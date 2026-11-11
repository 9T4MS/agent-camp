/**
 * Terrain: the whole map's floors and walls are painted once into one big canvas
 * (one texture, one sprite, zero per-frame cost). Walls are 3/4: a dark top cap plus
 * a front face (wallpaper above, wood wainscot below) with windows.
 */
import { hashString } from "@agent-office/protocol";
import { Texture } from "pixi.js";
import { type OfficeMap, podOrigin, type Terrain, TILE } from "../world/map.ts";
import { drawText } from "./font.ts";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";

const rnd = (x: number, y: number, salt = 0) => hashString(`${x},${y},${salt}`) / 4294967296;

type Painter = (pc: PixelCanvas, gx: number, gy: number, tx: number, ty: number) => void;

const each = (fn: (px: number, py: number, lx: number, ly: number) => void) => {
  for (let ly = 0; ly < TILE; ly++) for (let lx = 0; lx < TILE; lx++) fn(lx, ly, lx, ly);
};

const PAINT: Record<Terrain, Painter> = {
  wood(pc, gx, gy) {
    each((lx, ly) => {
      const px = gx + lx;
      const py = gy + ly;
      const row = Math.floor(py / 4);
      let c: string = C.tan;
      if (py % 4 === 3) c = C.wood;
      else if ((px + row * 11) % 28 === 0) c = C.wood;
      else if (py % 4 === 0 && rnd(px, py) < 0.25) c = C.sand;
      else if (rnd(px, py, 1) < 0.02) c = C.wood;
      pc.set(px, py, c);
    });
  },
  kitchen(pc, gx, gy) {
    each((lx, ly) => {
      const checker = (Math.floor(lx / 8) + Math.floor(ly / 8)) % 2 === 0;
      let c: string = checker ? C.cream : C.peach;
      if (lx % 8 === 7 || ly % 8 === 7) c = C.sand;
      pc.set(gx + lx, gy + ly, c);
    });
  },
  carpet(pc, gx, gy) {
    each((lx, ly) => {
      const px = gx + lx;
      const py = gy + ly;
      let c: string = C.forest;
      if ((px + py) % 8 === 0 && py % 4 === 0) c = C.moss;
      else if ((px - py + 1024) % 8 === 4 && py % 4 === 2) c = C.pine;
      pc.set(px, py, c);
    });
  },
  meeting(pc, gx, gy) {
    each((lx, ly) => {
      const px = gx + lx;
      const py = gy + ly;
      let c: string = C.dusk;
      if (px % 6 === 0 && py % 6 === 0) c = C.slate;
      else if (px % 6 === 3 && py % 6 === 3) c = C.ink;
      pc.set(px, py, c);
    });
  },
  game(pc, gx, gy) {
    each((lx, ly) => {
      const px = gx + lx;
      const py = gy + ly;
      const d = Math.abs((px % 16) - 8) + Math.abs((py % 16) - 8);
      let c: string = C.ink;
      if (d === 7) c = C.plum;
      else if (d === 0) c = C.berry;
      pc.set(px, py, c);
    });
  },
  grass(pc, gx, gy) {
    each((lx, ly) => {
      const px = gx + lx;
      const py = gy + ly;
      const r = rnd(px, py, 7);
      let c: string = C.moss;
      if (r < 0.07) c = C.leaf;
      else if (r < 0.1) c = C.forest;
      pc.set(px, py, c);
    });
    // tufts and the odd flower
    const r = rnd(gx, gy, 3);
    if (r < 0.5) {
      const x = gx + 3 + Math.floor(rnd(gx, gy, 4) * 9);
      const y = gy + 4 + Math.floor(rnd(gx, gy, 5) * 9);
      pc.set(x, y, C.leaf);
      pc.set(x + 2, y, C.leaf);
      pc.set(x + 1, y - 1, C.leaf);
    }
    if (r < 0.08) {
      const x = gx + 2 + Math.floor(rnd(gx, gy, 6) * 11);
      const y = gy + 2 + Math.floor(rnd(gx, gy, 8) * 11);
      pc.set(x, y, r < 0.04 ? C.white : C.lemon);
    }
  },
  path(pc, gx, gy) {
    each((lx, ly) => pc.set(gx + lx, gy + ly, C.moss));
    for (const [sx, sy] of [
      [0, 0],
      [8, 0],
      [0, 8],
      [8, 8],
    ] as const) {
      const ox = gx + sx + Math.floor(rnd(gx + sx, gy + sy) * 2);
      const oy = gy + sy + Math.floor(rnd(gx + sx, gy + sy, 2) * 2);
      pc.round(ox, oy, 7, 7, C.grey);
      pc.round(ox, oy, 7, 6, C.silver);
      pc.set(ox + 2, oy + 1, C.white);
    }
  },
  sidewalk(pc, gx, gy) {
    each((lx, ly) => {
      let c: string = C.grey;
      if (lx === 15 || ly === 15) c = C.slate;
      else if (lx === 0 || ly === 0) c = C.silver;
      pc.set(gx + lx, gy + ly, c);
    });
  },
  doorway(pc, gx, gy) {
    each((lx, ly) => pc.set(gx + lx, gy + ly, ly % 4 === 3 ? C.bark : C.wood));
  },
  door(pc, gx, gy) {
    each((lx, ly) => pc.set(gx + lx, gy + ly, C.slate));
  },
  water(pc, gx, gy) {
    each((lx, ly) => {
      const px = gx + lx;
      const py = gy + ly;
      let c: string = C.sky;
      if ((px * 3 + py * 7) % 23 === 0) c = C.cyan;
      else if ((px + py * 5) % 31 === 0) c = C.white;
      pc.set(px, py, c);
    });
  },
  hedge(pc, gx, gy) {
    each((lx, ly) => {
      const r = rnd(gx + lx, gy + ly, 9);
      pc.set(gx + lx, gy + ly, r < 0.3 ? C.pine : r < 0.8 ? C.forest : C.moss);
    });
  },
  wallTop(pc, gx, gy) {
    each((lx, ly) => pc.set(gx + lx, gy + ly, C.cocoa));
  },
  wallUpper(pc, gx, gy) {
    each((lx, ly) => {
      const c = lx % 8 === 2 || lx % 8 === 3 ? C.peach : C.cream;
      pc.set(gx + lx, gy + ly, ly === 0 ? C.sand : c);
    });
  },
  wallLower(pc, gx, gy) {
    each((lx, ly) => {
      let c: string = C.wood;
      if (ly === 0) c = C.tan;
      else if (ly === 1) c = C.bark;
      else if (lx % 8 === 0) c = C.bark;
      else if (lx % 8 === 1) c = C.tan;
      if (ly >= 13) c = ly === 13 ? C.cocoa : C.bark;
      pc.set(gx + lx, gy + ly, c);
    });
  },
  window(pc, gx, gy, tx, ty) {
    PAINT.wallUpper(pc, gx, gy, tx, ty);
  },
  wallFace(pc, gx, gy) {
    each((lx, ly) => {
      let c: string;
      if (ly < 8) c = lx % 8 === 2 || lx % 8 === 3 ? C.peach : C.cream;
      else if (ly === 8) c = C.tan;
      else if (ly >= 14) c = ly === 14 ? C.cocoa : C.bark;
      else c = lx % 8 === 0 ? C.bark : C.wood;
      pc.set(gx + lx, gy + ly, c);
    });
  },
};

const FLOOR_SHADOW: Partial<Record<Terrain, string>> = {
  wood: C.wood,
  kitchen: C.sand,
  carpet: C.pine,
  meeting: C.ink,
  game: C.night,
  doorway: C.bark,
};
const isWall = (t: Terrain | undefined) =>
  t === "wallTop" || t === "wallUpper" || t === "wallLower" || t === "window" || t === "wallFace";

/** Window rectangles (pixel coords) for the animated sky panes. */
export type WindowRect = { x: number; y: number; w: number; h: number };

function drawRug(pc: PixelCanvas, x: number, y: number, w: number, h: number) {
  pc.round(x, y, w, h, C.wine);
  pc.rect(x + 2, y + 2, w - 4, h - 4, C.cream);
  pc.rect(x + 4, y + 4, w - 8, h - 8, C.peach);
  for (let i = x + 6; i < x + w - 6; i += 6) {
    const cy = y + Math.floor(h / 2);
    pc.set(i, cy, C.red);
    pc.set(i + 1, cy - 1, C.red);
    pc.set(i + 1, cy + 1, C.red);
    pc.set(i + 2, cy, C.red);
  }
  for (let i = x + 1; i < x + w - 1; i += 2) {
    pc.set(i, y - 1, C.cream);
    pc.set(i, y + h, C.cream);
  }
}

export type TerrainArt = { texture: Texture; windows: WindowRect[]; canvas: HTMLCanvasElement };

export function renderTerrain(map: OfficeMap): TerrainArt {
  const W = map.width * TILE;
  const H = map.height * TILE;
  const pc = new PixelCanvas(W, H);
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      const t = map.terrainAt(tx, ty)!;
      PAINT[t](pc, tx * TILE, ty * TILE, tx, ty);
    }
  }
  // wall caps: light inner rim where the cap meets a face or floor
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      if (map.terrainAt(tx, ty) !== "wallTop") continue;
      const gx = tx * TILE;
      const gy = ty * TILE;
      const below = map.terrainAt(tx, ty + 1);
      const above = map.terrainAt(tx, ty - 1);
      if (!isWall(below) && below !== undefined) pc.hline(gx, gy + 15, 16, C.night);
      if (below === "wallUpper" || below === "window" || below === "wallFace") {
        pc.hline(gx, gy + 15, 16, C.bark);
      }
      if (above !== "wallTop") pc.hline(gx, gy, 16, C.bark);
      const left = map.terrainAt(tx - 1, ty);
      const right = map.terrainAt(tx + 1, ty);
      if (left !== undefined && !isWall(left)) pc.vline(gx, gy, 16, C.bark);
      if (right !== undefined && !isWall(right)) pc.vline(gx + 15, gy, 16, C.bark);
    }
  }
  // soft shadow on floors right below walls
  for (let ty = 1; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      const t = map.terrainAt(tx, ty)!;
      const sh = FLOOR_SHADOW[t];
      if (!sh) continue;
      const above = map.terrainAt(tx, ty - 1);
      if (isWall(above)) {
        pc.hline(tx * TILE, ty * TILE, 16, sh);
        for (let i = 0; i < 16; i += 2) pc.set(tx * TILE + i + (ty % 2), ty * TILE + 1, sh);
      }
      const left = map.terrainAt(tx - 1, ty);
      if (left === "wallTop") pc.vline(tx * TILE, ty * TILE, 16, sh);
    }
  }
  // windows: each "ww" pair spans the upper + lower face rows
  const windows: WindowRect[] = [];
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      if (map.terrainAt(tx, ty) !== "window" || map.terrainAt(tx - 1, ty) === "window") continue;
      const x = tx * TILE + 3;
      const y = ty * TILE + 3;
      const w = 26;
      const h = 22;
      pc.rect(x - 1, y - 1, w + 2, h + 3, C.bark);
      pc.rect(x, y, w, h, C.white);
      pc.rect(x - 2, y + h, w + 4, 2, C.cream);
      pc.hline(x - 2, y + h + 2, w + 4, C.tan);
      windows.push({ x: x + 1, y: y + 1, w: w - 2, h: h - 2 });
    }
  }
  // lounge rug + doormat + pod rugs
  for (const ob of map.objects) {
    if (ob.kind === "rug") drawRug(pc, ob.x * TILE + 4, ob.y * TILE + 4, 5 * TILE - 8, 3 * TILE - 8);
    if (ob.kind === "doormat") {
      const x = ob.x * TILE + 4;
      const y = ob.y * TILE + 4;
      pc.round(x, y, 24, 10, C.bark);
      pc.round(x + 1, y + 1, 22, 8, C.clay);
      drawText(pc, x + 7, y + 2, "HI!", C.cream);
    }
  }
  for (let pod = 0; pod < map.podRows * 3; pod++) {
    const o = podOrigin(pod);
    const x = o.x * TILE - 4;
    const y = o.y * TILE + 30;
    const w = 8 * TILE + 8;
    const h = 22;
    pc.round(x, y, w, h, C.wood);
    pc.round(x + 1, y + 1, w - 2, h - 2, C.sand);
    for (let i = x + 3; i < x + w - 3; i += 4) pc.set(i, y + 3, C.cream);
    for (let i = x + 5; i < x + w - 3; i += 4) pc.set(i, y + h - 4, C.tan);
  }
  const canvas = pc.toCanvas();
  return { texture: Texture.from(canvas), windows, canvas };
}

/** Sky panes for windows: day / dusk / night variants (cached by size). */
const paneCache = new Map<string, Texture>();
export function windowPane(kind: "day" | "dusk" | "night", w: number, h: number): Texture {
  const key = `${kind}:${w}x${h}`;
  const hit = paneCache.get(key);
  if (hit) return hit;
  const pc = new PixelCanvas(w, h);
  const bands =
    kind === "day"
      ? [C.sky, C.sky, C.cyan, C.cyan, C.white]
      : kind === "dusk"
        ? [C.plum, C.berry, C.pink, C.orange, C.amber]
        : [C.night, C.night, C.ink, C.ink, C.dusk];
  for (let y = 0; y < h; y++) {
    const b = bands[Math.min(bands.length - 1, Math.floor((y / h) * bands.length))]!;
    pc.hline(0, y, w, b);
  }
  if (kind === "day") {
    pc.round(3, 4, 8, 3, C.white);
    pc.round(5, 2, 5, 3, C.white);
    pc.round(15, 9, 6, 3, C.white);
  } else if (kind === "night") {
    pc.set(3, 3, C.white);
    pc.set(14, 6, C.white);
    pc.set(9, 11, C.silver);
    pc.set(19, 2, C.silver);
    pc.round(16, 2, 4, 4, C.cream);
  } else {
    pc.ellipse(8, h - 7, 8, 8, C.lemon);
  }
  // window cross bars
  pc.vline(Math.floor(w / 2), 0, h, C.white);
  pc.hline(0, Math.floor(h / 2), w, C.white);
  const t = Texture.from(pc.toCanvas());
  paneCache.set(key, t);
  return t;
}
