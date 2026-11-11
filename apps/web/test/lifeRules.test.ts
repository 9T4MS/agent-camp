import { describe, expect, test } from "bun:test";
import {
  findClearedSession,
  isClearRestart,
  pizzaWindow,
  ripLabel,
  weatherFor,
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
