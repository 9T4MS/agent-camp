import { describe, expect, test } from "bun:test";
import {
  IDLE_BEFORE_RELOAD_MS,
  mayAutoReload,
  newVersionLabel,
  notesKey,
  parseChangelog,
  shouldCelebrate,
} from "../src/release.ts";

describe("parseChangelog", () => {
  test("sections newest first with their items; intro text and empty sections dropped", () => {
    const md = `# Changelog

Intro line, not an item.

## 2026-11-12
- Cats
- Bar opens at 17:00

## 2026-11-11

## 2026-11-10
* Look studio
`;
    expect(parseChangelog(md)).toEqual([
      { title: "2026-11-12", items: ["Cats", "Bar opens at 17:00"] },
      { title: "2026-11-10", items: ["Look studio"] },
    ]);
  });
});

describe("shouldCelebrate", () => {
  test("only when this browser ran an older build before", () => {
    const notes = notesKey({ title: "2026-11-12", items: ["Cats"] });
    expect(shouldCelebrate(null, "abc1234", notes)).toBe(false);
    expect(shouldCelebrate({ build: "abc1234", notes: "old" }, "abc1234", notes)).toBe(false);
    expect(shouldCelebrate({ build: "old0000", notes: "old" }, "abc1234", notes)).toBe(true);
    expect(shouldCelebrate({ build: "old0000", notes: "old" }, "dev", notes)).toBe(false);
  });
  test("a deploy without a new changelog line stays quiet", () => {
    const notes = notesKey({ title: "2026-11-12", items: ["Cats"] });
    expect(shouldCelebrate({ build: "old0000", notes }, "abc1234", notes)).toBe(false);
    const more = notesKey({ title: "2026-11-12", items: ["Cats", "Bar"] });
    expect(shouldCelebrate({ build: "old0000", notes }, "abc1234", more)).toBe(true);
  });
});

describe("newVersionLabel", () => {
  test("the server's version, unless it still reports the one seen before", () => {
    expect(newVersionLabel({ build: "a", version: "0.1.19" }, "0.1.20")).toBe("v0.1.20");
    expect(newVersionLabel({ build: "a", version: "0.1.19" }, "0.1.19")).toBeNull();
    expect(newVersionLabel({ build: "a" }, "v0.1.20")).toBe("v0.1.20");
    expect(newVersionLabel({ build: "a" }, undefined)).toBeNull();
  });
});

describe("mayAutoReload", () => {
  const base = { kiosk: false, hidden: false, busy: false, idleMs: IDLE_BEFORE_RELOAD_MS };
  test("kiosk and hidden tabs reload right away", () => {
    expect(mayAutoReload({ ...base, kiosk: true, busy: true, idleMs: 0 })).toBe(true);
    expect(mayAutoReload({ ...base, hidden: true, idleMs: 0 })).toBe(true);
  });
  test("a hidden tab with a draft or the look studio open is left alone", () => {
    expect(mayAutoReload({ ...base, hidden: true, busy: true, idleMs: 0 })).toBe(false);
  });
  test("a visible page waits for a minute without input and nothing in progress", () => {
    expect(mayAutoReload(base)).toBe(true);
    expect(mayAutoReload({ ...base, idleMs: 5_000 })).toBe(false);
    expect(mayAutoReload({ ...base, busy: true })).toBe(false);
  });
});
