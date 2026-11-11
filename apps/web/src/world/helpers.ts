/**
 * Subagent helpers: one tiny bot (or kitten, the person's `helpers` skin) per live subagent.
 * They pop out with a puff near the parent's desk, one after another in a burst, scurry
 * around the pod's aisle (the area grows with the swarm) and now and then run an errand
 * (carry a paper or a box to the printer, the server rack or the bookshelf and back). Only
 * beyond MAX_BOTS a "+N" badge stands in for the rest. When a helper finishes it hops into the
 * parent's monitor with a sparkle (or the office cat gets a bot; it leaves kittens alone).
 */
import type { AgentKind, HelperSkin } from "@agent-office/protocol";
import { type Container, Sprite, type Texture } from "pixi.js";
import { carryTextures } from "../art/fun.ts";
import { badgeTexture, botTextures, CAT_COATS, kittenTextures } from "../art/fx.ts";
import type { Effects } from "./effects.ts";
import { burstGap, errandSlots, escortSpot, type Rect, visibleHelpers } from "./helperRules.ts";

type Pt = { x: number; y: number };
type Bot = {
  sprite: Sprite;
  /** two walk frames (robot, or a kitten in its own coat) */
  frames: Texture[];
  x: number;
  y: number;
  tx: number;
  ty: number;
  wait: number;
  phase: number;
  /** errand: path to walk, what it carries, and whether it is on the way back */
  errand: { path: Pt[]; back: boolean; carry: Sprite; pause: number; home: Pt } | null;
};
type Leaving = { sprite: Sprite; frames: Texture[]; x0: number; y0: number; t: number };

export type { Rect };
/** The roaming area for a swarm of `count` helpers. */
export type AreaFor = (count: number) => Rect;

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
  /** helpers still to pop out (a burst puffs them out one by one) */
  private queued = 0;
  private queueT = 0;
  private area: Rect;
  /** seconds a helper spends at least between errands */
  errandEvery = 25;
  /** while set, every helper drops its errand and crowds under this point (carrying someone) */
  escort: Pt | null = null;

  constructor(
    private readonly objects: Container,
    private readonly fxLayer: Container,
    private readonly effects: Effects,
    private readonly agent: AgentKind,
    private areaFor: AreaFor,
    private origin: { x: number; y: number },
    private readonly rand: () => number,
    private readonly world: HelperWorld | null = null,
    private skin: HelperSkin = "robots",
  ) {
    this.area = areaFor(0);
  }

  setArea(areaFor: AreaFor, origin: { x: number; y: number }) {
    this.areaFor = areaFor;
    this.origin = origin;
    this.area = areaFor(this.count);
  }

  /** Robots <-> kittens: every helper turns into the other kind with a puff. */
  setSkin(skin: HelperSkin, animate: boolean) {
    if (skin === this.skin) return;
    this.skin = skin;
    for (const b of this.bots) {
      b.frames = this.pickFrames();
      b.sprite.texture = b.frames[0]!;
      if (animate) this.effects.puff(b.x, b.y - 5);
    }
  }

  private pickFrames(): Texture[] {
    if (this.skin === "cats") {
      const coat = CAT_COATS[Math.floor(this.rand() * CAT_COATS.length)] ?? CAT_COATS[0]!;
      return kittenTextures(this.agent, coat);
    }
    return botTextures(this.agent);
  }

  set(count: number, animate: boolean) {
    this.count = count;
    this.area = this.areaFor(count);
    const { shown: want, extra } = visibleHelpers(count);
    if (!animate) {
      this.queued = 0;
      while (this.bots.length < want) this.spawn(false);
    } else if (this.bots.length + this.queued < want) {
      if (this.queued === 0) this.queueT = 0;
      this.queued = want - this.bots.length;
    }
    // fewer helpers: first drop ones that haven't popped out yet, then finish visible ones
    if (this.bots.length + this.queued > want) {
      this.queued = Math.max(0, want - this.bots.length);
    }
    while (this.bots.length > want) this.despawn(animate);
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
    const frames = this.pickFrames();
    const s = new Sprite(frames[0]!);
    s.anchor.set(0.5, 1);
    s.label = "actor";
    const b: Bot = {
      sprite: s,
      frames,
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
    // finished: maybe the cat pounces on a bot, else hop back into the parent's monitor
    if (this.skin === "robots" && this.world?.catEats(b.sprite, b.x, b.y)) return;
    this.leaving.push({ sprite: b.sprite, frames: b.frames, x0: b.x, y0: b.y, t: 0 });
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
    // a burst: pop the queued helpers out one after another (faster the more are waiting)
    if (this.queued > 0) {
      this.queueT -= dt;
      while (this.queued > 0 && this.queueT <= 0) {
        this.spawn(true);
        this.queued--;
        this.queueT += burstGap(this.queued, this.rand());
      }
    }
    let maxX = -1;
    let at = { x: 0, y: 0 };
    let busy = this.bots.filter((b) => b.errand).length;
    const slots = errandSlots(this.bots.length);
    for (const [i, b] of this.bots.entries()) {
      let moving = false;
      if (this.escort) {
        this.dropCarry(b);
        const { x: tx, y: ty } = escortSpot(this.escort, i, this.bots.length);
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
          busy < slots &&
          this.rand() < 1.2 / this.errandEvery &&
          this.startErrand(b)
        ) {
          busy++;
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
      b.sprite.texture = b.frames[moving ? Math.floor(time * 8 + b.phase) % 2 : 0]!;
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
      l.sprite.texture = l.frames[1]!;
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
    this.queued = 0;
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
