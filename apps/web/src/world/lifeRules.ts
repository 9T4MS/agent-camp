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

// ---- bar + weed shop -------------------------------------------------------------------------
/** Friday (weekdayOf: 0 = Sunday). */
const FRIDAY = 5;

/**
 * The "Feierabend" bar: 17:00-02:00 every night, on Fridays from 16:00 (happy hour).
 * `weekday` is the calendar day of `hour` (after midnight it is the next day, which is fine:
 * only the Friday afternoon depends on it).
 */
export function barOpen(hour: number, weekday: number): boolean {
  return hour >= 17 || hour < 2 || (weekday === FRIDAY && hour >= 16);
}

/** Friday happy hour 16:00-18:00: the BAR sign blinks and people head over more often. */
export function happyHour(hour: number, weekday: number): boolean {
  return weekday === FRIDAY && hour >= 16 && hour < 18;
}

/** The weed shop: 10:00-20:00 every day. The smokers' corner outside never closes. */
export function shopOpen(hour: number): boolean {
  return hour >= 10 && hour < 20;
}

/** `?bar=` / `?shop=` overrides: "open" | "closed" (else null = follow the clock). */
export function parseOpenOverride(v: string | null | undefined): boolean | null {
  return v === "open" ? true : v === "closed" ? false : null;
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

// ---- office chaos ---------------------------------------------------------------------------

/** "YYYY-MM-DD" of the day before (calendar math only, no time zones involved). */
export function prevDayKey(dayKey: string): string {
  const t = Date.UTC(+dayKey.slice(0, 4), +dayKey.slice(5, 7) - 1, +dayKey.slice(8, 10));
  return new Date(t - 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday, of a day key. */
export function weekdayOf(dayKey: string): number {
  return new Date(`${dayKey}T12:00:00Z`).getUTCDay();
}

/** Fire alarm: 3+ agents on fire for 5 s turns it on; calm for 20 s (or 90 s max) turns it off. */
export const ALARM_BURNING = 3;
export const ALARM_ARM_S = 5;
export const ALARM_CALM_S = 20;
export const ALARM_MAX_S = 90;
export const ALARM_COOLDOWN_S = 600;
export type AlarmState = {
  on: boolean;
  hot: number;
  calm: number;
  onFor: number;
  cooldown: number;
};
export const ALARM_IDLE: AlarmState = { on: false, hot: 0, calm: 0, onFor: 0, cooldown: 0 };

export function alarmTick(s: AlarmState, burning: number, dt: number): AlarmState {
  const fire = burning >= ALARM_BURNING;
  if (!s.on) {
    const cooldown = Math.max(0, s.cooldown - dt);
    const hot = fire ? s.hot + dt : 0;
    if (hot >= ALARM_ARM_S && cooldown <= 0)
      return { on: true, hot: 0, calm: 0, onFor: 0, cooldown: 0 };
    return { ...s, hot, cooldown };
  }
  const onFor = s.onFor + dt;
  const calm = fire ? 0 : s.calm + dt;
  if (calm >= ALARM_CALM_S || onFor >= ALARM_MAX_S)
    return { on: false, hot: 0, calm: 0, onFor: 0, cooldown: ALARM_COOLDOWN_S };
  return { ...s, onFor, calm };
}

/** The cat holds a meeting: Fridays 17:00-17:45 office time. */
export function catBossWindow(dayKey: string, hour: number): boolean {
  return weekdayOf(dayKey) === 5 && hour >= 17 && hour < 17.75;
}

/** Raccoons raid the bin on about a third of the nights; the raid starts between 23:00 and 04:00. */
export function raccoonRaid(nightOf: string): number | null {
  if (unit(`raccoon:${nightOf}`) >= 0.35) return null;
  return 23 + unit(`raccoon-at:${nightOf}`) * 4.9;
}
export const RACCOON_RAID_H = 70 / 3600;

/** Hours since the raid of the current night started (null = no raid yet / none tonight). */
export function raccoonPhase(dayKey: string, hour: number): number | null {
  // the night belongs to the evening it started on: 00:00-10:00 count as last night
  const night = hour < 10 ? prevDayKey(dayKey) : dayKey;
  const start = raccoonRaid(night);
  if (start === null) return null;
  const h = hour < 10 ? hour + 24 : hour;
  return h >= start ? h - start : null;
}

/** Raid going on right now. */
export function raccoonsOut(dayKey: string, hour: number): boolean {
  const p = raccoonPhase(dayKey, hour);
  return p !== null && p < RACCOON_RAID_H;
}

/** Trash lies around from the raid until 10:00 the next morning. */
export function trashOut(dayKey: string, hour: number): boolean {
  const p = raccoonPhase(dayKey, hour);
  return p !== null && p >= RACCOON_RAID_H * 0.6 && (hour < 10 || hour >= 23);
}

/** Kaiju day: one per month, between 10:00 and 16:00, for 40 seconds. */
export const KAIJU_S = 40;
export function kaijuStart(dayKey: string): number | null {
  const month = dayKey.slice(0, 7);
  const day = 1 + Math.floor(unit(`kaiju-day:${month}`) * 28);
  if (Number(dayKey.slice(8, 10)) !== day) return null;
  return 10 + unit(`kaiju-at:${month}`) * 6;
}
/** 0..1 progress of the kaiju walk, or null. */
export function kaijuAt(dayKey: string, hour: number): number | null {
  const start = kaijuStart(dayKey);
  if (start === null) return null;
  const p = ((hour - start) * 3600) / KAIJU_S;
  return p >= 0 && p < 1 ? p : null;
}

/** Solar eclipse: ~3 days a year at a fixed time around midday, 10 minutes of darkness. */
export const ECLIPSE_H = 10 / 60;
export function eclipseStart(dayKey: string): number | null {
  if (unit(`eclipse:${dayKey}`) >= 3 / 365) return null;
  return 11 + unit(`eclipse-at:${dayKey}`) * 4;
}
/** Darkness 0..1 of an eclipse at that moment (smooth in and out). */
export function eclipseDark(dayKey: string, hour: number, start = eclipseStart(dayKey)): number {
  if (start === null) return 0;
  const p = (hour - start) / ECLIPSE_H;
  if (p < 0 || p > 1) return 0;
  return smooth(clamp01(Math.min(p, 1 - p) * 4));
}

/** Rare weather events of an hour (~1 in 60 hours each; meteors only at night). */
export type RareEvent = "tornado" | "meteors";
export function rareEventOf(dayKey: string, hour: number): RareEvent | null {
  const h = Math.floor(hour);
  const r = unit(`rare:${dayKey}:${h}`);
  const night = h >= 21 || h < 4;
  // nights are 7 of 24 hours: scale up so meteors still come about once per 60 hours overall
  if (night && r < (1 / 60) * (24 / 7)) return "meteors";
  if (!night && r < 1 / 60) return "tornado";
  return null;
}
/** The tornado crosses for 30 s at a fixed minute of its hour: 0..1 progress or null. */
export const TORNADO_S = 30;
export function tornadoAt(dayKey: string, hour: number): number | null {
  if (rareEventOf(dayKey, hour) !== "tornado") return null;
  const h = Math.floor(hour);
  const start = h + 0.1 + unit(`tornado-at:${dayKey}:${h}`) * 0.8;
  const p = ((hour - start) * 3600) / TORNADO_S;
  return p >= 0 && p < 1 ? p : null;
}

/** Rain (not snow) in that hour's sky. */
export function rainyHour(dayKey: string, h: number, season: Season): boolean {
  return season !== "winter" && hourSky(dayKey, h).precip > 0.15;
}

/** Consecutive rainy hours ending with hour `h` (max 8 looked at). */
export function rainStreak(dayKey: string, h: number, season: Season): number {
  let n = 0;
  while (n < 8 && rainyHour(dayKey, h - n, season)) n++;
  return n;
}

/** Flood water in the garden, 0..1: rises after 3+ rainy hours, drains over the next 2. */
export const FLOOD_AFTER_H = 3;
export function floodLevel(dayKey: string, hour: number, season: Season): number {
  const h = Math.floor(hour);
  const frac = hour - h;
  const now = rainStreak(dayKey, h, season);
  if (now >= FLOOD_AFTER_H) return clamp01(0.4 + 0.3 * (now - FLOOD_AFTER_H) + 0.3 * frac);
  if (now > 0) return 0;
  for (let k = 1; k <= 2; k++) {
    if (rainStreak(dayKey, h - k, season) >= FLOOD_AFTER_H) {
      // dry hours since then drain it: k-1 full hours + this one
      return clamp01(1 - (k - 1 + frac) / 2);
    }
    if (rainyHour(dayKey, h - k, season)) return 0;
  }
  return 0;
}

/** `?event=` names for screenshots and demos. */
export const FORCE_EVENTS = [
  "tornado",
  "meteors",
  "eclipse",
  "kaiju",
  "raccoons",
  "alarm",
  "catboss",
  "flood",
  "happyhour",
] as const;
export type ForcedEvent = (typeof FORCE_EVENTS)[number];
export function parseForcedEvent(v: string | null | undefined): ForcedEvent | null {
  return (FORCE_EVENTS as readonly string[]).includes(v ?? "") ? (v as ForcedEvent) : null;
}
