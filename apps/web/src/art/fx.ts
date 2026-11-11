/**
 * Small animated bits: speech bubbles with activity icons, "!" and "..." bubbles,
 * puff clouds, confetti, helper bots and kittens, the office cat, glows and badges.
 */
import { type Activity, AGENT_PALETTES, type AgentKind } from "@agent-office/protocol";
import { Rectangle, Texture } from "pixi.js";
import { drawText, FONT_HEIGHT, fitText, measureText } from "./font.ts";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";

function framesOf(pc: PixelCanvas, fw: number, fh: number, n: number): Texture[] {
  const base = Texture.from(pc.toCanvas());
  return Array.from(
    { length: n },
    (_, i) => new Texture({ source: base.source, frame: new Rectangle(i * fw, 0, fw, fh) }),
  );
}

const ICONS: Record<Activity, { rows: string[]; colors: Record<string, string> }> = {
  typing: {
    rows: ["....pp.", "...pyp.", "..yyy..", ".yyy...", "yyy....", "kk.....", "k......"],
    colors: { p: C.pink, y: C.amber, k: C.night },
  },
  reading: {
    rows: [".......", "bww.wwb", "bwg.gwb", "bww.wwb", "bwg.gwb", "bbbbbbb", "......."],
    colors: { b: C.sky, w: C.white, g: C.grey },
  },
  running: {
    rows: ["kkkkkkk", "kgkkkkk", "kkgkkkk", "kgkgggk", "kkkkkkk", "......."],
    colors: { k: C.night, g: C.leaf },
  },
  thinking: {
    rows: ["..yyy..", ".yyyyy.", ".yywyy.", ".yyyyy.", "..yyy..", "..sss..", "...s..."],
    colors: { y: C.lemon, w: C.white, s: C.grey },
  },
  waiting: {
    rows: ["..rrr..", "..rrr..", "..rrr..", "..rrr..", "...r...", ".......", "..rrr.."],
    colors: { r: C.red },
  },
  idle: {
    rows: [".s.s...", "..s.s..", ".......", "wwwww..", "wbbbwww", "wbbbw.w", ".www..."],
    colors: { s: C.silver, w: C.white, b: C.bark },
  },
};

const bubbleCache = new Map<string, Texture>();
/** Speech bubble: activity icon + short text (e.g. the project name). */
export function bubbleTexture(activity: Activity, text: string): Texture {
  const t = fitText(text, 60);
  const key = `${activity}:${t}`;
  const hit = bubbleCache.get(key);
  if (hit) return hit;
  const tw = t ? measureText(t) : 0;
  const w = 3 + 7 + (tw ? 3 + tw : 0) + 3;
  const h = 11;
  const pc = new PixelCanvas(w + 2, h + 5);
  pc.at(1, 1);
  pc.round(0, 0, w, h, C.white);
  pc.hline(1, h - 1, w - 2, C.silver);
  const cx = Math.floor(w / 2);
  pc.rect(cx - 2, h, 4, 1, C.white);
  pc.rect(cx - 1, h + 1, 2, 1, C.white);
  pc.set(cx - 2, h, C.silver);
  const icon = ICONS[activity];
  pc.sprite(3, 2, icon.rows, icon.colors);
  if (t) drawText(pc, 13, 3, t, C.ink);
  pc.at(0, 0);
  pc.outline();
  const tex = Texture.from(pc.toCanvas());
  bubbleCache.set(key, tex);
  return tex;
}

let alertFrames: Texture[] | null = null;
/** Red "!" bubble for waiting characters (2 frames). */
export function alertTextures(): Texture[] {
  if (alertFrames) return alertFrames;
  const fw = 11;
  const fh = 15;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 1);
    pc.round(0, 0, 9, 10, f ? C.lemon : C.amber);
    pc.rect(3, 10, 3, 1, f ? C.lemon : C.amber);
    pc.set(4, 11, f ? C.lemon : C.amber);
    pc.rect(4, 2, 1, 4, C.wine);
    pc.rect(3, 2, 3, 3, C.wine);
    pc.set(4, 7, C.wine);
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  alertFrames = framesOf(pc, fw, fh, 2);
  return alertFrames;
}

let selectFrames: Texture[] | null = null;
/** Bouncing down arrow over the character whose agent card is open (2 frames). */
export function selectArrowTextures(): Texture[] {
  if (selectFrames) return selectFrames;
  const rows = ["yyyyyyy", ".yyyyy.", "..yyy..", "...y..."];
  const fw = 9;
  const fh = 6;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.sprite(f * fw + 1, 1, rows, { y: f ? C.lemon : C.amber });
    pc.outline(f * fw, 0, fw, fh);
  }
  selectFrames = framesOf(pc, fw, fh, 2);
  return selectFrames;
}

let dotsFrames: Texture[] | null = null;
/** "..." thinking bubble (3 frames). */
export function dotsTextures(): Texture[] {
  if (dotsFrames) return dotsFrames;
  const fw = 15;
  const fh = 12;
  const pc = new PixelCanvas(fw * 3, fh);
  for (let f = 0; f < 3; f++) {
    pc.at(f * fw + 1, 1);
    pc.round(0, 0, 13, 7, C.white);
    pc.rect(2, 7, 2, 1, C.white);
    pc.set(1, 8, C.white);
    for (let d = 0; d <= f; d++) pc.rect(3 + d * 3, 3, 1, 1, C.ink);
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  dotsFrames = framesOf(pc, fw, fh, 3);
  return dotsFrames;
}

let puffFrames: Texture[] | null = null;
/** Puff cloud for helper bots popping in/out (4 frames, 14x14). */
export function puffTextures(): Texture[] {
  if (puffFrames) return puffFrames;
  const fw = 14;
  const pc = new PixelCanvas(fw * 4, fw);
  const sizes = [6, 10, 12, 12];
  for (let f = 0; f < 4; f++) {
    pc.at(f * fw, 0);
    const s = sizes[f]!;
    const o = Math.floor((fw - s) / 2);
    if (f < 3) {
      pc.ellipse(o, o, s, s, C.silver);
      pc.ellipse(o + 1, o, s - 2, s - 3, C.white);
    } else {
      for (const [x, y] of [
        [1, 2],
        [9, 1],
        [2, 9],
        [10, 10],
        [6, 6],
      ] as const) {
        pc.rect(x, y, 2, 2, C.white);
      }
    }
  }
  pc.at(0, 0);
  puffFrames = framesOf(pc, fw, fw, 4);
  return puffFrames;
}

let pixelTex: Texture | null = null;
/** 2x2 white pixel, tinted for confetti and sparks. */
export function pixelTexture(): Texture {
  if (pixelTex) return pixelTex;
  const pc = new PixelCanvas(2, 2);
  pc.rect(0, 0, 2, 2, C.white);
  pixelTex = Texture.from(pc.toCanvas());
  return pixelTex;
}
export const CONFETTI_COLORS = [C.red, C.amber, C.lemon, C.leaf, C.cyan, C.pink, C.berry, C.white];

const botCache = new Map<AgentKind, Texture[]>();
/** Helper bot (2 hop frames, 12x12): silver body, visor eyes in the agent color. */
export function botTextures(agent: AgentKind): Texture[] {
  const hit = botCache.get(agent);
  if (hit) return hit;
  const fw = 12;
  const pc = new PixelCanvas(fw * 2, fw);
  const accent = AGENT_PALETTES[agent].light;
  const main = AGENT_PALETTES[agent].main;
  for (let f = 0; f < 2; f++) {
    const up = f === 1 ? -1 : 0;
    pc.at(f * fw + 1, 1 + up);
    pc.set(4, 0, accent);
    pc.set(4, 1, C.grey);
    pc.round(1, 2, 8, 6, C.silver);
    pc.hline(2, 2, 6, C.white);
    pc.rect(2, 4, 6, 2, C.night);
    pc.set(3, 4, accent);
    pc.set(6, 4, accent);
    pc.rect(2, 8, 6, 1, main);
    if (f === 0) {
      pc.set(2, 9, C.slate);
      pc.set(7, 9, C.slate);
    } else {
      pc.set(1, 9, C.slate);
      pc.set(8, 9, C.slate);
    }
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fw);
  }
  const frames = framesOf(pc, fw, fw, 2);
  botCache.set(agent, frames);
  return frames;
}

export const CAT = { sleep: [0, 1], sit: [2, 3], walkLeft: [4, 5], walkRight: [6, 7] } as const;

/**
 * A cat's fur: main coat, stripes/shade, belly and chin, eyes, and optional markings: calico
 * spots, or siamese points (a dark mask over the face).
 */
export type CatCoat = {
  id: string;
  label: string;
  main: string;
  stripe: string;
  belly: string;
  eye: string;
  patch?: { color: string; style: "spots" | "points" };
};
/** Coats of the office cats; slot 0 (the original cat) is the orange tabby. */
export const CAT_COATS: readonly CatCoat[] = [
  {
    id: "ginger",
    label: "orange tabby",
    main: C.orange,
    stripe: C.clay,
    belly: C.cream,
    eye: C.night,
  },
  {
    id: "midnight",
    label: "black cat",
    main: C.ink,
    stripe: C.dusk,
    belly: C.slate,
    eye: C.lemon,
  },
  { id: "smoke", label: "grey cat", main: C.grey, stripe: C.slate, belly: C.silver, eye: C.night },
  {
    id: "calico",
    label: "calico",
    main: C.white,
    stripe: C.orange,
    belly: C.white,
    eye: C.night,
    patch: { color: C.ink, style: "spots" },
  },
  { id: "snow", label: "white cat", main: C.white, stripe: C.silver, belly: C.white, eye: C.sky },
  { id: "cocoa", label: "brown tabby", main: C.wood, stripe: C.bark, belly: C.sand, eye: C.night },
  {
    id: "latte",
    label: "siamese",
    main: C.cream,
    stripe: C.cocoa,
    belly: C.white,
    eye: C.sky,
    patch: { color: C.bark, style: "points" },
  },
];

const catFrames = new Map<string, Texture[]>();
/** One cat in a coat, 18x14 frames (sleep x2, sit x2, walk left x2, walk right x2). */
export function catTextures(coat: CatCoat = CAT_COATS[0]!): Texture[] {
  const hit = catFrames.get(coat.id);
  if (hit) return hit;
  const fw = 18;
  const fh = 14;
  const pc = new PixelCanvas(fw * 8, fh);
  const O = coat.main;
  const S = coat.stripe;
  const B = coat.belly;
  const E = coat.eye;
  const P = coat.patch?.color;
  const spots = coat.patch?.style === "spots";
  const drawWalk = (f: number) => {
    const step = f % 2;
    pc.rect(5, 5, 9, 4, O); // body
    pc.hline(7, 5, 1, S);
    pc.hline(10, 5, 1, S);
    pc.rect(6, 8, 7, 1, B);
    pc.rect(1, 2, 6, 5, O); // head
    pc.set(1, 1, O);
    pc.set(5, 1, O);
    if (P && spots) {
      pc.rect(9, 5, 3, 2, P);
      pc.set(1, 1, P);
      pc.rect(1, 2, 2, 1, P);
    } else if (P) {
      pc.rect(1, 3, 5, 3, P);
      pc.set(1, 1, P);
      pc.set(5, 1, P);
      pc.vline(14, 3, 3, P);
    }
    pc.set(2, 4, E);
    pc.set(4, 4, E);
    pc.set(3, 5, C.pink);
    pc.rect(2, 6, 3, 1, B);
    pc.vline(14, 3, 3, O); // tail
    pc.set(15, 2, S);
    pc.vline(6 + step, 9, 3, O);
    pc.vline(9 - step, 9, 3, S);
    pc.vline(11 + step, 9, 3, O);
    pc.vline(13 - step, 9, 3, S);
  };
  for (let f = 0; f < 6; f++) {
    pc.at(f * fw + 1, 1);
    if (f < 2) {
      // curled up asleep, breathing
      const b = f;
      pc.ellipse(2, 5 - b, 13, 7 + b, O);
      pc.ellipse(4, 6, 6, 3, B);
      pc.hline(5, 5 - b, 2, S);
      pc.hline(9, 5 - b, 2, S);
      if (P && spots) pc.rect(9, 6 - b, 3, 2, P);
      pc.rect(1, 6, 5, 4, O);
      pc.set(1, 5, O);
      pc.set(4, 5, O);
      if (P && spots) pc.set(1, 5, P);
      else if (P) {
        pc.rect(1, 7, 5, 2, P);
        pc.set(1, 5, P);
        pc.set(4, 5, P);
      }
      pc.hline(2, 8, 1, C.night);
      pc.hline(4, 8, 1, C.night);
      pc.hline(8, 11, 6, S);
    } else if (f < 4) {
      // sitting, tail flick
      pc.rect(4, 5, 6, 7, O);
      pc.rect(5, 8, 4, 4, B);
      pc.rect(3, 0, 8, 6, O);
      pc.set(3, 0, C.night);
      pc.set(10, 0, C.night);
      if (P && spots) {
        pc.rect(3, 1, 3, 2, P);
        pc.set(9, 7, P);
        pc.set(9, 8, P);
      } else if (P) {
        pc.rect(4, 1, 6, 4, P);
        pc.set(3, 0, P);
        pc.set(10, 0, P);
      }
      pc.set(5, 2, E);
      pc.set(8, 2, E);
      pc.set(6, 3, C.pink);
      pc.set(7, 3, C.pink);
      pc.hline(5, 4, 4, B);
      pc.hline(4, 6, 1, S);
      pc.hline(9, 6, 1, S);
      if (f === 2) pc.rect(10, 10, 4, 2, O);
      else {
        pc.rect(10, 9, 2, 3, O);
        pc.set(12, 8, O);
      }
    } else {
      drawWalk(f);
    }
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  for (let f = 6; f < 8; f++) pc.mirrorFrom((f - 2) * fw, 0, fw, fh, f * fw, 0);
  const frames = framesOf(pc, fw, fh, 8);
  catFrames.set(coat.id, frames);
  return frames;
}

const kittenCache = new Map<string, Texture[]>();
/**
 * Helper kitten (2 trot frames, 12x12, facing right like a helper bot walking right): a tiny
 * cat in one of the office coats with a collar in the agent color and a bell.
 */
export function kittenTextures(agent: AgentKind, coat: CatCoat = CAT_COATS[0]!): Texture[] {
  const key = `${agent}:${coat.id}`;
  const hit = kittenCache.get(key);
  if (hit) return hit;
  const fw = 12;
  const pc = new PixelCanvas(fw * 2, fw);
  const O = coat.main;
  const S = coat.stripe;
  const B = coat.belly;
  const E = coat.eye;
  const P = coat.patch?.color;
  const points = coat.patch?.style === "points";
  const collar = AGENT_PALETTES[agent].main;
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 1);
    // tail up behind the body, flicking between frames
    pc.vline(0, 2 + f, 3, points && P ? P : S);
    pc.set(1, 5, O);
    // body with two stripes and a light belly
    pc.rect(1, 5, 6, 3, O);
    pc.set(3, 5, S);
    pc.set(5, 5, S);
    pc.hline(2, 7, 4, B);
    if (P && !points) pc.rect(2, 5, 2, 2, P);
    // head and ears
    pc.rect(5, 1, 5, 4, O);
    pc.set(5, 0, points && P ? P : O);
    pc.set(9, 0, points && P ? P : O);
    if (P && points) pc.rect(6, 2, 4, 3, P);
    pc.set(6, 2, E);
    pc.set(8, 2, E);
    pc.set(7, 3, C.pink);
    pc.hline(6, 4, 3, B);
    // collar in the agent color, with a bell
    pc.hline(5, 5, 4, collar);
    pc.set(7, 6, C.lemon);
    // legs trot: near legs in coat, far legs in shade
    const step = f;
    pc.vline(2 - step, 8, 2, S);
    pc.vline(3 + step, 8, 2, O);
    pc.vline(5 + step, 8, 2, S);
    pc.vline(6 - step, 8, 2, O);
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fw);
  }
  const frames = framesOf(pc, fw, fw, 2);
  kittenCache.set(key, frames);
  return frames;
}

const glowCache = new Map<string, Texture>();
/** Stepped (pixel-art) radial glow for lamps and screens, meant for additive blending. */
export function glowTexture(radius: number, color: string): Texture {
  const key = `${radius}:${color}`;
  const hit = glowCache.get(key);
  if (hit) return hit;
  const d = radius * 2;
  const pc = new PixelCanvas(d, d);
  const steps = [
    [1, 40],
    [0.7, 70],
    [0.42, 110],
  ] as const;
  for (const [f, a] of steps) {
    const s = Math.round(d * f);
    const o = Math.round((d - s) / 2);
    pc.ellipse(o, o, s, s, color, a);
  }
  const t = Texture.from(pc.toCanvas());
  glowCache.set(key, t);
  return t;
}

const badgeCache = new Map<string, Texture>();
/** Small pill with text, e.g. "+3" next to the helper bots. */
export function badgeTexture(text: string, bg: string = C.red): Texture {
  const key = `${text}:${bg}`;
  const hit = badgeCache.get(key);
  if (hit) return hit;
  const w = measureText(text) + 4;
  const pc = new PixelCanvas(w + 2, FONT_HEIGHT + 4);
  pc.at(1, 1);
  pc.round(0, 0, w, FONT_HEIGHT + 2, bg);
  drawText(pc, 2, 1, text, C.white);
  pc.at(0, 0);
  pc.outline();
  const t = Texture.from(pc.toCanvas());
  badgeCache.set(key, t);
  return t;
}

let zzzTex: Texture[] | null = null;
export function zzzTextures(): Texture[] {
  if (zzzTex) return zzzTex;
  const pc = new PixelCanvas(24, 8);
  for (let f = 0; f < 3; f++) {
    pc.at(f * 8, 0);
    for (let i = 0; i <= f; i++) {
      const x = i * 2;
      const y = 5 - i * 2;
      pc.hline(x, y, 3, C.white);
      pc.set(x + 1, y + 1, C.white);
      pc.hline(x, y + 2, 3, C.white);
    }
  }
  pc.at(0, 0);
  zzzTex = framesOf(pc, 8, 8, 3);
  return zzzTex;
}

/** Whiteboard content: today's numbers + a tiny bar chart of the last readings. */
export function whiteboardTexture(
  now: number,
  peak: number,
  started: number,
  history: number[],
): Texture {
  const w = 44;
  const h = 19;
  const pc = new PixelCanvas(w, h);
  drawText(pc, 1, 1, "TODAY", C.red);
  drawText(pc, 1, 7, `NOW ${now}`, C.navy);
  drawText(pc, 1, 13, `PEAK ${peak}`, C.moss);
  void started;
  const bars = history.slice(-8);
  const max = Math.max(1, ...bars);
  bars.forEach((v, i) => {
    const bh = Math.max(1, Math.round((v / max) * 12));
    pc.rect(30 + i * 2, 17 - bh, 1, bh, i === bars.length - 1 ? C.red : C.sky);
  });
  pc.hline(29, 18, 15, C.grey);
  return Texture.from(pc.toCanvas());
}
