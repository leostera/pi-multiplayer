// OpenCode in a shared session, through an ATXF shared file.
//
// The bridge keeps the session and the file in sync: it pushes the session, projected to ATXF
// records, into the file, and writes the records OpenCode adds there into the session as peer
// entries. OpenCode's ATXF plugin pushes its copy of the session after each of its turns, and
// pulls the file when it changes, while idle, by replacing its session with the file's.
//
// The file is a reconciled union of records keyed by content (ATXF's reconciliation keys), so
// pushing the same record twice adds nothing; but a record pushed under another id, or one
// whose parent the copy lacks, is a problem: the first is a duplicate message, the second a
// push that fails.
import {
  atMost,
  budget,
  spend,
  defineActor,
  defineCall,
  defineMessage,
  defineProperty,
  defineRule,
  defineScenario,
  defineSpec,
  defineZone,
  failed,
  listOf,
  nullable,
  oneOf,
  type Ctx,
} from "@leostera/feynman";

const faults = budget("faults", 1);

/** An ATXF record: a message, or OpenCode's settings record for a model switch. */
type Rec = { id: string; parentId: string | null; type: "message" | "settings"; text: string };
const RecSchema = { id: String, parentId: nullable(String), type: oneOf("message", "settings"), text: String };
/** A session entry: a message typed in Pi or kimi's answer, or another agent's (`peer`), with the record it came from. */
type Entry = { id: number; kind: "message" | "peer"; text: string; atxfId: string | null };
const EntrySchema = { id: Number, kind: oneOf("message", "peer"), text: String, atxfId: nullable(String) };

const Snapshot = defineMessage("Snapshot", { conn: Number, entries: listOf(EntrySchema) }, { name: "snapshot", over: "wss", tone: "reply" });
const Events = defineMessage("Events", { conn: Number, entry: EntrySchema }, { name: "events", over: "wss" });
const Attach = defineMessage("Attach", { conn: Number }, { name: "attach", over: "wss" });
const Write = defineMessage("Write", { requestId: String, atxfId: String, text: String }, { name: "write", over: "wss" });
const Read = defineCall("Read", {}, { name: "read the shared file", over: "fs" });
const Contents = defineMessage("Contents", { records: listOf(RecSchema) }, { name: "records", tone: "reply" });
const Push = defineCall("Push", { records: listOf(RecSchema) }, { name: "push (reconcile under the lock)", over: "fs" });
const Pushed = defineMessage("Pushed", { added: Number }, { tone: "reply" });
const Changed = defineMessage("Changed", {}, { name: "file changed", over: "fs.watch" });

const people = defineZone({ name: "Your machine", description: "OpenCode, the bridge and the shared file", place: { column: 0, region: true } });
const cloudflare = defineZone({ name: "Cloudflare", description: "the session", place: { column: 1 } });

/** A peer entry projects to the very record it came from, so the file gains nothing back. */
const peerProjectsToOriginal = defineRule("peerProjectsToOriginal", { description: "The bridge projects another agent's message as its original record, not as a new one." });
/** With a peer record, the bridge pushes the records of its branch the session has no entry for. */
const carryBranch = defineRule("carryBranch", { description: "The bridge carries a peer record's ancestors (OpenCode's settings records) into its push." });
/** The bridge writes each record with a request id made from the record's id, which the session places once. */
const writesKeyedByRecord = defineRule("writesKeyedByRecord", { description: "A write's request id is the record's id, so writing it again after a restart is not placed twice." });

export const Session = defineActor({
  name: "Session",
  description: "The session's conversation (spec shared-session), seen as its entries.",
  zone: cloudflare,
  singleton: true,
  initialState: () => ({ entries: [] as Entry[], requests: new Set<string>(), clients: {} as Record<string, number>, asked: 0 }),
  display: {
    icon: "chat",
    status: (s) => `${s.entries.length} entries`,
    rows: (s) => s.entries.map((e) => ({ group: "transcript", label: e.text, detail: e.kind === "peer" ? "from OpenCode" : "", mood: e.kind === "peer" ? "info" : "ok" })),
  },
  actions: {
    ask: {
      with: [atMost(1)],
      label: "Alice asks kimi, in Pi",
      description: "A message typed in Pi, and kimi's answer to it, both committed.",
      run(state, _i, ctx) {
        state.asked += 1;
        commit(state, ctx, { kind: "message", text: `alice: question ${state.asked}`, atxfId: null });
        commit(state, ctx, { kind: "message", text: `kimi: answer ${state.asked}`, atxfId: null });
      },
      sends: [Events],
    },
  },
  transitions: {
    attach: {
      on: Attach,
      description: "Attaches the bridge and sends it the snapshot.",
      sources: ["packages/server/src/server.ts#SessionServer.attach"],
      sends: [Snapshot],
      run(state, msg, ctx) {
        // A dead process's socket is closed: its late attach goes nowhere.
        if ((state.clients[ctx.from.id] ?? 0) > msg.conn) return;
        state.clients[ctx.from.id] = msg.conn;
        ctx.reply(Snapshot, { conn: msg.conn, entries: [...state.entries] });
      },
    },
    write: {
      on: Write,
      description: "Commits another agent's message as a peer entry; a request id it has seen is not placed again.",
      sources: ["packages/server/src/server.ts#SessionServer.#handle"],
      sends: [Events],
      run(state, msg, ctx) {
        if (state.requests.has(msg.requestId)) return;
        state.requests.add(msg.requestId);
        commit(state, ctx, { kind: "peer", text: msg.text, atxfId: msg.atxfId });
      },
    },
  },
});

function commit(state: { entries: Entry[]; clients: Record<string, number> }, ctx: Ctx, entry: Omit<Entry, "id">) {
  const full = { ...entry, id: state.entries.length + 1 };
  state.entries.push(full);
  for (const [id, conn] of Object.entries(state.clients)) ctx.send({ id }, Events, { conn, entry: full });
}

export const SharedFile = defineActor({
  name: "Shared file",
  description: "~/.local/share/pi-multiplayer/<session>.atxf.jsonl: ATXF records, reconciled under a lock file.",
  zone: people,
  singleton: true,
  initialState: () => ({ records: [] as Rec[], watchers: new Set<string>() }),
  display: {
    icon: "file",
    status: (s) => `${s.records.length} records`,
    rows: (s) => s.records.map((r) => ({ group: "records", label: r.type === "settings" ? "model switch" : r.text, detail: r.id, mood: "info" })),
  },
  transitions: {
    read: { on: Read, description: "Returns the records.", sends: [Contents], run: (s, _m, ctx) => (s.watchers.add(ctx.from.id), ctx.reply(Contents, { records: [...s.records] })) },
    push: {
      on: Push,
      description: "Reconciles the copy into the file: the union of records by content. A copy with a record whose parent it lacks is refused.",
      sends: [Pushed, Changed, failed(Push)],
      run(state, msg, ctx) {
        const ids = new Set<string>();
        for (const r of msg.records) {
          if (r.parentId !== null && !ids.has(r.parentId)) return ctx.reply(failed(Push), { payload: msg, to: { id: ctx.id } }, `parentId ${r.parentId} has no earlier record`);
          ids.add(r.id);
        }
        const have = new Set(state.records.map((r) => keyOf(state.records, r)));
        const added = msg.records.filter((r) => !have.has(keyOf(msg.records, r)));
        for (const r of added) state.records.push(r);
        ctx.reply(Pushed, { added: added.length });
        if (added.length) for (const id of state.watchers) if (id !== ctx.from.id) ctx.send({ id }, Changed, {});
      },
    },
  },
});

/** A record's reconciliation key: its content and its parent's, never its id (ATXF, Reconciliation). */
function keyOf(copy: readonly Rec[], r: Rec): string {
  const parent = r.parentId === null ? undefined : copy.find((p) => p.id === r.parentId);
  return `${r.type}:${r.text}<${parent ? keyOf(copy, parent) : ""}`;
}

export const Bridge = defineActor({
  name: "Bridge",
  description: "pi-multiplayer-atxf: the session's projection into the file, and OpenCode's records into the session.",
  zone: people,
  singleton: true,
  initialState: () => ({ entries: {} as Record<number, Entry>, ahead: {} as Record<number, Entry>, written: new Set<string>(), shared: [] as Rec[], conn: 0, starting: false, attached: false, reading: false, dirty: false }),
  display: { icon: "pipeline", status: (s) => (s.attached ? `${Object.keys(s.entries).length} entries, ${s.written.size} written` : s.starting ? "starting" : "stopped") },
  actions: {
    start: {
      with: [atMost(2)],
      label: "Start the bridge",
      description: "Connects to the session.",
      sources: ["packages/atxf/src/bridge.ts#startBridge"],
      when: (s) => !s.attached && !s.starting,
      sends: [Attach],
      run(s, _i, ctx) {
        s.starting = true;
        s.conn += 1;
        ctx.send(ctx.the(Session), Attach, { conn: s.conn });
      },
    },
  },
  transitions: {
    snapshot: {
      on: Snapshot,
      description: "Remembers the entries, and the records it wrote before (peer entries name them).",
      sources: ["packages/atxf/src/bridge.ts:51-58"],
      sends: [Read],
      run(state, msg, ctx) {
        if (msg.conn !== state.conn) return;
        state.attached = true;
        for (const e of msg.entries) remember(state, e);
        sync(state, ctx);
      },
    },
    events: {
      on: Events,
      description: "Remembers the new entry, by its id, and syncs.",
      sources: ["packages/atxf/src/bridge.ts:86-96"],
      sends: [Read],
      run(state, msg, ctx) {
        // The client holds events that come before the snapshot (connection.ts); here they are kept by id.
        if (msg.conn !== state.conn) return; // an old socket's, gone with it
        remember(state, msg.entry);
        if (state.attached) sync(state, ctx);
      },
    },
    changed: { on: Changed, description: "The file changed: syncs.", sources: ["packages/atxf/src/bridge.ts:97-99"], sends: [Read], run: (s, _m, ctx) => sync(s, ctx) },
    contents: {
      on: Contents,
      description: "Writes the records OpenCode added into the session, then pushes the session's projection.",
      sources: ["packages/atxf/src/bridge.ts:69-84", "packages/atxf/src/project.ts#newPeerRecords", "packages/atxf/src/project.ts#project"],
      sends: [Write, Push],
      run(state, msg, ctx) {
        state.shared = [...msg.records];
        for (const r of msg.records) {
          if (r.type !== "message" || r.id.startsWith("pm-") || state.written.has(r.id)) continue;
          state.written.add(r.id);
          ctx.send(ctx.the(Session), Write, { requestId: writesKeyedByRecord.on ? `atxf:${r.id}` : ctx.fresh("write"), atxfId: r.id, text: r.text });
        }
        const ordered = Object.values(state.entries).sort((a, b) => a.id - b.id);
        ctx.send(ctx.the(SharedFile), Push, { records: project(ordered, state.shared) });
      },
    },
    pushed: {
      on: Pushed,
      description: "Done; syncs again if the session changed meanwhile.",
      sends: [Read],
      run(state, _m, ctx) {
        state.reading = false;
        if (state.dirty) sync(state, ctx);
      },
    },
    pushFailed: {
      on: failed(Push),
      description: "Logs \"sync failed\"; the next change tries again.",
      run: (s, _f, ctx) => ((s.reading = false), ctx.note("sync failed")),
    },
    // The process stops and is started again. What was on its way to it (replies, events) went
    // with its sockets and file descriptors; it keeps nothing but how many sockets it opened.
    crash: {
      with: [spend(faults)],
      when: (s) => s.starting || s.attached,
      fair: false,
      description: "The bridge process dies and is started again.",
      run: (_s, _, ctx) => ctx.reset({ keeps: ["conn"], drops: () => true }),
    },
  },
});

type BridgeState = { shared: Rec[]; reading: boolean; dirty: boolean };

/**
 * Keeps an entry, in the session's order. The projection is a function of the entries the
 * bridge has, so it gives the same records every time only while those have no gap: a
 * WebSocket delivers in order, which holding entries until the ones before them arrive
 * stands for here (the model lets any message overtake any other).
 */
function remember(state: { entries: Record<number, Entry>; ahead: Record<number, Entry>; written: Set<string> }, e: Entry) {
  if (e.id in state.entries) return;
  state.ahead[e.id] = e;
  for (let next = Object.keys(state.entries).length + 1; state.ahead[next]; next++) {
    const entry = state.ahead[next]!;
    delete state.ahead[next];
    state.entries[next] = entry;
    if (entry.atxfId) state.written.add(entry.atxfId);
  }
}

/** One sync at a time (the bridge's queue); a change during one runs another after it. */
function sync(state: BridgeState, ctx: Ctx) {
  if (state.reading) return void (state.dirty = true);
  state.reading = true;
  state.dirty = false;
  ctx.send(ctx.the(SharedFile), Read, {});
}

/** The session as ATXF records (project.ts): its messages, and peer entries as the records they came from. */
function project(entries: readonly Entry[], shared: readonly Rec[]): Rec[] {
  const out: Rec[] = [];
  const emitted = new Set<string>();
  let parent: string | null = null;
  const add = (r: Rec) => (out.push(r), emitted.add(r.id), (parent = r.id));
  for (const e of entries) {
    const original = e.atxfId === null ? undefined : shared.find((r) => r.id === e.atxfId);
    // A peer entry whose record the file does not have (another bridge's) is left out.
    if (e.kind === "peer" && peerProjectsToOriginal.on) {
      if (!original) continue;
      const branch: Rec[] = [];
      for (let at: Rec | undefined = original; at && !emitted.has(at.id); ) {
        branch.unshift(at);
        at = carryBranch.on && at.parentId ? shared.find((r) => r.id === at!.parentId) : undefined;
      }
      branch.forEach(add);
      continue;
    }
    add({ id: `pm-${e.id}`, parentId: parent, type: "message", text: e.text });
  }
  return out;
}

export const OpenCode = defineActor({
  name: "OpenCode",
  description: "OpenCode with the opencode-atxf plugin, its session joined to the file.",
  zone: people,
  singleton: true,
  initialState: () => ({
    joined: false,
    busy: false,
    pending: false, // the file changed during a turn: pull once idle
    session: [] as Rec[], // its session, as ATXF records (the converter round-trips them)
    turns: 0,
    lost: false, // its session was deleted and could not be imported again
    // Message ids in OpenCode's database, which are unique across all its sessions: an
    // older ATXF session holds `msg_atxf_model`.
    otherSessions: new Set(["msg_atxf_model"]),
  }),
  display: {
    icon: "terminal",
    status: (s) => (s.lost ? "session lost" : !s.joined ? "not joined" : s.busy ? "working" : `${s.session.filter((r) => r.type === "message").length} messages`),
    mood: (s) => (s.lost ? "bad" : s.busy ? "busy" : s.joined ? "ok" : "off"),
  },
  actions: {
    join: {
      with: [atMost(1)],
      label: "/atxf join <file>",
      description: "Joins the file: the session becomes a copy of it.",
      when: (s) => !s.joined,
      sends: [Read],
      run(state, _i, ctx) {
        state.joined = true;
        ctx.send(ctx.the(SharedFile), Read, {});
      },
    },
    turn: {
      with: [atMost(1)],
      label: "Ask OpenCode",
      description: "A turn in OpenCode: it switches back to its own model (a settings record), then the question and its answer.",
      when: (s) => s.joined && !s.busy && !s.lost,
      run(state) {
        state.busy = true;
        state.turns += 1;
        const leaf = state.session.at(-1)?.id ?? null;
        const n = state.turns;
        state.session.push({ id: `oc-s${n}`, parentId: leaf, type: "settings", text: "gpt" });
        state.session.push({ id: `oc-u${n}`, parentId: `oc-s${n}`, type: "message", text: `carol: what did kimi say? (${n})` });
      },
    },
  },
  transitions: {
    answered: {
      description: "OpenCode's model answers; the plugin pushes the session, then pulls.",
      when: (s) => s.busy,
      sends: [Push],
      run(state, _, ctx) {
        const n = state.turns;
        state.session.push({ id: `oc-a${n}`, parentId: `oc-u${n}`, type: "message", text: `opencode: kimi said hi (${n})` });
        state.busy = false;
        ctx.send(ctx.the(SharedFile), Push, { records: [...state.session] });
      },
    },
    pushed: { on: Pushed, description: "Shared; pulls what arrived meanwhile.", sends: [Read], run: (_s, _m, ctx) => ctx.send(ctx.the(SharedFile), Read, {}) },
    pushFailed: { on: failed(Push), description: "Shows \"sync failed\".", run: () => {} },
    changed: {
      on: Changed,
      description: "The file changed: pulls now if idle, else after the turn.",
      sends: [Read],
      run(state, _m, ctx) {
        if (state.busy) return void (state.pending = true);
        ctx.send(ctx.the(SharedFile), Read, {});
      },
    },
    contents: {
      on: Contents,
      description: "Replaces its session with the file's copy, when the file has records it lacks: delete, then import.",
      sends: [Read],
      run(state, msg) {
        if (state.busy || state.lost) return void (state.pending = true);
        const have = new Set(state.session.map((r) => keyOf(state.session, r)));
        if (msg.records.every((r) => have.has(keyOf(msg.records, r)))) return;
        // The converter names the message of a model switch `msg_atxf_model`, in every session.
        const ids = msg.records.map((r) => (r.type === "settings" ? "msg_atxf_model" : `msg_${r.id}`));
        if (ids.some((id) => state.otherSessions.has(id))) {
          state.lost = true;
          state.session = [];
          return;
        }
        state.session = [...msg.records];
      },
    },
    pullPending: {
      description: "Pulls what changed during its turn.",
      when: (s) => s.pending && !s.busy && !s.lost,
      sends: [Read],
      run(state, _, ctx) {
        state.pending = false;
        ctx.send(ctx.the(SharedFile), Read, {});
      },
    },
  },
});

const eachMessageOnce = defineProperty("eachMessageOnce", {
  description: "Every message is in the shared file once.",
  always: (w) => {
    const texts = w.the(SharedFile).state.records.filter((r) => r.type === "message").map((r) => r.text);
    return new Set(texts).size === texts.length;
  },
  needs: [peerProjectsToOriginal],
});

const sessionHasEachMessageOnce = defineProperty("sessionHasEachMessageOnce", {
  description: "Every message is in the session once.",
  always: (w) => {
    const texts = w.the(Session).state.entries.map((e) => e.text);
    return new Set(texts).size === texts.length;
  },
  needs: [writesKeyedByRecord],
});

const pushesSucceed = defineProperty("pushesSucceed", {
  description: "The bridge's pushes never fail.",
  never: (t) => t.some((e) => e.is(Bridge, "pushFailed")),
  needs: [carryBranch],
});

const openCodeKeepsItsSession = defineProperty("openCodeKeepsItsSession", {
  description: "A pull never loses OpenCode's joined session.",
  always: (w) => !w.the(OpenCode).state.lost,
  known: "ATXF's OpenCode converter gives every model-switch message the id msg_atxf_model; importing a second session with one fails on OpenCode's unique message ids, after the plugin deleted the session",
});

/** The bridge died and nobody started it again: a process you run, so liveness is "while it runs". */
const bridgeDown = (w: { the: (a: typeof Bridge) => { state: { attached: boolean; starting: boolean } } }) => !w.the(Bridge).state.attached && !w.the(Bridge).state.starting;

const openCodeReachesTheSession = defineProperty("openCodeReachesTheSession", {
  description: "While the bridge runs, OpenCode's messages in the file reach the session.",
  leadsTo: {
    whenever: (w) => w.the(Bridge).state.attached && w.the(SharedFile).state.records.some((r) => r.type === "message" && r.id.startsWith("oc-")),
    then: (w) =>
      bridgeDown(w) ||
      w.the(SharedFile).state.records.filter((r) => r.type === "message" && r.id.startsWith("oc-")).every((r) => w.the(Session).state.entries.some((e) => e.atxfId === r.id)),
  },
});

const theSessionReachesOpenCode = defineProperty("theSessionReachesOpenCode", {
  description: "While the bridge runs, what the session says reaches OpenCode, once OpenCode is idle.",
  leadsTo: {
    whenever: (w) => w.the(OpenCode).state.joined && w.the(Bridge).state.attached && w.the(Session).state.entries.length > 0,
    // A lost session is openCodeKeepsItsSession's (the converter bug), not this property's.
    then: (w) => bridgeDown(w) || w.the(OpenCode).state.lost || w.the(OpenCode).state.busy || w.the(Session).state.entries.every((e) => w.the(OpenCode).state.session.some((r) => r.text === e.text)),
  },
});

const aConversation = defineScenario("Pi and OpenCode talk", {
  description: "Alice asks kimi in Pi; OpenCode joins and asks about it; kimi's next answer reaches OpenCode.",
  run(s) {
    const bridge = s.the(Bridge);
    s.act(s.the(Session), "ask");
    s.act(bridge, "start");
    s.settle();
    s.act(s.the(OpenCode), "join");
    s.settle();
    s.act(s.the(OpenCode), "turn");
    s.settle();
  },
});

export default defineSpec({
  name: "OpenCode through ATXF",
  description: "How the ATXF bridge keeps a session and a shared file in sync, so OpenCode takes part.",
  actors: [Session, Bridge, SharedFile, OpenCode],
  properties: [eachMessageOnce, sessionHasEachMessageOnce, pushesSucceed, openCodeKeepsItsSession, openCodeReachesTheSession, theSessionReachesOpenCode],
  scenarios: [aConversation],
});
