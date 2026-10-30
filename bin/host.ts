/**
 * Runs a durable session host for manual testing:
 *
 *   npx tsx bin/host.ts --socket /tmp/pdc.sock --db /tmp/pdc.sqlite [--cwd DIR] [--model provider/id]
 *
 * then, in another terminal:
 *
 *   PI_DURABLE_SOCKET=/tmp/pdc.sock pi -e ./src/extension.ts
 *
 * Models and credentials come from your Pi setup (settings, auth.json, models.json, and the
 * providers your Pi extensions register), so whatever model `pi` uses works here too. The
 * conversation is stored in SQLite: stop and restart the host and it carries on.
 */

import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { serveConversation } from "../src/host.ts";

const { values } = parseArgs({
  options: {
    socket: { type: "string", default: "/tmp/pi-durable.sock" },
    db: { type: "string", default: "/tmp/pi-durable.sqlite" },
    cwd: { type: "string", default: process.cwd() },
    model: { type: "string" },
  },
});
const cwd = values.cwd!;

// Borrow Pi's model runtime: it has the user's providers, including ones extensions register.
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noSkills: true, noContextFiles: true });
await resourceLoader.reload();
const { session: pi } = await createAgentSession({ cwd, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });
await pi.bindExtensions({});
const models = pi.modelRuntime;
let model = pi.model;
if (values.model) {
  const [provider, ...id] = values.model.split("/");
  model = models.getModel(provider!, id.join("/"));
}
if (!model) throw new Error("no model: pass --model provider/id or configure a default in Pi");

const registry = createRegistry();
registry.install(CodingTools);
const harness = await Harness.open(
  await openNodeSqliteStorage(values.db!),
  { models, registry, env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir ?? cwd }) },
  context,
);
const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id }, cwd } });
harness.resume();
const host = await serveConversation(harness, root, values.socket!);
console.log(`durable session on ${host.socketPath} (${model.provider}/${model.id}, ${values.db}, cwd ${cwd})`);

const stop = async () => {
  await host.close();
  await harness.close(context);
  pi.dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
