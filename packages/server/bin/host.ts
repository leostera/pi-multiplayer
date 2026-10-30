/**
 * Runs a durable session host for manual testing:
 *
 *   npx tsx bin/host.ts --socket /tmp/pdc.sock --db /tmp/pdc.sqlite [--cwd DIR] [--model provider/id] [--name NAME] [--raw]
 *
 * then, in another terminal:
 *
 *   pi -e ./packages/pi/src/extension.ts --multiplayer /tmp/pdc.sock
 *
 * Models and credentials come from your Pi setup (settings, auth.json, models.json, and the
 * providers your Pi extensions register), so whatever model `pi` uses works here too. The
 * conversation is stored in SQLite: stop and restart the host and it carries on.
 *
 * It prints what the conversation does as it goes: client requests, runs and turns, what the
 * model says and calls, tool output as it streams, and submissions. `--raw` adds every agent
 * event as JSON.
 */

import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { Harness, createRegistry, watchEvents } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { sharedSession } from "../src/agent.ts";
import { serveConversation } from "../src/node-host.ts";
import { dim, logLine, traceEvents } from "../src/log.ts";

const { values } = parseArgs({
  options: {
    socket: { type: "string", default: "/tmp/pi-durable.sock" },
    db: { type: "string", default: "/tmp/pi-durable.sqlite" },
    cwd: { type: "string", default: process.cwd() },
    model: { type: "string" },
    name: { type: "string", default: "agent" },
    raw: { type: "boolean", default: false },
  },
});
const cwd = values.cwd!;
const log = (text: string) => logLine(text);

log(dim("loading Pi's models and extensions…"));
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
registry.install(sharedSession(values.name!));
const harness = await Harness.open(
  await openNodeSqliteStorage(values.db!),
  {
    models,
    registry,
    env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir ?? cwd }),
    onReport: (error, info) => log(`\x1b[31mreport ${info.type}\x1b[0m ${error instanceof Error ? error.message : String(error)}`),
  },
  context,
);
const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id }, cwd } });

// The host's own view of the conversation, printed as it happens; clients get theirs separately.
const trace = traceEvents({ raw: values.raw });
const watch = await watchEvents(harness, root.id, context);
trace([watch.snapshot]);
watch.start(async events => trace(events));

harness.resume();
const host = await serveConversation(harness, root, values.socket!, { agentName: values.name, log: line => log(dim(line)) });
log(`durable session on ${host.socketPath} (${model.provider}/${model.id}, ${values.db}, cwd ${cwd})`);

const stop = async () => {
  log(dim("stopping"));
  await host.close();
  await watch.stop();
  await harness.close(context);
  pi.dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
