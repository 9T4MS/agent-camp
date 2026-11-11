import { expect, test } from "bun:test";
import { HistoryRow } from "@agent-office/protocol";
import { generateWeek } from "../src/backfill.ts";

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0); // Wed afternoon

test("backfill rows validate, are sorted and stay in the past week", () => {
  const rows = generateWeek({ seed: 1, now: NOW });
  expect(rows.length).toBeGreaterThan(500);
  let prev = 0;
  for (const r of rows) {
    expect(HistoryRow.safeParse(r).success).toBe(true);
    expect(r.ts).toBeGreaterThanOrEqual(prev);
    expect(r.ts).toBeLessThanOrEqual(NOW);
    expect(r.ts).toBeGreaterThan(NOW - 9 * 86_400_000);
    prev = r.ts;
  }
});

test("backfill is deterministic per seed", () => {
  expect(generateWeek({ seed: 5, now: NOW })).toEqual(generateWeek({ seed: 5, now: NOW }));
  expect(generateWeek({ seed: 5, now: NOW })).not.toEqual(generateWeek({ seed: 6, now: NOW }));
});

test("backfill is weekday / working-hour heavy, with agents, projects and parallel sessions", () => {
  const rows = generateWeek({ seed: 2, now: NOW });
  const starts = rows.filter((r) => r.type === "session.started");
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Vienna",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  });
  let weekday = 0;
  let work = 0;
  let late = 0;
  for (const r of starts) {
    const parts = fmt.formatToParts(new Date(r.ts));
    const wd = parts.find((p) => p.type === "weekday")!.value;
    const h = Number(parts.find((p) => p.type === "hour")!.value);
    if (wd !== "Sat" && wd !== "Sun") weekday++;
    if (h >= 8 && h < 19) work++;
    if (h >= 21 || h < 3) late++;
  }
  expect(weekday / starts.length).toBeGreaterThan(0.75);
  expect(work / starts.length).toBeGreaterThan(0.7);
  expect(late).toBeGreaterThan(0);
  expect(new Set(starts.map((r) => r.agent)).size).toBeGreaterThanOrEqual(3);
  expect(new Set(starts.map((r) => r.project)).size).toBeGreaterThanOrEqual(5);
  // someone runs sessions in parallel
  const running = new Map<string, number>();
  let maxParallel = 0;
  for (const r of rows) {
    const n = running.get(r.person) ?? 0;
    if (r.type === "session.started") running.set(r.person, n + 1);
    if (r.type === "session.ended") running.set(r.person, n - 1);
    maxParallel = Math.max(maxParallel, running.get(r.person) ?? 0);
  }
  expect(maxParallel).toBeGreaterThanOrEqual(2);
  for (const n of running.values()) expect(n).toBe(0);
  expect(rows.some((r) => r.type === "subagent.spawned" && r.subagents === 8)).toBe(true);
});
