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
  // agent kinds (agent card): Claude sunburst, Codex terminal, Pi glyph, Design artboard + pen,
  // unknown "?"
  claude: [
    ".......r........",
    "...r...r...r....",
    "....r..r..r.....",
    ".....r.r.r......",
    "......rrr.......",
    ".rrrrrrcrrrrrr..",
    "......rrr.......",
    ".....r.r.r......",
    "....r..r..r.....",
    "...r...r...r....",
    ".......r........",
  ],
  codex: [
    "................",
    ".kkkkkkkkkkkkkk.",
    ".kbbbbbbbbbbbbk.",
    ".kbcbbbbbbbbbbk.",
    ".kbbcbbbbbbbbbk.",
    ".kbbbcbbbbbbbbk.",
    ".kbbcbbbbbbbbbk.",
    ".kbcbbbllllbbbk.",
    ".kbbbbbbbbbbbbk.",
    ".kkkkkkkkkkkkkk.",
  ],
  pi: [
    "................",
    "..aaaaaaaaaaaa..",
    "..aaaaaaaaaaaa..",
    "....aa....aa....",
    "....aa....aa....",
    "....aa....aa....",
    "....aa....aa....",
    "...aa.....aa....",
    "..aa......aaa...",
  ],
  design: [
    "................",
    ".kkkkkkkkkkk.pp.",
    ".kwwwwwwwwwkppp.",
    ".kwrrrwwwwwppp..",
    ".kwrrrwwwwpppk..",
    ".kwrrrwwwpppwk..",
    ".kwwwwwwlppwwk..",
    ".kwcccccllwwwk..",
    ".kwwwwwwwwwwwk..",
    ".kkkkkkkkkkkkk..",
  ],
  unknown: [
    ".....wwwwww.....",
    "....ww....ww....",
    "..........ww....",
    ".........ww.....",
    "........ww......",
    ".......ww.......",
    ".......ww.......",
    "................",
    ".......ww.......",
    ".......ww.......",
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
  r: C.rust,
  o: C.clay,
};
const AGENT_ICON_COLORS: Partial<Record<string, Record<string, string>>> = {
  claude: { ...COLORS, c: C.lemon, r: C.clay },
  pi: { ...COLORS, a: C.leaf },
  design: { ...COLORS, p: C.berry, r: C.pink, c: C.slate },
  unknown: { ...COLORS, w: C.silver },
};

const cache = new Map<string, string>();
export type IconName = keyof typeof ICON_ROWS;
export function iconUrl(name: IconName): string {
  const hit = cache.get(name);
  if (hit) return hit;
  const pc = new PixelCanvas(16, 16);
  const rows = ICON_ROWS[name].map((r) => r.replace(/ /g, "s"));
  const colors =
    name === "logo"
      ? { ...COLORS, g: C.pine, l: C.leaf, c: C.lemon }
      : (AGENT_ICON_COLORS[name] ?? COLORS);
  pc.sprite(0, 2, rows, colors);
  pc.outline();
  const url = pc.toCanvas().toDataURL("image/png");
  cache.set(name, url);
  return url;
}
