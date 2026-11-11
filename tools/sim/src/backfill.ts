/**
 * `--backfill-week`: a realistic week of fake history rows for /stats. Weekday and
 * working-hour heavy, a few late nights and weekend pokes, mostly Claude with some Codex/Pi,
 * several projects per person, parallel sessions and subagent bursts.
 */
import {
  type AgentKind,
  HistoryRow,
  personIdFromName,
  seededRandom,
} from "@agent-office/protocol";
import { personAt, type Weighted, weighted } from "./data.ts";

export type BackfillOptions = {
  seed?: number;
  /** end of the generated range (default now); nothing is generated after it */
  now?: number;
  days?: number;
  people?: number;
  /** office time zone the working hours are in (default Europe/Vienna, like the server) */
  timezone?: string;
};

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Offset (ms) of `tz` from UTC at instant `ts`. */
function tzOffset(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - (ts - (ts % 1000));
}

/** Local calendar date (y, m0, d) and weekday (0 = Monday) of `ts` in `tz`. */
function localDate(ts: number, tz: string): { y: number; m: number; d: number; weekday: number } {
  const local = new Date(ts + tzOffset(ts, tz));
  return {
    y: local.getUTCFullYear(),
    m: local.getUTCMonth(),
    d: local.getUTCDate(),
    weekday: (local.getUTCDay() + 6) % 7,
  };
}

/** Epoch ms of local midnight + `hours` on a local date in `tz`. */
function localTime(date: { y: number; m: number; d: number }, hours: number, tz: string): number {
  const guess = Date.UTC(date.y, date.m, date.d) + hours * HOUR;
  return guess - tzOffset(guess, tz);
}

type Persona = {
  personId: string;
  projects: readonly string[];
  agents: Weighted<AgentKind>;
  start: number;
  maxParallel: number;
  nightOwl: number;
  diligence: number;
};

function persona(i: number, rand: () => number): Persona {
  const p = personAt(i);
  const agents: Weighted<AgentKind> =
    i % 4 === 3
      ? [
          ["codex", 60],
          ["claude", 35],
          ["pi", 5],
        ]
      : i % 5 === 4
        ? [
            ["pi", 45],
            ["claude", 50],
            ["unknown", 5],
          ]
        : [
            ["claude", 82],
            ["codex", 10],
            ["pi", 6],
            ["unknown", 2],
          ];
  return {
    personId: personIdFromName(p.name),
    projects: p.projects,
    agents,
    start: 8 + rand() * 2.5,
    maxParallel: 1 + Math.floor(rand() * 4),
    nightOwl: i === 2 || i === 6 ? 0.35 : 0.06,
    diligence: 0.75 + rand() * 0.2,
  };
}

export function generateWeek(opts: BackfillOptions = {}): HistoryRow[] {
  const rand = seededRandom(`backfill:${opts.seed ?? 42}`);
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 7;
  const tz = opts.timezone ?? "Europe/Vienna";
  const people = Array.from({ length: opts.people ?? 10 }, (_, i) => persona(i, rand));
  const rows: HistoryRow[] = [];

  const block = (p: Persona, from: number, to: number, intensity: number) => {
    const end = Math.min(to, now - MIN);
    if (end - from < 10 * MIN) return;
    rows.push({ ts: from, type: "person.joined", person: p.personId });
    const active: number[] = [];
    let t = from + Math.floor(rand() * 5 * MIN);
    let lastEnd = from;
    while (t < end - 5 * MIN) {
      for (let k = active.length - 1; k >= 0; k--) if (active[k]! <= t) active.splice(k, 1);
      const hour = ((t + tzOffset(t, tz)) % (24 * HOUR)) / HOUR;
      const lunch = hour >= 12 && hour < 13 && rand() < 0.75;
      if (!lunch && active.length < p.maxParallel) {
        const agent = weighted(rand, p.agents);
        const project = p.projects[Math.floor(rand() * p.projects.length)]!;
        const dur = Math.min(end - t, (8 + rand() * 110) * MIN);
        const sEnd = t + dur;
        rows.push({ ts: t, type: "session.started", person: p.personId, agent, project, subagents: 0 });
        if (agent === "claude" && rand() < 0.35) {
          const k = rand() < 0.15 ? 8 : 1 + Math.floor(rand() * 5);
          const burst = t + dur * (0.1 + rand() * 0.4);
          for (let n = 1; n <= k; n++)
            rows.push({
              ts: Math.round(burst + n * 4_000),
              type: "subagent.spawned",
              person: p.personId,
              agent,
              project,
              subagents: n,
            });
          const fin = burst + k * 4_000 + (2 + rand() * 10) * MIN;
          for (let n = k - 1; n >= 0; n--)
            rows.push({
              ts: Math.round(Math.min(sEnd - 1_000, fin + (k - n) * 20_000)),
              type: "subagent.finished",
              person: p.personId,
              agent,
              project,
              subagents: n,
            });
        }
        rows.push({ ts: Math.round(sEnd), type: "session.ended", person: p.personId, agent, project, subagents: 0 });
        active.push(sEnd);
        lastEnd = Math.max(lastEnd, sEnd);
      }
      t += (3 + rand() * 40 * intensity) * MIN;
    }
    rows.push({ ts: Math.round(Math.max(lastEnd, end) + MIN), type: "person.left", person: p.personId });
  };

  for (let d = days - 1; d >= 0; d--) {
    const date = localDate(now - d * 24 * HOUR, tz);
    const weekend = date.weekday >= 5;
    for (const p of people) {
      if (rand() < (weekend ? 0.15 : p.diligence)) {
        const start = weekend ? 11 + rand() * 6 : p.start + (rand() - 0.5);
        const length = weekend ? 1 + rand() * 2.5 : 7 + rand() * 2.5;
        const from = localTime(date, start, tz);
        if (from < now) block(p, from, from + length * HOUR, weekend ? 1.5 : 1);
      }
      if (rand() < p.nightOwl * (weekend ? 1.5 : 1)) {
        const from = localTime(date, 21 + rand() * 2, tz);
        if (from < now) block(p, from, from + (1 + rand() * 2.5) * HOUR, 0.8);
      }
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows.map((r) => HistoryRow.parse(r));
}

/** POST rows to /api/history/backfill in chunks. Returns the number inserted. */
export async function postBackfill(
  http: string,
  password: string,
  rows: HistoryRow[],
  chunk = 5_000,
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const res = await fetch(`${http}/api/history/backfill`, {
      method: "POST",
      headers: { authorization: `Bearer ${password}`, "content-type": "application/json" },
      body: JSON.stringify(rows.slice(i, i + chunk)),
    });
    if (!res.ok) throw new Error(`backfill failed: ${res.status} ${await res.text()}`);
    inserted += ((await res.json()) as { inserted: number }).inserted;
  }
  return inserted;
}
