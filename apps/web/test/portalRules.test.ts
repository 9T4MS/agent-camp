import { describe, expect, test } from "bun:test";
import { seededRandom } from "@agent-office/protocol";
import { buildOfficeMap, OFFICE_COLS, TILE } from "../src/world/map.ts";
import {
  EXIT_RUN,
  entranceFor,
  exitFor,
  freeAt,
  indoorTile,
  LINE_UP,
  MIN_HOP,
  PORTAL_GAP,
} from "../src/world/portalRules.ts";

/** A walled box: walkable inside x0..x1, y0..y1 (tiles). */
function box(w: number, h: number, x0: number, y0: number, x1: number, y1: number) {
  return {
    width: w,
    height: h,
    isWalkable: (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1,
    terrainAt: () => "wood" as const,
  };
}

describe("portal rules", () => {
  test("the entrance opens straight ahead of the lead, on his row", () => {
    const map = box(20, 10, 1, 1, 18, 8);
    const lead = { x: 8 * TILE + 8, y: 4 * TILE + 12 };
    expect(entranceFor(map, lead, 1)).toEqual({ x: lead.x + PORTAL_GAP, y: lead.y });
    expect(entranceFor(map, lead, -1)).toEqual({ x: lead.x - PORTAL_GAP, y: lead.y });
  });

  test("no entrance into a wall, nor without room for the sidekick behind the lead", () => {
    const map = box(20, 10, 1, 1, 18, 8);
    const nearRight = { x: 17 * TILE + 8, y: 4 * TILE + 12 };
    expect(entranceFor(map, nearRight, 1)).toBeNull();
    const nearLeft = { x: 1 * TILE + 4, y: 4 * TILE + 12 };
    expect(nearLeft.x - LINE_UP).toBeLessThan(TILE);
    expect(entranceFor(map, nearLeft, 1)).toBeNull();
  });

  test("exits are far away and have a free runway in the walking direction", () => {
    const map = buildOfficeMap(4);
    const rand = seededRandom("exits");
    const from = { x: 20 * TILE + 8, y: 14 * TILE + 12 };
    for (const dir of [1, -1] as const) {
      for (let i = 0; i < 40; i++) {
        const b = exitFor(map, from, dir, rand);
        expect(b).not.toBeNull();
        if (!b) continue;
        expect(Math.hypot(b.x - from.x, b.y - from.y)).toBeGreaterThanOrEqual(MIN_HOP);
        for (let d = 0; d <= EXIT_RUN; d += 2) expect(freeAt(map, b.x + dir * d, b.y)).toBe(true);
      }
    }
  });

  test("no exit when nothing is walkable", () => {
    const solid = {
      width: 10,
      height: 10,
      isWalkable: () => false,
      terrainAt: () => "wood" as const,
    };
    expect(exitFor(solid, null, 1, seededRandom("x"))).toBeNull();
  });

  test("portals stay inside the office building: no garden, street, doorway or east block", () => {
    const map = buildOfficeMap(4);
    const rand = seededRandom("indoor");
    for (const dir of [1, -1] as const) {
      for (let i = 0; i < 200; i++) {
        const b = exitFor(map, null, dir, rand);
        expect(b).not.toBeNull();
        if (!b) continue;
        expect(b.x).toBeLessThan(OFFICE_COLS * TILE);
        for (let d = -6; d <= EXIT_RUN; d += 2) {
          const tx = Math.floor((b.x + dir * d) / TILE);
          const ty = Math.floor((b.y - 2) / TILE);
          expect(indoorTile(map, tx, ty)).toBe(true);
          expect(["wood", "kitchen", "carpet", "meeting", "game"]).toContain(
            map.terrainAt(tx, ty) ?? "none",
          );
        }
      }
    }
    // walkable outdoor floor is never a portal spot
    const garden = map.areas.find((a) => a.name === "garden")!;
    let outdoor = 0;
    for (let ty = garden.y; ty < garden.y + garden.h; ty++) {
      for (let tx = garden.x; tx < garden.x + garden.w; tx++) {
        if (!map.isWalkable(tx, ty)) continue;
        outdoor++;
        expect(indoorTile(map, tx, ty)).toBe(false);
        expect(entranceFor(map, { x: tx * TILE + 8, y: ty * TILE + 12 }, 1)).toBeNull();
      }
    }
    expect(outdoor).toBeGreaterThan(0);
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = OFFICE_COLS; tx < map.width; tx++) expect(indoorTile(map, tx, ty)).toBe(false);
    }
  });
});
