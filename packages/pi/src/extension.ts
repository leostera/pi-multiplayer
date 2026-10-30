/**
 * A Pi extension that makes Pi a client of a durable session.
 *
 * Pi keeps its terminal UI, editor, queues, and abort; the agent itself runs in the durable
 * session. Three pieces line Pi's agent loop up with the remote conversation:
 *
 * - the `durable` provider answers each of Pi's model requests with the conversation's next
 *   assistant turn (see `provider.ts`);
 * - stand-in tools named like the remote tools (`bash`, `read`, ...) do no work: each waits for
 *   the remote result of the call with the same id. Pi's built-in renderers still draw them;
 * - input placed into the conversation by someone else (another client) is shown in Pi and
 *   starts a Pi turn, so Pi follows runs it did not start.
 *
 * In a shared session every message says who wrote it: each user message is headed by its
 * author and each assistant message by the agent's name.
 *
 * Enable it with `PI_DURABLE_SOCKET=<path> pi -e <this file>`. Messages are signed with `$USER`.
 */

import { userInfo } from "node:os";
import {
  getMarkdownTheme,
  UserMessageComponent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connectConversation } from "@pi-multiplayer/client";
import { Mirror } from "./mirror.ts";
import { durableStreamSimple } from "./provider.ts";

export const PROVIDER = "durable";
export const MODEL = "session";
const REMOTE_INPUT = "durable-remote-input";
// Registered before connecting, so the session starts with Pi's built-ins replaced.
const KNOWN_TOOLS = ["read", "bash", "edit", "write"];

export interface DurableClientOptions {
  socketPath?: string;
  /** Who this Pi submits as. Default: `$USER`, else the OS user name. */
  author?: string;
}

interface RemoteInputDetails {
  author?: string;
}

export function createDurableClientExtension(options: DurableClientOptions = {}) {
  return (pi: ExtensionAPI) => {
    const socketPath = options.socketPath ?? process.env.PI_DURABLE_SOCKET;
    const author = options.author ?? process.env.USER ?? userInfo().username;
    // The heading of assistant messages; until connected the agent has no name of its own.
    let agentHeading = "**agent**";
    let connecting: Promise<Mirror> | undefined;
    let mirror: Mirror | undefined;
    let busy = false;
    // Stand-in tools Pi is running: while any is, Pi is in a tool round.
    let toolsRunning = 0;
    // A Pi turn was requested (by `sendMessage`) and has not started yet.
    let triggered = false;
    const echoes: string[] = [];
    const registered = new Set<string>();

    const connectMirror = (): Promise<Mirror> => {
      if (!socketPath) return Promise.reject(new Error("set PI_DURABLE_SOCKET to the durable session's socket"));
      connecting ??= connectConversation(socketPath).then(
        remote => {
          mirror = new Mirror(remote, author);
          agentHeading = `**${remote.session.agent}** · _${remote.session.model}_`;
          // A lost connection is reopened by the next request; the conversation's state is the
          // host's, so nothing here needs to survive it.
          remote.onClose(() => {
            connecting = undefined;
            mirror = undefined;
          });
          // Stand-ins are fixed for each Pi run, so register one for every remote tool up front.
          remote.session.tools.forEach(registerStandIn);
          mirror.onForeignInput = ({ author: from, text }) => {
            // Shown in Pi's transcript, and sent to the provider as a user message the remote
            // conversation already has; `echoes` keeps the provider from submitting it again.
            echoes.push(text);
            if (!busy) triggered = true;
            // Idle, it starts a Pi turn that follows the run it started. In a tool round, it is
            // a steer the remote conversation placed after that round: Pi delivers it there too
            // (the stand-ins hold the round open until the remote one is over). Otherwise Pi is
            // streaming a turn: show it after that turn without asking for another one.
            const message = { customType: REMOTE_INPUT, content: text, display: true, details: { author: from } satisfies RemoteInputDetails };
            if (!busy) pi.sendMessage(message, { triggerTurn: true });
            else if (toolsRunning > 0) pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
            else pi.sendMessage(message, { triggerTurn: false });
          };
          // The remote conversation went on after Pi's loop ended (a steer it placed after the
          // final answer, a follow-up, a hook that continued the run): start a Pi turn to show it.
          mirror.onTurnQueued = () => followRemote();
          return mirror;
        },
        error => {
          connecting = undefined;
          throw error;
        },
      );
      return connecting;
    };

    const registerStandIn = (name: string) => {
      if (registered.has(name)) return;
      registered.add(name);
      pi.registerTool({
        name,
        label: name,
        description: `Runs in the durable session. (${name})`,
        // The remote conversation validated the arguments already; accept whatever it sent.
        parameters: Type.Object({}, { additionalProperties: true }),
        async execute(toolCallId, _params, signal, onUpdate) {
          const current = await connectMirror();
          const tool = current.tool(toolCallId);
          toolsRunning++;
          try {
            await new Promise<void>((resolve, reject) => {
              const update = () => {
                if (tool.ended) return finish(resolve);
                onUpdate?.({ content: [{ type: "text", text: tool.output }], details: tool.details as never });
              };
              const onAbort = () => finish(() => reject(new Error("aborted")));
              const unsubscribe = tool.changed.subscribe(update);
              const finish = (then: () => void) => {
                unsubscribe();
                signal?.removeEventListener("abort", onAbort);
                then();
              };
              signal?.addEventListener("abort", onAbort, { once: true });
              update();
            });
            await current.roundEnded(tool);
          } catch (error) {
            await current.abort().catch(() => {});
            throw error;
          } finally {
            toolsRunning--;
            current.forgetTool(toolCallId);
          }
          if (!tool.result) {
            return { content: [{ type: "text", text: "The call ended in the durable session without a result." }], details: undefined, isError: true };
          }
          return { content: tool.result.content, details: tool.details as never, isError: tool.result.isError };
        },
      });
    };
    for (const name of KNOWN_TOOLS) registerStandIn(name);

    // Pi's own messages are this user's; every assistant message is the agent's.
    pi.registerMarkdownTransformer((markdown, context) => {
      if (context.messageType === "user") return `**${author}**\n\n${markdown}`;
      if (context.messageType === "assistant") return `${agentHeading}\n\n${markdown}`;
      return markdown;
    });
    // Someone else's message, drawn like a user message under their name.
    pi.registerMessageRenderer<RemoteInputDetails>(REMOTE_INPUT, (message, { outputPad }) => {
      const content = typeof message.content === "string" ? message.content : message.content.map(part => (part.type === "text" ? part.text : "")).join("");
      return new UserMessageComponent(`**${message.details?.author ?? "someone"}**\n\n${content}`, getMarkdownTheme(), outputPad);
    });

    pi.registerProvider(PROVIDER, {
      name: "Durable session",
      baseUrl: "durable://session",
      apiKey: "unused",
      api: "durable-session",
      models: [
        {
          id: MODEL,
          name: "Durable session",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        },
      ],
      streamSimple: durableStreamSimple({
        mirror: connectMirror,
        echoes,
        // A tool the conversation gained after Pi connected (an MCP server, `tool_search`) has no
        // stand-in in the current Pi run, whose tools are fixed; Pi shows "not found" for it this
        // once, while the remote call still runs. Register it for the next run.
        onToolCalls: names => names.forEach(registerStandIn),
      }),
    });

    const followRemote = () => {
      if (busy || triggered || !mirror || mirror.queuedTurns === 0) return;
      triggered = true;
      echoes.push("");
      pi.sendMessage({ customType: REMOTE_INPUT, content: "", display: false, details: undefined }, { triggerTurn: true });
    };

    // Steers and follow-ups typed while Pi is busy go to the remote conversation right away, so
    // it places them by its own rules; Pi still queues and shows them, and the provider does not
    // send them again when Pi delivers them.
    pi.on("input", async event => {
      if (event.streamingBehavior === undefined || event.source === "extension") return { action: "continue" };
      const current = await connectMirror();
      echoes.push(event.text);
      await current.submit(`pi:${event.streamingBehavior}:${Date.now()}:${Math.random().toString(36).slice(2)}`, event.text, event.streamingBehavior);
      return { action: "continue" };
    });
    pi.on("agent_start", () => {
      busy = true;
      triggered = false;
    });
    pi.on("agent_settled", () => {
      busy = false;
      followRemote();
    });
    pi.on("session_start", async (_event, ctx: ExtensionContext) => {
      const model = ctx.modelRegistry.find(PROVIDER, MODEL);
      if (model && ctx.model?.provider !== PROVIDER) await pi.setModel(model);
      // Connect now so input from other clients shows up before the first prompt.
      await connectMirror().catch(error => ctx.ui.notify(`Durable session: ${error.message}`, "error"));
    });
    pi.on("session_shutdown", () => {
      mirror?.close();
      connecting = undefined;
      mirror = undefined;
    });
  };
}

export default createDurableClientExtension();
