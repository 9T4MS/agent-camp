/**
 * Tiny deterministic hashing + seeded randomness. Dependency-free and identical in
 * every runtime (Bun, Node, Workers, browsers), so the same seed always yields the
 * same avatar on the server and in the renderer.
 */

/** 32-bit FNV-1a hash of a string (UTF-16 code units). Returns an unsigned int. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG: returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded PRNG from a string or number seed. Floats in [0, 1). */
export function seededRandom(seed: string | number): () => number {
  return mulberry32(typeof seed === "number" ? seed : hashString(seed));
}

/** Pick one element of a non-empty array using `rand`. */
export function pick<T>(rand: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick() from empty array");
  return items[Math.floor(rand() * items.length) % items.length] as T;
}
