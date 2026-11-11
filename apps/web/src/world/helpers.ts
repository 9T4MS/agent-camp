/**
 * Subagent helpers: tiny bots that pop out with a puff near the parent's desk, scurry
 * around the pod's aisle and vanish on finish. Max 5 visible, plus a "+N" badge.
 */
import type { AgentKind } from "@agent-office/protocol";
import { type Container, Sprite } from "pixi.js";
import { badgeTexture, botTextures } from "../art/fx.ts";
import type { Effects } from "./effects.ts";

const MAX_VISIBLE = 5;
type Bot = {
  sprite: Sprite;
  x: number;
  y: number;
  tx: number;
  ty: number;
  wait: number;
  phase: number;
};
export type Rect = { x: number; y: number; w: number; h: number };

export class HelperSwarm {
  private bots: Bot[] = [];
  private badge: Sprite | null = null;
  private count = 0;

  constructor(
    private readonly objects: Container,
    private readonly fxLayer: Container,
    private readonly effects: Effects,
    private readonly agent: AgentKind,
    private area: Rect,
    private origin: { x: number; y: number },
    private readonly rand: () => number,
  ) {}

  setArea(area: Rect, origin: { x: number; y: number }) {
    this.area = area;
    this.origin = origin;
  }

  set(count: number, animate: boolean) {
    this.count = count;
    const want = Math.min(MAX_VISIBLE, count);
    while (this.bots.length < want) this.spawn(animate);
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

  private despawn(animate: boolean) {
    const b = this.bots.pop();
    if (!b) return;
    if (animate) this.effects.puff(b.x, b.y - 5);
    this.objects.removeChild(b.sprite);
    b.sprite.destroy();
  }

  private place(b: Bot) {
    b.sprite.position.set(Math.round(b.x), Math.round(b.y));
    b.sprite.zIndex = b.y;
  }

  update(dt: number, time: number) {
    const frames = botTextures(this.agent);
    let maxX = -1;
    let at = { x: 0, y: 0 };
    for (const b of this.bots) {
      if (b.wait > 0) {
        b.wait -= dt;
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
      }
      const moving = b.wait <= 0;
      b.sprite.texture = frames[moving ? Math.floor(time * 8 + b.phase) % 2 : 0]!;
      this.place(b);
      if (b.x > maxX) {
        maxX = b.x;
        at = { x: b.x, y: b.y };
      }
    }
    if (this.badge) this.badge.position.set(Math.round(at.x + 8), Math.round(at.y - 9));
  }

  destroy(animate: boolean) {
    while (this.bots.length) this.despawn(animate);
    if (this.badge) {
      this.fxLayer.removeChild(this.badge);
      this.badge.destroy();
      this.badge = null;
    }
  }
}
