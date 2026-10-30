/**
 * The client side of the wire: a connection to one session, over a Unix socket or a WebSocket.
 *
 * `target` is a socket path (or `unix:<path>`) or a URL: `ws://`, `wss://`, or `http(s)://`,
 * which is used as the matching WebSocket URL. A session behind Cloudflare Access is reached
 * with the token `cloudflared access token` prints for it, sent as `cf-access-token`.
 */

import { execFile } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import {
  lineSplitter,
  type ClientRequest,
  type Delivery,
  type HostMessage,
  type PeerData,
  type SessionInfo,
  type SubmitResult,
} from "@pi-multiplayer/protocol";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface RemoteConversation {
  readonly snapshot: SnapshotEvent;
  /** The agent, its model, its tools, and who the server says this client is. */
  readonly session: SessionInfo;
  /** Receives every batch of events committed after the snapshot, in order. */
  onEvents(listener: (events: readonly AgentEvent[]) => void): () => void;
  /** Called once when the connection is lost or closed. */
  onClose(listener: () => void): void;
  submit(requestId: string, author: string, content: string, whenBusy: Delivery): Promise<SubmitResult>;
  /** Adds another agent's message as context, without starting a run. */
  write(requestId: string, peer: PeerData): Promise<SubmitResult>;
  abort(): Promise<void>;
  close(): void;
}

export interface ConnectOptions {
  /**
   * The Cloudflare Access token to send. By default it is asked of `cloudflared` for remote
   * `https`/`wss` targets; `false` sends none.
   */
  accessToken?: string | false;
}

/** A message transport: whole messages in, whole messages out. */
interface Transport {
  send(text: string): void;
  close(): void;
  readonly closed: boolean;
}

export async function connectConversation(target: string, options: ConnectOptions = {}): Promise<RemoteConversation> {
  const listeners = new Set<(events: readonly AgentEvent[]) => void>();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const closeListeners: (() => void)[] = [];
  // Batches that arrive before anyone listens are kept, so nothing between the snapshot and the
  // first listener is lost.
  const early: (readonly AgentEvent[])[] = [];
  let nextId = 1;
  let session: SessionInfo = { agent: "agent", model: "unknown", tools: [] };
  let gotSnapshot: (snapshot: SnapshotEvent) => void = () => {};
  let failed: (error: Error) => void = () => {};
  const snapshot = new Promise<SnapshotEvent>((resolve, reject) => {
    gotSnapshot = resolve;
    failed = reject;
  });

  const onMessage = (text: string) => {
    const message = JSON.parse(text) as HostMessage;
    switch (message.type) {
      case "snapshot":
        session = message.session;
        gotSnapshot(message.snapshot);
        break;
      case "events":
        if (listeners.size === 0) early.push(message.events);
        for (const listener of listeners) listener(message.events);
        break;
      case "reply": {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.ok) waiter?.resolve(message.result);
        else waiter?.reject(new Error(message.error));
        break;
      }
    }
  };
  const onClose = (reason: string) => {
    failed(new Error(reason));
    for (const waiter of pending.values()) waiter.reject(new Error("durable session connection closed"));
    pending.clear();
    for (const listener of closeListeners.splice(0)) listener();
  };

  const transport = isUrl(target)
    ? await openWebSocket(target, options, onMessage, onClose)
    : openSocket(target.replace(/^unix:/, ""), onMessage, onClose);
  const first = await snapshot;

  const request = <T>(body: DistributiveOmit<ClientRequest, "id">): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (transport.closed) return reject(new Error("durable session connection closed"));
      const id = nextId++;
      pending.set(id, { resolve: value => resolve(value as T), reject });
      transport.send(JSON.stringify({ ...body, id }));
    });

  return {
    snapshot: first,
    session,
    onEvents(listener) {
      listeners.add(listener);
      for (const batch of early.splice(0)) listener(batch);
      return () => listeners.delete(listener);
    },
    onClose: listener => {
      if (transport.closed) listener();
      else closeListeners.push(listener);
    },
    submit: (requestId, author, content, whenBusy) =>
      request<SubmitResult>({ op: "submit", requestId, author, content, whenBusy }),
    write: (requestId, peer) => request<SubmitResult>({ op: "write", requestId, peer }),
    abort: () => request<void>({ op: "abort" }),
    close: () => transport.close(),
  };
}

function isUrl(target: string): boolean {
  return /^(wss?|https?):\/\//.test(target);
}

function openSocket(path: string, onMessage: (text: string) => void, onClose: (reason: string) => void): Transport {
  const socket = connect(path);
  let closed = false;
  socket.on("data", lineSplitter(onMessage));
  socket.on("error", error => onClose(`could not reach ${path}: ${error.message}`));
  socket.on("close", () => {
    closed = true;
    onClose("connection closed");
  });
  return {
    send: text => socket.write(`${text}\n`),
    close: () => socket.destroy(),
    get closed() {
      return closed || socket.destroyed;
    },
  };
}

async function openWebSocket(
  target: string,
  options: ConnectOptions,
  onMessage: (text: string) => void,
  onClose: (reason: string) => void,
): Promise<Transport> {
  const url = new URL(target.replace(/^http/, "ws"));
  const headers: Record<string, string> = {};
  const token = options.accessToken ?? (needsAccess(url) ? await accessToken(url) : false);
  if (token) headers["cf-access-token"] = token;
  const socket = new WebSocket(url, { headers } as never);
  let closed = false;
  socket.addEventListener("message", event => onMessage(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)));
  socket.addEventListener("error", () => onClose(`could not reach ${url.origin}${token ? "" : " (no Cloudflare Access token)"}`));
  socket.addEventListener("close", event => {
    closed = true;
    onClose(`connection closed${event.reason ? `: ${event.reason}` : ""}`);
  });
  const queue: string[] = [];
  socket.addEventListener("open", () => {
    for (const text of queue.splice(0)) socket.send(text);
  });
  return {
    send: text => (socket.readyState === WebSocket.OPEN ? socket.send(text) : queue.push(text)),
    close: () => socket.close(),
    get closed() {
      return closed;
    },
  };
}

function needsAccess(url: URL): boolean {
  return url.protocol === "wss:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
}

/** The Access token `cloudflared` holds for the app at `url`'s origin. */
export async function accessToken(url: URL): Promise<string> {
  const app = `https://${url.host}`;
  try {
    const { stdout } = await promisify(execFile)("cloudflared", ["access", "token", `-app=${app}`]);
    const token = stdout.trim();
    if (token && !/^Unable|error/i.test(token)) return token;
  } catch {
    // Not logged in, or no cloudflared.
  }
  throw new Error(`no Cloudflare Access token for ${app}: run \`cloudflared access login ${app}\``);
}
