/** Vehicle art complements the single AvatarSpec paper doll; no separate wardrobe state. */
import type { AgentKind, AvatarSpec } from "@agent-office/protocol";
import { CHAR_H, CHAR_RES, CHAR_W, lookFor, paintSheet } from "./characters.ts";
import { accentHex } from "./costumes.ts";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";
/** Transparent vehicle layer anchored at (32,48), the character's feet. */
export function vehiclePixels(avatar: AvatarSpec): PixelCanvas {
  const p = new PixelCanvas(64, 64).at(24, 24);
  const color = accentHex(avatar.accentColor ?? "cyan");
  // Vehicles sit below the body, leaving the agent-colored jacket readable.
  if (avatar.vehicle === "car") {
    p.round(-8, 19, 32, 8, C.night);
    p.round(-7, 18, 30, 7, color);
    p.rect(-1, 14, 17, 6, color);
    p.rect(1, 15, 6, 4, C.cyan);
    p.rect(9, 15, 5, 4, C.navy);
    p.rect(-4, 24, 5, 5, C.ink);
    p.rect(16, 24, 5, 5, C.ink);
    p.rect(-3, 25, 3, 2, C.silver);
    p.rect(17, 25, 3, 2, C.silver);
    p.rect(21, 20, 2, 2, C.lemon);
  } else if (avatar.vehicle === "skateboard") {
    p.round(-4, 24, 25, 3, color);
    p.rect(-1, 27, 3, 3, C.ink);
    p.rect(15, 27, 3, 3, C.ink);
    p.hline(-1, 24, 19, C.white);
  } else if (avatar.vehicle === "hoverboard") {
    p.round(-4, 24, 25, 4, C.navy);
    p.hline(-3, 24, 23, color);
    p.rect(-1, 29, 5, 1, C.cyan);
    p.rect(12, 29, 5, 1, C.pink);
  } else if (avatar.vehicle === "spaceship") {
    p.ellipse(-8, 17, 32, 10, C.slate);
    p.ellipse(-3, 14, 22, 9, C.cyan);
    p.hline(-5, 24, 27, color);
    for (let x = -3; x < 23; x += 6) p.rect(x, 25, 2, 2, C.lemon);
    p.rect(3, 28, 3, 3, C.orange);
    p.rect(11, 28, 3, 3, C.orange);
  }
  return p;
}
export function vehicleCanvas(avatar: AvatarSpec): HTMLCanvasElement {
  return vehiclePixels(avatar).toCanvas();
}
/**
 * One full avatar, including the optional vehicle, for a race runner or preview. The character
 * is the HD frame (2 texels per world px), so the portrait is 128×128 texels for a 64×64 world
 * px box; the 1× vehicle layer is doubled under it.
 */
export function avatarPortrait(avatar: AvatarSpec, agent: AgentKind = "codex"): HTMLCanvasElement {
  const p = new PixelCanvas(64 * CHAR_RES, 64 * CHAR_RES);
  const sheet = paintSheet(lookFor(avatar, agent, null));
  p.copyFrom(sheet, 0, 0, CHAR_W * CHAR_RES, CHAR_H * CHAR_RES, 24 * CHAR_RES, 24 * CHAR_RES);
  const vehicle = vehiclePixels(avatar);
  for (let y = 0; y < vehicle.height; y++)
    for (let x = 0; x < vehicle.width; x++) {
      const v = vehicle.data[y * vehicle.width + x]!;
      if (v >>> 24 === 0) continue;
      for (let dy = 0; dy < CHAR_RES; dy++)
        for (let dx = 0; dx < CHAR_RES; dx++) p.put(x * CHAR_RES + dx, y * CHAR_RES + dy, v);
    }
  return p.toCanvas();
}
