/**
 * "Tiny Office" 3x5 bitmap font (caps, digits, a little punctuation), drawn straight into
 * PixelCanvas so in-world text scales with the camera exactly like the art does.
 * Lowercase maps to caps; accents are stripped; unknown glyphs render as "?".
 */
import type { PixelCanvas } from "./pixel.ts";

const G: Record<string, string> = {
  A: ".#.|#.#|###|#.#|#.#",
  B: "##.|#.#|##.|#.#|##.",
  C: ".##|#..|#..|#..|.##",
  D: "##.|#.#|#.#|#.#|##.",
  E: "###|#..|##.|#..|###",
  F: "###|#..|##.|#..|#..",
  G: ".##|#..|#.#|#.#|.##",
  H: "#.#|#.#|###|#.#|#.#",
  I: "###|.#.|.#.|.#.|###",
  J: "..#|..#|..#|#.#|.#.",
  K: "#.#|#.#|##.|#.#|#.#",
  L: "#..|#..|#..|#..|###",
  M: "#...#|##.##|#.#.#|#...#|#...#",
  N: "#..#|##.#|#.##|#..#|#..#",
  O: ".#.|#.#|#.#|#.#|.#.",
  P: "##.|#.#|##.|#..|#..",
  Q: ".#.|#.#|#.#|##.|.##",
  R: "##.|#.#|##.|#.#|#.#",
  S: ".##|#..|.#.|..#|##.",
  T: "###|.#.|.#.|.#.|.#.",
  U: "#.#|#.#|#.#|#.#|###",
  V: "#.#|#.#|#.#|#.#|.#.",
  W: "#...#|#...#|#.#.#|##.##|#...#",
  X: "#.#|#.#|.#.|#.#|#.#",
  Y: "#.#|#.#|.#.|.#.|.#.",
  Z: "###|..#|.#.|#..|###",
  "0": "###|#.#|#.#|#.#|###",
  "1": ".#.|##.|.#.|.#.|###",
  "2": "##.|..#|.#.|#..|###",
  "3": "##.|..#|.#.|..#|##.",
  "4": "#.#|#.#|###|..#|..#",
  "5": "###|#..|##.|..#|##.",
  "6": ".##|#..|###|#.#|###",
  "7": "###|..#|.#.|.#.|.#.",
  "8": "###|#.#|###|#.#|###",
  "9": "###|#.#|###|..#|##.",
  " ": "..|..|..|..|..",
  "-": "...|...|###|...|...",
  _: "...|...|...|...|###",
  "+": "...|.#.|###|.#.|...",
  ".": ".|.|.|.|#",
  ",": "..|..|..|.#|#.",
  ":": ".|#|.|#|.",
  "!": "#|#|#|.|#",
  "?": "##.|..#|.#.|...|.#.",
  "'": "#|#|.|.|.",
  "/": "..#|..#|.#.|#..|#..",
  "(": ".#|#.|#.|#.|.#",
  ")": "#.|.#|.#|.#|#.",
  "#": "#.#|###|#.#|###|#.#",
  "&": ".#.|#.#|.#.|#.#|.##",
  "%": "#.#|..#|.#.|#..|#.#",
  "*": "...|#.#|.#.|#.#|...",
  "=": "...|###|...|###|...",
  "<": "..#|.#.|#..|.#.|..#",
  ">": "#..|.#.|..#|.#.|#..",
  "@": "###|#.#|#.#|#..|.##",
};

type Glyph = { w: number; rows: string[] };
const GLYPHS = new Map<string, Glyph>();
for (const [ch, def] of Object.entries(G)) {
  const rows = def.split("|");
  GLYPHS.set(ch, { w: rows[0]!.length, rows });
}

export const FONT_HEIGHT = 5;

export function normalizeText(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

function glyph(ch: string): Glyph {
  return GLYPHS.get(ch) ?? GLYPHS.get("?")!;
}

export function measureText(text: string): number {
  const t = normalizeText(text);
  let w = 0;
  for (const ch of t) w += glyph(ch).w + 1;
  return Math.max(0, w - 1);
}

/** Truncate with ".." so the text fits `maxWidth` pixels. */
export function fitText(text: string, maxWidth: number): string {
  if (measureText(text) <= maxWidth) return text;
  let t = normalizeText(text);
  while (t.length > 1 && measureText(`${t}..`) > maxWidth) t = t.slice(0, -1);
  return `${t}..`;
}

/** Draw text with its top-left at (x, y); returns the drawn width. */
export function drawText(pc: PixelCanvas, x: number, y: number, text: string, hex: string): number {
  let cx = x;
  for (const ch of normalizeText(text)) {
    const g = glyph(ch);
    for (let j = 0; j < FONT_HEIGHT; j++) {
      const row = g.rows[j]!;
      for (let i = 0; i < g.w; i++) if (row[i] === "#") pc.set(cx + i, y + j, hex);
    }
    cx += g.w + 1;
  }
  return cx - x - 1;
}
