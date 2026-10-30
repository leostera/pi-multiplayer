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

export interface HostOptions {
  /** Receives a line for each client connection, request, and reply. */
  log?: (line: string) => void;
}

export async function serveConversation(
  harness: Harness,
  conversation: Conversation,
  socketPath: string,
  options: HostOptions = {},
): Promise<DurableHost> {
  let clients = 0;
  rmSync(socketPath, { force: true });
  const connections = new Set<Socket>();
  const server: Server = createServer(socket => {
    connections.add(socket);
    const client = ++clients;
    options.log?.(`client ${client} connected`);
    void attach(harness, conversation, socket, client, options.log).finally(() => {
      connections.delete(socket);
      options.log?.(`client ${client} disconnected`);
    });
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

async function attach(
  harness: Harness,
  conversation: Conversation,
  socket: Socket,
  client: number,
  log?: (line: string) => void,
): Promise<void> {
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
      log?.(`client ${client} → ${describe(request)}`);
      void handle(conversation, request).then(
        result => {
          log?.(`client ${client} ← ${request.op} ok${result ? ` (submission #${result.submissionId})` : ""}`);
          send({ type: "reply", id: request.id, ok: true, result });
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          log?.(`client ${client} ← ${request.op} failed: ${message}`);
          send({ type: "reply", id: request.id, ok: false, error: message });
        },
      );
    }),
  );
  await new Promise<void>(resolve => {
    socket.once("close", () => resolve());
    socket.once("error", () => resolve());
  });
  await stream.stop();
}

function describe(request: ClientRequest): string {
  if (request.op === "abort") return "abort";
  const text = request.content.replace(/\s+/g, " ").trim();
  return `submit (${request.whenBusy} if busy) ${JSON.stringify(text.length > 120 ? `${text.slice(0, 120)}…` : text)} ${request.requestId}`;
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
