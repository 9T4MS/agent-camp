/**
 * Tiny animated-GIF encoder (GIF89a, looping) for the busy-office clip. Dependency-free.
 *
 * - One global 255-color palette from a 15-bit histogram over all frames (most frequent
 *   colors win; pixel art has few distinct colors, so this is nearly lossless).
 * - Frames after the first only carry changed pixels: unchanged ones become the transparent
 *   index 255 (disposal "do not dispose"), so a mostly static office compresses to little.
 * - LZW with 8-bit min code size, variable code width up to 12 bits, clear on a full table.
 */

export type RgbaFrame = { width: number; height: number; rgba: Uint8Array };

const TRANSPARENT = 255;
const key15 = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** Pick up to 255 palette colors (index 255 is reserved for "unchanged"). */
export function buildPalette(frames: RgbaFrame[]): number[][] {
  const counts = new Uint32Array(1 << 15);
  const sumR = new Float64Array(1 << 15);
  const sumG = new Float64Array(1 << 15);
  const sumB = new Float64Array(1 << 15);
  for (const f of frames) {
    const d = f.rgba;
    for (let i = 0; i < d.length; i += 4) {
      const k = key15(d[i]!, d[i + 1]!, d[i + 2]!);
      counts[k]!++;
      sumR[k]! += d[i]!;
      sumG[k]! += d[i + 1]!;
      sumB[k]! += d[i + 2]!;
    }
  }
  const keys: number[] = [];
  for (let k = 0; k < counts.length; k++) if (counts[k]! > 0) keys.push(k);
  keys.sort((a, b) => counts[b]! - counts[a]!);
  return keys.slice(0, 255).map((k) => {
    const n = counts[k]!;
    return [Math.round(sumR[k]! / n), Math.round(sumG[k]! / n), Math.round(sumB[k]! / n)];
  });
}

function makeMapper(palette: number[][]): (r: number, g: number, b: number) => number {
  const cache = new Int16Array(1 << 15).fill(-1);
  return (r, g, b) => {
    const k = key15(r, g, b);
    const hit = cache[k]!;
    if (hit >= 0) return hit;
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i]!;
      const dr = p[0]! - r;
      const dg = p[1]! - g;
      const db = p[2]! - b;
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    cache[k] = best;
    return best;
  };
}

/** GIF LZW (same scheme as omggif): returns the sub-blocked image data incl. terminator. */
export function lzw(indices: Uint8Array, minCodeSize = 8): Uint8Array {
  const out: number[] = [];
  let cur = 0;
  let curBits = 0;
  let codeSize = minCodeSize + 1;
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let next = eoi + 1;
  let table = new Map<number, number>();
  const emit = (code: number) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      out.push(cur & 0xff);
      cur >>>= 8;
      curBits -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      next = eoi + 1;
      codeSize = minCodeSize + 1;
      table = new Map();
    } else {
      if (next >= 1 << codeSize) codeSize++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (curBits > 0) out.push(cur & 0xff);
  // split into <= 255-byte sub-blocks
  const blocks: number[] = [minCodeSize];
  for (let i = 0; i < out.length; i += 255) {
    const chunk = out.slice(i, i + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

/** Encode frames (all the same size) as a looping GIF with `delayCs` hundredths per frame. */
export function encodeGif(frames: RgbaFrame[], delayCs = 10): Uint8Array {
  if (frames.length === 0) throw new Error("no frames");
  const { width, height } = frames[0]!;
  const palette = buildPalette(frames);
  const map = makeMapper(palette);
  const parts: Uint8Array[] = [];
  const bytes = (...b: number[]) => parts.push(Uint8Array.from(b));
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];

  parts.push(new TextEncoder().encode("GIF89a"));
  bytes(...u16(width), ...u16(height), 0xf7, 0, 0); // global table, 8 bpp, 256 entries
  const gct = new Uint8Array(768);
  for (const [i, p] of palette.entries()) gct.set(p, i * 3);
  parts.push(gct);
  // NETSCAPE2.0: loop forever
  bytes(0x21, 0xff, 0x0b, ...new TextEncoder().encode("NETSCAPE2.0"), 0x03, 0x01, 0, 0, 0);

  let prev: Uint8Array | null = null;
  for (const f of frames) {
    if (f.width !== width || f.height !== height) throw new Error("frame size mismatch");
    const idx = new Uint8Array(width * height);
    for (let p = 0, i = 0; p < idx.length; p++, i += 4) {
      idx[p] = map(f.rgba[i]!, f.rgba[i + 1]!, f.rgba[i + 2]!);
    }
    let data = idx;
    if (prev) {
      data = new Uint8Array(idx.length);
      for (let p = 0; p < idx.length; p++) data[p] = idx[p] === prev[p] ? TRANSPARENT : idx[p]!;
    }
    // graphic control: disposal 1 (keep), transparent flag on frames after the first
    bytes(0x21, 0xf9, 0x04, (1 << 2) | (prev ? 1 : 0), ...u16(delayCs), TRANSPARENT, 0);
    bytes(0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0);
    parts.push(lzw(data));
    prev = idx;
  }
  bytes(0x3b);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
