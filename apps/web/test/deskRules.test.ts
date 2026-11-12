import { describe, expect, test } from "bun:test";
import {
  CLAIM_AFTER_MS,
  type DeskSeat,
  deskSwaps,
  preferMover,
  SWAP_COOLDOWN_MS,
  seatingOrder,
  stateSince,
  YIELD_AFTER_MS,
} from "../src/state/deskRules.ts";

const NOW = 1_000_000;
const MAX = 6;
const seat = (
  id: string,
  desk: number,
  idle: boolean,
  agoMs: number,
  extra: Partial<DeskSeat> = {},
) => ({ id, desk, idle, since: NOW - agoMs, movable: true, ...extra }) satisfies DeskSeat;
/** six desks: d0..d5 working for a minute, except the ones listed as idle */
const pod = (idle: Record<number, number> = {}) =>
  [0, 1, 2, 3, 4, 5].map((d) =>
    d in idle ? seat(`d${d}`, d, true, idle[d]!) : seat(`d${d}`, d, false, 60_000),
  );

describe("deskSwaps", () => {
  test("a working roamer takes the desk of the session idle longest", () => {
    const seats = [...pod({ 1: 60_000, 4: 600_000 }), seat("r", 6, false, 10_000)];
    expect(deskSwaps(seats, NOW, MAX)).toEqual([{ taker: "r", yielder: "d4" }]);
  });

  test("nothing moves while every desk holder works, or the roamer is idle too", () => {
    expect(deskSwaps([...pod(), seat("r", 6, false, 60_000)], NOW, MAX)).toEqual([]);
    expect(deskSwaps([...pod({ 2: 60_000 }), seat("r", 6, true, 60_000)], NOW, MAX)).toEqual([]);
  });

  test("hysteresis: both states have to hold for a few seconds", () => {
    const fresh = [...pod({ 2: 60_000 }), seat("r", 6, false, CLAIM_AFTER_MS - 1)];
    expect(deskSwaps(fresh, NOW, MAX)).toEqual([]);
    const ready = [...pod({ 2: 60_000 }), seat("r", 6, false, CLAIM_AFTER_MS)];
    expect(deskSwaps(ready, NOW, MAX)).toEqual([{ taker: "r", yielder: "d2" }]);
    const justIdle = [...pod({ 2: YIELD_AFTER_MS - 1 }), seat("r", 6, false, 60_000)];
    expect(deskSwaps(justIdle, NOW, MAX)).toEqual([]);
  });

  test("no swapping straight back: both sides sit out a cooldown", () => {
    // r just took d2's desk; d2 (now roaming at 6) is working again, r is idle again
    const after = [
      ...pod().filter((s) => s.desk !== 2),
      seat("r", 2, true, 20_000, { swappedAt: NOW - 20_000 }),
      seat("d2", 6, false, 20_000, { swappedAt: NOW - 20_000 }),
    ];
    expect(deskSwaps(after, NOW, MAX)).toEqual([]);
    expect(deskSwaps(after, NOW - 20_000 + SWAP_COOLDOWN_MS, MAX)).toEqual([
      { taker: "d2", yielder: "r" },
    ]);
  });

  test("several roamers: longest working gets the longest idle desk, pairs until one side runs out", () => {
    const seats = [
      ...pod({ 0: 300_000, 3: 900_000 }),
      seat("r6", 6, false, 10_000),
      seat("r7", 7, false, 90_000),
      seat("r8", 8, false, 30_000),
    ];
    expect(deskSwaps(seats, NOW, MAX)).toEqual([
      { taker: "r7", yielder: "d3" },
      { taker: "r8", yielder: "d0" },
    ]);
  });

  test("ties: the earlier roamer claims first, the far end of the pod yields first", () => {
    const seats = [
      ...pod({ 1: 60_000, 5: 60_000 }),
      seat("r9", 9, false, 9_000),
      seat("r7", 7, false, 9_000),
    ];
    expect(deskSwaps(seats, NOW, MAX)[0]).toEqual({ taker: "r7", yielder: "d5" });
  });

  test("sessions that can't move right now take no part", () => {
    const leaving = [
      ...pod({ 2: 60_000 }).map((s) => ({ ...s, movable: s.desk !== 2 })),
      seat("r", 6, false, 60_000),
    ];
    expect(deskSwaps(leaving, NOW, MAX)).toEqual([]);
    const offline = [...pod({ 2: 60_000 }), seat("r", 6, false, 60_000, { movable: false })];
    expect(deskSwaps(offline, NOW, MAX)).toEqual([]);
  });
});

describe("stateSince", () => {
  test("start of the trailing idle or working run", () => {
    const log = [
      { activity: "typing" as const, at: 1 },
      { activity: "idle" as const, at: 5 },
      { activity: "reading" as const, at: 9 },
      { activity: "running" as const, at: 12 },
      { activity: "typing" as const, at: 20 },
    ];
    expect(stateSince(log, 0)).toBe(9);
    expect(stateSince([...log, { activity: "idle", at: 30 }], 0)).toBe(30);
    expect(stateSince(log.slice(0, 2), 0)).toBe(5);
    expect(stateSince([], 42)).toBe(42);
  });
});

describe("seatingOrder", () => {
  const working = (s: string) => s.startsWith("w");
  test("keeps the incoming order when everything fits", () => {
    expect(seatingOrder(["i1", "w1", "i2"], 6, working)).toEqual(["i1", "w1", "i2"]);
  });
  test("working ones get the free desks when they don't all fit", () => {
    expect(seatingOrder(["i1", "i2", "w1", "i3", "w2"], 3, working)).toEqual([
      "i1",
      "w1",
      "w2",
      "i2",
      "i3",
    ]);
    expect(seatingOrder(["i1", "w1", "w2"], 0, working)).toEqual(["i1", "w1", "w2"]);
    expect(seatingOrder(["w1", "w2", "w3", "i1"], 2, working)).toEqual(["w1", "w2", "w3", "i1"]);
  });
});

describe("preferMover", () => {
  const m = (desk: number, working: boolean) => ({ desk, working });
  test("highest desk moves into a gap, but a working roamer beats an idle one", () => {
    expect(preferMover(undefined, m(3, false), MAX)).toEqual(m(3, false));
    expect(preferMover(m(3, true), m(5, false), MAX)).toEqual(m(5, false));
    expect(preferMover(m(5, true), m(7, false), MAX)).toEqual(m(7, false));
    expect(preferMover(m(6, true), m(8, false), MAX)).toEqual(m(6, true));
    expect(preferMover(m(8, false), m(6, true), MAX)).toEqual(m(6, true));
    expect(preferMover(m(6, true), m(8, true), MAX)).toEqual(m(8, true));
  });
});
