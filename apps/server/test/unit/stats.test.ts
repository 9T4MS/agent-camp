import { describe, expect, test } from "bun:test";
import { type HistoryRow, StatsResponse } from "@agent-office/protocol";
import { computeStats, historyToCsv, makeLocalizer } from "../../src/core/stats.ts";

// 2026-11-09 is a Monday. 08:00 UTC = 09:00 in Vienna (CET).
const MON_0800Z = Date.UTC(2026, 10, 9, 8, 0, 0);
const H = 3_600_000;

const row = (
  ts: number,
  type: string,
  person: string,
  over: Partial<HistoryRow> = {},
): HistoryRow => ({
  ts,
  type,
  person,
  agent: null,
  project: null,
  subagents: null,
  ...over,
});

describe("stats", () => {
  test("localizer uses the office time zone", () => {
    expect(makeLocalizer("Europe/Vienna")(MON_0800Z)).toEqual({ weekday: 0, hour: 9 });
    expect(makeLocalizer("UTC")(MON_0800Z)).toEqual({ weekday: 0, hour: 8 });
    // Sunday 23:30 UTC = Monday 00:30 Vienna
    expect(makeLocalizer("Europe/Vienna")(MON_0800Z - 8.5 * H)).toEqual({ weekday: 0, hour: 0 });
    expect(makeLocalizer("UTC")(MON_0800Z - 8.5 * H)).toEqual({ weekday: 6, hour: 23 });
    // bad zone falls back to UTC
    expect(makeLocalizer("Not/AZone")(MON_0800Z)).toEqual({ weekday: 0, hour: 8 });
  });

  test("heatmap, leaderboards, split, parallel sweep", () => {
    const rows: HistoryRow[] = [
      row(MON_0800Z, "session.started", "anna", { agent: "claude", project: "office" }),
      row(MON_0800Z + 1, "session.started", "anna", { agent: "claude", project: "office" }),
      row(MON_0800Z + 2, "session.started", "anna", { agent: "codex", project: "web" }),
      row(MON_0800Z + 3, "subagent.spawned", "anna", { subagents: 1 }),
      row(MON_0800Z + 4, "subagent.spawned", "anna", { subagents: 2 }),
      row(MON_0800Z + 5, "session.ended", "anna"),
      row(MON_0800Z + 6, "session.ended", "anna"),
      row(MON_0800Z + 7, "session.started", "anna", { agent: "claude" }), // back to 2 running
      row(MON_0800Z + 24 * H, "session.started", "bob", { agent: "pi", project: "office" }),
      row(MON_0800Z + 24 * H + 1, "subagent.spawned", "bob", { subagents: 1 }),
      row(MON_0800Z + 24 * H + 2, "person.left", "bob"),
      row(MON_0800Z + 24 * H + 3, "session.started", "bob", { agent: "pi" }),
    ];
    const st = computeStats(rows, { timezone: "Europe/Vienna", now: 5, names: { anna: "Anna" } });
    expect(StatsResponse.safeParse(st).success).toBe(true);
    expect(st.totalSessions).toBe(6);
    expect(st.totalSubagents).toBe(3);
    expect(st.heatmap[0]![9]).toBe(4); // Monday 09h Vienna
    expect(st.heatmap[1]![9]).toBe(2); // Tuesday
    expect(st.heatmap.flat().reduce((a, b) => a + b, 0)).toBe(6);
    expect(st.agentSplit).toEqual({ claude: 3, codex: 1, pi: 2, unknown: 0 });
    expect(st.leaderboards.mostSessions).toEqual([
      { key: "anna", value: 4 },
      { key: "bob", value: 2 },
    ]);
    expect(st.leaderboards.mostParallel).toEqual([
      { key: "anna", value: 3 },
      { key: "bob", value: 1 },
    ]);
    expect(st.leaderboards.mostSubagents[0]).toEqual({ key: "anna", value: 2 });
    expect(st.leaderboards.busiestProjects).toEqual([
      { key: "office", value: 3 },
      { key: "web", value: 1 },
    ]);
    expect(st.range).toEqual({ from: MON_0800Z, to: MON_0800Z + 24 * H + 3 });
    expect(st.names).toEqual({ anna: "Anna" });
  });

  test("empty history", () => {
    const st = computeStats([], { timezone: "UTC" });
    expect(st.range).toBeNull();
    expect(st.totalSessions).toBe(0);
    expect(st.heatmap).toHaveLength(7);
    expect(st.heatmap[0]).toHaveLength(24);
  });

  test("unsorted input and unmatched ends do not go negative", () => {
    const rows = [
      row(10, "session.started", "a"),
      row(1, "session.ended", "a"),
      row(5, "session.ended", "a"),
      row(20, "session.started", "a"),
    ];
    expect(computeStats(rows, { timezone: "UTC" }).leaderboards.mostParallel).toEqual([
      { key: "a", value: 2 },
    ]);
  });

  test("csv export escapes and keeps columns", () => {
    const csv = historyToCsv([
      row(0, "session.started", "anna", { agent: "claude", project: 'we,ird "p"', subagents: 0 }),
      row(1000, "person.left", "anna"),
    ]);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("ts,iso,type,person,agent,project,subagents");
    expect(lines[1]).toBe(
      '0,1970-01-01T00:00:00.000Z,session.started,anna,claude,"we,ird ""p""",0',
    );
    expect(lines[2]).toBe("1000,1970-01-01T00:00:01.000Z,person.left,anna,,,");
  });
});
