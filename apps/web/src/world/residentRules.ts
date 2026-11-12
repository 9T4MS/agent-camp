/**
 * Pure rules of the residents without an agent: when the hourly bow starts, where the lines
 * in front of the head desk form, how a haggle at the sales stand goes and what Kurt says
 * when someone asks him for something.
 */
import type { Point } from "./map.ts";

/** The office clock just went past a full hour (prev and now in 0..24, a few seconds apart). */
export function hourCrossed(prev: number | null, now: number): boolean {
  if (prev === null) return false;
  const ahead = (now - prev + 24) % 24;
  return ahead > 0 && ahead < 0.25 && Math.floor(now) !== Math.floor(prev);
}

type Grid = { isWalkable(x: number, y: number): boolean };

const key = (p: Point) => `${p.x},${p.y}`;

/** Nearest walkable, unused tile to `from` (breadth-first over walkable tiles). */
function nearestFree(grid: Grid, from: Point, used: Set<string>, radius: number): Point | null {
  const seen = new Set([key(from)]);
  let ring: Point[] = [from];
  for (let r = 0; r < radius && ring.length; r++) {
    const next: Point[] = [];
    for (const p of ring) {
      for (const d of [
        { x: 0, y: 1 },
        { x: -1, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: -1 },
      ]) {
        const q = { x: p.x + d.x, y: p.y + d.y };
        if (seen.has(key(q)) || !grid.isWalkable(q.x, q.y)) continue;
        seen.add(key(q));
        if (!used.has(key(q))) return q;
        next.push(q);
      }
    }
    ring = next;
  }
  return null;
}

/**
 * Tiles of the lines in front of the head desk: each line runs straight down from its front
 * tile while the floor is free, then bunches up wherever there is room. Lines take turns, so
 * neither runs out of room first. `counts[i]` people stand in line i.
 */
export function lineSpots(
  grid: Grid,
  fronts: readonly Point[],
  counts: readonly number[],
): Point[][] {
  const used = new Set<string>(fronts.map(key));
  const lines: Point[][] = fronts.map((f) => (grid.isWalkable(f.x, f.y) ? [f] : []));
  const straight = fronts.map(() => true);
  for (let round = 0; round < 200; round++) {
    let grew = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length >= (counts[i] ?? 0)) continue;
      const last = line[line.length - 1] ?? fronts[i]!;
      let next: Point | null = null;
      if (straight[i]) {
        const below = { x: last.x, y: last.y + 1 };
        if (grid.isWalkable(below.x, below.y) && !used.has(key(below))) next = below;
        else straight[i] = false;
      }
      next ??= nearestFree(grid, last, used, 14);
      if (!next) continue;
      used.add(key(next));
      line.push(next);
      grew = true;
    }
    if (!grew) break;
  }
  return lines.map((l, i) => l.slice(0, counts[i] ?? 0));
}

export type HaggleLine = { who: "seller" | "client"; text: string };

const pick = <T>(rand: () => number, list: readonly T[]): T =>
  list[Math.floor(rand() * list.length)]!;

const OPENERS = ["HOW MUCH?", "WHAT'S THE PRICE?", "I HAVE A BUDGET.", "JUST LOOKING..."];
const PITCHES = ["FOR YOU? DOUBLE.", "PREMIUM PLAN!", "ONLY 30% MORE!", "ENTERPRISE TIER!"];
const PUSHBACK = ["TOO EXPENSIVE!", "HMM...", "10% OFF?", "MY BOSS SAYS NO."];
const SWEETENERS = [
  "+ FREE EIERSPEIS!",
  "I THROW IN A SCHNITZEL.",
  "PRICE GOES UP TOMORROW.",
  "BEST DEAL IN VIENNA!",
];
const YES = ["DEAL!", "FINE, DEAL!", "SIGN ME UP!"];
const THANKS = ["PLEASURE!", "SEE YOU AT LUNCH!", "WELCOME ABOARD!"];
const NO = ["I'LL THINK ABOUT IT.", "MAYBE NEXT YEAR."];
const LATER = ["NEXT WEEK +20%!", "THE OFFER STANDS!"];

/** One haggle at the sales stand: client asks, seller pitches high, sweetens, mostly closes. */
export function haggle(rand: () => number): { lines: HaggleLine[]; deal: boolean } {
  const deal = rand() < 0.7;
  const lines: HaggleLine[] = [
    { who: "client", text: pick(rand, OPENERS) },
    { who: "seller", text: pick(rand, PITCHES) },
    { who: "client", text: pick(rand, PUSHBACK) },
    { who: "seller", text: pick(rand, SWEETENERS) },
    deal ? { who: "client", text: pick(rand, YES) } : { who: "client", text: pick(rand, NO) },
    deal ? { who: "seller", text: pick(rand, THANKS) } : { who: "seller", text: pick(rand, LATER) },
  ];
  return { lines, deal };
}

export type KurtTopic = "klima" | "contract";
export type KurtLine = { who: "kurt" | "dev"; text: string };

const ASKS: Record<KurtTopic, readonly string[]> = {
  klima: ["KLIMA TICKET?", "MY KLIMA TICKET?", "ANY NEWS ON THE KLIMA TICKET?"],
  contract: ["MY CONTRACT?", "CONTRACT READY?", "CAN I SIGN MY CONTRACT?"],
};
const HARD = ["HMM. THAT'S HARD.", "OH, THAT'S TRICKY.", "DIFFICULT, DIFFICULT."];
const THIS_AND_THAT = [
  "I'M DOING THIS AND THAT.",
  "RIGHT NOW: THIS AND THAT.",
  "FIRST THIS, THEN THAT.",
];
const TAKES_TIME = ["IT WILL TAKE TIME.", "THAT TAKES TIME.", "GIVE IT TIME."];
const REACTIONS: Record<KurtTopic, readonly string[]> = {
  klima: ["OK... BY BIKE THEN.", "SINCE MARCH?", "OK...", "SIGH."],
  contract: ["OK... I'LL WAIT.", "SINCE MARCH?", "OK...", "SIGH."],
};

/**
 * One visit at Kurt's desk: a dev asks for the Klima ticket or a contract, Kurt says it's
 * hard, he's doing this and that, it will take time; the dev gives up.
 */
export function kurtTalk(rand: () => number): { topic: KurtTopic; lines: KurtLine[] } {
  const topic: KurtTopic = rand() < 0.5 ? "klima" : "contract";
  return {
    topic,
    lines: [
      { who: "dev", text: pick(rand, ASKS[topic]) },
      { who: "kurt", text: pick(rand, HARD) },
      { who: "kurt", text: pick(rand, THIS_AND_THAT) },
      { who: "kurt", text: pick(rand, TAKES_TIME) },
      { who: "dev", text: pick(rand, REACTIONS[topic]) },
    ],
  };
}

const WIFI_ANSWERS = [
  "SAME AS YESTERDAY.",
  "IT'S ON THE ROUTER.",
  "ASK RICHARD!",
  "PASSWORD'S ON THE FRIDGE.",
  "TURN IT OFF AND ON?",
  "IT'S ALWAYS BEEN THERE.",
];
const WIFI_THANKS = ["AH. THANKS!", "STILL NOTHING.", "THIS AND THAT, THEN.", "OK. WHICH ROUTER?"];

/** Kurt out of his office: "WHERE IS THE WIFI?!", someone answers, he gives his verdict. */
export function kurtWifi(rand: () => number): { ask: string; answer: string; thanks: string } {
  return {
    ask: "WHERE IS THE WIFI?!",
    answer: pick(rand, WIFI_ANSWERS),
    thanks: pick(rand, WIFI_THANKS),
  };
}
