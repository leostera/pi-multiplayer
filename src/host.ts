/**
 * Serves one pi-durable conversation to Pi clients over a Unix socket.
 *
 * Each connection gets the conversation's current snapshot, then every committed batch of agent
 * events. Requests map one to one onto the conversation: `submit` is an input (starting a run
 * when idle, steering or following up a busy one), `abort` stops the conversation.
 *
 * In Axo this is the part that becomes the session Durable Object.
 */

import { createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { watchEvents, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { lineSplitter, type ClientRequest, type HostMessage } from "./protocol.ts";

export interface DurableHost {
  readonly socketPath: string;
  close(): Promise<void>;
}

export async function serveConversation(
  harness: Harness,
  conversation: Conversation,
  socketPath: string,
): Promise<DurableHost> {
  rmSync(socketPath, { force: true });
  const connections = new Set<Socket>();
  const server: Server = createServer(socket => {
    connections.add(socket);
    void attach(harness, conversation, socket).finally(() => connections.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(socketPath, { force: true });
    },
  };
}

async function attach(harness: Harness, conversation: Conversation, socket: Socket): Promise<void> {
  const send = (message: HostMessage) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  };
  const stream = await watchEvents(harness, conversation.id, context);
  const agent = await conversation.agent(context);
  const tools = [...agent.tools, ...agent.deferred].map(tool => tool.name);
  send({ type: "snapshot", snapshot: stream.snapshot, tools });
  stream.start(async events => send({ type: "events", events }));

  socket.on(
    "data",
    lineSplitter(line => {
      const request = JSON.parse(line) as ClientRequest;
      void handle(conversation, request).then(
        result => send({ type: "reply", id: request.id, ok: true, result }),
        (error: unknown) =>
          send({ type: "reply", id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    }),
  );
  await new Promise<void>(resolve => {
    socket.once("close", () => resolve());
    socket.once("error", () => resolve());
  });
  await stream.stop();
}

async function handle(conversation: Conversation, request: ClientRequest) {
  switch (request.op) {
    case "submit": {
      // An idle conversation starts a run; a busy one places the input as `whenBusy` says.
      const submission = await conversation.submit(
        { type: "input", requestId: request.requestId, content: request.content, whenBusy: request.whenBusy },
        context,
      );
      return { submissionId: Number(submission.id) };
    }
    case "abort":
      await conversation.abort(context);
      return null;
  }
}
