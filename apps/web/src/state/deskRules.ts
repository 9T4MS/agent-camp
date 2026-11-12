/**
 * Pure seating rules (no Pixi, unit-tested): who gets one of a person's few desks when they
 * run more sessions than the pod has desks. Working sessions win desks over idle ones, so the
 * pod shows what is actually going on instead of whoever happened to start first.
 *
 * Desk numbers follow the model: `desk < maxDesks` is a desk, anything above roams.
 */
import type { Activity } from "@agent-office/protocol";

/** A roamer has to keep working this long before it takes an idle session's desk. */
export const CLAIM_AFTER_MS = 5_000;
/** A desk holder has to be idle this long before it gives its desk up. */
export const YIELD_AFTER_MS = 5_000;
/** Both sides of a swap sit still this long, so flapping activity can't swap them right back. */
export const SWAP_COOLDOWN_MS = 30_000;

/** One session of a person, as the swap rule sees it. */
export type DeskSeat = {
  id: string;
  desk: number;
  /** activity is "idle" */
  idle: boolean;
  /** client time of its last idle <-> working flip (when it became what it is now) */
  since: number;
  /** may change seats right now (not leaving, zapped, carried off, evacuating, offline) */
  movable: boolean;
  /** last time it won or lost a desk in a swap */
  swappedAt?: number;
};

export type DeskSwap = { taker: string; yielder: string };

/**
 * Swaps that hand idle sessions' desks to working roamers: the roamer working longest gets
 * the desk of the session idle longest, and so on, one pair at a time. Both need their state
 * to have held for a few seconds and neither may have swapped recently (hysteresis), so a
 * session flickering between idle and working doesn't shuffle the pod.
 */
export function deskSwaps(seats: readonly DeskSeat[], now: number, maxDesks: number): DeskSwap[] {
  const rested = (s: DeskSeat) =>
    s.movable && (s.swappedAt === undefined || now - s.swappedAt >= SWAP_COOLDOWN_MS);
  const takers = seats
    .filter((s) => s.desk >= maxDesks && !s.idle && rested(s) && now - s.since >= CLAIM_AFTER_MS)
    // working longest first; same moment: whoever has been roaming longest (lower number)
    .sort((a, b) => a.since - b.since || a.desk - b.desk);
  const yielders = seats
    .filter((s) => s.desk < maxDesks && s.idle && rested(s) && now - s.since >= YIELD_AFTER_MS)
    // idle longest first; same moment: the far end of the pod goes first, low desks stay put
    .sort((a, b) => a.since - b.since || b.desk - a.desk);
  const n = Math.min(takers.length, yielders.length);
  const out: DeskSwap[] = [];
  for (let i = 0; i < n; i++) out.push({ taker: takers[i]!.id, yielder: yielders[i]!.id });
  return out;
}

/**
 * When a session's current idle / working state started, from its activity log (oldest
 * first): the start of the trailing run of idle or of non-idle entries. A switch between two
 * working activities (typing -> reading) doesn't restart the clock.
 */
export function stateSince(
  log: readonly { activity: Activity; at: number }[],
  fallback: number,
): number {
  const last = log.at(-1);
  if (!last) return fallback;
  const idle = last.activity === "idle";
  let since = last.at;
  for (let i = log.length - 2; i >= 0; i--) {
    const e = log[i]!;
    if ((e.activity === "idle") !== idle) break;
    since = e.at;
  }
  return since;
}

/**
 * The order new sessions take a person's free desks in. When they all fit the incoming order
 * stays (a fresh load looks like it always did); when they don't, working ones get the free
 * desks before idle ones, still in incoming order among themselves, and the rest roam.
 */
export function seatingOrder<T>(
  items: readonly T[],
  free: number,
  working: (t: T) => boolean,
): T[] {
  if (items.length <= free) return [...items];
  const seated = new Set<T>();
  for (const t of items) if (seated.size < free && working(t)) seated.add(t);
  for (const t of items) if (seated.size < free && !working(t)) seated.add(t);
  return [...items.filter((t) => seated.has(t)), ...items.filter((t) => !seated.has(t))];
}

/** Of the agents that could fill a freed desk, the one to move: working roamers first. */
export function preferMover<T extends { desk: number; working: boolean }>(
  a: T | undefined,
  b: T,
  maxDesks: number,
): T {
  if (!a) return b;
  // both roam: a working one beats an idle one, then the higher number (as before)
  if (a.desk >= maxDesks && b.desk >= maxDesks && a.working !== b.working) return a.working ? a : b;
  return b.desk > a.desk ? b : a;
}
