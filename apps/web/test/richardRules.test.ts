import { describe, expect, test } from "bun:test";
import { seededRandom } from "@agent-office/protocol";
import {
  buildOfficeMap,
  CABIN_DOOR,
  CABIN_HOSE,
  FOOTPRINTS,
  RACK_SPOT,
  SERVER_CABIN,
} from "../src/world/map.ts";
import { findPath } from "../src/world/pathing.ts";
import {
  expiredMess,
  FIRE_OUT,
  FIRE_START,
  jitter,
  MESS_MAX,
  MUTTER,
  messAlpha,
  POKED,
  pickRamTarget,
  RAM_ASKS,
  RAM_COMING,
  RAM_THANKS,
  ramSize,
} from "../src/world/richardRules.ts";

const target = (id: string, context: number) => ({ id, context, x: 0, y: 0 });

describe("who gets RAM", () => {
  test("nobody working: nobody asks", () => {
    expect(pickRamTarget([], Math.random)).toBeNull();
  });
  test("the fullest context window asks first", () => {
    const rand = seededRandom("ram");
    const all = [target("a", 0.2), target("b", 0.85), target("c", 0.6), target("d", 0)];
    for (let i = 0; i < 50; i++) expect(pickRamTarget(all, rand)?.id).toBe("b");
  });
  test("ties at the top and the no-hungry case are picked at random", () => {
    const rand = seededRandom("ram-tie");
    const tie = [target("a", 0.7), target("b", 0.7), target("c", 0.1)];
    const seen = new Set(Array.from({ length: 60 }, () => pickRamTarget(tie, rand)?.id));
    expect([...seen].sort()).toEqual(["a", "b"]);
    const calm = [target("x", 0.1), target("y", 0.2)];
    const any = new Set(Array.from({ length: 60 }, () => pickRamTarget(calm, rand)?.id));
    expect([...any].sort()).toEqual(["x", "y"]);
  });
  test("fuller windows get bigger sticks: 16, 32 or 64 GB", () => {
    const rand = seededRandom("ram-size");
    for (let i = 0; i < 100; i++) {
      expect([16, 32]).toContain(ramSize(0.1, rand));
      expect([32, 64]).toContain(ramSize(0.6, rand));
      expect(ramSize(0.9, rand)).toBe(64);
    }
  });
});

describe("timers", () => {
  test("jitter stays within ±25 % of the mean", () => {
    const rand = seededRandom("jitter");
    for (let i = 0; i < 200; i++) {
      const t = jitter(100, rand);
      expect(t).toBeGreaterThanOrEqual(75);
      expect(t).toBeLessThanOrEqual(125);
    }
  });
});

describe("mess", () => {
  const items = (borns: number[]) => borns.map((born) => ({ born }));
  test("pieces past their life go", () => {
    const list = items([0, 50, 100]);
    expect(expiredMess(list, 130, false, 6, 120)).toEqual([list[0]!]);
  });
  test("never more than the cap: dropping one more removes the oldest", () => {
    const list = items([1, 2, 3, 4, 5, 6]);
    expect(list).toHaveLength(MESS_MAX);
    expect(expiredMess(list, 10, false)).toEqual([]);
    expect(expiredMess(list, 10, true)).toEqual([list[0]!]);
  });
  test("fades out over the last 10 s", () => {
    expect(messAlpha(0, 120)).toBe(1);
    expect(messAlpha(110, 120)).toBe(1);
    expect(messAlpha(115, 120)).toBeCloseTo(0.5);
    expect(messAlpha(130, 120)).toBe(0);
  });
});

describe("Richard's spots", () => {
  test("cabin door, hose spot and rack are reachable from the street door and each other", () => {
    for (const rows of [4, 6]) {
      const map = buildOfficeMap(rows);
      for (const t of [CABIN_DOOR, CABIN_HOSE, RACK_SPOT]) {
        expect(map.isWalkable(t.x, t.y), `${t.x},${t.y}`).toBe(true);
        expect(findPath(map, map.spawn, t), `${t.x},${t.y}`).not.toBeNull();
        expect(findPath(map, CABIN_DOOR, t), `${t.x},${t.y} from the cabin`).not.toBeNull();
      }
    }
  });
  test("the door and hose spots are right in front of the cabin, the rack spot below the rack", () => {
    const fp = FOOTPRINTS.serverCabin;
    for (const t of [CABIN_DOOR, CABIN_HOSE]) {
      expect(t.y).toBe(SERVER_CABIN.y + fp.h);
      expect(t.x).toBeGreaterThanOrEqual(SERVER_CABIN.x);
      expect(t.x).toBeLessThan(SERVER_CABIN.x + fp.w);
    }
    const map = buildOfficeMap(4);
    const rack = map.objects.find((o) => o.kind === "serverRack")!;
    expect(RACK_SPOT).toEqual({ x: rack.x, y: rack.y + 1 });
    for (let y = SERVER_CABIN.y; y < SERVER_CABIN.y + fp.h; y++)
      for (let x = SERVER_CABIN.x; x < SERVER_CABIN.x + fp.w; x++)
        expect(map.isWalkable(x, y), `${x},${y}`).toBe(false);
  });
});

describe("lines", () => {
  test("everything he and the devs say fits the bubble font", () => {
    for (const l of [
      ...RAM_ASKS,
      ...RAM_COMING,
      ...RAM_THANKS,
      ...FIRE_START,
      ...FIRE_OUT,
      ...POKED,
      ...MUTTER,
    ]) {
      expect(l).toMatch(/^[A-Z0-9 .,!?'%+*]+$/);
    }
  });
});
