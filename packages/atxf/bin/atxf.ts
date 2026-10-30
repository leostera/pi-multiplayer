#!/usr/bin/env bun
/**
 * Bridge a pi-multiplayer session and an ATXF shared file:
 *
 *   pi-multiplayer-atxf wss://<host>/s/<name> ~/shared/<name>.atxf.jsonl
 *
 * Then, in OpenCode (with the opencode-atxf plugin): `/atxf join ~/shared/<name>.atxf.jsonl`.
 */

import { parseArgs } from "node:util";
import { startBridge } from "../src/bridge.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string", default: "opencode" },
    author: { type: "string" },
  },
});
const [target, file] = positionals;
if (!target || !file) {
  console.error("usage: pi-multiplayer-atxf <session URL or socket> <file.atxf.jsonl> [--agent opencode] [--author name]");
  process.exit(2);
}
const log = (line: string) => console.log(`\x1b[2m${new Date().toISOString().slice(11, 19)}\x1b[0m ${line}`);
const bridge = await startBridge({ target, file, agent: values.agent, author: values.author, log });
process.on("SIGINT", () => bridge.close());
await bridge.closed;
log("session connection closed");
process.exit(1);
