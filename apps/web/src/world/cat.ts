/**
 * The office cat: naps next to someone idle (zzz), is the waiting alarm (walks over and sits
 * next to anyone waiting for 5+ minutes), meows and purrs hearts when clicked, and now and
 * then pounces on a finished helper bot (crunch).
 */
import { seededRandom } from "@agent-office/protocol";
import { type Container, Sprite } from "pixi.js";
import { tieTexture } from "../art/chaos.ts";
import { heartTexture, textBubbleTexture } from "../art/fun.ts";
import { CAT, catTextures, zzzTextures } from "../art/fx.ts";
import { C } from "../art/palette.ts";
import type { Effects } from "./effects.ts";
import { type OfficeMap, type Point, TILE } from "./map.ts";
import { findPath } from "./pathing.ts";

export type WaitSpot = Point & { id: string };

export class OfficeCat {
  readonly sprite: Sprite;
  private zzz: Sprite;
  x: number;
  y: number;
  private path: Point[] = [];
  private mode: "sleep" | "sit" | "walk" | "pounce" | "smug" = "sleep";
  private timer = 6;
  private dir = 1;
  private rand = seededRandom("cat");
  /** whose side the cat sits at as the waiting alarm */
  private guarding: string | null = null;
  private heading: string | null = null;
  private prey: { sprite: Sprite; x: number; y: number } | null = null;
  private meowCooldown = 0;
  private tie: Sprite;
  /** Friday meeting: where the boss sits (null = an ordinary cat) */
  private boss: Point | null = null;
  private bossTalk = 3;
  /** chance a finished helper nearby gets eaten */
  eatChance = 0.25;
  /** how far (px) the cat will dash for a finished helper */
  eatRange = 220;

  constructor(
    objects: Container,
    fx: Container,
    private map: OfficeMap,
    private readonly idleSpots: () => Point[],
    private readonly effects: Effects,
    private readonly waitSpots: () => WaitSpot[] = () => [],
  ) {
    this.sprite = new Sprite(catTextures()[0]!);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.label = "actor";
    this.zzz = new Sprite(zzzTextures()[0]!);
    this.zzz.anchor.set(0, 1);
    this.tie = new Sprite(tieTexture());
    this.tie.anchor.set(0.5, 0);
    this.tie.visible = false;
    objects.addChild(this.sprite);
    fx.addChild(this.zzz, this.tie);
    const home = this.home();
    this.x = home.x;
    this.y = home.y;
  }

  setMap(map: OfficeMap) {
    this.map = map;
  }

  /** The cat is the boss now (wears a tie, sits at the head of the table), or not anymore. */
  setBoss(spot: Point | null) {
    if (
      spot === this.boss ||
      (spot && this.boss && spot.x === this.boss.x && spot.y === this.boss.y)
    )
      return;
    this.boss = spot;
    this.guarding = null;
    this.heading = null;
    if (!spot) {
      this.effects.floater(textBubbleTexture("MEETING OVER."), this.x, this.y - 14, 2.5, 8);
      this.mode = "sit";
      this.timer = 3;
      return;
    }
    this.prey = null;
    this.bossTalk = 2;
    if (!this.goTo(spot)) {
      this.x = spot.x;
      this.y = spot.y;
      this.mode = "sit";
    }
    this.timer = 9999;
  }

  private home(): Point {
    return { x: 45 * TILE + 4, y: 8 * TILE + 12 };
  }

  private goTo(target: Point) {
    const from = { x: Math.floor(this.x / TILE), y: Math.floor((this.y - 2) / TILE) };
    const to = { x: Math.floor(target.x / TILE), y: Math.floor(target.y / TILE) };
    const tiles = findPath(this.map, from, to);
    if (!tiles) return false;
    this.path = tiles.slice(1).map((t) => ({ x: t.x * TILE + 8, y: t.y * TILE + 12 }));
    this.path.push(target);
    this.mode = "walk";
    return true;
  }

  private walkable(p: Point) {
    return this.map.isWalkable(Math.floor(p.x / TILE), Math.floor(p.y / TILE));
  }

  /** A spot right next to someone (beside the chair, else in front of it). */
  private beside(s: Point): Point | null {
    for (const c of [
      { x: s.x + 14, y: s.y + 6 },
      { x: s.x - 14, y: s.y + 6 },
      { x: s.x, y: s.y + 12 },
      { x: s.x + 8, y: s.y + 16 },
    ]) {
      if (this.walkable(c)) return c;
    }
    return null;
  }

  private pickTarget() {
    if (this.boss) {
      if (Math.hypot(this.x - this.boss.x, this.y - this.boss.y) > 2 && this.goTo(this.boss))
        return;
      this.mode = "sit";
      this.timer = 9999;
      return;
    }
    // waiting alarm first: whoever waits the longest gets company
    const waiting = this.waitSpots();
    if (waiting.length > 0) {
      const w = waiting[0]!;
      const spot = this.beside(w);
      if (spot && this.goTo(spot)) {
        this.heading = w.id;
        return;
      }
    }
    this.heading = null;
    const spots = this.idleSpots();
    let target = this.home();
    if (spots.length > 0 && this.rand() < 0.8) {
      const s = spots[Math.floor(this.rand() * spots.length)]!;
      target = this.beside(s) ?? this.home();
    }
    if (!this.goTo(target)) this.timer = 5;
  }

  /** Clicked: "mrrp?" and a few purr hearts. */
  meow() {
    if (this.meowCooldown > 0) return;
    this.meowCooldown = 1.2;
    const lines = ["MRRP?", "MEOW!", "PRRR", "MRRRP"];
    const text = lines[Math.floor(this.rand() * lines.length)]!;
    this.effects.floater(textBubbleTexture(text, C.plum), this.x + 6, this.y - 14, 2.2, 6);
    for (let i = 0; i < 3; i++) {
      this.effects.after(0.25 + i * 0.35, () =>
        this.effects.floater(heartTexture(), this.x - 4 + i * 4, this.y - 10, 1.6, 18, 2),
      );
    }
    if (this.mode === "sleep") {
      this.mode = "sit";
      this.timer = 6;
    }
  }

  hit(wx: number, wy: number) {
    return Math.abs(wx - this.x) <= 10 && wy >= this.y - 14 && wy <= this.y + 3;
  }

  /** A finished helper bot at (x, y): pounce on it (true = the cat owns the sprite now). */
  tryEat(sprite: Sprite, x: number, y: number): boolean {
    if (this.prey || this.guarding || this.heading || this.boss) return false;
    if (Math.hypot(x - this.x, y - this.y) > this.eatRange) return false;
    if (this.rand() >= this.eatChance) return false;
    this.prey = { sprite, x, y };
    this.mode = "pounce";
    this.path = [];
    this.timer = 0;
    return true;
  }

  get busyWithPrey() {
    return this.prey !== null;
  }

  private stepPath(dt: number, speed: number) {
    let budget = speed * dt;
    while (budget > 0 && this.path.length) {
      const wp = this.path[0]!;
      const dx = wp.x - this.x;
      const dy = wp.y - this.y;
      const d = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.5) this.dir = dx < 0 ? -1 : 1;
      if (d <= budget) {
        this.x = wp.x;
        this.y = wp.y;
        budget -= d;
        this.path.shift();
      } else {
        this.x += (dx / d) * budget;
        this.y += (dy / d) * budget;
        budget = 0;
      }
    }
  }

  update(dt: number, time: number) {
    const frames = catTextures();
    this.meowCooldown -= dt;
    let hopY = 0;
    if (this.mode === "pounce" && this.prey) {
      // the bot freezes and trembles; the cat leaps straight at it
      const p = this.prey;
      p.sprite.x = Math.round(p.x + Math.sin(time * 60) * 1);
      const dx = p.x - this.x;
      const dy = p.y + 1 - this.y;
      const d = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.5) this.dir = dx < 0 ? -1 : 1;
      const step = (d > 120 ? 220 : 120) * dt;
      hopY = d < 30 ? -Math.sin(Math.min(1, d / 30) * Math.PI) * 6 : 0;
      if (d <= step) {
        this.x = p.x;
        this.y = p.y + 1;
        p.sprite.parent?.removeChild(p.sprite);
        p.sprite.destroy();
        this.prey = null;
        this.effects.floater(textBubbleTexture("CRUNCH!", C.red), this.x, this.y - 12, 1.8, 8);
        this.effects.burst(this.x, this.y - 4, [C.silver, C.grey, C.slate, C.amber], {
          count: 10,
          speed: 40,
          life: 2.5,
          floor: this.y + 2,
        });
        this.mode = "smug";
        this.timer = 4;
      } else {
        this.x += (dx / d) * step;
        this.y += (dy / d) * step;
      }
      const walk = this.dir < 0 ? CAT.walkLeft : CAT.walkRight;
      this.sprite.texture = frames[walk[Math.floor(time * 12) % 2]!]!;
    } else if (this.mode === "walk") {
      this.stepPath(dt, this.heading ? 40 : 26);
      const walk = this.dir < 0 ? CAT.walkLeft : CAT.walkRight;
      this.sprite.texture = frames[walk[Math.floor(time * 6) % 2]!]!;
      if (this.path.length === 0) {
        if (this.boss) {
          this.mode = "sit";
          this.timer = 9999;
        } else if (this.heading) {
          this.guarding = this.heading;
          this.heading = null;
          this.mode = "sit";
          this.timer = 2;
        } else {
          this.mode = this.rand() < 0.3 ? "sit" : "sleep";
          this.timer = this.mode === "sit" ? 5 + this.rand() * 5 : 18 + this.rand() * 25;
        }
      }
    } else {
      const set = this.mode === "sleep" ? CAT.sleep : CAT.sit;
      const fps = this.mode === "sleep" ? 0.8 : this.mode === "smug" ? 2 : 0.5;
      this.sprite.texture = frames[set[Math.floor(time * fps) % 2]!]!;
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.guarding) {
          // keep sitting by them as long as they still wait
          const still = this.waitSpots().some((w) => w.id === this.guarding);
          if (still) this.timer = 2;
          else {
            this.guarding = null;
            this.pickTarget();
          }
        } else if (this.mode === "sit" && this.rand() < 0.5) {
          this.mode = "sleep";
          this.timer = 20;
        } else this.pickTarget();
      } else if (!this.guarding && this.mode !== "smug" && this.timer > 3) {
        // someone started waiting for long while the cat naps: go now
        if (Math.floor(time) !== Math.floor(time - dt) && this.waitSpots().length > 0)
          this.timer = 0.01;
      }
      if (this.mode === "smug" && this.timer <= 0) this.mode = "sit";
    }
    this.sprite.scale.x =
      this.mode === "walk" || this.mode === "pounce" ? 1 : this.dir < 0 ? 1 : -1;
    this.sprite.position.set(Math.round(this.x), Math.round(this.y + hopY));
    this.sprite.zIndex = this.y - 1;
    this.tie.visible = this.boss !== null;
    if (this.tie.visible) {
      this.tie.position.set(
        Math.round(this.x + (this.mode === "walk" ? this.dir * 3 : 0)),
        Math.round(this.y - 7),
      );
      if (this.mode === "sit") {
        this.bossTalk -= dt;
        if (this.bossTalk <= 0) {
          this.bossTalk = 18 + this.rand() * 12;
          const lines = [
            "MEETING. NOW.",
            "WHO ATE MY BOT?",
            "AGENDA: ME.",
            "NO HUMANS ON THE SOFA.",
          ];
          const text = lines[Math.floor(this.rand() * lines.length)]!;
          this.effects.floater(textBubbleTexture(text, C.plum), this.x + 6, this.y - 14, 3, 8);
        }
      }
    }
    this.zzz.visible = this.mode === "sleep";
    this.zzz.texture = zzzTextures()[Math.floor(time * 1.5) % 3]!;
    this.zzz.position.set(Math.round(this.x + 4), Math.round(this.y - 12));
  }
}
