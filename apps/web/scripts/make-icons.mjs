// Generates the home-screen icons (pixel art, Endesga 32) into public/icons/.
// Usage: node scripts/make-icons.mjs   (no dependencies; tiny PNG encoder below)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const ART = [
  "................",
  "................",
  "...kkkkkkkkkk...",
  "...kppppppppk...",
  "...kpllpyyppk...",
  "...kppppppppk...",
  "...kplllllppk...",
  "...kkkkkkkkkk...",
  "......kggk......",
  "..hhhh.........",
  ".hhhhhh........",
  ".hssssh........",
  "tttttttttttttttt",
  "dddddddddddddddd",
  ".b............b.",
  ".b............b.",
];
const COLORS = {
  k: "#181425",
  p: "#193c3e",
  l: "#63c74d",
  y: "#fee761",
  g: "#5a6988",
  h: "#733e39",
  s: "#e8b796",
  t: "#e4a672",
  d: "#b86f50",
  b: "#3e2731",
};
const BG = "#262b44";
const BORDER = "#3e2731";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

function icon(size) {
  // 20x20 logical grid: 2-px frame + the 16x16 art centered
  const cell = size / 20;
  return png(size, (x, y) => {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    if (gx === 0 || gy === 0 || gx === 19 || gy === 19) return rgb(BORDER);
    const ax = gx - 2;
    const ay = gy - 2;
    const ch = ART[ay]?.[ax];
    return rgb(ch && COLORS[ch] ? COLORS[ch] : BG);
  });
}

// Android "maskable" icon: no frame, the art kept inside the center safe zone (any mask shape
// leaves it whole), whole-pixel cells so it stays crisp
function maskable(size) {
  const cell = Math.floor((size * 0.55) / 16);
  const off = Math.floor((size - cell * 16) / 2);
  return png(size, (x, y) => {
    const ax = Math.floor((x - off) / cell);
    const ay = Math.floor((y - off) / cell);
    const ch = x >= off && y >= off ? ART[ay]?.[ax] : undefined;
    return rgb(ch && COLORS[ch] ? COLORS[ch] : BG);
  });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "icon-maskable-512.png"), maskable(512));
console.log("wrote icon-maskable-512.png");
for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
]) {
  writeFileSync(join(OUT, name), icon(size));
  console.log("wrote", name);
}
