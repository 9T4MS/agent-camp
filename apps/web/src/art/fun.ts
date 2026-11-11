/**
 * Office-life art: chat icon bubbles, coffee mug, ping ring, sparkles, carried papers,
 * roomba, pizza drone, birds, hearts, "mrrp", ship-it toast, trophy, desk lamp, leaves.
 * Everything drawn in code, cached once (no per-frame texture work).
 */
import { Rectangle, Texture } from "pixi.js";
import { drawText, FONT_HEIGHT, measureText } from "./font.ts";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";

function framesOf(pc: PixelCanvas, fw: number, fh: number, n: number): Texture[] {
  const base = Texture.from(pc.toCanvas());
  return Array.from(
    { length: n },
    (_, i) => new Texture({ source: base.source, frame: new Rectangle(i * fw, 0, fw, fh) }),
  );
}

function once<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => {
    v ??= make();
    return v;
  };
}

// ---- chat icons -----------------------------------------------------------------------------
const ICONS: Record<string, { rows: string[]; colors: Record<string, string> }> = {
  coffee: {
    rows: [".s.s...", "..s.s..", ".......", "wwwww..", "wbbbwww", "wbbbw.w", ".www..."],
    colors: { s: C.silver, w: C.white, b: C.bark },
  },
  idea: {
    rows: ["..yyy..", ".yyyyy.", ".yywyy.", ".yyyyy.", "..yyy..", "..sss..", "...s..."],
    colors: { y: C.lemon, w: C.white, s: C.grey },
  },
  laugh: {
    rows: [".yyyyy.", "yyyyyyy", "ykyyyky", "yyyyyyy", "ykkkkky", "yykrkyy", ".yyyyy."],
    colors: { y: C.amber, k: C.night, r: C.red },
  },
  heart: {
    rows: [".rr.rr.", "rrrrrrr", "rwrrrrr", "rrrrrrr", ".rrrrr.", "..rrr..", "...r..."],
    colors: { r: C.red, w: C.pink },
  },
  bug: {
    rows: ["k.....k", ".k.g.k.", "..ggg..", "kgmgmgk", "..ggg..", "kgmgmgk", "..ggg.."],
    colors: { k: C.night, g: C.leaf, m: C.moss },
  },
  rocket: {
    rows: ["...w...", "..wsw..", "..wcw..", "..www..", ".rwwwr.", ".r.o.r.", "...y..."],
    colors: { w: C.white, s: C.silver, c: C.sky, r: C.red, o: C.orange, y: C.lemon },
  },
  music: {
    rows: ["...kkkk", "...k..k", "...k..k", "...k..k", ".kkk.kk", "kkkkkkk", ".kk...."],
    colors: { k: C.plum },
  },
  pizza: {
    rows: ["aaaaaaa", ".yryyy.", ".yyyry.", "..yry..", "..yyy..", "...y...", "......."],
    colors: { a: C.clay, y: C.lemon, r: C.red },
  },
  cat: {
    rows: ["o.....o", "oo...oo", "ooooooo", "okooko.", "ooopoo.", ".ooooo.", "......."],
    colors: { o: C.orange, k: C.night, p: C.pink },
  },
};
export const CHAT_ICONS = Object.keys(ICONS);

/** Little speech bubbles holding a single pixel icon (one per CHAT_ICONS entry). */
export const chatIconTextures = once(() => {
  const fw = 13;
  const fh = 14;
  const n = CHAT_ICONS.length;
  const pc = new PixelCanvas(fw * n, fh);
  CHAT_ICONS.forEach((name, i) => {
    pc.at(i * fw + 1, 1);
    pc.round(0, 0, 11, 10, C.white);
    pc.hline(1, 9, 9, C.silver);
    pc.rect(4, 10, 3, 1, C.white);
    pc.set(5, 11, C.white);
    const icon = ICONS[name]!;
    pc.sprite(2, 1, icon.rows, icon.colors);
    pc.at(0, 0);
    pc.outline(i * fw, 0, fw, fh);
  });
  return framesOf(pc, fw, fh, n);
});

// ---- mug, ring, sparkle, carry --------------------------------------------------------------
/** Coffee mug in hand with a steam wisp (2 frames, 7x11). */
export const mugTextures = once(() => {
  const fw = 7;
  const fh = 11;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 0);
    pc.set(f ? 2 : 1, 0, C.white, 170);
    pc.set(f ? 1 : 2, 1, C.white, 200);
    pc.set(f ? 2 : 1, 2, C.white, 140);
    pc.rect(0, 4, 4, 5, C.white);
    pc.hline(0, 4, 4, C.bark);
    pc.vline(4, 5, 2, C.white);
    pc.set(1, 6, C.red);
    pc.set(2, 6, C.red);
    pc.at(0, 0);
    pc.outline(f * fw, 3, fw, fh - 3);
  }
  return framesOf(pc, fw, fh, 2);
});

/** Expanding "ping" ring around someone who waits for a long time (4 frames, 25x13). */
export const ringTextures = once(() => {
  const fw = 25;
  const fh = 13;
  const pc = new PixelCanvas(fw * 4, fh);
  const sizes = [
    [9, 5],
    [15, 7],
    [21, 10],
    [25, 13],
  ] as const;
  sizes.forEach(([w, h], f) => {
    const ox = f * fw + Math.floor((fw - w) / 2);
    const oy = Math.floor((fh - h) / 2);
    const rx = w / 2;
    const ry = h / 2;
    const col = f < 2 ? C.amber : f === 2 ? C.lemon : C.cream;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const dx = (i + 0.5 - rx) / rx;
        const dy = (j + 0.5 - ry) / ry;
        const d = dx * dx + dy * dy;
        const inner = (1 - 2 / Math.min(w, h)) ** 2;
        if (d <= 1 && d >= inner) pc.set(ox + i, oy + j, col, f === 3 ? 150 : 255);
      }
    }
  });
  return framesOf(pc, fw, fh, 4);
});

/** Twinkle star (4 frames, 11x11). */
export const sparkleTextures = once(() => {
  const fw = 11;
  const pc = new PixelCanvas(fw * 4, fw);
  const arms = [1, 3, 5, 2];
  arms.forEach((a, f) => {
    pc.at(f * fw, 0);
    const col = f === 2 ? C.white : C.lemon;
    pc.vline(5, 5 - a, a * 2 + 1, col);
    pc.hline(5 - a, 5, a * 2 + 1, col);
    pc.set(5, 5, C.white);
    if (f === 2) {
      pc.set(3, 3, C.lemon);
      pc.set(7, 3, C.lemon);
      pc.set(3, 7, C.lemon);
      pc.set(7, 7, C.lemon);
    }
  });
  pc.at(0, 0);
  return framesOf(pc, fw, fw, 4);
});

/** Things helper bots carry: [paper, box] (8x7). */
export const carryTextures = once(() => {
  const fw = 8;
  const fh = 7;
  const pc = new PixelCanvas(fw * 2, fh);
  pc.at(1, 1);
  pc.rect(0, 0, 6, 5, C.white);
  pc.hline(1, 1, 4, C.grey);
  pc.hline(1, 3, 3, C.grey);
  pc.at(fw + 1, 1);
  pc.rect(0, 0, 6, 5, C.tan);
  pc.hline(0, 0, 6, C.sand);
  pc.vline(3, 0, 5, C.wood);
  pc.at(0, 0);
  pc.outline();
  return framesOf(pc, fw, fh, 2);
});

// ---- ambient actors -------------------------------------------------------------------------
/** Robot vacuum seen from the top (2 frames: status light blinks, 14x9). */
export const roombaTextures = once(() => {
  const fw = 14;
  const fh = 9;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 1);
    pc.ellipse(0, 0, 12, 7, C.slate);
    pc.ellipse(1, 0, 10, 5, C.grey);
    pc.hline(3, 1, 6, C.silver);
    pc.set(6, 3, f ? C.leaf : C.moss);
    pc.hline(2, 6, 8, C.ink);
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  return framesOf(pc, fw, fh, 2);
});

/** Delivery drone (2 frames: rotors spin, 20x11). */
export const droneTextures = once(() => {
  const fw = 20;
  const fh = 11;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 1);
    const blade = f ? [0, 3] : [1, 2];
    for (const x of [0, 13]) {
      pc.hline(x + blade[0]!, 0, 2, C.silver);
      pc.hline(x + blade[1]! + 2, 0, 2, C.silver);
      pc.vline(x + 2, 1, 2, C.grey);
    }
    pc.hline(2, 2, 14, C.grey);
    pc.round(5, 2, 8, 5, C.white);
    pc.rect(6, 4, 6, 1, C.night);
    pc.set(7, 4, C.cyan);
    pc.set(10, 4, C.cyan);
    pc.set(9, 2, f ? C.red : C.wine);
    pc.vline(7, 7, 2, C.slate);
    pc.vline(10, 7, 2, C.slate);
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  return framesOf(pc, fw, fh, 2);
});

/** Pizza box: [closed, open] (18x12). */
export const pizzaTextures = once(() => {
  const fw = 18;
  const fh = 12;
  const pc = new PixelCanvas(fw * 2, fh);
  pc.at(1, 4);
  pc.rect(0, 0, 16, 5, C.cream);
  pc.hline(0, 0, 16, C.white);
  pc.rect(0, 4, 16, 2, C.sand);
  pc.rect(5, 1, 6, 3, C.red);
  pc.hline(6, 2, 4, C.white);
  pc.at(fw + 1, 0);
  pc.rect(0, 0, 16, 4, C.sand); // lid, standing up
  pc.hline(0, 0, 16, C.cream);
  pc.rect(0, 4, 16, 6, C.cream);
  pc.ellipse(2, 4, 12, 6, C.amber);
  pc.ellipse(3, 5, 10, 4, C.lemon);
  for (const [x, y] of [
    [5, 6],
    [9, 5],
    [11, 7],
    [7, 8],
  ] as const)
    pc.set(x, y, C.red);
  pc.set(8, 6, C.moss);
  pc.hline(8, 4, 1, C.cream);
  pc.at(0, 0);
  pc.outline();
  return framesOf(pc, fw, fh, 2);
});

export const BIRD = { stand: 0, peck: 1, fly: [2, 3] } as const;
/** Small garden bird (4 frames, 9x8). */
export const birdTextures = once(() => {
  const fw = 9;
  const fh = 8;
  const pc = new PixelCanvas(fw * 4, fh);
  const body = C.cocoa;
  for (let f = 0; f < 4; f++) {
    pc.at(f * fw + 1, 1);
    if (f < 2) {
      const peck = f === 1;
      pc.rect(1, 2, 4, 3, body);
      pc.set(0, 3, body);
      pc.hline(2, 4, 3, C.peach);
      pc.rect(peck ? 4 : 4, peck ? 3 : 1, 2, 2, body);
      pc.set(5, peck ? 3 : 1, C.night);
      pc.set(6, peck ? 5 : 2, C.amber);
      pc.set(2, 5, C.amber);
      pc.set(4, 5, C.amber);
    } else {
      const up = f === 2;
      pc.rect(2, 3, 4, 2, body);
      pc.set(6, 3, body);
      pc.set(7, 3, C.amber);
      pc.hline(0, up ? 1 : 5, 3, C.bark);
      pc.set(2, up ? 2 : 4, C.bark);
      pc.hline(4, up ? 1 : 5, 2, C.bark);
    }
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  return framesOf(pc, fw, fh, 4);
});

/** Tiny pink heart (cat purrs). */
export const heartTexture = once(() => {
  const pc = new PixelCanvas(7, 6);
  pc.sprite(0, 0, [".r.r.", "rrrrr", "rrrrr", ".rrr.", "..r.."], { r: C.pink });
  pc.set(1, 1, C.white);
  pc.outline();
  return Texture.from(pc.toCanvas());
});

/** Speech bubble with plain text (e.g. the cat's "MRRP?"). */
const textBubbles = new Map<string, Texture>();
export function textBubbleTexture(text: string, color: string = C.ink): Texture {
  const hit = textBubbles.get(text);
  if (hit) return hit;
  const w = measureText(text) + 6;
  const h = FONT_HEIGHT + 5;
  const pc = new PixelCanvas(w + 2, h + 4);
  pc.at(1, 1);
  pc.round(0, 0, w, h, C.white);
  pc.hline(1, h - 1, w - 2, C.silver);
  pc.rect(3, h, 3, 1, C.white);
  pc.set(3, h + 1, C.white);
  drawText(pc, 3, 2, text, color);
  pc.at(0, 0);
  pc.outline();
  const t = Texture.from(pc.toCanvas());
  textBubbles.set(text, t);
  return t;
}

/** "SHIP IT!" ribbon over a desk whose long session just ended. */
const toasts = new Map<string, Texture>();
export function toastTexture(text: string): Texture {
  const hit = toasts.get(text);
  if (hit) return hit;
  const w = measureText(text) + 10;
  const h = FONT_HEIGHT + 6;
  const pc = new PixelCanvas(w + 6, h + 4);
  pc.at(1, 1);
  // ribbon tails
  pc.rect(0, 3, 4, h - 2, C.wine);
  pc.rect(w, 3, 4, h - 2, C.wine);
  pc.set(0, h, C.night);
  pc.set(w + 3, h, C.night);
  pc.rect(2, 0, w, h, C.red);
  pc.hline(2, 0, w, C.orange);
  pc.hline(2, h - 1, w, C.wine);
  drawText(pc, 7, 3, text, C.lemon);
  pc.at(0, 0);
  pc.outline();
  const t = Texture.from(pc.toCanvas());
  toasts.set(text, t);
  return t;
}

/** Golden trophy as a DOM canvas for the HUD banner portrait (16x24 px, scaled by CSS). */
export function trophyCanvas(): HTMLCanvasElement {
  const pc = new PixelCanvas(16, 24);
  pc.rect(0, 0, 16, 24, C.ink);
  const g = C.amber;
  pc.rect(3, 4, 10, 2, C.lemon);
  pc.rect(3, 6, 10, 5, g);
  pc.rect(4, 11, 8, 2, g);
  pc.rect(5, 13, 6, 1, C.orange);
  pc.vline(4, 6, 4, C.lemon);
  // handles
  pc.vline(1, 5, 4, g);
  pc.set(2, 5, g);
  pc.set(2, 9, g);
  pc.vline(14, 5, 4, g);
  pc.set(13, 5, g);
  pc.set(13, 9, g);
  pc.rect(7, 14, 2, 3, C.orange);
  pc.rect(4, 17, 8, 2, g);
  pc.rect(3, 19, 10, 3, C.bark);
  pc.hline(5, 20, 6, C.lemon);
  pc.set(7, 7, C.white);
  pc.set(10, 2, C.white);
  pc.set(12, 1, C.lemon);
  return pc.toCanvas();
}

/** Desk lamp: [off, on] (9x13), sits on the desk corner. */
export const deskLampTextures = once(() => {
  const fw = 9;
  const fh = 13;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 1);
    pc.rect(0, 0, 6, 3, f ? C.amber : C.slate);
    pc.hline(1, 3, 4, f ? C.lemon : C.grey);
    pc.vline(4, 4, 5, C.slate);
    pc.rect(2, 9, 5, 2, C.slate);
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  return framesOf(pc, fw, fh, 2);
});

/** A fresh leaf that grows on potted plants during the day (5x4). */
export const leafTexture = once(() => {
  const pc = new PixelCanvas(6, 5);
  pc.sprite(1, 1, [".ll", "lLl", "l.."], { l: C.leaf, L: C.lemon });
  pc.outline(0, 0, 6, 5, C.forest);
  return Texture.from(pc.toCanvas());
});
