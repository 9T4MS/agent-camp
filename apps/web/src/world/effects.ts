/**
 * Short-lived effects: puffs, confetti, sparkles, fireworks, floating toasts/bubbles.
 * Pooled sprites for particles, no per-frame allocation.
 */
import { type Container, Sprite, type Texture } from "pixi.js";
import { paperBallTexture, sparkleTextures } from "../art/fun.ts";
import { CONFETTI_COLORS, pixelTexture, puffTextures } from "../art/fx.ts";
import { C, hexNum } from "../art/palette.ts";

type Puff = { sprite: Sprite; t: number };
type Bit = {
  sprite: Sprite;
  vx: number;
  vy: number;
  life: number;
  t: number;
  floor: number;
  /** fireworks fall slowly and do not flutter like paper */
  spark?: boolean;
};
type Flip = { sprite: Sprite; frames: Texture[]; fps: number; t: number };
type Floater = {
  sprite: Sprite;
  x: number;
  y: number;
  t: number;
  life: number;
  rise: number;
  sway: number;
};
type Later = { t: number; fn: () => void };
type Throw = {
  sprite: Sprite;
  from: { x: number; y: number };
  to: { x: number; y: number };
  t: number;
  dur: number;
  onHit: () => void;
};

export class Effects {
  private puffs: Puff[] = [];
  private bits: Bit[] = [];
  private pool: Sprite[] = [];
  private flips: Flip[] = [];
  private floaters: Floater[] = [];
  private later: Later[] = [];
  private throws: Throw[] = [];

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

  /** One-shot flipbook (e.g. a sparkle). */
  flip(frames: Texture[], x: number, y: number, fps = 12) {
    const s = this.take();
    s.texture = frames[0]!;
    s.tint = 0xffffff;
    s.anchor.set(0.5);
    s.scale.set(1);
    s.position.set(Math.round(x), Math.round(y));
    this.flips.push({ sprite: s, frames, fps, t: 0 });
  }

  sparkle(x: number, y: number) {
    this.flip(sparkleTextures(), x, y, 10);
  }

  /** Radial burst of pixels (fireworks, crumbs). */
  burst(
    x: number,
    y: number,
    colors: readonly string[],
    opts: { count?: number; speed?: number; life?: number; floor?: number; rand?: () => number },
  ) {
    const rand = opts.rand ?? Math.random;
    const count = opts.count ?? 24;
    for (let i = 0; i < count; i++) {
      const s = this.take();
      s.texture = pixelTexture();
      s.anchor.set(0.5);
      s.scale.set(opts.floor === undefined ? 1 : rand() < 0.4 ? 1 : 0.5);
      s.tint = hexNum(colors[i % colors.length]!);
      s.position.set(x, y);
      const a = (i / count) * Math.PI * 2 + rand() * 0.3;
      const v = (opts.speed ?? 60) * (0.6 + rand() * 0.5);
      this.bits.push({
        sprite: s,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: (opts.life ?? 1.2) * (0.8 + rand() * 0.4),
        t: 0,
        floor: opts.floor ?? Number.POSITIVE_INFINITY,
        spark: opts.floor === undefined,
      });
    }
  }

  /** A few staggered firework bursts above a point. */
  fireworks(x: number, y: number, rand: () => number = Math.random) {
    const sets = [
      [C.red, C.amber, C.lemon],
      [C.cyan, C.white, C.sky],
      [C.pink, C.berry, C.lemon],
      [C.leaf, C.lemon, C.white],
    ];
    sets.forEach((cols, i) => {
      const bx = x + (rand() - 0.5) * 50;
      const by = y - 18 - rand() * 22;
      this.after(i * 0.45, () => {
        this.burst(bx, by, cols, { count: 30, speed: 80, life: 1.3, rand });
        this.sparkle(bx, by);
      });
    });
  }

  /** A sprite (toast, bubble, heart) that rises and fades. Ownership stays with the caller's texture. */
  floater(tex: Texture, x: number, y: number, life = 2.5, rise = 10, sway = 0) {
    const s = new Sprite(tex);
    s.anchor.set(0.5, 1);
    s.position.set(Math.round(x), Math.round(y));
    this.layer.addChild(s);
    this.floaters.push({ sprite: s, x, y, t: 0, life, rise, sway });
  }

  /** A crumpled paper ball lobbed in an arc; it bounces off the target and lands nearby. */
  throwBall(fx: number, fy: number, tx: number, ty: number, onHit: () => void = () => {}) {
    const s = new Sprite(paperBallTexture());
    s.anchor.set(0.5);
    s.position.set(Math.round(fx), Math.round(fy));
    this.layer.addChild(s);
    const dur = Math.min(1.1, 0.45 + Math.hypot(tx - fx, ty - fy) / 260);
    this.throws.push({ sprite: s, from: { x: fx, y: fy }, to: { x: tx, y: ty }, t: 0, dur, onHit });
  }

  after(seconds: number, fn: () => void) {
    this.later.push({ t: seconds, fn });
  }

  update(dt: number) {
    for (let i = this.throws.length - 1; i >= 0; i--) {
      const b = this.throws[i]!;
      b.t += dt;
      const k = Math.min(1, b.t / b.dur);
      const arc = Math.sin(k * Math.PI) * Math.min(60, 20 + Math.abs(b.to.x - b.from.x) * 0.25);
      b.sprite.position.set(
        Math.round(b.from.x + (b.to.x - b.from.x) * k),
        Math.round(b.from.y + (b.to.y - b.from.y) * k - arc),
      );
      b.sprite.rotation = Math.round(b.t * 12) * (Math.PI / 2);
      if (k < 1) continue;
      this.throws.splice(i, 1);
      b.onHit();
      // bounce off the head and roll to a stop on the floor, then fade
      const bounce: Throw = {
        sprite: b.sprite,
        from: { ...b.to },
        to: { x: b.to.x + (b.to.x >= b.from.x ? 10 : -10), y: b.to.y + 18 },
        t: 0,
        dur: 0.35,
        onHit: () =>
          this.floater(
            b.sprite.texture,
            b.to.x + (b.to.x >= b.from.x ? 10 : -10),
            b.to.y + 22,
            3,
            0,
          ),
      };
      if (b.dur > 0.36) this.throws.push(bounce);
      else {
        this.layer.removeChild(b.sprite);
        b.sprite.destroy();
      }
    }
    for (let i = this.later.length - 1; i >= 0; i--) {
      const l = this.later[i]!;
      l.t -= dt;
      if (l.t <= 0) {
        this.later.splice(i, 1);
        l.fn();
      }
    }
    for (let i = this.flips.length - 1; i >= 0; i--) {
      const f = this.flips[i]!;
      f.t += dt;
      const k = Math.floor(f.t * f.fps);
      if (k >= f.frames.length) {
        this.give(f.sprite);
        this.flips.splice(i, 1);
        continue;
      }
      f.sprite.texture = f.frames[k]!;
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]!;
      f.t += dt;
      if (f.t >= f.life) {
        this.layer.removeChild(f.sprite);
        f.sprite.destroy();
        this.floaters.splice(i, 1);
        continue;
      }
      const k = f.t / f.life;
      // pop in, hold, then drift up while fading
      const pop = Math.min(1, f.t * 6);
      f.sprite.scale.set(pop < 1 ? 0.6 + 0.4 * pop : 1);
      f.sprite.position.set(
        Math.round(f.x + Math.sin(f.t * 4) * f.sway),
        Math.round(f.y - f.rise * k),
      );
      f.sprite.alpha = k > 0.7 ? (1 - k) / 0.3 : 1;
    }
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
      if (b.spark) {
        b.vy += 40 * dt;
        b.vx *= 1 - dt * 2.2;
        b.vy *= 1 - dt * 2.2;
        b.sprite.x += b.vx * dt;
        b.sprite.y += b.vy * dt;
        b.sprite.alpha = Math.min(1, (b.life - b.t) * 2.5);
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
