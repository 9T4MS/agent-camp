/**
 * Looks of the residents without a coding agent (the head of sales, who also runs the
 * kitchen, the head of development and Kurt in his own office) and of the clients at the
 * sales stand. They are drawn
 * with the same HD painter as everybody else; no agent colour, no badge.
 */
import { avatarFromSeed, type CharacterLook, resolveLook } from "@agent-office/protocol";
import { agentRampOf, type RenderLook } from "./avatar/renderLook.ts";
import { type CharacterSheet, characterSheet } from "./characters.ts";

const ramp = (base: string, shadow: string, light: string) => ({ base, shadow, light });
const plain = (a: string) => ({ kind: "none" as const, a, b: "none" as const });
const noButtons = (color: string) => ({
  count: 0,
  color,
  rim: "none" as const,
  size: "small" as const,
});
const NAVY = ramp("#26355e", "#18213d", "#3a4d80");
const BLACK = ramp("#24222a", "#141218", "#3b3842");

/** Head of sales and cook: silver slicked-back hair, clear glasses, navy suit, a big grin. */
export const SALES_LOOK: CharacterLook = {
  v: 1,
  build: "average",
  skin: ramp("#e8b08c", "#c98a6b", "#f6caa6"),
  face: {
    shape: "oval",
    ears: "small",
    eyes: "narrow",
    eyeColor: "#3e2731",
    brows: "thin",
    expression: "grin",
    cheeks: "none",
  },
  hair: { cut: "slicked-back", ramp: ramp("#9a9aa3", "#5f5f69", "#d2d2d8"), sheen: true },
  facialHair: { style: "stubble", color: "#8a8178" },
  eyewear: {
    style: "panto",
    frame: "#c0cbdc",
    frameAccent: "#8b9bb4",
    framePattern: "solid",
    lens: "#e4eef5",
    tint: "clear",
  },
  headwear: { style: "none", ramp: NAVY, accent: "#ffffff" },
  earrings: { style: "none", color: "#c0cbdc" },
  shirt: {
    kind: "shirt",
    ramp: ramp("#f4f6fa", "#c0cbdc", "#ffffff"),
    pattern: { kind: "pinstripe", a: "#9fb2d4", b: "none" },
    collar: "shirt",
    collarColor: "none",
    neckwear: "none",
    neckwearColor: "#ffffff",
    sleeves: "long",
    buttons: noButtons("#ffffff"),
    peeksAtWaist: false,
  },
  vest: {
    kind: "none",
    ramp: NAVY,
    pattern: plain("#26355e"),
    collar: "none",
    piping: "none",
    buttons: noButtons("#26355e"),
  },
  outer: {
    kind: "blazer",
    agentColored: false,
    ramp: NAVY,
    pattern: plain("#26355e"),
    open: true,
    length: "hip",
    collar: "lapel",
    collarColor: "none",
    collarPiping: "none",
    piping: "none",
    buttons: { count: 2, color: "#18213d", rim: "none", size: "small" },
    pockets: "flap",
    pocketPiping: "none",
    yoke: false,
  },
  bottoms: {
    kind: "trousers",
    ramp: NAVY,
    pattern: plain("#26355e"),
    flap: false,
    embroidery: { motif: "none", color: "#26355e", stitching: "none" },
    buttons: noButtons("#26355e"),
    suspenders: "none",
    suspendersColor: "#18213d",
    belt: "#3e2731",
    hem: "plain",
  },
  legwear: { kind: "crew-socks", color: "#18213d", accent: "none" },
  shoes: {
    kind: "loafers",
    ramp: ramp("#2a2027", "#141016", "#4a3a44"),
    sole: "#141016",
    accent: "none",
    laces: "none",
  },
  pose: { hands: "relaxed", stance: "neutral", headTilt: false },
  extras: {
    leftHand: "none",
    rightHand: "none",
    costume: "none",
    wrist: "none",
    accent: "#feae34",
  },
};

/** Head of development: long straight red hair with a middle parting, black sweater. */
export const HEAD_DEV_LOOK: CharacterLook = {
  v: 1,
  build: "slim",
  skin: ramp("#f3c9ad", "#d9a184", "#fde0cb"),
  face: {
    shape: "oval",
    ears: "hidden",
    eyes: "round",
    eyeColor: "#5a6b58",
    brows: "thin",
    expression: "smirk",
    cheeks: "freckles",
  },
  hair: { cut: "long", ramp: ramp("#b4492a", "#7a2c1b", "#df7440"), sheen: true },
  facialHair: { style: "none", color: "#7a2c1b" },
  eyewear: {
    style: "none",
    frame: "#24222a",
    frameAccent: "#24222a",
    framePattern: "solid",
    lens: "#c0cbdc",
    tint: "clear",
  },
  headwear: { style: "none", ramp: BLACK, accent: "#ffffff" },
  earrings: { style: "none", color: "#c0cbdc" },
  shirt: {
    kind: "sweater",
    ramp: BLACK,
    pattern: plain("#24222a"),
    collar: "crew",
    collarColor: "none",
    neckwear: "none",
    neckwearColor: "#24222a",
    sleeves: "long",
    buttons: noButtons("#24222a"),
    peeksAtWaist: false,
  },
  vest: {
    kind: "none",
    ramp: BLACK,
    pattern: plain("#24222a"),
    collar: "none",
    piping: "none",
    buttons: noButtons("#24222a"),
  },
  outer: {
    kind: "none",
    agentColored: false,
    ramp: BLACK,
    pattern: plain("#24222a"),
    open: false,
    length: "waist",
    collar: "none",
    collarColor: "none",
    collarPiping: "none",
    piping: "none",
    buttons: noButtons("#24222a"),
    pockets: "none",
    pocketPiping: "none",
    yoke: false,
  },
  bottoms: {
    kind: "jeans",
    ramp: ramp("#3a4466", "#262b44", "#5a6988"),
    pattern: plain("#3a4466"),
    flap: false,
    embroidery: { motif: "none", color: "#3a4466", stitching: "none" },
    buttons: noButtons("#3a4466"),
    suspenders: "none",
    suspendersColor: "#262b44",
    belt: "none",
    hem: "plain",
  },
  legwear: { kind: "ankle-socks", color: "#24222a", accent: "none" },
  shoes: {
    kind: "boots",
    ramp: BLACK,
    sole: "#141218",
    accent: "none",
    laces: "none",
  },
  pose: { hands: "relaxed", stance: "neutral", headTilt: false },
  extras: {
    leftHand: "none",
    rightHand: "none",
    costume: "none",
    wrist: "none",
    accent: "#feae34",
  },
};

const CHARCOAL = ramp("#3d3b42", "#26242b", "#5a5760");
const SLATE_GREY = ramp("#4f4b52", "#333036", "#6d6873");

/** Kurt: bald, short grey beard, tortoiseshell glasses, a big grin, open blazer over light blue. */
export const KURT_LOOK: CharacterLook = {
  v: 1,
  build: "broad",
  skin: ramp("#efbfa0", "#cf977c", "#fbd6bd"),
  face: {
    shape: "round",
    ears: "visible",
    eyes: "narrow",
    eyeColor: "#3e2731",
    brows: "thick",
    expression: "grin",
    cheeks: "blush",
  },
  hair: { cut: "bald", ramp: ramp("#9a8f86", "#6e655e", "#c4bab0"), sheen: false },
  facialHair: { style: "beard", color: "#9a8f86" },
  eyewear: {
    style: "rectangle",
    frame: "#5a3a26",
    frameAccent: "#c88a4a",
    framePattern: "tortoiseshell",
    lens: "#e4eef5",
    tint: "clear",
  },
  headwear: { style: "none", ramp: CHARCOAL, accent: "#ffffff" },
  earrings: { style: "none", color: "#c0cbdc" },
  shirt: {
    kind: "shirt",
    ramp: ramp("#bcd3ee", "#8ea9cc", "#e2edf8"),
    pattern: plain("#bcd3ee"),
    collar: "shirt",
    collarColor: "none",
    neckwear: "none",
    neckwearColor: "#ffffff",
    sleeves: "long",
    buttons: noButtons("#ffffff"),
    peeksAtWaist: false,
  },
  vest: {
    kind: "none",
    ramp: CHARCOAL,
    pattern: plain("#3d3b42"),
    collar: "none",
    piping: "none",
    buttons: noButtons("#3d3b42"),
  },
  outer: {
    kind: "blazer",
    agentColored: false,
    ramp: CHARCOAL,
    pattern: plain("#3d3b42"),
    open: true,
    length: "hip",
    collar: "lapel",
    collarColor: "none",
    collarPiping: "none",
    piping: "none",
    buttons: { count: 2, color: "#26242b", rim: "none", size: "small" },
    pockets: "flap",
    pocketPiping: "none",
    yoke: false,
  },
  bottoms: {
    kind: "chinos",
    ramp: SLATE_GREY,
    pattern: plain("#4f4b52"),
    flap: false,
    embroidery: { motif: "none", color: "#4f4b52", stitching: "none" },
    buttons: noButtons("#4f4b52"),
    suspenders: "none",
    suspendersColor: "#333036",
    belt: "#3e2731",
    hem: "plain",
  },
  legwear: { kind: "crew-socks", color: "#26242b", accent: "none" },
  shoes: {
    kind: "loafers",
    ramp: ramp("#6b4430", "#3e2731", "#8f5d43"),
    sole: "#2a1d19",
    accent: "none",
    laces: "none",
  },
  pose: { hands: "relaxed", stance: "neutral", headTilt: false },
  extras: {
    leftHand: "none",
    rightHand: "none",
    costume: "none",
    wrist: "none",
    accent: "#feae34",
  },
};

const SUITS = [
  ramp("#5a6988", "#3a4466", "#8b9bb4"),
  ramp("#4a4650", "#2e2b33", "#6d6873"),
  ramp("#733e39", "#3e2731", "#a05b53"),
  ramp("#265c42", "#193c3e", "#3e8948"),
];

function render(look: CharacterLook): RenderLook {
  return {
    look,
    agent: "claude",
    agentRamp: agentRampOf("claude"),
    accent: false,
    hat: false,
    mug: false,
  };
}

/** A client at the sales stand: a random face from the catalog in a suit. */
export function clientLook(i: number): CharacterLook {
  const base = resolveLook(avatarFromSeed(`client-${i}`));
  const suit = SUITS[i % SUITS.length]!;
  return {
    ...base,
    outer: {
      ...base.outer,
      kind: "blazer",
      agentColored: false,
      ramp: suit,
      pattern: plain(suit.base),
      open: true,
      length: "hip",
      collar: "lapel",
    },
    bottoms: { ...base.bottoms, kind: "trousers", ramp: suit, pattern: plain(suit.base) },
    extras: {
      leftHand: "none",
      rightHand: "none",
      costume: "none",
      wrist: "none",
      accent: "#feae34",
    },
  };
}

export const salesSheet = (): CharacterSheet => characterSheet(render(SALES_LOOK));
export const headDevSheet = (): CharacterSheet => characterSheet(render(HEAD_DEV_LOOK));
export const kurtSheet = (): CharacterSheet => characterSheet(render(KURT_LOOK));
export const clientSheet = (i: number): CharacterSheet => characterSheet(render(clientLook(i)));
