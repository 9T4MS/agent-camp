/**
 * A* on the walkable tile grid, 8 directions without cutting corners.
 * Returns the tile path including start and goal, or null when unreachable.
 */
import type { Point } from "./map.ts";

export type Grid = { width: number; height: number; isWalkable(x: number, y: number): boolean };

const DIRS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
] as const;

class MinHeap {
  private items: number[] = [];
  private prio: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: number, p: number) {
    const a = this.items;
    const pr = this.prio;
    a.push(item);
    pr.push(p);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pr[parent]! <= pr[i]!) break;
      [a[parent], a[i]] = [a[i]!, a[parent]!];
      [pr[parent], pr[i]] = [pr[i]!, pr[parent]!];
      i = parent;
    }
  }
  pop(): number {
    const a = this.items;
    const pr = this.prio;
    const top = a[0]!;
    const lastItem = a.pop()!;
    const lastP = pr.pop()!;
    if (a.length > 0) {
      a[0] = lastItem;
      pr[0] = lastP;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && pr[l]! < pr[m]!) m = l;
        if (r < a.length && pr[r]! < pr[m]!) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        [pr[m], pr[i]] = [pr[i]!, pr[m]!];
        i = m;
      }
    }
    return top;
  }
}

export function findPath(grid: Grid, from: Point, to: Point): Point[] | null {
  const { width, height } = grid;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  if (!inside(from.x, from.y) || !inside(to.x, to.y)) return null;
  // start/goal may be non-walkable (e.g. a seat); allow them explicitly
  const goal = to.y * width + to.x;
  const start = from.y * width + from.x;
  const ok = (x: number, y: number) =>
    inside(x, y) && (grid.isWalkable(x, y) || y * width + x === goal || y * width + x === start);
  const g = new Float64Array(width * height).fill(Number.POSITIVE_INFINITY);
  const came = new Int32Array(width * height).fill(-1);
  const closed = new Uint8Array(width * height);
  const h = (i: number) => {
    const dx = Math.abs((i % width) - to.x);
    const dy = Math.abs(Math.floor(i / width) - to.y);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  const open = new MinHeap();
  g[start] = 0;
  open.push(start, h(start));
  while (open.size > 0) {
    const cur = open.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % width;
    const cy = Math.floor(cur / width);
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!ok(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!ok(cx + dx, cy) || !ok(cx, cy + dy))) continue;
      const ni = ny * width + nx;
      const ng = g[cur]! + cost;
      if (ng < g[ni]!) {
        g[ni] = ng;
        came[ni] = cur;
        open.push(ni, ng + h(ni));
      }
    }
  }
  if (goal !== start && came[goal] === -1) return null;
  const path: Point[] = [];
  for (let i = goal; i !== -1; i = i === start ? -1 : came[i]!) {
    path.push({ x: i % width, y: Math.floor(i / width) });
  }
  return path.reverse();
}

/** Pixel path (tile centers, feet height) from one pixel point to another, ending exactly there. */
export function findPathPx(
  grid: Grid,
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number }[] | null {
  const tiles = findPath(
    grid,
    { x: Math.floor(from.x / 16), y: Math.floor((from.y - 4) / 16) },
    { x: Math.floor(to.x / 16), y: Math.floor((to.y - 4) / 16) },
  );
  if (!tiles) return null;
  const out = tiles.slice(1).map((t) => ({ x: t.x * 16 + 8, y: t.y * 16 + 13 }));
  out.push({ x: to.x, y: to.y });
  return out;
}
