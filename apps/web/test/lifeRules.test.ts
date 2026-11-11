import { describe, expect, test } from "bun:test";
import {
  findClearedSession,
  forcedSky,
  hourSky,
  isClearRestart,
  isFullMoon,
  monthOf,
  moonAge,
  pizzaWindow,
  ripLabel,
  SKY_FADE,
  seasonFor,
  skyAt,
  truckWindow,
  weatherFor,
  weatherOf,
  werewolfHour,
} from "../src/world/lifeRules.ts";

describe("office life rules", () => {
  const ended = { personId: "anna", machine: "mbp", project: "web", at: 1000 };
  test("a quick restart by the same person on the same machine is a /clear", () => {
    expect(isClearRestart(ended, { personId: "anna", machine: "mbp", at: 4000 })).toBe(true);
    expect(isClearRestart(ended, { personId: "anna", machine: undefined, at: 4000 })).toBe(true);
  });
  test("other people, other machines and slow restarts are not", () => {
    expect(isClearRestart(ended, { personId: "ben", machine: "mbp", at: 2000 })).toBe(false);
    expect(isClearRestart(ended, { personId: "anna", machine: "devbox", at: 2000 })).toBe(false);
    expect(isClearRestart(ended, { personId: "anna", machine: "mbp", at: 12_001 })).toBe(false);
    expect(isClearRestart(ended, { personId: "anna", machine: "mbp", at: 500 })).toBe(false);
  });
  test("findClearedSession picks the most recent match", () => {
    const a = { ...ended, at: 1000 };
    const b = { ...ended, at: 3000 };
    expect(findClearedSession([a, b], { personId: "anna", machine: "mbp", at: 5000 })).toBe(b);
    expect(findClearedSession([a, b], { personId: "zoe", machine: "mbp", at: 5000 })).toBe(null);
  });
  test("weather is stable per day and varied over a month", () => {
    expect(weatherFor("2026-11-11")).toBe(weatherFor("2026-11-11"));
    const kinds = new Set(
      Array.from({ length: 40 }, (_, i) => weatherFor(`2026-11-${String(i).padStart(2, "0")}`)),
    );
    expect(kinds.size).toBe(3);
  });
  test("pizza windows", () => {
    expect(pizzaWindow(12.4)).toBe("lunch");
    expect(pizzaWindow(18.7)).toBe("dinner");
    expect(pizzaWindow(15)).toBe(null);
    expect(pizzaWindow(19.5)).toBe(null);
  });
  test("tombstone label", () => {
    expect(ripLabel("web", 42 * 60_000)).toBe("web 42M");
    expect(ripLabel(undefined, 3 * 3600_000)).toBe("session 3H");
  });
});

describe("sky, seasons, moon, food truck", () => {
  const day = "2026-11-11";

  test("the sky of an hour is the same for every viewer", () => {
    expect(skyAt(day, 14.6, "autumn")).toEqual(skyAt(day, 14.6, "autumn"));
    expect(hourSky(day, 9)).toEqual(hourSky(day, 9));
  });

  test("each hour fades over from the previous one, then holds", () => {
    const prev = hourSky(day, 13);
    const cur = hourSky(day, 14);
    expect(skyAt(day, 14, "summer").cloud).toBeCloseTo(prev.cloud, 6);
    expect(skyAt(day, 14 + SKY_FADE, "summer").cloud).toBeCloseTo(cur.cloud, 6);
    expect(skyAt(day, 14.9, "summer").cloud).toBeCloseTo(cur.cloud, 6);
    const mid = skyAt(day, 14 + SKY_FADE / 2, "summer").cloud;
    expect(mid).toBeGreaterThanOrEqual(Math.min(prev.cloud, cur.cloud) - 1e-9);
    expect(mid).toBeLessThanOrEqual(Math.max(prev.cloud, cur.cloud) + 1e-9);
  });

  test("the weather changes during a day, and snows instead of raining in winter", () => {
    const kinds = new Set<string>();
    for (let d = 1; d <= 28; d++)
      for (let h = 0; h < 24; h++)
        kinds.add(skyAt(`2026-01-${String(d).padStart(2, "0")}`, h + 0.5, "winter").weather);
    expect(kinds.has("snow")).toBe(true);
    expect(kinds.has("rain")).toBe(false);
    expect(kinds.has("sun")).toBe(true);
    const hours = new Set(Array.from({ length: 24 }, (_, h) => hourSky(day, h).cloud.toFixed(2)));
    expect(hours.size).toBeGreaterThan(12);
    expect(weatherOf({ cloud: 0.9, precip: 0.6, wind: 0 }, "summer")).toBe("rain");
  });

  test("forced weather for ?weather=", () => {
    expect(forcedSky("snow").weather).toBe("snow");
    expect(forcedSky("sun").precip).toBe(0);
  });

  test("seasons by month", () => {
    expect([12, 1, 2].map(seasonFor)).toEqual(["winter", "winter", "winter"]);
    expect(seasonFor(4)).toBe("spring");
    expect(seasonFor(7)).toBe("summer");
    expect(seasonFor(10)).toBe("autumn");
    expect(monthOf("2026-11-11")).toBe(11);
  });

  test("moon phase", () => {
    // full moon 2026-01-03 10:03 UTC, new moon 2026-01-18 19:52 UTC
    expect(isFullMoon(Date.UTC(2026, 0, 3, 10))).toBe(true);
    expect(isFullMoon(Date.UTC(2026, 0, 18, 20))).toBe(false);
    expect(moonAge(Date.UTC(2026, 0, 18, 20))).toBeLessThan(0.5);
  });

  test("food truck at lunch, werewolves at night", () => {
    expect(truckWindow(12.5)).toBe(true);
    expect(truckWindow(13)).toBe(false);
    expect(werewolfHour(23)).toBe(true);
    expect(werewolfHour(3)).toBe(true);
    expect(werewolfHour(12)).toBe(false);
  });
});
