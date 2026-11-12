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
  beer: {
    rows: ["..www..", ".wwwww.", ".aayaa.", ".aaaaas", ".ayaaas", ".aaaaa.", ".aaaaa."],
    colors: { w: C.white, a: C.amber, y: C.lemon, s: C.silver },
  },
  chill: {
    rows: ["...g...", "g..g..g", ".g.g.g.", "..ggg..", "ggggggg", "..gmg..", "...m..."],
    colors: { g: C.leaf, m: C.moss },
  },
};
export const CHAT_ICONS = Object.keys(ICONS);
/** What people chat about at random (beer/chill only come up when they hold one, cat never). */
export const CHAT_TOPICS = CHAT_ICONS.filter((n) => n !== "cat" && n !== "beer" && n !== "chill");

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

/** A glass of lager in hand, foam bubbling (2 frames, 7x11, same frame as the mug). */
export const beerTextures = once(() => {
  const fw = 7;
  const fh = 11;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 0);
    pc.set(f ? 2 : 1, 2, C.white, 200);
    pc.rect(0, 3, 4, 2, C.white);
    pc.rect(0, 5, 4, 5, C.amber);
    pc.vline(0, 5, 5, C.lemon);
    pc.set(2, f ? 6 : 8, C.lemon);
    pc.vline(4, 5, 3, C.silver);
    pc.at(0, 0);
    pc.outline(f * fw, 3, fw, fh - 3);
  }
  return framesOf(pc, fw, fh, 2);
});

/** A joint between the fingers with a glowing tip and a curl of smoke (2 frames, 7x11). */
export const jointTextures = once(() => {
  const fw = 7;
  const fh = 11;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw, 0);
    pc.hline(1, 8, 3, C.white);
    pc.set(4, 8, C.cream);
    pc.set(5, 8, f ? C.amber : C.orange);
    pc.set(5, 6 - f, C.silver, 200);
    pc.set(4, 5 - f, C.silver, 150);
    pc.set(5, 4 - f, C.white, 110);
    pc.at(0, 0);
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

/** Crumpled paper ball (thrown at people from the agent card). */
export const paperBallTexture = once(() => {
  const pc = new PixelCanvas(7, 7);
  pc.at(1, 1);
  pc.round(0, 0, 5, 5, C.white);
  pc.set(1, 1, C.silver);
  pc.set(3, 2, C.silver);
  pc.set(2, 3, C.silver);
  pc.hline(1, 4, 3, C.silver);
  pc.at(0, 0);
  pc.outline();
  return Texture.from(pc.toCanvas());
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

// ---- slapstick: /clear zaps, ghosts, graveyard, chef -----------------------------------------
/** Lightning bolt from the monitor down to the chair (3 frames, 13x30). */
export const boltTextures = once(() => {
  const fw = 13;
  const fh = 30;
  const pc = new PixelCanvas(fw * 3, fh);
  const shapes = [
    [6, 5, 7, 4, 8, 3, 6, 5, 7, 4, 6, 5, 7, 5],
    [5, 6, 4, 6, 7, 8, 5, 6, 4, 5, 6, 7, 6, 5],
    [7, 6, 8, 5, 4, 5, 7, 8, 6, 5, 4, 6, 7, 6],
  ];
  shapes.forEach((xs, f) => {
    pc.at(f * fw, 0);
    xs.forEach((x, k) => {
      pc.rect(x - 1, k * 2, 3, 2, f === 1 ? C.white : C.lemon);
      pc.vline(x, k * 2, 2, C.white);
    });
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh, C.amber);
  });
  return framesOf(pc, fw, fh, 3);
});

/** Charred little pile with smoke (3 frames, 16x16). */
export const pileTextures = once(() => {
  const fw = 16;
  const pc = new PixelCanvas(fw * 3, fw);
  for (let f = 0; f < 3; f++) {
    pc.at(f * fw + 1, 0);
    pc.ellipse(1, 10, 12, 5, C.ink);
    pc.ellipse(3, 9, 8, 4, C.slate);
    pc.set(5, 10, C.orange);
    pc.set(8, 11, C.red);
    pc.set(6, 9, C.night);
    pc.set(9, 9, C.night);
    // smoke puffs drifting up
    const sx = [5, 7, 6][f]!;
    pc.rect(sx, 6 - f, 2, 2, C.silver);
    pc.rect(sx + (f % 2 ? -2 : 2), 3 - f, 2, 2, C.grey);
    if (f > 0) pc.set(sx + 1, 1, C.grey);
    pc.at(0, 0);
  }
  pc.outline(0, 7, fw * 3, 9);
  return framesOf(pc, fw, fw, 3);
});

/** Tombstone at the desk: "RIP" + a short label (project · minutes). */
const tombs = new Map<string, Texture>();
export function tombstoneTexture(label: string): Texture {
  const hit = tombs.get(label);
  if (hit) return hit;
  const tw = Math.max(measureText("RIP"), measureText(label));
  const w = tw + 4;
  const h = 2 * FONT_HEIGHT + 6;
  const pc = new PixelCanvas(w + 2, h + 3);
  pc.at(1, 1);
  pc.rect(0, 3, w, h - 3, C.grey);
  pc.rect(2, 0, w - 4, 3, C.grey);
  pc.rect(1, 1, w - 2, 2, C.grey);
  pc.hline(2, 0, w - 4, C.silver);
  pc.vline(0, 3, h - 3, C.silver);
  pc.vline(w - 1, 3, h - 3, C.slate);
  drawText(pc, Math.floor((w - measureText("RIP")) / 2), 2, "RIP", C.night);
  drawText(pc, Math.floor((w - measureText(label)) / 2), 3 + FONT_HEIGHT, label, C.ink);
  pc.hline(-1, h - 1, w + 2, C.moss);
  pc.at(0, 0);
  pc.outline();
  const t = Texture.from(pc.toCanvas());
  tombs.set(label, t);
  return t;
}

/** Wobbly cartoon ghost (2 frames, 14x16). */
export const ghostTextures = once(() => {
  const fw = 14;
  const fh = 16;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 1);
    pc.ellipse(0, 0, 12, 10, C.white);
    pc.rect(0, 5, 12, 7, C.white);
    for (let x = 0; x < 12; x += 3) pc.rect(x + (f ? 1 : 0), 12, 2, 2, C.white);
    pc.vline(11, 4, 8, C.silver);
    pc.rect(3, 4, 2, 2, C.night);
    pc.rect(7, 4, 2, 2, C.night);
    pc.rect(5, 8, 2, f ? 2 : 1, C.night);
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh, C.slate);
  }
  return framesOf(pc, fw, fh, 2);
});

/** Small garden headstones: [upright, crooked, flat (crashed)] (8x10). */
export const headstoneTextures = once(() => {
  const fw = 9;
  const fh = 10;
  const pc = new PixelCanvas(fw * 3, fh);
  pc.at(1, 1);
  pc.rect(0, 2, 6, 6, C.grey);
  pc.rect(1, 1, 4, 1, C.grey);
  pc.hline(2, 0, 2, C.silver);
  pc.vline(2, 3, 3, C.slate);
  pc.hline(1, 4, 3, C.slate);
  pc.hline(-1, 8, 8, C.moss);
  pc.at(fw + 1, 1);
  pc.rect(1, 2, 6, 6, C.grey);
  pc.rect(2, 1, 4, 1, C.grey);
  pc.rect(3, 0, 2, 1, C.silver);
  pc.set(0, 7, C.grey);
  pc.vline(3, 3, 3, C.slate);
  pc.hline(2, 4, 3, C.slate);
  pc.hline(-1, 8, 8, C.moss);
  pc.at(fw * 2 + 1, 4);
  pc.rect(0, 1, 7, 3, C.grey);
  pc.hline(0, 1, 7, C.silver);
  pc.set(3, 2, C.slate);
  pc.hline(-1, 4, 9, C.moss);
  pc.at(0, 0);
  pc.outline();
  return framesOf(pc, fw, fh, 3);
});

/** Wooden sign "TODAY'S FALLEN: n". */
const signs = new Map<string, Texture>();
export function fallenSignTexture(n: number): Texture {
  const text = `FALLEN TODAY ${n}`;
  const hit = signs.get(text);
  if (hit) return hit;
  const w = measureText(text) + 6;
  const h = FONT_HEIGHT + 5;
  const pc = new PixelCanvas(w + 2, h + 8);
  pc.at(1, 1);
  pc.rect(0, 0, w, h, C.tan);
  pc.hline(0, 0, w, C.sand);
  pc.hline(0, h - 1, w, C.wood);
  drawText(pc, 3, 2, text, C.night);
  pc.rect(3, h, 2, 6, C.bark);
  pc.rect(w - 5, h, 2, 6, C.bark);
  pc.at(0, 0);
  pc.outline();
  const t = Texture.from(pc.toCanvas());
  signs.set(text, t);
  return t;
}

/** Chef bot with a big knife, then the sandwich it actually brings: [knife a, knife b, sandwich] (14x18). */
export const chefTextures = once(() => {
  const fw = 16;
  const fh = 20;
  const pc = new PixelCanvas(fw * 3, fh);
  for (let f = 0; f < 3; f++) {
    pc.at(f * fw + 2, 1);
    // toque
    pc.rect(2, 0, 7, 4, C.white);
    pc.rect(1, 1, 9, 2, C.white);
    pc.hline(3, 4, 5, C.silver);
    // body
    pc.round(1, 5, 9, 7, C.silver);
    pc.rect(2, 7, 7, 2, C.night);
    pc.set(3, 7, C.red);
    pc.set(7, 7, C.red);
    pc.rect(2, 12, 7, 3, C.white);
    pc.vline(3, 15, 2, C.slate);
    pc.vline(7, 15, 2, C.slate);
    if (f < 2) {
      // knife raised (wobbles)
      const kx = 10;
      const ky = f ? 3 : 4;
      pc.rect(kx, ky, 2, 6, C.white);
      pc.vline(kx + 1, ky, 6, C.silver);
      pc.rect(kx, ky + 6, 2, 3, C.bark);
    } else {
      // sandwich held out
      pc.rect(9, 8, 6, 1, C.sand);
      pc.rect(9, 9, 6, 1, C.leaf);
      pc.rect(9, 10, 6, 1, C.red);
      pc.rect(9, 11, 6, 1, C.sand);
    }
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  return framesOf(pc, fw, fh, 3);
});

// ---- cat toys -------------------------------------------------------------------------------
/** Cat food bowl: full, half, empty (3 frames, 12x7). */
export const bowlTextures = once(() => {
  const fw = 12;
  const fh = 7;
  const pc = new PixelCanvas(fw * 3, fh);
  for (let f = 0; f < 3; f++) {
    pc.at(f * fw + 1, 1);
    // kibble heap first, the bowl rim in front of it
    if (f === 0) {
      pc.rect(2, 0, 6, 2, C.wood);
      pc.set(3, 0, C.bark);
      pc.set(6, 0, C.clay);
      pc.set(4, 1, C.bark);
    } else if (f === 1) {
      pc.rect(3, 1, 4, 1, C.wood);
      pc.set(5, 1, C.bark);
    }
    pc.rect(0, 2, 10, 2, C.sky);
    pc.hline(0, 2, 10, C.cyan);
    pc.rect(1, 4, 8, 1, C.navy);
    if (f === 2) pc.hline(2, 2, 6, C.navy);
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  return framesOf(pc, fw, fh, 3);
});

/** A fish-shaped cat treat (an agent tosses one to a begging cat), 7x5. */
export const treatTexture = once(() => {
  const pc = new PixelCanvas(7, 5);
  pc.at(1, 1);
  pc.sprite(0, 0, [".oo.o", "ooooo", ".oo.o"], { o: C.amber });
  pc.set(1, 1, C.night);
  pc.set(3, 2, C.wood);
  pc.at(0, 0);
  pc.outline();
  return Texture.from(pc.toCanvas());
});

/** Yarn ball rolling (4 frames, 9x9; the thread turns a quarter each frame). */
export const yarnTextures = once(() => {
  const fw = 9;
  const fh = 9;
  const pc = new PixelCanvas(fw * 4, fh);
  const threads = [
    [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ],
    [
      [1, 4],
      [2, 4],
      [3, 4],
      [5, 4],
    ],
    [
      [1, 5],
      [2, 4],
      [3, 3],
      [4, 2],
    ],
    [
      [3, 1],
      [3, 2],
      [3, 3],
      [3, 5],
    ],
  ] as const;
  for (let f = 0; f < 4; f++) {
    pc.at(f * fw + 1, 1);
    pc.round(0, 0, 7, 7, C.berry);
    pc.set(1, 1, C.pink);
    pc.set(2, 1, C.pink);
    for (const [x, y] of threads[f]!) pc.set(x, y, C.plum);
    pc.set(6, 6, C.pink);
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  return framesOf(pc, fw, fh, 4);
});

/** Laser pointer dot, flickering (2 frames, 7x7: a hot core in a soft red halo). */
export const laserTextures = once(() => {
  const fw = 7;
  const pc = new PixelCanvas(fw * 2, fw);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw, 0);
    const halo = f === 0 ? 150 : 90;
    pc.rect(2, 0, 3, 7, C.red, halo);
    pc.rect(0, 2, 7, 3, C.red, halo);
    pc.rect(1, 1, 5, 5, C.red, halo);
    pc.rect(2, 2, 3, 3, C.neon);
    pc.set(3, 3, C.white);
  }
  return framesOf(pc, fw, fw, 2);
});
