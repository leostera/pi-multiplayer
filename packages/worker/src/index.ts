/**
 * pi-multiplayer on Cloudflare: each session is a Durable Object that holds one pi-durable
 * conversation and serves it to every client over WebSockets.
 *
 *   wss://<host>/s/<name>   join session <name> (made on first join)
 *   https://<host>/         who you are and how to join
 *
 * Everything sits behind Cloudflare Access; the Worker checks the Access JWT again and signs
 * every message with the person it names. The agent runs on Workers AI (see `models.ts`).
 * Locally (`wrangler dev -e local`, only on localhost) there is no Access and clients sign their
 * own messages.
 */

import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { SessionServer, type AttachedClient } from "@pi-multiplayer/server";
import { sharedSession } from "@pi-multiplayer/server/agent";
import { checkAccess, createVerifier, parseAccessConfig, refusalResponse, type Verifier } from "./access.ts";
import { workersAiModels, type ModelAccess } from "./models.ts";

export interface Env {
  SESSIONS: DurableObjectNamespace<PiSession>;
  /** The Workers AI binding; absent locally, where the model is called with an API token. */
  AI?: AiBinding;
  /** Local only (`.dev.vars`): a token that can run Workers AI, and its account. */
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** The AI Gateway the model calls go through. */
  AI_GATEWAY: string;
  /** A Workers AI model id, e.g. `@cf/moonshotai/kimi-k2.6`. */
  MODEL: string;
  /** The agent's name in the session. */
  AGENT_NAME: string;
  /** `1` in the `local` environment (`wrangler dev -e local`): no Access, and only on localhost. */
  LOCAL_DEV?: string;
}

const SESSION_PATH = /^\/s\/([a-z0-9][a-z0-9-]{0,62})$/;
// The person the Worker verified, passed to the session; the session is reachable only through here.
const PERSON_HEADER = "x-pi-multiplayer-person";

let verifier: { key: string; verify: Verifier | null } | undefined;
function verifierFor(env: Env): Verifier | null {
  const key = `${env.ACCESS_TEAM_DOMAIN}|${env.ACCESS_AUD}`;
  if (verifier?.key !== key) {
    const config = parseAccessConfig(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
    verifier = { key, verify: config && createVerifier(config) };
  }
  return verifier.verify;
}

function isLocal(request: Request, env: Env): boolean {
  const { hostname } = new URL(request.url);
  return env.LOCAL_DEV === "1" && (hostname === "localhost" || hostname === "127.0.0.1");
}

export default {
  async fetch(request, env): Promise<Response> {
    let person: string | undefined;
    if (!isLocal(request, env)) {
      const decision = await checkAccess(request, verifierFor(env), new Date());
      if (!decision.allowed) return refusalResponse(decision.refusal);
      person = decision.person;
    }

    const url = new URL(request.url);
    const session = SESSION_PATH.exec(url.pathname)?.[1];
    if (session) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("join with a WebSocket client: pi --multiplayer <this URL>\n", { status: 426 });
      }
      const headers = new Headers(request.headers);
      headers.delete(PERSON_HEADER);
      if (person) headers.set(PERSON_HEADER, person);
      return env.SESSIONS.getByName(session).fetch(new Request(request, { headers }));
    }
    if (url.pathname === "/") {
      const local = isLocal(request, env);
      const wss = `${local ? "ws" : "wss"}://${url.host}/s/<name>`;
      return new Response(
        [
          `pi-multiplayer${person ? ` — you are ${person}` : ""}`,
          "",
          `Pi:       pi -e <pi-multiplayer>/packages/pi/src/extension.ts --multiplayer ${wss}`,
          `OpenCode: bun <pi-multiplayer>/packages/atxf/bin/atxf.ts ${wss} <file>.atxf.jsonl, then /atxf join <file>.atxf.jsonl`,
          "",
          ...(local ? [] : [`First: cloudflared access login https://${url.host}`, ""]),
        ].join("\n"),
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function modelAccess(env: Env): ModelAccess {
  if (env.AI) return { binding: env.AI, gateway: env.AI_GATEWAY };
  if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
    return { apiToken: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID };
  }
  throw new Error("no model: bind AI, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .dev.vars");
}

/** One shared session: a pi-durable conversation, and the people and agents attached to it. */
export class PiSession extends DurableObject<Env> {
  #server?: Promise<SessionServer>;

  async fetch(request: Request): Promise<Response> {
    const server = await this.server();
    const author = request.headers.get(PERSON_HEADER) ?? undefined;
    const { 0: client, 1: socket } = new WebSocketPair();
    socket.accept();

    // Frames that arrive while the client is being attached wait for it.
    const early: string[] = [];
    let attached: AttachedClient | undefined;
    let closed = false;
    socket.addEventListener("message", event => {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      // A request may start a run: if the object is evicted mid-run, the alarm resumes it.
      this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 60_000));
      if (attached) attached.receive(text);
      else early.push(text);
    });
    const close = () => {
      closed = true;
      void attached?.detach();
    };
    socket.addEventListener("close", close);
    socket.addEventListener("error", close);

    server
      .attach({ send: text => socket.readyState === WebSocket.OPEN && socket.send(text) }, { author })
      .then(client => {
        attached = client;
        if (closed) return void client.detach();
        for (const text of early.splice(0)) client.receive(text);
      })
      .catch(error => socket.close(1011, error instanceof Error ? error.message.slice(0, 120) : "could not attach"));

    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    // Wakes runs that were in flight when the object was evicted.
    (await this.harness()).resume();
  }

  private server(): Promise<SessionServer> {
    this.#server ??= this.open().catch(error => {
      this.#server = undefined;
      throw error;
    });
    return this.#server;
  }

  #harness?: Harness;
  private async harness(): Promise<Harness> {
    await this.server();
    return this.#harness!;
  }

  private async open(): Promise<SessionServer> {
    const { models, model } = workersAiModels(modelAccess(this.env), this.env.MODEL);
    const registry = createRegistry();
    registry.install(sharedSession(this.env.AGENT_NAME));
    const harness = await Harness.open(
      await openDurableObjectSqliteStorage(this.ctx.storage),
      {
        models,
        registry,
        onReport: (error, info) => console.error(`pi-durable ${info.type}`, error),
      },
      context,
    );
    const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
    harness.resume();
    this.#harness = harness;
    return new SessionServer(harness, root, { agentName: this.env.AGENT_NAME, log: line => console.log(line) });
  }
}
