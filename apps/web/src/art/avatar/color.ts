/**
 * Colour helpers for the HD character painter. Characters are the one place where free hex
 * colours are allowed (a look carries its own ramps); everything else stays Endesga 32.
 */
import type { Ramp } from "@agent-office/protocol";

export const NIGHT = "#181425"; // outline + darkest ink
export const WHITE = "#ffffff";

const rgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hex2 = (v: number) =>
  Math.max(0, Math.min(255, Math.round(v)))
    .toString(16)
    .padStart(2, "0");

/** Linear mix: t=0 -> a, t=1 -> b. */
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return `#${hex2(r1 + (r2 - r1) * t)}${hex2(g1 + (g2 - g1) * t)}${hex2(b1 + (b2 - b1) * t)}`;
}

export const darken = (hex: string, t: number) => mix(hex, NIGHT, t);
export const lighten = (hex: string, t: number) => mix(hex, WHITE, t);

/** Perceived brightness 0..1. */
export function luma(hex: string): number {
  const [r, g, b] = rgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** OptHex helper: "none" -> fallback. */
export const opt = (h: string, fallback: string) => (h === "none" ? fallback : h);
/** OptHex helper: "none" -> null. */
export const optOrNull = (h: string): string | null => (h === "none" ? null : h);

/** A ramp from three colours. */
export const ramp = (base: string, shadow: string, light: string): Ramp => ({
  base,
  shadow,
  light,
});

/** Small deterministic integer hash of a texel position (patterns, speckles). */
export function hash2(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Smooth-ish value noise in 0..1 with the given cell size (worn patina, camo blobs). */
export function noise(x: number, y: number, cell: number, salt = 0): number {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const fx = (x - gx * cell) / cell;
  const fy = (y - gy * cell) / cell;
  const v = (i: number, j: number) => (hash2(gx + i, gy + j, salt) % 1000) / 1000;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = v(0, 0) + (v(1, 0) - v(0, 0)) * sx;
  const bot = v(0, 1) + (v(1, 1) - v(0, 1)) * sx;
  return top + (bot - top) * sy;
}
