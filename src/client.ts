/** The Pi side of the wire: a connection to one durable conversation. */

import { connect, type Socket } from "node:net";
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import { lineSplitter, type ClientRequest, type Delivery, type HostMessage, type SubmitResult } from "./protocol.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface RemoteConversation {
  readonly snapshot: SnapshotEvent;
  /** The tools the conversation offered when this client attached. */
  readonly tools: readonly string[];
  /** Receives every batch of events committed after the snapshot, in order. */
  onEvents(listener: (events: readonly AgentEvent[]) => void): () => void;
  submit(requestId: string, content: string, whenBusy: Delivery): Promise<SubmitResult>;
  abort(): Promise<void>;
  close(): void;
}

export async function connectConversation(socketPath: string): Promise<RemoteConversation> {
  const socket: Socket = connect(socketPath);
  const listeners = new Set<(events: readonly AgentEvent[]) => void>();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  // Batches that arrive before anyone listens are kept, so nothing between the snapshot and the
  // first listener is lost.
  const early: (readonly AgentEvent[])[] = [];
  let nextId = 1;

  let tools: string[] = [];
  const snapshot = await new Promise<SnapshotEvent>((resolve, reject) => {
    socket.once("error", reject);
    socket.on(
      "data",
      lineSplitter(line => {
        const message = JSON.parse(line) as HostMessage;
        switch (message.type) {
          case "snapshot":
            tools = message.tools;
            resolve(message.snapshot);
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
      }),
    );
  });
  socket.on("close", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("durable session connection closed"));
    pending.clear();
  });

  const request = <T>(body: DistributiveOmit<ClientRequest, "id">): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: value => resolve(value as T), reject });
      socket.write(`${JSON.stringify({ ...body, id })}\n`);
    });

  return {
    snapshot,
    tools,
    onEvents(listener) {
      listeners.add(listener);
      for (const batch of early.splice(0)) listener(batch);
      return () => listeners.delete(listener);
    },
    submit: (requestId, content, whenBusy) => request<SubmitResult>({ op: "submit", requestId, content, whenBusy }),
    abort: () => request<void>({ op: "abort" }),
    close: () => socket.destroy(),
  };
}
