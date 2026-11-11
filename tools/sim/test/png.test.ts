import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { crc32, encodePng, PNG_SIGNATURE, pngSize, sceneFrame } from "../src/png.ts";

test("crc32 matches the reference value", () => {
  expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
});

test("encodePng writes a valid PNG with the right size", () => {
  const w = 7;
  const h = 3;
  const rgb = new Uint8Array(w * h * 3).map((_, i) => i % 256);
  const png = encodePng(w, h, rgb);
  expect([...png.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
  expect(pngSize(png)).toEqual({ width: w, height: h });
  // decode IDAT back to the raw scanlines
  const v = new DataView(png.buffer, png.byteOffset);
  let off = 8;
  const idat: number[] = [];
  while (off < png.length) {
    const len = v.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    if (type === "IDAT") idat.push(...png.subarray(off + 8, off + 8 + len));
    expect(v.getUint32(off + 8 + len)).toBe(crc32(png.subarray(off + 4, off + 8 + len)));
    off += 12 + len;
  }
  const raw = inflateSync(new Uint8Array(idat));
  expect(raw.length).toBe((w * 3 + 1) * h);
  expect([...raw.subarray(1, 1 + w * 3)]).toEqual([...rgb.subarray(0, w * 3)]);
});

test("scene frames are small PNGs that differ over time", () => {
  const a = sceneFrame(0, 5);
  const b = sceneFrame(2, 5);
  expect(pngSize(a)).toEqual({ width: 192, height: 120 });
  expect(a.length).toBeLessThan(300 * 1024);
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
});

test("pngSize rejects non-PNG input", () => {
  expect(() => pngSize(new Uint8Array(30))).toThrow();
});
