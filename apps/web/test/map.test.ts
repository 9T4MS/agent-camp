import { describe, expect, test } from "bun:test";
import {
  buildOfficeMap,
  chairTile,
  FOOTPRINTS,
  isBarPoi,
  isShopPoi,
  isSmokePoi,
  MAX_DESKS,
  nookLayout,
  POD_COLS,
  podBlockTiles,
  podRowsFor,
  setSlotBlocked,
} from "../src/world/map.ts";
import { findPath } from "../src/world/pathing.ts";

describe("office map", () => {
  for (const rows of [4, 6]) {
    test(`every desk and POI is reachable from the door, all pods full (${rows} pod rows)`, () => {
      const map = buildOfficeMap(rows);
      expect(map.rows.every((r) => r.length === map.width)).toBe(true);
      for (let pod = 0; pod < rows * POD_COLS; pod++)
        setSlotBlocked(map, pod, podBlockTiles(pod, MAX_DESKS));
      for (let pod = 0; pod < rows * POD_COLS; pod++) {
        for (let d = 0; d < MAX_DESKS; d++) {
          const chair = chairTile(pod, d, MAX_DESKS);
          expect(map.isWalkable(chair.x, chair.y)).toBe(true);
          expect(findPath(map, map.spawn, chair), `pod ${pod} desk ${d}`).not.toBeNull();
        }
      }
      for (const poi of map.pois) {
        expect(findPath(map, map.spawn, poi.tile), poi.id).not.toBeNull();
      }
    });
  }
  test("nooks between pods keep desks and their own POIs reachable", () => {
    const map = buildOfficeMap(4);
    for (let pod = 0; pod < 4 * POD_COLS; pod++) {
      if (pod % 2) setSlotBlocked(map, pod, nookLayout(pod).block);
      else setSlotBlocked(map, pod, podBlockTiles(pod, pod % 4 === 0 ? MAX_DESKS : 2));
    }
    for (let pod = 0; pod < 4 * POD_COLS; pod++) {
      if (pod % 2) {
        for (const poi of nookLayout(pod).pois)
          expect(findPath(map, map.spawn, poi.tile), poi.id).not.toBeNull();
      } else {
        const n = pod % 4 === 0 ? MAX_DESKS : 2;
        for (let d = 0; d < n; d++)
          expect(findPath(map, map.spawn, chairTile(pod, d, n))).not.toBeNull();
      }
    }
    for (const poi of map.pois) expect(findPath(map, map.spawn, poi.tile), poi.id).not.toBeNull();
  });
  test("pod rows grow with people", () => {
    expect(podRowsFor(0)).toBe(4);
    expect(podRowsFor(12)).toBe(4);
    expect(podRowsFor(13)).toBe(5);
    expect(buildOfficeMap(5).height).toBe(buildOfficeMap(4).height + 6);
  });
  test("pathing avoids walls and returns null when blocked", () => {
    const grid = { width: 3, height: 3, isWalkable: (x: number, y: number) => !(x === 1 && y < 2) };
    const p = findPath(grid, { x: 0, y: 0 }, { x: 2, y: 0 })!;
    expect(p[0]).toEqual({ x: 0, y: 0 });
    expect(p.at(-1)).toEqual({ x: 2, y: 0 });
    expect(p.some((t) => t.x === 1 && t.y < 2)).toBe(false);
    const wall = { width: 3, height: 3, isWalkable: (x: number) => x !== 1 };
    expect(findPath(wall, { x: 0, y: 0 }, { x: 2, y: 2 })).toBeNull();
  });
  describe("east street block (bar, weed shop, smokers' corner)", () => {
    for (const rows of [4, 6]) {
      test(`bar, shop and corner spots sit in their areas and are reachable (${rows} pod rows)`, () => {
        const map = buildOfficeMap(rows);
        expect(map.width).toBe(80);
        const area = (n: string) => map.areas.find((a) => a.name === n)!;
        const inside = (n: string, t: { x: number; y: number }) => {
          const a = area(n);
          return t.x >= a.x && t.x < a.x + a.w && t.y >= a.y && t.y < a.y + a.h;
        };
        const bar = map.pois.filter(isBarPoi);
        const shop = map.pois.filter(isShopPoi);
        const smoke = map.pois.filter(isSmokePoi);
        expect(bar.map((p) => p.id)).toContain("tap");
        expect(shop.map((p) => p.id)).toContain("shop-counter");
        expect(smoke.length).toBeGreaterThanOrEqual(2);
        for (const p of bar) expect(inside("bar", p.tile), p.id).toBe(true);
        for (const p of [...shop, ...smoke]) expect(inside("shop", p.tile), p.id).toBe(true);
        for (const p of [...bar, ...shop, ...smoke]) {
          expect(map.isWalkable(p.tile.x, p.tile.y), p.id).toBe(true);
          expect(findPath(map, map.spawn, p.tile), p.id).not.toBeNull();
        }
        // the smokers' corner never shifts when the desk floor grows
        expect(smoke.map((p) => p.tile)).toEqual(
          buildOfficeMap(4)
            .pois.filter(isSmokePoi)
            .map((p) => p.tile),
        );
      });
    }
    test("the bar is reachable through the garden gate, not only along the street", () => {
      const map = buildOfficeMap(4);
      // close the sidewalk below the street block: the hedge gate (x 63, y 7..8) remains
      for (let x = 51; x < map.width; x++) map.setWalkable(x, map.height - 1, false);
      const tap = map.pois.find((p) => p.id === "tap")!;
      expect(findPath(map, { x: 49, y: 7 }, tap.tile)).not.toBeNull();
      expect(map.terrainAt(63, 7)).toBe("path");
      expect(map.terrainAt(63, 6)).toBe("hedge");
    });
    test("every new object has a footprint inside the street block", () => {
      const map = buildOfficeMap(4);
      const east = map.objects.filter((o) => o.x >= 64);
      expect(east.length).toBeGreaterThan(15);
      for (const o of east) expect(o.x + FOOTPRINTS[o.kind].w, o.kind).toBeLessThanOrEqual(79);
    });
  });
});
