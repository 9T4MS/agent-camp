import { describe, expect, test } from "bun:test";
import {
  EXPLODE_AT,
  explodeCheck,
  HitCounter,
  isGhostHour,
  pickGhosts,
  SKELETON_AFTER_MS,
  SKELETON_FADE_S,
  skeletonAmount,
} from "../src/world/dramaRules.ts";

describe("drama rules", () => {
  test("explodes once per crossing and re-arms below 90%", () => {
    let armed = true;
    const step = (c: number | undefined) => {
      const r = explodeCheck(armed, c);
      armed = r.armed;
      return r.explode;
    };
    expect(step(0.8)).toBe(false);
    expect(step(EXPLODE_AT)).toBe(true);
    expect(step(1)).toBe(false);
    expect(step(0.95)).toBe(false);
    expect(step(1)).toBe(false);
    expect(step(0.85)).toBe(false);
    expect(step(1)).toBe(true);
    expect(explodeCheck(false, undefined)).toEqual({ explode: false, armed: true });
  });

  test("skeleton fades in after 30 min of waiting", () => {
    expect(skeletonAmount(SKELETON_AFTER_MS - 1)).toBe(0);
    expect(skeletonAmount(SKELETON_AFTER_MS + (SKELETON_FADE_S * 1000) / 2)).toBe(0.5);
    expect(skeletonAmount(SKELETON_AFTER_MS * 2)).toBe(1);
  });

  test("ghost hours", () => {
    expect([21.9, 22, 3, 4.99, 5, 12].map(isGhostHour)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  test("third hit within a minute throws back, then counting starts over", () => {
    const h = new HitCounter();
    expect(h.hit("anna", 0)).toBe(false);
    expect(h.hit("anna", 10_000)).toBe(false);
    expect(h.hit("bob", 10_000)).toBe(false);
    expect(h.hit("anna", 20_000)).toBe(true);
    expect(h.hit("anna", 21_000)).toBe(false);
    // hits older than a minute don't count
    expect(h.hit("bob", 80_000)).toBe(false);
    expect(h.hit("bob", 81_000)).toBe(false);
    expect(h.hit("bob", 82_000)).toBe(true);
  });

  test("ghosts: today only, free desks, newest per desk, capped", () => {
    const e = (pod: number, desk: number, at: number, day = "d") => ({ pod, desk, at, day });
    const ended = [
      e(0, 0, 1),
      e(0, 0, 5),
      e(0, 1, 2),
      e(1, 0, 3, "yesterday"),
      e(2, 0, 4),
      ...Array.from({ length: 10 }, (_, i) => e(5, i, 10 + i)),
    ];
    const busy = (pod: number, desk: number) => pod === 2 && desk === 0;
    const got = pickGhosts(ended, busy, "d", 6);
    expect(got).toHaveLength(6);
    expect(got.every((g) => g.day === "d" && !(g.pod === 2 && g.desk === 0))).toBe(true);
    const few = pickGhosts(ended.slice(0, 5), busy, "d");
    expect(few.map((g) => `${g.pod}:${g.desk}@${g.at}`)).toEqual(["0:0@5", "0:1@2"]);
  });
});
