/** History rows -> /api/stats JSON and CSV export. Pure. */
import type { HistoryRow, LeaderboardEntry, StatsResponse } from "@agent-office/protocol";

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
  const agentSplit: Record<string, number> = { claude: 0, codex: 0, pi: 0, unknown: 0 };
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
