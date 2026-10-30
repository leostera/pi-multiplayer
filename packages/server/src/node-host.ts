/**
 * Serves a session on a Unix socket, one JSON object per line. For local use and tests; the
 * Durable Object serves the same protocol on WebSockets.
 */

import { createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { lineSplitter } from "@pi-multiplayer/protocol";
import { SessionServer, type SessionServerOptions } from "./server.ts";

export interface DurableHost {
  readonly socketPath: string;
  close(): Promise<void>;
}

export async function serveConversation(
  harness: Harness,
  conversation: Conversation,
  socketPath: string,
  options: SessionServerOptions = {},
): Promise<DurableHost> {
  rmSync(socketPath, { force: true });
  const session = new SessionServer(harness, conversation, options);
  const connections = new Set<Socket>();
  const server: Server = createServer(socket => {
    connections.add(socket);
    void serve(session, socket).finally(() => connections.delete(socket));
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

async function serve(session: SessionServer, socket: Socket): Promise<void> {
  const client = await session.attach({
    send: text => {
      if (!socket.destroyed) socket.write(`${text}\n`);
    },
  });
  socket.on("data", lineSplitter(line => client.receive(line)));
  await new Promise<void>(resolve => {
    socket.once("close", () => resolve());
    socket.once("error", () => resolve());
  });
  await client.detach();
}
