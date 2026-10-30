# pi-multiplayer

> Experimental.

A Pi extension that makes Pi a client of a [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) session. Several Pi clients can share one session. Pi keeps its terminal UI, editor, queues and Esc. The agent, meaning the model turns, the tool calls and the transcript, runs in the durable session.

## How it works

Pi's agent loop asks for one assistant message, runs that message's tool calls, and asks again. A durable conversation produces the same sequence on its own. The extension lines the two up:

- **The `durable` provider** (`src/provider.ts`) answers each Pi model request with the conversation's next assistant turn. It first sends the user messages Pi added since the last answer: the prompt, plus steers and follow-ups that reach it this way. Text and thinking stream as deltas; each tool call is sent once its block is complete.
- **Stand-in tools** take the names of the conversation's tools (`bash`, `read`, …). They do no work: each waits for the remote result of the call with the same id and streams its output in the meantime. Because they replace the built-ins by name, Pi's built-in renderers still draw them.
- **Input from other clients** (for example the iPhone) appears in Pi as a `durable-remote-input` message and starts a Pi turn, so Pi shows runs it didn't start. Steers and follow-ups typed while Pi is busy go to the conversation immediately, and the conversation places them.
- **Names on every message.** Each user message is headed by its author (`PI_DURABLE_USER`, otherwise your OS user name). Each assistant message is headed by the agent's name and model (the host's `--name`). The model sees each message as `alice: …`, so it knows who is asking.
- **Several people can share one session.** Any number of Pi clients can connect to the same host. A steer from another person shows up in every window where the host placed it: the stand-in tools keep Pi's tool round open until the host's round is over.
- **The mirror** (`src/mirror.ts`) queues remote turns and tool results, keyed by call id, so the provider and the stand-ins can take them whenever Pi asks.

The wire (`src/protocol.ts`) is JSON lines over a Unix socket: a snapshot plus the session's agent name, model and tools, then `watchEvents` batches, plus `submit` and `abort`. The same protocol could run over a WebSocket, for example to a Cloudflare Durable Object that holds the session.

## Try it

```sh
npm install
npx tsx bin/host.ts --socket /tmp/pdc.sock --db /tmp/pdc.sqlite --cwd ~/some/repo --model opencode-cf/claude-haiku-5-5 --name haiku
# one terminal per person
PI_DURABLE_SOCKET=/tmp/pdc.sock PI_DURABLE_USER=alice pi -e ./src/extension.ts
PI_DURABLE_SOCKET=/tmp/pdc.sock PI_DURABLE_USER=bob pi -e ./src/extension.ts
```

The host takes models and credentials from your Pi setup, including providers that your Pi extensions register.

As it runs, the host prints what it's doing:

- client connections and requests
- runs and turns
- what the model says and which tools it calls
- each tool's output as it streams
- how each submission is placed and settled

Add `--raw` to also print every agent event as JSON.

## Tests

`npm test` runs Pi (through its SDK) against a durable host that uses a faux model. The tests cover:

- tool calls
- streaming
- input from another client
- Esc
- steering mid-run
- a tool Pi has no built-in for
- a follow-up queued by another client
- reconnecting after the host restarts
- author names, both what the model sees and what Pi shows

## Known gaps

- **History on attach.** Pi shows only what happens after it connects. To catch up, project the conversation's entries into a Pi session file and open it.
- **Runs that continue while Pi is disconnected.** After a reconnect, Pi doesn't show what it missed (same fix).
- **Pi's local commands.** `/compact`, `/model`, `/tree` and `/fork` act on Pi's own copy of the transcript. They need durable counterparts.
- **Tools added mid-run.** The tools available in a Pi run are fixed when the run starts. A tool the conversation gains during a run shows as "not found" in Pi for that run, while the remote call still runs.
- **Ordering.** Another person's steer lines up exactly when it lands in a tool round. A message placed while Pi is streaming a turn shows after that turn. The host's order is authoritative.
- **Access.** Anyone who can open the socket can type into the session, and its tools run as the host's user.
