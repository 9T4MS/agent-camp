/**
 * `?demo=busy|one|empty|join` (or `?demo=1` = busy): a local fake event stream, no server.
 * Deterministic for a given `seed`: the same sequence of messages in the same order
 * (timing is wall clock, so only order and content are reproducible).
 * Every message is built with `envelope()` and is schema-valid.
 */
import {
  ACTIVITIES,
  type Activity,
  type AgentKind,
  avatarFromSeed,
  envelope,
  type PersonView,
  type ServerToViewer,
  type SessionView,
  seededRandom,
  sessionIdOf,
} from "@agent-office/protocol";

export type DemoMode = "busy" | "one" | "empty" | "join";

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
    // busy
    const nPeople = Math.min(this.opts.people ?? 12, DEMO_NAMES.length);
    const nSessions = Math.max(nPeople, this.opts.sessions ?? 30);
    const counts = Array.from({ length: nPeople }, () => 1);
    for (let left = nSessions - nPeople; left > 0; ) {
      const i = Math.floor(this.rand() * nPeople);
      if (counts[i]! < 4) {
        counts[i]!++;
        left--;
      }
    }
    const people = counts.map((c) => this.makePerson(c));
    // guarantee the interesting states are visible
    const all = people.flatMap((p) => p.sessions);
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
    if (r < 0.3) return "typing";
    if (r < 0.48) return "reading";
    if (r < 0.62) return "running";
    if (r < 0.78) return "thinking";
    if (r < 0.88) return "waiting";
    return "idle";
  }

  private makeSession(
    agent: AgentKind,
    activity: Activity,
    subagents: number,
    project?: string,
  ): SessionView {
    const key = `demo${(this.sessionCounter++).toString(36).padStart(6, "0")}${Math.floor(this.rand() * 1e6)}`;
    return {
      sessionId: sessionIdOf("demo-laptop", key),
      agent,
      project: project ?? this.pick(PROJECTS),
      activity,
      subagents,
      startedAt: this.now() - Math.floor(this.rand() * 3 * 3600_000),
    };
  }

  private makePerson(sessions: number): PersonView {
    const name = DEMO_NAMES[this.nameIdx++ % DEMO_NAMES.length]!;
    const personId = name.toLowerCase();
    const p: PersonView = {
      personId,
      name,
      avatar: avatarFromSeed(personId),
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
    if (!this.stopped) this.sink(msg);
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
    } else if (r < 0.96 && p.sessions.length < 4) {
      const ns = this.makeSession(this.agent(), "thinking", 0);
      ns.startedAt = this.now();
      p.sessions.push(ns);
      this.emit(envelope("session.started", { personId: p.personId, session: structuredClone(ns) }));
    }
  }
}

export function parseDemoMode(value: string | null): DemoMode | null {
  if (value === null) return null;
  if (value === "one" || value === "empty" || value === "join" || value === "busy") return value;
  return "busy";
}
