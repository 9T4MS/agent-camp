/**
 * Pure rules of the IT guy in the server cabin: when the cabin catches fire next,
 * which developer gets new RAM first, how much mess he leaves lying around, and his lines.
 */
import type { Point } from "./map.ts";

/** Context share from which a developer's agent "needs more RAM" (and asks first). */
export const RAM_HUNGRY_AT = 0.5;
/** At most this many pieces of mess lie around at once. */
export const MESS_MAX = 6;
/** Seconds a piece of mess stays on the floor (the last few fade out). */
export const MESS_LIFE_S = 120;

/** Mean seconds between cabin fires (shorter in the party demo). */
export const FIRE_EVERY_S = 330;
/** Mean seconds between RAM requests (shorter in the party demo). */
export const RAM_EVERY_S = 70;

/** Seconds until the next event of a timer with mean `every`: ±25 % at random. */
export function jitter(every: number, rand: () => number): number {
  return every * (0.75 + rand() * 0.5);
}

export type RamTarget = Point & { id: string; context: number };

/**
 * Who asks the IT guy for RAM: someone whose agent uses at least half its context window if
 * there is one (the fullest first, ties at random), otherwise anyone with a working agent.
 */
export function pickRamTarget<T extends RamTarget>(
  targets: readonly T[],
  rand: () => number,
): T | null {
  if (targets.length === 0) return null;
  const hungry = targets.filter((t) => t.context >= RAM_HUNGRY_AT);
  if (hungry.length === 0) return targets[Math.floor(rand() * targets.length)]!;
  const top = Math.max(...hungry.map((t) => t.context));
  const fullest = hungry.filter((t) => t.context === top);
  return fullest[Math.floor(rand() * fullest.length)]!;
}

/** How much RAM goes in this time: 16, 32 or 64 GB, more for fuller context windows. */
export function ramSize(context: number, rand: () => number): number {
  const base = context >= 0.8 ? 2 : context >= RAM_HUNGRY_AT ? 1 : 0;
  return 16 * 2 ** Math.min(2, base + (rand() < 0.3 ? 1 : 0));
}

export type Mess = { born: number };

/**
 * Mess that has to go now: everything past its life, and the oldest pieces beyond `max`
 * (counting one more piece about to be dropped when `dropping`).
 */
export function expiredMess<T extends Mess>(
  items: readonly T[],
  now: number,
  dropping = false,
  max = MESS_MAX,
  life = MESS_LIFE_S,
): T[] {
  const alive = items.filter((m) => now - m.born < life).sort((a, b) => a.born - b.born);
  const over = Math.max(0, alive.length + (dropping ? 1 : 0) - max);
  const keep = new Set(alive.slice(over));
  return items.filter((m) => !keep.has(m));
}

/** Opacity of a piece of mess: solid, then fading out over its last 10 s. */
export function messAlpha(age: number, life = MESS_LIFE_S): number {
  return Math.max(0, Math.min(1, (life - age) / 10));
}

export const RAM_ASKS = [
  "IT GUY! MORE RAM!",
  "IT GUY, IT'S SWAPPING!",
  "OUT OF MEMORY AGAIN!",
  "IT GUY! RAM PLEASE!",
];
export const RAM_COMING = ["COMING!", "ON MY WAY!", "RAM? I HAVE RAM!", "HOLD ON!"];
export const RAM_THANKS = ["FINALLY!", "SO FAST NOW!", "THANKS IT GUY!", "IT FLIES!"];
export const FIRE_START = ["MY SERVERS!", "NOT AGAIN!", "FIRE! FIRE!", "WHO PLUGGED THAT IN?!"];
export const FIRE_OUT = [
  "ALL GOOD. PROBABLY.",
  "THAT'S NORMAL.",
  "STILL RUNNING!",
  "NO DATA LOST. I THINK.",
];
export const POKED = [
  "TURN IT OFF AND ON AGAIN.",
  "WHO TOUCHED MY CABLES?",
  "IT'S NOT A FIRE, IT'S A FEATURE.",
  "NEED RAM? I HAVE A DRAWER FULL.",
  "CROCS ARE SERVER ROOM SAFE.",
  "WORKS ON MY SERVER.",
];
export const MUTTER = ["WHERE'S MY SCREWDRIVER?", "HMM, ONE CABLE LEFT OVER.", "*CLONK*", "OOPS."];
