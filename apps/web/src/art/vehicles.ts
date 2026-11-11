/**
 * Outdoor art: the little car on the street, the lunch food truck, forest eyes and the
 * werewolf, weather particles (snowflake, petal, leaf) and soft cloud shadows.
 * Drawn in code and cached once, facing right (flip with scale.x = -1).
 */
import { Rectangle, Texture } from "pixi.js";
import { drawText } from "./font.ts";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";

function framesOf(pc: PixelCanvas, fw: number, fh: number, n: number): Texture[] {
  const base = Texture.from(pc.toCanvas());
  return Array.from(
    { length: n },
    (_, i) => new Texture({ source: base.source, frame: new Rectangle(i * fw, 0, fw, fh) }),
  );
}

const CAR_COLORS = [
  { main: C.red, shade: C.wine, light: C.pink },
  { main: C.sky, shade: C.navy, light: C.cyan },
  { main: C.amber, shade: C.rust, light: C.lemon },
  { main: C.leaf, shade: C.moss, light: C.lemon },
] as const;
export const CAR_VARIANTS = CAR_COLORS.length;

const cars = new Map<number, Texture[]>();
/** A small hatchback, two wheel frames. 30 x 18 px. */
export function carTextures(variant: number): Texture[] {
  const hit = cars.get(variant);
  if (hit) return hit;
  const col = CAR_COLORS[variant % CAR_COLORS.length]!;
  const fw = 30;
  const fh = 18;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 1);
    pc.ellipse(1, 13, 26, 4, C.night, 90);
    pc.round(0, 6, 27, 7, col.main);
    pc.hline(1, 6, 25, col.light);
    pc.hline(0, 12, 27, col.shade);
    pc.round(6, 1, 14, 7, col.main);
    pc.rect(8, 2, 5, 4, C.cyan);
    pc.rect(14, 2, 5, 4, C.cyan);
    pc.set(8, 2, C.white);
    pc.set(14, 2, C.white);
    pc.rect(25, 8, 2, 2, C.lemon);
    pc.rect(0, 8, 1, 2, C.red);
    pc.vline(13, 7, 5, col.shade);
    for (const wx of [4, 19]) {
      pc.ellipse(wx, 10, 5, 5, C.night);
      pc.set(wx + 2, 12, f ? C.silver : C.grey);
      pc.set(wx + 1 + f, 11 + f, C.silver);
    }
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  const t = framesOf(pc, fw, fh, 2);
  cars.set(variant, t);
  return t;
}

let truckTex: Texture[] | null = null;
/** Food truck, frame 0 closed, frame 1 with the hatch open and an awning. 48 x 34 px. */
export function truckTextures(): Texture[] {
  if (truckTex) return truckTex;
  const fw = 48;
  const fh = 34;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 1);
    pc.ellipse(2, 28, 42, 4, C.night, 90);
    // box body + cab
    pc.rect(2, 6, 30, 22, C.cream);
    pc.hline(2, 6, 30, C.white);
    pc.rect(2, 22, 30, 6, C.sky);
    pc.round(32, 12, 12, 16, C.cream);
    pc.rect(35, 14, 7, 6, C.cyan);
    pc.set(35, 14, C.white);
    pc.rect(42, 22, 2, 2, C.lemon);
    pc.hline(32, 27, 12, C.slate);
    if (f) {
      // open hatch, striped awning, a burger on the counter
      pc.rect(6, 10, 22, 9, C.ink);
      pc.rect(7, 16, 20, 2, C.tan);
      pc.rect(16, 13, 5, 3, C.amber);
      pc.hline(16, 14, 5, C.bark);
      pc.rect(10, 13, 3, 3, C.red);
      for (let x = 4; x < 30; x++) {
        const c = Math.floor((x - 4) / 3) % 2 ? C.white : C.red;
        pc.vline(x, 4, 4, c);
      }
      pc.hline(4, 8, 26, C.wine);
    } else {
      pc.rect(6, 10, 22, 9, C.silver);
      pc.hline(6, 14, 22, C.grey);
    }
    drawText(pc, 7, 22, "FOOD", C.white);
    for (const wx of [6, 34]) {
      pc.ellipse(wx, 25, 6, 6, C.night);
      pc.set(wx + 2, 27, C.silver);
    }
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  truckTex = framesOf(pc, fw, fh, 2);
  return truckTex;
}

let eyesTex: Texture[] | null = null;
/** Glowing eyes in the dark: open, half shut, closed. 7 x 3 px. */
export function eyesTextures(): Texture[] {
  if (eyesTex) return eyesTex;
  const pc = new PixelCanvas(7 * 3, 3);
  for (let f = 0; f < 3; f++) {
    const x = f * 7;
    if (f === 2) continue;
    for (const ex of [x + 1, x + 4]) {
      pc.set(ex, 1, C.lemon);
      pc.set(ex + 1, 1, C.amber);
      if (f === 0) {
        pc.set(ex, 0, C.amber);
        pc.set(ex + 1, 2, C.orange);
      }
    }
  }
  eyesTex = framesOf(pc, 7, 3, 3);
  return eyesTex;
}

let wolfTex: Texture[] | null = null;
/** A small werewolf trotting on all fours (2 frames) and howling (frame 2). 20 x 16 px. */
export function werewolfTextures(): Texture[] {
  if (wolfTex) return wolfTex;
  const fw = 20;
  const fh = 16;
  const pc = new PixelCanvas(fw * 3, fh);
  const fur = C.dusk;
  const dark = C.ink;
  for (let f = 0; f < 3; f++) {
    pc.at(f * fw + 1, 1);
    if (f < 2) {
      pc.round(2, 6, 12, 5, fur);
      pc.hline(3, 6, 10, C.slate);
      pc.round(12, 3, 5, 5, fur);
      pc.set(13, 2, fur);
      pc.set(15, 2, fur);
      pc.hline(16, 6, 2, fur);
      pc.set(15, 4, C.lemon);
      pc.rect(0, 5, 3, 2, fur);
      const legs = f ? [3, 6, 10, 13] : [4, 5, 11, 12];
      for (const lx of legs) pc.vline(lx, 11, 3, dark);
    } else {
      // sitting, snout to the moon
      pc.round(5, 6, 8, 8, fur);
      pc.round(9, 1, 5, 6, fur);
      pc.set(10, 0, fur);
      pc.hline(13, 1, 3, fur);
      pc.set(11, 2, C.lemon);
      pc.rect(2, 11, 4, 2, fur);
      pc.vline(7, 13, 2, dark);
      pc.vline(11, 13, 2, dark);
    }
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  wolfTex = framesOf(pc, fw, fh, 3);
  return wolfTex;
}

const flakes = new Map<string, Texture>();
/** Weather particles: a snowflake, a cherry petal, an autumn leaf. */
export function particleTexture(kind: "snow" | "petal" | "leaf"): Texture {
  const hit = flakes.get(kind);
  if (hit) return hit;
  const pc = new PixelCanvas(3, 3);
  if (kind === "snow") {
    pc.set(1, 0, C.white);
    pc.set(0, 1, C.white);
    pc.set(1, 1, C.white);
    pc.set(2, 1, C.white);
    pc.set(1, 2, C.white);
  } else if (kind === "petal") {
    pc.set(0, 0, C.pink);
    pc.set(1, 0, C.pink);
    pc.set(1, 1, C.peach);
  } else {
    pc.set(0, 0, C.orange);
    pc.set(1, 1, C.amber);
    pc.set(2, 1, C.rust);
    pc.set(1, 2, C.rust);
  }
  const t = Texture.from(pc.toCanvas());
  flakes.set(kind, t);
  return t;
}

let shadowTex: Texture | null = null;
/** A big soft cloud shadow (dithered, drawn once at low alpha). 96 x 48 px. */
export function cloudShadowTexture(): Texture {
  if (shadowTex) return shadowTex;
  const w = 96;
  const h = 48;
  const pc = new PixelCanvas(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - w / 2) / (w / 2);
      const dy = (y - h / 2) / (h / 2);
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      if (d > 0.6 && (x + y) % 2) continue;
      pc.set(x, y, C.night);
    }
  }
  shadowTex = Texture.from(pc.toCanvas());
  return shadowTex;
}
