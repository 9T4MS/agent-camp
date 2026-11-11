/**
 * Terrain: the whole map's floors and walls are painted once into one big canvas
 * (one texture, one sprite, zero per-frame cost). Walls are 3/4: a dark top cap plus
 * a front face (wallpaper above, wood wainscot below) with windows.
 */
import { hashString } from "@agent-office/protocol";
import { Texture } from "pixi.js";
import type { Weather } from "../world/lifeRules.ts";
import { type OfficeMap, type Terrain, TILE } from "../world/map.ts";
import { drawText } from "./font.ts";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";
import { artSeason, foliage, lawn } from "./seasons.ts";

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
  bar(pc, gx, gy) {
    // dark pub planks with brass nail heads
    each((lx, ly) => {
      const px = gx + lx;
      const py = gy + ly;
      const row = Math.floor(py / 5);
      let c: string = C.bark;
      if (py % 5 === 4) c = C.cocoa;
      else if ((px + row * 13) % 24 === 0) c = C.cocoa;
      else if ((px + row * 13) % 24 === 2 && py % 5 === 2) c = C.amber;
      else if (rnd(px, py, 12) < 0.05) c = C.wood;
      pc.set(px, py, c);
    });
  },
  shop(pc, gx, gy) {
    // pale green-and-cream tiles
    each((lx, ly) => {
      const checker = (Math.floor(lx / 8) + Math.floor(ly / 8)) % 2 === 0;
      let c: string = checker ? C.cream : C.leaf;
      if (lx % 8 === 7 || ly % 8 === 7) c = checker ? C.sand : C.moss;
      pc.set(gx + lx, gy + ly, c);
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
      pc.set(px, py, lawn(c, r));
    });
    if (artSeason() === "winter") return;
    // tufts and the odd flower
    const r = rnd(gx, gy, 3);
    if (r < 0.5) {
      const x = gx + 3 + Math.floor(rnd(gx, gy, 4) * 9);
      const y = gy + 4 + Math.floor(rnd(gx, gy, 5) * 9);
      pc.set(x, y, C.leaf);
      pc.set(x + 2, y, C.leaf);
      pc.set(x + 1, y - 1, C.leaf);
    }
    if (r < (artSeason() === "spring" ? 0.3 : 0.08)) {
      const x = gx + 2 + Math.floor(rnd(gx, gy, 6) * 11);
      const y = gy + 2 + Math.floor(rnd(gx, gy, 8) * 11);
      const spring = [C.pink, C.white, C.lemon, C.neon][Math.floor(rnd(gx, gy, 10) * 4)]!;
      pc.set(x, y, artSeason() === "spring" ? spring : r < 0.04 ? C.white : C.lemon);
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
      const top = artSeason() === "winter" && ly < 5 + Math.floor(rnd(gx + lx, gy, 11) * 3);
      pc.set(gx + lx, gy + ly, top ? C.white : r < 0.3 ? C.pine : r < 0.8 ? C.forest : C.moss);
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
  bar: C.cocoa,
  shop: C.moss,
  doorway: C.bark,
};
const isWall = (t: Terrain | undefined) =>
  t === "wallTop" || t === "wallUpper" || t === "wallLower" || t === "window" || t === "wallFace";

/** Window rectangles (pixel coords) for the animated sky panes. */
export type WindowRect = { x: number; y: number; w: number; h: number };

/** Rug color sets: border, band, field, motif. */
const RUGS = [
  [C.wine, C.cream, C.peach, C.red],
  [C.navy, C.sky, C.dusk, C.cyan],
  [C.pine, C.lemon, C.moss, C.amber],
  [C.plum, C.pink, C.berry, C.peach],
] as const;

function drawRug(pc: PixelCanvas, x: number, y: number, w: number, h: number, variant = 0) {
  const [border, band, field, motif] = RUGS[variant % RUGS.length]!;
  pc.round(x, y, w, h, border);
  pc.rect(x + 2, y + 2, w - 4, h - 4, band);
  pc.rect(x + 4, y + 4, w - 8, h - 8, field);
  for (let i = x + 6; i < x + w - 6; i += 6) {
    const cy = y + Math.floor(h / 2);
    pc.set(i, cy, motif);
    pc.set(i + 1, cy - 1, motif);
    pc.set(i + 1, cy + 1, motif);
    pc.set(i + 2, cy, motif);
  }
  for (let i = x + 1; i < x + w - 1; i += 2) {
    pc.set(i, y - 1, band);
    pc.set(i, y + h, band);
  }
}

const rugCache = new Map<string, Texture>();
/** A loose rug sprite (nooks between pods). The texture has a 1 px fringe margin. */
export function rugTexture(w: number, h: number, variant: number): Texture {
  const key = `${w}x${h}:${variant}`;
  const hit = rugCache.get(key);
  if (hit) return hit;
  const pc = new PixelCanvas(w, h + 2);
  drawRug(pc, 0, 1, w, h, variant);
  const t = Texture.from(pc.toCanvas());
  rugCache.set(key, t);
  return t;
}

/** Pod floor mats (under the chairs): one color pair per person. */
export const POD_MATS = [
  [C.wood, C.sand, C.cream, C.tan],
  [C.forest, C.moss, C.leaf, C.pine],
  [C.dusk, C.slate, C.grey, C.ink],
  [C.tan, C.peach, C.cream, C.tan],
  [C.cocoa, C.bark, C.wood, C.cocoa],
  [C.ink, C.dusk, C.slate, C.ink],
] as const;
const matCache = new Map<string, Texture>();
export function podMatTexture(w: number, variant: number): Texture {
  const key = `${w}:${variant}`;
  const hit = matCache.get(key);
  if (hit) return hit;
  const [edge, fill, dotA, dotB] = POD_MATS[variant % POD_MATS.length]!;
  const h = 22;
  const pc = new PixelCanvas(w, h);
  pc.round(0, 0, w, h, edge);
  pc.round(1, 1, w - 2, h - 2, fill);
  for (let i = 3; i < w - 3; i += 4) pc.set(i, 3, dotA);
  for (let i = 5; i < w - 3; i += 4) pc.set(i, h - 4, dotB);
  const t = Texture.from(pc.toCanvas());
  matCache.set(key, t);
  return t;
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
    if (ob.kind === "rug")
      drawRug(pc, ob.x * TILE + 4, ob.y * TILE + 4, 5 * TILE - 8, 3 * TILE - 8);
    if (ob.kind === "doormat") {
      const x = ob.x * TILE + 4;
      const y = ob.y * TILE + 4;
      pc.round(x, y, 24, 10, C.bark);
      pc.round(x + 1, y + 1, 22, 8, C.clay);
      drawText(pc, x + 7, y + 2, "HI!", C.cream);
    }
  }
  const canvas = pc.toCanvas();
  return { texture: Texture.from(canvas), windows, canvas };
}

/** Sky panes for windows: day / dusk / night variants (cached by size). */
const paneCache = new Map<string, Texture>();

export type { Weather };
/** Frames a weather animates through in the window panes. */
export const WEATHER_FRAMES: Record<Weather, number> = { sun: 1, clouds: 4, rain: 3, snow: 4 };

export function windowPane(
  kind: "day" | "dusk" | "night",
  w: number,
  h: number,
  weather: Weather = "sun",
  frame = 0,
): Texture {
  const key = `${kind}:${w}x${h}:${weather}:${frame}`;
  const hit = paneCache.get(key);
  if (hit) return hit;
  const pc = new PixelCanvas(w, h);
  const grey = weather !== "sun";
  const bands =
    kind === "day"
      ? grey
        ? weather === "rain" || weather === "snow"
          ? [C.slate, C.grey, C.grey, C.silver, C.silver]
          : [C.sky, C.silver, C.cyan, C.cyan, C.white]
        : [C.sky, C.sky, C.cyan, C.cyan, C.white]
      : kind === "dusk"
        ? grey
          ? [C.dusk, C.plum, C.berry, C.pink, C.pink]
          : [C.plum, C.berry, C.pink, C.orange, C.amber]
        : [C.night, C.night, C.ink, C.ink, C.dusk];
  for (let y = 0; y < h; y++) {
    const b = bands[Math.min(bands.length - 1, Math.floor((y / h) * bands.length))]!;
    pc.hline(0, y, w, b);
  }
  if (kind === "day" && weather === "sun") {
    pc.round(3, 4, 8, 3, C.white);
    pc.round(5, 2, 5, 3, C.white);
    pc.round(15, 9, 6, 3, C.white);
    pc.ellipse(w - 7, 1, 5, 5, C.lemon);
  } else if (kind === "night") {
    if (!grey) {
      pc.set(3, 3, C.white);
      pc.set(14, 6, C.white);
      pc.set(9, 11, C.silver);
      pc.set(19, 2, C.silver);
    }
    pc.round(16, 2, 4, 4, C.cream);
  } else if (kind === "dusk" && !grey) {
    pc.ellipse(8, h - 7, 8, 8, C.lemon);
  }
  if (grey) {
    // drifting clouds (wrap around the pane)
    const wet = weather === "rain" || weather === "snow";
    const cloud = wet ? (kind === "night" ? C.dusk : C.grey) : C.white;
    const shade = wet ? (kind === "night" ? C.ink : C.slate) : C.silver;
    const n = WEATHER_FRAMES[weather];
    for (const [cx, cy, cw] of [
      [2, 2, 10],
      [14, 6, 8],
    ] as const) {
      const x0 = (cx + Math.round((frame * w) / n / 2)) % w;
      for (const dx of [0, -w]) {
        pc.round(x0 + dx, cy + 1, cw, 3, shade);
        pc.round(x0 + dx, cy, cw, 3, cloud);
        pc.round(x0 + dx + 2, cy - 1, cw - 5, 2, cloud);
      }
    }
    if (weather === "rain") {
      for (let i = 0; i < 7; i++) {
        const x = (i * 7 + 3) % w;
        const y = (i * 5 + frame * 4) % h;
        pc.vline(x, y, 2, kind === "night" ? C.sky : C.cyan);
      }
    }
    if (weather === "snow") {
      for (let i = 0; i < 9; i++) {
        const x = (i * 7 + 3 + (frame % 2)) % w;
        const y = (i * 5 + frame * 2) % h;
        pc.set(x, y, C.white);
      }
    }
  }
  // window cross bars
  pc.vline(Math.floor(w / 2), 0, h, C.white);
  pc.hline(0, Math.floor(h / 2), w, C.white);
  const t = Texture.from(pc.toCanvas());
  paneCache.set(key, t);
  return t;
}

/** How far the outdoor surroundings reach past the map on every side (px). */
export const SURROUND = 12 * TILE;

export type SurroundPiece = { texture: Texture; x: number; y: number };

/**
 * The world outside the building: a darker lawn with round trees and a street below the
 * sidewalk, so zoom-to-fit letterboxes into scenery instead of a flat color. Four strips
 * around the map (no overdraw under the terrain sprite).
 */
export function renderSurround(map: OfficeMap): SurroundPiece[] {
  const W = map.width * TILE;
  const H = map.height * TILE;
  const M = SURROUND;
  const streetY = H + 10;
  const streetH = 44;
  const strips = [
    { x: -M, y: -M, w: W + 2 * M, h: M },
    { x: -M, y: H, w: W + 2 * M, h: M },
    { x: -M, y: 0, w: M, h: H },
    { x: W, y: 0, w: M, h: H },
  ];
  // trees on a jittered grid, kept off the street and away from the building
  const trees: { x: number; y: number; r: number; v: number }[] = [];
  for (let gy = -M; gy < H + M; gy += 56) {
    for (let gx = -M; gx < W + M; gx += 60) {
      const x = gx + Math.floor(rnd(gx, gy, 21) * 40);
      const y = gy + Math.floor(rnd(gx, gy, 22) * 36);
      const r = 9 + Math.floor(rnd(gx, gy, 23) * 7);
      const near = x > -r - 6 && x < W + r + 6 && y > -r - 10 && y < H + r + 10;
      const street = y > streetY - 14 && y < streetY + streetH + r + 6;
      if (near || street || rnd(gx, gy, 24) < 0.35) continue;
      trees.push({ x, y, r, v: Math.floor(rnd(gx, gy, 25) * 3) });
    }
  }
  return strips.map((st) => {
    const pc = new PixelCanvas(st.w, st.h);
    for (let y = 0; y < st.h; y++) {
      for (let x = 0; x < st.w; x++) {
        const wx = st.x + x;
        const wy = st.y + y;
        let c: string;
        if (wy >= streetY && wy < streetY + streetH) {
          const ly = wy - streetY;
          if (ly < 2) c = C.slate;
          else if (ly >= streetH - 2) c = C.slate;
          else if (Math.abs(ly - streetH / 2) < 1 && (wx & 31) < 16) c = C.lemon;
          else c = rnd(wx, wy, 26) < 0.04 ? C.dusk : C.ink;
        } else if (wy >= H && wy < streetY) {
          c = (wx & 15) === 15 || ((wy - H) & 15) === 9 ? C.slate : C.grey;
        } else {
          const r = rnd(wx, wy, 27);
          c = lawn(r < 0.06 ? C.moss : r < 0.12 ? C.pine : C.forest, r);
        }
        pc.set(x, y, c);
      }
    }
    pc.at(-st.x, -st.y);
    const winter = artSeason() === "winter";
    for (const t of trees) {
      pc.ellipse(t.x - t.r, t.y + t.r - 4, t.r * 2, 8, winter ? C.silver : C.pine);
      pc.rect(t.x - 2, t.y, 4, t.r, C.bark);
      const top = t.y - t.r - 6;
      if (winter) {
        // bare branches with a little snow on top
        pc.rect(t.x - 1, top + 4, 2, t.r + 2, C.bark);
        for (const [dx, dy, len] of [
          [-1, 6, -t.r + 2],
          [1, 3, t.r - 3],
          [-1, 11, -t.r + 4],
          [1, 9, t.r - 2],
        ] as const) {
          const n = Math.abs(len);
          for (let i = 0; i < n; i++) {
            const x = t.x + dx + Math.sign(len) * i;
            const y = top + dy - Math.floor(i / 2);
            pc.set(x, y, C.cocoa);
            if (i % 3 === 0) pc.set(x, y - 1, C.white);
          }
        }
        continue;
      }
      const f = foliage(t.v);
      const main = f?.mid ?? [C.moss, C.forest, C.leaf][t.v]!;
      pc.ellipse(t.x - t.r - 1, top - 1, t.r * 2 + 2, t.r * 2 + 2, C.night);
      pc.ellipse(t.x - t.r, top, t.r * 2, t.r * 2, f?.dark ?? (t.v === 1 ? C.pine : C.forest));
      pc.ellipse(t.x - t.r + 1, top, t.r * 2 - 3, t.r * 2 - 4, main);
      pc.ellipse(
        t.x - t.r / 2,
        top + 2,
        t.r,
        t.r - 2,
        f?.light ?? (t.v === 2 ? C.lemon : C.leaf),
        140,
      );
      if (f?.dot) {
        for (let i = 0; i < 5; i++) {
          const a = rnd(t.x, t.y, 30 + i) * Math.PI * 2;
          const d = rnd(t.x, t.y, 40 + i) * (t.r - 3);
          pc.set(Math.round(t.x + Math.cos(a) * d), Math.round(top + t.r + Math.sin(a) * d), f.dot);
        }
      }
    }
    pc.at(0, 0);
    return { texture: Texture.from(pc.toCanvas()), x: st.x, y: st.y };
  });
}
