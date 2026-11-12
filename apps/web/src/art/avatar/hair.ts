/**
 * Hair cuts. The classic catalog cuts reuse the 1× ASCII layers of the original characters,
 * upscaled with Scale2x (rounds diagonals), so catalog people keep their silhouette.
 * New cuts are authored at 2× directly. Codes: h base, H shadow, L light (sheen), R ribbon.
 */
import type { CharacterLook } from "@agent-office/protocol";
import { C } from "../palette.ts";
import { type PixelCanvas, packColor } from "../pixel.ts";
import { hash2 } from "./color.ts";
import type { View } from "./geometry.ts";

type Layer = readonly string[];

/** Scale2x / EPX upscale of an ASCII layer ('.' = empty). */
export function scale2x(rows: Layer, width = 16): string[] {
  const at = (x: number, y: number) => {
    const r = rows[y];
    if (!r || x < 0 || x >= width) return ".";
    const c = r[x];
    return c === undefined || c === " " ? "." : c;
  };
  const out: string[] = [];
  for (let y = 0; y < rows.length; y++) {
    let r0 = "";
    let r1 = "";
    for (let x = 0; x < width; x++) {
      const P = at(x, y);
      const A = at(x, y - 1);
      const B = at(x + 1, y);
      const C = at(x - 1, y);
      const D = at(x, y + 1);
      // only round off silhouette corners (into or out of empty space), keep interior shading
      const ok = (q: string) => q === "." || P === ".";
      const e0 = C === A && C !== D && A !== B && ok(A) ? A : P;
      const e1 = A === B && A !== C && B !== D && ok(B) ? B : P;
      const e2 = D === C && D !== B && C !== A && ok(C) ? C : P;
      const e3 = B === D && B !== A && D !== C && ok(D) ? D : P;
      r0 += e0 + e1;
      r1 += e2 + e3;
    }
    out.push(r0, r1);
  }
  return out;
}

// ---- 1× layers of the original characters (16 wide, rows from y=0) ---------------------------
const SHORT_TOP = [
  "................",
  "................",
  "....hhhhhhhh....",
  "...hhLLhhhhhh...",
  "..hhLhhhhhhhHh..",
  "..hhhhhhhhhhHh..",
];
const CLASSIC: Record<
  "short" | "buzz" | "long" | "bun" | "curly" | "ponytail" | "mohawk" | "bald",
  Record<View, Layer>
> = {
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

// ---- 2× authored cuts (32 wide, rows from y=0) -------------------------------------------------
const SLICKED: Record<View, Layer> = {
  // high, smooth volume combed straight back; short dark sides; forehead free
  // front: high hairline (forehead free), comb lines fanning back over the top, short dark sides
  down: [
    "................................",
    "............HhhhhhhH............",
    "..........HhhhLLLhhhhH..........",
    ".........HhhhLLhhHhhhhH.........",
    "........HhHhhLhhhhHhhhhH........",
    "........HhhHhhhhhhHhhhHH........",
    ".......HhhhHhhhhhhhHhhhHH.......",
    ".......HhhhhHhhhhhhHhhhHH.......",
    "......HHhhhhHhLLLhhhhhhHHH......",
    "......HH...HhhhhhhhhH...HH......",
    "......HH................HH......",
    "......HH................HH......",
    ".......H................H.......",
  ],
  up: [
    "................................",
    "...........HHhhhhhhHH...........",
    ".........HhhhhLLLhhhhhH.........",
    "........HhhhhLLhhhhhhhhH........",
    ".......HhhhhLhhhhhhhhhhhH.......",
    ".......HhhhhhhhhhhhhhhhhH.......",
    "......HhhhhhhHhhhhHhhhhhHH......",
    "......HhhhhhhHhhhhHhhhhhHH......",
    "......HHhhhhhhHhhhHhhhhhHH......",
    "......HHhhhhhhHhhhhHhhhhHH......",
    "......HHhhhhhhhhhhhHhhhhHH......",
    "......HHHhhhhhhhhhhhhhhHHH......",
    "......HHHhhhhhhhhhhhhhhHHH......",
    "......HHHhhhhhhhhhhhhhhHHH......",
    ".......HHhhhhhhhhhhhhhhHH.......",
    ".......HHHhhhhhhhhhhhhHHH.......",
    "........HHHhhhhhhhhhhHHH........",
    "........HHHHhhhhhhhhHHHH........",
    ".........HHHHHhhhhHHHHH.........",
    "..........HHHHHHHHHHHH..........",
    "............HHHHHHHH............",
  ],
  left: [
    "................................",
    "...........hhhhhhH..............",
    ".........hLLLhhhhhhhH...........",
    "........hLhhhhhhhhhhhhH.........",
    "........hhhhhHHHhhhhhhhhH.......",
    "........HhhhhhhhhhHHHhhhhH......",
    ".........HhhhhhhhhhhhhhhhH......",
    "..........HHhhhhhhhhhhhhhH......",
    "...........HHHHHhhhhhhhhhH......",
    "............HHHHHHhhhhhhhH......",
    "............HHHHHHHhhhhhhH......",
    "............HHHH..HHhhhhhH......",
    "............HH.....HhhhhhH......",
    "...................HhhhhhH......",
    "...................HhhhhhH......",
    "...................HHhhhhH......",
    "....................HHhhHH......",
    ".....................HHHH.......",
  ],
};

const SIDE_PART: Record<View, Layer> = {
  down: [
    "................................",
    "................................",
    "................................",
    ".......hhhhH.hhhhhhhhhhhh.......",
    "......hhhLhH.hhhhhLLhhhhhh......",
    ".....hhhhhhH.hhhhLhhhhhhhhh.....",
    "....hhhhhhhHhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhHHh....",
    "....hhhh.......hhhhhhhhhhHHh....",
    "....hhh..............hhhhHh.....",
    "....hh..................HHh.....",
    "....h.....................H.....",
  ],
  up: [
    "................................",
    "................................",
    "................................",
    ".......hhhhhhhhhhhhhhhhh........",
    "......hhhhhhhhhhLLhhhhhhh.......",
    ".....hhhhhhhhhhLhhhhhhhhhh......",
    "....hhhhhhhhhhhhhhhhhhhhhHh.....",
    "....hhhhhhhhhhhhhhhhhhhhhHh.....",
    "....hhhhhhhhhhhhhhhhhhhhhHh.....",
    "....hhhhhhhhhhhhhhhhhhhhhHh.....",
    "....hhhhhhhhhhhhhhhhhhhhhHh.....",
    "....hhhhhhhhhhhhhhhhhhhhhHh.....",
    ".....hhhhhhhhhhhhhhhhhhhHh......",
    "......HhhhhhhhhhhhhhhhhHH.......",
    ".......HHHHHHHHHHHHHHHHH........",
  ],
  left: [
    "................................",
    "................................",
    "................................",
    "..........hhhhhhhhhh............",
    "........hhhLLhhhhhhhhh..........",
    ".......hhLhhhhhhhhhhhhhh........",
    "......hhhhhhhhhhhhhhhhhhh.......",
    "......hhhhhhhhhhhhhhhhhhHh......",
    "......hhhhh..hhhhhhhhhhhHh......",
    "......hhh.....hhhhhhhhhhHh......",
    "..............HhhhhhhhhhHh......",
    "................hhhhhhhhHh......",
    "..................hhhhhhH.......",
    "..................HHhhhHH.......",
    "....................HHH.........",
  ],
};

const BOB: Record<View, Layer> = {
  down: [
    "................................",
    "................................",
    "................................",
    "........hhhhhhhhhhhhhhhh........",
    "......hhhhLLhhhhhhhhhhhhhh......",
    ".....hhhhLhhhhhhhhhhhhhhhhh.....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhHHh....",
    "....hhhhhHhhhHhhhhHhhhHhhHHh....",
    "....hhhh..............hhhHHh....",
    "....hhh.................hHHh....",
    "....hhh.................hHHh....",
    "....hhh.................hHHh....",
    "....hhh.................hHHh....",
    "....hhh.................hHHh....",
    "....hhh.................hHHh....",
    "....HHh.................hHHH....",
    "....HHH.................HHHH....",
  ],
  up: [
    "................................",
    "................................",
    "................................",
    "........hhhhhhhhhhhhhhhh........",
    "......hhhhLLhhhhhhhhhhhhhh......",
    ".....hhhhLhhhhhhhhhhhhhhhhh.....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhHHh....",
    "....hhhhhhhhhhhhhhhhhhhhhHHh....",
    "....HhhhhhhhhhhhhhhhhhhhhHHH....",
    "....HHHHHHHHHHHHHHHHHHHHHHHH....",
  ],
  left: [
    "................................",
    "................................",
    "................................",
    "..........hhhhhhhhhhh...........",
    "........hhhLLhhhhhhhhhh.........",
    ".......hhLhhhhhhhhhhhhhhh.......",
    "......hhhhhhhhhhhhhhhhhhhh......",
    "......hhhhhhhhhhhhhhhhhhhHh.....",
    "......hhhhhhhhhhhhhhhhhhhHh.....",
    "......hhhhhhhhhhhhhhhhhhhHh.....",
    "......hhhhhhhhhhhhhhhhhhhHh.....",
    "......hhhh.hhhhhhhhhhhhhhHh.....",
    "......hh.......hhhhhhhhhhHh.....",
    "...............hhhhhhhhhhHh.....",
    "................hhhhhhhhhHh.....",
    "................hhhhhhhhhHh.....",
    "................hhhhhhhhhHh.....",
    "................hhhhhhhhhHh.....",
    "................hhhhhhhhhHh.....",
    "................HhhhhhhhhHH.....",
    "................HHHHHHHHHHH.....",
  ],
};

/** Shoulder length, centre parting, curtain fringe framing the face, ends flipped outwards. */
const FLIP: Record<View, Layer> = {
  down: [
    "................................",
    "................................",
    "................................",
    "........hhhhhhhHHhhhhhHh........",
    "......hhhhLLhhhHHhhhhhhhHh......",
    ".....hhhhLhhhhhHHhhhhhhhhHh.....",
    "....hhhhhhhhhhhHHhhhhhhhhhHh....",
    "....hhhhhhhhhhH..HhhhhhhhhHh....",
    "....hhhhhhhhhH....HhhhhhhhHh....",
    "....hhhhhhhhH......HhhhhhhHh....",
    "....hhhhhhhhH......HhhhhhhHh....",
    "....hhhhhhhH........HhhhhhHh....",
    "....hhhhhH............HhhhHh....",
    "....hhh..................hHh....",
    "....hhh..................hHh....",
    "....hhh..................hHh....",
    "....hhh..................hHh....",
    "....hhh..................hHh....",
    "....hhhh................hhHh....",
    "...hhhhH................HhhHh...",
    "..hhhH....................HhHh..",
    ".hhH........................HHh.",
  ],
  up: [
    "................................",
    "................................",
    "................................",
    "........hhhhhhhhhhhhhhHh........",
    "......hhhhLLhhhhhhhhhhhhHh......",
    ".....hhhhLhhhhhhhhhhhhhhhHh.....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "....hhhhhhhhhhhhhhhhhhhhhhHh....",
    "...hhhhhhhhhhhhhhhhhhhhhhhhHh...",
    "..hhhHHhhhhhhhhhhhhhhhhhhHHhHh..",
    ".hhH..HHHHHHHHHHHHHHHHHHHH..HHh.",
  ],
  left: [
    "................................",
    "................................",
    "................................",
    "..........hhhhhhhhhhh...........",
    "........hhhLLhhhhhhhhhh.........",
    ".......hhLhhhhhhhhhhhhhhh.......",
    "......hhhhhhhhhhhhhhhhhhhh......",
    "......hhhhhhhhhhhhhhhhhhhHh.....",
    "......hhhhhhhhhhhhhhhhhhhHh.....",
    "......hhhhhhhhhhhhhhhhhhhHh.....",
    "......hhhhhhhhhhhhhhhhhhhHh.....",
    "......hhhh.hhhhhhhhhhhhhhHh.....",
    "......hh.......hhhhhhhhhhHh.....",
    "...............hhhhhhhhhhHh.....",
    "................hhhhhhhhhHh.....",
    "................hhhhhhhhhHh.....",
    "................hhhhhhhhhHh.....",
    "................hhhhhhhhhHh.....",
    "................hhhhhhhhhhHh....",
    "................hhhhhhhhhhhHh...",
    "................HhhhhhhhhHHhHh..",
    "................HHHHHHHHH..HHh..",
  ],
};

const UPSCALED = new Map<string, string[]>();
function classic(cut: keyof typeof CLASSIC, view: View): string[] {
  const k = `${cut}/${view}`;
  let v = UPSCALED.get(k);
  if (!v) {
    v = scale2x(CLASSIC[cut][view]);
    UPSCALED.set(k, v);
  }
  return v;
}

/** Afro: a big round cloud around the head, face cut out. */
function drawAfro(pc: PixelCanvas, L: CharacterLook, view: View, hy: number) {
  const { base, shadow, light } = L.hair.ramp;
  const cx = view === "left" ? 17 : 15.5;
  const cy = 11;
  const rx = view === "left" ? 12.5 : 13.5;
  const ry = 10;
  for (let y = 0; y <= 23; y++) {
    for (let x = 0; x < 32; x++) {
      const dx = (x + 0.5 - cx - 0.5) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const bump = (hash2(x, y, 3) % 5) / 40;
      if (dx * dx + dy * dy > 1 - bump) continue;
      if (view === "down" && y >= 10 && x >= 8 && x <= 23) continue;
      if (view === "down" && y >= 16) continue;
      if (view === "left" && y >= 10 && x <= 15) continue;
      if (view === "left" && y >= 18 && x < 20) continue;
      if (view === "up" && y >= 21) continue;
      const h = hash2(x, y, 9) % 9;
      const c = x > cx + rx * 0.45 || y > cy + ry * 0.6 ? shadow : h === 0 ? shadow : base;
      pc.set(x, y + hy, L.hair.sheen && h === 1 && y < cy && x < cx ? light : c);
    }
  }
}

export function drawHair(pc: PixelCanvas, L: CharacterLook, view: View, hy: number) {
  const { cut, ramp, sheen } = L.hair;
  if (cut === "afro") {
    drawAfro(pc, L, view, hy);
    return;
  }
  const rows =
    cut === "slicked-back"
      ? SLICKED[view]
      : cut === "side-part"
        ? SIDE_PART[view]
        : cut === "bob"
          ? BOB[view]
          : cut === "flip"
            ? FLIP[view]
            : classic(cut, view);
  const light = cut === "bald" ? L.skin.light : sheen ? ramp.light : ramp.base;
  pc.sprite(0, hy, rows, { h: ramp.base, H: ramp.shadow, L: light, R: "#e43b44" });
  if (L.hair.clips && L.hair.clips !== "none") drawClips(pc, L, view, hy);
}

// ---- hair clips ---------------------------------------------------------------------------------
/** Where clips may sit, per view, in the order they are used; a spot is skipped off the hair. */
const CLIP_SPOTS: Record<View, readonly (readonly [number, number])[]> = {
  // clear of a hairband's arch and its ends at the temples
  down: [
    [10, 6],
    [19, 6],
    [4, 17],
    [25, 17],
    [14, 5],
    [5, 20],
    [24, 20],
    [4, 23],
    [25, 23],
  ],
  left: [
    [19, 6],
    [21, 11],
    [17, 9],
    [22, 15],
    [18, 13],
    [20, 18],
    [23, 8],
    [17, 17],
  ],
  up: [
    [9, 7],
    [20, 7],
    [14, 10],
    [6, 13],
    [23, 13],
    [15, 15],
    [9, 18],
    [20, 18],
  ],
};
const CLIP_COLORS = [C.pink, C.lemon, C.cyan, C.neon, C.orange, C.plum, C.sky, C.berry] as const;

/** Small 3×1 snap clips in bright colours, only where there is hair under them. */
function drawClips(pc: PixelCanvas, L: CharacterLook, view: View, hy: number) {
  const hair = new Set(
    [L.hair.ramp.base, L.hair.ramp.shadow, L.hair.ramp.light].map((h) => packColor(h)),
  );
  const want = L.hair.clips === "many" ? 8 : 3;
  let n = 0;
  for (const [x, y] of CLIP_SPOTS[view]) {
    if (n >= want) break;
    if (![0, 1, 2].every((i) => hair.has(pc.get(x + i, y + hy)))) continue;
    const col = CLIP_COLORS[n % CLIP_COLORS.length]!;
    pc.hline(x, y + hy, 3, col);
    pc.set(x, y + hy, C.white);
    n++;
  }
}
