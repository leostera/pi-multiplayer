import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, MemoryStorage, createRegistry, type Conversation } from "@earendil-works/pi-durable";
import { contentText, type EntryRecord, type Transcript } from "@leostera/atxf";
import { opencode } from "@leostera/atxf/opencode";
import { push, readShared } from "@leostera/atxf/sync";
import { reconciliationKeys } from "@leostera/atxf/reconcile";
import { serveConversation, type DurableHost } from "@pi-multiplayer/server/node";
import { connectConversation, type RemoteConversation } from "@pi-multiplayer/client";
import { PEER_KIND } from "@pi-multiplayer/protocol";
import { startBridge, type Bridge } from "../src/bridge.ts";

let dir: string;
let faux: ReturnType<typeof fauxProvider>;
let harness: Harness;
let root: Conversation;
let host: DurableHost;
let bridge: Bridge;
let leo: RemoteConversation;
let file: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pm-atxf-"));
  file = join(dir, "shared.atxf.jsonl");
  faux = fauxProvider({ tokensPerSecond: 1000 });
  const models = createModels();
  models.setProvider(faux.provider);
  harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  const model = faux.getModel();
  root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  host = await serveConversation(harness, root, join("/tmp", `pm-atxf-${process.pid}-${Math.random().toString(36).slice(2)}.sock`), { agentName: "kimi" });
  harness.resume();
  bridge = await startBridge({ target: host.socketPath, file, author: "carol" });
  leo = await connectConversation(host.socketPath);
});

afterEach(async () => {
  leo.close();
  bridge.close();
  await host.close();
  await harness.close(context);
  rmSync(dir, { recursive: true, force: true });
});

/** What OpenCode does: its session is a copy of the file (through its own format), plus its turn, pushed back. */
async function opencodeTakesATurn(question: string, answer: string): Promise<void> {
  const shared = (await readShared(file))!;
  const local = opencode.toAtxf(opencode.fromAtxf(shared));
  const leaf = local.records.at(-1)!.id;
  const time = new Date().toISOString();
  // OpenCode records its model switch before the turn: a record the session has no entry for.
  const turn: EntryRecord[] = [
    { type: "settings", id: `oc-s-${question.length}`, time, parentId: leaf, model: { provider: "openai", id: "gpt" } },
    { type: "message", id: `oc-u-${question.length}`, time, parentId: `oc-s-${question.length}`, role: "user", content: question },
    { type: "message", id: `oc-a-${answer.length}`, time, parentId: `oc-u-${question.length}`, role: "assistant", content: [{ type: "text", text: answer }], origin: { kind: "model" } },
  ];
  await push(file, { ...local, records: [...local.records, ...turn] });
}

const texts = (transcript: Transcript) =>
  transcript.records.filter(r => r.type === "message").map(r => {
    const m = r as Extract<EntryRecord, { type: "message" }>;
    return `${m.role}:${m.role === "assistant" ? m.content.map(b => (b.type === "text" ? b.text : "")).join("") : contentText(m.content as never)}`;
  });

async function until<T>(read: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

test("the session reaches the shared file, OpenCode's turns reach the session, and nothing is shared twice", async () => {
  let seen = "";
  faux.setResponses([
    fauxAssistantMessage("Hello Leo."),
    context => {
      seen = JSON.stringify(context.messages);
      return fauxAssistantMessage("Agreed with opencode.");
    },
  ]);

  await leo.submit("r1", "leo", "hi kimi", "followUp");
  await until(async () => ((await readShared(file)) && texts((await readShared(file))!).includes("assistant:Hello Leo.") ? true : undefined), "kimi's reply in the file");

  await opencodeTakesATurn("what does main.ts do?", "It starts the server.");
  // Newest first; in order of commit here.
  const entries = async () => [...(await root.entries({}, 100, undefined, context)).items].sort((a, b) => Number(a.id) - Number(b.id));
  await until(async () => ((await entries()).filter(e => e.kind === PEER_KIND).length === 2 ? true : undefined), "OpenCode's turn in the session");
  const peers = (await entries()).filter(e => e.kind === PEER_KIND).map(e => e.data);
  assert.deepEqual(peers.map(p => [(p as { author: string }).author, (p as { role: string }).role]), [["carol", "user"], ["opencode", "assistant"]]);

  await leo.submit("r2", "leo", "kimi, do you agree?", "followUp");
  await until(async () => (texts((await readShared(file))!).includes("assistant:Agreed with opencode.") ? true : undefined), "kimi's second reply in the file");
  assert.match(seen, /carol \(in opencode\): what does main.ts do\?/);
  assert.match(seen, /It starts the server/);

  // Everyone's copy holds each message once.
  const shared = (await readShared(file))!;
  assert.deepEqual(texts(shared), [
    "user:hi kimi",
    "assistant:Hello Leo.",
    "user:what does main.ts do?",
    "assistant:It starts the server.",
    "user:kimi, do you agree?",
    "assistant:Agreed with opencode.",
  ]);
  // OpenCode pulling it, then pushing its copy back, adds nothing.
  const back = opencode.toAtxf(opencode.fromAtxf(shared));
  assert.equal([...reconciliationKeys(back)].filter(k => !reconciliationKeys(shared).has(k)).length, 0);
  assert.equal((await push(file, back)).added, 0);
});
