import { describe, expect, test } from "bun:test";
import {
  ALARM_COOLDOWN_S,
  ALARM_IDLE,
  type AlarmState,
  alarmTick,
  catBossWindow,
  eclipseDark,
  eclipseStart,
  floodLevel,
  hourSky,
  kaijuAt,
  kaijuStart,
  parseForcedEvent,
  prevDayKey,
  RACCOON_RAID_H,
  raccoonRaid,
  raccoonsOut,
  rainStreak,
  rareEventOf,
  tornadoAt,
  trashOut,
  weekdayOf,
} from "../src/world/lifeRules.ts";

const days = (from: string, n: number) => {
  const out: string[] = [];
  const t0 = Date.parse(`${from}T00:00:00Z`);
  for (let i = 0; i < n; i++) out.push(new Date(t0 + i * 86_400_000).toISOString().slice(0, 10));
  return out;
};
const year = days("2027-01-01", 365);

describe("chaos schedule", () => {
  test("calendar helpers", () => {
    expect(prevDayKey("2027-03-01")).toBe("2027-02-28");
    expect(prevDayKey("2027-01-01")).toBe("2026-12-31");
    expect(weekdayOf("2026-11-13")).toBe(5); // a Friday
  });

  test("fire alarm: arms after 5 s of 3+ fires, calms after 20 s, then cools down", () => {
    let s: AlarmState = ALARM_IDLE;
    for (let i = 0; i < 9; i++) s = alarmTick(s, 3, 0.5);
    expect(s.on).toBe(false);
    s = alarmTick(s, 3, 0.5);
    expect(s.on).toBe(true);
    for (let i = 0; i < 30; i++) s = alarmTick(s, i % 10 === 0 ? 4 : 0, 0.5);
    expect(s.on).toBe(true); // a flare-up resets the calm timer
    for (let i = 0; i < 40; i++) s = alarmTick(s, 0, 0.5);
    expect(s.on).toBe(false);
    expect(s.cooldown).toBeGreaterThan(ALARM_COOLDOWN_S - 30);
    for (let i = 0; i < 20; i++) s = alarmTick(s, 5, 0.5);
    expect(s.on).toBe(false); // still cooling down
  });

  test("fire alarm turns off after 90 s even if it keeps burning", () => {
    let s: AlarmState = ALARM_IDLE;
    for (let i = 0; i < 12; i++) s = alarmTick(s, 3, 0.5);
    expect(s.on).toBe(true);
    for (let i = 0; i < 180; i++) s = alarmTick(s, 3, 0.5);
    expect(s.on).toBe(false);
  });

  test("the cat's meeting: Fridays 17:00-17:45 only", () => {
    expect(catBossWindow("2026-11-13", 17.2)).toBe(true);
    expect(catBossWindow("2026-11-13", 17.75)).toBe(false);
    expect(catBossWindow("2026-11-13", 16.9)).toBe(false);
    expect(catBossWindow("2026-11-12", 17.2)).toBe(false);
  });

  test("kaiju: exactly one day a month, 10:00-16:00, 40 s", () => {
    for (const month of ["2027-01", "2027-02", "2027-07"]) {
      const hits = year.filter((d) => d.startsWith(month) && kaijuStart(d) !== null);
      expect(hits).toHaveLength(1);
      const start = kaijuStart(hits[0]!)!;
      expect(start).toBeGreaterThanOrEqual(10);
      expect(start).toBeLessThan(16);
      expect(kaijuAt(hits[0]!, start + 20 / 3600)).toBeCloseTo(0.5, 5);
      expect(kaijuAt(hits[0]!, start + 41 / 3600)).toBeNull();
    }
  });

  test("eclipse: a few days a year, dark in the middle of its 10 minutes", () => {
    const ecl = year.filter((d) => eclipseStart(d) !== null);
    expect(ecl.length).toBeGreaterThanOrEqual(0);
    expect(ecl.length).toBeLessThan(10);
    expect(eclipseDark("2027-01-01", 12, 12)).toBe(0);
    expect(eclipseDark("2027-01-01", 12 + 5 / 60, 12)).toBe(1);
    expect(eclipseDark("2027-01-01", 12 + 0.5 / 60, 12)).toBeGreaterThan(0);
    expect(eclipseDark("2027-01-01", 12.2, 12)).toBe(0);
  });

  test("rare weather: deterministic and rare", () => {
    let tornado = 0;
    let meteors = 0;
    for (const d of year)
      for (let h = 0; h < 24; h++) {
        const e = rareEventOf(d, h);
        expect(rareEventOf(d, h + 0.5)).toBe(e);
        if (e === "tornado") {
          tornado++;
          expect(h >= 4 && h < 21).toBe(true);
        }
        if (e === "meteors") {
          meteors++;
          expect(h >= 21 || h < 4).toBe(true);
        }
      }
    const hours = year.length * 24;
    expect(tornado / hours).toBeGreaterThan(1 / 140);
    expect(tornado / hours).toBeLessThan(1 / 25);
    expect(meteors / hours).toBeGreaterThan(1 / 140);
    expect(meteors / hours).toBeLessThan(1 / 25);
  });

  test("a tornado crosses for 30 s inside its hour", () => {
    let found = false;
    for (const d of year.slice(0, 60))
      for (let h = 4; h < 21 && !found; h++) {
        if (rareEventOf(d, h) !== "tornado") continue;
        let hit = 0;
        for (let s = 0; s < 3600; s += 5) if (tornadoAt(d, h + s / 3600) !== null) hit++;
        expect(hit).toBeGreaterThanOrEqual(5);
        expect(hit).toBeLessThanOrEqual(7);
        found = true;
      }
    expect(found).toBe(true);
  });

  test("raccoons: some nights, between 23:00 and 04:00, trash until 10:00", () => {
    const raids = year.filter((d) => raccoonRaid(d) !== null);
    expect(raids.length / year.length).toBeGreaterThan(0.2);
    expect(raids.length / year.length).toBeLessThan(0.5);
    const night = raids[0]!;
    const start = raccoonRaid(night)!;
    expect(start).toBeGreaterThanOrEqual(23);
    expect(start).toBeLessThan(28);
    const next = days(night, 2)[1]!;
    const at = (h: number) => (h >= 24 ? [next, h - 24] : [night, h]) as [string, number];
    expect(raccoonsOut(...at(start + RACCOON_RAID_H / 2))).toBe(true);
    expect(raccoonsOut(...at(start + RACCOON_RAID_H * 2))).toBe(false);
    expect(trashOut(...at(start + RACCOON_RAID_H * 2))).toBe(true);
    expect(trashOut(next, 9.9)).toBe(true);
    expect(trashOut(next, 10.1)).toBe(false);
  });

  test("flood: only after 3 rainy hours in a row, drains over 2 dry hours", () => {
    let seen = false;
    for (const d of year)
      for (let h = 3; h < 22; h++) {
        const level = floodLevel(d, h + 0.5, "summer");
        if (rainStreak(d, h, "summer") >= 3) {
          expect(level).toBeGreaterThan(0.4);
          seen = true;
        } else if (hourSky(d, h).precip > 0.15) expect(level).toBe(0);
        expect(floodLevel(d, h + 0.5, "winter")).toBe(0);
      }
    expect(seen).toBe(true);
  });

  test("?event= names", () => {
    expect(parseForcedEvent("kaiju")).toBe("kaiju");
    expect(parseForcedEvent("nope")).toBeNull();
    expect(parseForcedEvent(null)).toBeNull();
  });
});
