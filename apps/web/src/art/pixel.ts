/**
 * Tiny software pixel canvas. All art is drawn here pixel by pixel (no anti-aliasing),
 * then uploaded once as a texture. Keeps art code independent of Pixi.
 */
import { OUTLINE } from "./palette.ts";

const colorCache = new Map<string, number>();

/** "#rrggbb" -> packed little-endian RGBA (as stored in ImageData). */
export function packColor(hex: string, alpha = 255): number {
  const key = alpha === 255 ? hex : `${hex}/${alpha}`;
  let c = colorCache.get(key);
  if (c === undefined) {
    const n = Number.parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    c = ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0;
    colorCache.set(key, c);
  }
  return c;
}

export class PixelCanvas {
  readonly data: Uint32Array;
  /** drawing offset, so frame painters can use local coordinates */
  ox = 0;
  oy = 0;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint32Array(width * height);
  }

  at(x: number, y: number): this {
    this.ox = x;
    this.oy = y;
    return this;
  }

  set(x: number, y: number, hex: string, alpha = 255): void {
    const px = (x + this.ox) | 0;
    const py = (y + this.oy) | 0;
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    this.data[py * this.width + px] = packColor(hex, alpha);
  }

  clear(x: number, y: number): void {
    const px = (x + this.ox) | 0;
    const py = (y + this.oy) | 0;
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    this.data[py * this.width + px] = 0;
  }

  get(x: number, y: number): number {
    const px = (x + this.ox) | 0;
    const py = (y + this.oy) | 0;
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return 0;
    return this.data[py * this.width + px]!;
  }

  rect(x: number, y: number, w: number, h: number, hex: string, alpha = 255): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, hex, alpha);
  }

  hline(x: number, y: number, w: number, hex: string): void {
    for (let i = 0; i < w; i++) this.set(x + i, y, hex);
  }

  vline(x: number, y: number, h: number, hex: string): void {
    for (let j = 0; j < h; j++) this.set(x, y + j, hex);
  }

  /** Rect with the four corner pixels left out (cheap rounded look). */
  round(x: number, y: number, w: number, h: number, hex: string): void {
    this.rect(x + 1, y, w - 2, h, hex);
    this.rect(x, y + 1, 1, h - 2, hex);
    this.rect(x + w - 1, y + 1, 1, h - 2, hex);
  }

  /** Filled ellipse inside the given box. */
  ellipse(x: number, y: number, w: number, h: number, hex: string, alpha = 255): void {
    const rx = w / 2;
    const ry = h / 2;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const dx = (i + 0.5 - rx) / rx;
        const dy = (j + 0.5 - ry) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x + i, y + j, hex, alpha);
      }
    }
  }

  /**
   * Draw ASCII art: each char maps to a color via `colors` ('.' / ' ' = skip).
   * Lets small sprites be authored as readable string grids.
   */
  sprite(x: number, y: number, rows: readonly string[], colors: Record<string, string>): void {
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j]!;
      for (let i = 0; i < row.length; i++) {
        const ch = row[i]!;
        if (ch === "." || ch === " ") continue;
        const hex = colors[ch];
        if (hex) this.set(x + i, y + j, hex);
      }
    }
  }

  /**
   * 1-px outline around everything opaque inside the region (absolute coords, ignores
   * offset). `diagonal` also fills corner-adjacent pixels for a chunkier silhouette.
   */
  outline(
    rx = 0,
    ry = 0,
    rw = this.width,
    rh = this.height,
    hex: string = OUTLINE,
    diagonal = false,
  ): void {
    const w = this.width;
    const src = this.data;
    const color = packColor(hex);
    const marks: number[] = [];
    const opaque = (x: number, y: number) =>
      x >= rx && y >= ry && x < rx + rw && y < ry + rh && src[y * w + x]! >>> 24 > 0;
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        if (src[y * w + x]! >>> 24 > 0) continue;
        let hit = opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1);
        if (!hit && diagonal) {
          hit =
            opaque(x - 1, y - 1) ||
            opaque(x + 1, y - 1) ||
            opaque(x - 1, y + 1) ||
            opaque(x + 1, y + 1);
        }
        if (hit) marks.push(y * w + x);
      }
    }
    for (const i of marks) src[i] = color;
  }

  /** Mirror a region horizontally into another place (for left/right frames). */
  mirrorFrom(sx: number, sy: number, w: number, h: number, dx: number, dy: number): void {
    const W = this.width;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        this.data[(dy + y) * W + dx + (w - 1 - x)] = this.data[(sy + y) * W + sx + x]!;
      }
    }
  }

  /** Copy a region (absolute coordinates). */
  copyFrom(src: PixelCanvas, sx: number, sy: number, w: number, h: number, dx: number, dy: number) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = src.data[(sy + y) * src.width + sx + x]!;
        if (v >>> 24 === 0) continue;
        const tx = dx + x;
        const ty = dy + y;
        if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) continue;
        this.data[ty * this.width + tx] = v;
      }
    }
  }

  toCanvas(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(this.width, this.height);
    new Uint32Array(img.data.buffer).set(this.data);
    ctx.putImageData(img, 0, 0);
    return canvas;
  }
}
