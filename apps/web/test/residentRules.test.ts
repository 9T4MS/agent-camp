import { describe, expect, test } from "bun:test";
import { seededRandom } from "@agent-office/protocol";
import { buildOfficeMap, HEAD_DESK, SALES_STAND, STOVE_SPOT } from "../src/world/map.ts";
import { findPath } from "../src/world/pathing.ts";
import { haggle, hourCrossed, lineSpots } from "../src/world/residentRules.ts";

const grid = (x0: number, y0: number, x1: number, y1: number) => ({
  isWalkable: (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1,
});

describe("hourly bow", () => {
  test("starts when the clock passes a full hour, not on load or within the hour", () => {
    expect(hourCrossed(null, 10.0)).toBe(false);
    expect(hourCrossed(9.999, 10.001)).toBe(true);
    expect(hourCrossed(23.999, 0.001)).toBe(true);
    expect(hourCrossed(10.2, 10.3)).toBe(false);
    expect(hourCrossed(10.3, 10.3)).toBe(false);
  });
  test("a clock that jumps (or runs backwards) does not start it", () => {
    expect(hourCrossed(9.5, 11.2)).toBe(false);
    expect(hourCrossed(10.001, 9.999)).toBe(false);
  });
});

describe("lines in front of the head desk", () => {
  test("each line runs straight down from its front, then bunches up", () => {
    const [a, b] = lineSpots(
      grid(0, 0, 9, 4),
      [
        { x: 2, y: 0 },
        { x: 4, y: 0 },
      ],
      [7, 3],
    );
    expect(a!.slice(0, 5)).toEqual([0, 1, 2, 3, 4].map((y) => ({ x: 2, y })));
    expect(a).toHaveLength(7);
    expect(b).toEqual([0, 1, 2].map((y) => ({ x: 4, y })));
    const all = [...a!, ...b!].map((p) => `${p.x},${p.y}`);
    expect(new Set(all).size).toBe(all.length);
  });
  test("a full office still gets a spot for everyone in the meeting room", () => {
    const map = buildOfficeMap(4);
    const fronts = [
      { x: HEAD_DESK.x, y: HEAD_DESK.y + 1 },
      { x: HEAD_DESK.x + 2, y: HEAD_DESK.y + 1 },
    ];
    const lines = lineSpots(map, fronts, [30, 30]);
    expect(lines.map((l) => l.length)).toEqual([30, 30]);
    for (const p of lines.flat()) expect(map.isWalkable(p.x, p.y)).toBe(true);
    const keys = lines.flat().map((p) => `${p.x},${p.y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("resident spots", () => {
  test("stove, head desk lines and both sides of the sales stand are reachable", () => {
    const map = buildOfficeMap(4);
    const street = { x: SALES_STAND.x - 1, y: map.spawn.y };
    for (const t of [
      STOVE_SPOT,
      { x: HEAD_DESK.x + 1, y: HEAD_DESK.y - 1 },
      { x: HEAD_DESK.x, y: HEAD_DESK.y + 1 },
      { x: HEAD_DESK.x + 2, y: HEAD_DESK.y + 1 },
      { x: SALES_STAND.x + 1, y: SALES_STAND.y - 1 },
      { x: SALES_STAND.x + 1, y: SALES_STAND.y + 1 },
    ]) {
      expect(map.isWalkable(t.x, t.y), `${t.x},${t.y}`).toBe(true);
      expect(findPath(map, map.spawn, t), `${t.x},${t.y}`).not.toBeNull();
      expect(findPath(map, street, t), `${t.x},${t.y} from the street`).not.toBeNull();
    }
  });
});

describe("haggling at the sales stand", () => {
  test("client opens, the seller pitches, sweetens and has the last word", () => {
    const rand = seededRandom("haggle");
    let deals = 0;
    for (let i = 0; i < 200; i++) {
      const h = haggle(rand);
      expect(h.lines.map((l) => l.who)).toEqual([
        "client",
        "seller",
        "client",
        "seller",
        "client",
        "seller",
      ]);
      for (const l of h.lines) expect(l.text).toMatch(/^[A-Z0-9 .,!?'%+]+$/);
      if (h.deal) deals++;
    }
    expect(deals).toBeGreaterThan(100);
    expect(deals).toBeLessThan(200);
  });
});
