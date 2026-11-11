/** Short-lived effects: puffs and confetti. Pooled sprites, no per-frame allocation. */
import { type Container, Sprite } from "pixi.js";
import { CONFETTI_COLORS, pixelTexture, puffTextures } from "../art/fx.ts";
import { hexNum } from "../art/palette.ts";

type Puff = { sprite: Sprite; t: number };
type Bit = { sprite: Sprite; vx: number; vy: number; life: number; t: number; floor: number };

export class Effects {
  private puffs: Puff[] = [];
  private bits: Bit[] = [];
  private pool: Sprite[] = [];

  constructor(private readonly layer: Container) {}

  private take(): Sprite {
    const s = this.pool.pop() ?? new Sprite(pixelTexture());
    s.visible = true;
    s.alpha = 1;
    this.layer.addChild(s);
    return s;
  }

  private give(s: Sprite) {
    s.visible = false;
    this.layer.removeChild(s);
    this.pool.push(s);
  }

  puff(x: number, y: number) {
    const s = this.take();
    s.texture = puffTextures()[0]!;
    s.tint = 0xffffff;
    s.anchor.set(0.5);
    s.scale.set(1);
    s.position.set(Math.round(x), Math.round(y));
    this.puffs.push({ sprite: s, t: 0 });
  }

  /** A confetti cannon: `lean` tilts the burst (radians, negative = to the left). */
  confetti(x: number, y: number, count = 40, rand: () => number = Math.random, lean = 0) {
    for (let i = 0; i < count; i++) {
      const s = this.take();
      s.texture = pixelTexture();
      s.anchor.set(0.5);
      const big = rand() < 0.55;
      s.scale.set(big ? 2 : 1, big ? (rand() < 0.5 ? 1 : 2) : 1);
      s.tint = hexNum(CONFETTI_COLORS[i % CONFETTI_COLORS.length]!);
      s.position.set(x, y);
      const a = -Math.PI / 2 + lean + (rand() - 0.5) * 1.5;
      const v = 80 + rand() * 90;
      this.bits.push({
        sprite: s,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: 2.2 + rand() * 1.3,
        t: 0,
        // land on the floor just inside the door instead of falling through the wall
        floor: y - 4 - rand() * 30,
      });
    }
  }

  update(dt: number) {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]!;
      p.t += dt;
      const f = Math.floor(p.t * 12);
      if (f >= 4) {
        this.give(p.sprite);
        this.puffs.splice(i, 1);
        continue;
      }
      p.sprite.texture = puffTextures()[f]!;
    }
    for (let i = this.bits.length - 1; i >= 0; i--) {
      const b = this.bits[i]!;
      b.t += dt;
      if (b.t >= b.life) {
        this.give(b.sprite);
        this.bits.splice(i, 1);
        continue;
      }
      // fall like paper: gravity with drag, a little flutter
      b.vy = Math.min(b.vy + 140 * dt, 26);
      b.vx *= 1 - dt * 1.8;
      b.vx += Math.sin((b.t + i) * 9) * 6 * dt * 10;
      if (b.vy > 0 && b.sprite.y >= b.floor) {
        b.vx = 0;
        b.vy = 0;
      }
      b.sprite.x += b.vx * dt;
      b.sprite.y += b.vy * dt;
      b.sprite.alpha = Math.min(1, (b.life - b.t) * 2);
    }
  }
}
