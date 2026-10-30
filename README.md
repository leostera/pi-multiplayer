# pi-durable-client (spike)

A Pi extension that makes Pi a client of a [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) session. Pi keeps its terminal UI, editor, queues and Esc. The agent, meaning the model turns, the tool calls and the transcript, runs in the durable session.

## How it works

Pi's agent loop asks for one assistant message, runs that message's tool calls, and asks again. A durable conversation produces the same sequence on its own. The extension lines the two up:

- **The `durable` provider** (`src/provider.ts`) answers each Pi model request with the conversation's next assistant turn. It first sends the user messages Pi added since the last answer: the prompt, plus steers and follow-ups that reach it this way. Text and thinking stream as deltas; each tool call is sent once its block is complete.
- **Stand-in tools** take the names of the conversation's tools (`bash`, `read`, …). They do no work: each waits for the remote result of the call with the same id and streams its output in the meantime. Because they replace the built-ins by name, Pi's built-in renderers still draw them.
- **Input from other clients** (for example the iPhone) appears in Pi as a `durable-remote-input` message and starts a Pi turn, so Pi shows runs it didn't start. Steers and follow-ups typed while Pi is busy go to the conversation immediately, and the conversation places them.
- **The mirror** (`src/mirror.ts`) queues remote turns and tool results, keyed by call id, so the provider and the stand-ins can take them whenever Pi asks.

The wire (`src/protocol.ts`) is JSON lines over a Unix socket: a snapshot plus the tool names, then `watchEvents` batches, plus `submit` and `abort`. In Axo this would be a WebSocket to a session Durable Object.

## Try it

```sh
npm install
npx tsx bin/host.ts --socket /tmp/pdc.sock --db /tmp/pdc.sqlite --cwd ~/some/repo --model opencode-cf/claude-haiku-5-5
# another terminal
PI_DURABLE_SOCKET=/tmp/pdc.sock pi -e ./src/extension.ts
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

## Known gaps

- **History on attach.** Pi shows only what happens after it connects. To catch up, project the conversation's entries into a Pi session file and open it (the same pi/3 projection RFD0018 needs).
- **Runs that continue while Pi is disconnected.** After a reconnect, Pi doesn't show what it missed (same fix).
- **Pi's local commands.** `/compact`, `/model`, `/tree` and `/fork` act on Pi's own copy of the transcript. They need durable counterparts.
- **Tools added mid-run.** The tools available in a Pi run are fixed when the run starts. A tool the conversation gains during a run shows as "not found" in Pi for that run, while the remote call still runs.
- **Ordering.** Pi and the conversation place steers by the same rule (after the current tool round), but nothing enforces that. The conversation is authoritative.
