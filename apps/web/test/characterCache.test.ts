import { expect, test } from "bun:test";
import { BufferImageSource, Rectangle, Texture } from "pixi.js";
import { type CharacterSheet, pruneCharacterSheetEntries } from "../src/art/characters.ts";

function entry() {
  const source = new BufferImageSource({
    width: 35,
    height: 24,
    resource: new Uint8Array(35 * 24 * 4),
  });
  const base = new Texture({ source });
  const frames = Array.from(
    { length: 35 },
    (_, i) => new Texture({ source, frame: new Rectangle(i, 0, 1, 24) }),
  );
  const sheet: CharacterSheet = {
    frames,
    anims: {
      idleDown: frames,
      idleLeft: frames,
      idleRight: frames,
      idleUp: frames,
      play: frames,
      raiseHand: frames,
      sitFront: frames,
      sitIdle: frames,
      sitRead: frames,
      sitType: frames,
      walkDown: frames,
      walkLeft: frames,
      walkRight: frames,
      walkUp: frames,
      wave: frames,
    },
  };
  return { base, sheet };
}

test("cache retains live sheets and displayed old frames until the sprite switches", () => {
  const live = entry(),
    old = entry(),
    unused = entry();
  const cache = new Map([
    ["live", live],
    ["old", old],
    ["unused", unused],
  ]);
  const oldSource = old.base.source;
  expect(pruneCharacterSheetEntries(cache, [live.sheet], [old.sheet.frames[0]!], 1)).toBe(1);
  expect(cache.size).toBe(2); // live references may exceed the soft limit
  expect(cache.has("live")).toBe(true);
  expect(cache.has("old")).toBe(true);
  expect(oldSource.destroyed).toBe(false);
  expect(pruneCharacterSheetEntries(cache, [live.sheet], [live.sheet.frames[0]!], 1)).toBe(1);
  expect(oldSource.destroyed).toBe(true);
  expect(live.base.source.destroyed).toBe(false);
  pruneCharacterSheetEntries(cache, [], [], 0);
});

test("eviction destroys all frame wrappers and their single shared source exactly once", () => {
  const candidate = entry();
  const source = candidate.base.source;
  let sourcesDestroyed = 0,
    framesDestroyed = 0;
  source.on("destroy", () => sourcesDestroyed++);
  for (const frame of candidate.sheet.frames) frame.on("destroy", () => framesDestroyed++);
  const cache = new Map([["unused", candidate]]);
  expect(pruneCharacterSheetEntries(cache, [], [], 0)).toBe(1);
  expect(framesDestroyed).toBe(35);
  expect(sourcesDestroyed).toBe(1);
  expect(candidate.base.destroyed).toBe(true);
  expect(cache.size).toBe(0);
});

test("unused oldest sheets are evicted before newer reusable sheets", () => {
  const oldest = entry(),
    recent = entry();
  const cache = new Map([
    ["oldest", oldest],
    ["recent", recent],
  ]);
  expect(pruneCharacterSheetEntries(cache, [], [], 1)).toBe(1);
  expect(cache.has("recent")).toBe(true);
  expect(recent.base.source.destroyed).toBe(false);
  pruneCharacterSheetEntries(cache, [], [], 0);
});
