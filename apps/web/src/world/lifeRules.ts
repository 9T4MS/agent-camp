/**
 * Pure rules behind the office-life fun (no Pixi, unit-tested): when a session restart counts
 * as a "/clear", the weather of every hour, seasons, the moon, when the pizza drone and the
 * food truck come, what deserves a party.
 */
import { hashString } from "@agent-office/protocol";

export type Weather = "sun" | "clouds" | "rain" | "snow";
export type Season = "winter" | "spring" | "summer" | "autumn";
export const SEASONS: readonly Season[] = ["winter", "spring", "summer", "autumn"];

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

/** Meteorological season of a month (1..12, northern hemisphere). */
export function seasonFor(month: number): Season {
  if (month === 12 || month <= 2) return "winter";
  if (month <= 5) return "spring";
  if (month <= 8) return "summer";
  return "autumn";
}

/** Month (1..12) of a "YYYY-MM-DD" day key. */
export function monthOf(dayKey: string): number {
  return Number(dayKey.slice(5, 7)) || 1;
}

/** cloud cover, precipitation and wind, each 0..1 */
export type Sky = { cloud: number; precip: number; wind: number };
export type SkyNow = Sky & { weather: Weather };

/** How long the change from one hour's sky to the next takes (fraction of an hour). */
export const SKY_FADE = 0.25;

/** hashString of similar keys ("…:9", "…:10") is close; a murmur3 finalizer spreads it out. */
function mix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}
const unit = (s: string) => mix32(hashString(s)) / 4294967296;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * The sky of one hour: the day's character (mostly sunny / cloudy / rainy, as
 * `weatherFor`) plus per-hour noise, so the weather drifts through the day.
 */
export function hourSky(dayKey: string, hour: number): Sky {
  const base = { sun: 0.28, clouds: 0.52, rain: 0.7, snow: 0.7 }[weatherFor(dayKey)];
  // neighbouring hours share half their noise, so the sky wanders instead of jumping around
  const n =
    (unit(`sky:${dayKey}:${hour}`) + unit(`sky:${dayKey}:${Math.floor(hour / 2)}:pair`)) / 2;
  const cloud = clamp01(base + (n - 0.5) * 1.1);
  const showers = unit(`precip:${dayKey}:${hour}`) < 0.65;
  const precip = showers && cloud > 0.62 ? clamp01((cloud - 0.62) / 0.3) : 0;
  return { cloud, precip, wind: unit(`wind:${dayKey}:${hour}`) };
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Weather a sky looks like (snow instead of rain in winter). */
export function weatherOf(sky: Sky, season: Season): Weather {
  if (sky.precip > 0.15) return season === "winter" ? "snow" : "rain";
  return sky.cloud > 0.42 ? "clouds" : "sun";
}

/**
 * The sky at a fractional local hour: each hour's sky holds, and the first quarter of every
 * hour fades over from the previous one. Deterministic, so every viewer sees the same.
 */
export function skyAt(dayKey: string, hour: number, season: Season): SkyNow {
  const h = Math.floor(hour);
  const k = smooth(clamp01((hour - h) / SKY_FADE));
  const a = hourSky(dayKey, h - 1);
  const b = hourSky(dayKey, h);
  const sky = {
    cloud: a.cloud + (b.cloud - a.cloud) * k,
    precip: a.precip + (b.precip - a.precip) * k,
    wind: a.wind + (b.wind - a.wind) * k,
  };
  return { ...sky, weather: weatherOf(sky, season) };
}

/** A fixed sky for `?weather=` (screenshots, demos). */
export function forcedSky(weather: Weather): SkyNow {
  const v = {
    sun: { cloud: 0.05, precip: 0 },
    clouds: { cloud: 0.55, precip: 0 },
    rain: { cloud: 0.85, precip: 0.8 },
    snow: { cloud: 0.85, precip: 0.8 },
  }[weather];
  return { ...v, wind: 0.4, weather };
}

const SYNODIC_DAYS = 29.530588853;
/** A known new moon: 2000-01-06 18:14 UTC. */
const NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);

/** Moon age in days (0 = new moon, ~14.8 = full moon). */
export function moonAge(at: number): number {
  const days = (at - NEW_MOON_MS) / 86_400_000;
  return ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
}

/** Within about a day and a half of full moon. */
export function isFullMoon(at: number): boolean {
  return Math.abs(moonAge(at) - SYNODIC_DAYS / 2) < 1.5;
}

/** Werewolf hours (office local): 22:00-05:00. */
export function werewolfHour(hour: number): boolean {
  return hour >= 22 || hour < 5;
}

/** The lunch food truck parks outside 12:00-13:00. */
export function truckWindow(hour: number): boolean {
  return hour >= 12 && hour < 13;
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
