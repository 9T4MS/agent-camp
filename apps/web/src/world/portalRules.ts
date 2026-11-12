/**
 * Where the lead may open portals: pure geometry on the walk grid, so it is unit-tested.
 * Portals stand on the indoor office floor (never the garden, the street, a doorway or the
 * east street block); the characters always walk through them horizontally.
 */
import { OFFICE_COLS, type OfficeMap, type Point, type Terrain, TILE } from "./map.ts";

export type Walk = Pick<OfficeMap, "isWalkable" | "width" | "height" | "terrainAt">;

/** Floors inside the office building. */
const INDOOR: ReadonlySet<Terrain> = new Set(["wood", "kitchen", "carpet", "meeting", "game"]);

/** A walkable tile inside the office building (west of the east street block). */
export function indoorTile(map: Walk, tx: number, ty: number) {
  const t = map.terrainAt(tx, ty);
  return tx < OFFICE_COLS && !!t && INDOOR.has(t) && map.isWalkable(tx, ty);
}
export type Dir = 1 | -1;

/** the entrance opens this far in front of the lead */
export const PORTAL_GAP = 24;
/** the sidekick lines up this far behind the lead */
export const LINE_UP = 13;
/** free floor needed past the exit portal so both can step out */
export const EXIT_RUN = 34;
/** an exit is at least this far from the entrance */
export const MIN_HOP = 10 * TILE;

/** Free indoor floor at a feet position (feet a little above the bottom of the tile). */
export function freeAt(map: Walk, x: number, y: number) {
  return indoorTile(map, Math.floor(x / TILE), Math.floor((y - 2) / TILE));
}

function runFree(map: Walk, x: number, y: number, dir: Dir, from: number, to: number) {
  for (let d = from; d <= to; d += 4) if (!freeAt(map, x + dir * d, y)) return false;
  return freeAt(map, x + dir * to, y);
}

/** Entrance straight ahead of the lead in `dir`, with room for the sidekick; null if blocked. */
export function entranceFor(map: Walk, lead: Point, dir: Dir): Point | null {
  if (!runFree(map, lead.x, lead.y, dir, -LINE_UP, PORTAL_GAP + 6)) return null;
  return { x: lead.x + dir * PORTAL_GAP, y: lead.y };
}

/** A random exit far from `from` with a free runway in `dir` (tile-centered); null if none. */
export function exitFor(
  map: Walk,
  from: Point | null,
  dir: Dir,
  rand: () => number,
  minDist = MIN_HOP,
): Point | null {
  for (let tries = 0; tries < 120; tries++) {
    const tx = Math.floor(rand() * Math.min(map.width, OFFICE_COLS));
    const ty = Math.floor(rand() * map.height);
    const p = { x: tx * TILE + 8, y: ty * TILE + 12 };
    if (from && Math.hypot(p.x - from.x, p.y - from.y) < minDist) continue;
    if (runFree(map, p.x, p.y, dir, -6, EXIT_RUN)) return p;
  }
  return null;
}
