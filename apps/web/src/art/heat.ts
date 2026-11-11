/**
 * Context-window heat: a smoke puff for sessions past half their context, flickering flames
 * for sessions past 80%.
 */
import { Rectangle, Texture } from "pixi.js";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";

let smoke: Texture | null = null;
export function smokeTexture(): Texture {
  if (smoke) return smoke;
  const pc = new PixelCanvas(7, 6);
  pc.sprite(0, 0, [".aaa...", "aabba..", "abbbaa.", ".abbba.", "..aaa..", "......."], {
    a: C.slate,
    b: C.silver,
  });
  smoke = Texture.from(pc.toCanvas());
  return smoke;
}

const FLAMES = [
  ["...r....", "..rr..r.", "..ror.r.", ".rooorr.", ".royyor.", "rooyyoor", "roooooor", ".rrrrrr."],
  [".....r..", ".r..rr..", ".r.ror..", ".rrooor.", ".royyor.", "rooyyoor", "roooooor", ".rrrrrr."],
  ["....r...", "...rr...", "..rorr..", ".roooor.", "rooyyor.", "rooyyoor", "roooooor", ".rrrrrr."],
];

let flames: Texture[] | null = null;
export function flameTextures(): Texture[] {
  if (flames) return flames;
  const pc = new PixelCanvas(8 * FLAMES.length, 8);
  for (const [i, rows] of FLAMES.entries())
    pc.sprite(i * 8, 0, rows, { r: C.red, o: C.orange, y: C.lemon });
  const base = Texture.from(pc.toCanvas());
  flames = FLAMES.map(
    (_, i) => new Texture({ source: base.source, frame: new Rectangle(i * 8, 0, 8, 8) }),
  );
  return flames;
}
