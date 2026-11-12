/**
 * Headwear, earrings and the sibling-session hat. Catalog headwear (beanie, cap, bow,
 * headphones) reuses the original 1× layers through Scale2x so it looks like before.
 */
import type { CharacterLook } from "@agent-office/protocol";
import { C } from "../palette.ts";
import type { PixelCanvas } from "../pixel.ts";
import { mix, NIGHT } from "./color.ts";
import { drawNoveltyHeadwear } from "./extras.ts";
import type { View } from "./geometry.ts";
import { scale2x } from "./hair.ts";
import { faceSides } from "./head.ts";

type Layer = readonly string[];
const ACC: Record<"headphones" | "beanie" | "cap" | "bow", Record<View, Layer>> = {
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
};
const HAT: Record<View, Layer> = {
  down: [".....TTTTTT.....", ".....TTTTTT.....", ".....tttttt.....", ".YYYYYYYYYYYYYY."],
  up: [".....TTTTTT.....", ".....TTTTTT.....", ".....tttttt.....", ".YYYYYYYYYYYYYY."],
  left: [".....TTTTTT.....", ".....TTTTTT.....", ".....tttttt.....", "..YYYYYYYYYYYY.."],
};

const cache = new Map<string, string[]>();
function up2(key: string, rows: Layer): string[] {
  let v = cache.get(key);
  if (!v) {
    v = scale2x(rows);
    cache.set(key, v);
  }
  return v;
}

/** Wide-brim hats: crown box + brim line, drawn procedurally. */
function drawBrimHat(
  pc: PixelCanvas,
  hw: CharacterLook["headwear"],
  view: View,
  hy: number,
  felt: boolean,
) {
  const { base, shadow, light } = hw.ramp;
  const side = view === "left";
  const cl = side ? 9 : 9;
  const cr = side ? 22 : 22;
  const crownTop = felt ? 2 : 3;
  const brimY = 8;
  // crown
  for (let y = crownTop; y < brimY; y++) {
    const inset = y === crownTop ? 2 : y === crownTop + 1 && felt ? 1 : 0;
    for (let x = cl + inset; x <= cr - inset; x++) pc.set(x, y + hy, x >= cr - 1 ? shadow : base);
  }
  if (felt) pc.hline(cl + 4, crownTop + hy, cr - cl - 7, shadow); // pinched crown
  pc.set(cl + 1, crownTop + 2 + hy, light);
  // band
  pc.hline(cl, brimY - 2 + hy, cr - cl + 1, hw.accent);
  pc.hline(cl, brimY - 1 + hy, cr - cl + 1, felt ? hw.accent : base);
  if (felt) {
    // a little tuft/feather on the side
    pc.vline(side ? cr - 1 : cr - 2, crownTop - 1 + hy, 3, light);
    pc.set(side ? cr : cr - 1, crownTop - 2 + hy, light);
  }
  // brim
  if (felt) {
    pc.hline(cl - 3, brimY + hy, cr - cl + 7, shadow);
    pc.hline(cl - 2, brimY + hy, cr - cl + 5, base);
  } else {
    // bucket: sloped brim all around
    pc.hline(cl - 2, brimY + hy, cr - cl + 5, base);
    pc.hline(cl - 3, brimY + 1 + hy, cr - cl + 7, shadow);
  }
}

/** First opaque row of column x between rows y0..y1 (the top of the hair or head), or null. */
function topAt(pc: PixelCanvas, x: number, y0: number, y1: number): number | null {
  for (let y = y0; y <= y1; y++) if (pc.get(x, y) >>> 24 !== 0) return y;
  return null;
}

/**
 * Alice band: a thin band that follows the top of the hair (so it curves with every cut) a
 * little behind the hairline, its ends running down to the ears. It sits over the crown and
 * ends behind the ears, so from behind the hair hides it.
 */
function drawHairband(pc: PixelCanvas, L: CharacterLook, view: View, hy: number) {
  if (view === "up") return;
  const { base, shadow, light } = L.headwear.ramp;
  const ear = 14 + hy;
  if (view === "left") {
    // seen from the side: the band crosses the crown in front of the ear, leaning back
    for (let y = hy; y < ear; y++) {
      const x = y < 9 + hy ? 13 : y < 12 + hy ? 14 : 15;
      const top = topAt(pc, x, hy, ear);
      if (top === null || y < top + 1) continue;
      pc.set(x, y, y === top + 1 ? light : base);
      pc.set(x + 1, y, shadow);
    }
    return;
  }
  const [fl, fr] = faceSides(L.face.shape);
  const xl = fl - 1;
  const xr = fr + 1;
  const cx = (xl + xr) / 2;
  const half = (xr - xl) / 2;
  for (let x = xl; x <= xr; x++) {
    const top = topAt(pc, x, hy, ear);
    if (top === null) continue;
    // a little hair shows above it, and it bends down towards the ears even on flat tops
    const t = (x - cx) / half;
    const y = top + 3 + Math.round(t * t * 3);
    if (y >= ear) continue;
    pc.set(x, y, x < (xl + xr) / 2 - 3 && x > xl + 2 ? light : base);
    pc.set(x, y + 1, shadow);
    // the two ends run down over the hair to the ears
    if (x === xl || x === xr) for (let yy = y + 1; yy < ear; yy++) pc.set(x, yy, base);
  }
}

export function drawHeadwear(
  pc: PixelCanvas,
  L: CharacterLook,
  view: View,
  hy: number,
  hat: boolean,
) {
  const hw = L.headwear;
  const { base, shadow, light } = hw.ramp;
  switch (hw.style) {
    case "none":
      break;
    case "beanie":
      pc.sprite(0, hy, up2(`beanie/${view}`, ACC.beanie[view]), {
        B: base,
        b: light,
        p: hw.accent,
      });
      // knit ribs on the cuff
      for (let x = 5; x < 27; x += 2) pc.set(x, 9 + hy, mix(light, shadow, 0.5));
      break;
    case "cap": {
      pc.sprite(0, hy, up2(`cap/${view}`, ACC.cap[view]), { A: base, a: light, N: hw.accent });
      // small logo on the front panel (the mint cap's white logo)
      const logo = hw.logo && hw.logo !== "none" ? hw.logo : null;
      if (logo && view === "down") pc.rect(14, 6 + hy, 4, 2, logo);
      if (logo && view === "left") pc.rect(8, 6 + hy, 2, 2, logo);
      break;
    }
    case "cap-backwards": {
      const v: View = view === "down" ? "up" : view === "up" ? "down" : "left";
      if (view === "left") {
        // the side cap without its brim, brim sticking out at the back of the head instead
        const rows = up2("cap/left", ACC.cap.left).map((r) => r.replace(/N/g, "."));
        pc.sprite(0, hy, rows, { A: base, a: light, N: hw.accent });
        pc.hline(22, 10 + hy, 8, hw.accent);
        pc.hline(24, 11 + hy, 6, mix(hw.accent, NIGHT, 0.3));
      } else {
        pc.sprite(0, hy, up2(`cap/${v}`, ACC.cap[v]), { A: base, a: light, N: hw.accent });
      }
      if (view === "down") pc.hline(13, 9 + hy, 6, hw.accent); // strap opening seen from the front
      break;
    }
    case "bucket-hat":
      drawBrimHat(pc, hw, view, hy, false);
      break;
    case "felt-hat":
      drawBrimHat(pc, hw, view, hy, true);
      break;
    case "headband": {
      const [l, r] = view === "left" ? [8, 23] : faceSides(L.face.shape);
      pc.hline(l, 9 + hy, r - l + 1, base);
      pc.hline(l, 10 + hy, r - l + 1, hw.accent);
      pc.hline(l, 11 + hy, r - l + 1, shadow);
      break;
    }
    case "hairband":
      drawHairband(pc, L, view, hy);
      break;
    case "bow":
      pc.sprite(0, hy, up2(`bow/${view}`, ACC.bow[view]), { R: base, r: hw.accent });
      break;
    case "cat-ears":
    case "fox-ears":
    case "bunny-ears":
    case "devil-horns":
    case "halo":
    case "crown":
    case "wizard-hat":
    case "party-hat":
    case "antenna":
      drawNoveltyHeadwear(pc, L, view, hy);
      break;
    case "headphones":
      if (!hat)
        pc.sprite(0, hy, up2(`hp/${view}`, ACC.headphones[view]), {
          K: hw.accent,
          P: base,
          Q: light,
        });
      break;
  }
  if (hat) pc.sprite(0, hy, up2(`hat/${view}`, HAT[view]), { T: C.amber, t: C.red, Y: C.sand });
}

export function drawEarrings(pc: PixelCanvas, L: CharacterLook, view: View, hy: number) {
  const e = L.earrings;
  if (e.style === "none" || L.face.ears === "hidden") return;
  const dark = mix(e.color, NIGHT, 0.35);
  const xs: number[] =
    view === "left"
      ? [17]
      : (() => {
          const [l, r] = faceSides(L.face.shape);
          const w = L.face.ears === "visible" ? 2 : 1;
          return [l - w, r + w];
        })();
  for (const x of xs) {
    if (e.style === "stud") {
      pc.set(x, 18 + hy, e.color);
    } else {
      pc.set(x, 18 + hy, e.color);
      pc.set(x - 1, 19 + hy, e.color);
      pc.set(x + 1, 19 + hy, dark);
      pc.set(x, 20 + hy, dark);
    }
  }
}
