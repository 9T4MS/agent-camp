/** Pure rules behind the agent drama (explosions, zombies, skeletons, ghosts, paper wars). */

/** Context share that blows a seated session up, and the share below which it re-arms. */
export const EXPLODE_AT = 0.99;
export const REARM_BELOW = 0.9;
/** Idle this long: zombie. Waiting this long: skeleton (client clock, scaled like waits). */
export const ZOMBIE_AFTER_MS = 2 * 3600_000;
export const SKELETON_AFTER_MS = 30 * 60_000;
export const SKELETON_FADE_S = 20;
/** Helpers of one person that start a rebellion, how often and for how long. */
export const REBELLION_HELPERS = 10;
export const REBELLION_EVERY_S = 60;
export const REBELLION_S = 8;
export const GHOST_MAX = 6;
/** Hits within this window that make someone throw back. */
export const HIT_WINDOW_MS = 60_000;
export const HITS_TO_THROW_BACK = 3;
export const SPLAT_S = 10 * 60;
export const CRATER_S = 30;

/** Explodes once per crossing: returns whether to explode now and the new armed state. */
export function explodeCheck(armed: boolean, context: number | undefined) {
  const c = context ?? 0;
  if (armed && c >= EXPLODE_AT) return { explode: true, armed: false };
  return { explode: false, armed: armed || c < REARM_BELOW };
}

/** 22:00–05:00 office time. */
export function isGhostHour(hour: number): boolean {
  return hour >= 22 || hour < 5;
}

/** Skeleton amount 0..1 after `waitedMs`, fading in over SKELETON_FADE_S. */
export function skeletonAmount(waitedMs: number): number {
  if (waitedMs < SKELETON_AFTER_MS) return 0;
  return Math.min(1, (waitedMs - SKELETON_AFTER_MS) / (SKELETON_FADE_S * 1000));
}

/** Counts paper/tomato hits per person; the third within a minute answers with a throw back. */
export class HitCounter {
  private hits = new Map<string, number[]>();

  hit(personId: string, now: number): boolean {
    const list = (this.hits.get(personId) ?? []).filter((t) => now - t < HIT_WINDOW_MS);
    list.push(now);
    if (list.length >= HITS_TO_THROW_BACK) {
      this.hits.delete(personId);
      return true;
    }
    this.hits.set(personId, list);
    return false;
  }
}

export type EndedDesk = { pod: number; desk: number; day: string; at: number };

/** Ghosts for tonight: today's ended desks that are free now, newest first, one per desk, capped. */
export function pickGhosts<T extends EndedDesk>(
  ended: readonly T[],
  occupied: (pod: number, desk: number) => boolean,
  day: string,
  max = GHOST_MAX,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of [...ended].sort((a, b) => b.at - a.at)) {
    const key = `${e.pod}:${e.desk}`;
    if (e.day !== day || seen.has(key) || occupied(e.pod, e.desk)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}
