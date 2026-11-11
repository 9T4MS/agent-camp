/**
 * Head: skin silhouette per face shape and view, ears, eyes, brows, cheeks, mouth, facial hair.
 * Front head spans x6..25 (round face), rows 6..23 (+ head offset).
 */
import type { CharacterLook } from "@agent-office/protocol";
import type { PixelCanvas } from "../pixel.ts";
import { hash2, mix, NIGHT, WHITE } from "./color.ts";
import type { View } from "./geometry.ts";

type Span = readonly [number, number];
/** Skin spans per row (index 0 = texel row 6) for the front/back view. */
const FRONT: Record<CharacterLook["face"]["shape"], Span[]> = {
  round: [
    [9, 22],
    [7, 24],
    ...Array.from({ length: 13 }, () => [6, 25] as const),
    [7, 24],
    [8, 23],
    [10, 21],
  ],
  oval: [
    [9, 22],
    [7, 24],
    ...Array.from({ length: 12 }, () => [6, 25] as const),
    [7, 24],
    [8, 23],
    [9, 22],
    [11, 20],
  ],
  narrow: [
    [10, 21],
    [8, 23],
    ...Array.from({ length: 12 }, () => [7, 24] as const),
    [7, 24],
    [8, 23],
    [9, 22],
    [11, 20],
  ],
  square: [[8, 23], ...Array.from({ length: 16 }, () => [6, 25] as const), [7, 24]],
};
const SIDE: Span[] = [
  [11, 20],
  [9, 22],
  ...Array.from({ length: 13 }, () => [8, 23] as const),
  [9, 22],
  [10, 21],
  [11, 19],
];

export const HEAD_TOP = 6;

/** Face span (inclusive) at a texel row, for the front view. */
export function faceSpan(shape: CharacterLook["face"]["shape"], row: number): Span | null {
  return FRONT[shape][row - HEAD_TOP] ?? null;
}

/** Face columns at eye level (front). */
export const faceSides = (shape: CharacterLook["face"]["shape"]) => faceSpan(shape, 15)!;

export function drawHeadSkin(pc: PixelCanvas, L: CharacterLook, view: View, hy: number) {
  const s = L.skin;
  const spans = view === "left" ? SIDE : FRONT[L.face.shape];
  spans.forEach(([a, b], i) => {
    const y = HEAD_TOP + i + hy;
    for (let x = a; x <= b; x++) pc.set(x, y, s.base);
    if (view === "left") {
      // back of the head in shade
      pc.set(b, y, s.shadow);
    } else if (i >= 3) {
      pc.set(b, y, s.shadow); // right edge in shade (light from the upper left)
    }
  });
  const last = spans.length - 1;
  // chin / jaw shadow
  const [ca, cb] = spans[last]!;
  for (let x = ca; x <= cb; x++) pc.set(x, HEAD_TOP + last + hy, s.shadow);
  if (view !== "left") {
    const [pa, pb] = spans[last - 1]!;
    for (let x = pa; x <= pb; x++)
      if (x > (pa + pb) / 2 + 3) pc.set(x, HEAD_TOP + last - 1 + hy, s.shadow);
  }
  drawEars(pc, L, view, hy);
  if (view === "down") drawFaceFront(pc, L, hy);
  else if (view === "left") drawFaceSide(pc, L, hy);
}

function drawEars(pc: PixelCanvas, L: CharacterLook, view: View, hy: number) {
  const s = L.skin;
  const ears = L.face.ears;
  if (ears === "hidden") return;
  if (view === "left") {
    // ear in the middle of the side head
    const x = 16;
    pc.rect(x, 14 + hy, 2, 4, s.base);
    pc.vline(x + 1, 14 + hy, 4, s.shadow);
    if (ears === "visible") {
      pc.set(x - 1, 15 + hy, s.shadow);
      pc.set(x - 1, 16 + hy, s.shadow);
      pc.set(x + 2, 15 + hy, s.shadow);
      pc.set(x + 2, 16 + hy, s.base);
    } else pc.set(x, 15 + hy, s.shadow);
    return;
  }
  const [l, r] = faceSides(L.face.shape);
  if (ears === "small") {
    pc.vline(l - 1, 14 + hy, 3, s.base);
    pc.vline(r + 1, 14 + hy, 3, s.shadow);
    return;
  }
  // visible: 2 wide, sitting close to the head, inner shade
  pc.rect(l - 2, 14 + hy, 2, 4, s.base);
  pc.set(l - 2, 13 + hy, s.base);
  pc.set(l - 1, 15 + hy, s.shadow);
  pc.set(l - 1, 16 + hy, s.shadow);
  pc.rect(r + 1, 14 + hy, 2, 4, s.shadow);
  pc.set(r + 2, 13 + hy, s.shadow);
  pc.set(r + 1, 15 + hy, mix(s.shadow, NIGHT, 0.25));
  pc.set(r + 1, 16 + hy, mix(s.shadow, NIGHT, 0.25));
}

/** Eye texels (front): two eyes, each 2 wide. Exported for the lens painter. */
export const EYE_X = [12, 18] as const;

function drawFaceFront(pc: PixelCanvas, L: CharacterLook, hy: number) {
  const f = L.face;
  const s = L.skin;
  const ec = f.eyeColor;
  for (const ex of EYE_X) drawEye(pc, f.eyes, ec, ex, hy, false);
  // brows
  if (f.brows !== "none") {
    const c = L.hair.ramp.shadow;
    for (const ex of EYE_X) {
      pc.hline(ex - (ex === EYE_X[0] ? 1 : 0), 11 + hy, 3, c);
      if (f.brows === "thick") pc.hline(ex - (ex === EYE_X[0] ? 1 : 0), 10 + hy, 3, c);
    }
  }
  // cheeks
  const cheekY = (f.expression === "grin" || f.expression === "big-smile" ? 17 : 18) + hy;
  if (f.cheeks === "blush") {
    const blush = mix(s.base, "#f6757a", 0.55);
    pc.hline(9, cheekY, 2, blush);
    pc.hline(21, cheekY, 2, blush);
  } else if (f.cheeks === "freckles") {
    const fr = mix(s.shadow, NIGHT, 0.2);
    for (const [x, y] of [
      [9, 0],
      [11, 1],
      [10, 2],
      [20, 0],
      [22, 1],
      [21, 2],
    ] as const)
      pc.set(x, cheekY - 1 + y, fr);
  }
  drawMouthFront(pc, L, hy);
  drawFacialHairFront(pc, L, hy);
}

export function drawEye(
  pc: PixelCanvas,
  kind: CharacterLook["face"]["eyes"],
  ec: string,
  ex: number,
  hy: number,
  side: boolean,
) {
  const w = side ? 2 : 2;
  switch (kind) {
    case "dot":
      pc.rect(ex, 14 + hy, w, 3, ec);
      break;
    case "round":
      pc.rect(ex, 13 + hy, w, 4, ec);
      pc.set(ex + (side ? 0 : 1), 13 + hy, WHITE);
      break;
    case "narrow":
      pc.hline(ex - (side ? 0 : 1) + (ex > 16 ? 1 : 0), 15 + hy, 3, ec);
      pc.hline(ex, 16 + hy, w, ec);
      break;
    case "happy":
      // ^ ^ closed eyes
      pc.set(ex - 1 + (side ? 1 : 0), 16 + hy, ec);
      pc.hline(ex, 15 + hy, 2, ec);
      if (!side) pc.set(ex + 2, 16 + hy, ec);
      break;
  }
}

const LIP = "#7a3040";
function drawMouthFront(pc: PixelCanvas, L: CharacterLook, hy: number) {
  const s = L.skin;
  const dark = mix(s.shadow, LIP, 0.6);
  const y = 19 + hy;
  switch (L.face.expression) {
    case "neutral":
      pc.hline(15, y + 1, 2, s.shadow);
      break;
    case "serious":
      pc.hline(14, y + 1, 4, dark);
      break;
    case "smile":
      pc.set(13, y, dark);
      pc.set(18, y, dark);
      pc.hline(14, y + 1, 4, dark);
      break;
    case "big-smile":
      pc.hline(13, y, 6, dark);
      pc.hline(14, y + 1, 4, dark);
      pc.hline(15, y + 1, 2, "#e86a73");
      break;
    case "grin":
      // wide open smile showing the upper teeth
      pc.set(12, y - 1, dark);
      pc.set(19, y - 1, dark);
      pc.hline(13, y, 6, WHITE);
      pc.set(12, y, dark);
      pc.set(19, y, dark);
      pc.hline(13, y + 1, 6, dark);
      pc.hline(14, y + 1, 4, mix(dark, "#e86a73", 0.35));
      pc.hline(14, y + 2, 4, s.shadow);
      break;
    case "smirk":
      pc.hline(14, y + 1, 3, dark);
      pc.set(17, y, dark);
      break;
    case "surprised":
      pc.rect(15, y, 2, 2, dark);
      break;
  }
}

function drawFacialHairFront(pc: PixelCanvas, L: CharacterLook, hy: number) {
  const fh = L.facialHair;
  const c = fh.color;
  const sh = mix(c, NIGHT, 0.3);
  const [l, r] = faceSides(L.face.shape);
  switch (fh.style) {
    case "none":
      return;
    case "stubble":
      for (let y = 18; y <= 23; y++) {
        const sp = faceSpan(L.face.shape, y);
        if (!sp) continue;
        for (let x = sp[0] + 1; x < sp[1]; x++) {
          if (y < 20 && x > 11 && x < 20) continue;
          if (y === 19 || y === 20 ? x > 12 && x < 19 : false) continue;
          if (hash2(x, y, 5) % 3 === 0) pc.set(x, y + hy, c);
        }
      }
      return;
    case "mustache":
      pc.hline(13, 18 + hy, 6, c);
      pc.set(12, 19 + hy, c);
      pc.set(19, 19 + hy, c);
      pc.hline(14, 18 + hy, 4, sh);
      return;
    case "goatee":
      pc.hline(14, 18 + hy, 4, c);
      pc.rect(14, 21 + hy, 4, 2, c);
      pc.hline(15, 23 + hy, 2, sh);
      return;
    case "beard":
      for (let y = 17; y <= 23; y++) {
        const sp = faceSpan(L.face.shape, y);
        if (!sp) continue;
        for (let x = sp[0]; x <= sp[1]; x++) {
          const mouth = y >= 19 && y <= 20 && x >= 13 && x <= 18;
          const cheek = y < 19 && x > l + 2 && x < r - 2;
          if (mouth || cheek) continue;
          pc.set(x, y + hy, y === 23 || x === sp[1] ? sh : c);
        }
      }
      pc.hline(13, 18 + hy, 6, c);
      pc.rect(14, 24 + hy, 4, 1, sh);
      return;
  }
}

function drawFaceSide(pc: PixelCanvas, L: CharacterLook, hy: number) {
  const f = L.face;
  const s = L.skin;
  // nose
  pc.set(7, 15 + hy, s.base);
  pc.rect(6, 16 + hy, 2, 2, s.base);
  pc.set(6, 17 + hy, s.shadow);
  drawEye(pc, f.eyes, f.eyeColor, 10, hy, true);
  if (f.brows !== "none") {
    pc.hline(9, 11 + hy, 3, L.hair.ramp.shadow);
    if (f.brows === "thick") pc.hline(9, 10 + hy, 3, L.hair.ramp.shadow);
  }
  const cheekY = (f.expression === "grin" || f.expression === "big-smile" ? 17 : 18) + hy;
  if (f.cheeks === "blush") pc.hline(12, cheekY, 2, mix(s.base, "#f6757a", 0.55));
  if (f.cheeks === "freckles") {
    pc.set(12, cheekY, mix(s.shadow, NIGHT, 0.2));
    pc.set(14, cheekY + 1, mix(s.shadow, NIGHT, 0.2));
  }
  const dark = mix(s.shadow, LIP, 0.6);
  const y = 19 + hy;
  switch (f.expression) {
    case "grin":
      pc.hline(8, y, 3, WHITE);
      pc.set(11, y - 1, dark);
      pc.set(11, y, dark);
      pc.hline(8, y + 1, 3, dark);
      break;
    case "big-smile":
      pc.hline(8, y, 3, dark);
      pc.set(11, y - 1, dark);
      pc.set(9, y + 1, dark);
      break;
    case "smile":
    case "smirk":
      pc.hline(8, y + 1, 2, dark);
      pc.set(10, y, dark);
      break;
    case "surprised":
      pc.rect(8, y, 1, 2, dark);
      break;
    case "serious":
      pc.hline(8, y + 1, 3, dark);
      break;
    default:
      pc.set(8, y + 1, s.shadow);
  }
  const fh = L.facialHair;
  const c = fh.color;
  switch (fh.style) {
    case "stubble":
      for (const [x, yy] of [
        [9, 20],
        [11, 21],
        [13, 20],
        [10, 22],
        [12, 22],
        [14, 21],
      ] as const)
        pc.set(x, yy + hy, c);
      break;
    case "mustache":
      pc.hline(7, 18 + hy, 4, c);
      break;
    case "goatee":
      pc.hline(8, 18 + hy, 3, c);
      pc.rect(9, 21 + hy, 3, 2, c);
      break;
    case "beard":
      pc.hline(7, 18 + hy, 4, c);
      for (let yy = 19; yy <= 23; yy++) {
        const [a] = SIDE[yy - HEAD_TOP]!;
        for (let x = Math.max(a, 8); x <= 16; x++) {
          if (yy <= 20 && x <= 10) continue;
          pc.set(x, yy + hy, c);
        }
      }
      pc.hline(10, 24 + hy, 4, mix(c, NIGHT, 0.3));
      break;
    default:
  }
}
