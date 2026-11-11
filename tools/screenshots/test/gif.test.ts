import { describe, expect, test } from "bun:test";
import { encodeGif, lzw } from "../gif.ts";

/** Reference GIF LZW decoder (sub-blocked input incl. min code size byte). */
function unlzw(data: Uint8Array): number[] {
  const min = data[0]!;
  const bytes: number[] = [];
  for (let i = 1; data[i]! > 0; i += data[i]! + 1)
    bytes.push(...data.subarray(i + 1, i + 1 + data[i]!));
  const clear = 1 << min;
  const eoi = clear + 1;
  let size = min + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = Array.from({ length: clear + 2 }, (_, i) => [i]);
    size = min + 1;
  };
  reset();
  let bit = 0;
  const read = () => {
    let v = 0;
    for (let i = 0; i < size; i++, bit++) v |= ((bytes[bit >> 3]! >> (bit & 7)) & 1) << i;
    return v;
  };
  const out: number[] = [];
  let prev: number[] | null = null;
  while (bit < bytes.length * 8) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code]!;
    else entry = [...prev!, prev![0]!];
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]!]);
    if (dict.length === 1 << size && size < 12) size++;
    prev = entry;
  }
  return out;
}

describe("gif encoder", () => {
  test("LZW round-trips random and repetitive data, incl. table resets", () => {
    let s = 7;
    const rand = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s;
    };
    for (const n of [1, 2, 300, 5000, 70_000]) {
      const a = Uint8Array.from({ length: n }, (_, i) => (i % 97 < 60 ? 3 : rand() % 256));
      expect(unlzw(lzw(a))).toEqual([...a]);
    }
  });

  test("encodes a valid looping GIF89a", () => {
    const frame = (c: number) => ({
      width: 4,
      height: 2,
      rgba: Uint8Array.from({ length: 32 }, (_, i) => (i % 4 === 3 ? 255 : (i * c) % 256)),
    });
    const gif = encodeGif([frame(10), frame(10), frame(30)], 8);
    expect(new TextDecoder().decode(gif.subarray(0, 6))).toBe("GIF89a");
    expect(gif[6]).toBe(4);
    expect(gif[8]).toBe(2);
    expect(gif.at(-1)).toBe(0x3b);
    expect(new TextDecoder().decode(gif.subarray(13 + 768 + 3, 13 + 768 + 14))).toBe("NETSCAPE2.0");
  });
});
