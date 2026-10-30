# RFD0001 - pi-multiplayer: shared agent sessions

- Feature Name: `pi-multiplayer-shared-sessions`
- Status: Implemented (prototype)
- Author: leostera
- Start Date: 2026-10-30
- Updated: 2026-10-30
- Document Type: Snapshot

## Summary

This RFD records the design of the first pi-multiplayer prototype, as built, and the questions it leaves open. A shared session is one [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) conversation served to many clients. People join from Pi through an extension that turns Pi into a client while keeping its terminal UI. Other agents, OpenCode first, join through a bridge that keeps the session in sync with an ATXF shared file. A session runs either on your machine, as a Node host on a Unix socket with your files and shell, or on Cloudflare, as one Durable Object per session behind Cloudflare Access with Workers AI as its model. Every message is signed by whoever wrote it: the server takes the name from the Access identity, not from the client. The design's invariants are written as Feynman specs in [`specs/`](../../specs). Each safeguard that keeps one true is a named rule there, and the checker confirms the invariant breaks without it.

## Motivation

A coding-agent session belongs to one person on one machine. When two people want to work with the same agent, say one asks and another follows up, or a colleague watches a run and steers it, they take turns at one keyboard or copy transcripts around. Different agents (Pi, OpenCode) can't share a conversation at all, even when they're looking at the same code.

pi-durable already holds a conversation as a durable log, with runs, steers, follow-ups and aborts placed by its own rules, and it can live in a Durable Object. What's missing is the multiplayer layer:

- **A transport for many clients.** That means a wire protocol and a server that streams one conversation to any number of clients and takes their input.
- **Clients people already use.** Pi's TUI, rather than a new UI.
- **Identity.** Who wrote each message, in a form the model sees and the clients show, and that a client can't forge.
- **Other agents.** OpenCode keeps its own agent and model, and its turns become context for the session.
- **A deployment colleagues can join.** Access-gated, with no API keys to hand out.

## Goals

- Several people, each in their own Pi, share one conversation and see the same transcript in the same order.
- Input is placed by the conversation: idle, a message starts a run; during a run, Pi's steer and follow-up keep their meaning.
- Every message names its author; on the deployed server, the author is the Access identity.
- OpenCode takes part through ATXF without changes to OpenCode.
- The same session server runs on a laptop (with tools) and in a Durable Object (without).
- The design is checked: its invariants are model-checked specs, with the rules that keep them.

## Non-goals

- **History on attach in Pi.** Pi shows what happens after it connects; the session has everything before.
- **Durable versions of Pi's local commands.** `/compact`, `/model`, `/tree` and `/fork` act on Pi's own copy.
- **Tools in the deployed session.** The Durable Object has no files or shell (see Future possibilities).
- **OpenCode turns starting kimi runs.** OpenCode talks to its own agent; its turns are context.
- **Access control on the local socket.**

## Guide-level explanation

### Mental model

The **session** is the conversation: an append-only log of entries (messages, tool calls, results) and the runs that produce them, held by pi-durable. The **server** attaches clients to it. Each client gets a **snapshot** of the entries, then every entry committed after it, and sends requests:

- `submit` is a person's message;
- `write` is another agent's message, which adds context without starting a run;
- `abort` stops the run.

**Pi** is a client that doesn't run the agent. Its model is the session (`durable/session`). When Pi asks its "model" for the next turn, the extension answers with the session's next assistant message, and Pi's tools are stand-ins that wait for the session's results. Pi therefore draws everything as usual, and Esc, steering and follow-ups keep working, while the session decides what actually happens.

**OpenCode** isn't a client. Its ATXF plugin joins a shared file; the **bridge** joins the file to the session.

### Joining from Pi

```sh
cloudflared access login https://pi-multiplayer.lostera.me.cloudflare.dev
pi -e ./packages/pi/src/extension.ts --multiplayer wss://pi-multiplayer.lostera.me.cloudflare.dev/s/ax
```

Alice types "what does main.ts do?". The session runs kimi, and every attached Pi shows:

```text
lostera
what does main.ts do?

kimi · workers-ai/@cf/moonshotai/kimi-k2.6
It starts the server.
```

The model sees `lostera: what does main.ts do?`. If Bob types while kimi is working, his Pi queues it as a steer or a follow-up as usual. The session places it, and everyone sees it under Bob's name where it lands.

### Joining from OpenCode

```sh
bun packages/atxf/bin/atxf.ts wss://pi-multiplayer.lostera.me.cloudflare.dev/s/ax ~/.local/share/pi-multiplayer/ax.atxf.jsonl
# in OpenCode, in an open session:
/atxf join ~/.local/share/pi-multiplayer/ax.atxf.jsonl
```

OpenCode's session becomes a copy of the shared one. After each OpenCode turn, the plugin pushes; the bridge writes the new messages into the session. Pi shows `carol · via opencode` and `opencode · another agent`, and kimi reads them as `carol (in opencode): …` and `[opencode, another agent in this session, replied:] …`. When the session gains entries, the bridge pushes them to the file and OpenCode pulls them between turns.

### Running locally

`bun packages/server/bin/host.ts --socket /tmp/pm.sock …` serves a session on a Unix socket using your Pi models and coding tools; `pi … --multiplayer /tmp/pm.sock` joins it. `cd packages/worker && bun run dev` runs the Worker on workerd without Access (localhost only).

## Reference-level explanation

### Components

| Package | Runs in | Owns |
| --- | --- | --- |
| `protocol` | everywhere | The wire types: `ClientRequest` (`submit`, `write`, `abort`) and `HostMessage` (`snapshot`, `events`, `reply`); the entry kinds `multiplayer.message` (`{author, text}`) and `multiplayer.peer` (`{agent, author, role, text, atxfId?}`). |
| `server` | Node, workerd | `SessionServer`: attaching clients (`watchEvents`), signing, placing requests on the conversation. `node-host.ts` serves it on a Unix socket (JSON lines); `agent.ts` is the shared-session system section. |
| `client` | Node, Bun | `connectConversation(target)`: a socket path or `ws(s)://` URL, the snapshot, buffered early batches, requests with ids, the Access token from `cloudflared access token`. |
| `pi` | Pi | The extension: the `durable` provider, stand-in tools, the mirror (`mirror.ts`), names on messages, peer entries drawn under their agent. Active only with `--multiplayer`. |
| `worker` | Cloudflare | The Worker (Access check, routing `/s/<name>`) and `PiSession`, a SQLite-backed Durable Object per session holding the harness and the server. |
| `atxf` | Node, Bun | The bridge: the session's projection to ATXF (`project.ts`), and the shared file's new records written into the session. |

### The wire

A message is one JSON object: a line on a socket, or a frame on a WebSocket. On attach, the server sends `{type: "snapshot", snapshot, session: {agent, model, tools, you?}}`, then `{type: "events", events}` for every committed batch. Requests carry an `id` and get `{type: "reply", id, ok, result | error}`. A `submit` carries `requestId`, which the conversation uses to dedupe, as well as `author`, `content` and `whenBusy: "steer" | "followUp"`. A `write` carries `requestId` and a `peer`.

### Signing

`SessionServer.attach(peer, identity)` takes the identity the transport established. With one, the server replaces `submit.author` with it, and `write.peer.author` too for user-role peers. Without one (the local socket, `wrangler dev`), it uses the client's author. A submit becomes the input `"<author>: <text>"` with the entry `multiplayer.message`. A write becomes a `write` submission: a user-role model message (`peerText`), with the entry `multiplayer.peer`.

### The deployed Worker

1. **Access.** The Access application on the hostname allows the Agent Experience team's emails. `cloudflared access token` gives the CLI a token, sent as `cf-access-token`; Access forwards the request with `cf-access-jwt-assertion`.
2. **The Worker's own check.** It verifies that JWT itself (`access.ts`: RS256, issuer, AUD, expiry with 10 s of skew) and admits only simple `@cloudflare.com` addresses; service tokens are refused. It fails closed without a configuration.
3. **Identity to the session.** It removes any client-sent `x-pi-multiplayer-person` header, sets it to the person, and forwards the upgrade to `SESSIONS.getByName(name)`. `workers_dev` and preview URLs are off.
4. **`PiSession`.** It opens the harness on `openDurableObjectSqliteStorage`, accepts the WebSocket, and attaches it as that person, holding frames that arrive before attaching finishes. Every frame sets an alarm 60 s out, and `alarm()` calls `harness.resume()`, so a run in flight when the object is evicted carries on.
5. **The model.** Workers AI (`MODEL`, default `@cf/moonshotai/kimi-k2.6`), reached through AI Gateway over the AI binding: no API keys. Locally, the REST API with a token from `.dev.vars`.

### The Pi extension

- **The `durable` provider** submits the user messages Pi added since the last answer, then streams the session's next assistant turn as Pi's model response. It names a prompt `pi:<timestamp>:<digest>`, so Pi's retry after a lost connection resubmits the same request id.
- **Stand-in tools**, one per remote tool name, wait for the remote result of the same call id.
- **Input from others** is shown as `durable-remote-input` and starts a Pi turn, so Pi follows runs it didn't start.
- **Steers and follow-ups** typed while Pi is busy are submitted at once, so the session places them.

### The ATXF bridge

- **The projection.** The session projects to records with stable ids (`pm-<session>-<entry>`) and the model messages' own timestamps, so pushing it again adds nothing. A peer entry projects to the very record it came from, along with the records of its branch the session has no entry for (OpenCode's settings records).
- **Writes.** New message records in the file, other than the bridge's own and those already written, become `write` requests keyed `atxf:<session>:<record id>`.
- **Round trips.** OpenCode's converter round-trips foreign records exactly (checked in `packages/atxf/test`), so nothing comes back twice.

### Failure semantics

- **A Pi connection drops.** Pi reconnects on its next request. Its retry resubmits the unanswered prompt with the same request id, and the conversation doesn't place it twice.
- **A Durable Object is evicted mid-run.** The alarm resumes the harness from storage. WebSockets keep it alive while anyone is attached.
- **The model call fails.** pi-durable's retry and error handling apply, and clients see the outcome as entries. The spec models a failed call as ending the run with an error answer.
- **The bridge dies.** It is a process you run: restart it. It rebuilds what it wrote from the session's peer entries and writes nothing twice.
- **A push fails.** The bridge logs `sync failed` and tries again on the next change.
- **OpenCode is busy when the file changes.** It pulls after its turn, because the plugin replaces the session to update it.

### Invariants, and where they are checked

`bun run specs` (`feynman check`) checks three specs. The bounds are depth 18, two people or two Pis, and one fault, unless stated otherwise.

| Invariant | Spec · property | Rules it needs |
| --- | --- | --- |
| Only the Agent Experience team is ever attached | `joining` · `onlyTheTeam` | `verifyJwt` (with a route around Access) |
| Every message is signed by the person who typed it | `joining` · `messagesAreSignedByWhoTypedThem` | `serverSigns`, `verifyJwt` |
| A team member who joins gets in, as themselves | `joining` · `teamMembersGetIn` (✓ at depth 24) | |
| Every Pi shows a prefix of the transcript, in order | `shared-session` · `viewsArePrefixes` | |
| Once quiet, every Pi shows the whole transcript | `shared-session` · `quietViewsAgree` | `atomicSnapshot` |
| A prompt is placed once, however often Pi submits it | `shared-session` · `inputsPlacedOnce` | `stableRequestIds` |
| A Pi waiting on a prompt gets the answer | `shared-session` · `everyPromptAnswered` (✓ with one Pi at depth 30) | |
| Every message is in the shared file once | `opencode-bridge` · `eachMessageOnce` | `peerProjectsToOriginal` |
| Every message is in the session once | `opencode-bridge` · `sessionHasEachMessageOnce` | `writesKeyedByRecord` (with a bridge restart) |
| The bridge's pushes never fail | `opencode-bridge` · `pushesSucceed` | `carryBranch` |
| OpenCode's turns reach the session, and the session reaches OpenCode, while the bridge runs | `opencode-bridge` · `openCodeReachesTheSession`, `theSessionReachesOpenCode` (✓ without faults at depth 70) | |
| A pull never loses OpenCode's session | `opencode-bridge` · `openCodeKeepsItsSession` | **known bug**, below |

Three things the specs rely on, stated here:

1. **Delivery is in order.** A WebSocket delivers frames in order; the specs model this with explicit reordering by position. The bridge's projection depends on it: it is stable only while the bridge's entries have no gap.
2. **The client waits for its snapshot before it sends.** `connectConversation` doesn't return until the snapshot arrives. The Durable Object's early-frame buffer is a safeguard for clients that don't wait.
3. **The Worker's header handling.** Removing a client-sent `x-pi-multiplayer-person` matters only when there is no verified person. In production there always is one, and the Worker then overwrites the header.

### Findings

- **The OpenCode converter's fixed id.** ATXF's converter names every model-switch message `msg_atxf_model`, and OpenCode's message ids are unique across all its sessions. Once another session holds that id (any earlier ATXF import with a model switch), pulling a file with a model switch in it fails at the import. By then the plugin has already deleted the session, so the joined OpenCode session is lost. This happened in the live test and is the shortest counterexample to `openCodeKeepsItsSession` (13 events, no faults). The fix belongs in the converter: give synthetic messages ids scoped to the transcript. A related exposure on our side is fixed: record ids name the session (`pm-<session>-…`), so two sessions joined in one OpenCode can't collide.
- **The missing branch.** A peer record whose parent was OpenCode's settings record made the bridge's projection a copy with a dangling parent, and every push failed after OpenCode's first turn. It was found live and fixed by `carryBranch`; without the rule, the spec breaks `pushesSucceed` in 8 events.

### Security and privacy

- **Who can join.** The Access policy on the deployed hostname is a copy of the Agent Experience account's `ax-team` list in lostera-individual-account, because reusable policies don't cross accounts. It will drift when the team changes.
- **Defence in depth.** The Worker's own check means a route around Access (workers.dev, a preview URL, a deleted application) still lets nobody in (`joining`, `verifyJwt`).
- **Unauthenticated fields.** Peer messages' `agent` names and assistant or tool `author`s are whatever the bridge sends. They are shown as another agent's words, never as a person's, but a team member could write a peer message claiming to be from "opencode".
- **The local socket** has no authentication, and the Node host's tools run as the host's user.
- **Transcripts** are stored in each Durable Object's SQLite, with no expiry.

### Observability

The server logs each connection, request and reply (`SessionServer` `log`). On Cloudflare these go to Workers Logs, and observability is on in `wrangler.jsonc`. The Node host prints runs, turns, tool output and placements; `--raw` adds every event. The bridge logs what it moves each way and each failed sync.

### Validation

- **Tests.** `bun test` runs 13 tests:
  - Pi through its SDK against a faux-model host;
  - the bridge against a real session server, with OpenCode's converter standing in for OpenCode;
  - the Access gate with locally signed JWTs.
- **Specs.** `bun run specs` checks the three specs above.
- **Live, local.** On workerd with Workers AI: Pi → kimi, OpenCode joining and taking a turn, Pi showing it under its names, kimi answering about it, and the file complete with no duplicates. The OpenCode pull after that turn hit the converter finding above.
- **Live, deployed.** Not yet. The Worker is deployed and redirects to Access, and joining waits on an Access login.

## Drawbacks

- **Pi is a client by imitation.** The provider-plus-stand-ins design depends on Pi's agent loop staying as it is, and some of Pi's features act only on its local copy.
- **pi-durable is experimental** and pinned exactly. The session format is pi-durable's, so upgrading needs care.
- **OpenCode sync is turn-grained and replaces the session**, a consequence of the plugin's API. It's slow to update, it pulls only while idle, and it's exposed to converter bugs like the one found.
- **A copied Access policy** has to be kept up to date by hand.
- **The bridge needs `@leostera/atxf` 0.2**, which isn't published yet; it's linked from a checkout.

## Rationale and alternatives

### Pi as a client through a provider, rather than a new UI

A new terminal UI would duplicate Pi's rendering, editor and queues. Replaying the session's turns through Pi's own agent loop gets all of them for free. The cost is coupling to that loop, which the tests pin.

### One server core for every transport

`SessionServer` takes a `send` and gives `receive`, so the Unix socket and the Durable Object's WebSocket are thin. The alternative, a host per transport, would put signing in two places.

### The server signs messages

The other option is to trust the client's `author` and authenticate only the connection. That lets any team member sign as anyone, and the `joining` spec breaks `messagesAreSignedByWhoTypedThem` in 9 events without `serverSigns`.

### OpenCode through ATXF, rather than a native client

A native OpenCode client would need changes to OpenCode or a deeper plugin. ATXF already converts OpenCode sessions losslessly and has a join flow, so the bridge is the only new piece. The cost is the turn-grained sync described above.

### Workers AI over the binding, rather than provider keys

Routing a provider such as Anthropic through AI Gateway would need keys stored in the gateway. Workers AI over the binding needs nothing, which matters for something colleagues deploy as-is. The model is a variable.

### Do nothing

People keep taking turns at one keyboard, and agents keep not sharing context.

## Prior art

- **r4's `PiReviewer`.** It runs pi-durable in a SQLite Durable Object, with alarms resuming the harness and credentials kept in the trusted Worker. `PiSession` follows it.
- **r2facts' Access gate.** The Worker's JWT check (`access.ts`) is ported from it, including fail-closed configuration and refusing service tokens.
- **Axo RFD0015 and RFD0018.** They make sessions clients of a host and sync sessions to clients through Durable Objects. The lesson taken here is that one server core and one identity per message must not depend on the transport.
- **ATXF's reconciliation** (SPEC §18). It makes the shared file a union by content, which is why the bridge's projection must be deterministic and peer records must be re-emitted verbatim.

## Unresolved questions

### Before acceptance

- **Should OpenCode's turns be able to start a kimi run?** One option is a human OpenCode message becoming a `submit`, with OpenCode's own answer suppressed or kept.
- **Where should the deployment live?** The other option is the Agent Experience account, where the `ax-team` policy exists and wouldn't drift. The cost is putting a prototype in a shared account.
- **The license.** `package.json` says MIT, but there is no LICENSE file.

### During implementation

- The converter fix in ATXF, and publishing `@leostera/atxf` 0.2.
- Joining in OpenCode needs an open session first. The plugin could create one on `join`.
- Choosing the session's model per session, rather than per deployment.

### Out of scope

- Pi history on attach: projecting the entries into a Pi session file.
- Durable `/compact`, `/model` and `/fork`.

## Future possibilities

- **Lending a machine.** A person attaches their machine to a session, and the session's tools run there: pi-env's `RemoteExecutionEnv` over a WebSocket `Connection`, scoped to one directory and revocable. Its approval and isolation model needs its own RFD.
- **More agents through ATXF.** The bridge is not OpenCode-specific; any agent with an ATXF join flow (Pi's pi-atxf, Claude Code, Codex) can take part.
- **Per-person views.** Each person could keep a Pi session file of the shared conversation, kept current as entries arrive.
