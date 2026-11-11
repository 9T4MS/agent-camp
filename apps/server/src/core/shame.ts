/**
 * Wall of shame: per person and office-local day, how many `/clear` restarts, the longest an
 * agent waited for its human, and how often an agent caught fire (context >= 80%). Fed with
 * the hub's viewer events; one small kv row per day. Pure apart from the store.
 */

import type { ViewerEvent } from "@agent-office/protocol";
import type { OfficeState } from "./diff.ts";
import type { Store } from "./store.ts";

export const CLEAR_WINDOW_MS = 10_000;
export const FIRE_AT = 0.8;
const WAITING_KEY = "shame.waiting";
const WAIT_MAX_MS = 24 * 3_600_000;

export type ShameDay = {
  day: string;
  clears: Record<string, number>;
  longestWaitMs: Record<string, number>;
  fires: Record<string, number>;
};

type Wait = { person: string; since: number };

const empty = (day: string): ShameDay => ({ day, clears: {}, longestWaitMs: {}, fires: {} });
const bump = (m: Record<string, number>, k: string, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};

export class ShameTracker {
  private today: ShameDay;
  /** sessionId -> when it started waiting; kept in kv because the Durable Object hibernates */
  private waiting: Map<string, Wait> | null = null;
  private dirtyDay = false;
  private dirtyWaits = false;
  /** person -> last session.ended */
  private lastEnd = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly dayOf: (ts: number) => string,
  ) {
    this.today = empty("");
  }

  private day(now: number): ShameDay {
    const d = this.dayOf(now);
    if (this.today.day === d) return this.today;
    try {
      const raw = this.store.kvGet(`shame.${d}`);
      this.today = raw ? (JSON.parse(raw) as ShameDay) : empty(d);
    } catch {
      this.today = empty(d);
    }
    return this.today;
  }

  private waits(now: number): Map<string, Wait> {
    if (this.waiting) return this.waiting;
    const waiting = new Map<string, Wait>();
    try {
      const raw = this.store.kvGet(WAITING_KEY);
      for (const [id, w] of raw ? (JSON.parse(raw) as [string, Wait][]) : [])
        if (now - w.since < WAIT_MAX_MS) waiting.set(id, w);
    } catch {
      waiting.clear();
    }
    this.waiting = waiting;
    return waiting;
  }

  private startWait(sessionId: string, person: string, now: number) {
    this.waits(now).set(sessionId, { person, since: now });
    this.dirtyWaits = true;
  }

  private endWait(sessionId: string, person: string, now: number) {
    const w = this.waits(now).get(sessionId);
    if (!w) return;
    this.waits(now).delete(sessionId);
    this.dirtyWaits = true;
    const t = this.day(now);
    if (now - w.since <= (t.longestWaitMs[person] ?? 0)) return;
    t.longestWaitMs[person] = now - w.since;
    this.dirtyDay = true;
  }

  /** Feed one commit's events. `prev` is the state before them (for contexts). */
  record(events: readonly ViewerEvent[], prev: OfficeState, now: number): void {
    this.dirtyDay = false;
    this.dirtyWaits = false;
    const before = new Map<string, number | undefined>();
    for (const p of prev.people) for (const s of p.sessions) before.set(s.sessionId, s.context);
    for (const e of events) {
      switch (e.type) {
        case "session.started": {
          const person = e.data.personId;
          const ended = this.lastEnd.get(person);
          if (ended !== undefined && now - ended <= CLEAR_WINDOW_MS) {
            bump(this.day(now).clears, person);
            this.lastEnd.delete(person);
            this.dirtyDay = true;
          }
          if (e.data.session.activity === "waiting")
            this.startWait(e.data.session.sessionId, person, now);
          break;
        }
        case "session.ended":
          this.lastEnd.set(e.data.personId, now);
          this.endWait(e.data.sessionId, e.data.personId, now);
          break;
        case "session.activityChanged":
          if (e.data.activity === "waiting") this.startWait(e.data.sessionId, e.data.personId, now);
          else if (e.data.previous === "waiting")
            this.endWait(e.data.sessionId, e.data.personId, now);
          break;
        case "session.contextChanged": {
          const was = before.get(e.data.sessionId) ?? 0;
          if (was < FIRE_AT && (e.data.context ?? 0) >= FIRE_AT) {
            bump(this.day(now).fires, e.data.personId);
            this.dirtyDay = true;
          }
          break;
        }
      }
    }
    if (this.dirtyDay) this.store.kvPut(`shame.${this.today.day}`, JSON.stringify(this.today));
    if (this.dirtyWaits) this.store.kvPut(WAITING_KEY, JSON.stringify([...this.waits(now)]));
  }

  /** Today's numbers, with waits still running counted up to `now`. */
  snapshot(now: number): ShameDay {
    const t = this.day(now);
    const out: ShameDay = {
      day: t.day,
      clears: { ...t.clears },
      longestWaitMs: { ...t.longestWaitMs },
      fires: { ...t.fires },
    };
    for (const w of this.waits(now).values())
      out.longestWaitMs[w.person] = Math.max(out.longestWaitMs[w.person] ?? 0, now - w.since);
    return out;
  }
}
