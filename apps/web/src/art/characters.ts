/**
 * Paper-doll characters, ~16x24 px, drawn pixel by pixel from small ASCII layers:
 * skin head -> hair (per style and view) -> facial hair -> glasses -> accessory/hat,
 * body = jacket in the agent color + shirt + pants + shoes, then a 1-px dark outline.
 *
 * One sheet (35 frames) per look; looks are cached by key so siblings and re-joins reuse.
 */
import {
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
  jacket: Ramp;
  hairStyle: AvatarSpec["hairStyle"];
  glasses: AvatarSpec["glasses"];
  facialHair: AvatarSpec["facialHair"];
  accessory: AvatarSpec["accessory"];
  hat: boolean;
  mug: boolean;
};

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
  return {
    skin: { main: sk.hex, shade: sk.shade, light: sk.light },
    hair,
    jacket: { main: j.main, shade: j.shade, light: j.light },
    hairStyle: avatar.hairStyle,
    glasses: avatar.glasses,
    facialHair: avatar.facialHair,
    accessory: avatar.accessory,
    hat: !!variation?.hat && avatar.accessory !== "beanie" && avatar.accessory !== "cap",
    mug: !!variation?.mug,
  };
}

export function lookKey(l: Look): string {
  return [
    l.skin.main,
    l.hair.main,
    l.hair.shade,
    l.jacket.main,
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
    });
  }
}

function drawTorso(pc: PixelCanvas, look: Look, view: View, top: number, rows: number) {
  const j = look.jacket;
  if (view === "left") {
    pc.rect(5, top, 6, rows, j.main);
    pc.vline(10, top, rows, j.shade);
    pc.vline(5, top, Math.min(3, rows), C.white);
    pc.hline(5, top + rows - 1, 6, j.shade);
    return;
  }
  pc.rect(4, top, 8, rows, j.main);
  pc.vline(11, top, rows, j.shade);
  pc.set(4, top, j.light);
  pc.set(5, top, j.light);
  pc.hline(4, top + rows - 1, 8, j.shade);
  if (view === "down") {
    pc.rect(7, top, 2, Math.min(4, rows - 1), C.white);
    pc.set(6, top, j.light);
    pc.set(9, top, j.light);
  } else {
    pc.vline(7, top + 1, rows - 2, j.shade); // back seam
  }
}

function drawArmsFront(pc: PixelCanvas, look: Look, arms: Arms, top: number, phase: number) {
  const j = look.jacket;
  const s = look.skin;
  const lenL = phase === 1 ? 4 : 5;
  const lenR = phase === 3 ? 4 : 5;
  // left arm (viewer's left) always down
  pc.vline(3, top, lenL, j.main);
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
  pc.vline(12, top, lenR, j.shade);
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
  pc.vline(3, top, lenL, j.shade);
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
  pc.vline(12, top, lenR, j.shade);
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

function paintFrame(pc: PixelCanvas, look: Look, f: FrameSpec) {
  const bob = f.bob;
  if (f.seat === "none") {
    drawLegs(pc, f.view, f.phase);
    drawTorso(pc, look, f.view, 12 + bob, 6);
    if (f.view === "down") {
      drawArmsFront(pc, look, f.arms, 12 + bob, f.phase);
      if (look.mug && f.arms === "down") drawMug(pc, 12, 16 + bob);
      if (look.mug && (f.arms === "wave0" || f.arms === "wave1")) drawMug(pc, 2, 16);
    } else if (f.view === "up") {
      drawArmsBack(pc, look, f.arms, 12 + bob, f.phase);
    } else {
      // side: one arm swinging
      const j = look.jacket;
      const ax = f.phase === 1 ? -1 : f.phase === 3 ? 1 : 0;
      pc.rect(7, 12 + bob, 2, 2, j.shade);
      pc.rect(7 + ax, 14 + bob, 2, 2, j.shade);
      pc.rect(7 + ax * 2, 16 + bob, 2, 1, look.skin.main);
      if (look.mug && f.phase === 0) drawMug(pc, 5, 15 + bob);
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
  drawArmsFront(pc, look, f.arms === "rest" ? "down" : f.arms, 12 + S + bob, 0);
  if (look.mug && f.arms === "rest") drawMug(pc, 11, 17 + bob);
  drawHead(pc, look, "down", S + bob);
  drawRaisedHand(pc, look, f.arms, 12 + S + bob);
}

const sheetCache = new Map<string, CharacterSheet>();

export function characterSheet(look: Look): CharacterSheet {
  const key = lookKey(look);
  const cached = sheetCache.get(key);
  if (cached) return cached;
  const pc = new PixelCanvas(CHAR_W * SPECS.length, CHAR_H);
  SPECS.forEach((spec, i) => {
    if (spec.mirror !== undefined) return;
    pc.at(i * CHAR_W, 0);
    paintFrame(pc, look, spec);
    pc.at(0, 0);
    pc.outline(i * CHAR_W, 0, CHAR_W, CHAR_H);
  });
  SPECS.forEach((spec, i) => {
    if (spec.mirror !== undefined) {
      pc.mirrorFrom(spec.mirror * CHAR_W, 0, CHAR_W, CHAR_H, i * CHAR_W, 0);
    }
  });
  const base = Texture.from(pc.toCanvas());
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
