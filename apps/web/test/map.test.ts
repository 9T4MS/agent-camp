import { describe, expect, test } from "bun:test";
import {
  buildOfficeMap,
  chairTile,
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
});
