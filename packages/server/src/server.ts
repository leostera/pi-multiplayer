/**
 * Serves one pi-durable conversation to any number of clients, over any transport.
 *
 * Each attached client gets the conversation's current snapshot and session info, then every
 * committed batch of agent events. Requests map one to one onto the conversation:
 *
 * - `submit` is an input, signed by its author. An idle conversation starts a run; a busy one
 *   places it as the client says (steer or follow-up).
 * - `write` adds another agent's message (from the ATXF bridge) as context without a run.
 * - `abort` stops the conversation.
 *
 * The Node host serves it on a Unix socket; the Durable Object on WebSockets.
 */

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { watchEvents, type Conversation, type Harness } from "@earendil-works/pi-durable";
import {
  MESSAGE_KIND,
  PEER_KIND,
  type ClientRequest,
  type HostMessage,
  type MessageData,
  type PeerData,
  type SessionInfo,
  type SubmitResult,
} from "@pi-multiplayer/protocol";

/** One client's connection, as the server sees it. */
export interface Peer {
  send(text: string): void;
}

export interface ClientIdentity {
  /** Who the transport says the client is; overrides the author the client sends. */
  author?: string;
}

export interface AttachedClient {
  /** Hands the server one message (a line or a frame) from the client. */
  receive(text: string): void;
  /** Stops the client's event stream. */
  detach(): Promise<void>;
}

export interface SessionServerOptions {
  /** The agent's display name. Default `agent`. */
  agentName?: string;
  /** Receives a line for each client connection, request, and reply. */
  log?: (line: string) => void;
}

export class SessionServer {
  #clients = 0;

  constructor(
    private readonly harness: Harness,
    private readonly conversation: Conversation,
    private readonly options: SessionServerOptions = {},
  ) {}

  async attach(peer: Peer, identity: ClientIdentity = {}): Promise<AttachedClient> {
    const client = ++this.#clients;
    const name = identity.author ? `${identity.author} (client ${client})` : `client ${client}`;
    const log = this.options.log;
    log?.(`${name} connected`);
    const send = (message: HostMessage) => peer.send(JSON.stringify(message));

    const stream = await watchEvents(this.harness, this.conversation.id, context);
    const agent = await this.conversation.agent(context);
    const session: SessionInfo = {
      agent: this.options.agentName ?? "agent",
      model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "unknown",
      tools: [...agent.tools, ...agent.deferred].map(tool => tool.name),
      ...(identity.author ? { you: identity.author } : {}),
    };
    send({ type: "snapshot", snapshot: stream.snapshot, session });
    stream.start(async events => send({ type: "events", events }));

    return {
      receive: text => {
        let request: ClientRequest;
        try {
          request = JSON.parse(text) as ClientRequest;
        } catch {
          log?.(`${name} sent something that is not JSON`);
          return;
        }
        if (request.op === "submit" && identity.author) request.author = identity.author;
        // The person running the bridge typed the other agent's user messages.
        if (request.op === "write" && identity.author && request.peer.role === "user") request.peer.author = identity.author;
        log?.(`${name} → ${describe(request)}`);
        void this.#handle(request).then(
          result => {
            log?.(`${name} ← ${request.op} ok${result ? ` (submission #${result.submissionId})` : ""}`);
            send({ type: "reply", id: request.id, ok: true, result });
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            log?.(`${name} ← ${request.op} failed: ${message}`);
            send({ type: "reply", id: request.id, ok: false, error: message });
          },
        );
      },
      detach: async () => {
        await stream.stop();
        log?.(`${name} disconnected`);
      },
    };
  }

  async #handle(request: ClientRequest): Promise<SubmitResult | null> {
    switch (request.op) {
      case "submit": {
        const data: MessageData = { author: request.author, text: request.content };
        const submission = await this.conversation.submit(
          {
            type: "input",
            requestId: request.requestId,
            content: `${request.author}: ${request.content}`,
            entry: { kind: MESSAGE_KIND, data: { ...data } },
            whenBusy: request.whenBusy,
          },
          context,
        );
        return { submissionId: Number(submission.id) };
      }
      case "write": {
        // Context for the model, as a user message that says whose it is; no run starts.
        const submission = await this.conversation.submit(
          {
            type: "write",
            requestId: request.requestId,
            entry: {
              kind: PEER_KIND,
              data: { ...request.peer },
              model: [{ role: "user", content: peerText(request.peer), timestamp: Date.now() }],
            },
          },
          context,
        );
        return { submissionId: Number(submission.id) };
      }
      case "abort":
        await this.conversation.abort(context);
        return null;
    }
  }
}

/** How another agent's message reads to the model. */
export function peerText(peer: PeerData): string {
  switch (peer.role) {
    case "user":
      return `${peer.author} (in ${peer.agent}): ${peer.text}`;
    case "assistant":
      return `[${peer.agent}, another agent in this session, replied:]\n${peer.text}`;
    case "tool":
      return `[${peer.agent} ran a tool, which returned:]\n${peer.text}`;
  }
}

function describe(request: ClientRequest): string {
  const short = (text: string) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return JSON.stringify(flat.length > 120 ? `${flat.slice(0, 120)}…` : flat);
  };
  switch (request.op) {
    case "abort":
      return "abort";
    case "submit":
      return `submit from ${request.author} (${request.whenBusy} if busy) ${short(request.content)} ${request.requestId}`;
    case "write":
      return `write ${request.peer.agent} ${request.peer.role} from ${request.peer.author} ${short(request.peer.text)}`;
  }
}
