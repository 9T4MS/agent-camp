import { describe, expect, test } from "bun:test";
import { avatarFromSeed, envelope, type PersonView } from "@agent-office/protocol";
import { OfficeModel } from "../src/state/officeModel.ts";
import {
  fitScale,
  frameAt,
  frameEnds,
  GIF_MAX_H,
  GIF_MAX_W,
  thinFrames,
} from "../src/world/gifs.ts";

const GIF = "JIX9t2j0ZTN9S";

describe("gif timing", () => {
  test("frameEnds: tiny delays play like browsers (100 ms)", () => {
    expect(frameEnds([50, 0, 10, 20])).toEqual([50, 150, 250, 270]);
  });

  test("frameAt loops", () => {
    const ends = [100, 200, 300];
    expect(frameAt(ends, 0)).toBe(0);
    expect(frameAt(ends, 99)).toBe(0);
    expect(frameAt(ends, 100)).toBe(1);
    expect(frameAt(ends, 299)).toBe(2);
    expect(frameAt(ends, 300)).toBe(0);
    expect(frameAt(ends, 1_250)).toBe(0);
    expect(frameAt([], 500)).toBe(0);
  });

  test("thinFrames keeps every n-th frame and the loop length", () => {
    const ends = [100, 200, 300, 400, 500, 600];
    expect(thinFrames(ends, 10)).toEqual({ keep: [0, 1, 2, 3, 4, 5], ends });
    expect(thinFrames(ends, 3)).toEqual({ keep: [0, 2, 4], ends: [200, 400, 600] });
    expect(thinFrames(ends, 4)).toEqual({ keep: [0, 1, 3, 4], ends: [100, 300, 400, 600] });
    expect(thinFrames(ends, 0.5)).toEqual({ keep: [0], ends: [600] });
    // a 1000-frame GIF fits the budget and still loops in the same time
    const long = Array.from({ length: 1000 }, (_, i) => (i + 1) * 40);
    const t = thinFrames(long, 150.7);
    expect(t.keep.length).toBe(150);
    expect(t.ends.at(-1)).toBe(40_000);
    expect(t.ends.every((e, i) => i === 0 || e > t.ends[i - 1]!)).toBe(true);
  });

  test("fitScale keeps the aspect ratio inside the box", () => {
    const wide = fitScale(200, 100);
    expect(200 * wide).toBeCloseTo(GIF_MAX_W);
    expect(100 * wide).toBeLessThanOrEqual(GIF_MAX_H);
    const tall = fitScale(200, 400);
    expect(400 * tall).toBeCloseTo(GIF_MAX_H);
    expect(fitScale(0, 0)).toBe(1);
  });
});

describe("office model: head gif", () => {
  const anna = (gif?: string): PersonView => ({
    personId: "anna",
    name: "Anna",
    avatar: avatarFromSeed("anna"),
    sessions: [],
    joinedAt: 1,
    ...(gif ? { gif } : {}),
  });
  const snap = (p: PersonView) =>
    envelope("office.snapshot", { officeName: "Camp", serverTime: 10, people: [p] });

  test("snapshot, gif.updated and a later snapshot all keep it in sync", () => {
    const m = new OfficeModel(() => 10);
    m.apply(snap(anna(GIF)));
    expect(m.people.get("anna")?.gif).toBe(GIF);

    expect(m.apply(envelope("gif.updated", { personId: "anna" }))).toEqual([
      { kind: "gifChanged", personId: "anna" },
    ]);
    expect(m.people.get("anna")?.gif).toBeUndefined();
    // same value again: no change
    expect(m.apply(envelope("gif.updated", { personId: "anna" }))).toEqual([]);

    const changes = m.apply(snap(anna(GIF)));
    expect(changes).toContainEqual({ kind: "gifChanged", personId: "anna" });
    expect(m.people.get("anna")?.gif).toBe(GIF);
  });
});
