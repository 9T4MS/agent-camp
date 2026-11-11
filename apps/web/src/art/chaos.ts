/**
 * Office chaos art: fire truck, raccoons and their trash, the kaiju, the birthday cake, the
 * tornado funnel, shooting stars, flood water and ducks, the boss cat's tie.
 * Drawn in code, cached once, facing right (flip with scale.x = -1).
 */
import { Rectangle, Texture } from "pixi.js";
import { drawText } from "./font.ts";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";

function framesOf(pc: PixelCanvas, fw: number, fh: number, n: number): Texture[] {
  const base = Texture.from(pc.toCanvas());
  return Array.from(
    { length: n },
    (_, i) => new Texture({ source: base.source, frame: new Rectangle(i * fw, 0, fw, fh) }),
  );
}

function once<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => {
    v ??= make();
    return v;
  };
}

/** Fire engine with a ladder; frames alternate the siren (red / blue). 44 x 22. */
export const fireTruckTextures = once(() => {
  const fw = 44;
  const fh = 22;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 1);
    pc.ellipse(1, 17, 40, 4, C.night, 90);
    pc.round(0, 7, 41, 10, C.red);
    pc.hline(1, 7, 39, C.pink);
    pc.hline(0, 16, 41, C.wine);
    // cab
    pc.round(30, 3, 11, 8, C.red);
    pc.rect(33, 4, 6, 4, C.cyan);
    pc.set(33, 4, C.white);
    // ladder on top
    pc.hline(3, 4, 26, C.silver);
    pc.hline(3, 6, 26, C.silver);
    for (let x = 4; x < 29; x += 3) pc.vline(x, 4, 3, C.grey);
    // stripe + text
    pc.hline(1, 12, 38, C.white);
    drawText(pc, 8, 9, "112", C.lemon);
    // siren
    pc.rect(33, 1, 2, 2, f ? C.sky : C.red);
    pc.rect(36, 1, 2, 2, f ? C.red : C.sky);
    pc.rect(39, 11, 2, 2, C.lemon);
    for (const wx of [6, 30]) {
      pc.ellipse(wx, 14, 6, 6, C.night);
      pc.set(wx + 2, 16, C.silver);
    }
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  return framesOf(pc, fw, fh, 2);
});

/** Raccoon: [walk a, walk b, rummage]. 14 x 10. */
export const raccoonTextures = once(() => {
  const fw = 14;
  const fh = 10;
  const pc = new PixelCanvas(fw * 3, fh);
  for (let f = 0; f < 3; f++) {
    pc.at(f * fw + 1, 1);
    const head = f === 2 ? 4 : 2;
    pc.round(2, 3, 8, 4, C.grey);
    pc.hline(3, 6, 6, C.slate);
    // ringed tail
    pc.hline(0, 3, 2, C.grey);
    pc.set(0, 2, C.night);
    pc.set(1, 3, C.night);
    // head + mask
    pc.round(9, head - 1, 4, 4, C.silver);
    pc.hline(9, head, 4, C.night);
    pc.set(11, head, C.white);
    pc.set(12, head + 2, C.night);
    const legs = f === 1 ? [3, 8] : [4, 7];
    for (const lx of legs) pc.vline(lx, 7, 1, C.night);
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  return framesOf(pc, fw, fh, 3);
});

/** Garden trash bin (10 x 13). */
export const binTexture = once(() => {
  const pc = new PixelCanvas(12, 14);
  pc.at(1, 1);
  pc.rect(1, 2, 8, 10, C.forest);
  pc.vline(3, 3, 8, C.pine);
  pc.vline(6, 3, 8, C.pine);
  pc.rect(0, 1, 10, 2, C.moss);
  pc.hline(4, 0, 2, C.moss);
  pc.at(0, 0);
  pc.outline();
  return Texture.from(pc.toCanvas());
});

/** Bits of trash a raccoon left: [banana, can, paper]. 7 x 6 each. */
export const trashTextures = once(() => {
  const fw = 7;
  const fh = 6;
  const pc = new PixelCanvas(fw * 3, fh);
  pc.at(1, 1);
  pc.hline(0, 3, 4, C.lemon);
  pc.set(4, 2, C.lemon);
  pc.set(0, 2, C.bark);
  pc.at(fw + 1, 1);
  pc.rect(0, 1, 5, 3, C.red);
  pc.hline(0, 1, 5, C.silver);
  pc.at(2 * fw + 1, 1);
  pc.rect(0, 0, 4, 4, C.white);
  pc.set(1, 1, C.silver);
  pc.set(3, 2, C.silver);
  pc.at(0, 0);
  for (let f = 0; f < 3; f++) pc.outline(f * fw, 0, fw, fh);
  return framesOf(pc, fw, fh, 3);
});

/** The kaiju: a huge dark silhouette with glowing eyes, [step a, step b, roar]. 40 x 46. */
export const kaijuTextures = once(() => {
  const fw = 40;
  const fh = 46;
  const pc = new PixelCanvas(fw * 3, fh);
  for (let f = 0; f < 3; f++) {
    pc.at(f * fw, 0);
    const body = C.ink;
    // tail
    for (let i = 0; i < 10; i++) pc.rect(i, 30 + Math.floor(i / 3), 2, 4, body);
    // body + belly
    pc.round(8, 16, 20, 22, body);
    pc.round(13, 22, 10, 14, C.dusk);
    // spikes on the back
    for (const [x, y] of [
      [9, 14],
      [12, 11],
      [15, 9],
      [10, 20],
    ] as const) {
      pc.rect(x, y, 3, 4, C.slate);
    }
    // head
    const hy = f === 2 ? 2 : 5;
    pc.round(20, hy, 16, 12, body);
    pc.rect(30, hy + 3, 3, 2, C.lemon);
    pc.set(31, hy + 3, C.white);
    if (f === 2) {
      // jaws open
      pc.rect(26, hy + 9, 12, 4, C.wine);
      for (let x = 27; x < 37; x += 2) pc.set(x, hy + 9, C.white);
    } else pc.hline(27, hy + 9, 9, C.night);
    // arms
    pc.rect(27, 20, 6, 3, body);
    pc.rect(32, 22, 2, 3, body);
    // legs
    const step = f === 1 ? 3 : 0;
    pc.rect(11 + step, 36, 6, 10, body);
    pc.rect(21 - step, 36, 6, 10, body);
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  return framesOf(pc, fw, fh, 3);
});

/** Birthday cake with candles: two flicker frames. 18 x 16. */
export const cakeTextures = once(() => {
  const fw = 18;
  const fh = 16;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 1);
    pc.ellipse(0, 11, 16, 3, C.silver);
    pc.rect(2, 7, 12, 5, C.pink);
    pc.hline(2, 7, 12, C.white);
    pc.hline(2, 9, 12, C.berry);
    for (const x of [3, 6, 9, 12]) pc.set(x, 8, C.white);
    for (const [i, x] of [4, 8, 12].entries()) {
      pc.vline(x, 3, 4, [C.cyan, C.lemon, C.leaf][i]!);
      const up = (i + f) % 2;
      pc.set(x, 1 + up, C.orange);
      pc.set(x, 2 + up, C.lemon);
    }
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  return framesOf(pc, fw, fh, 2);
});

/** Tornado funnel: three swirl frames. 26 x 40. */
export const tornadoTextures = once(() => {
  const fw = 26;
  const fh = 40;
  const pc = new PixelCanvas(fw * 3, fh);
  for (let f = 0; f < 3; f++) {
    pc.at(f * fw, 0);
    for (let y = 0; y < 38; y++) {
      const half = Math.max(1, Math.round(12 - y * 0.3));
      const sway = Math.round(Math.sin(y * 0.35 + f * 2.1) * 2);
      const cx = 13 + sway;
      for (let x = -half; x <= half; x++) {
        const band = (y + f * 2 + Math.abs(x)) % 5;
        pc.set(cx + x, y, band === 0 ? C.silver : band < 3 ? C.grey : C.slate, 220);
      }
    }
    pc.ellipse(7, 36, 14, 4, C.slate, 160);
  }
  return framesOf(pc, fw, fh, 3);
});

/** Shooting star: a short bright streak with a fading tail (12 x 6, falls left to right). */
export const meteorTexture = once(() => {
  const pc = new PixelCanvas(12, 6);
  for (let i = 0; i < 10; i++) {
    const y = Math.floor(i / 2);
    pc.set(i, y, i > 7 ? C.white : i > 4 ? C.cyan : C.sky, 60 + i * 19);
  }
  pc.set(11, 5, C.white);
  return Texture.from(pc.toCanvas());
});

const waters = new Map<string, Texture>();
/** A flat oval of water (puddle or flooded lawn), with a lighter rim. */
export function waterTexture(w: number, h: number): Texture {
  const key = `${w}x${h}`;
  const hit = waters.get(key);
  if (hit) return hit;
  const pc = new PixelCanvas(w, h);
  pc.ellipse(0, 0, w, h, C.cyan, 200);
  pc.ellipse(1, 1, w - 2, h - 2, C.sky, 220);
  for (let i = 0; i < Math.floor(w / 6); i++) {
    const x = 3 + ((i * 37) % Math.max(1, w - 8));
    const y = 2 + ((i * 13) % Math.max(1, h - 4));
    pc.hline(x, y, 3, C.cyan);
  }
  const t = Texture.from(pc.toCanvas());
  waters.set(key, t);
  return t;
}

/** Duck paddling: two frames. 11 x 9. */
export const duckTextures = once(() => {
  const fw = 11;
  const fh = 9;
  const pc = new PixelCanvas(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    pc.at(f * fw + 1, 1);
    pc.round(0, 3, 7, 4, C.white);
    pc.hline(1, 6, 5, C.silver);
    pc.round(5, 0 + f, 3, 3, C.leaf);
    pc.set(6, 1 + f, C.night);
    pc.hline(8, 2 + f, 1, C.orange);
    pc.set(2, 4, C.silver);
    pc.at(0, 0);
    pc.outline(f * fw, 0, fw, fh);
  }
  return framesOf(pc, fw, fh, 2);
});

/** The boss cat's tiny tie (3 x 5). */
export const tieTexture = once(() => {
  const pc = new PixelCanvas(3, 5);
  pc.hline(0, 0, 3, C.red);
  pc.set(1, 1, C.red);
  pc.vline(1, 2, 2, C.wine);
  pc.hline(0, 3, 3, C.red);
  pc.set(1, 4, C.red);
  return Texture.from(pc.toCanvas());
});
