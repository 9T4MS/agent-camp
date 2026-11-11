/**
 * Subagent helpers: tiny bots that pop out with a puff near the parent's desk, scurry
 * around the pod's aisle and now and then run an errand (carry a paper or a box to the
 * printer, the server rack or the bookshelf and back). Max 5 visible, plus a "+N" badge.
 * When a helper finishes it hops into the parent's monitor with a sparkle (or the office
 * cat gets it).
 */
import type { AgentKind } from "@agent-office/protocol";
import { type Container, Sprite } from "pixi.js";
import { carryTextures } from "../art/fun.ts";
import { badgeTexture, botTextures } from "../art/fx.ts";
import type { Effects } from "./effects.ts";

const MAX_VISIBLE = 5;
type Pt = { x: number; y: number };
type Bot = {
  sprite: Sprite;
  x: number;
  y: number;
  tx: number;
  ty: number;
  wait: number;
  phase: number;
  /** errand: path to walk, what it carries, and whether it is on the way back */
  errand: { path: Pt[]; back: boolean; carry: Sprite; pause: number; home: Pt } | null;
};
type Leaving = { sprite: Sprite; x0: number; y0: number; t: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** Hooks the world gives the swarm (paths around furniture, the hungry cat). */
export type HelperWorld = {
  /** a walkable path (pixel waypoints) from a point to a random errand spot, or null */
  errand(from: Pt, rand: () => number): Pt[] | null;
  /** path back from an errand spot to a point near the pod */
  pathTo(from: Pt, to: Pt): Pt[] | null;
  /** the cat may take a finishing helper: true = it owns the sprite now */
  catEats(sprite: Sprite, x: number, y: number): boolean;
};

export class HelperSwarm {
  private bots: Bot[] = [];
  private leaving: Leaving[] = [];
  private badge: Sprite | null = null;
  private count = 0;
  /** seconds a helper spends at least between errands */
  errandEvery = 25;
  /** while set, every helper drops its errand and crowds under this point (carrying someone) */
  escort: Pt | null = null;

  constructor(
    private readonly objects: Container,
    private readonly fxLayer: Container,
    private readonly effects: Effects,
    private readonly agent: AgentKind,
    private area: Rect,
    private origin: { x: number; y: number },
    private readonly rand: () => number,
    private readonly world: HelperWorld | null = null,
  ) {}

  setArea(area: Rect, origin: { x: number; y: number }) {
    this.area = area;
    this.origin = origin;
  }

  set(count: number, animate: boolean) {
    const finished = this.count - count;
    this.count = count;
    const want = Math.min(MAX_VISIBLE, count);
    while (this.bots.length < want) this.spawn(animate);
    // helpers beyond the visible five finish too: one of them pops out of the crowd and hops home
    const hidden = Math.min(finished, this.bots.length - want);
    for (let i = hidden; animate && i < finished && this.bots.length > 0; i++) {
      const from = this.bots[Math.floor(this.rand() * this.bots.length)]!;
      const s = new Sprite(botTextures(this.agent)[0]!);
      s.anchor.set(0.5, 1);
      s.label = "actor";
      this.objects.addChild(s);
      s.position.set(Math.round(from.x), Math.round(from.y));
      if (!this.world?.catEats(s, from.x, from.y))
        this.leaving.push({ sprite: s, x0: from.x, y0: from.y, t: 0 });
    }
    while (this.bots.length > want) this.despawn(animate);
    const extra = count - want;
    if (extra > 0) {
      const tex = badgeTexture(`+${extra}`);
      if (!this.badge) {
        this.badge = new Sprite(tex);
        this.badge.anchor.set(0.5, 1);
        this.fxLayer.addChild(this.badge);
      }
      this.badge.texture = tex;
    } else if (this.badge) {
      this.fxLayer.removeChild(this.badge);
      this.badge.destroy();
      this.badge = null;
    }
  }

  get total() {
    return this.count;
  }

  private target(b: Bot) {
    b.tx = this.area.x + this.rand() * this.area.w;
    b.ty = this.area.y + this.rand() * this.area.h;
  }

  private spawn(animate: boolean) {
    const s = new Sprite(botTextures(this.agent)[0]!);
    s.anchor.set(0.5, 1);
    s.label = "actor";
    const b: Bot = {
      sprite: s,
      x: this.origin.x + (this.rand() - 0.5) * 12,
      y: this.origin.y + 6,
      tx: 0,
      ty: 0,
      wait: animate ? 0.4 : 0,
      phase: this.rand() * 10,
      errand: null,
    };
    if (!animate) {
      b.x = this.area.x + this.rand() * this.area.w;
      b.y = this.area.y + this.rand() * this.area.h;
    }
    this.target(b);
    this.objects.addChild(s);
    this.bots.push(b);
    if (animate) this.effects.puff(b.x, b.y - 5);
    this.place(b);
  }

  private dropCarry(b: Bot) {
    if (!b.errand) return;
    this.objects.removeChild(b.errand.carry);
    b.errand.carry.destroy();
    b.errand = null;
  }

  private despawn(animate: boolean) {
    // prefer a helper that is home (not out on an errand)
    let i = this.bots.length - 1;
    for (let k = this.bots.length - 1; k >= 0; k--) {
      if (!this.bots[k]!.errand) {
        i = k;
        break;
      }
    }
    const [b] = this.bots.splice(i, 1);
    if (!b) return;
    this.dropCarry(b);
    if (!animate) {
      this.objects.removeChild(b.sprite);
      b.sprite.destroy();
      return;
    }
    // finished: maybe the cat pounces, else hop back into the parent's monitor
    if (this.world?.catEats(b.sprite, b.x, b.y)) return;
    this.leaving.push({ sprite: b.sprite, x0: b.x, y0: b.y, t: 0 });
  }

  private place(b: Bot) {
    b.sprite.position.set(Math.round(b.x), Math.round(b.y));
    b.sprite.zIndex = b.y;
    if (b.errand) {
      b.errand.carry.position.set(Math.round(b.x - 4), Math.round(b.y - 16));
      b.errand.carry.zIndex = b.y + 0.1;
    }
  }

  private startErrand(b: Bot) {
    const path = this.world?.errand({ x: b.x, y: b.y }, this.rand);
    if (!path || path.length === 0) return false;
    const carry = new Sprite(carryTextures()[this.rand() < 0.6 ? 0 : 1]!);
    carry.label = "actor";
    this.objects.addChild(carry);
    b.errand = { path, back: false, carry, pause: 0.8, home: { x: b.x, y: b.y } };
    return true;
  }

  private errandStep(b: Bot, dt: number) {
    const e = b.errand!;
    if (e.path.length === 0) {
      if (e.pause > 0) {
        e.pause -= dt;
        return false;
      }
      if (e.back) {
        this.dropCarry(b);
        b.wait = 0.4;
        this.target(b);
        return false;
      }
      // dropped it off, picked something up for the way back
      e.back = true;
      e.carry.texture = carryTextures()[e.carry.texture === carryTextures()[0] ? 1 : 0]!;
      e.path = this.world?.pathTo({ x: b.x, y: b.y }, e.home) ?? [e.home];
      e.pause = 0;
      return false;
    }
    let budget = 30 * dt;
    while (budget > 0 && e.path.length) {
      const wp = e.path[0]!;
      const dx = wp.x - b.x;
      const dy = wp.y - b.y;
      const d = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.3) b.sprite.scale.x = dx < 0 ? -1 : 1;
      if (d <= budget) {
        b.x = wp.x;
        b.y = wp.y;
        budget -= d;
        e.path.shift();
        if (e.path.length === 0) e.pause = 0.9;
      } else {
        b.x += (dx / d) * budget;
        b.y += (dy / d) * budget;
        budget = 0;
      }
    }
    return true;
  }

  update(dt: number, time: number) {
    const frames = botTextures(this.agent);
    let maxX = -1;
    let at = { x: 0, y: 0 };
    const busy = this.bots.filter((b) => b.errand).length;
    for (const [i, b] of this.bots.entries()) {
      let moving = false;
      if (this.escort) {
        this.dropCarry(b);
        const tx = this.escort.x + (i - (this.bots.length - 1) / 2) * 5;
        const ty = this.escort.y + 1 + (i % 2);
        const dx = tx - b.x;
        const dy = ty - b.y;
        const d = Math.hypot(dx, dy);
        const step = 90 * dt;
        if (d <= step) {
          b.x = tx;
          b.y = ty;
        } else {
          b.x += (dx / d) * step;
          b.y += (dy / d) * step;
        }
        if (Math.abs(dx) > 0.3) b.sprite.scale.x = dx < 0 ? -1 : 1;
        b.wait = 0.5;
        moving = true;
      } else if (b.errand) {
        moving = this.errandStep(b, dt);
      } else if (b.wait > 0) {
        b.wait -= dt;
        if (
          b.wait <= 0 &&
          this.world &&
          busy < 2 &&
          this.rand() < 1.2 / this.errandEvery &&
          this.startErrand(b)
        ) {
          moving = true;
        }
      } else {
        const dx = b.tx - b.x;
        const dy = b.ty - b.y;
        const d = Math.hypot(dx, dy);
        const step = 34 * dt;
        if (d <= step) {
          b.x = b.tx;
          b.y = b.ty;
          b.wait = 0.3 + this.rand() * 1.4;
          this.target(b);
        } else {
          b.x += (dx / d) * step;
          b.y += (dy / d) * step;
        }
        b.sprite.scale.x = dx < 0 ? -1 : 1;
        moving = true;
      }
      b.sprite.texture = frames[moving ? Math.floor(time * 8 + b.phase) % 2 : 0]!;
      this.place(b);
      if (!b.errand && b.x > maxX) {
        maxX = b.x;
        at = { x: b.x, y: b.y };
      }
    }
    if (this.badge) this.badge.position.set(Math.round(at.x + 8), Math.round(at.y - 9));
    // finished helpers: a hop up into the parent's monitor, shrinking, then a sparkle
    const mon = { x: this.origin.x, y: this.origin.y - 30 };
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const l = this.leaving[i]!;
      l.t += dt;
      const k = Math.min(1, l.t / 0.75);
      const x = l.x0 + (mon.x - l.x0) * k;
      const y = l.y0 + (mon.y - l.y0) * k - Math.sin(k * Math.PI) * 16;
      l.sprite.position.set(Math.round(x), Math.round(y));
      l.sprite.zIndex = Math.max(y, this.origin.y - 1);
      l.sprite.scale.set(1 - 0.6 * k);
      l.sprite.texture = frames[1]!;
      if (k >= 1) {
        this.effects.sparkle(mon.x, mon.y - 4);
        this.objects.removeChild(l.sprite);
        l.sprite.destroy();
        this.leaving.splice(i, 1);
      }
    }
  }

  destroy(animate: boolean) {
    for (const b of this.bots) {
      this.dropCarry(b);
      if (animate) this.effects.puff(b.x, b.y - 5);
      this.objects.removeChild(b.sprite);
      b.sprite.destroy();
    }
    this.bots = [];
    for (const l of this.leaving) {
      this.objects.removeChild(l.sprite);
      l.sprite.destroy();
    }
    this.leaving = [];
    if (this.badge) {
      this.fxLayer.removeChild(this.badge);
      this.badge.destroy();
      this.badge = null;
    }
  }
}
