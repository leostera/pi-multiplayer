// Joining a deployed session: Cloudflare Access, the Worker, and who signs each message.
//
// People reach `wss://<host>/s/<name>` through the Access application in front of the
// hostname, which only lets the Agent Experience team in. The Worker checks the Access JWT
// again and tells the session (a Durable Object) who the person is; the session signs every
// message with that name, whatever the client claims.
//
// The faults here are not lost packets but a misconfiguration: a way to the Worker around
// Access (workers.dev or a preview URL switched on, the Access application deleted). The
// Worker's own check is what keeps that from letting anyone in.
import {
  atMost,
  budget,
  defineActor,
  defineMessage,
  defineProperty,
  defineRule,
  defineScenario,
  defineSpec,
  defineZone,
  input,
  nullable,
  oneOf,
  spend,
} from "@leostera/feynman";

/** A way to the Worker that does not pass Access. `--set bypass=0` checks without one. */
const bypass = budget("bypass", 1);

/**
 * Who the Access policy includes: Alice and Bob in the scenarios; when exploring, where people
 * are named "Person A" and "Person B", A is on the team and B is not.
 */
const TEAM = new Set(["Alice", "Bob", "Person A"]);

const Login = defineMessage("Login", {}, { name: "cloudflared access login", over: "https" });
const Token = defineMessage("Token", { token: String }, { name: "Access token", tone: "reply" });
const LoginRefused = defineMessage("LoginRefused", {}, { name: "not in the policy", tone: "refused" });
// The upgrade request, with the Access token if the client has one (`cf-access-token`).
const Upgrade = defineMessage("Upgrade", { token: nullable(String), client: String }, { name: "WebSocket upgrade", over: "wss" });
// What reaches the Worker: through Access, with the assertion Access adds; or around it, without.
const Forwarded = defineMessage("Forwarded", { assertion: nullable(String), client: String }, { name: "request", over: "https" });
const Refused = defineMessage("Refused", { status: oneOf(401, 403) }, { tone: "refused" });
// The Worker to the session: `x-pi-multiplayer-person`, set from the verified JWT.
const Attach = defineMessage("Attach", { person: nullable(String), client: String }, { name: "attach", over: "Durable Object fetch" });
const Snapshot = defineMessage("Snapshot", { you: nullable(String) }, { name: "snapshot", over: "wss", tone: "reply" });
// A message typed in Pi. `author` is what the client claims; `typedBy` is who really typed it,
// known to the model only, to state the property.
const Submit = defineMessage("Submit", { client: String, author: String, typedBy: String }, { name: "submit", over: "wss" });

const people = defineZone({ name: "People", description: "Pi, with cloudflared", place: { column: 0 } });
const edge = defineZone({ name: "Cloudflare Access", description: "the application on the hostname", place: { column: 1 } });
const cloudflare = defineZone({ name: "Cloudflare", description: "the Worker and one Durable Object per session", place: { column: 2, region: true } });

/** The Worker verifies the Access JWT itself, rather than trusting that the request passed Access. */
const verifyJwt = defineRule("verifyJwt", { description: "The Worker refuses a request without a valid Access JWT for its application." });
/** The session signs messages with the identity the Worker gave it, not the client's claim. */
const serverSigns = defineRule("serverSigns", { description: "The session overrides the author a client sends with the person it attached as." });

export const Access = defineActor({
  name: "Access",
  description: "The Access application on the hostname, with the Agent Experience team policy.",
  zone: edge,
  singleton: true,
  initialState: () => ({ tokens: {} as Record<string, string> }),
  display: { icon: "shield", status: (s) => `${Object.keys(s.tokens).length} token(s) issued` },
  transitions: {
    login: {
      on: Login,
      description: "Issues a token to a person the policy includes.",
      sends: [Token, LoginRefused],
      run(state, _msg, ctx) {
        const who = ctx.delivery.from.label;
        if (!TEAM.has(who)) return ctx.reply(LoginRefused, {}, `${who} is not on the Agent Experience team`);
        const token = ctx.hash(`token:${who}`);
        state.tokens[token] = who;
        ctx.reply(Token, { token });
      },
    },
    upgrade: {
      on: Upgrade,
      description: "Lets a request with a valid token through to the Worker, adding the signed assertion; refuses the rest.",
      sends: [Forwarded, Refused],
      run(state, msg, ctx) {
        const who = msg.token === null ? undefined : state.tokens[msg.token];
        if (!who) return ctx.reply(Refused, { status: 401 }, "redirected to the Access login");
        // The JWT Access signs, naming the person; the Worker reads the email from it.
        ctx.send(ctx.the(Worker), Forwarded, { assertion: `jwt:${who}`, client: msg.client });
      },
    },
  },
});

export const Worker = defineActor({
  name: "Worker",
  description: "Checks the Access JWT again and attaches the connection to the session it names.",
  zone: cloudflare,
  singleton: true,
  initialState: () => ({}),
  display: { icon: "cloud", status: () => "pi-multiplayer" },
  transitions: {
    forwarded: {
      on: Forwarded,
      description: "Verifies the JWT, takes the person from its email, and passes them to the session.",
      sources: ["packages/worker/src/access.ts#checkAccess", "packages/worker/src/index.ts:62-81"],
      sends: [Attach, Refused],
      run(_state, msg, ctx) {
        const person = msg.assertion === null ? null : msg.assertion.replace(/^jwt:/, "");
        if (verifyJwt.on && person === null) return ctx.send({ id: msg.client }, Refused, { status: 401 });
        ctx.send(ctx.the(PiSession), Attach, { person, client: msg.client });
      },
    },
  },
});

export const PiSession = defineActor({
  name: "Session",
  description: "The PiSession Durable Object: the conversation, and the clients attached to it.",
  zone: cloudflare,
  singleton: true,
  initialState: () => ({
    clients: {} as Record<string, string | null>, // client → the person it attached as
    entries: [] as { author: string; typedBy: string }[],
  }),
  display: {
    icon: "chat",
    status: (s) => `${Object.keys(s.clients).length} attached, ${s.entries.length} message(s)`,
    rows: (s) => s.entries.map((e) => ({ group: "transcript", label: e.author, detail: e.author === e.typedBy ? "" : `typed by ${e.typedBy}`, mood: e.author === e.typedBy ? "ok" : "bad" })),
  },
  transitions: {
    attach: {
      on: Attach,
      description: "Attaches the connection as the person the Worker named, and sends it the snapshot.",
      sources: ["packages/worker/src/index.ts#PiSession.fetch", "packages/server/src/server.ts#SessionServer.attach"],
      sends: [Snapshot],
      run(state, msg, ctx) {
        state.clients[msg.client] = msg.person;
        ctx.send({ id: msg.client }, Snapshot, { you: msg.person });
      },
    },
    submit: {
      on: Submit,
      description: "Places the message in the conversation, signed with its author.",
      sources: ["packages/server/src/server.ts:80-109", "packages/server/src/server.ts#SessionServer.#handle"],
      run(state, msg) {
        if (!(msg.client in state.clients)) return;
        const identity = state.clients[msg.client];
        const author = serverSigns.on && identity ? identity : msg.author;
        state.entries.push({ author, typedBy: msg.typedBy });
      },
    },
  },
});

export const Person = defineActor({
  name: "Person",
  description: "Someone running Pi with the pi-multiplayer extension.",
  zone: people,
  initialState: () => ({ token: null as string | null, connection: null as string | null, you: null as string | null, refused: false }),
  display: {
    icon: "laptop",
    names: ["Alice", "Mallory"],
    status: (s) => (s.you ? `joined as ${s.you}` : s.connection ? "joining" : s.token ? "logged in" : s.refused ? "refused" : "not logged in"),
    mood: (s) => (s.you ? "ok" : s.refused ? "bad" : s.connection ? "busy" : "off"),
  },
  actions: {
    login: {
      with: [atMost(1)],
      label: "cloudflared access login",
      description: "Logs in to the Access application in the browser.",
      sources: ["packages/client/src/index.ts#accessToken"],
      when: (s) => s.token === null,
      sends: [Login],
      run: (_s, _i, ctx) => ctx.send(ctx.the(Access), Login, {}),
    },
    join: {
      with: [atMost(1)],
      label: "pi --multiplayer wss://…",
      description: "Opens the session's WebSocket through Access, with the token if it has one.",
      sources: ["packages/client/src/index.ts#openWebSocket"],
      when: (s) => s.connection === null,
      sends: [Upgrade],
      run(state, _i, ctx) {
        state.connection = "through Access";
        ctx.send(ctx.the(Access), Upgrade, { token: state.token, client: ctx.id });
      },
    },
    joinAround: {
      with: [atMost(1), spend(bypass)],
      label: "Connect around Access",
      description: "Reaches the Worker by a route Access does not cover, if one exists.",
      when: (s) => s.connection === null,
      sends: [Forwarded],
      run(state, _i, ctx) {
        state.connection = "around Access";
        ctx.send(ctx.the(Worker), Forwarded, { assertion: null, client: ctx.id });
      },
    },
    say: {
      with: [atMost(1)],
      label: "Send a message",
      description: "Types a message in Pi; the client signs it with a name, its own or anyone's.",
      sources: ["packages/pi/src/mirror.ts#Mirror.submit"],
      inputs: { as: input(String, { examples: (w): string[] => w.all(Person).map((p) => p.label) }) },
      when: (s) => s.connection !== null,
      sends: [Submit],
      run: (_state, { as }, ctx) => ctx.send(ctx.the(PiSession), Submit, { client: ctx.id, author: as, typedBy: ctx.label }),
    },
  },
  transitions: {
    token: { on: Token, description: "Keeps the token for the hostname.", run: (s, msg) => void (s.token = msg.token) },
    loginRefused: { on: LoginRefused, description: "Is not let in.", run: (s) => void (s.refused = true) },
    refused: { on: Refused, description: "The connection is refused.", run: (s) => ((s.refused = true), (s.connection = null)) },
    snapshot: { on: Snapshot, description: "Joined: the session says who it takes this client for.", sources: ["packages/pi/src/extension.ts#createDurableClientExtension"], run: (s, msg) => void (s.you = msg.you) },
  },
});

const onlyTheTeam = defineProperty("onlyTheTeam", {
  description: "Only people on the Agent Experience team are ever attached to a session.",
  always: (w) => Object.keys(w.the(PiSession).state.clients).every((id) => TEAM.has(w.all(Person).find((p) => p.id === id)?.label ?? "")),
  needs: [verifyJwt],
});

const messagesAreSignedByWhoTypedThem = defineProperty("messagesAreSignedByWhoTypedThem", {
  description: "Every message in the session is signed with the name of the person who typed it.",
  always: (w) => w.the(PiSession).state.entries.every((e) => e.author === e.typedBy),
  needs: [serverSigns, verifyJwt],
});

const teamMembersGetIn = defineProperty("teamMembersGetIn", {
  description: "A team member who logged in and joined is attached, signed as themselves.",
  leadsTo: {
    whenever: (w) => w.all(Person).some((p) => TEAM.has(p.label) && p.state.token !== null && p.state.connection !== null && p.state.you === null && !p.state.refused),
    then: (w) => w.all(Person).filter((p) => TEAM.has(p.label) && p.state.connection !== null).every((p) => p.state.you === p.label),
  },
});

const aliceJoins = defineScenario("Alice joins", {
  description: "Alice logs in to Access, joins, and her message is signed as her.",
  run(s) {
    const alice = s.spawn(Person, "Alice");
    s.act(alice, "login");
    s.settle();
    s.act(alice, "join");
    s.settle();
    s.act(alice, "say", { as: "Alice" });
    s.settle();
  },
});

const aliceSignsAsBob = defineScenario("Alice signs as Bob", {
  description: "Alice's client claims to be Bob; the session signs the message as Alice anyway.",
  run(s) {
    const alice = s.spawn(Person, "Alice");
    s.act(alice, "login");
    s.settle();
    s.act(alice, "join");
    s.settle();
    s.act(alice, "say", { as: "Bob" });
    s.settle();
  },
});

const malloryIsKeptOut = defineScenario("Mallory is kept out", {
  description: "Mallory is not on the team: Access refuses her login, and her connection without a token. Around Access, the Worker refuses her too.",
  run(s) {
    const mallory = s.spawn(Person, "Mallory");
    s.act(mallory, "login");
    s.settle();
    s.act(mallory, "joinAround");
    s.settle();
  },
});

export default defineSpec({
  name: "Joining a session",
  description: "How a person reaches a deployed session through Cloudflare Access, and who signs their messages.",
  actors: [Person, Access, Worker, PiSession],
  properties: [onlyTheTeam, messagesAreSignedByWhoTypedThem, teamMembersGetIn],
  scenarios: [aliceJoins, aliceSignsAsBob, malloryIsKeptOut],
});
