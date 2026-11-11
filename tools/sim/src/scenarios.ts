/**
 * Scenario scripts. Each scenario is a generator of `Step`s driven by a seeded PRNG and the
 * current `World` (the runner applies every action before asking for the next step), so the
 * same seed always yields the same sequence.
 */
import { type Activity, type AgentKind, seededRandom } from "@agent-office/protocol";
import {
  AGENT_MIX,
  hex,
  intBetween,
  NEXT_ACTIVITY,
  type PersonDef,
  personAt,
  START_ACTIVITY,
  weighted,
} from "./data.ts";
import type { LaptopDef, SessionSpec, Step, World } from "./world.ts";

export const SCENARIOS = ["live", "empty", "one", "busy", "stress", "join"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export type ScenarioOptions = {
  /** people for `live` */
  people: number;
  /** inclusive range of sessions per person for `live` and joiners */
  sessionsPerPerson: [number, number];
  chaos: boolean;
  seed: number;
};

export const DEFAULT_SCENARIO_OPTIONS: ScenarioOptions = {
  people: 6,
  sessionsPerPerson: [1, 4],
  chaos: false,
  seed: 42,
};

export type ScenarioContext = { rand: () => number; world: World; opts: ScenarioOptions };
type Script = Generator<Step, void, void>;

export function createScenario(name: ScenarioName, world: World, opts: ScenarioOptions): Script {
  const ctx: ScenarioContext = { rand: seededRandom(`sim:${name}:${opts.seed}`), world, opts };
  switch (name) {
    case "live":
      return live(ctx);
    case "empty":
      return empty();
    case "one":
      return one(ctx);
    case "busy":
      return busy(ctx);
    case "stress":
      return stress(ctx);
    case "join":
      return join(ctx);
  }
}

// ---- helpers ------------------------------------------------------------------------------

const MIN = 60_000;

function laptop(rand: () => number, p: PersonDef): LaptopDef {
  return { clientId: `sim-${hex(rand, 12)}`, name: p.name, description: p.description };
}

function session(
  rand: () => number,
  p: PersonDef,
  over: Partial<Omit<SessionSpec, "key">> = {},
): SessionSpec {
  const agent: AgentKind = over.agent ?? weighted(rand, AGENT_MIX);
  const spec: SessionSpec = {
    key: hex(rand, 16),
    agent,
    project: over.project ?? p.projects[Math.floor(rand() * p.projects.length)]!,
    activity: over.activity ?? weighted(rand, START_ACTIVITY),
    subagents: over.subagents ?? 0,
    ageMs: over.ageMs ?? Math.floor(rand() * 40 * MIN),
  };
  return spec;
}

function* hold(): Script {
  while (true) yield { op: "wait", ms: 60_000 };
}

/** Join one person: connect laptop(s) and start `count` sessions spread over them. */
function* joinPerson(
  rand: () => number,
  p: PersonDef,
  laptops: number,
  count: number,
  gapMs: number,
): Generator<Step, LaptopDef[], void> {
  const defs: LaptopDef[] = [];
  for (let i = 0; i < laptops; i++) {
    const def = laptop(rand, p);
    defs.push(def);
    yield { op: "connect", laptop: def };
  }
  for (let i = 0; i < count; i++) {
    const def = defs[i % defs.length]!;
    yield { op: "start", clientId: def.clientId, session: session(rand, p) };
    if (gapMs > 0) yield { op: "wait", ms: gapMs };
  }
  return defs;
}

const pickOne = <T>(rand: () => number, xs: readonly T[]): T | undefined =>
  xs.length === 0 ? undefined : xs[Math.floor(rand() * xs.length)];

/** One realistic random change somewhere in the office. */
function* randomChange(
  ctx: ScenarioContext,
  weights: {
    activity: number;
    burst: number;
    finish: number;
    churn: number;
    wait: number;
  },
): Script {
  const { rand, world, opts } = ctx;
  const live = world.liveSessions();
  const kind = weighted(rand, [
    ["activity", weights.activity],
    ["burst", weights.burst],
    ["finish", weights.finish],
    ["churn", weights.churn],
    ["wait", weights.wait],
  ] as const);
  const target = pickOne(rand, live);
  if (!target) return;
  const { laptop: l, session: s } = target;
  switch (kind) {
    case "activity": {
      const next: Activity = weighted(rand, NEXT_ACTIVITY[s.activity]);
      yield { op: "activity", clientId: l.clientId, key: s.key, activity: next };
      return;
    }
    case "wait":
      yield { op: "activity", clientId: l.clientId, key: s.key, activity: "waiting" };
      return;
    case "burst": {
      // subagents are a Claude thing; bursts ramp up one by one (up to 8 for the "+N" badge)
      const claude = live.filter((x) => x.session.agent === "claude");
      const t = pickOne(rand, claude);
      if (!t) return;
      const goal = Math.min(8, t.session.subagents + intBetween(rand, 1, 6));
      for (let n = t.session.subagents + 1; n <= goal; n++) {
        yield { op: "subagents", clientId: t.laptop.clientId, key: t.session.key, count: n };
        yield { op: "wait", ms: intBetween(rand, 150, 600) };
      }
      return;
    }
    case "finish": {
      const busy = live.filter((x) => x.session.subagents > 0);
      const t = pickOne(rand, busy);
      if (!t) return;
      const done = Math.min(t.session.subagents, intBetween(rand, 1, 3));
      for (let i = 1; i <= done; i++) {
        yield {
          op: "subagents",
          clientId: t.laptop.clientId,
          key: t.session.key,
          count: t.session.subagents - 1,
        };
        if (i < done) yield { op: "wait", ms: intBetween(rand, 200, 900) };
      }
      return;
    }
    case "churn": {
      // a session ends, and (usually) another one starts on the same laptop later
      const max = opts.sessionsPerPerson[1];
      const p = PERSON_BY_NAME.get(l.name) ?? personAt(0);
      if (l.sessions.size > 1 || rand() < 0.3) {
        yield { op: "end", clientId: l.clientId, key: s.key };
      }
      if (l.sessions.size < max && rand() < 0.8) {
        yield { op: "wait", ms: intBetween(rand, 500, 3000) };
        yield { op: "start", clientId: l.clientId, session: session(rand, p, { ageMs: 0 }) };
      }
      return;
    }
  }
}

const PERSON_BY_NAME = new Map<string, PersonDef>();
for (let i = 0; i < 60; i++) PERSON_BY_NAME.set(personAt(i).name, personAt(i));

// ---- scenarios ----------------------------------------------------------------------------

function* empty(): Script {
  yield { op: "settled" };
  yield* hold();
}

/** One person, one Claude session, typing. */
function* one(ctx: ScenarioContext): Script {
  const anna = personAt(0);
  const l = laptop(ctx.rand, anna);
  yield { op: "connect", laptop: l };
  yield {
    op: "start",
    clientId: l.clientId,
    session: session(ctx.rand, anna, {
      agent: "claude",
      project: "agent-office",
      activity: "typing",
      ageMs: 4 * MIN,
    }),
  };
  yield { op: "settled" };
  yield* hold();
}

type Desk = Partial<Omit<SessionSpec, "key">> & { laptop?: number };
/** Hand-picked busy office: mixed agents, one session with 8 subagents, Lena waiting. */
const BUSY: { person: number; laptops: number; desks: Desk[] }[] = [
  {
    person: 0, // Anna
    laptops: 1,
    desks: [
      { agent: "claude", project: "agent-office", activity: "typing", subagents: 3 },
      { agent: "codex", project: "website", activity: "reading" },
    ],
  },
  {
    person: 1, // Martin, two laptops
    laptops: 2,
    desks: [
      { agent: "claude", project: "billing-api", activity: "running", subagents: 8, laptop: 0 },
      { agent: "pi", project: "infra", activity: "thinking", laptop: 1 },
    ],
  },
  {
    person: 2, // Lena
    laptops: 1,
    desks: [{ agent: "claude", project: "design-system", activity: "waiting" }],
  },
  {
    person: 3, // Jonas
    laptops: 1,
    desks: [
      { agent: "codex", project: "data-pipeline", activity: "typing" },
      { agent: "claude", project: "infra", activity: "reading", subagents: 1 },
    ],
  },
  {
    person: 4, // Sofia
    laptops: 1,
    desks: [
      { agent: "claude", project: "mobile-app", activity: "thinking", subagents: 2 },
      { agent: "unknown", project: "design-system", activity: "idle" },
    ],
  },
  {
    person: 5, // Felix
    laptops: 1,
    desks: [
      { agent: "pi", project: "game-jam", activity: "typing" },
      { agent: "claude", project: "agent-office", activity: "running" },
    ],
  },
];

function* busySetup(ctx: ScenarioContext): Script {
  const { rand } = ctx;
  for (const row of BUSY) {
    const p = personAt(row.person);
    const defs: LaptopDef[] = [];
    for (let i = 0; i < row.laptops; i++) {
      const def = laptop(rand, p);
      defs.push(def);
      yield { op: "connect", laptop: def };
    }
    for (const desk of row.desks) {
      const { laptop: li, ...over } = desk;
      const def = defs[li ?? 0]!;
      yield {
        op: "start",
        clientId: def.clientId,
        session: session(rand, p, { subagents: 0, ...over }),
      };
    }
    yield { op: "wait", ms: 300 };
  }
}

function* busy(ctx: ScenarioContext): Script {
  yield* busySetup(ctx);
  yield { op: "settled" };
  yield* hold();
}

/** Busy office, then a new person walks in every ~8 s. */
function* join(ctx: ScenarioContext): Script {
  const { rand, opts } = ctx;
  yield* busySetup(ctx);
  yield { op: "settled" };
  for (let i = BUSY.length; ; i++) {
    yield { op: "wait", ms: intBetween(rand, 7500, 8500) };
    const [min, max] = opts.sessionsPerPerson;
    yield* joinPerson(
      rand,
      personAt(i),
      1,
      intBetween(rand, Math.max(1, min), Math.min(max, 2)),
      0,
    );
  }
}

/** 12 people, 30 sessions, constant changes. */
function* stress(ctx: ScenarioContext): Script {
  const { rand } = ctx;
  for (let i = 0; i < 12; i++) {
    const p = personAt(i);
    const laptops = i === 1 || i === 4 ? 2 : 1;
    const count = i < 6 ? 3 : 2; // 6*3 + 6*2 = 30
    const defs: LaptopDef[] = [];
    for (let j = 0; j < laptops; j++) {
      const def = laptop(rand, p);
      defs.push(def);
      yield { op: "connect", laptop: def };
    }
    for (let j = 0; j < count; j++) {
      const s = session(rand, p);
      if (s.agent === "claude" && rand() < 0.4) s.subagents = intBetween(rand, 1, 8);
      yield { op: "start", clientId: defs[j % defs.length]!.clientId, session: s };
    }
    yield { op: "wait", ms: 100 };
  }
  yield { op: "settled" };
  while (true) {
    yield { op: "wait", ms: intBetween(rand, 80, 400) };
    yield* randomChange(
      { ...ctx, opts: { ...ctx.opts, sessionsPerPerson: [2, 3] } },
      {
        activity: 70,
        burst: 8,
        finish: 12,
        churn: 4,
        wait: 6,
      },
    );
  }
}

/**
 * The default: `--people` teammates join over time with `--sessions-per-person` sessions,
 * activities change every few seconds, subagent bursts, sessions come and go, one laptop
 * drops without a bye, sessions wait for their human. `--chaos` adds random disconnects,
 * reconnects, clean quits + rejoins and rapid-fire changes.
 */
function* live(ctx: ScenarioContext): Script {
  const { rand, world, opts } = ctx;
  const [min, max] = opts.sessionsPerPerson;
  const multi = new Set<string>();
  for (let i = 0; i < opts.people; i++) {
    const p = personAt(i);
    const laptops = i === 1 || (i > 2 && rand() < 0.12) ? 2 : 1;
    const defs = yield* joinPerson(rand, p, laptops, intBetween(rand, min, max), 150);
    if (laptops > 1) for (const d of defs) multi.add(d.clientId);
    yield { op: "wait", ms: intBetween(rand, 300, 1500) };
  }
  yield { op: "settled" };

  const departed: LaptopDef[] = [];
  let dropped = false;
  for (let step = 1; ; step++) {
    yield { op: "wait", ms: opts.chaos ? intBetween(rand, 100, 900) : intBetween(rand, 800, 3500) };

    // once per run: a laptop (preferably someone's second one) vanishes without a bye
    if (!dropped && step === 15) {
      const online = world.online().filter((l) => l.sessions.size > 0);
      const victim = online.find((l) => multi.has(l.clientId)) ?? pickOne(rand, online);
      if (victim) {
        dropped = true;
        yield { op: "drop", clientId: victim.clientId };
        continue;
      }
    }

    if (opts.chaos) {
      const c = weighted(rand, [
        ["none", 70],
        ["drop", 6],
        ["reconnect", 8],
        ["bye", 3],
        ["rejoin", 4],
        ["rapid", 9],
      ] as const);
      if (c === "drop") {
        const l = pickOne(rand, world.online());
        if (l) yield { op: "drop", clientId: l.clientId };
        continue;
      }
      if (c === "reconnect") {
        const l = pickOne(
          rand,
          [...world.laptops.values()].filter((x) => !x.online),
        );
        if (l) yield { op: "reconnect", clientId: l.clientId };
        continue;
      }
      if (c === "bye") {
        const l = pickOne(rand, world.online());
        if (l) {
          departed.push({ clientId: l.clientId, name: l.name, description: l.description ?? "" });
          yield { op: "bye", clientId: l.clientId };
        }
        continue;
      }
      if (c === "rejoin" && departed.length > 0) {
        const def = departed.splice(Math.floor(rand() * departed.length), 1)[0]!;
        const p = PERSON_BY_NAME.get(def.name) ?? personAt(0);
        yield { op: "connect", laptop: def };
        yield { op: "start", clientId: def.clientId, session: session(rand, p, { ageMs: 0 }) };
        continue;
      }
      if (c === "rapid") {
        const t = pickOne(rand, world.liveSessions());
        if (!t) continue;
        for (let i = intBetween(rand, 3, 7); i > 0; i--) {
          const cur = world.laptops.get(t.laptop.clientId)?.sessions.get(t.session.key);
          if (!cur) break;
          yield {
            op: "activity",
            clientId: t.laptop.clientId,
            key: t.session.key,
            activity: weighted(rand, NEXT_ACTIVITY[cur.activity]),
          };
          yield { op: "wait", ms: intBetween(rand, 40, 160) };
        }
        continue;
      }
    }

    yield* randomChange(ctx, { activity: 62, burst: 8, finish: 12, churn: 9, wait: 7 });
  }
}
