/**
 * `?demo=busy|one|empty|join|party|feierabend` (or `?demo=1` = busy): a local fake event
 * stream, no server. `feierabend` = Friday 17:30: most people idle, the bar full, the weed
 * shop and smokers' corner busy.
 * `party` plays the office-life moments quickly: idle people (coffee, chats, arcade), a long
 * waiter, a helper burst to 10 (party mode), `/clear` restarts, a long session that ships, new
 * records of parallel agents.
 * Deterministic for a given `seed`: the same sequence of messages in the same order
 * (timing is wall clock, so only order and content are reproducible).
 * Every message is built with `envelope()` and is schema-valid.
 */
import {
  ACTIVITIES,
  type Activity,
  type AgentKind,
  type AvatarSpec,
  avatarFromSeed,
  envelope,
  type PersonView,
  repairAvatar,
  type ServerToViewer,
  type SessionView,
  seededRandom,
  sessionIdOf,
} from "@agent-office/protocol";

export type DemoMode = "busy" | "one" | "empty" | "join" | "party" | "feierabend";

export const DEMO_NAMES = [
  "Anna",
  "Martin",
  "Lea",
  "Jonas",
  "Sofia",
  "Max",
  "Mia",
  "Felix",
  "Clara",
  "Paul",
  "Nora",
  "Elias",
  "Ida",
  "Theo",
  "Lina",
  "Ben",
];
const PROJECTS = [
  "agent-office",
  "web-shop",
  "infra",
  "docs",
  "ml-pipeline",
  "mobile-app",
  "api-gateway",
  "design-sys",
  "billing",
  "data-lake",
];

export type DemoOptions = {
  mode: DemoMode;
  seed?: string;
  /** busy: number of people (default 12) */
  people?: number;
  /** busy: total sessions (default 30) */
  sessions?: number;
  /** speed multiplier for the event clock (default 1) */
  speed?: number;
  /** avatar of the first demo person (`?look=`), e.g. a detailed look fixture */
  look?: AvatarSpec;
};

type Sink = (msg: ServerToViewer) => void;

export class DemoFeed {
  private rand: () => number;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private people = new Map<string, PersonView>();
  private nameIdx = 0;
  private sessionCounter = 0;
  private stopped = false;
  private readonly speed: number;

  constructor(
    private readonly opts: DemoOptions,
    private readonly sink: Sink,
    private readonly now: () => number = Date.now,
  ) {
    this.rand = seededRandom(`demo:${opts.mode}:${opts.seed ?? "1"}`);
    this.speed = opts.speed ?? 1;
  }

  start(): void {
    const { mode } = this.opts;
    if (mode === "empty") {
      this.snapshot([]);
      return;
    }
    if (mode === "one") {
      const p = this.makePerson(0);
      p.sessions.push(this.makeSession("claude", "typing", 0, "agent-office"));
      this.snapshot([p]);
      this.loop(9000, () => this.tickOne(p.personId));
      return;
    }
    if (mode === "join") {
      const initial = [0, 1, 2].map((i) => {
        const p = this.makePerson(1 + this.rand() * 2);
        p.sessions[0]!.activity = (["typing", "reading", "running"] as const)[i]!;
        return p;
      });
      this.snapshot(initial);
      this.after(1200, () => this.joinSomeone());
      this.loop(11000, () => this.joinSomeone());
      this.loop(2200, () => this.tickBusy());
      return;
    }
    if (mode === "party") {
      this.startParty();
      return;
    }
    if (mode === "feierabend") {
      this.startFeierabend();
      return;
    }
    // busy
    const nPeople = Math.min(this.opts.people ?? 12, DEMO_NAMES.length);
    const nSessions = Math.max(nPeople, this.opts.sessions ?? 30);
    const counts = Array.from({ length: nPeople }, () => 1);
    let left = nSessions - nPeople;
    // one power user with a big pod (5 desks) when there are sessions to spare
    if (nPeople > 3 && left >= 8) {
      counts[3] = 5;
      left -= 4;
    }
    while (left > 0) {
      const i = Math.floor(this.rand() * nPeople);
      if (counts[i]! < 4) {
        counts[i]!++;
        left--;
      }
    }
    const people = counts.map((c) => this.makePerson(c));
    // guarantee the interesting states are visible
    const all = people.flatMap((p) => p.sessions);
    // realistic mix: mostly busy, a few idle, exactly two people waiting on their human
    for (const s of all) if (s.activity === "waiting") s.activity = "thinking";
    if (all[1]) all[1].activity = "waiting";
    if (all[7]) all[7].activity = "waiting";
    if (all[2]) all[2].subagents = 8;
    if (all[5]) all[5].subagents = 3;
    for (const i of [4, 11, 17, 23]) if (all[i]) all[i].activity = "idle";
    if (all[0]) all[0].activity = "typing";
    this.snapshot(people);
    this.loop(900, () => this.tickBusy());
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  // ---- building blocks --------------------------------------------------------------------
  private pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rand() * items.length)]!;
  }

  private agent(): AgentKind {
    const r = this.rand();
    return r < 0.6 ? "claude" : r < 0.85 ? "codex" : r < 0.97 ? "pi" : "unknown";
  }

  private activity(): Activity {
    const r = this.rand();
    if (r < 0.32) return "typing";
    if (r < 0.52) return "reading";
    if (r < 0.67) return "running";
    if (r < 0.83) return "thinking";
    if (r < 0.88) return "waiting";
    return "idle";
  }

  private waitingCount(): number {
    let n = 0;
    for (const p of this.people.values())
      for (const s of p.sessions) if (s.activity === "waiting") n++;
    return n;
  }

  private makeSession(
    agent: AgentKind,
    activity: Activity,
    subagents: number,
    project?: string,
  ): SessionView {
    // every third session runs on the devbox (no rand() call: keeps seeded demos unchanged)
    const machine = this.sessionCounter % 3 === 2 ? "devbox" : "MacBook";
    // fixed context ramp per session (no rand(): seeded demos stay the same); some smoke, one burns
    const context = [0.15, 0.35, 0.55, 0.2, 0.3, 0.4, 0.65, 0.1, 0.25, 0.45, 0.85, 0.3, 0.2, 0.5][
      this.sessionCounter % 14
    ]!;
    const key = `demo${(this.sessionCounter++).toString(36).padStart(6, "0")}${Math.floor(this.rand() * 1e6)}`;
    return {
      sessionId: sessionIdOf("demo-laptop", key),
      agent,
      project: project ?? this.pick(PROJECTS),
      activity,
      subagents,
      startedAt: this.now() - Math.floor(this.rand() * 3 * 3600_000),
      machine,
      context,
    };
  }

  private makePerson(sessions: number): PersonView {
    const name = DEMO_NAMES[this.nameIdx++ % DEMO_NAMES.length]!;
    const personId = name.toLowerCase();
    const first = this.nameIdx === 1 && this.opts.look;
    const p: PersonView = {
      personId,
      name,
      avatar: first ? structuredClone(this.opts.look!) : avatarFromSeed(personId),
      sessions: [],
      joinedAt: this.now() - Math.floor(this.rand() * 5 * 3600_000),
    };
    for (let i = 0; i < Math.floor(sessions); i++) {
      p.sessions.push(this.makeSession(this.agent(), this.activity(), 0));
    }
    this.people.set(personId, p);
    return p;
  }

  private emit(msg: ServerToViewer) {
    if (!this.stopped) this.sink({ ...msg, ts: this.now() });
  }

  private snapshot(people: PersonView[]) {
    this.emit(
      envelope("office.snapshot", {
        officeName: "Agent Office",
        serverTime: this.now(),
        people: structuredClone(people),
      }),
    );
  }

  private after(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms / this.speed));
  }

  private loop(meanMs: number, fn: () => void) {
    const next = () => {
      if (this.stopped) return;
      fn();
      this.after(meanMs * (0.5 + this.rand()), next);
    };
    this.after(meanMs * (0.5 + this.rand()), next);
  }

  // ---- party ------------------------------------------------------------------------------
  private startParty() {
    const H = 3600_000;
    const plan: [Activity, number, number][][] = [
      [
        ["typing", 0, 2.2 * H],
        ["reading", 0, 0.3 * H],
      ], // Anna: the long one ships
      [
        ["running", 4, 0.7 * H],
        ["thinking", 0, 0.2 * H],
        ["typing", 0, 0.1 * H],
      ], // Martin: helpers -> party, new records
      [["idle", 0, 1 * H]], // Lea
      [
        ["idle", 0, 0.5 * H],
        ["typing", 1, 0.4 * H],
      ], // Jonas
      [["waiting", 0, 0.6 * H]], // Sofia: waits (ping, cat, chef)
      [["idle", 0, 0.4 * H]], // Max
      [["idle", 0, 0.9 * H]], // Mia
      [["typing", 0, 0.8 * H]], // Felix: /clear
    ];
    const people = plan.map((sessions) => {
      const p = this.makePerson(0);
      for (const [activity, subagents, age] of sessions) {
        const ses = this.makeSession(this.agent(), activity, subagents);
        ses.startedAt = this.now() - age;
        p.sessions.push(ses);
      }
      return p;
    });
    this.snapshot(people);
    const [anna, martin, , , , , , felix] = people;
    // Martin's helpers climb to 10: the game corner parties
    const ms = martin!.sessions[0]!;
    for (let i = 0; i < 6; i++) this.after(3000 + i * 1100, () => this.helpers(martin!, ms, +1));
    // ... and then they finish one by one (hop into the monitor, or the cat gets one)
    for (let i = 0; i < 5; i++) this.after(15000 + i * 2200, () => this.helpers(martin!, ms, -1));
    this.after(8000, () => this.clearSession(felix!));
    this.after(13000, () => this.startSession(martin!, "thinking"));
    this.after(19000, () => this.endSession(anna!, anna!.sessions[0]));
    this.after(24000, () => this.startSession(martin!, "reading"));
    this.after(34000, () => this.clearSession(martin!));
    // keep the busy ones busy, the idle ones idle (they wander, chat, play)
    this.loop(2600, () => {
      const busy = [...this.people.values()].flatMap((p) =>
        p.sessions
          .filter((x) => x.activity !== "idle" && x.activity !== "waiting")
          .map((x) => [p, x] as const),
      );
      if (busy.length === 0) return;
      const [p, x] = this.pick(busy);
      const next = this.pick(["typing", "reading", "running", "thinking"] as const);
      this.setActivity(p.personId, x, next);
    });
    // and every now and then another /clear or a session that ships
    this.loop(16000, () => {
      const p = this.pick([...this.people.values()].filter((q) => q.sessions.length > 0));
      if (this.rand() < 0.6) this.clearSession(p);
      else {
        const x = p.sessions.find((y) => y.activity !== "waiting" && y.activity !== "idle");
        if (x) {
          x.startedAt = Math.min(x.startedAt, this.now() - 0.8 * 3600_000);
          this.endSession(p, x);
          this.after(5000, () => this.startSession(p, "typing"));
        }
      }
    });
  }

  // ---- feierabend -------------------------------------------------------------------------
  /** Friday after work: nearly everybody's agents idle, two people still pushing. */
  private startFeierabend() {
    const H = 3600_000;
    const plan: Activity[] = ["idle", "idle", "typing", "idle", "idle", "idle", "running", "idle"];
    const people = plan.map((activity) => {
      const p = this.makePerson(0);
      const ses = this.makeSession(this.agent(), activity, 0);
      ses.startedAt = this.now() - Math.floor((0.5 + this.rand() * 2) * H);
      p.sessions.push(ses);
      return p;
    });
    this.snapshot(people);
    this.loop(3000, () => {
      const busy = [...this.people.values()].flatMap((p) =>
        p.sessions.filter((x) => x.activity !== "idle").map((x) => [p, x] as const),
      );
      if (busy.length === 0) return;
      const [p, x] = this.pick(busy);
      this.setActivity(p.personId, x, this.pick(["typing", "reading", "running"] as const));
    });
  }

  private helpers(p: PersonView, s: SessionView, d: number) {
    if (!p.sessions.includes(s)) return;
    s.subagents = Math.max(0, s.subagents + d);
    this.emit(
      envelope(d > 0 ? "subagent.spawned" : "subagent.finished", {
        personId: p.personId,
        sessionId: s.sessionId,
        count: s.subagents,
      }),
    );
  }

  private startSession(p: PersonView, activity: Activity, like?: SessionView) {
    if (p.sessions.length >= 6) return;
    const ns = this.makeSession(like?.agent ?? this.agent(), activity, 0, like?.project);
    if (like?.machine) ns.machine = like.machine;
    ns.startedAt = this.now();
    p.sessions.push(ns);
    this.emit(envelope("session.started", { personId: p.personId, session: structuredClone(ns) }));
  }

  private endSession(p: PersonView, s: SessionView | undefined) {
    if (!s || !p.sessions.includes(s)) return;
    p.sessions.splice(p.sessions.indexOf(s), 1);
    this.emit(envelope("session.ended", { personId: p.personId, sessionId: s.sessionId }));
  }

  /** `/clear`: the session ends and a fresh one starts a second later on the same machine. */
  private clearSession(p: PersonView) {
    const s = p.sessions.find((x) => x.activity !== "waiting") ?? p.sessions[0];
    if (!s) return;
    this.endSession(p, s);
    this.after(1100, () => this.startSession(p, "thinking", s));
  }

  // ---- scripted behavior ------------------------------------------------------------------
  private setActivity(personId: string, s: SessionView, activity: Activity) {
    if (s.activity === activity) return;
    const previous = s.activity;
    s.activity = activity;
    this.emit(
      envelope("session.activityChanged", { personId, sessionId: s.sessionId, activity, previous }),
    );
  }

  private tickOne(personId: string) {
    const p = this.people.get(personId);
    const s = p?.sessions[0];
    if (!s) return;
    const order: Activity[] = ["typing", "reading", "typing", "running", "thinking", "typing"];
    const i = order.indexOf(s.activity);
    this.setActivity(personId, s, order[(i + 1) % order.length]!);
  }

  private joinSomeone() {
    if (this.people.size >= DEMO_NAMES.length) return;
    const p = this.makePerson(1);
    p.sessions[0]!.activity = "typing";
    p.joinedAt = this.now();
    this.emit(envelope("person.joined", { person: structuredClone(p) }));
  }

  private tickBusy() {
    const people = [...this.people.values()];
    if (people.length === 0) return;
    const p = this.pick(people);
    const r = this.rand();
    const s = p.sessions.length > 0 ? this.pick(p.sessions) : undefined;
    if (s && r < 0.62) {
      let a = this.activity();
      if (a === s.activity) a = this.pick(ACTIVITIES);
      // someone answered: waiting sessions get back to work; never more than 2 waiting
      if (s.activity === "waiting") a = this.rand() < 0.6 ? "typing" : "thinking";
      else if (a === "waiting" && this.waitingCount() >= 2) a = "reading";
      this.setActivity(p.personId, s, a);
    } else if (s && r < 0.84) {
      const up = s.subagents === 0 || (s.subagents < 9 && this.rand() < 0.55);
      s.subagents += up ? 1 : -1;
      this.emit(
        envelope(up ? "subagent.spawned" : "subagent.finished", {
          personId: p.personId,
          sessionId: s.sessionId,
          count: s.subagents,
        }),
      );
    } else if (s && r < 0.9 && p.sessions.length > 1) {
      p.sessions.splice(p.sessions.indexOf(s), 1);
      this.emit(envelope("session.ended", { personId: p.personId, sessionId: s.sessionId }));
    } else if (r < 0.96 && p.sessions.length < 6) {
      const ns = this.makeSession(this.agent(), "thinking", 0);
      ns.startedAt = this.now();
      p.sessions.push(ns);
      this.emit(
        envelope("session.started", { personId: p.personId, session: structuredClone(ns) }),
      );
    }
  }
}

export function parseDemoMode(value: string | null): DemoMode | null {
  if (value === null) return null;
  if (
    value === "one" ||
    value === "empty" ||
    value === "join" ||
    value === "busy" ||
    value === "party" ||
    value === "feierabend"
  )
    return value;
  return "busy";
}

/**
 * `?look=` value -> avatar: a fixture name (`tracht`, looked up in `fixtures`) or
 * `b64:<base64url AvatarSpec JSON>`. Untrusted input goes through `repairAvatar`; values with
 * nothing usable give null. Fixtures are passed in (loaded on demand from
 * `@agent-office/protocol/fixtures`) so they stay out of the main bundle.
 */
export function parseLookParam(
  value: string | null,
  fixtures: Readonly<Record<string, AvatarSpec>> = {},
): AvatarSpec | null {
  if (!value) return null;
  if (Object.hasOwn(fixtures, value)) return fixtures[value]!;
  if (!value.startsWith("b64:")) return null;
  let candidate: unknown;
  try {
    const b64 = value.slice(4).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    candidate = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))),
    );
  } catch {
    return null;
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const { avatar, repaired } = repairAvatar(candidate, "look-param");
  if (!repaired) return avatar;
  // repaired: keep it only if something from the candidate survived (a look or a catalog field)
  const c = candidate as Record<string, unknown>;
  const kept =
    (avatar.look !== undefined && "look" in c) ||
    LOOK_CATALOG_KEYS.some((k) => k in c && JSON.stringify(c[k]) === JSON.stringify(avatar[k]));
  return kept ? avatar : null;
}

const LOOK_CATALOG_KEYS = [
  "hairStyle",
  "hairColor",
  "skinTone",
  "glasses",
  "facialHair",
  "accessory",
  "deskProps",
  "deskMess",
] as const;
