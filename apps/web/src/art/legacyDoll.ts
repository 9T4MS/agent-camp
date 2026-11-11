/**
 * The original 1× (16×24) head painter and held-item art, kept from before the HD paper doll
 * (art/avatar/*): the prom queen (queen.ts) still uses the 1× head, and the HD painter reuses
 * the held items, bracelets and costume details by painting them at 1× and doubling them
 * (art/avatar/extras.ts), so they look exactly as drawn in the look editor before.
 */
import type { AvatarSpec } from "@agent-office/protocol";
import { accentHex, costumeAccessory, costumeHead } from "./costumes.ts";
import { C } from "./palette.ts";
import type { PixelCanvas } from "./pixel.ts";

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
  wrist: AvatarSpec["wrist"];
  accentColor: AvatarSpec["accentColor"];
  hat: boolean;
  mug: boolean;
};

export type View = "down" | "up" | "left";

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

const ACC: Partial<Record<AvatarSpec["accessory"], Record<View, Layer>>> = {
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

export function drawHead(pc: PixelCanvas, look: Look, view: View, dy: number) {
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
  const parts = {
    outfit: look.outfit,
    accessory: look.accessory,
    accent: accentHex(look.accentColor),
  };
  costumeHead(pc, parts, view, dy);
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
    const accessory = ACC[look.accessory];
    if (accessory)
      layer(pc, accessory[view], dy, {
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
    costumeAccessory(pc, parts, view, dy);
  }
}

/** Neon bracelets around the wrist above the hand pixel (x, y). */
export function drawWrist(pc: PixelCanvas, wrist: AvatarSpec["wrist"], x: number, y: number) {
  if (wrist === "none") return;
  const color =
    wrist === "neon-pink"
      ? C.pink
      : wrist === "neon-lime"
        ? C.leaf
        : wrist === "rainbow"
          ? C.lemon
          : C.cyan;
  pc.hline(x - 1, y, 3, color);
  if (wrist === "rainbow") pc.set(x + 1, y, C.pink);
}

/** Painters that run after the outline (thin things that must stay thin). */
export type After = ((pc: PixelCanvas) => void)[];

/**
 * A held item next to the hand pixel (hx, hy). `dir` -1 = it sticks out to the viewer's
 * left, +1 = right. `tick` (0/1) animates smoke.
 */
export function drawHeld(
  pc: PixelCanvas,
  item: AvatarSpec["leftHand"],
  hx: number,
  hy: number,
  dir: -1 | 1,
  tick: number,
  after: After,
  color: string = C.cyan,
) {
  const x = dir < 0 ? hx - 2 : hx + 1; // left column of a 2-wide item
  switch (item) {
    case "none":
      return;
    case "lightsaber":
      pc.rect(x, hy - 10, 2, 9, color);
      pc.vline(x, hy - 9, 8, C.white);
      pc.rect(x, hy - 1, 2, 3, C.silver);
      return;
    case "confetti":
      pc.rect(x, hy - 3, 2, 4, C.berry);
      pc.hline(x, hy - 3, 2, color);
      pc.set(x, hy - 1, C.lemon);
      return;
    case "bubble-wand":
      pc.vline(x, hy - 3, 5, C.pink);
      pc.rect(x - 1, hy - 6, 3, 3, C.cyan);
      pc.set(x, hy - 5, C.navy);
      return;
    case "disco-ball":
      pc.ellipse(x - 1, hy - 6, 4, 5, C.silver);
      pc.set(x, hy - 5, C.cyan);
      pc.set(x + 1, hy - 3, C.white);
      pc.vline(x, hy - 1, 2, C.slate);
      return;
    case "magic-wand":
      pc.vline(x, hy - 4, 5, C.plum);
      pc.hline(x - 1, hy - 5, 3, C.lemon);
      pc.vline(x, hy - 6, 3, C.lemon);
      return;
    case "balloon":
      pc.vline(x, hy - 8, 9, C.white);
      pc.ellipse(x - 1, hy - 13, 4, 6, color);
      pc.set(x, hy - 12, C.white);
      return;
    case "water-pistol":
      pc.rect(x - 1, hy - 3, 4, 2, C.sky);
      pc.vline(x, hy - 1, 3, C.orange);
      pc.rect(x, hy - 5, 2, 2, color);
      return;
    case "maracas":
      pc.vline(x, hy - 2, 4, C.wood);
      pc.ellipse(x - 1, hy - 6, 3, 4, C.red);
      pc.hline(x - 1, hy - 4, 3, C.lemon);
      return;
    case "umbrella":
      pc.vline(x, hy - 8, 9, C.silver);
      pc.hline(x - 1, hy, 2, C.silver);
      pc.ellipse(Math.max(0, x - 2), hy - 12, 5, 5, color);
      pc.hline(Math.max(0, x - 2), hy - 8, 5, C.white);
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
    case "cigarette":
    case "joint": {
      // white stick with a glowing tip and a curl of smoke, drawn over the outline
      after.push((p) => {
        const ex = hx + dir * 2;
        p.set(hx + dir, hy, C.white);
        p.set(ex, hy, item === "cigarette" ? C.wood : C.cream);
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
