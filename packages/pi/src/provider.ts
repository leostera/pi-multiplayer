/**
 * Pi's provider for a durable session: each "model request" Pi makes is answered by the next
 * assistant turn of the remote conversation.
 *
 * On each call it sends the user messages Pi added since the last answer (the prompt, steers,
 * follow-ups) to the remote conversation, then streams that conversation's next assistant turn
 * back to Pi as if a model had produced it. Pi's own system prompt and tool list are ignored: the
 * remote conversation has its own.
 */

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { userText, type Mirror, type RemoteTurn } from "./mirror.ts";

export interface DurableStreamOptions {
  mirror: () => Promise<Mirror>;
  /**
   * Texts of messages the extension put into Pi's transcript to show input that arrived from
   * elsewhere; the remote conversation already has them, so they are not sent back.
   */
  echoes: string[];
  /** Called with the tool names of each finished turn, before Pi runs its calls. */
  onToolCalls?: (names: readonly string[]) => void;
}

export function durableStreamSimple(options: DurableStreamOptions) {
  return (model: Model<Api>, context: TranscriptContext, streamOptions?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    void run(stream, model, context, streamOptions?.signal, options);
    return stream;
  };
}

async function run(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  context: TranscriptContext,
  signal: AbortSignal | undefined,
  options: DurableStreamOptions,
): Promise<void> {
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "pending",
    timestamp: Date.now(),
  };
  const fail = (reason: "error" | "aborted", message: string) => {
    output.stopReason = reason;
    output.errorMessage = message;
    stream.push({ type: "error", reason, error: output });
    stream.end(output);
  };

  let mirror: Mirror;
  const inputs = newInputs(context.messages, options.echoes);
  const send = async () => {
    mirror = await options.mirror();
    for (const input of inputs) await mirror.submit(input.requestId, input.text);
  };
  try {
    // A connection found dead on use is opened again once; request ids make resending safe.
    await send().catch(async error => {
      if (!mirror?.closed) throw error;
      await send();
    });
  } catch (error) {
    return fail("error", `Could not reach the durable session: ${errorText(error)}`);
  }

  mirror = mirror!;
  let next;
  try {
    next = await mirror.nextTurn(signal);
  } catch {
    await mirror.abort().catch(() => {});
    return fail("aborted", "Aborted");
  }
  if ("ended" in next) {
    // Pi asked again after the remote run had answered, with nothing new to send (another
    // client's message reached Pi after the answer to it): there is nothing to show.
    if (inputs.length === 0 && !mirror.closed) {
      output.stopReason = "stop";
      stream.push({ type: "start", partial: output });
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end(output);
      return;
    }
    return fail("error", next.ended);
  }

  stream.push({ type: "start", partial: output });
  const emitter = new TurnEmitter(stream, output);
  try {
    await follow(next.turn, emitter, signal);
  } catch {
    await mirror.abort().catch(() => {});
    emitter.endOpenBlocks();
    return fail("aborted", "Aborted");
  }

  const final = next.turn.final!;
  emitter.sync(final, true);
  output.usage = structuredClone(final.usage);
  output.responseModel = `${final.provider}/${final.model}`;
  const calls = output.content.filter(block => block.type === "toolCall").map(block => block.name);
  options.onToolCalls?.(calls);
  if (final.stopReason === "error" || final.stopReason === "aborted") {
    return fail(final.stopReason, final.errorMessage ?? "The durable session's model request failed.");
  }
  output.stopReason = final.stopReason === "pending" || final.stopReason === "deferred" ? "stop" : final.stopReason;
  stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
  stream.end(output);
}

/** Streams the turn's changes into the emitter until the turn is final. */
function follow(turn: RemoteTurn, emitter: TurnEmitter, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const update = () => {
      emitter.sync(turn.message, false);
      if (turn.final) finish(resolve);
    };
    const onAbort = () => finish(() => reject(new Error("aborted")));
    const unsubscribe = turn.changed.subscribe(update);
    const finish = (then: () => void) => {
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      then();
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    update();
  });
}

/**
 * Turns successive states of the remote message into Pi's stream events by diffing them
 * against what was already emitted: text and thinking stream as deltas; a tool call is emitted
 * whole once its block is complete.
 */
class TurnEmitter {
  readonly #emitted: { type: string; length: number; ended: boolean }[] = [];

  constructor(
    private readonly stream: AssistantMessageEventStream,
    private readonly output: AssistantMessage,
  ) {}

  sync(remote: AssistantMessage, final: boolean): void {
    remote.content.forEach((block, index) => {
      let state = this.#emitted[index];
      if (!state) {
        state = { type: block.type, length: 0, ended: false };
        this.#emitted[index] = state;
        // Starting a block closes the previous one: the remote side writes blocks in order.
        if (index > 0) this.#end(index - 1, remote);
        this.output.content[index] =
          block.type === "text" ? { type: "text", text: "" }
          : block.type === "thinking" ? { type: "thinking", thinking: "" }
          : structuredClone(block);
        if (block.type === "text") this.stream.push({ type: "text_start", contentIndex: index, partial: this.output });
        if (block.type === "thinking") this.stream.push({ type: "thinking_start", contentIndex: index, partial: this.output });
        if (block.type === "toolCall") this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.output });
      }
      if (block.type === "text" || block.type === "thinking") {
        const text = block.type === "text" ? block.text : block.thinking;
        if (text.length > state.length) {
          const delta = text.slice(state.length);
          state.length = text.length;
          const local = this.output.content[index]!;
          if (local.type === "text") local.text = text;
          if (local.type === "thinking") local.thinking = text;
          this.stream.push({ type: block.type === "text" ? "text_delta" : "thinking_delta", contentIndex: index, delta, partial: this.output });
        }
      }
    });
    if (final) remote.content.forEach((_, index) => this.#end(index, remote));
  }

  endOpenBlocks(): void {
    this.#emitted.forEach((state, index) => {
      if (state.ended) return;
      state.ended = true;
      const block = this.output.content[index]!;
      if (block.type === "text") this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.output });
      if (block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.output });
    });
  }

  #end(index: number, remote: AssistantMessage): void {
    const state = this.#emitted[index];
    if (!state || state.ended) return;
    state.ended = true;
    const block = structuredClone(remote.content[index]!);
    this.output.content[index] = block;
    if (block.type === "text") this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.output });
    if (block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.output });
    if (block.type === "toolCall") this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: this.output });
  }
}

/**
 * The user messages after Pi's last assistant message, each with a request id stable across
 * Pi's retries so the remote conversation admits it once.
 */
function newInputs(messages: readonly Message[], echoes: string[]): { requestId: string; text: string }[] {
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.role !== "assistant") start--;
  const inputs: { requestId: string; text: string }[] = [];
  for (const message of messages.slice(start)) {
    if (message.role !== "user") continue;
    const text = userText(message.content as never);
    const echo = echoes.indexOf(text);
    if (echo !== -1) {
      echoes.splice(echo, 1);
      continue;
    }
    const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
    inputs.push({ requestId: `pi:${message.timestamp}:${digest}`, text });
  }
  return inputs;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
