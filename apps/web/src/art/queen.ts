/**
 * The prom queen: a teammate without a coding agent, so she has no desk and no session.
 * Pink satin dress with a silver sash, black tiara, lace gloves, fishnets and silver heels,
 * black roses in one hand and a pager in the other. 20x24 frames (the 16 px body sits 2 px
 * in, so the roses and the pager can stick out), drawn with the shared head painter.
 */
import { Rectangle, Texture } from "pixi.js";
import { drawHead, type Look, type View } from "./legacyDoll.ts";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";

export const QUEEN_W = 20;
export const QUEEN_H = 24;
const PAD = 2;

const DRESS = { main: C.pink, shade: C.berry, light: C.peach };
const SKIN = { main: C.peach, shade: C.tan, light: C.cream };

const LOOK: Look = {
  skin: SKIN,
  hair: { main: C.wood, shade: C.bark, light: C.sand },
  jacket: DRESS,
  badge: DRESS,
  hairStyle: "long",
  glasses: "none",
  facialHair: "none",
  accessory: "none",
  outfit: "tee",
  leftHand: "none",
  rightHand: "none",
  wrist: "none",
  accentColor: "cyan",
  hat: false,
  mug: false,
};

type Pose = "down" | "page";
type Spec = { view: View; phase: number; bob: number; pose: Pose; flash: number; mirror?: number };
const S = (view: View, phase: number, bob = 0, pose: Pose = "down", flash = 0): Spec => ({
  view,
  phase,
  bob,
  pose,
  flash,
});

const SPECS: Spec[] = [
  /* 0-1 idle */ S("down", 0),
  S("down", 0, 1),
  /* 2-5 walk down */ S("down", 0),
  S("down", 1),
  S("down", 2),
  S("down", 3),
  /* 6-9 walk up */ S("up", 0),
  S("up", 1),
  S("up", 2),
  S("up", 3),
  /* 10-13 walk left */ S("left", 0),
  S("left", 1),
  S("left", 2),
  S("left", 3),
  /* 14-17 walk right */ { ...S("left", 0), mirror: 10 },
  { ...S("left", 1), mirror: 11 },
  { ...S("left", 2), mirror: 12 },
  { ...S("left", 3), mirror: 13 },
  /* 18-19 paging: pager up, screen blinking */ S("down", 0, 0, "page", 1),
  S("down", 0, 0, "page", 0),
];

export const QUEEN = {
  idle: [0, 1],
  walkDown: [2, 3, 4, 5],
  walkUp: [6, 7, 8, 9],
  walkLeft: [10, 11, 12, 13],
  walkRight: [14, 15, 16, 17],
  page: [18, 19],
} as const;

type After = ((pc: PixelCanvas) => void)[];

function fishnet(pc: PixelCanvas, x: number, y: number, w: number, h: number) {
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) pc.set(i, j, (i + j) % 2 ? SKIN.main : C.white);
}

function heel(pc: PixelCanvas, x: number, y: number, w: number) {
  pc.hline(x, y, w, C.silver);
  pc.set(x, y, C.white);
}

function legs(pc: PixelCanvas, view: View, phase: number) {
  if (view === "left") {
    if (phase === 1 || phase === 3) {
      fishnet(pc, 5, 20, 2, 2);
      fishnet(pc, 9, 20, 2, 2);
      heel(pc, 4, 22, 3);
      heel(pc, 9, 22, 3);
    } else {
      fishnet(pc, 6, 19, 3, 3);
      heel(pc, 5, 22, 4);
    }
    return;
  }
  const lUp = phase === 1 ? 1 : 0;
  const rUp = phase === 3 ? 1 : 0;
  fishnet(pc, 5, 19, 2, 3 - lUp);
  fishnet(pc, 9, 19, 2, 3 - rUp);
  pc.set(6, 20, SKIN.main); // a run in the tights
  heel(pc, 5, 22 - lUp, 2);
  heel(pc, 9, 22 - rUp, 2);
}

/** Skirt with its satin flounce, and the grey tulle hanging out underneath. */
function skirt(pc: PixelCanvas, view: View, top: number) {
  const x = view === "left" ? 4 : 3;
  const w = view === "left" ? 8 : 10;
  pc.rect(x + 1, top, w - 2, 1, DRESS.main);
  pc.rect(x, top + 1, w, 2, DRESS.main);
  pc.vline(x + w - 1, top + 1, 2, DRESS.shade);
  for (let i = x + 1; i < x + w - 1; i += 3) pc.set(i, top + 1, DRESS.light);
  for (let i = x; i < x + w; i++) pc.set(i, top + 3, i % 2 ? C.silver : C.grey);
  if (view === "down") {
    pc.set(5, top, DRESS.light); // the bow
    pc.set(6, top, DRESS.light);
  }
}

function bodice(pc: PixelCanvas, view: View, top: number) {
  if (view === "left") {
    pc.rect(5, top, 6, 5, DRESS.main);
    pc.vline(10, top, 5, DRESS.shade);
    for (let k = 0; k < 4; k++) pc.set(6 + k, top + k, C.silver);
    return;
  }
  pc.rect(4, top, 8, 5, DRESS.main);
  pc.vline(11, top, 5, DRESS.shade);
  pc.hline(4, top + 4, 8, DRESS.shade);
  if (view === "down") {
    pc.rect(8, top, 4, 1, SKIN.main); // one-shoulder neckline
    for (let k = 0; k < 7; k++) {
      pc.set(4 + k, top + k, C.silver);
      if (5 + k < 12) pc.set(5 + k, top + k, C.white);
    }
    pc.set(6, top + 2, C.night); // lettering on the sash
    pc.set(8, top + 4, C.night);
  } else {
    pc.rect(4, top, 3, 1, SKIN.main);
    for (let k = 0; k < 7; k++) pc.set(11 - k, top + k, C.silver);
  }
}

/** Bare upper arm, lace glove below, hand at the end. Returns the hand row. */
function arm(pc: PixelCanvas, x: number, top: number, len: number) {
  pc.vline(x, top, 2, SKIN.main);
  pc.vline(x, top + 2, len - 2, C.silver);
  pc.set(x, top + 3, C.white);
  pc.set(x, top + len, SKIN.main);
  return top + len;
}

function roses(pc: PixelCanvas, x: number, y: number) {
  pc.rect(x, y, 3, 3, C.ink);
  pc.set(x + 1, y, C.night);
  pc.set(x, y + 1, C.red);
  pc.set(x + 2, y + 2, C.forest);
  pc.set(x + 2, y + 3, C.forest);
}

function pager(pc: PixelCanvas, x: number, y: number, flash: number) {
  pc.rect(x, y, 2, 2, C.ink);
  pc.set(x, y, flash ? C.neon : C.leaf);
}

function tiara(pc: PixelCanvas, view: View, dy: number) {
  const w = view === "left" ? 5 : 6;
  pc.hline(5, 1 + dy, w, C.ink);
  for (let i = 5; i < 5 + w; i += 2) pc.set(i, dy, C.ink);
  pc.set(7, 1 + dy, C.silver);
}

function paint(pc: PixelCanvas, f: Spec, after: After) {
  const top = 12 + f.bob;
  legs(pc, f.view, f.phase);
  skirt(pc, f.view, 17 + f.bob);
  bodice(pc, f.view, top);
  if (f.view === "left") {
    const ax = f.phase === 1 ? -1 : f.phase === 3 ? 1 : 0;
    pc.rect(7, top, 2, 2, SKIN.main);
    pc.rect(7 + ax, top + 2, 2, 2, C.silver);
    pc.rect(7 + ax * 2, top + 4, 2, 1, SKIN.main);
    pager(pc, 5 + ax * 2, top + 4, 0);
  } else if (f.view === "up") {
    const hl = arm(pc, 3, top, f.phase === 3 ? 4 : 5);
    const hr = arm(pc, 12, top, f.phase === 1 ? 4 : 5);
    pager(pc, 1, hl - 1, 0);
    roses(pc, 13, hr - 4);
  } else {
    pc.set(2, top, SKIN.main);
    pc.vline(1, top - 3, 4, C.silver);
    pc.set(1, top - 2, C.white);
    pc.set(1, top - 4, SKIN.main);
    if (f.pose === "page") {
      pc.vline(12, top, 2, SKIN.main);
      pc.vline(13, top - 5, 2, SKIN.main);
      pc.vline(13, top - 3, 4, C.silver);
      pc.rect(13, top - 6, 2, 1, SKIN.main);
      pager(pc, 14, top - 8, f.flash);
      if (f.flash) {
        after.push((p) => {
          p.set(16, top - 9, C.white);
          p.set(17, top - 10, C.white);
          p.set(17, top - 8, C.lemon);
        });
      }
    } else {
      const hr = arm(pc, 12, top, f.phase === 3 ? 4 : 5);
      pager(pc, 13, hr - 1, 0);
    }
  }
  drawHead(pc, LOOK, f.view, f.bob);
  tiara(pc, f.view, f.bob);
  if (f.view === "down") roses(pc, -1, top - 8);
}

let frames: Texture[] | null = null;

export function paintQueen(): PixelCanvas {
  const pc = new PixelCanvas(QUEEN_W * SPECS.length, QUEEN_H);
  SPECS.forEach((spec, i) => {
    if (spec.mirror !== undefined) return;
    const after: After = [];
    pc.at(i * QUEEN_W + PAD, 0);
    paint(pc, spec, after);
    pc.at(0, 0);
    pc.outline(i * QUEEN_W, 0, QUEEN_W, QUEEN_H);
    pc.at(i * QUEEN_W + PAD, 0);
    for (const p of after) p(pc);
    pc.at(0, 0);
  });
  SPECS.forEach((spec, i) => {
    if (spec.mirror !== undefined)
      pc.mirrorFrom(spec.mirror * QUEEN_W, 0, QUEEN_W, QUEEN_H, i * QUEEN_W, 0);
  });
  return pc;
}

export function queenTextures(): Texture[] {
  if (frames) return frames;
  const base = Texture.from(paintQueen().toCanvas());
  frames = SPECS.map(
    (_, i) =>
      new Texture({ source: base.source, frame: new Rectangle(i * QUEEN_W, 0, QUEEN_W, QUEEN_H) }),
  );
  return frames;
}
