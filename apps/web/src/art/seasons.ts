/**
 * The season the static art (lawn, hedges, trees) is painted for. Set once before the scene
 * is built (main.ts); textures are cached, so a change shows after the next rebuild/reload.
 */
import type { Season } from "../world/lifeRules.ts";
import { C } from "./palette.ts";

let current: Season = "summer";

export function setArtSeason(s: Season): void {
  current = s;
}

export function artSeason(): Season {
  return current;
}

export type Foliage = { dark: string; mid: string; light: string; dot: string | null };

/** Tree crown colors for spring/autumn; null = keep the summer colors (check winter first). */
export function foliage(variant: number): Foliage | null {
  switch (current) {
    case "winter":
      return null;
    case "autumn":
      return variant === 1
        ? { dark: C.rust, mid: C.orange, light: C.amber, dot: C.lemon }
        : { dark: C.bark, mid: C.rust, light: C.orange, dot: C.amber };
    case "spring":
      return variant === 1
        ? { dark: C.forest, mid: C.moss, light: C.leaf, dot: C.pink }
        : { dark: C.berry, mid: C.pink, light: C.peach, dot: C.white };
    default:
      return null;
  }
}

/** Lawn pixel: snow in winter, a few fallen leaves in autumn, otherwise the given green. */
export function lawn(green: string, r: number): string {
  if (current === "winter") return r < 0.05 ? C.silver : r < 0.08 ? C.moss : C.white;
  if (current === "autumn" && r > 0.985) return r > 0.993 ? C.orange : C.amber;
  return green;
}
