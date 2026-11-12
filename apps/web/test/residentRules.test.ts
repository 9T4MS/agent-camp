import { describe, expect, test } from "bun:test";
import { seededRandom } from "@agent-office/protocol";
import { buildOfficeMap, CFO_DESK, HEAD_DESK, SALES_STAND, STOVE_SPOT } from "../src/world/map.ts";
import { findPath } from "../src/world/pathing.ts";
import {
  cfoCall,
  cfoOuting,
  cfoTalk,
  haggle,
  hourCrossed,
  lineSpots,
} from "../src/world/residentRules.ts";

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

describe("asking the CFO", () => {
  test("a dev asks for their contract; it's hard, takes time", () => {
    const rand = seededRandom("cfo");
    for (let i = 0; i < 200; i++) {
      const { lines } = cfoTalk(rand);
      expect(lines.map((l) => l.who)).toEqual(["dev", "cfo", "cfo", "dev"]);
      expect(lines[0]!.text).toMatch(/CONTRACT/);
      expect(lines[1]!.text).toMatch(/HARD|TRICKY|DIFFICULT/);
      expect(lines[2]!.text).toMatch(/TIME/);
      for (const l of lines) {
        expect(l.text).toMatch(/^[A-Z0-9 .,!?':]+$/);
        expect(l.text).not.toMatch(/KLIMA/);
      }
    }
  });
  test("he calls his colleague at WEKAO: dials, greets, two or three lines, goodbye", () => {
    const rand = seededRandom("wekao");
    for (let i = 0; i < 200; i++) {
      const lines = cfoCall(rand);
      expect(lines.length === 5 || lines.length === 6).toBe(true);
      expect(lines[0]).toBe("CALLING WEKAO...");
      expect(lines[1]).toMatch(/WEKAO|IT'S ME/);
      expect(new Set(lines.slice(2, -1)).size).toBe(lines.length - 3);
      for (const l of lines) expect(l).toMatch(/^[A-Z0-9 .,!?':]+$/);
    }
  });
  test("out of his office he asks about the wifi or lunch, someone answers, he has the last word", () => {
    const rand = seededRandom("outing");
    const answers = new Set<string>();
    const topics = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const o = cfoOuting(rand);
      topics.add(o.topic);
      expect(o.ask).toBe(
        o.topic === "wifi" ? "WHERE IS THE WIFI?!" : "ANYONE ORDERING LUNCH AT PHO HA NOI?!",
      );
      answers.add(o.answer);
      for (const t of [o.leave, o.ask, o.answer, o.thanks]) {
        expect(t).toMatch(/^[A-Z0-9 .,!?':]+$/);
        expect(t).not.toMatch(/THIS.*THAT/);
      }
    }
    expect([...topics].sort()).toEqual(["lunch", "wifi"]);
    expect(answers.size).toBeGreaterThan(3);
  });
  for (const rows of [4, 6]) {
    test(`his office is only reachable through its door (${rows} pod rows)`, () => {
      const map = buildOfficeMap(rows);
      const room = map.areas.find((a) => a.name === "cfo")!;
      const visit = map.pois.find((p) => p.id === "cfo")!;
      const inRoom = (t: { x: number; y: number }) =>
        t.x >= room.x && t.x < room.x + room.w && t.y >= room.y && t.y < room.y + room.h;
      expect(inRoom(visit.tile)).toBe(true);
      expect(visit.tile).toEqual({ x: CFO_DESK.x, y: CFO_DESK.y + 1 });
      expect(map.isWalkable(visit.tile.x, visit.tile.y)).toBe(true);
      expect(findPath(map, map.spawn, visit.tile)).not.toBeNull();
      // his chair behind the desk is free floor
      expect(map.isWalkable(CFO_DESK.x, CFO_DESK.y - 1)).toBe(true);
      // close the door: nobody gets in any more
      const door = [];
      for (let y = room.y; y < room.y + room.h; y++)
        if (map.isWalkable(room.x - 1, y)) door.push(y);
      expect(door).toEqual([25, 26]);
      for (const y of door) map.setWalkable(room.x - 1, y, false);
      expect(findPath(map, map.spawn, visit.tile)).toBeNull();
    });
  }
});
