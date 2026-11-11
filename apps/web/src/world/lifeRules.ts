/**
 * Pure rules behind the office-life fun (no Pixi, unit-tested): when a session restart counts
 * as a "/clear", which weather a day gets, when the pizza drone comes, what deserves a party.
 */
import { hashString } from "@agent-office/protocol";

export type Weather = "sun" | "clouds" | "rain";

/** A session.ended followed this fast by a session.started of the same person = "/clear". */
export const CLEAR_WINDOW_MS = 10_000;
/** Sessions that ran longer than this get fireworks + "SHIP IT!" when they end. */
export const SHIP_IT_AFTER_MS = 30 * 60_000;
/** A person with this many helpers at once turns on party mode in the game corner. */
export const PARTY_HELPERS = 10;
/** Waiting thresholds: ping ring, the cat comes over, the chef brings a sandwich. */
export const WAIT_PING_MS = 2 * 60_000;
export const WAIT_CAT_MS = 5 * 60_000;
export const WAIT_CHEF_MS = 10 * 60_000;

export type EndedSession = {
  personId: string;
  machine: string | undefined;
  project: string | undefined;
  at: number;
};
export type StartedSession = {
  personId: string;
  machine: string | undefined;
  at: number;
};

/** True when `started` looks like the same human restarting (`/clear`) the `ended` session. */
export function isClearRestart(ended: EndedSession, started: StartedSession): boolean {
  if (ended.personId !== started.personId) return false;
  const dt = started.at - ended.at;
  if (dt < 0 || dt > CLEAR_WINDOW_MS) return false;
  // when both connectors told us their machine it has to match
  if (ended.machine && started.machine && ended.machine !== started.machine) return false;
  return true;
}

/** Most recent matching end for a start (consumes nothing; caller removes the match). */
export function findClearedSession<T extends EndedSession>(
  recent: readonly T[],
  started: StartedSession,
): T | null {
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i]!;
    if (isClearRestart(e, started)) return e;
  }
  return null;
}

/** Local calendar day as "YYYY-MM-DD" for a time zone (falls back to the browser's). */
export function localDayKey(timezone: string | undefined, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(at);
  } catch {
    return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
  }
}

/** Seeded weather of the day: mostly sunny, sometimes clouds, now and then rain. */
export function weatherFor(dayKey: string): Weather {
  const r = hashString(`weather:${dayKey}`) % 100;
  return r < 55 ? "sun" : r < 85 ? "clouds" : "rain";
}

/** Pizza delivery windows (office local time): lunch 12:00-13:00, dinner 18:30-19:30. */
export function pizzaWindow(hour: number): "lunch" | "dinner" | null {
  if (hour >= 12 && hour < 13) return "lunch";
  if (hour >= 18.5 && hour < 19.5) return "dinner";
  return null;
}

/** Session age at its end, in ms, given the server clock skew (server - local). */
export function sessionAgeMs(startedAt: number, clockSkew: number, now: number): number {
  return now + clockSkew - startedAt;
}

/** "agent-office 42m" style label for a tombstone. */
export function ripLabel(project: string | undefined, ageMs: number): string {
  const min = Math.max(1, Math.round(ageMs / 60_000));
  const dur = min >= 120 ? `${Math.round(min / 60)}H` : `${min}M`;
  const name = (project ?? "session").slice(0, 14);
  return `${name} ${dur}`;
}
