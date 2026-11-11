/** Tiny HUD icons (16x16) drawn with the same pixel tools, as data URLs. */
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";

const ICON_ROWS = {
  person: [
    "................",
    ".....hhhhhh.....",
    "....hhhhhhhh....",
    "....hssssssh....",
    "....sseses s....",
    "....ssssssss....",
    ".....ssssss.....",
    "...jjjjwwjjjj...",
    "..jjjjjwwjjjjj..",
    "..jjjjjwwjjjjj..",
    "..jjjjjjjjjjjj..",
  ],
  monitor: [
    "................",
    "..kkkkkkkkkkkk..",
    "..kbbbbbbbbbbk..",
    "..kbccccbbbbbk..",
    "..kbbbllllbbbk..",
    "..kbccbbbbbbbk..",
    "..kbbbbbbbbbbk..",
    "..kkkkkkkkkkkk..",
    "......gggg......",
    "....gggggggg....",
  ],
  bot: [
    "................",
    ".......a........",
    ".......g........",
    "....wwwwwwww....",
    "...wwwwwwwwww...",
    "...wkkkkkkkkw...",
    "...wkakkkkakw...",
    "...wwwwwwwwww...",
    "....jjjjjjjj....",
    "....g......g....",
  ],
  logo: [
    "................",
    "...kkkkkkkkkk...",
    "...kggggggggk...",
    "...kgllgccggk...",
    "...kggggggggk...",
    "...kkkkkkkkkk...",
    "......kkkk......",
    ".tttttttttttttt.",
    ".dddddddddddddd.",
    ".b............b.",
    ".b............b.",
  ],
} as const;

const COLORS: Record<string, string> = {
  h: C.bark,
  s: C.peach,
  e: C.night,
  j: C.rust,
  w: C.white,
  k: C.night,
  b: C.navy,
  c: C.cyan,
  l: C.lemon,
  g: C.slate,
  a: C.leaf,
  t: C.sand,
  d: C.wood,
};

const cache = new Map<string, string>();
export function iconUrl(name: keyof typeof ICON_ROWS): string {
  const hit = cache.get(name);
  if (hit) return hit;
  const pc = new PixelCanvas(16, 16);
  const rows = ICON_ROWS[name].map((r) => r.replace(/ /g, "s"));
  pc.sprite(0, 2, rows, name === "logo" ? { ...COLORS, g: C.pine, l: C.leaf, c: C.lemon } : COLORS);
  pc.outline();
  const url = pc.toCanvas().toDataURL("image/png");
  cache.set(name, url);
  return url;
}
