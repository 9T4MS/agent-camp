/**
 * Drives a scenario: real WebSocket connectors (`runScenario`) or a virtual clock with no
 * network at all (`dryRun`, for tests).
 */
import {
  type ConnectorToServer,
  type OfficeSnapshot,
  type SessionView,
  SNAPSHOT_DEBOUNCE_MS,
  sessionIdOf,
  WS_CONNECTOR_PATH,
} from "@agent-office/protocol";
import type { z } from "zod";
import { FakeConnector } from "./connector.ts";
import {
  createScenario,
  DEFAULT_SCENARIO_OPTIONS,
  type ScenarioName,
  type ScenarioOptions,
} from "./scenarios.ts";
import {
  type Action,
  byeMessage,
  helloMessage,
  type Step,
  snapshotMessage,
  World,
} from "./world.ts";

export type SimOptions = Partial<ScenarioOptions> & {
  /** default "live" (the free-running script driven by --people / --chaos) */
  scenario?: ScenarioName;
  /** ws(s)://host[:port] (path optional), default ws://localhost:8787 */
  server?: string;
  password?: string;
  /** time multiplier for scenario waits, default 1 */
  speed?: number;
  /** wall-clock run time; 0 / undefined = until stop() */
  durationMs?: number;
  /** one line per action; pass `false` to silence */
  log?: ((line: string) => void) | false;
  /** at "settled", poll GET /api/state until it matches the simulated office (default true) */
  verifyState?: boolean;
  settleTimeoutMs?: number;
};

export type SimHandle = {
  world: World;
  connectors: Map<string, FakeConnector>;
  /** resolves when the scenario reached its stable state (and /api/state agrees) */
  settled: Promise<void>;
  /** resolves when the run ended (duration elapsed or stop()) */
  done: Promise<void>;
  /** stop the script and say bye on every connected laptop */
  stop(): Promise<void>;
};

/** ws://host:8787 -> { ws: ws://host:8787/ws/connector, http: http://host:8787 } */
export function serverUrls(server: string): { ws: string; http: string } {
  const u = new URL(server.includes("://") ? server : `ws://${server}`);
  if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:";
  const base = `${u.protocol}//${u.host}`;
  const http = base.replace(/^ws/, "http");
  return { ws: `${base}${WS_CONNECTOR_PATH}`, http };
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

/** One concise human-readable line for an action (computed before it is applied). */
export function describeAction(world: World, a: Action): string {
  if (a.op === "connect") {
    const desc = a.laptop.description ? ` "${a.laptop.description}"` : "";
    return `${pad(a.laptop.name, 9)} connect   ${a.laptop.clientId}${desc}`;
  }
  const l = world.laptops.get(a.clientId);
  const who = pad(l?.name ?? "?", 9);
  const s = "key" in a ? l?.sessions.get(a.key) : undefined;
  const where = s ? `${pad(s.agent, 7)} ${pad(s.project ?? "-", 15)}` : "";
  switch (a.op) {
    case "bye":
      return `${who} bye       ${a.clientId}`;
    case "drop":
      return `${who} drop      ${a.clientId} (no bye, heartbeats stop)`;
    case "reconnect":
      return `${who} reconnect ${a.clientId}`;
    case "start": {
      const x = a.session;
      const subs = x.subagents > 0 ? ` +${x.subagents} subagents` : "";
      return `${who} start     ${pad(x.agent, 7)} ${pad(x.project ?? "-", 15)} ${x.activity}${subs}`;
    }
    case "end":
      return `${who} end       ${where}`.trimEnd();
    case "activity":
      return `${who} activity  ${where} ${s?.activity ?? "?"} -> ${a.activity}`;
    case "subagents": {
      const prev = s?.subagents ?? 0;
      const verb = a.count > prev ? "spawned " : "finished";
      return `${who} subagent  ${where} ${verb} (${a.count})`;
    }
  }
}

function resolveOptions(opts: SimOptions): ScenarioOptions {
  return {
    people: opts.people ?? DEFAULT_SCENARIO_OPTIONS.people,
    sessionsPerPerson: opts.sessionsPerPerson ?? DEFAULT_SCENARIO_OPTIONS.sessionsPerPerson,
    chaos: opts.chaos ?? DEFAULT_SCENARIO_OPTIONS.chaos,
    seed: opts.seed ?? DEFAULT_SCENARIO_OPTIONS.seed,
  };
}

/**
 * Does GET /api/state show what the simulated office expects? Every online laptop's sessions
 * must be there with the same agent/activity/subagents and nothing extra; people and sessions
 * that are not ours (other connectors, leftovers in their grace period) are ignored.
 */
export function stateMatches(state: z.infer<typeof OfficeSnapshot>, world: World): boolean {
  const server = new Map<string, { personId: string; s: SessionView }>();
  for (const p of state.data.people)
    for (const s of p.sessions) server.set(s.sessionId, { personId: p.personId, s });
  const online = world.online();
  const ours = new Set(online.map((l) => l.clientId));
  let expected = 0;
  for (const l of online) {
    if (!state.data.people.some((p) => p.personId === l.personId)) return false;
    for (const s of l.sessions.values()) {
      expected++;
      const got = server.get(sessionIdOf(l.clientId, s.key));
      if (!got || got.personId !== l.personId) return false;
      if (got.s.agent !== s.agent || got.s.activity !== s.activity) return false;
      if (got.s.subagents !== s.subagents) return false;
    }
  }
  let present = 0;
  for (const id of server.keys()) if (ours.has(id.slice(0, id.indexOf(":")))) present++;
  return present === expected;
}

/**
 * Run a scenario against a real server. Returns immediately; await `handle.settled` for the
 * stable state (e.g. before a screenshot) and `handle.stop()` to finish.
 */
export function runScenario(opts: SimOptions = {}): SimHandle {
  const scenario = opts.scenario ?? "live";
  const sopts = resolveOptions(opts);
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const urls = serverUrls(opts.server ?? "ws://localhost:8787");
  const password = opts.password ?? "devpass";
  const t0 = Date.now();
  const sink = opts.log === false ? () => {} : (opts.log ?? ((l: string) => console.log(l)));
  const log = (line: string) =>
    sink(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`);

  const world = new World(() => Date.now());
  const connectors = new Map<string, FakeConnector>();
  const script = createScenario(scenario, world, sopts);

  let stopping = false;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stopping) return resolve();
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });

  let markSettled!: () => void;
  let failSettled!: (err: unknown) => void;
  let isSettled = false;
  const settled = new Promise<void>((res, rej) => {
    markSettled = () => {
      isSettled = true;
      res();
    };
    failSettled = rej;
  });
  settled.catch(() => {});

  const settle = async () => {
    for (const c of connectors.values()) c.flush();
    if (opts.verifyState === false) return;
    const deadline = Date.now() + (opts.settleTimeoutMs ?? 8_000);
    while (!stopping && Date.now() < deadline) {
      try {
        const res = await fetch(`${urls.http}/api/state`);
        if (res.ok && stateMatches((await res.json()) as z.infer<typeof OfficeSnapshot>, world))
          return;
      } catch {
        // server not reachable via HTTP; keep trying until the deadline
      }
      await sleep(100);
    }
    if (!stopping) log("warning: /api/state did not match the simulated office before timeout");
  };

  const perform = async (a: Action) => {
    if (a.op === "connect") {
      const c = new FakeConnector(a.laptop, {
        url: urls.ws,
        password,
        sessions: () => world.sessionInfos(a.laptop.clientId),
        log,
        debounceMs: Math.max(50, Math.round(SNAPSHOT_DEBOUNCE_MS / speed)),
        autoReconnect: true,
      });
      connectors.set(a.laptop.clientId, c);
      await c.connect();
      return;
    }
    const c = connectors.get(a.clientId);
    if (!c) return;
    switch (a.op) {
      case "bye":
        connectors.delete(a.clientId);
        await c.bye();
        return;
      case "drop":
        c.drop();
        return;
      case "reconnect":
        await c.connect().catch((err) => log(`reconnect failed: ${(err as Error).message}`));
        return;
      default:
        c.markDirty();
    }
  };

  const loop = async () => {
    for (let r = script.next(); !r.done && !stopping; r = script.next()) {
      const step: Step = r.value;
      if (step.op === "wait") {
        await sleep(step.ms / speed);
      } else if (step.op === "settled") {
        await settle();
        if (!isSettled) {
          const people = world.expectedPeople();
          let sessions = 0;
          for (const n of people.values()) sessions += n;
          log(`settled   ${scenario}: ${people.size} people, ${sessions} sessions`);
          markSettled();
        }
      } else {
        const line = describeAction(world, step);
        if (!world.apply(step)) continue;
        log(line);
        await perform(step);
      }
    }
  };

  let durationTimer: ReturnType<typeof setTimeout> | null = null;
  let stopRequested!: () => void;
  const untilStopped = new Promise<void>((r) => {
    stopRequested = r;
  });
  const running = loop();
  const finish = async () => {
    stopping = true;
    stopRequested();
    wake?.();
    if (durationTimer) clearTimeout(durationTimer);
    await running.catch(() => {});
    await Promise.all([...connectors.values()].map((c) => c.bye().catch(() => {})));
    connectors.clear();
  };
  let stopped: Promise<void> | null = null;
  const stop = () => {
    stopped ??= finish();
    return stopped;
  };

  const done = (async () => {
    try {
      await running;
    } catch (err) {
      failSettled(err);
      await stop();
      throw err;
    }
    if (!isSettled) markSettled();
    // a script that ran out keeps holding (heartbeats) until stop() / --duration
    await untilStopped;
    await stop();
  })();
  done.catch(() => {});

  if (opts.durationMs && opts.durationMs > 0) {
    durationTimer = setTimeout(() => void stop(), opts.durationMs);
  }

  return { world, connectors, settled, done, stop };
}

// ---- dry run (no network) -----------------------------------------------------------------

export type DryStep = { t: number; step: Step };

export type DryRunResult = {
  steps: DryStep[];
  /** every message the fake connectors would send (validated), in order */
  messages: ConnectorToServer[];
  world: World;
  settledAt: number | null;
};

/**
 * Play a scenario on a virtual clock without any network. Stops after `maxSteps` steps or
 * `untilMs` simulated ms, whichever comes first. Deterministic for a given seed and startTs.
 */
export function dryRun(
  opts: Omit<SimOptions, "server" | "password" | "log"> & {
    maxSteps?: number;
    untilMs?: number;
    startTs?: number;
  } = {},
): DryRunResult {
  const start = opts.startTs ?? Date.UTC(2026, 10, 10, 9, 0, 0);
  let t = 0;
  const world = new World(() => start + t);
  const script = createScenario(opts.scenario ?? "live", world, resolveOptions(opts));
  const steps: DryStep[] = [];
  const messages: ConnectorToServer[] = [];
  let settledAt: number | null = null;
  const maxSteps = opts.maxSteps ?? 500;
  const untilMs = opts.untilMs ?? Number.POSITIVE_INFINITY;
  for (let r = script.next(); !r.done; r = script.next()) {
    const step = r.value;
    steps.push({ t, step });
    if (step.op === "wait") t += step.ms;
    else if (step.op === "settled") settledAt ??= t;
    else if (world.apply(step)) {
      const id = step.op === "connect" ? step.laptop.clientId : step.clientId;
      const l = world.laptops.get(id);
      if (step.op === "connect") messages.push(helloMessage(step.laptop, "devpass", start + t));
      if (step.op === "bye") messages.push(byeMessage(start + t));
      else if (l?.online) messages.push(snapshotMessage(world.sessionInfos(id), start + t));
    }
    if (steps.length >= maxSteps || t >= untilMs) break;
  }
  return { steps, messages, world, settledAt };
}
