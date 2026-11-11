/** History rows -> /api/stats JSON and CSV export. Pure. */
import type {
  HistoryRow,
  LeaderboardEntry,
  PersonDayResponse,
  StatsResponse,
} from "@agent-office/protocol";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

/** Weekday (0 = Monday) and hour of `ts` in an IANA time zone. */
export function makeLocalizer(timeZone: string): (ts: number) => { weekday: number; hour: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "numeric",
      hourCycle: "h23",
    });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
      hour: "numeric",
      hourCycle: "h23",
    });
  }
  return (ts) => {
    let weekday = 0;
    let hour = 0;
    for (const part of fmt.formatToParts(new Date(ts))) {
      if (part.type === "weekday") weekday = WEEKDAY_INDEX[part.value] ?? 0;
      if (part.type === "hour") hour = Number.parseInt(part.value, 10) % 24;
    }
    return { weekday, hour };
  };
}

function top(counts: Map<string, number>, n: number): LeaderboardEntry[] {
  return [...counts.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
    .slice(0, n);
}

const inc = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

export type StatsOptions = {
  timezone: string;
  now?: number;
  names?: Record<string, string>;
  /** leaderboard length */
  limit?: number;
};

export function computeStats(rows: readonly HistoryRow[], opts: StatsOptions): StatsResponse {
  const local = makeLocalizer(opts.timezone);
  const limit = opts.limit ?? 5;
  const heatmap = WEEKDAYS.map(() => new Array<number>(24).fill(0));
  const sessions = new Map<string, number>();
  const subagents = new Map<string, number>();
  const projects = new Map<string, number>();
  const agentSplit: Record<string, number> = {
    claude: 0,
    codex: 0,
    pi: 0,
    design: 0,
    unknown: 0,
  };
  const running = new Map<string, number>();
  const parallel = new Map<string, number>();
  let totalSessions = 0;
  let totalSubagents = 0;

  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  for (const r of sorted) {
    switch (r.type) {
      case "session.started": {
        totalSessions++;
        inc(sessions, r.person);
        const { weekday, hour } = local(r.ts);
        heatmap[weekday]![hour]!++;
        const agent = r.agent ?? "unknown";
        agentSplit[agent] = (agentSplit[agent] ?? 0) + 1;
        if (r.project) inc(projects, r.project);
        const n = (running.get(r.person) ?? 0) + 1;
        running.set(r.person, n);
        if (n > (parallel.get(r.person) ?? 0)) parallel.set(r.person, n);
        break;
      }
      case "session.ended":
        running.set(r.person, Math.max(0, (running.get(r.person) ?? 0) - 1));
        break;
      case "person.left":
        // all of a person's sessions end before they leave; resync in case rows are missing
        running.set(r.person, 0);
        break;
      case "subagent.spawned":
        totalSubagents++;
        inc(subagents, r.person);
        break;
    }
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    generatedAt: opts.now ?? Date.now(),
    timezone: opts.timezone,
    range: first && last ? { from: first.ts, to: last.ts } : null,
    totalSessions,
    totalSubagents,
    heatmap,
    weekdays: [...WEEKDAYS],
    agentSplit,
    leaderboards: {
      mostSessions: top(sessions, limit),
      mostParallel: top(parallel, limit),
      mostSubagents: top(subagents, limit),
      busiestProjects: top(projects, limit),
    },
    names: opts.names ?? {},
  };
}

/** Midnight of `now`'s calendar day in an IANA time zone (epoch ms). Bad zone -> UTC. */
export function startOfDayIn(timeZone: string, now: number): number {
  let fmt: Intl.DateTimeFormat;
  const o: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  };
  try {
    fmt = new Intl.DateTimeFormat("en-US", { ...o, timeZone });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", { ...o, timeZone: "UTC" });
  }
  const parts = (ts: number) => {
    const v: Record<string, number> = {};
    for (const p of fmt.formatToParts(new Date(ts))) v[p.type] = Number(p.value);
    return v as { year: number; month: number; day: number; hour: number; minute: number };
  };
  const p = parts(now);
  // local wall clock as if it were UTC, minus the zone offset at that moment
  const offsetAt = (ts: number) => {
    const q = parts(ts) as ReturnType<typeof parts> & { second: number };
    return (
      Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) -
      Math.floor(ts / 1000) * 1000
    );
  };
  const midnightWall = Date.UTC(p.year, p.month - 1, p.day);
  let guess = midnightWall - offsetAt(now);
  // DST change between midnight and now: correct with the offset at the guess
  guess = midnightWall - offsetAt(guess);
  return guess;
}

export type PersonDayOptions = {
  timezone: string;
  now: number;
  name?: string | null;
  online?: boolean;
  /** sessions the person has running right now (floor for the parallel peak) */
  liveSessions?: number;
  recentActivity?: PersonDayResponse["recentActivity"];
};

/** One person's numbers for today. `rows` may span more than today; others are ignored. */
export function computePersonDay(
  rows: readonly HistoryRow[],
  personId: string,
  opts: PersonDayOptions,
): PersonDayResponse {
  const dayStart = startOfDayIn(opts.timezone, opts.now);
  let sessionsToday = 0;
  let subagentsToday = 0;
  let running = 0;
  let peak = opts.liveSessions ?? 0;
  const mine = rows.filter((r) => r.person === personId).sort((a, b) => a.ts - b.ts);
  for (const r of mine) {
    const today = r.ts >= dayStart && r.ts <= opts.now;
    switch (r.type) {
      case "session.started":
        running++;
        if (today) {
          sessionsToday++;
          peak = Math.max(peak, running);
          // helpers a session already had when it was first seen count too
          subagentsToday += r.subagents ?? 0;
        }
        break;
      case "session.ended":
        running = Math.max(0, running - 1);
        break;
      case "person.left":
        running = 0;
        break;
      case "subagent.spawned":
        if (today) subagentsToday++;
        break;
    }
  }
  return {
    personId,
    name: opts.name ?? null,
    timezone: opts.timezone,
    dayStart,
    generatedAt: opts.now,
    online: opts.online ?? false,
    sessionsToday,
    peakParallelToday: peak,
    subagentsToday,
    recentActivity: opts.recentActivity ?? {},
  };
}

export type OfficeDay = { started: number; peak: number; recent: number[] };

/** Whole office today: sessions started, most running at once, and a recent 5-min sampling. */
export function computeOfficeDay(
  rows: readonly HistoryRow[],
  opts: { timezone: string; now: number; liveSessions: number },
): OfficeDay {
  const dayStart = startOfDayIn(opts.timezone, opts.now);
  const STEP = 5 * 60_000;
  const marks = Array.from({ length: 8 }, (_, i) => opts.now - (7 - i) * STEP);
  const recent: number[] = [];
  const running = new Map<string, number>();
  let total = 0;
  let started = 0;
  let peak = opts.liveSessions;
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  let m = 0;
  const sampleUntil = (ts: number) => {
    while (m < marks.length && marks[m]! < ts) {
      recent.push(total);
      m++;
    }
  };
  for (const r of sorted) {
    if (r.ts > opts.now) break;
    sampleUntil(r.ts);
    const before = running.get(r.person) ?? 0;
    let after = before;
    if (r.type === "session.started") after = before + 1;
    else if (r.type === "session.ended") after = Math.max(0, before - 1);
    else if (r.type === "person.left") after = 0;
    else continue;
    running.set(r.person, after);
    total += after - before;
    if (r.type === "session.started" && r.ts >= dayStart) {
      started++;
      peak = Math.max(peak, total);
    }
  }
  sampleUntil(Number.POSITIVE_INFINITY);
  // the last mark is "now": what is live beats what history reconstructs
  recent[recent.length - 1] = opts.liveSessions;
  return { started, peak, recent };
}

const CSV_COLUMNS = ["ts", "iso", "type", "person", "agent", "project", "subagents"] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function historyToCsv(rows: readonly HistoryRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [r.ts, new Date(r.ts).toISOString(), r.type, r.person, r.agent, r.project, r.subagents]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
