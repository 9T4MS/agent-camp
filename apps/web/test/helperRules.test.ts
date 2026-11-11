import { describe, expect, test } from "bun:test";
import {
  BIG_SWARM,
  burstGap,
  ESCORT_ROW,
  errandSlots,
  escortRow,
  escortSpot,
  helperArea,
  MAX_BOTS,
  visibleHelpers,
} from "../src/world/helperRules.ts";
import { podAisle } from "../src/world/map.ts";

describe("helper swarm rules", () => {
  test("every helper gets its own sprite up to the kiosk cap, then a +N badge", () => {
    expect(MAX_BOTS).toBeGreaterThanOrEqual(30);
    expect(MAX_BOTS).toBeLessThanOrEqual(50);
    expect(visibleHelpers(0)).toEqual({ shown: 0, extra: 0 });
    expect(visibleHelpers(7)).toEqual({ shown: 7, extra: 0 });
    expect(visibleHelpers(100)).toEqual({ shown: MAX_BOTS, extra: 100 - MAX_BOTS });
    expect(visibleHelpers(MAX_BOTS)).toEqual({ shown: MAX_BOTS, extra: 0 });
    expect(visibleHelpers(MAX_BOTS + 100)).toEqual({ shown: MAX_BOTS, extra: 100 });
  });

  test("the roaming area grows with the swarm, up to the whole aisle", () => {
    const aisle = podAisle(0);
    const seat = { x: aisle.x + aisle.w / 2, y: aisle.y + 4 };
    const inside = (r: { x: number; y: number; w: number; h: number }) =>
      r.x >= aisle.x &&
      r.y >= aisle.y &&
      r.x + r.w <= aisle.x + aisle.w &&
      r.y + r.h <= aisle.y + aisle.h;
    const small = helperArea(aisle, seat, 1);
    const mid = helperArea(aisle, seat, 12);
    const full = helperArea(aisle, seat, BIG_SWARM);
    for (const r of [small, mid, full]) expect(inside(r)).toBe(true);
    expect(small.w).toBe(44);
    expect(mid.w).toBeGreaterThan(small.w);
    expect(full).toEqual(aisle);
    // a big swarm also takes the free tile beside the aisle and the strip below it
    expect(helperArea(aisle, seat, 50)).toEqual({
      x: aisle.x - 16,
      y: aisle.y,
      w: aisle.w + 32,
      h: aisle.h + 6,
    });
    expect(helperArea(aisle, seat, 5)).toEqual(helperArea(aisle, seat, 0));
  });

  test("more helpers run errands in a bigger swarm", () => {
    expect(errandSlots(0)).toBe(2);
    expect(errandSlots(5)).toBe(2);
    expect(errandSlots(50)).toBe(10);
  });

  test("escort rows grow with the swarm, 8 to 16 per row", () => {
    expect(escortRow(3)).toBe(ESCORT_ROW);
    expect(escortRow(40)).toBe(10);
    expect(escortRow(200)).toBe(16);
  });

  test("escort: rows of ESCORT_ROW, centred under the carried person", () => {
    const at = { x: 100, y: 50 };
    const spots = Array.from({ length: 20 }, (_, i) => escortSpot(at, i, 20));
    // the next row stands 3 px further down
    expect(spots[ESCORT_ROW]!.y - spots[0]!.y).toBe(3);
    const xs = spots.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBe((ESCORT_ROW - 1) * 5);
    // a full row is centred on the point
    const row0 = spots.slice(0, ESCORT_ROW).map((p) => p.x);
    expect((Math.min(...row0) + Math.max(...row0)) / 2).toBe(at.x);
    // the last, partial row too
    const last = spots.slice(2 * ESCORT_ROW).map((p) => p.x);
    expect((Math.min(...last) + Math.max(...last)) / 2).toBe(at.x);
  });

  test("a burst of 100 pops out within a few seconds, a single one quickly", () => {
    let t = 0;
    for (let q = 100; q > 0; q--) t += burstGap(q, 1);
    expect(t).toBeLessThan(10);
    expect(burstGap(1, 0.5)).toBeLessThanOrEqual(0.12);
  });
});
