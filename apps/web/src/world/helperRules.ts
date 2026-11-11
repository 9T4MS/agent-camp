/** Pure rules of the helper swarm (sizes, area, errands, escort rows); no Pixi, unit-tested. */

/** Bots drawn per swarm; beyond it a "+N" badge, so a few bursting sessions stay cheap on the kiosk. */
export const MAX_BOTS = 40;
/** Helpers per row while they carry someone around (rebellion): 8, up to 16 for big swarms. */
export const ESCORT_ROW = 8;
const ESCORT_ROW_MAX = 16;
/** Beyond this many helpers the swarm also uses the free floor tile beside and below the aisle. */
export const BIG_SWARM = 20;

type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** How many helpers get a sprite; the rest (beyond MAX_BOTS) are the "+N" badge. */
export function visibleHelpers(count: number): { shown: number; extra: number } {
  const shown = Math.max(0, Math.min(MAX_BOTS, count));
  return { shown, extra: Math.max(0, count - shown) };
}

/**
 * Helpers stay within a few steps of their agent's chair, inside the pod's aisle; a bigger
 * swarm spreads out further, up to the whole aisle, and a big one (> BIG_SWARM) also onto the
 * floor tile on either side of the aisle and the strip below it (the rest of the pod slot).
 */
export function helperArea(aisle: Rect, seat: Pt, count = 0): Rect {
  if (count > BIG_SWARM) aisle = { x: aisle.x - 16, y: aisle.y, w: aisle.w + 32, h: aisle.h + 6 };
  const extra = Math.max(0, count - 5);
  const reach = 22 + 4 * extra;
  const x0 = Math.max(aisle.x, seat.x - reach);
  const x1 = Math.min(aisle.x + aisle.w, seat.x + reach);
  const y0 = Math.max(aisle.y, seat.y - 4 - extra);
  const y1 = Math.min(aisle.y + aisle.h, seat.y + 18 + extra);
  return x1 - x0 < 8 || y1 - y0 < 4 ? aisle : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** How many helpers of a swarm of `count` may be out on errands at once. */
export function errandSlots(count: number): number {
  return Math.max(2, Math.ceil(count / 5));
}

/** Helpers per escort row for a swarm of `n`. */
export function escortRow(n: number): number {
  return Math.max(ESCORT_ROW, Math.min(ESCORT_ROW_MAX, Math.ceil(n / 4)));
}

/** Where helper `i` of `n` stands while carrying someone: rows under the point, centred. */
export function escortSpot(at: Pt, i: number, n: number): Pt {
  const per = escortRow(n);
  const row = Math.floor(i / per);
  const inRow = Math.min(per, n - row * per);
  const col = i % per;
  return { x: at.x + (col - (inRow - 1) / 2) * 5, y: at.y + 1 + (col % 2) + row * 3 };
}

/** Seconds until the next queued helper of a burst pops out (faster the more are waiting). */
export function burstGap(queued: number, r: number): number {
  return Math.min(0.12, 1.5 / Math.max(1, queued)) * (0.5 + r);
}
