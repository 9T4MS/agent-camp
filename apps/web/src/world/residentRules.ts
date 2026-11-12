/**
 * Pure rules of the residents without an agent: when the hourly bow starts, where the lines
 * in front of the head desk form, how a haggle at the sales stand goes and what the CFO says
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

export type CfoLine = { who: "cfo" | "dev"; text: string };

const ASKS = ["MY CONTRACT?", "CONTRACT READY?", "CAN I SIGN MY CONTRACT?"];
const HARD = ["HMM. THAT'S HARD.", "OH, THAT'S TRICKY.", "DIFFICULT, DIFFICULT."];
const TAKES_TIME = ["IT WILL TAKE TIME.", "THAT TAKES TIME.", "GIVE IT TIME."];
const REACTIONS = ["OK... I'LL WAIT.", "SINCE MARCH?", "OK...", "SIGH."];

/**
 * One visit at the CFO's desk: a dev asks for their contract, the CFO says it's hard and it
 * will take time; the dev gives up.
 */
export function cfoTalk(rand: () => number): { lines: CfoLine[] } {
  return {
    lines: [
      { who: "dev", text: pick(rand, ASKS) },
      { who: "cfo", text: pick(rand, HARD) },
      { who: "cfo", text: pick(rand, TAKES_TIME) },
      { who: "dev", text: pick(rand, REACTIONS) },
    ],
  };
}

const CALL_OPEN = [
  "HELLO WEKAO! IT'S ME!",
  "MY FAVOURITE COLLEAGUE AT WEKAO!",
  "HI! HOW ARE THINGS AT WEKAO?",
];
const CALL_MIDDLE = [
  "I MISSED YOU!",
  "HAHAHA, YES!",
  "YOU'RE THE BEST.",
  "WE SHOULD GET LUNCH!",
  "JUST WANTED TO HEAR YOUR VOICE.",
  "NO, YOU'RE TOO KIND!",
  "TELL EVERYONE AT WEKAO I SAY HI.",
];
const CALL_CLOSE = ["NO, YOU HANG UP FIRST!", "TALK SOON! BYE BYE!", "CIAO, BYE!"];

/**
 * The CFO calls his beloved colleague at WEKAO: he dials, greets, says two or three things
 * (the other side is never heard) and says goodbye.
 */
export function cfoCall(rand: () => number): string[] {
  const middle = [...CALL_MIDDLE];
  const lines = ["CALLING WEKAO...", pick(rand, CALL_OPEN)];
  const n = rand() < 0.5 ? 2 : 3;
  for (let i = 0; i < n; i++) lines.push(middle.splice(Math.floor(rand() * middle.length), 1)[0]!);
  lines.push(pick(rand, CALL_CLOSE));
  return lines;
}

export type CfoOutingTopic = "wifi" | "lunch";
export type CfoOuting = {
  topic: CfoOutingTopic;
  /** what he calls out when he leaves his office */
  leave: string;
  ask: string;
  answer: string;
  thanks: string;
};

const OUTINGS: Record<
  CfoOutingTopic,
  { leave: string; ask: string; answers: readonly string[]; thanks: readonly string[] }
> = {
  wifi: {
    leave: "WIFI IS DOWN!",
    ask: "WHERE IS THE WIFI?!",
    answers: [
      "SAME AS YESTERDAY.",
      "IT'S ON THE ROUTER.",
      "ASK THE IT GUY!",
      "PASSWORD'S ON THE FRIDGE.",
      "TURN IT OFF AND ON?",
      "IT'S ALWAYS BEEN THERE.",
    ],
    thanks: ["AH. THANKS!", "STILL NOTHING.", "OK. WHICH ROUTER?"],
  },
  lunch: {
    leave: "LUNCH TIME!",
    ask: "ANYONE ORDERING LUNCH AT PHO HA NOI?!",
    answers: [
      "ME! NUMBER 12!",
      "PHO BO, PLEASE!",
      "ALREADY ATE.",
      "SPRING ROLLS FOR ME!",
      "AGAIN? SURE!",
      "I BROUGHT MY OWN.",
    ],
    thanks: ["NOTED!", "OK, I'LL ORDER.", "MORE FOR ME.", "PHO IT IS!"],
  },
};

/**
 * The CFO out of his office, either "WHERE IS THE WIFI?!" or "ANYONE ORDERING LUNCH AT PHO HA
 * NOI?!" (half and half); someone answers, he has the last word.
 */
export function cfoOuting(rand: () => number): CfoOuting {
  const topic: CfoOutingTopic = rand() < 0.5 ? "wifi" : "lunch";
  const o = OUTINGS[topic];
  return {
    topic,
    leave: o.leave,
    ask: o.ask,
    answer: pick(rand, o.answers),
    thanks: pick(rand, o.thanks),
  };
}
