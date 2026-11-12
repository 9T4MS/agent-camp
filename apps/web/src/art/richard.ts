/**
 * Richard, the IT guy who lives in the wooden server cabin in the garden: short white-grey
 * hair, a ruddy face, a grey polo, short blue trousers, bare shins and lime-green crocs. Drawn
 * with the shared HD painter (no agent colour, no badge), plus the small things he carries
 * (a fire extinguisher, a RAM stick), the mess he leaves behind and the soot on his roof.
 */
import type { CharacterLook } from "@agent-office/protocol";
import { Rectangle, Texture } from "pixi.js";
import { agentRampOf, type RenderLook } from "./avatar/renderLook.ts";
import { type CharacterSheet, characterSheet } from "./characters.ts";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";

const ramp = (base: string, shadow: string, light: string) => ({ base, shadow, light });
const plain = (a: string) => ({ kind: "none" as const, a, b: "none" as const });
const noButtons = (color: string) => ({
  count: 0,
  color,
  rim: "none" as const,
  size: "small" as const,
});
const POLO = ramp("#6f7975", "#4f5855", "#8f9a95");
const SHORTS = ramp("#3b6db3", "#28497a", "#5b8fd4");
const CROCS = ramp("#8fd14f", "#5c9a2c", "#b8e67c");

export const RICHARD_LOOK: CharacterLook = {
  v: 1,
  build: "broad",
  skin: ramp("#eaa98a", "#c97e64", "#f7c6aa"),
  face: {
    shape: "round",
    ears: "visible",
    eyes: "dot",
    eyeColor: "#2c3e50",
    brows: "thin",
    expression: "smile",
    cheeks: "blush",
  },
  hair: { cut: "short", ramp: ramp("#e4e4ea", "#a9a9b3", "#ffffff"), sheen: true },
  facialHair: { style: "none", color: "#a9a9b3" },
  eyewear: {
    style: "none",
    frame: "#24222a",
    frameAccent: "#24222a",
    framePattern: "solid",
    lens: "#c0cbdc",
    tint: "clear",
  },
  headwear: { style: "none", ramp: POLO, accent: "#ffffff" },
  earrings: { style: "none", color: "#c0cbdc" },
  shirt: {
    kind: "polo",
    ramp: POLO,
    pattern: plain("#6f7975"),
    collar: "polo",
    collarColor: "none",
    neckwear: "none",
    neckwearColor: "#6f7975",
    sleeves: "short",
    buttons: { count: 2, color: "#4f5855", rim: "none", size: "small" },
    peeksAtWaist: false,
  },
  vest: {
    kind: "none",
    ramp: POLO,
    pattern: plain("#6f7975"),
    collar: "none",
    piping: "none",
    buttons: noButtons("#6f7975"),
  },
  outer: {
    kind: "none",
    agentColored: false,
    ramp: POLO,
    pattern: plain("#6f7975"),
    open: false,
    length: "waist",
    collar: "none",
    collarColor: "none",
    collarPiping: "none",
    piping: "none",
    buttons: noButtons("#6f7975"),
    pockets: "none",
    pocketPiping: "none",
    yoke: false,
  },
  bottoms: {
    kind: "shorts",
    ramp: SHORTS,
    pattern: plain("#3b6db3"),
    flap: false,
    embroidery: { motif: "none", color: "#3b6db3", stitching: "none" },
    buttons: noButtons("#3b6db3"),
    suspenders: "none",
    suspendersColor: "#28497a",
    belt: "none",
    hem: "plain",
  },
  legwear: { kind: "none", color: "#eaa98a", accent: "none" },
  // the painter has no crocs: bright slippers with a darker "hole" dot come closest
  shoes: { kind: "slippers", ramp: CROCS, sole: "#5c9a2c", accent: "#4a7d22", laces: "none" },
  pose: { hands: "relaxed", stance: "wide", headTilt: false },
  extras: {
    leftHand: "none",
    rightHand: "none",
    costume: "none",
    wrist: "none",
    accent: "#feae34",
  },
};

export const RICHARD_RENDER: RenderLook = {
  look: RICHARD_LOOK,
  agent: "claude",
  agentRamp: agentRampOf("claude"),
  accent: false,
  hat: false,
  mug: false,
};

export const richardSheet = (): CharacterSheet => characterSheet(RICHARD_RENDER);

function once<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => {
    v ??= make();
    return v;
  };
}

function framesOf(pc: PixelCanvas, fw: number, fh: number, n: number): Texture[] {
  const base = Texture.from(pc.toCanvas());
  return Array.from(
    { length: n },
    (_, i) => new Texture({ source: base.source, frame: new Rectangle(i * fw, 0, fw, fh) }),
  );
}

/** A red fire extinguisher with a black hose (2 frames: the nozzle flickers while spraying). */
export const extinguisherTextures = once(() => {
  const fw = 9;
  const fh = 13;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 1);
    pc.rect(1, 2, 4, 9, C.red);
    pc.vline(4, 3, 7, C.wine);
    pc.vline(1, 3, 6, C.clay);
    pc.rect(1, 5, 4, 2, C.white); // label
    pc.set(2, 5, C.red);
    pc.rect(2, 0, 2, 2, C.ink); // valve
    pc.hline(3, 0, 3, C.slate); // handle
    pc.vline(5, 1, 3, C.ink); // hose
    pc.set(6, 0, C.ink);
    pc.set(6, f ? 0 : 1, f ? C.white : C.ink);
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  return framesOf(pc, fw, fh, 2);
});

/** A green RAM stick with black chips and gold pins (held up high). */
export const ramTexture = once(() => {
  const pc = new PixelCanvas(13, 6);
  pc.at(1, 1);
  pc.rect(0, 0, 11, 3, C.forest);
  pc.hline(0, 0, 11, C.moss);
  for (const x of [1, 4, 7]) pc.rect(x, 1, 2, 2, C.ink);
  pc.set(10, 1, C.white);
  for (let x = 0; x < 11; x += 2) pc.set(x, 3, C.amber);
  pc.set(5, 3, C.forest); // the notch
  pc.at(0, 0);
  pc.outline();
  return Texture.from(pc.toCanvas());
});

/** What Richard leaves lying around: a tangled cable, a screw, a pizza box, a floppy disk. */
export const messTextures = once(() => {
  const fw = 12;
  const fh = 9;
  const pc = new PixelCanvas(fw * 4, fh);
  // 0: tangled cable with a plug
  pc.at(1, 1);
  pc.sprite(
    0,
    0,
    [
      "..kkk.....",
      ".k...k.kk.",
      "k..kk.k..k",
      ".k.k..k.k.",
      "..k.kk..k.",
      "....kkkk..",
      "........ss",
    ],
    {
      k: C.ink,
      s: C.silver,
    },
  );
  // 1: a screw
  pc.at(fw + 3, 2);
  pc.sprite(0, 0, ["sss.", ".g..", ".s..", ".g..", ".s.."], { s: C.silver, g: C.grey });
  // 2: an empty pizza box, lid half open
  pc.at(fw * 2 + 1, 1);
  pc.rect(0, 2, 10, 5, C.sand);
  pc.hline(0, 6, 10, C.tan);
  pc.rect(1, 0, 8, 2, C.cream);
  pc.set(3, 3, C.red);
  pc.set(6, 4, C.amber);
  pc.set(7, 3, C.red);
  // 3: a floppy disk
  pc.at(fw * 3 + 2, 1);
  pc.rect(0, 0, 7, 7, C.navy);
  pc.rect(2, 0, 3, 2, C.silver);
  pc.rect(1, 4, 5, 3, C.white);
  pc.hline(2, 5, 3, C.grey);
  pc.at(0, 0);
  for (let i = 0; i < 4; i++) pc.outline(i * fw, 0, fw, fh);
  return framesOf(pc, fw, fh, 4);
});

/** Black soot on the cabin roof after a fire (fades out over a minute). */
export const sootTexture = once(() => {
  const pc = new PixelCanvas(64, 28);
  const blots = [
    [6, 8, 14, 9],
    [20, 2, 18, 12],
    [40, 6, 16, 11],
    [28, 14, 14, 9],
  ] as const;
  for (const [x, y, w, h] of blots) {
    pc.ellipse(x, y, w, h, C.night, 150);
    pc.ellipse(x + 2, y + 2, w - 4, h - 4, C.ink, 190);
  }
  return Texture.from(pc.toCanvas());
});
