import { describe, expect, test } from "bun:test";
import type { SnapshotMeta } from "../../../packages/protocol/src/api.ts";
import {
  ALL_DAYS,
  filterFrames,
  normalizeDay,
  PRELOAD_FRAME_LIMIT,
  preloadFrames,
  selectedFrameIndex,
  sortFrames,
} from "../src/state/timelapseFrames.ts";

const frame = (id: number, ts = id): SnapshotMeta => ({ id, ts, size: 100, url: `/frame/${id}` });

describe("timelapseFrames", () => {
  test("sorts by timestamp then numeric id without mutating the response", () => {
    const frames = [frame(10, 2), frame(2, 2), frame(3, 1), frame(1, 2)];
    expect(sortFrames(frames).map((f) => f.id)).toEqual([3, 1, 2, 10]);
    expect(frames.map((f) => f.id)).toEqual([10, 2, 3, 1]);
  });

  test("All retains every frame; invalid days fall back to All", () => {
    const frames = [frame(1), frame(2)];
    for (const day of [ALL_DAYS, "", "nope", "2024-02-30", "2024-13-01", "2024-1-01"]) {
      expect(normalizeDay(day)).toBe(ALL_DAYS);
      expect(filterFrames(frames, day)).toEqual(frames);
    }
    expect(normalizeDay(null)).toBe(ALL_DAYS);
    expect(normalizeDay("2024-02-29")).toBe("2024-02-29");
  });

  test("empty, no-match, one-frame and selection preservation", () => {
    expect(filterFrames([], ALL_DAYS)).toEqual([]);
    expect(selectedFrameIndex([])).toBe(-1);
    const frames = [frame(1), frame(2), frame(3)];
    expect(filterFrames(frames, "2024-01-01")).toEqual([]);
    expect(selectedFrameIndex(frames)).toBe(2);
    expect(selectedFrameIndex(frames, 2)).toBe(1);
    expect(selectedFrameIndex(frames, 99)).toBe(2);
    expect(selectedFrameIndex([frame(2)], 2)).toBe(0);
    expect(preloadFrames([frame(2)], 0)).toEqual([frame(2)]);
  });

  test("preload stays bounded to current/next, including endpoints", () => {
    const frames = Array.from({ length: 100 }, (_, i) => frame(i));
    for (let index = 0; index < frames.length; index++) {
      const window = preloadFrames(frames, index);
      expect(window.length).toBeLessThanOrEqual(PRELOAD_FRAME_LIMIT);
      expect(window[0]).toBe(frames[index]);
      expect(window).toEqual(frames.slice(index, Math.min(index + 3, frames.length)));
    }
    expect(preloadFrames(frames, 99)).toEqual([frame(99)]);
    for (const index of [-1, 100, 0.5, Number.NaN])
      expect(preloadFrames(frames, index)).toEqual([]);
    expect(preloadFrames([], 0)).toEqual([]);
  });

  // Separate processes make TZ explicit without mutating the test runner's global zone.
  for (const fixture of [
    {
      tz: "Europe/Vienna",
      day: "2024-03-31",
      stamps: [
        "2024-03-30T22:59:59Z",
        "2024-03-30T23:00:00Z",
        "2024-03-31T00:59:59Z",
        "2024-03-31T01:00:00Z",
        "2024-03-31T21:59:59Z",
        "2024-03-31T22:00:00Z",
      ],
      days: ["2024-03-30", "2024-03-31", "2024-03-31", "2024-03-31", "2024-03-31", "2024-04-01"],
    },
    {
      tz: "America/New_York",
      day: "2024-11-03",
      stamps: [
        "2024-11-03T03:59:59Z",
        "2024-11-03T04:00:00Z",
        "2024-11-03T05:30:00Z",
        "2024-11-03T06:30:00Z",
        "2024-11-04T04:59:59Z",
        "2024-11-04T05:00:00Z",
      ],
      days: ["2024-11-02", "2024-11-03", "2024-11-03", "2024-11-03", "2024-11-03", "2024-11-04"],
    },
    {
      tz: "UTC",
      day: "2024-03-31",
      stamps: [
        "2024-03-30T23:59:59Z",
        "2024-03-31T00:00:00Z",
        "2024-03-31T23:59:59Z",
        "2024-04-01T00:00:00Z",
      ],
      days: ["2024-03-30", "2024-03-31", "2024-03-31", "2024-04-01"],
    },
  ]) {
    test(`local calendar boundaries and DST in ${fixture.tz}`, () => {
      const helper = new URL("../src/state/timelapseFrames.ts", import.meta.url).pathname;
      const result = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `
        import { localDayKey, filterFrames } from ${JSON.stringify(helper)};
        const frames = ${JSON.stringify(fixture.stamps)}.map((ts, id) => ({id, ts: Date.parse(ts)}));
        console.log(JSON.stringify({days: frames.map(f => localDayKey(f.ts)), ids: filterFrames(frames, ${JSON.stringify(fixture.day)}).map(f => f.id)}));
      `,
        ],
        { env: { ...process.env, TZ: fixture.tz } },
      );
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.toString());
      expect(output.days).toEqual(fixture.days);
      expect(output.ids).toEqual(
        fixture.days.flatMap((day, i) => (day === fixture.day ? [i] : [])),
      );
    });
  }
});
