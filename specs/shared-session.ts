// One shared session: several Pi clients attached to one pi-durable conversation.
//
// The session (a PiSession Durable Object, or the Node host) holds the conversation. Each
// client attaches, gets a snapshot of the entries, then every entry committed after it. A
// message typed in Pi is submitted with a request id: idle, it starts a run; while a run is
// going, Pi says whether it is a steer (placed before the run's next model call) or a
// follow-up (placed after the run). Every client sees every entry, in the session's order.
//
// Connections drop. Pi then reconnects, and Pi's own retry submits the unanswered prompt
// again, with the same request id, which the conversation has seen: it is not placed twice.
import {
  atMost,
  budget,
  crash,
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
  lose,
  oneOf,
  type Ctx,
} from "@leostera/feynman";

const faults = budget("faults", 1);

type Entry = { kind: "input" | "answer"; id: string; by: string };
const EntrySchema = { kind: oneOf("input", "answer"), id: String, by: String };

// The WebSocket opens; the session attaches the client and sends a snapshot (`watchEvents`).
const Open = defineMessage("Open", { conn: Number }, { name: "WebSocket open", over: "wss" });
const Snapshot = defineMessage("Snapshot", { conn: Number, entries: listOf(EntrySchema) }, { name: "snapshot", over: "wss", tone: "reply" });
// `at` is the entry's place in the transcript; a WebSocket delivers in order, which Pi's
// reorder by `at` stands for (the model lets any message overtake any other).
const Events = defineMessage("Events", { conn: Number, at: Number, entry: EntrySchema }, { name: "events", over: "wss" });
const Submit = defineMessage("Submit", { conn: Number, requestId: String, whenBusy: oneOf("steer", "followUp") }, { name: "submit", over: "wss" });
// The model call of a turn: Workers AI, through AI Gateway. Its failure reaches the run.
const Generate = defineCall("Generate", { turn: String }, { name: "model call", over: "AI binding" });
const Generated = defineMessage("Generated", { turn: String }, { name: "assistant message", tone: "reply" });

const people = defineZone({ name: "People", description: "Pi with the pi-multiplayer extension", place: { column: 0 } });
const cloudflare = defineZone({ name: "Cloudflare", description: "one Durable Object per session", place: { column: 1, region: true } });

/** The client attaches with one snapshot and the events after it, with nothing between. */
const atomicSnapshot = defineRule("atomicSnapshot", { description: "The snapshot and the event stream start at the same entry (watchEvents)." });
/** A prompt's request id comes from the message, so Pi's retry sends the same one. */
const stableRequestIds = defineRule("stableRequestIds", { description: "Pi names a prompt by its timestamp and text, so a retry has the same request id; the conversation places a request id once." });

export const Session = defineActor({
  name: "Session",
  description: "The conversation and the clients attached to it: SessionServer over pi-durable.",
  zone: cloudflare,
  singleton: true,
  initialState: () => ({
    entries: [] as Entry[],
    seen: new Set<string>(), // request ids placed
    run: null as null | { turn: string; calling: boolean },
    steers: [] as Entry[],
    followUps: [] as Entry[],
    // client id → "attaching" (the snapshot is taken, the stream not started yet) or "attached"
    clients: {} as Record<string, "attaching" | "attached">,
  }),
  display: {
    icon: "chat",
    status: (s) => `${s.entries.length} entries${s.run ? ", running" : ""}`,
    mood: (s) => (s.run ? "busy" : "ok"),
    rows: (s) => s.entries.map((e) => ({ group: "transcript", label: e.kind === "input" ? `${e.by}: ${e.id}` : `kimi answers`, mood: e.kind === "input" ? "info" : "ok" })),
  },
  transitions: {
    open: {
      on: Open,
      description: "Takes the snapshot of the entries and sends it; from then on the client gets every new entry.",
      sources: ["packages/worker/src/index.ts#PiSession.fetch", "packages/server/src/server.ts#SessionServer.attach"],
      sends: [Snapshot],
      run(state, msg, ctx) {
        const client = `${ctx.from.id}|${msg.conn}`;
        ctx.reply(Snapshot, { conn: msg.conn, entries: [...state.entries] });
        state.clients[client] = atomicSnapshot.on ? "attached" : "attaching";
      },
    },
    streamStarts: {
      description: "Starts the client's event stream (without atomicSnapshot, a separate step after the snapshot).",
      when: (s) => Object.values(s.clients).includes("attaching"),
      run(state, _, ctx) {
        for (const [id, stage] of Object.entries(state.clients)) if (stage === "attaching") state.clients[id] = "attached";
        ctx.note("entries committed since the snapshot were never sent to that client");
      },
    },
    submit: {
      on: Submit,
      description: "Places the input: a new run when idle, else a steer or a follow-up. A request id it has seen is not placed again.",
      sources: ["packages/server/src/server.ts#SessionServer.#handle"],
      sends: [Generate, Events],
      run(state, msg, ctx) {
        const client = `${ctx.from.id}|${msg.conn}`;
        const frame = { requestId: msg.requestId, whenBusy: msg.whenBusy, by: ctx.from.label };
        // Pi submits only once it has its snapshot (`connectConversation` waits for it), so
        // the client is attached; the Durable Object holds frames that come earlier anyway.
        if (!(client in state.clients)) return;
        place(state, frame, ctx);
      },
    },
    generated: {
      on: Generated,
      description: "Commits the assistant message; takes the next turn if a steer is waiting, else ends the run and starts the next follow-up.",
      sources: ["packages/server/src/server.ts#SessionServer.attach"],
      sends: [Generate, Events],
      run(state, msg, ctx) {
        if (!state.run || state.run.turn !== msg.turn) return;
        commit(state, { kind: "answer", id: msg.turn, by: "kimi" }, ctx);
        next(state, ctx);
      },
    },
    generateFailed: {
      on: failed(Generate),
      description: "The model call failed: the run ends with the error as its answer.",
      sends: [Generate, Events],
      run(state, failure, ctx) {
        if (!state.run || state.run.turn !== failure.payload.turn) return;
        commit(state, { kind: "answer", id: failure.payload.turn, by: "kimi (error)" }, ctx);
        next(state, ctx);
      },
    },
  },
});

type SessionState = {
  entries: Entry[];
  seen: Set<string>;
  run: null | { turn: string; calling: boolean };
  steers: Entry[];
  followUps: Entry[];
  clients: Record<string, "attaching" | "attached">;
};

function commit(state: SessionState, entry: Entry, ctx: Ctx) {
  state.entries.push(entry);
  for (const [client, stage] of Object.entries(state.clients)) {
    const [id, conn] = client.split("|");
    if (stage === "attached") ctx.send({ id: id! }, Events, { conn: Number(conn), at: state.entries.length - 1, entry });
  }
}

function place(state: SessionState, f: { requestId: string; whenBusy: "steer" | "followUp"; by: string }, ctx: Ctx) {
  if (state.seen.has(f.requestId)) return;
  state.seen.add(f.requestId);
  const entry: Entry = { kind: "input", id: f.requestId, by: f.by };
  if (!state.run) {
    commit(state, entry, ctx);
    state.run = { turn: f.requestId, calling: true };
    ctx.send(ctx.the(Model), Generate, { turn: f.requestId });
  } else (f.whenBusy === "steer" ? state.steers : state.followUps).push(entry);
}

function next(state: SessionState, ctx: Ctx) {
  const steer = state.steers.shift();
  const followUp = steer ? undefined : state.followUps.shift();
  const input = steer ?? followUp;
  if (!input) return void (state.run = null);
  commit(state, input, ctx);
  state.run = { turn: input.id, calling: true };
  ctx.send(ctx.the(Model), Generate, { turn: input.id });
}

export const Model = defineActor({
  name: "Workers AI",
  description: "Kimi K2.6 on Workers AI, called through AI Gateway over the AI binding.",
  zone: cloudflare,
  singleton: true,
  initialState: () => ({}),
  display: { icon: "robot", status: () => "kimi-k2.6" },
  transitions: {
    generate: {
      on: Generate,
      description: "Answers one turn.",
      sources: ["packages/worker/src/models.ts#workersAiModels"],
      sends: [Generated],
      run: (_s, msg, ctx) => ctx.reply(Generated, { turn: msg.turn }),
    },
    generateLost: lose(Generate),
  },
});

export const Pi = defineActor({
  name: "Pi",
  description: "Pi with the extension: its view of the transcript, and the prompt it is waiting on.",
  zone: people,
  symmetric: true,
  initialState: () => ({
    connection: "closed" as "closed" | "opening" | "open",
    conn: 0,
    view: [] as Entry[],
    ahead: {} as Record<number, Entry>, // events that arrived before an earlier one: the socket's order
    waiting: null as string | null,
    prompts: 0,
  }),
  display: {
    icon: "terminal",
    names: ["Alice", "Bob"],
    status: (s) => (s.connection !== "open" ? s.connection : s.waiting ? "waiting for kimi" : `${s.view.length} entries`),
    mood: (s) => (s.connection !== "open" ? "off" : s.waiting ? "busy" : "ok"),
  },
  actions: {
    connect: {
      with: [atMost(2)],
      label: "pi --multiplayer",
      description: "Opens the session's WebSocket.",
      sources: ["packages/client/src/index.ts#connectConversation"],
      when: (s) => s.connection === "closed",
      sends: [Open],
      run(state, _i, ctx) {
        state.connection = "opening";
        state.conn += 1;
        state.view = [];
        state.ahead = {};
        ctx.send(ctx.the(Session), Open, { conn: state.conn });
      },
    },
    prompt: {
      with: [atMost(1)],
      label: "Type a prompt",
      description: "Sends a message: a new run if the session is idle, else a follow-up.",
      sources: ["packages/pi/src/provider.ts#durableStreamSimple", "packages/pi/src/mirror.ts#Mirror.submit"],
      when: (s) => s.connection === "open" && s.waiting === null,
      sends: [Submit],
      run(state, _i, ctx) {
        state.prompts += 1;
        state.waiting = `${ctx.label}-${state.prompts}`;
        ctx.send(ctx.the(Session), Submit, { conn: state.conn, requestId: state.waiting, whenBusy: "followUp" });
      },
    },
    steer: {
      with: [atMost(1)],
      label: "Steer",
      description: "Types while kimi works: the session places it before the run's next turn.",
      sources: ["packages/pi/src/extension.ts#createDurableClientExtension"],
      when: (s) => s.connection === "open",
      sends: [Submit],
      run(state, _i, ctx) {
        ctx.send(ctx.the(Session), Submit, { conn: state.conn, requestId: `${ctx.label}-steer`, whenBusy: "steer" });
      },
    },
  },
  transitions: {
    snapshot: {
      on: Snapshot,
      description: "Shows the transcript so far; after a reconnect, Pi's retry submits the prompt it still waits on.",
      sources: ["packages/pi/src/mirror.ts#Mirror", "packages/pi/src/provider.ts#durableStreamSimple"],
      sends: [Submit],
      run(state, msg, ctx) {
        if (msg.conn !== state.conn || state.connection !== "opening") return;
        state.connection = "open";
        state.view = [...msg.entries];
        flush(state);
        if (!state.waiting) return;
        // Answered while Pi was away: it is in the snapshot.
        if (state.view.some((e) => e.kind === "answer" && e.id === state.waiting)) return void (state.waiting = null);
        if (!stableRequestIds.on) state.waiting = `${state.waiting}'`;
        ctx.send(ctx.the(Session), Submit, { conn: state.conn, requestId: state.waiting, whenBusy: "followUp" });
      },
    },
    events: {
      on: Events,
      description: "Shows the new entry; an answer to its prompt ends its wait.",
      sources: ["packages/pi/src/mirror.ts#Mirror"],
      run(state, msg) {
        // Only the current WebSocket's events: an old socket's are gone with it.
        if (msg.conn !== state.conn || state.connection === "closed") return;
        state.ahead[msg.at] = msg.entry;
        if (state.connection !== "open") return;
        flush(state);
      },
    },
    closed: {
      ...crash({ keeps: ["waiting", "prompts", "conn"], spend: faults }),
      description: "The WebSocket closes; Pi keeps the prompt it is waiting on.",
    },
  },
});

function flush(state: { view: Entry[]; ahead: Record<number, Entry>; waiting: string | null }) {
  for (const at of Object.keys(state.ahead).map(Number)) if (at < state.view.length) delete state.ahead[at];
  while (state.ahead[state.view.length]) {
    const entry = state.ahead[state.view.length]!;
    delete state.ahead[state.view.length];
    state.view.push(entry);
    if (entry.kind === "answer" && entry.id === state.waiting) state.waiting = null;
  }
}

const viewsArePrefixes = defineProperty("viewsArePrefixes", {
  description: "What every connected Pi shows is the session's transcript so far, in its order: never a gap or a reordering.",
  always: (w) => {
    const entries = w.the(Session).state.entries.map((e) => `${e.kind}:${e.id}`);
    return w.all(Pi).every((p) => p.state.connection !== "open" || p.state.view.every((e, i) => entries[i] === `${e.kind}:${e.id}`));
  },
});

const quietViewsAgree = defineProperty("quietViewsAgree", {
  description: "Once nothing is in flight, every attached Pi shows the whole transcript.",
  always: (w) => {
    if (!w.quiet) return true;
    const s = w.the(Session).state;
    return w.all(Pi).every((p) => p.state.connection !== "open" || p.state.view.length === s.entries.length);
  },
  needs: [atomicSnapshot],
});

const inputsPlacedOnce = defineProperty("inputsPlacedOnce", {
  description: "A prompt is placed in the conversation once, however often Pi submits it.",
  always: (w) => {
    const inputs = w.the(Session).state.entries.filter((e) => e.kind === "input").map((e) => e.id.replace(/'+$/, ""));
    return new Set(inputs).size === inputs.length;
  },
  needs: [stableRequestIds],
});

const everyPromptAnswered = defineProperty("everyPromptAnswered", {
  description: "A Pi that stays connected and waits on a prompt gets kimi's answer.",
  leadsTo: {
    whenever: (w) => w.all(Pi).some((p) => p.state.waiting !== null),
    then: (w) => w.all(Pi).every((p) => p.state.waiting === null || p.state.connection === "closed"),
  },
});

const twoPeople = defineScenario("Alice prompts, Bob follows up", {
  description: "Alice's prompt starts a run; Bob's message, sent while it runs, is placed after it; both see the same transcript.",
  run(s) {
    const alice = s.spawn(Pi, "Alice");
    const bob = s.spawn(Pi, "Bob");
    s.act(alice, "connect");
    s.act(bob, "connect");
    s.settle({ until: (w) => w.all(Pi).every((p) => p.state.connection === "open") });
    s.act(alice, "prompt");
    s.deliver(s.the(Session), Submit);
    s.act(bob, "prompt");
    s.settle();
  },
});

const reconnect = defineScenario("Alice's connection drops", {
  description: "The WebSocket closes while kimi answers Alice; Pi reconnects and its retry submits the prompt again, which is not placed twice.",
  run(s) {
    const alice = s.spawn(Pi, "Alice");
    s.act(alice, "connect");
    s.settle({ until: (w) => w.the(Pi).state.connection === "open" });
    s.act(alice, "prompt");
    s.deliver(s.the(Session), Submit);
    s.step(alice, "closed");
    s.act(alice, "connect");
    s.settle();
  },
});

export default defineSpec({
  name: "A shared session",
  description: "How several Pi clients share one pi-durable conversation: attaching, placing input, and reconnecting.",
  actors: [Pi, Session, Model],
  properties: [viewsArePrefixes, quietViewsAgree, inputsPlacedOnce, everyPromptAnswered],
  scenarios: [twoPeople, reconnect],
});
