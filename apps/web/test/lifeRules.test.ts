import { describe, expect, test } from "bun:test";
import {
  barOpen,
  CAT_MEAL_CHANCE,
  CAT_TREAT_CHANCE,
  catAnswer,
  catBegLabel,
  catBegLine,
  catCount,
  catMealFor,
  findClearedSession,
  forcedSky,
  happyHour,
  hourSky,
  isClearRestart,
  isFullMoon,
  monthOf,
  moonAge,
  parseForcedEvent,
  parseOpenOverride,
  pizzaWindow,
  ripLabel,
  SKY_FADE,
  seasonFor,
  shopOpen,
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
  test("one cat per two people on top of the first, at most ten", () => {
    expect([0, 1, 2, 3, 7, 18, 19, 30].map(catCount)).toEqual([1, 1, 2, 2, 4, 10, 10, 10]);
  });
  test("Cece and Jess know their mealtimes", () => {
    expect(catMealFor(7)).toBe("breakfast");
    expect(catMealFor(8.99)).toBe("breakfast");
    expect(catMealFor(10)).toBe(null);
    expect(catMealFor(12)).toBe("lunch");
    expect(catMealFor(13.5)).toBe(null);
    expect(catMealFor(18)).toBe("dinner");
    expect(catMealFor(23)).toBe(null);
  });
  test("begging cats ask for treats, at mealtimes for the meal", () => {
    expect(catBegLine(null, 0)).toBe("TREAT?");
    expect(catBegLine("dinner", 0)).toBe("DINNER!");
    for (const r of [0, 0.5, 0.999999]) {
      expect(catBegLine(null, r).length).toBeGreaterThan(0);
      expect(catBegLine("lunch", r).length).toBeGreaterThan(0);
    }
    expect(catBegLabel(null, "Anna")).toBe("begging Anna for treats");
    expect(catBegLabel("lunch", "Anna")).toBe("begging Anna for lunch");
  });
  test("agents give in more often at mealtimes", () => {
    const r = (CAT_TREAT_CHANCE + CAT_MEAL_CHANCE) / 2;
    expect(catAnswer(null, "Jess", r, 0).give).toBe(false);
    expect(catAnswer("dinner", "Jess", r, 0).give).toBe(true);
    expect(catAnswer(null, "Jess", 0, 0)).toEqual({ give: true, text: "OK, ONE TREAT" });
    expect(catAnswer(null, "Cece", 0.99, 0)).toEqual({ give: false, text: "CECE, YOU JUST ATE!" });
    expect(catAnswer("lunch", "Cece", 0, 0).text).toBe("LUNCH, COMING UP");
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

describe("bar + weed shop opening hours", () => {
  const MON = 1;
  const FRI = 5;
  const SAT = 6;
  test("bar: 17:00-02:00 every night, Friday from 16:00", () => {
    expect(barOpen(16.99, MON)).toBe(false);
    expect(barOpen(17, MON)).toBe(true);
    expect(barOpen(23.5, MON)).toBe(true);
    expect(barOpen(1.99, SAT)).toBe(true);
    expect(barOpen(2, SAT)).toBe(false);
    expect(barOpen(12, FRI)).toBe(false);
    expect(barOpen(16, FRI)).toBe(true);
    expect(barOpen(16, SAT)).toBe(false);
  });
  test("happy hour: Fridays 16:00-18:00 only", () => {
    expect(happyHour(15.99, FRI)).toBe(false);
    expect(happyHour(16, FRI)).toBe(true);
    expect(happyHour(17.99, FRI)).toBe(true);
    expect(happyHour(18, FRI)).toBe(false);
    expect(happyHour(17, MON)).toBe(false);
    // happy hour always falls inside opening hours
    for (let h = 0; h < 24; h += 0.25) if (happyHour(h, FRI)) expect(barOpen(h, FRI)).toBe(true);
  });
  test("shop: 10:00-20:00", () => {
    expect(shopOpen(9.99)).toBe(false);
    expect(shopOpen(10)).toBe(true);
    expect(shopOpen(19.99)).toBe(true);
    expect(shopOpen(20)).toBe(false);
    expect(shopOpen(23)).toBe(false);
  });
  test("?bar= / ?shop= overrides and ?event=happyhour", () => {
    expect(parseOpenOverride("open")).toBe(true);
    expect(parseOpenOverride("closed")).toBe(false);
    expect(parseOpenOverride("nope")).toBeNull();
    expect(parseOpenOverride(null)).toBeNull();
    expect(parseForcedEvent("happyhour")).toBe("happyhour");
  });
});
