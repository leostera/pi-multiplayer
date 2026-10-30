import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, type Conversation } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { serveConversation, type DurableHost } from "@pi-multiplayer/server/node";
import { connectConversation } from "@pi-multiplayer/client";
import { MESSAGE_KIND } from "@pi-multiplayer/protocol";
import { createDurableClientExtension, MODEL, PROVIDER } from "../src/extension.ts";

interface World {
  dir: string;
  faux: ReturnType<typeof fauxProvider>;
  harness: Harness;
  root: Conversation;
  host: DurableHost;
  pi: AgentSession;
}

let world: World;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdc-"));
  const faux = fauxProvider({ tokensPerSecond: 400 });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(
    defineExtension({
      name: "counting",
      tools: [
        defineTool({
          name: "count",
          description: "Count from 1 to n",
          parameters: Type.Object({ n: Type.Number() }),
          execute: async (args, api) => {
            for (let i = 1; i <= args.n; i++) api.output(`${i}\n`);
            return {};
          },
        }),
      ],
    }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? dir }),
      settings: { progress: { partialIntervalMs: 10, outputIntervalMs: 10 } },
    },
    context,
  );
  const model = faux.getModel();
  const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id }, cwd: dir } });
  const host = await serveConversation(harness, root, join("/tmp", `pdc-${process.pid}-${Math.random().toString(36).slice(2)}.sock`), {
    agentName: "pal",
  });

  const agentDir = join(dir, "agent");
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir,
    extensionFactories: [createDurableClientExtension({ socketPath: host.socketPath, author: "alice" })],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir,
    resourceLoader,
    modelRuntime,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });
  await session.bindExtensions({});
  const durable = session.modelRuntime.getModel(PROVIDER, MODEL);
  assert.ok(durable, "the extension registers the durable model");
  await session.setModel(durable);
  world = { dir, faux, harness, root, host, pi: session };
});

afterEach(async () => {
  world.pi.dispose();
  await world.host.close();
  await world.harness.close(context);
  rmSync(world.dir, { recursive: true, force: true });
});

const respond = (...steps: FauxResponseStep[]) => world.faux.setResponses(steps);

function transcript(session: AgentSession) {
  // What Pi shows: its system message and hidden custom messages are not drawn.
  const shown = session.messages.filter(message => message.role !== "system" && !(message.role === "custom" && !message.display));
  return shown.map(message => {
    switch (message.role) {
      case "user":
        return { user: text(message.content) };
      case "custom": {
        const author = (message.details as { author?: string } | undefined)?.author;
        return { remoteInput: text(message.content as never), ...(author ? { author } : {}) };
      }
      case "assistant":
        return {
          assistant: message.content.map(block =>
            block.type === "text" ? block.text
            : block.type === "thinking" ? `(thinking) ${block.thinking}`
            : `${block.name}(${JSON.stringify(block.arguments)})`,
          ),
          stop: message.stopReason,
        };
      case "toolResult":
        return { tool: message.toolName, result: text(message.content), error: message.isError };
      default:
        return { other: message.role };
    }
  });
}

function text(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === "string" ? content : content.map(part => part.text ?? `[${part.type}]`).join("");
}

const ANSWER = "It printed hi and there. ".repeat(12).trim();

test("a Pi prompt runs in the durable session and Pi shows its turns and tool calls", async () => {
  respond(
    fauxAssistantMessage(
      [fauxThinking("Need to run it."), fauxText("Let me check."), fauxToolCall("bash", { command: "echo hi; echo there" }, { id: "call_1" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(ANSWER),
  );
  const streamed: string[] = [];
  world.pi.subscribe(event => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") streamed.push(event.assistantMessageEvent.delta);
  });

  await world.pi.prompt("run echo");

  assert.deepEqual(transcript(world.pi), [
    { user: "run echo" },
    { assistant: ["(thinking) Need to run it.", "Let me check.", 'bash({"command":"echo hi; echo there"})'], stop: "toolUse" },
    { tool: "bash", result: "hi\nthere\n", error: false },
    { assistant: [ANSWER], stop: "stop" },
  ]);
  assert.ok(streamed.length > 2, `text streams as deltas (got ${streamed.length})`);
  // The remote conversation holds the same run, including the user input Pi sent.
  const entries = (await world.root.entries({}, 100, undefined, context)).items
    .toSorted((a, b) => Number(a.id) - Number(b.id))
    .map(entry => entry.kind);
  assert.deepEqual(entries.filter(kind => kind !== "pi.system"), [MESSAGE_KIND, "pi.assistant", "pi.tool-result", "pi.assistant"]);
});

test("input from another client shows up in Pi and Pi follows the run", async () => {
  respond(fauxAssistantMessage("Hello from the phone's question."));

  // Another client (say, the iPhone) submits straight to the conversation.
  const submission = await world.root.submit({ type: "input", content: "sent from the phone", requestId: "phone-1" }, context);
  await submission.wait(context);
  await waitUntil(() => world.pi.messages.some(m => m.role === "assistant"));
  await world.pi.waitForIdle();

  assert.deepEqual(transcript(world.pi), [
    { remoteInput: "sent from the phone" },
    { assistant: ["Hello from the phone's question."], stop: "stop" },
  ]);
  // Pi did not submit the input a second time.
  const users = (await world.root.entries({}, 100, undefined, context)).items.filter(entry => entry.kind === "pi.user" || entry.kind === MESSAGE_KIND);
  assert.equal(users.length, 1);
});

test("Esc in Pi aborts the remote run", async () => {
  respond(
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5; echo late" }, { id: "slow" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("should never be asked for"),
  );
  const prompt = world.pi.prompt("run something slow");
  await waitUntil(() => world.pi.messages.some(m => m.role === "assistant"));
  await new Promise(resolve => setTimeout(resolve, 200));
  await world.pi.abort();
  await prompt.catch(() => {});

  await world.root.waitForIdle(context);
  const results = (await world.root.entries({}, 100, undefined, context)).items.filter(e => e.kind === "pi.tool-result");
  const result = results[0]?.model?.[0];
  assert.equal(result?.role, "toolResult");
  assert.ok(result?.role === "toolResult" && result.isError, "the remote bash call was aborted");
  assert.equal(world.faux.getPendingResponseCount(), 1, "the remote conversation did not continue after the abort");
});

test("a steer typed in Pi while the remote run works reaches its next turn", async () => {
  respond(
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.4; echo a" }, { id: "first" })], { stopReason: "toolUse" }),
    context => {
      const steered = context.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes("use b instead"));
      return fauxAssistantMessage(steered ? "Switching to b." : "Never saw the steer.");
    },
  );
  const prompt = world.pi.prompt("print a");
  await waitUntil(() => world.pi.messages.some(m => m.role === "assistant"));
  await world.pi.prompt("use b instead", { streamingBehavior: "steer" });
  await prompt;
  await world.pi.waitForIdle();

  assert.deepEqual(transcript(world.pi), [
    { user: "print a" },
    { assistant: ['bash({"command":"sleep 0.4; echo a"})'], stop: "toolUse" },
    { tool: "bash", result: "a\n", error: false },
    { user: "use b instead" },
    { assistant: ["Switching to b."], stop: "stop" },
  ]);
  const users = (await world.root.entries({}, 100, undefined, context)).items.filter(entry => entry.kind === "pi.user" || entry.kind === MESSAGE_KIND);
  assert.equal(users.length, 2, "the steer was submitted once");
});

test("a remote tool Pi has never heard of still runs and shows", async () => {
  respond(
    fauxAssistantMessage([fauxToolCall("count", { n: 3 }, { id: "count_1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Counted."),
  );
  await world.pi.prompt("count to three");

  assert.deepEqual(transcript(world.pi), [
    { user: "count to three" },
    { assistant: ['count({"n":3})'], stop: "toolUse" },
    { tool: "count", result: "1\n2\n3\n", error: false },
    { assistant: ["Counted."], stop: "stop" },
  ]);
});

test("a follow-up another client queues during Pi's run is shown and answered after it", async () => {
  respond(
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.3; echo one" }, { id: "one" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("First done."),
    fauxAssistantMessage("Second done."),
  );
  const prompt = world.pi.prompt("first");
  await waitUntil(() => world.pi.messages.some(m => m.role === "assistant"));
  await world.root.submit({ type: "input", content: "second, from the phone", whenBusy: "followUp", requestId: "phone-2" }, context);
  await prompt;
  await waitUntil(() => transcript(world.pi).some(m => m.assistant?.[0] === "Second done."));
  await world.pi.waitForIdle();

  assert.deepEqual(transcript(world.pi), [
    { user: "first" },
    { assistant: ['bash({"command":"sleep 0.3; echo one"})'], stop: "toolUse" },
    { tool: "bash", result: "one\n", error: false },
    { assistant: ["First done."], stop: "stop" },
    { remoteInput: "second, from the phone" },
    { assistant: ["Second done."], stop: "stop" },
  ]);
});

test("Pi reconnects after the host restarts", async () => {
  respond(fauxAssistantMessage("before"), fauxAssistantMessage("after"));
  await world.pi.prompt("one");
  const socketPath = world.host.socketPath;
  await world.host.close();
  world.host = await serveConversation(world.harness, world.root, socketPath, { agentName: "pal" });

  await world.pi.prompt("two");

  assert.deepEqual(transcript(world.pi).slice(-2), [{ user: "two" }, { assistant: ["after"], stop: "stop" }]);
});

test("every message says who wrote it: the model sees the author, and Pi shows other clients' names", async () => {
  let seen = "";
  respond(context => {
    seen = JSON.stringify(context.messages.filter(m => m.role === "user").map(m => m.content));
    return fauxAssistantMessage("Hi both.");
  });
  const bob = await connectConversation(world.host.socketPath);
  assert.equal(bob.session.agent, "pal");
  await bob.submit("bob-1", "bob", "hello pal", "followUp");
  await waitUntil(() => world.pi.messages.some(m => m.role === "assistant"));
  await world.pi.waitForIdle();
  bob.close();

  assert.match(seen, /bob: hello pal/, "the model sees who is asking");
  assert.deepEqual(transcript(world.pi), [
    { remoteInput: "hello pal", author: "bob" },
    { assistant: ["Hi both."], stop: "stop" },
  ]);
  const placed = (await world.root.entries({}, 100, undefined, context)).items.find(entry => entry.kind === MESSAGE_KIND);
  assert.deepEqual(placed?.data, { author: "bob", text: "hello pal" });
});

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
