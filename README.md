# pi-multiplayer

> Experimental. pi-durable is experimental too, and the versions here are pinned exactly.

Several people, and several agents, share one [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) session:

- **Pi** joins with an extension. Pi keeps its terminal UI, editor, queues and Esc; the agent (model turns, tool calls, transcript) runs in the session.
- **OpenCode** joins through [ATXF](https://github.com/leostera/agent-transcript-exchange-format): a bridge keeps the session and an ATXF shared file in sync, and OpenCode's `/atxf join` joins the file.
- **The session** runs on your machine (a Node host on a Unix socket, with your files, shell and Pi's models), or on Cloudflare (a Durable Object per session, behind Cloudflare Access, on Workers AI).

Every message says who wrote it. The model sees `alice: …`, Pi shows each message under its author, and OpenCode's messages arrive as `carol (in opencode): …` and `[opencode, another agent in this session, replied:] …`.

## Packages

| Package | What it is |
| --- | --- |
| [`packages/protocol`](packages/protocol) | The wire: one JSON message per line or frame. A snapshot, then event batches; `submit`, `write`, `abort`. |
| [`packages/server`](packages/server) | `SessionServer`, which serves one conversation to many clients over any transport, and the Node host (`bin/host.ts`) on a Unix socket. |
| [`packages/client`](packages/client) | `connectConversation(target)` for a socket path or a `ws(s)://` URL, with Cloudflare Access tokens from `cloudflared`. |
| [`packages/pi`](packages/pi) | The Pi extension. |
| [`packages/worker`](packages/worker) | The Cloudflare Worker and the `PiSession` Durable Object. |
| [`packages/atxf`](packages/atxf) | The ATXF bridge for OpenCode and any other ATXF agent. |

```sh
bun install
bun test          # Pi against a faux-model host, the ATXF bridge, the Access gate
bun run typecheck # and: cd packages/worker && ../../node_modules/.bin/tsc
```

The ATXF bridge needs `@leostera/atxf` 0.2, which is not on npm yet. Until it is, clone [agent-transcript-exchange-format](https://github.com/leostera/agent-transcript-exchange-format) and run `bun install && bun run build && cd packages/atxf-ts && bun link` there before `bun install` here.

## Join the shared session

There is one deployed at `pi-multiplayer.lostera.me.cloudflare.dev`, for the Agent Experience team. Each session is a name: `wss://pi-multiplayer.lostera.me.cloudflare.dev/s/<name>`, and a new name starts an empty one. Its agent is `kimi` (Kimi K2.6 on Workers AI). It has no tools yet: it has no files or shell of its own.

First, log in to Access once (it opens your browser):

```sh
cloudflared access login https://pi-multiplayer.lostera.me.cloudflare.dev
```

Your messages are signed with your Access identity (`lostera@cloudflare.com` signs as `lostera`).

### From Pi

```sh
pi -e ./packages/pi/src/extension.ts --multiplayer wss://pi-multiplayer.lostera.me.cloudflare.dev/s/ax
```

The extension does nothing without `--multiplayer`, so it is safe to keep loaded.

### From OpenCode

1. Install the ATXF plugin. From the ATXF checkout, add its `packages/opencode-atxf` path to `~/.config/opencode/cli.json`:

   ```json
   { "plugins": ["/path/to/agent-transcript-exchange-format/packages/opencode-atxf"] }
   ```

2. Start the bridge. It keeps the session and a shared file in sync:

   ```sh
   bun packages/atxf/bin/atxf.ts wss://pi-multiplayer.lostera.me.cloudflare.dev/s/ax ~/.local/share/pi-multiplayer/ax.atxf.jsonl
   ```

3. In OpenCode, open a new session and join the file:

   ```
   /atxf join ~/.local/share/pi-multiplayer/ax.atxf.jsonl
   ```

   The OpenCode session becomes a copy of the shared one. Between turns, OpenCode pulls what the session gains, and the bridge brings OpenCode's turns into the session after each one.

OpenCode keeps its own agent and model. Its turns are context in the session: they show in Pi and kimi reads them, but they don't start a kimi run. Pull happens only while OpenCode is idle, because the plugin replaces the session to update it.

## Run it locally

### With your files and shell: the Node host

```sh
bun packages/server/bin/host.ts --socket /tmp/pm.sock --db /tmp/pm.sqlite --cwd ~/some/repo --model <provider>/<model> --name haiku
# one terminal per person; messages are signed with $USER
pi -e ./packages/pi/src/extension.ts --multiplayer /tmp/pm.sock
USER=bob pi -e ./packages/pi/src/extension.ts --multiplayer /tmp/pm.sock
```

The host uses your Pi setup's models and credentials, including providers from your Pi extensions, and runs Pi's coding tools in `--cwd`. It prints connections, requests, runs, turns, tool output and how each submission is placed; `--raw` adds every event as JSON.

### The Worker, on workerd

```sh
cd packages/worker
printf 'CLOUDFLARE_API_TOKEN=<token that can run Workers AI>\nCLOUDFLARE_ACCOUNT_ID=<account id>\n' > .dev.vars
bun run dev      # wrangler dev -e local, on http://localhost:8787
pi -e ../pi/src/extension.ts --multiplayer ws://localhost:8787/s/test
```

The `local` environment has no Access (it only answers on localhost) and calls Workers AI over its REST API, since the AI binding's local proxy would run on your account's `workers.dev` host.

## Deploy your own

1. In `packages/worker/wrangler.jsonc`, set `account_id` and the hostname in `routes`. Choose the model (`MODEL`, any Workers AI chat model in pi-ai's catalog) and `AGENT_NAME`.
2. Create a self-hosted Access application for the hostname, with a policy for the people who may join. Put its AUD tag in `ACCESS_AUD` and your team domain in `ACCESS_TEAM_DOMAIN`.
3. `cd packages/worker && bunx wrangler deploy`.

The Worker re-verifies every request's Access JWT (signature, issuer, audience, expiry) and fails closed without a valid configuration. It only admits `@cloudflare.com` people (`personFromEmail` in `src/access.ts`): service tokens are refused, since every message is somebody's. `workers_dev` and preview URLs are off, because they would sidestep Access. The model is called through AI Gateway (`AI_GATEWAY`, `default` by default) over the AI binding, so there are no API keys to manage.

## How the Pi extension works

Pi's agent loop asks for one assistant message, runs its tool calls, and asks again. A durable conversation produces the same sequence on its own. The extension lines the two up:

- **The `durable` provider** (`provider.ts`) answers each of Pi's model requests with the conversation's next assistant turn. It first sends the user messages Pi added since the last answer. Text and thinking stream as deltas; each tool call is sent once its block is complete.
- **Stand-in tools** are named like the conversation's tools (`bash`, `read`, …) and do no work. Each waits for the remote result of the call with the same id, streaming its output meanwhile. Pi's built-in renderers still draw them.
- **Input from other clients** shows up as a `durable-remote-input` message and starts a Pi turn, so Pi follows runs it didn't start. Steers and follow-ups typed while Pi is busy go to the conversation at once, and the conversation places them.
- **Other agents' messages** (from the ATXF bridge) show under their names and stay out of Pi's own model context.
- **The mirror** (`mirror.ts`) queues remote turns and tool results by call id, until the provider and the stand-ins ask for them.

## How the ATXF bridge works

The session projects to ATXF records with stable ids and times (`project.ts`), so pushing it again adds nothing. Records the file gains from other agents are written into the session as peer entries, keyed by record id, so restarting the bridge writes nothing twice. A peer entry projects back to the very record it came from, and OpenCode's converter round-trips foreign records exactly, so no copy ever holds a message twice.

## Known gaps

- **History on attach.** Pi shows only what happens after it connects (the session has it all). To catch up, project the entries into a Pi session file and open it.
- **Pi's local commands.** `/compact`, `/model`, `/tree` and `/fork` act on Pi's own copy of the transcript.
- **Tools added mid-run** show as "not found" in Pi for that run; the remote call still runs.
- **The deployed agent has no tools.** Next: a machine lends its files and shell to a session (pi-env's `RemoteExecutionEnv` over the same WebSocket).
- **OpenCode talks to its own agent.** An OpenCode message does not start a kimi run.
- **The local socket** has no access control: anyone who can open it can type into the session, and its tools run as the host's user.
