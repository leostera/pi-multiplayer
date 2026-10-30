/**
 * A local mirror of one durable conversation, shaped for Pi's agent loop.
 *
 * Pi's loop asks for one assistant message at a time (the provider) and then runs that message's
 * tool calls (the stand-in tools). The remote conversation produces the same sequence on its own:
 * an assistant turn, its tool results, the next turn. The mirror lines the two up:
 *
 * - every remote assistant turn is queued, and the provider takes them in order;
 * - every remote tool call is kept by its call id, and a stand-in tool waits for its result.
 *
 * The remote side is authoritative. Pi's transcript is a copy that the mirror keeps in step.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, MessageChange, SubmissionRecord } from "@earendil-works/pi-durable";
import type { RemoteConversation } from "@pi-multiplayer/client";
import { MESSAGE_KIND, type Delivery, type MessageData } from "@pi-multiplayer/protocol";

type Listener = () => void;

class Signal {
  #listeners = new Set<Listener>();
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** One remote assistant message, live while it streams. */
export class RemoteTurn {
  readonly changed = new Signal();
  message: AssistantMessage;
  final?: AssistantMessage;

  constructor(message: AssistantMessage) {
    this.message = structuredClone(message);
  }

  apply(changes: readonly MessageChange[]): void {
    for (const change of changes) applyChange(this.message, change);
    this.changed.notify();
  }

  finish(message: AssistantMessage): void {
    this.message = structuredClone(message);
    this.final = this.message;
    this.changed.notify();
  }
}

/** One remote tool call: its running output, then its result. */
export class RemoteTool {
  readonly changed = new Signal();
  output = "";
  details: unknown;
  /** Set once the call ended; `result` is absent when it ended without one (faulted, orphaned). */
  ended = false;
  /** The mirror's round count when the call ended (see `Mirror.roundEnded`). */
  endedInRound = 0;
  result?: ToolResultMessage;
}

export type NextTurn = { turn: RemoteTurn } | { ended: string };

export interface ForeignInput {
  /** Who wrote it; absent for a client that does not say. */
  author?: string;
  text: string;
}

export class Mirror {
  readonly #remote: RemoteConversation;
  readonly #turns: RemoteTurn[] = [];
  #current?: RemoteTurn;
  readonly #tools = new Map<string, RemoteTool>();
  readonly #changed = new Signal();
  #running: boolean;
  /** Request ids this client submitted that are not settled yet. */
  readonly #outstanding = new Set<string>();
  readonly #own = new Set<string>();
  readonly #inputs = new Map<number, ForeignInput>();
  /** Who this client submits as. */
  readonly author: string;
  #lastFailure?: string;
  #closed = false;
  /** Counts turn starts and run ends: the points by which a tool round's steers are placed. */
  #round = 0;
  /** Called when someone else (another client) places input into the conversation. */
  onForeignInput?: (input: ForeignInput) => void;
  /** Called when a remote assistant turn starts and is queued for Pi. */
  onTurnQueued?: () => void;

  constructor(remote: RemoteConversation, author: string) {
    this.#remote = remote;
    this.author = author;
    this.#running = remote.snapshot.run !== undefined;
    for (const entry of remote.snapshot.entries) this.#rememberInput(entry);
    remote.onEvents(events => {
      for (const event of events) this.#apply(event);
      this.#changed.notify();
    });
    remote.onClose(() => {
      this.#closed = true;
      // Pi's waits end: the turn being streamed and every tool call still running.
      this.#current?.finish({ ...this.#current.message, stopReason: "error", errorMessage: "Lost the durable session connection." });
      for (const tool of this.#tools.values()) {
        tool.ended = true;
        tool.changed.notify();
      }
      this.#changed.notify();
    });
  }

  close(): void {
    this.#remote.close();
  }

  /** Remote turns no Pi model request has taken yet. */
  get queuedTurns(): number {
    return this.#turns.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get session() {
    return this.#remote.session;
  }

  get running(): boolean {
    return this.#running;
  }

  async submit(requestId: string, content: string, whenBusy: Delivery = "steer"): Promise<void> {
    this.#own.add(requestId);
    this.#outstanding.add(requestId);
    this.#lastFailure = undefined;
    try {
      await this.#remote.submit(requestId, this.author, content, whenBusy);
    } catch (error) {
      this.#outstanding.delete(requestId);
      throw error;
    }
  }

  async abort(): Promise<void> {
    await this.#remote.abort();
    // Whatever the aborted run still produced is not Pi's to show.
    this.#turns.length = 0;
    this.#current = undefined;
  }

  /**
   * The next remote assistant turn, waiting for it if needed. Resolves `ended` when the
   * conversation is idle, nothing this client submitted is outstanding, and no turn is queued.
   */
  nextTurn(signal?: AbortSignal): Promise<NextTurn> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const turn = this.#turns.shift();
        if (turn) return done({ turn });
        if (this.#closed) return done({ ended: "Lost the durable session connection." });
        if (!this.#running && this.#outstanding.size === 0) {
          return done({ ended: this.#lastFailure ?? "The durable session is idle and produced no answer." });
        }
        return false;
      };
      const done = (value: NextTurn): true => {
        cleanup();
        resolve(value);
        return true;
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("aborted"));
      };
      const unsubscribe = this.#changed.subscribe(() => void check());
      const cleanup = () => {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }

  /** The remote call with this id; created empty if its events have not arrived yet. */
  tool(toolCallId: string): RemoteTool {
    let tool = this.#tools.get(toolCallId);
    if (!tool) {
      tool = new RemoteTool();
      this.#tools.set(toolCallId, tool);
    }
    return tool;
  }

  /**
   * Resolves once the tool round that `tool` belonged to is over on the remote side: the next
   * turn started or the run ended. Inputs placed after that round (steers) are known by then,
   * so Pi can show them before its next request, where the remote conversation put them.
   */
  roundEnded(tool: RemoteTool): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        if (this.#closed || this.#round > tool.endedInRound) {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = this.#changed.subscribe(check);
      check();
    });
  }

  forgetTool(toolCallId: string): void {
    this.#tools.delete(toolCallId);
  }

  #apply(event: AgentEvent): void {
    switch (event.type) {
      case "run_start":
        this.#running = true;
        break;
      case "run_end":
        this.#running = false;
        this.#round++;
        break;
      case "turn_start":
        this.#round++;
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          this.#current = new RemoteTurn(event.message);
          this.#turns.push(this.#current);
          this.onTurnQueued?.();
        }
        break;
      case "message_update":
        this.#current?.apply(event.changes);
        break;
      case "message_end":
        this.#rememberInput(event.entry);
        if (event.entry.kind === "pi.assistant" && this.#current) {
          const message = event.entry.model?.find(m => m.role === "assistant");
          if (message) this.#current.finish(message);
          this.#current = undefined;
        }
        break;
      case "tool_execution_start":
        this.tool(event.toolCallId);
        break;
      case "tool_execution_update": {
        const tool = this.tool(event.toolCallId);
        if (event.output) {
          if ("set" in event.output) tool.output = event.output.set;
          else tool.output = tool.output.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
        }
        if (event.details !== undefined) tool.details = event.details;
        tool.changed.notify();
        break;
      }
      case "tool_execution_end": {
        if (event.parentToolCallId !== undefined) break;
        const tool = this.tool(event.toolCallId);
        tool.ended = true;
        tool.endedInRound = this.#round;
        tool.result = event.entry?.model?.find((m): m is ToolResultMessage => m.role === "toolResult");
        tool.changed.notify();
        break;
      }
      case "submission":
        this.#settle(event.record);
        break;
    }
  }

  #settle(record: SubmissionRecord): void {
    if (record.type !== "input") return;
    const mine = record.requestId !== undefined && this.#own.has(record.requestId);
    if (mine) {
      if (record.status === "done" || record.status === "unanswered") this.#outstanding.delete(record.requestId!);
      if (record.status === "unanswered") {
        this.#lastFailure = `The durable session did not answer (${record.reason}${record.detail ? `: ${record.detail}` : ""}).`;
      }
      return;
    }
    if (record.status === "placed") {
      const input = this.#inputs.get(Number(record.entry));
      if (input !== undefined) this.onForeignInput?.(input);
    }
  }

  #rememberInput(entry: EntryRecord): void {
    if (entry.kind === MESSAGE_KIND) {
      const data = entry.data as unknown as MessageData;
      this.#inputs.set(Number(entry.id), { author: data.author, text: data.text });
      return;
    }
    const user = entry.model?.find(m => m.role === "user");
    if (user) this.#inputs.set(Number(entry.id), { text: userText(user.content) });
  }
}

export function userText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .filter(part => part.type === "text")
    .map(part => part.text ?? "")
    .join("\n");
}

function applyChange(message: AssistantMessage, change: MessageChange): void {
  switch (change.type) {
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
    case "block":
      message.content[change.contentIndex] = structuredClone(change.block);
      break;
    case "text_delta": {
      const block = message.content[change.contentIndex];
      if (block?.type === "text") block.text += change.delta;
      break;
    }
    case "thinking_delta": {
      const block = message.content[change.contentIndex];
      if (block?.type === "thinking") block.thinking += change.delta;
      break;
    }
    case "toolcall_delta": {
      let target: Record<string | number, unknown> | undefined = message.content[change.contentIndex] as never;
      const path = change.path;
      for (let i = 0; target && i < path.length - 1; i++) {
        target[path[i]!] ??= typeof path[i + 1] === "number" ? [] : {};
        target = target[path[i]!] as Record<string | number, unknown>;
      }
      const last = path[path.length - 1];
      if (target && last !== undefined) target[last] = String(target[last] ?? "") + change.delta;
      break;
    }
    case "message":
      Object.assign(message, structuredClone(change.message));
      break;
  }
}
