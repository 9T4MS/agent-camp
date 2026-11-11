/**
 * Agent drama: the skeleton a long wait turns into, its cobweb, the crater a full context
 * leaves behind, tomatoes and their splats.
 */
import { Texture } from "pixi.js";
import { drawText, FONT_HEIGHT, measureText } from "./font.ts";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";

const once = <T>(make: () => T) => {
  let v: T | undefined;
  return () => {
    v ??= make();
    return v;
  };
};

const tex = (pc: PixelCanvas) => Texture.from(pc.toCanvas());

/** A skeleton seen from behind, sitting at the desk (16x24, same frame as a character). */
export const skeletonTexture = once(() => {
  const pc = new PixelCanvas(16, 24);
  pc.sprite(
    0,
    0,
    [
      "................",
      "................",
      "................",
      "......wwww......",
      ".....wwwwww.....",
      ".....wwwwww.....",
      ".....wwwwww.....",
      "......wsws......",
      ".......ww.......",
      ".......ss.......",
      "....wwwwwwww....",
      "...w..wssw..w...",
      "...w.wwwwww.w...",
      "...w..wssw..w...",
      "...w.wwwwww.w...",
      "..w...wssw...w..",
      "..w....ww....w..",
      ".......ss.......",
      ".....wwwwww.....",
      ".....w.ww.w.....",
      "................",
      "................",
      "................",
      "................",
    ],
    { w: C.cream, s: C.silver },
  );
  pc.outline();
  return tex(pc);
});

export const cobwebTexture = once(() => {
  const pc = new PixelCanvas(9, 9);
  pc.sprite(
    0,
    0,
    [
      "wwwwwwwww",
      "ww..w..w.",
      "w.w.w.w..",
      "w..www...",
      "wwww.ww..",
      "w..w.....",
      "w.w......",
      "ww.......",
      "w........",
    ],
    { w: C.silver },
  );
  return tex(pc);
});

export const craterTexture = once(() => {
  const pc = new PixelCanvas(26, 10);
  pc.ellipse(0, 0, 26, 10, C.bark);
  pc.ellipse(3, 2, 20, 6, C.cocoa);
  pc.ellipse(7, 3, 12, 4, C.night);
  pc.set(2, 1, C.slate);
  pc.set(22, 7, C.slate);
  pc.set(12, 0, C.orange);
  return tex(pc);
});

/** Little wooden sign on a post. */
export const signTexture = (() => {
  const cache = new Map<string, Texture>();
  return (text: string) => {
    const hit = cache.get(text);
    if (hit) return hit;
    const w = measureText(text) + 6;
    const h = FONT_HEIGHT + 4;
    const pc = new PixelCanvas(w + 2, h + 8);
    pc.at(1, 1);
    pc.rect(0, 0, w, h, C.wood);
    pc.hline(0, h - 1, w, C.bark);
    drawText(pc, 3, 2, text, C.night);
    pc.rect(Math.floor(w / 2) - 1, h, 2, 6, C.bark);
    pc.at(0, 0);
    pc.outline();
    const t = tex(pc);
    cache.set(text, t);
    return t;
  };
})();

export const tomatoTexture = once(() => {
  const pc = new PixelCanvas(7, 7);
  pc.sprite(0, 0, [".......", "...gg..", "..rrrr.", ".rrwrrr", ".rrrrrr", ".rrrrr.", "..rrr.."], {
    r: C.red,
    w: C.pink,
    g: C.leaf,
  });
  pc.outline();
  return tex(pc);
});

/** Tomato splat that sticks on a character. */
export const splatTexture = once(() => {
  const pc = new PixelCanvas(12, 9);
  pc.sprite(
    0,
    0,
    [
      "..r......r..",
      ".....rr.....",
      "r..rrrrrr...",
      "..rrrwrrrr.r",
      ".rrrrrrrrr..",
      "..rrrrrrr...",
      "r...rrrr..r.",
      ".....r......",
      "...r....r...",
    ],
    { r: C.red, w: C.pink },
  );
  return tex(pc);
});
