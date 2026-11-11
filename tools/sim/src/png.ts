/**
 * `--snapshots N`: a tiny dependency-free PNG encoder (RGB, 8 bit, zlib via node:zlib) and a
 * pixel "office" scene generator, so the timelapse page has frames to play.
 */
import { deflateSync } from "node:zlib";
import { AGENT_COLORS, PALETTE, seededRandom } from "@agent-office/protocol";

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode an RGB image (width*height*3 bytes, row-major) as PNG. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  if (rgb.length !== width * height * 3) throw new Error("rgb buffer has the wrong size");
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // compression, filter, interlace = 0
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const parts = [
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Read width/height from a PNG's IHDR (throws if it is not a PNG). */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24 || PNG_SIGNATURE.some((b, i) => png[i] !== b)) throw new Error("not a PNG");
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

const rgbOf = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * A small pixel office for timelapse frame `frame` of `total`: wooden floor, desks in a grid,
 * characters with agent-colored jackets. The office fills up and empties over the frames and
 * the windows go from day to night.
 */
export function renderScene(
  frame: number,
  total: number,
  seed = 42,
  width = 192,
  height = 120,
): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  const rand = seededRandom(`scene:${seed}:${frame}`);
  const set = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    rgb[i] = c[0];
    rgb[i + 1] = c[1];
    rgb[i + 2] = c[2];
  };
  const rect = (x: number, y: number, w: number, h: number, c: [number, number, number]) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, c);
  };
  const phase = total > 1 ? frame / (total - 1) : 0.5;
  // wall + windows (sky goes day -> dusk -> night)
  rect(0, 0, width, 24, rgbOf("#3e2731"));
  const sky = phase < 0.5 ? "#0099db" : phase < 0.8 ? "#f77622" : "#262b44";
  for (let x = 12; x < width - 20; x += 40) {
    rect(x, 5, 24, 13, rgbOf("#ead4aa"));
    rect(x + 1, 6, 22, 11, rgbOf(sky));
  }
  // floor planks
  for (let y = 24; y < height; y++)
    for (let x = 0; x < width; x++)
      set(x, y, rgbOf(((x >> 4) + (y >> 3)) % 2 ? "#b86f50" : "#c28569"));
  // desks + characters
  const busy = Math.sin(Math.PI * phase); // 0 -> 1 -> 0
  const agents = Object.values(AGENT_COLORS);
  let desk = 0;
  for (let y = 36; y < height - 16; y += 28) {
    for (let x = 14; x < width - 24; x += 30, desk++) {
      rect(x, y, 22, 10, rgbOf("#733e39"));
      rect(x + 7, y - 6, 8, 6, rgbOf("#262b44")); // monitor
      rect(x + 8, y - 5, 6, 4, rgbOf(rand() < 0.5 ? "#2ce8f5" : "#63c74d"));
      if (rand() < busy * 0.95) {
        const jacket = rgbOf(agents[desk % 7 === 3 ? 1 : rand() < 0.75 ? 0 : 2]!);
        rect(x + 8, y + 11, 6, 5, jacket);
        rect(x + 9, y + 7, 4, 4, rgbOf(PALETTE[2 + Math.floor(rand() * 3)]!));
      }
    }
  }
  // the office cat wanders
  rect(Math.floor(phase * (width - 10)), height - 7, 6, 4, rgbOf("#181425"));
  return rgb;
}

export function sceneFrame(frame: number, total: number, seed = 42): Uint8Array {
  return encodePng(192, 120, renderScene(frame, total, seed));
}

/** Upload `n` generated frames to POST /api/snapshots (Bearer skips the rate limit). */
export async function uploadSnapshots(
  http: string,
  password: string,
  n: number,
  seed = 42,
  log: (line: string) => void = () => {},
): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const png = sceneFrame(i, n, seed);
    const res = await fetch(`${http}/api/snapshots`, {
      method: "POST",
      headers: { authorization: `Bearer ${password}`, "content-type": "image/png" },
      body: png as Uint8Array<ArrayBuffer>, // DOM typings (screenshots tool) want a plain ArrayBuffer
    });
    if (!res.ok) throw new Error(`snapshot upload failed: ${res.status} ${await res.text()}`);
    const body = (await res.json().catch(() => ({}))) as { id?: number };
    if (typeof body.id === "number") ids.push(body.id);
    log(
      `snapshot  ${i + 1}/${n} uploaded (${png.length} bytes${body.id ? `, id ${body.id}` : ""})`,
    );
  }
  return ids;
}
