/**
 * Fabric patterns at texel scale. A pattern is drawn over a garment's base colour; shading
 * (shadow column, light edge) is painted on top by the garment painters.
 * Coordinates are garment-local so a pattern doesn't crawl when the body bobs.
 */
import type { Pattern, Ramp } from "@agent-office/protocol";
import { hash2, mix, noise, opt } from "./color.ts";

export type Fabric = { ramp: Ramp; pattern: Pattern; salt?: number };

/** Colour of one texel of a fabric. */
export function fabricAt(f: Fabric, x: number, y: number): string {
  const { ramp, pattern } = f;
  const a = pattern.a;
  const b = opt(pattern.b, ramp.shadow);
  const s = f.salt ?? 0;
  switch (pattern.kind) {
    case "none":
      return ramp.base;
    case "dots":
      return (x % 4 === 1 && y % 4 === 1) || (x % 4 === 3 && y % 4 === 3) ? a : ramp.base;
    case "pinstripe":
      return x % 3 === 1 ? a : ramp.base;
    case "stripes":
      return y % 4 < 2 ? a : pattern.b === "none" ? ramp.base : b;
    case "check": {
      const on = ((x >> 1) + (y >> 1)) % 2 === 0;
      return on ? a : ramp.base;
    }
    case "plaid": {
      const vx = x % 5 === 0;
      const hy = y % 5 === 0;
      if (vx && hy) return mix(a, b, 0.5);
      if (vx) return a;
      if (hy) return b;
      return ramp.base;
    }
    case "damask": {
      // small dense ornament: offset dots of `a` and `b` on a 4×4 tile
      const tx = x % 4;
      const ty = y % 4;
      if ((tx === 0 && ty === 0) || (tx === 2 && ty === 2)) return a;
      if ((tx === 2 && ty === 0) || (tx === 0 && ty === 2)) return b;
      return ramp.base;
    }
    case "floral": {
      const tx = (x + (y >= 0 ? Math.floor(y / 5) * 3 : 0)) % 6;
      const ty = y % 5;
      if (tx === 2 && ty === 2) return b;
      if ((tx === 2 && (ty === 1 || ty === 3)) || (ty === 2 && (tx === 1 || tx === 3))) return a;
      return ramp.base;
    }
    case "heather": {
      const h = hash2(x, y, 11 + s) % 7;
      return h === 0 ? a : h === 1 && pattern.b !== "none" ? b : ramp.base;
    }
    case "worn": {
      // blotchy patina: lighter patches (a), darker patches (b)
      const n = noise(x + 3, y + 1, 3, 7 + s);
      if (n > 0.68) return a;
      if (n < 0.24) return b;
      return ramp.base;
    }
    case "camo": {
      const n = noise(x, y, 3, 19 + s);
      if (n > 0.62) return a;
      if (n < 0.32) return b;
      return ramp.base;
    }
  }
}
