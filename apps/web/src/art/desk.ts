/**
 * Desk pod pieces: desk, monitor (animated screen states), office chair, desk props,
 * desk mess, floor nameplates and the main door.
 */
import type { DeskProp } from "@agent-office/protocol";
import { Rectangle, Texture } from "pixi.js";
import { drawText, fitText, measureText } from "./font.ts";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";

function sheet(pc: PixelCanvas, fw: number, fh: number, n: number): Texture[] {
  const base = Texture.from(pc.toCanvas());
  return Array.from(
    { length: n },
    (_, i) => new Texture({ source: base.source, frame: new Rectangle(i * fw, 0, fw, fh) }),
  );
}

const deskTex = new Map<number, Texture>();
/** wx28 desk (w = 32, 26 or 24), placed with its top-left at (x - 1, tileY*16 + 3). */
export function deskTexture(w = 32): Texture {
  const hit = deskTex.get(w);
  if (hit) return hit;
  const pc = new PixelCanvas(w + 2, 30);
  pc.at(1, 1);
  pc.rect(0, 0, w, 13, C.sand);
  pc.hline(0, 0, w, C.cream);
  pc.rect(0, 13, w, 9, C.tan);
  pc.hline(0, 13, w, C.wood);
  const dw = Math.round(w / 3);
  pc.rect(w - dw - 2, 15, dw, 5, C.wood);
  pc.hline(w - dw + 1, 17, dw - 6, C.sand);
  pc.rect(1, 22, 3, 6, C.bark);
  pc.rect(w - 4, 22, 3, 6, C.bark);
  pc.hline(4, 22, w - 8, C.bark);
  // keyboard + mouse
  const kx = Math.round(w / 2) - 7;
  pc.rect(kx, 8, 13, 3, C.silver);
  pc.hline(kx + 1, 9, 11, C.white);
  if (w >= 30) pc.rect(kx + 15, 8, 2, 3, C.silver);
  pc.at(0, 0);
  pc.outline();
  const t = Texture.from(pc.toCanvas());
  deskTex.set(w, t);
  return t;
}

export const MONITOR = {
  off: [0],
  code: [1, 2],
  run: [3, 11, 4, 12],
  wait: [5, 6],
  idle: [7, 8],
  read: [9, 9, 9, 13, 14, 10, 10, 10, 13, 14],
  think: [1, 2, 1, 2, 15, 16, 15, 16, 17, 17],
} as const;
/** Screen frames per second by state (running scrolls fast, reading flips pages). */
export const MONITOR_FPS: Record<MonitorState, number> = {
  off: 1,
  code: 2,
  run: 6,
  wait: 2,
  idle: 2,
  read: 3,
  think: 2,
};
export type MonitorState = keyof typeof MONITOR;
let monitorFrames: Texture[] | null = null;
/** 18x16 monitor frames (+2 px pad). */
export function monitorTextures(): Texture[] {
  if (monitorFrames) return monitorFrames;
  const fw = 20;
  const fh = 18;
  const n = 18;
  const pc = new PixelCanvas(fw * n, fh);
  for (let i = 0; i < n; i++) {
    pc.at(i * fw + 1, 1);
    pc.rect(0, 0, 18, 12, C.ink);
    pc.rect(7, 12, 4, 2, C.slate);
    pc.rect(4, 14, 10, 2, C.slate);
    pc.hline(4, 14, 10, C.grey);
    const sx = 2;
    const sy = 2;
    const sw = 14;
    const sh = 8;
    const lines = (bg: string, cols: string[], shift: number) => {
      pc.rect(sx, sy, sw, sh, bg);
      for (let r = 0; r < 4; r++) {
        const len = [9, 5, 11, 7, 4, 10][(r + shift) % 6]!;
        const ind = [0, 2, 2, 0, 4, 2][(r + shift) % 6]!;
        pc.hline(
          sx + 1 + ind,
          sy + 1 + r * 2,
          Math.min(len, sw - 2 - ind),
          cols[(r + shift) % cols.length]!,
        );
      }
    };
    switch (i) {
      case 0:
        pc.rect(sx, sy, sw, sh, C.night);
        pc.set(sx + 1, sy + 1, C.dusk);
        pc.set(sx + 2, sy + 1, C.dusk);
        pc.set(sx + 1, sy + 2, C.dusk);
        break;
      case 1:
      case 2:
        lines(C.navy, [C.cyan, C.lemon, C.white, C.pink], i - 1);
        break;
      case 3:
      case 4:
      case 11:
      case 12: {
        // terminal output scrolling up one row per frame
        const shift = i < 11 ? i - 3 : i - 9;
        lines(C.pine, [C.leaf, C.lemon, C.leaf], shift);
        pc.set(sx + 12, sy + 7, shift % 2 === 0 ? C.white : C.leaf);
        break;
      }
      case 13:
      case 14: {
        // page turning: the right page lifts and swings over
        pc.rect(sx, sy, sw, sh, C.cream);
        pc.vline(sx + 7, sy, sh, C.tan);
        for (let r = 0; r < 4; r++) pc.hline(sx + 1, sy + 1 + r * 2, 5, C.grey);
        if (i === 13) {
          pc.rect(sx + 8, sy, 4, sh - 1, C.white);
          pc.vline(sx + 12, sy + 1, sh - 2, C.silver);
        } else {
          pc.rect(sx + 5, sy, 3, sh - 1, C.white);
          pc.vline(sx + 4, sy + 1, sh - 2, C.silver);
          for (let r = 0; r < 4; r++) pc.hline(sx + 9, sy + 1 + r * 2, 4, C.grey);
        }
        break;
      }
      case 15:
      case 16: {
        // a little turning gear
        pc.rect(sx, sy, sw, sh, C.navy);
        const gx = sx + 5;
        const gy = sy + 2;
        pc.rect(gx, gy, 4, 4, C.silver);
        pc.set(gx + 1, gy + 1, C.navy);
        pc.set(gx + 2, gy + 2, C.navy);
        pc.set(gx + 1, gy + 2, C.navy);
        pc.set(gx + 2, gy + 1, C.navy);
        if (i === 15) {
          pc.hline(gx + 1, gy - 1, 2, C.silver);
          pc.hline(gx + 1, gy + 4, 2, C.silver);
          pc.vline(gx - 1, gy + 1, 2, C.silver);
          pc.vline(gx + 4, gy + 1, 2, C.silver);
        } else {
          pc.set(gx - 1, gy - 1, C.silver);
          pc.set(gx + 4, gy - 1, C.silver);
          pc.set(gx - 1, gy + 4, C.silver);
          pc.set(gx + 4, gy + 4, C.silver);
        }
        pc.hline(sx + 1, sy + 7, 3, C.cyan);
        break;
      }
      case 17:
        // thought cloud
        pc.rect(sx, sy, sw, sh, C.navy);
        pc.round(sx + 4, sy + 1, 8, 4, C.white);
        pc.set(sx + 3, sy + 5, C.white);
        pc.set(sx + 2, sy + 6, C.white);
        pc.set(sx + 7, sy + 2, C.lemon);
        break;
      case 5:
      case 6:
        pc.rect(sx, sy, sw, sh, C.navy);
        pc.hline(sx + 1, sy + 1, 8, C.grey);
        pc.set(sx + 1, sy + 5, C.amber);
        if (i === 5) pc.rect(sx + 3, sy + 5, 2, 1, C.white);
        break;
      case 7:
      case 8:
        pc.rect(sx, sy, sw, sh, C.night);
        pc.set(sx + (i === 7 ? 3 : 9), sy + (i === 7 ? 2 : 5), C.lemon);
        pc.set(sx + (i === 7 ? 10 : 5), sy + (i === 7 ? 6 : 3), C.cyan);
        break;
      case 9:
      case 10:
        pc.rect(sx, sy, sw, sh, C.cream);
        for (let r = 0; r < 4; r++)
          pc.hline(sx + 2, sy + 1 + r * 2, 10 - ((r + i) % 3) * 2, C.grey);
        break;
    }
    pc.at(0, 0);
    pc.outline(i * fw, 0, fw, fh);
  }
  monitorFrames = sheet(pc, fw, fh, n);
  return monitorFrames;
}

let chairTex: Texture | null = null;
/** 14x11 office chair seen from behind (+1 px pad): low backrest so the jacket shows. */
export function chairTexture(): Texture {
  if (chairTex) return chairTex;
  const pc = new PixelCanvas(16, 13);
  pc.at(1, 1);
  pc.round(1, 0, 12, 5, C.dusk);
  pc.hline(2, 0, 10, C.slate);
  pc.set(1, 1, C.slate);
  pc.rect(0, 4, 14, 2, C.ink);
  pc.rect(6, 6, 2, 2, C.ink);
  pc.hline(2, 8, 10, C.ink);
  pc.set(2, 9, C.slate);
  pc.set(11, 9, C.slate);
  pc.set(6, 9, C.slate);
  pc.at(0, 0);
  pc.outline();
  chairTex = Texture.from(pc.toCanvas());
  return chairTex;
}

const PROP_ART: Record<DeskProp, (pc: PixelCanvas) => void> = {
  plant(pc) {
    pc.rect(2, 6, 4, 4, C.clay);
    pc.ellipse(0, 0, 8, 7, C.moss);
    pc.ellipse(1, 0, 5, 4, C.leaf);
  },
  mug(pc) {
    pc.rect(1, 4, 4, 5, C.white);
    pc.rect(5, 5, 2, 2, C.white);
    pc.set(6, 6, C.night);
    pc.hline(2, 4, 2, C.bark);
    pc.set(2, 2, C.silver);
    pc.set(3, 1, C.silver);
  },
  "rubber-duck": (pc) => {
    pc.rect(1, 5, 6, 4, C.lemon);
    pc.rect(3, 2, 3, 3, C.lemon);
    pc.set(6, 3, C.orange);
    pc.set(7, 3, C.orange);
    pc.set(4, 3, C.night);
    pc.hline(1, 8, 6, C.amber);
  },
  figurine(pc) {
    pc.rect(2, 2, 4, 3, C.silver);
    pc.set(3, 3, C.neon);
    pc.set(4, 3, C.neon);
    pc.rect(2, 5, 4, 3, C.sky);
    pc.rect(1, 8, 6, 1, C.ink);
    pc.set(4, 1, C.red);
  },
  lamp(pc) {
    pc.hline(1, 9, 5, C.ink);
    pc.vline(3, 4, 5, C.ink);
    pc.rect(3, 1, 4, 3, C.ink);
    pc.hline(4, 3, 3, C.lemon);
  },
  books(pc) {
    pc.rect(0, 7, 8, 2, C.red);
    pc.rect(1, 5, 7, 2, C.sky);
    pc.rect(0, 3, 7, 2, C.moss);
    pc.vline(7, 3, 2, C.cream);
    pc.vline(0, 5, 2, C.cream);
  },
  cactus(pc) {
    pc.rect(2, 7, 4, 3, C.clay);
    pc.rect(3, 1, 2, 6, C.moss);
    pc.vline(3, 1, 6, C.leaf);
    pc.rect(1, 3, 1, 2, C.moss);
    pc.rect(6, 2, 1, 3, C.moss);
    pc.set(4, 0, C.pink);
  },
  "cat-photo": (pc) => {
    pc.rect(0, 2, 7, 7, C.bark);
    pc.rect(1, 3, 5, 5, C.sky);
    pc.rect(2, 5, 3, 3, C.orange);
    pc.set(2, 4, C.orange);
    pc.set(4, 4, C.orange);
    pc.set(3, 9, C.bark);
  },
};

const propCache = new Map<string, Texture>();
/** ~8x10 desk prop, bottom-aligned (+1 px pad). */
export function propTexture(prop: DeskProp): Texture {
  const hit = propCache.get(prop);
  if (hit) return hit;
  const pc = new PixelCanvas(10, 12);
  pc.at(1, 1);
  PROP_ART[prop](pc);
  pc.at(0, 0);
  pc.outline();
  const t = Texture.from(pc.toCanvas());
  propCache.set(prop, t);
  return t;
}

let messTex: Texture[] | null = null;
/** Desk mess bits: paper, crumpled ball, snack wrapper, sticky note. */
export function messTextures(): Texture[] {
  if (messTex) return messTex;
  const pc = new PixelCanvas(32, 8);
  pc.rect(0, 1, 6, 5, C.white);
  pc.hline(1, 2, 4, C.grey);
  pc.hline(1, 4, 3, C.grey);
  pc.rect(9, 3, 3, 3, C.silver);
  pc.set(10, 3, C.white);
  pc.rect(16, 3, 5, 3, C.red);
  pc.set(16, 4, C.lemon);
  pc.rect(25, 2, 4, 4, C.lemon);
  pc.set(26, 3, C.amber);
  const base = Texture.from(pc.toCanvas());
  messTex = [0, 8, 15, 24].map(
    (x) => new Texture({ source: base.source, frame: new Rectangle(x, 0, 8, 8) }),
  );
  return messTex;
}

/** Floor nameplate under a pod: a little wooden sign with the name. */
export function nameplateTexture(name: string, accent: string): Texture {
  const text = fitText(name, 90);
  const tw = measureText(text);
  const w = tw + 12;
  const pc = new PixelCanvas(w + 2, 12);
  pc.at(1, 1);
  pc.round(0, 0, w, 9, C.bark);
  pc.round(0, 0, w, 8, C.wood);
  pc.hline(1, 0, w - 2, C.tan);
  pc.rect(3, 3, 2, 2, accent);
  drawText(pc, 7, 2, text, C.cream);
  pc.at(0, 0);
  pc.outline();
  return Texture.from(pc.toCanvas());
}

let doorFrames: Texture[] | null = null;
/** Main door (32x16), 4 frames from closed to open. */
export function doorTextures(): Texture[] {
  if (doorFrames) return doorFrames;
  const fw = 32;
  const fh = 18;
  const pc = new PixelCanvas(fw * 4, fh);
  for (let f = 0; f < 4; f++) {
    pc.at(f * fw, 0);
    pc.rect(0, 0, 32, 18, C.ink);
    pc.rect(1, 2, 30, 14, C.slate);
    const slide = f * 4;
    // left panel slides into the wall on the left, right panel to the right
    const lw = 14 - slide;
    if (lw > 0) pc.rect(2, 3, lw, 12, C.sky);
    if (lw > 0) pc.rect(30 - lw, 3, lw, 12, C.sky);
    if (lw > 2) {
      pc.vline(3, 4, 6, C.cyan);
      pc.vline(4, 4, 3, C.white);
      pc.vline(31 - lw, 4, 6, C.cyan);
      pc.vline(32 - lw, 4, 3, C.white);
    }
    if (f === 0) pc.vline(16, 3, 12, C.ink);
    pc.rect(1, 2, 1, 14, C.ink);
    pc.rect(30, 2, 1, 14, C.ink);
    pc.hline(0, 0, 32, C.dusk);
    pc.hline(0, 17, 32, C.night);
  }
  pc.at(0, 0);
  doorFrames = sheet(pc, fw, fh, 4);
  return doorFrames;
}
