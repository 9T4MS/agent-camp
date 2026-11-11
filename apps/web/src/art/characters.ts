/**
 * Paper-doll characters, ~16x24 px, drawn pixel by pixel from small ASCII layers:
 * skin head -> hair (per style and view) -> facial hair -> glasses -> accessory/hat,
 * body = outfit (jacket/hoodie in the agent color, or flannel/tee with an agent badge)
 * + pants + shoes + held items, then a 1-px dark outline (thin things like a joint and
 * its smoke are drawn after the outline so they stay thin).
 *
 * One sheet (35 frames) per look; looks are cached by key so siblings and re-joins reuse.
 */
import {
  AGENT_COLORED_OUTFITS,
  AGENT_PALETTES,
  type AgentKind,
  type AvatarSpec,
  hairColorHex,
  type SessionVariation,
  skinToneHex,
} from "@agent-office/protocol";
import { Rectangle, Texture } from "pixi.js";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";

export const CHAR_W = 16;
export const CHAR_H = 24;

type Ramp = { main: string; shade: string; light: string };
export type Look = {
  skin: Ramp;
  hair: Ramp;
  /** the top garment (agent color for jacket/hoodie) */
  jacket: Ramp;
  /** agent color: shown as a badge on outfits that are not agent colored */
  badge: Ramp;
  hairStyle: AvatarSpec["hairStyle"];
  glasses: AvatarSpec["glasses"];
  facialHair: AvatarSpec["facialHair"];
  accessory: AvatarSpec["accessory"];
  outfit: AvatarSpec["outfit"];
  leftHand: AvatarSpec["leftHand"];
  rightHand: AvatarSpec["rightHand"];
  hat: boolean;
  mug: boolean;
};

/** Garment colors of the outfits that are not agent colored. */
const OUTFIT_RAMPS: Partial<Record<AvatarSpec["outfit"], Ramp>> = {
  flannel: { main: C.grey, shade: C.slate, light: C.silver },
  "flannel-red": { main: C.red, shade: C.wine, light: C.pink },
  tee: { main: C.dusk, shade: C.ink, light: C.slate },
};
/** Plaid lines over a flannel: dark bands across, light threads down. */
const PLAID: Partial<Record<AvatarSpec["outfit"], { dark: string; light: string }>> = {
  flannel: { dark: C.dusk, light: C.white },
  "flannel-red": { dark: C.night, light: C.pink },
};
/** The navy tee under an open flannel. */
const TEE = C.ink;
const isFlannel = (o: AvatarSpec["outfit"]) => o === "flannel" || o === "flannel-red";
const CAPS: readonly AvatarSpec["accessory"][] = ["beanie", "cap", "cap-mint"];

export function lookFor(
  avatar: AvatarSpec,
  agent: AgentKind,
  variation: SessionVariation | null,
): Look {
  const sk = skinToneHex(avatar.skinTone);
  const hc = hairColorHex(avatar.hairColor);
  let hair: Ramp = { main: hc.hex, shade: hc.shade, light: hc.light };
  if (variation?.hairShade === 1) hair = { main: hc.light, shade: hc.hex, light: hc.light };
  if (variation?.hairShade === -1 && hc.shade !== C.night) {
    hair = { main: hc.shade, shade: hc.shade === C.cocoa ? C.night : C.cocoa, light: hc.hex };
  }
  const j = AGENT_PALETTES[agent];
  const badge: Ramp = { main: j.main, shade: j.shade, light: j.light };
  const outfit = avatar.outfit ?? "jacket";
  const leftHand = avatar.leftHand ?? "none";
  const rightHand = avatar.rightHand ?? "none";
  return {
    skin: { main: sk.hex, shade: sk.shade, light: sk.light },
    hair,
    jacket: AGENT_COLORED_OUTFITS.includes(outfit) ? badge : (OUTFIT_RAMPS[outfit] ?? badge),
    badge,
    hairStyle: avatar.hairStyle,
    glasses: avatar.glasses,
    facialHair: avatar.facialHair,
    accessory: avatar.accessory,
    outfit,
    leftHand,
    rightHand,
    hat: !!variation?.hat && !CAPS.includes(avatar.accessory),
    // hands already full: no session mug
    mug: !!variation?.mug && leftHand === "none" && rightHand === "none",
  };
}

export function lookKey(l: Look): string {
  return [
    l.skin.main,
    l.hair.main,
    l.hair.shade,
    l.jacket.main,
    l.badge.main,
    l.outfit,
    l.leftHand,
    l.rightHand,
    l.hairStyle,
    l.glasses,
    l.facialHair,
    l.accessory,
    l.hat ? 1 : 0,
    l.mug ? 1 : 0,
  ].join("|");
}

// ---- frame table ----------------------------------------------------------------------------
type View = "down" | "up" | "left";
type Seat = "none" | "back" | "front";
type Arms =
  | "down"
  | "type0"
  | "type1"
  | "book0"
  | "book1"
  | "raise0"
  | "raise1"
  | "wave0"
  | "wave1"
  | "rest";
type FrameSpec = {
  view: View;
  seat: Seat;
  phase: number;
  arms: Arms;
  bob: number;
  mirror?: number;
};

const F = (view: View, seat: Seat, phase: number, arms: Arms, bob = 0): FrameSpec => ({
  view,
  seat,
  phase,
  arms,
  bob,
});

const SPECS: FrameSpec[] = [
  /* 0 */ F("down", "none", 0, "down"),
  /* 1 */ F("down", "none", 0, "down", 1),
  /* 2-5 walk down */ F("down", "none", 0, "down"),
  F("down", "none", 1, "down"),
  F("down", "none", 2, "down"),
  F("down", "none", 3, "down"),
  /* 6-9 walk up */ F("up", "none", 0, "down"),
  F("up", "none", 1, "down"),
  F("up", "none", 2, "down"),
  F("up", "none", 3, "down"),
  /* 10-13 walk left */ F("left", "none", 0, "down"),
  F("left", "none", 1, "down"),
  F("left", "none", 2, "down"),
  F("left", "none", 3, "down"),
  /* 14-17 walk right (mirrors) */ { ...F("left", "none", 0, "down"), mirror: 10 },
  { ...F("left", "none", 1, "down"), mirror: 11 },
  { ...F("left", "none", 2, "down"), mirror: 12 },
  { ...F("left", "none", 3, "down"), mirror: 13 },
  /* 18-19 sit typing */ F("up", "back", 0, "type0"),
  F("up", "back", 0, "type1"),
  /* 20-21 sit reading */ F("up", "back", 0, "book0"),
  F("up", "back", 0, "book1"),
  /* 22-23 sit idle */ F("up", "back", 0, "down"),
  F("up", "back", 0, "down", 1),
  /* 24-25 raise hand */ F("down", "front", 0, "raise0"),
  F("down", "front", 0, "raise1"),
  /* 26-27 wave */ F("down", "none", 0, "wave0"),
  F("down", "none", 0, "wave1"),
  /* 28-29 sit front */ F("down", "front", 0, "rest"),
  F("down", "front", 0, "rest", 1),
  /* 30 idle up */ F("up", "none", 0, "down"),
  /* 31 idle left */ F("left", "none", 0, "down"),
  /* 32 idle right */ { ...F("left", "none", 0, "down"), mirror: 31 },
  /* 33-34 busy standing (arcade, whiteboard) */ F("up", "none", 0, "type0"),
  F("up", "none", 0, "type1"),
];

export const ANIM = {
  idleDown: [0, 1],
  walkDown: [2, 3, 4, 5],
  walkUp: [6, 7, 8, 9],
  walkLeft: [10, 11, 12, 13],
  walkRight: [14, 15, 16, 17],
  sitType: [18, 19],
  sitRead: [20, 21],
  sitIdle: [22, 23],
  raiseHand: [24, 25],
  wave: [26, 27],
  sitFront: [28, 29],
  idleUp: [30],
  idleLeft: [31],
  idleRight: [32],
  play: [33, 34],
} as const;
export type AnimName = keyof typeof ANIM;
export type CharacterSheet = { frames: Texture[]; anims: Record<AnimName, Texture[]> };

// ---- hair layers (rows from y=0, 16 wide; h main, H shade, L light, R ribbon) ------------------
type Layer = readonly string[];
const SHORT_TOP = [
  "................",
  "................",
  "....hhhhhhhh....",
  "...hhLLhhhhhh...",
  "..hhLhhhhhhhHh..",
  "..hhhhhhhhhhHh..",
];
const HAIR: Record<AvatarSpec["hairStyle"], Record<View, Layer>> = {
  short: {
    down: [...SHORT_TOP, "..hhhh....hhHh..", "..h..........H.."],
    up: [
      ...SHORT_TOP,
      "..hhhhhhhhhhHh..",
      "..hhhhhhhhhhHh..",
      "..hhhhhhhhhhHh..",
      "...HhhhhhhhhH...",
      "....HHHHHHHH....",
    ],
    left: [
      "................",
      "................",
      ".....hhhhhh.....",
      "....hLLhhhhhh...",
      "...hhhhhhhhhhh..",
      "...hhhhhhhhhHh..",
      "...hh.hhhhhhHh..",
      ".........hhhHh..",
      ".........hhhHh..",
      ".........hhhH...",
      "..........HH....",
    ],
  },
  buzz: {
    down: ["", "", "", "....HHHHHHHH....", "...HhHhHhHhHH...", "...H........H..."],
    up: [
      "",
      "",
      "",
      "....HHHHHHHH....",
      "...HhHhHhHhHH...",
      "...hHhHhHhHhH...",
      "...HhHhHhHhHH...",
      "...hHhHhHhHhH...",
      "...HhHhHhHhHH...",
      "....HHHHHHHH....",
    ],
    left: [
      "",
      "",
      "",
      ".....HHHHHH.....",
      "....HhHhHhHH....",
      "....H...hHhH....",
      ".........HhH....",
      ".........HhH....",
      "..........HH....",
    ],
  },
  long: {
    down: [
      ...SHORT_TOP,
      "..hhhh....hhHh..",
      "..hh........Hh..",
      "..hh........Hh..",
      "..hh........Hh..",
      "..hh........Hh..",
      "..hh........Hh..",
      "..hh........Hh..",
      "..Hh........hH..",
      "..H..........H..",
    ],
    up: [
      ...SHORT_TOP,
      "..hhhhhhhhhhHh..",
      "..hhhhhhhhhhHh..",
      "..hhhhhhhhhhHh..",
      "..hhhhhhhhhhHh..",
      "..hhhhhhhhhhHh..",
      "..hhhhhhhhhhHh..",
      "..hhhhhhhhhhHh..",
      "..hhhhhhhhhhHh..",
      "..HhhhhhhhhhHH..",
      "...HHhHHhHHhH...",
    ],
    left: [
      "................",
      "................",
      ".....hhhhhh.....",
      "....hLLhhhhhh...",
      "...hhhhhhhhhhh..",
      "...hhhhhhhhhHh..",
      "...hh.hhhhhhHh..",
      "........hhhhHh..",
      "........hhhhHh..",
      "........hhhhHh..",
      "........hhhhHh..",
      "........hhhhHh..",
      "........hhhhHh..",
      ".........hhhHh..",
      ".........hhHH...",
    ],
  },
  bun: {
    down: [
      "......hhhh......",
      ".....hLhhhH.....",
      ...SHORT_TOP.slice(2),
      "..hhhh....hhHh..",
      "..h..........H..",
    ],
    up: [
      "......hhhh......",
      ".....hLhhhH.....",
      ...SHORT_TOP.slice(2),
      "..hhhhhhhhhhHh..",
      "..hhhhhhhhhhHh..",
      "..hhhhhhhhhhHh..",
      "...HhhhhhhhhH...",
      "....HHHHHHHH....",
    ],
    left: [
      ".........hhh....",
      "........hLhhH...",
      ".....hhhhhhH....",
      "....hLLhhhhhh...",
      "...hhhhhhhhhhh..",
      "...hhhhhhhhhHh..",
      "...hh.hhhhhhHh..",
      ".........hhhHh..",
      ".........hhhHh..",
      ".........hhhH...",
      "..........HH....",
    ],
  },
  curly: {
    down: [
      "................",
      "....hh.hh.hh....",
      "..hhhhhhhhhhhh..",
      ".hhhLhhhhLhhhhh.",
      ".hhLhhhhhhhhhHh.",
      ".hhhhhhhhhhhhHh.",
      ".hhhhh.hh.hhhHh.",
      ".hhh........hHh.",
      ".hh..........Hh.",
      "..h..........H..",
    ],
    up: [
      "................",
      "....hh.hh.hh....",
      "..hhhhhhhhhhhh..",
      ".hhhLhhhhLhhhhh.",
      ".hhLhhhhhhhhhHh.",
      ".hhhhhhhhhhhhHh.",
      ".hhhhhhhhhhhhHh.",
      ".hhhhhhhhhhhhHh.",
      ".hhhhhhhhhhhhHh.",
      ".hhhhhhhhhhhhHh.",
      "..hhhhhhhhhhHh..",
      "...H.HH.HH.H....",
    ],
    left: [
      "................",
      ".....hh.hh......",
      "...hhhhhhhhhh...",
      "..hhhLhhhhhhhh..",
      "..hhLhhhhhhhhHh.",
      "..hhhhhhhhhhhHh.",
      "..hh.hhhhhhhhHh.",
      "..h......hhhhHh.",
      ".........hhhhHh.",
      ".........hhhhH..",
      "..........HHH...",
    ],
  },
  ponytail: {
    down: [
      ...SHORT_TOP,
      "..hhh......hHh..",
      "..h..........hH.",
      ".............hH.",
      ".............Hh.",
      "..............H.",
    ],
    up: [
      ...SHORT_TOP,
      "..hhhhhhhhhhHh..",
      "..hhhhhhhhhhHh..",
      "..hhhhhhhhhhHh..",
      "...HhhhRRhhhH...",
      "....HHHhhHHH....",
      ".......hH.......",
      ".......hH.......",
      ".......hH.......",
      "........H.......",
    ],
    left: [
      "................",
      "................",
      ".....hhhhhh.....",
      "....hLLhhhhhh...",
      "...hhhhhhhhhhh..",
      "...hhhhhhhhhHhR.",
      "...hh.hhhhhhHhhh",
      ".........hhhH.hH",
      ".........hhhH.hH",
      ".........hhhH..H",
      "..........HH....",
    ],
  },
  mohawk: {
    down: [
      ".......hh.......",
      "......hLhh......",
      "......hhhh......",
      "....HHhhhhHH....",
      "...H..hhhh..H...",
      "...H........H...",
    ],
    up: [
      ".......hh.......",
      "......hLhh......",
      "......hhhh......",
      "....HHhhhhHH....",
      "...HHHhhhhHHH...",
      "...HHHhhhhHHH...",
      "...HHHhhhhHHH...",
      "...HHHhhhhHHH...",
      "....HHhhhhHH....",
      "......hhhh......",
    ],
    left: [
      ".......hhh......",
      "......hLhhh.....",
      ".....hhhhhhh....",
      "....HHHHhhhhh...",
      "....H...HHhH....",
      ".........HHH....",
      ".........HHH....",
      "..........H.....",
    ],
  },
  bald: {
    down: ["", "", "", "", ".....LL........."],
    up: ["", "", "", "", "......LL........", ".....L.........."],
    left: ["", "", "", "", ".....LL........."],
  },
};

const FACIAL: Record<Exclude<AvatarSpec["facialHair"], "none">, Record<"down" | "left", Layer>> = {
  beard: {
    down: [
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "...h........h...",
      "...hh......hh...",
      "....hhhhhhhh....",
      ".....hhhhhh.....",
    ],
    left: [
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "........h.......",
      "....h..hhh......",
      ".....hhhhh......",
      "......hhh.......",
    ],
  },
  mustache: {
    down: ["", "", "", "", "", "", "", "", "", "", "......hhhh......"],
    left: ["", "", "", "", "", "", "", "", "", "", "...hh..........."],
  },
  stubble: {
    down: ["", "", "", "", "", "", "", "", "", "", "....S.S..S.S....", ".....S.SS.S....."],
    left: ["", "", "", "", "", "", "", "", "", "", "....S.S.........", ".....S.S........"],
  },
};

const GLASSES_L: Record<Exclude<AvatarSpec["glasses"], "none">, Record<"down" | "left", Layer>> = {
  round: {
    down: ["", "", "", "", "", "", "", "....gg.gg.gg....", ".....g.gg.g....."],
    left: ["", "", "", "", "", "", "", "....g.gg........", "....g.g........."],
  },
  square: {
    down: ["", "", "", "", "", "", "....gggggggg....", ".....g.gg.g.....", ".....gggggg....."],
    left: ["", "", "", "", "", "", "....ggg.........", "....g.gg........", "....ggg........."],
  },
  sunglasses: {
    down: ["", "", "", "", "", "", "", "....kkkkkkkk....", ".....kk..kk....."],
    left: ["", "", "", "", "", "", "", "...kkkkk........", "....kk.........."],
  },
};

const ACC: Record<Exclude<AvatarSpec["accessory"], "none">, Record<View, Layer>> = {
  headphones: {
    down: [
      "",
      ".....KKKKKK.....",
      "....K......K....",
      "...K........K...",
      "..K..........K..",
      "..K..........K..",
      ".PP..........PP.",
      ".PQ..........QP.",
      ".PP..........PP.",
    ],
    up: [
      "",
      ".....KKKKKK.....",
      "....K......K....",
      "...K........K...",
      "..K..........K..",
      "..K..........K..",
      ".PP..........PP.",
      ".PQ..........QP.",
      ".PP..........PP.",
    ],
    left: [
      "",
      ".......KKK......",
      "........K.......",
      "........K.......",
      "........K.......",
      "........K.......",
      ".......PPP......",
      ".......PQP......",
      ".......PPP......",
    ],
  },
  beanie: {
    down: [
      ".......pp.......",
      ".....BBBBBB.....",
      "....BBBBBBBB....",
      "...BBBBBBBBBB...",
      "..bbbbbbbbbbbb..",
      "..bbbbbbbbbbbb..",
    ],
    up: [
      ".......pp.......",
      ".....BBBBBB.....",
      "....BBBBBBBB....",
      "...BBBBBBBBBB...",
      "..bbbbbbbbbbbb..",
      "..bbbbbbbbbbbb..",
    ],
    left: [
      "........pp......",
      ".....BBBBBB.....",
      "....BBBBBBBB....",
      "....BBBBBBBBB...",
      "...bbbbbbbbbbb..",
      "...bbbbbbbbbbb..",
    ],
  },
  cap: {
    down: [
      "",
      ".....AAAAAA.....",
      "....AaAAAAAA....",
      "...AAAAAAAAAA...",
      "...AAAAAAAAAA...",
      "..NNNNNNNNNNNN..",
    ],
    up: [
      "",
      ".....AAAAAA.....",
      "....AaAAAAAA....",
      "...AAAAAAAAAA...",
      "...AAAAAAAAAA...",
      "...AAN....NAA...",
    ],
    left: [
      "",
      ".....AAAAAA.....",
      "....AaAAAAAAA...",
      "....AAAAAAAAAA..",
      "....AAAAAAAAAA..",
      ".NNNNNN.........",
    ],
  },
  "cap-mint": {
    down: [
      "",
      ".....MMMMMM.....",
      "....MmMMMMMM....",
      "...MMMMWWMMMM...",
      "...MMMMMMMMMM...",
      "..nnnnnnnnnnnn..",
    ],
    up: [
      "",
      ".....MMMMMM.....",
      "....MmMMMMMM....",
      "...MMMMMMMMMM...",
      "...MMMMMMMMMM...",
      "...MMn....nMM...",
    ],
    left: [
      "",
      ".....MMMMMM.....",
      "....MmMMMMMMM...",
      "....WMMMMMMMMM..",
      "....MMMMMMMMMM..",
      ".nnnnnn.........",
    ],
  },
  bow: {
    down: ["", "", "..........RRrRR.", "..........R.r.R."],
    up: ["", "", ".RRrRR..........", ".R.r.R.........."],
    left: ["", "", "........RRrRR...", "........R.r.R..."],
  },
  earring: {
    down: ["", "", "", "", "", "", "", "", "", "..E..........E.."],
    up: ["", "", "", "", "", "", "", "", "", "..E..........E.."],
    left: ["", "", "", "", "", "", "", "", "", "........E......."],
  },
};

const HAT: Record<View, Layer> = {
  down: [".....TTTTTT.....", ".....TTTTTT.....", ".....tttttt.....", ".YYYYYYYYYYYYYY."],
  up: [".....TTTTTT.....", ".....TTTTTT.....", ".....tttttt.....", ".YYYYYYYYYYYYYY."],
  left: [".....TTTTTT.....", ".....TTTTTT.....", ".....tttttt.....", "..YYYYYYYYYYYY.."],
};

// ---- painters -------------------------------------------------------------------------------
function layer(pc: PixelCanvas, rows: Layer, dy: number, colors: Record<string, string>) {
  pc.sprite(0, dy, rows, colors);
}

function drawHead(pc: PixelCanvas, look: Look, view: View, dy: number) {
  const s = look.skin;
  const hairC = { h: look.hair.main, H: look.hair.shade, L: look.hair.light, R: C.red };
  if (view === "left") {
    pc.rect(5, 3 + dy, 6, 1, s.main);
    pc.rect(4, 4 + dy, 8, 7, s.main);
    pc.rect(5, 11 + dy, 6, 1, s.shade);
    pc.set(3, 8 + dy, s.main); // nose
    pc.vline(11, 5 + dy, 6, s.shade);
    pc.set(8, 7 + dy, s.shade); // ear
    pc.set(8, 8 + dy, s.shade);
    pc.set(5, 7 + dy, C.night);
    pc.set(5, 8 + dy, C.night);
    if (look.skin.main !== "#733e39") pc.set(6, 9 + dy, C.pink);
  } else {
    pc.rect(4, 3 + dy, 8, 1, s.main);
    pc.rect(3, 4 + dy, 10, 7, s.main);
    pc.rect(4, 11 + dy, 8, 1, s.shade);
    pc.vline(12, 5 + dy, 6, s.shade);
    pc.set(2, 7 + dy, s.main);
    pc.set(2, 8 + dy, s.main);
    pc.set(13, 7 + dy, s.shade);
    pc.set(13, 8 + dy, s.shade);
    if (view === "down") {
      pc.set(6, 7 + dy, C.night);
      pc.set(6, 8 + dy, C.night);
      pc.set(9, 7 + dy, C.night);
      pc.set(9, 8 + dy, C.night);
      if (look.skin.main !== "#733e39") {
        pc.set(5, 9 + dy, C.pink);
        pc.set(10, 9 + dy, C.pink);
      }
    }
  }
  const hv = view;
  layer(pc, HAIR[look.hairStyle][hv], dy, {
    ...hairC,
    L: look.hairStyle === "bald" ? s.light : hairC.L,
  });
  if (view !== "up") {
    const fv = view === "left" ? "left" : "down";
    if (look.facialHair !== "none") {
      layer(pc, FACIAL[look.facialHair][fv], dy, { h: look.hair.main, S: s.shade });
    }
    if (look.glasses !== "none") {
      layer(pc, GLASSES_L[look.glasses][fv], dy, { g: C.slate, k: C.night });
    }
  }
  if (look.hat) {
    layer(pc, HAT[view], dy, { T: C.amber, t: C.red, Y: C.sand });
  }
  if (look.accessory !== "none" && !(look.hat && look.accessory === "headphones")) {
    layer(pc, ACC[look.accessory][view], dy, {
      K: C.ink,
      P: C.berry,
      Q: C.pink,
      B: C.plum,
      b: C.berry,
      p: C.cream,
      A: C.forest,
      a: C.moss,
      N: C.pine,
      R: C.pink,
      r: C.berry,
      E: C.amber,
      M: C.cyan,
      m: C.white,
      n: C.sky,
      W: C.white,
    });
  }
}

/** Plaid over a garment area: dark bands every 3 rows, light threads every 3 columns. */
function plaid(pc: PixelCanvas, look: Look, x: number, top: number, w: number, h: number) {
  const p = PLAID[look.outfit];
  if (!p) return;
  for (let y = top; y < top + h; y++) {
    for (let i = x; i < x + w; i++) {
      const band = (y - top) % 3 === 1;
      const thread = i % 3 === 1;
      if (band && thread) pc.set(i, y, look.jacket.shade);
      else if (band) pc.set(i, y, p.dark);
      else if (thread) pc.set(i, y, p.light);
    }
  }
}

/** Plaid bands on a 1-px sleeve. */
function sleevePlaid(pc: PixelCanvas, look: Look, x: number, top: number, len: number) {
  const p = PLAID[look.outfit];
  if (!p) return;
  for (let y = top + 1; y < top + len; y += 3) pc.set(x, y, p.dark);
}

/** 2x2 agent badge (light corner top-left). */
function badge(pc: PixelCanvas, look: Look, x: number, y: number) {
  pc.rect(x, y, 2, 2, look.badge.main);
  pc.set(x, y, look.badge.light);
}

function drawTorso(pc: PixelCanvas, look: Look, view: View, top: number, rows: number) {
  const j = look.jacket;
  const o = look.outfit;
  const flannel = isFlannel(o);
  if (view === "left") {
    pc.rect(5, top, 6, rows, j.main);
    plaid(pc, look, 5, top, 6, rows - 1);
    pc.vline(10, top, rows, j.shade);
    if (o === "jacket") pc.vline(5, top, Math.min(3, rows), C.white);
    if (flannel) {
      pc.vline(5, top, Math.min(4, rows - 1), TEE);
      pc.set(5, top + 1, look.badge.main);
    }
    if (o === "tee") pc.set(5, top + 1, look.badge.main);
    if (o === "hoodie") pc.rect(9, top, 2, 2, j.shade); // hood on the back
    pc.hline(5, top + rows - 1, 6, j.shade);
    return;
  }
  pc.rect(4, top, 8, rows, j.main);
  plaid(pc, look, 4, top, 8, rows - 1);
  pc.vline(11, top, rows, j.shade);
  pc.set(4, top, j.light);
  pc.set(5, top, j.light);
  pc.hline(4, top + rows - 1, 8, j.shade);
  if (view === "down") {
    if (o === "jacket") {
      pc.rect(7, top, 2, Math.min(4, rows - 1), C.white);
      pc.set(6, top, j.light);
      pc.set(9, top, j.light);
    } else if (flannel) {
      // open flannel: the navy tee with the agent badge in the middle
      pc.rect(6, top, 4, rows - 1, TEE);
      pc.set(6, top, j.light);
      pc.set(9, top, j.light);
      badge(pc, look, 7, top + 1);
    } else if (o === "tee") {
      pc.set(7, top, look.skin.shade);
      pc.set(8, top, look.skin.shade);
      badge(pc, look, 7, top + 2);
    } else if (o === "hoodie") {
      pc.set(6, top + 1, C.white); // drawstrings
      pc.set(9, top + 1, C.white);
      pc.hline(6, top + 3, 4, j.shade); // pocket
    }
  } else {
    pc.vline(7, top + 1, rows - 2, j.shade); // back seam
    if (o === "hoodie") {
      pc.rect(5, top, 6, 2, j.shade);
      pc.hline(6, top, 4, j.light);
    }
    // what you see at the desk: a wide agent patch across the shoulders
    if (!AGENT_COLORED_OUTFITS.includes(o)) {
      pc.rect(5, top + 1, 6, 2, look.badge.main);
      pc.hline(5, top + 1, 6, look.badge.light);
    }
  }
}

/** Sleeve of length `len` from `top`; short sleeves (tee) leave a bare forearm. */
function sleeve(pc: PixelCanvas, look: Look, x: number, top: number, len: number, hex: string) {
  if (look.outfit === "tee") {
    pc.vline(x, top, Math.min(2, len), hex);
    if (len > 2) pc.vline(x, top + 2, len - 2, look.skin.main);
    return;
  }
  pc.vline(x, top, len, hex);
  sleevePlaid(pc, look, x, top, len);
}

function drawArmsFront(pc: PixelCanvas, look: Look, arms: Arms, top: number, phase: number) {
  const j = look.jacket;
  const s = look.skin;
  const lenL = phase === 1 ? 4 : 5;
  const lenR = phase === 3 ? 4 : 5;
  // left arm (viewer's left) always down
  sleeve(pc, look, 3, top, lenL, j.main);
  pc.set(3, top + lenL, s.main);
  if (arms === "raise0" || arms === "raise1" || arms === "wave0" || arms === "wave1") {
    const alt = arms === "raise1" || arms === "wave1";
    pc.vline(12, top, 2, j.shade);
    if (!alt) {
      pc.vline(13, top - 7, 8, j.shade);
      pc.rect(13, top - 9, 2, 2, s.main);
    } else {
      pc.vline(13, top - 5, 6, j.shade);
      pc.set(14, top - 6, j.shade);
      pc.rect(14, top - 8, 2, 2, s.main);
    }
    return;
  }
  sleeve(pc, look, 12, top, lenR, j.shade);
  pc.set(12, top + lenR, s.main);
}

function drawArmsBack(pc: PixelCanvas, look: Look, arms: Arms, top: number, phase: number) {
  const j = look.jacket;
  const s = look.skin;
  let lenL = phase === 3 ? 4 : 5;
  let lenR = phase === 1 ? 4 : 5;
  if (arms === "type0") {
    lenL = 3;
    lenR = 4;
  } else if (arms === "type1") {
    lenL = 4;
    lenR = 3;
  }
  sleeve(pc, look, 3, top, lenL, j.shade);
  if (arms === "down") pc.set(3, top + lenL, s.main);
  if (arms === "book0" || arms === "book1") {
    pc.vline(12, top, 2, j.shade);
    pc.rect(11, top - 1, 2, 1, s.main);
    const by = top - 6;
    pc.rect(11, by, 4, 4, C.wine);
    pc.vline(11, by, 4, C.red);
    pc.hline(11, by - 1, 4, C.cream);
    if (arms === "book1") {
      pc.set(13, by - 2, C.cream);
      pc.set(14, by - 2, C.white);
      pc.set(14, by - 3, C.white);
    }
    return;
  }
  sleeve(pc, look, 12, top, lenR, j.shade);
  if (arms === "down") pc.set(12, top + lenR, s.main);
}

function drawLegs(pc: PixelCanvas, view: View, phase: number) {
  const P = C.dusk;
  const Ps = C.ink;
  const Sh = C.cocoa;
  if (view === "left") {
    if (phase === 1 || phase === 3) {
      pc.rect(6, 18, 4, 1, P);
      pc.rect(5, 19, 2, 1, phase === 1 ? P : Ps);
      pc.rect(8, 19, 2, 1, phase === 1 ? Ps : P);
      pc.rect(4, 20, 2, 1, phase === 1 ? P : Ps);
      pc.rect(9, 20, 2, 1, phase === 1 ? Ps : P);
      pc.rect(3, 21, 3, 1, Sh);
      pc.rect(9, 21, 3, 1, Sh);
    } else {
      pc.rect(6, 18, 4, 3, P);
      pc.vline(9, 18, 3, Ps);
      pc.rect(5, 21, 5, 1, Sh);
    }
    return;
  }
  pc.rect(5, 18, 6, 1, P);
  const lUp = phase === 1 ? 1 : 0;
  const rUp = phase === 3 ? 1 : 0;
  pc.rect(5, 19, 2, 2 - lUp, P);
  pc.rect(9, 19, 2, 2 - rUp, Ps);
  pc.rect(5, 21 - lUp, 2, 1, Sh);
  pc.rect(9, 21 - rUp, 2, 1, Sh);
}

/** Raised hand drawn over the head's edge so it reads at a glance ("waiting for you!"). */
function drawRaisedHand(pc: PixelCanvas, look: Look, arms: Arms, top: number) {
  if (arms !== "raise0" && arms !== "raise1") return;
  const j = look.jacket;
  const s = look.skin;
  const lift = arms === "raise0" ? 0 : 1;
  pc.vline(13, top - 3 + lift, 4, j.shade);
  pc.vline(14, top - 7 + lift, 6, j.main);
  pc.rect(13, top - 10 + lift, 2, 3, s.main);
  pc.set(12, top - 9 + lift, s.main); // thumb
}

function drawMug(pc: PixelCanvas, x: number, y: number) {
  pc.rect(x, y, 2, 3, C.white);
  pc.vline(x + 2, y + 1, 1, C.white);
  pc.set(x, y, C.silver);
}

/** Painters that run after the outline (thin things that must stay thin). */
type After = ((pc: PixelCanvas) => void)[];

/**
 * A held item next to the hand pixel (hx, hy). `dir` -1 = it sticks out to the viewer's
 * left, +1 = right. `tick` (0/1) animates smoke.
 */
function drawHeld(
  pc: PixelCanvas,
  item: AvatarSpec["leftHand"],
  hx: number,
  hy: number,
  dir: -1 | 1,
  tick: number,
  after: After,
) {
  const x = dir < 0 ? hx - 2 : hx + 1; // left column of a 2-wide item
  switch (item) {
    case "none":
      return;
    case "beer":
      // glass of lager with a foam head
      pc.rect(x, hy - 2, 2, 1, C.white);
      pc.rect(x, hy - 1, 2, 3, C.amber);
      pc.set(dir < 0 ? x : x + 1, hy - 1, C.lemon);
      pc.set(dir < 0 ? x + 1 : x, hy + 1, C.orange);
      return;
    case "coffee":
      pc.rect(x, hy - 2, 2, 1, C.white);
      pc.rect(x, hy - 1, 2, 1, C.wood);
      pc.rect(x, hy, 2, 2, C.white);
      return;
    case "phone":
      pc.rect(x, hy - 2, 2, 3, C.ink);
      pc.set(x, hy - 2, C.sky);
      pc.set(x + 1, hy - 1, C.cyan);
      return;
    case "joint": {
      // white stick with a glowing tip and a curl of smoke, drawn over the outline
      after.push((p) => {
        const ex = hx + dir * 2;
        p.set(hx + dir, hy, C.white);
        p.set(ex, hy, C.cream);
        p.set(ex + dir, hy, tick ? C.amber : C.orange);
        const sx = ex + dir;
        p.set(sx, hy - 2 - tick, C.silver, 200);
        p.set(sx - dir, hy - 3 - tick, C.silver, 150);
        p.set(sx, hy - 4 - tick, C.white, 110);
      });
      return;
    }
  }
}

/** Items in both hands of a front-facing pose (arms down). */
function drawHands(
  pc: PixelCanvas,
  look: Look,
  arms: Arms,
  top: number,
  phase: number,
  tick: number,
  after: After,
) {
  const lenL = phase === 1 ? 4 : 5;
  const lenR = phase === 3 ? 4 : 5;
  drawHeld(pc, look.leftHand, 3, top + lenL, -1, tick, after);
  const raised = arms === "raise0" || arms === "raise1" || arms === "wave0" || arms === "wave1";
  if (!raised) drawHeld(pc, look.rightHand, 12, top + lenR, 1, tick, after);
}

function paintFrame(pc: PixelCanvas, look: Look, f: FrameSpec, after: After) {
  const bob = f.bob;
  const tick = (f.bob + f.phase) % 2;
  if (f.seat === "none") {
    drawLegs(pc, f.view, f.phase);
    drawTorso(pc, look, f.view, 12 + bob, 6);
    if (f.view === "down") {
      drawArmsFront(pc, look, f.arms, 12 + bob, f.phase);
      if (look.mug && f.arms === "down") drawMug(pc, 12, 16 + bob);
      if (look.mug && (f.arms === "wave0" || f.arms === "wave1")) drawMug(pc, 2, 16);
      drawHands(pc, look, f.arms, 12 + bob, f.phase, tick, after);
    } else if (f.view === "up") {
      drawArmsBack(pc, look, f.arms, 12 + bob, f.phase);
    } else {
      // side: one arm swinging
      const j = look.jacket;
      const ax = f.phase === 1 ? -1 : f.phase === 3 ? 1 : 0;
      pc.rect(7, 12 + bob, 2, 2, j.shade);
      pc.rect(7 + ax, 14 + bob, 2, 2, look.outfit === "tee" ? look.skin.main : j.shade);
      pc.rect(7 + ax * 2, 16 + bob, 2, 1, look.skin.main);
      if (look.mug && f.phase === 0) drawMug(pc, 5, 15 + bob);
      const item = look.rightHand !== "none" ? look.rightHand : look.leftHand;
      drawHeld(pc, item, 7 + ax * 2, 16 + bob, -1, tick, after);
    }
    drawHead(pc, look, f.view, bob);
    if (f.view === "down") drawRaisedHand(pc, look, f.arms, 12 + bob);
    return;
  }
  const S = 3; // seated: everything sits 3 px lower
  if (f.seat === "back") {
    drawTorso(pc, look, "up", 12 + S + bob, 5);
    drawArmsBack(pc, look, f.arms, 12 + S + bob, 0);
    drawHead(pc, look, "up", S + bob);
    return;
  }
  // front seated: knees toward the camera
  pc.rect(4, 20, 8, 2, C.dusk);
  pc.hline(4, 21, 8, C.ink);
  pc.rect(4, 22, 2, 1, C.cocoa);
  pc.rect(10, 22, 2, 1, C.cocoa);
  drawTorso(pc, look, "down", 12 + S + bob, 5);
  const arms = f.arms === "rest" ? "down" : f.arms;
  drawArmsFront(pc, look, arms, 12 + S + bob, 0);
  if (look.mug && f.arms === "rest") drawMug(pc, 11, 17 + bob);
  drawHands(pc, look, arms, 12 + S + bob, 0, tick, after);
  drawHead(pc, look, "down", S + bob);
  drawRaisedHand(pc, look, f.arms, 12 + S + bob);
}

/** Paint every frame of a look into one strip (no Pixi; also used by the look editor). */
export function paintSheet(look: Look): PixelCanvas {
  const pc = new PixelCanvas(CHAR_W * SPECS.length, CHAR_H);
  SPECS.forEach((spec, i) => {
    if (spec.mirror !== undefined) return;
    const after: After = [];
    pc.at(i * CHAR_W, 0);
    paintFrame(pc, look, spec, after);
    pc.at(0, 0);
    pc.outline(i * CHAR_W, 0, CHAR_W, CHAR_H);
    pc.at(i * CHAR_W, 0);
    for (const paint of after) paint(pc);
    pc.at(0, 0);
  });
  SPECS.forEach((spec, i) => {
    if (spec.mirror !== undefined) {
      pc.mirrorFrom(spec.mirror * CHAR_W, 0, CHAR_W, CHAR_H, i * CHAR_W, 0);
    }
  });
  return pc;
}

/** One frame of a look as a DOM canvas, `scale`x (look editor preview). */
export function lookPreview(look: Look, frame = 0, scale = 4): HTMLCanvasElement {
  const pc = paintSheet(look);
  const one = new PixelCanvas(CHAR_W, CHAR_H);
  one.copyFrom(pc, frame * CHAR_W, 0, CHAR_W, CHAR_H, 0, 0);
  const src = one.toCanvas();
  const canvas = document.createElement("canvas");
  canvas.width = CHAR_W * scale;
  canvas.height = CHAR_H * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const sheetCache = new Map<string, CharacterSheet>();

export function characterSheet(look: Look): CharacterSheet {
  const key = lookKey(look);
  const cached = sheetCache.get(key);
  if (cached) return cached;
  const base = Texture.from(paintSheet(look).toCanvas());
  const frames = SPECS.map(
    (_, i) =>
      new Texture({ source: base.source, frame: new Rectangle(i * CHAR_W, 0, CHAR_W, CHAR_H) }),
  );
  const anims = {} as Record<AnimName, Texture[]>;
  for (const [name, idx] of Object.entries(ANIM)) {
    anims[name as AnimName] = idx.map((i) => frames[i]!);
  }
  const sheet = { frames, anims };
  sheetCache.set(key, sheet);
  return sheet;
}
