/**
 * Two characters drop by the office. They stroll around (the sidekick trailing the lead), and
 * every half minute or so the lead aims his portal gun, shoots a portal open in front of them
 * and they walk through it, coming out of a second portal somewhere else in the office. While
 * they are halfway through, the part that is already through shows at the exit portal.
 */
import { seededRandom } from "@agent-office/protocol";
import { Container, Graphics, Sprite } from "pixi.js";
import { textBubbleTexture } from "../art/fun.ts";
import { C } from "../art/palette.ts";
import {
  leadSheet,
  PORTAL_R,
  portalGlowTexture,
  portalShotTexture,
  portalTexture,
  RES,
  sidekickSheet,
  TOON,
  type ToonSheet,
} from "../art/portalCharacters.ts";
import type { Effects } from "./effects.ts";
import { type Facing, type OfficeMap, type Point, TILE } from "./map.ts";
import { findPath } from "./pathing.ts";
import {
  type Dir,
  entranceFor,
  exitFor,
  freeAt,
  indoorTile,
  LINE_UP,
  PORTAL_GAP,
} from "./portalRules.ts";

const WALK = 26;
const PORTAL_WALK = 32;
/** how far the sidekick trails the lead on a stroll */
const FOLLOW = 15;
/** a toon is fully through a portal once its middle is this far past it */
const HALF = 8;
/** gun muzzle relative to the lead's feet in the aim frame (facing left) */
const MUZZLE = { x: -15, y: -20 };
/** the auto-pilot camera looks at a portal at most this often, and not in the first minutes */
const NOTIFY_EVERY_S = 180;

const LEAD_LINES = [
  "WUBBA LUBBA DUB DUB!",
  "*BURP*",
  "COME ON, KID!",
  "IN AND OUT, KID. 20 MINUTES.",
  "YOUR AGENTS ARE AMATEURS.",
  "I'M NOT A COMPILER, KID!",
  "SHIP IT, KID! *BURP*",
];
const SIDEKICK_LINES = [
  "AW GEEZ, BOSS!",
  "OH MAN, OH MAN...",
  "W-WHERE ARE WE NOW?",
  "BOSS, I DON'T LIKE THIS!",
  "IS THIS AN OFFICE?",
];
const LEAD_CLICKED = ["WHAT?! *BURP*", "HANDS OFF THE LAB COAT.", "SCIENCE, KID!"];
const SIDEKICK_CLICKED = ["H-HI!", "AW GEEZ...", "I'M JUST HERE WITH THE BOSS!"];

/** One side of a vertical line through a portal, as a world-space mask rectangle. */
function halfPlane(g: Graphics, p: Point, keep: Dir) {
  g.clear();
  g.rect(keep > 0 ? p.x : p.x - 400, p.y - 120, 400, 160).fill(0xffffff);
}

/** Going through a portal pair: `a` is the entrance (null when arriving), `b` the exit. */
type Passage = { a: Point | null; b: Point; dir: Dir; crossed: boolean };

class Toon {
  readonly sprite: Sprite;
  /** the part that is already through, shown at the exit while crossing */
  private readonly ghost: Sprite;
  private readonly before = new Graphics();
  private readonly after = new Graphics();
  x = -999;
  y = -999;
  facing: Facing = "down";
  moving = false;
  pose: "aim" | "panic" | null = null;
  passage: Passage | null = null;

  constructor(
    objects: Container,
    private readonly sheet: () => ToonSheet,
  ) {
    const s = sheet();
    const mk = () => {
      const sp = new Sprite(s.frames[0]!);
      sp.anchor.set(0.5, s.ground / s.h);
      sp.scale.set(1 / RES);
      sp.label = "actor";
      objects.addChild(sp);
      return sp;
    };
    this.sprite = mk();
    this.ghost = mk();
    this.ghost.visible = false;
    for (const g of [this.before, this.after]) {
      g.label = "actor";
      objects.addChild(g);
    }
  }

  enter(passage: Passage) {
    this.passage = passage;
    if (passage.a) halfPlane(this.before, passage.a, -passage.dir as Dir);
    halfPlane(this.after, passage.b, passage.dir);
  }

  /** Walk on through the portal; returns true once clear of the exit. */
  stepThrough(dt: number) {
    const p = this.passage;
    if (!p) return true;
    this.x += p.dir * PORTAL_WALK * dt;
    this.moving = true;
    this.facing = p.dir > 0 ? "right" : "left";
    if (!p.crossed && p.a && p.dir * (this.x - p.a.x) > HALF) {
      this.x += p.b.x - p.a.x;
      this.y = p.b.y;
      p.crossed = true;
      this.ghost.mask = null;
      this.sprite.mask = this.after;
      this.before.clear();
    }
    if (p.crossed && p.dir * (this.x - p.b.x) > HALF) {
      this.passage = null;
      return true;
    }
    return false;
  }

  walkToward(t: Point, dt: number, speed: number) {
    const dx = t.x - this.x;
    const dy = t.y - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.6) {
      this.moving = false;
      return true;
    }
    const step = Math.min(d, speed * dt);
    this.x += (dx / d) * step;
    this.y += (dy / d) * step;
    this.moving = true;
    this.face(dx, dy);
    return false;
  }

  face(dx: number, dy: number) {
    if (Math.abs(dx) > Math.abs(dy) * 0.8) this.facing = dx < 0 ? "left" : "right";
    else if (Math.abs(dy) > 0.3) this.facing = dy < 0 ? "up" : "down";
  }

  hit(wx: number, wy: number, h: number) {
    return Math.abs(wx - this.x) <= 6 && wy >= this.y - h && wy <= this.y + 2;
  }

  draw(time: number) {
    const s = this.sheet();
    const side = this.facing === "left" || this.facing === "right";
    let set: readonly number[];
    let fps = 7;
    if (this.pose === "aim") set = TOON.aim;
    else if (this.pose === "panic") set = TOON.panic;
    else if (this.moving)
      set = side ? TOON.walkSide : this.facing === "up" ? TOON.walkUp : TOON.walkDown;
    else {
      set = side ? TOON.standSide : this.facing === "up" ? [TOON.walkUp[1]] : TOON.idle;
      fps = 3;
    }
    const tex = s.frames[set[Math.floor(time * fps) % set.length]!]!;
    const sx = (this.facing === "right" ? -1 : 1) / RES;
    const p = this.passage;
    for (const sp of [this.sprite, this.ghost]) {
      sp.texture = tex;
      sp.scale.set(sx, 1 / RES);
    }
    this.sprite.position.set(this.x, this.y);
    this.sprite.zIndex = this.y;
    if (!p) {
      if (this.sprite.mask) {
        this.sprite.mask = null;
        this.ghost.mask = null;
        // an unused mask would render as a plain white rectangle
        this.before.clear();
        this.after.clear();
      }
      this.ghost.visible = false;
    } else if (!p.crossed && p.a) {
      this.sprite.mask = this.before;
      this.ghost.mask = this.after;
      this.ghost.visible = true;
      this.ghost.position.set(this.x + p.b.x - p.a.x, p.b.y);
      this.ghost.zIndex = p.b.y;
    } else {
      this.sprite.mask = this.after;
      this.ghost.mask = null;
      this.ghost.visible = false;
    }
  }
}

const easeOutBack = (t: number) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;

/** An upright swirling green oval standing on the floor at (x, y). */
class Portal {
  private readonly root: Container;
  private readonly oval: Container;
  private readonly disc: Sprite;
  private readonly glow: Sprite;
  /** 0 = shut, 1 = fully open */
  private p = 0;
  private opening = true;

  constructor(
    objects: Container,
    readonly x: number,
    readonly y: number,
  ) {
    this.root = new Container();
    this.oval = new Container();
    this.root.label = "actor";
    this.root.position.set(x, y);
    // just behind whoever stands on the same row, so they walk "into" it
    this.root.zIndex = y - 0.5;
    this.glow = new Sprite(portalGlowTexture());
    this.glow.anchor.set(0.5);
    this.glow.blendMode = "add";
    this.oval.position.set(0, -PORTAL_R - 1);
    this.disc = new Sprite(portalTexture());
    this.disc.anchor.set(0.5);
    this.disc.scale.set(1 / RES);
    this.oval.addChild(this.disc);
    this.root.addChild(this.glow, this.oval);
    objects.addChild(this.root);
    this.apply();
  }

  close() {
    this.opening = false;
  }

  get open() {
    return this.opening && this.p >= 1;
  }

  get gone() {
    return !this.opening && this.p <= 0;
  }

  private apply() {
    const s = this.opening ? easeOutBack(this.p) : this.p * this.p;
    this.oval.scale.set(0.5 * s, s);
    this.oval.visible = s > 0.01;
    this.glow.alpha = Math.min(1, this.p * 1.4);
    this.glow.scale.set((0.6 + 0.4 * s) / RES);
  }

  update(dt: number) {
    this.p = Math.max(0, Math.min(1, this.p + (this.opening ? dt / 0.4 : -dt / 0.3)));
    this.disc.rotation -= dt * 5;
    this.glow.alpha *= 0.85 + 0.15 * Math.sin(this.disc.rotation * 3);
    this.apply();
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}

type Shot = { sprite: Sprite; from: Point; to: Point; t: number; onHit: () => void };

type Hop = {
  dir: Dir;
  a: Point;
  b: Point;
  t: number;
  shot: boolean;
  entrance: Portal | null;
  exit: Portal | null;
  /** lead / sidekick have started walking through */
  leadGo: boolean;
  sidekickGo: boolean;
  leadDone: boolean;
  sidekickDone: boolean;
};

type Arrival = {
  b: Point;
  dir: Dir;
  portal: Portal;
  t: number;
  leadDone: boolean;
  sidekickDone: boolean;
};

export class PortalDuo {
  private readonly lead: Toon;
  private readonly sidekick: Toon;
  private rand = seededRandom("portal-characters");
  private mode: "away" | "arrive" | "stand" | "walk" | "hop" = "away";
  private path: Point[] = [];
  private trail: Point[] = [];
  private timer = 3;
  private hopIn = 12;
  private hop: Hop | null = null;
  private arrival: Arrival | null = null;
  private portals: Portal[] = [];
  private shots: Shot[] = [];
  private talkCooldown = 0;
  /** 0, not -Infinity: no camera visit in the first minutes after a (kiosk) reload */
  private lastNotify = 0;
  private clock = 0;
  /** mean seconds between portal hops (shorter in the party demo) */
  hopEvery = 30;
  /**
   * A portal opened at (x, y): the auto-pilot camera may come and look (rate-limited here; the
   * camera itself lets real agent events win). Returns whether the camera came.
   */
  onPortal: (x: number, y: number) => boolean = () => false;

  constructor(
    private readonly objects: Container,
    private readonly fx: Container,
    private map: OfficeMap,
    private readonly effects: Effects,
  ) {
    this.lead = new Toon(objects, leadSheet);
    this.sidekick = new Toon(objects, sidekickSheet);
  }

  setMap(map: OfficeMap) {
    this.map = map;
    if (this.mode === "walk") {
      this.path = [];
      this.mode = "stand";
      this.timer = 1;
    }
  }

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.rand() * list.length)]!;
  }

  private say(who: Toon, text: string) {
    const color = who === this.lead ? C.forest : C.navy;
    const h = who === this.lead ? 38 : 30;
    this.effects.floater(textBubbleTexture(text, color), who.x, who.y - h, 2.8, 8);
  }

  /** Offer the auto-pilot camera a look; it only counts when the camera came. */
  private notify(x: number, y: number) {
    if (this.clock - this.lastNotify < NOTIFY_EVERY_S) return;
    if (this.onPortal(x, y)) this.lastNotify = this.clock;
  }

  // ---- arriving -----------------------------------------------------------------------------

  private arrive() {
    const dir: Dir = this.rand() < 0.5 ? 1 : -1;
    const b = exitFor(this.map, null, dir, this.rand);
    if (!b) {
      this.timer = 10;
      return;
    }
    this.mode = "arrive";
    const portal = new Portal(this.objects, b.x, b.y);
    this.portals.push(portal);
    this.arrival = { b, dir, portal, t: 0, leadDone: false, sidekickDone: false };
    for (const [toon, back] of [
      [this.lead, HALF],
      [this.sidekick, HALF + LINE_UP + 4],
    ] as const) {
      toon.x = b.x - dir * back;
      toon.y = b.y;
      toon.pose = null;
      toon.enter({ a: null, b, dir, crossed: true });
    }
    this.notify(b.x, b.y - 16);
  }

  private stepArrival(dt: number) {
    const a = this.arrival!;
    a.t += dt;
    if (a.t < 0.5) return;
    if (!a.leadDone) a.leadDone = this.lead.stepThrough(dt);
    else this.lead.moving = false;
    if (!a.sidekickDone) a.sidekickDone = this.sidekick.stepThrough(dt);
    else this.sidekick.moving = false;
    if (a.leadDone && !a.sidekickDone && a.t > 0.5 && this.talkCooldown <= 0) {
      this.say(this.lead, this.pick(["*BURP*", "WE'RE HERE, KID.", "WUBBA LUBBA DUB DUB!"]));
      this.talkCooldown = 3;
    }
    if (a.leadDone && a.sidekickDone) {
      a.portal.close();
      this.arrival = null;
      this.settle(2);
      if (this.rand() < 0.5)
        this.effects.after(0.6, () => this.say(this.sidekick, this.pick(SIDEKICK_LINES)));
    }
  }

  // ---- strolling ----------------------------------------------------------------------------

  private settle(seconds: number) {
    this.mode = "stand";
    this.timer = seconds;
    this.lead.moving = false;
    this.lead.pose = null;
    this.sidekick.pose = null;
    this.trail = [
      { x: this.sidekick.x, y: this.sidekick.y },
      { x: this.lead.x, y: this.lead.y },
    ];
  }

  private stroll() {
    const cx = Math.floor(this.lead.x / TILE);
    const cy = Math.floor((this.lead.y - 2) / TILE);
    for (let tries = 0; tries < 20; tries++) {
      const tx = cx + Math.floor(this.rand() * 17) - 8;
      const ty = cy + Math.floor(this.rand() * 11) - 5;
      // stay inside the office building (no garden, street or east block)
      if (!indoorTile(this.map, tx, ty) || (tx === cx && ty === cy)) continue;
      const tiles = findPath(this.map, { x: cx, y: cy }, { x: tx, y: ty });
      if (!tiles || tiles.length > 24) continue;
      this.path = tiles.slice(1).map((t) => ({ x: t.x * TILE + 8, y: t.y * TILE + 12 }));
      this.mode = "walk";
      return;
    }
    this.timer = 3;
  }

  /** The sidekick walks the lead's trail, FOLLOW px behind him. */
  private follow(dt: number) {
    const last = this.trail[this.trail.length - 1];
    if (!last || Math.hypot(last.x - this.lead.x, last.y - this.lead.y) >= 1)
      this.trail.push({ x: this.lead.x, y: this.lead.y });
    if (this.trail.length > 80) this.trail.splice(0, this.trail.length - 80);
    let need = FOLLOW;
    let target = this.trail[0]!;
    for (let i = this.trail.length - 1; i > 0; i--) {
      const p = this.trail[i]!;
      const q = this.trail[i - 1]!;
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d >= need) {
        const k = need / d;
        target = { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
        break;
      }
      need -= d;
    }
    const near =
      Math.hypot(this.sidekick.x - this.lead.x, this.sidekick.y - this.lead.y) < FOLLOW - 2;
    if (near || this.sidekick.walkToward(target, dt, WALK * 1.2)) {
      this.sidekick.moving = false;
      this.sidekick.face(this.lead.x - this.sidekick.x, this.lead.y - this.sidekick.y);
    }
  }

  private stepWalk(dt: number) {
    let budget = WALK * dt;
    while (budget > 0 && this.path.length) {
      const wp = this.path[0]!;
      const dx = wp.x - this.lead.x;
      const dy = wp.y - this.lead.y;
      const d = Math.hypot(dx, dy);
      this.lead.face(dx, dy);
      if (d <= budget) {
        this.lead.x = wp.x;
        this.lead.y = wp.y;
        budget -= d;
        this.path.shift();
      } else {
        this.lead.x += (dx / d) * budget;
        this.lead.y += (dy / d) * budget;
        budget = 0;
      }
    }
    this.lead.moving = true;
    if (!this.path.length) this.settle(3 + this.rand() * 6);
  }

  // ---- portal hops --------------------------------------------------------------------------

  private startHop() {
    const first: Dir =
      this.lead.facing === "left"
        ? -1
        : this.lead.facing === "right"
          ? 1
          : this.rand() < 0.5
            ? 1
            : -1;
    for (const dir of [first, -first as Dir]) {
      const a = entranceFor(this.map, this.lead, dir);
      if (!a) continue;
      const b = exitFor(this.map, a, dir, this.rand);
      if (!b) continue;
      this.hop = {
        dir,
        a,
        b,
        t: 0,
        shot: false,
        entrance: null,
        exit: null,
        leadGo: false,
        sidekickGo: false,
        leadDone: false,
        sidekickDone: false,
      };
      this.mode = "hop";
      this.lead.facing = dir > 0 ? "right" : "left";
      this.lead.moving = false;
      this.lead.pose = "aim";
      return true;
    }
    return false;
  }

  private stepHop(dt: number) {
    const h = this.hop!;
    const { lead, sidekick } = this;
    h.t += dt;
    const lineUp = { x: h.a.x - h.dir * (LINE_UP + PORTAL_GAP), y: h.a.y };
    if (!h.leadGo) {
      // the sidekick gets in line behind the lead while he aims
      if (sidekick.walkToward(lineUp, dt, WALK * 1.4)) sidekick.facing = lead.facing;
    }
    if (!h.shot && h.t >= 0.7) {
      h.shot = true;
      const from = { x: lead.x + h.dir * -MUZZLE.x, y: lead.y + MUZZLE.y };
      const to = { x: h.a.x, y: h.a.y - PORTAL_R - 1 };
      const sprite = new Sprite(portalShotTexture());
      sprite.anchor.set(0.5);
      sprite.scale.set(1 / RES);
      sprite.blendMode = "add";
      this.fx.addChild(sprite);
      this.shots.push({
        sprite,
        from,
        to,
        t: 0,
        onHit: () => {
          h.entrance = new Portal(this.objects, h.a.x, h.a.y);
          this.portals.push(h.entrance);
          if (this.rand() < 0.6) this.say(lead, this.pick(LEAD_LINES));
          sidekick.pose = sidekick.moving ? null : "aim";
          this.effects.after(0.35, () => {
            h.exit = new Portal(this.objects, h.b.x, h.b.y);
            this.portals.push(h.exit);
            this.notify(h.b.x, h.b.y - 16);
          });
        },
      });
    }
    if (!h.leadGo && h.entrance?.open && h.exit?.open && h.t > 1.6) {
      h.leadGo = true;
      lead.pose = null;
      lead.enter({ a: h.a, b: h.b, dir: h.dir, crossed: false });
    }
    if (h.leadGo && !h.sidekickGo && h.t > 2.1) {
      h.sidekickGo = true;
      sidekick.pose = null;
      sidekick.y = h.a.y;
      if (Math.abs(sidekick.x - lineUp.x) > 8) sidekick.x = lineUp.x;
      sidekick.enter({ a: h.a, b: h.b, dir: h.dir, crossed: false });
    }
    if (h.leadGo && !h.leadDone) h.leadDone = lead.stepThrough(dt);
    else if (h.leadDone) lead.moving = false;
    if (h.sidekickGo && !h.sidekickDone) {
      const crossed = sidekick.passage?.crossed;
      h.sidekickDone = sidekick.stepThrough(dt);
      if (!crossed && (sidekick.passage?.crossed || h.sidekickDone)) {
        h.entrance?.close();
        if (this.rand() < 0.5) this.say(sidekick, this.pick(SIDEKICK_LINES));
      }
    } else if (h.sidekickDone) sidekick.moving = false;
    if (h.leadDone && h.sidekickDone) {
      h.exit?.close();
      h.entrance?.close();
      this.hop = null;
      this.hopIn = this.hopEvery * (0.6 + this.rand() * 0.8);
      this.settle(2 + this.rand() * 3);
    }
  }

  where() {
    return this.mode === "away" ? null : { x: this.lead.x, y: this.lead.y, mode: this.mode };
  }

  // ---- clicks -------------------------------------------------------------------------------

  hit(wx: number, wy: number): "lead" | "sidekick" | null {
    if (this.mode === "away") return null;
    if (this.lead.hit(wx, wy, 36)) return "lead";
    if (this.sidekick.hit(wx, wy, 27)) return "sidekick";
    return null;
  }

  /** feet y of whoever `hit` found, for picking the front-most thing under the pointer */
  depth(who: "lead" | "sidekick") {
    return who === "lead" ? this.lead.y : this.sidekick.y;
  }

  poke(who: "lead" | "sidekick") {
    if (this.talkCooldown > 0) return;
    this.talkCooldown = 1.5;
    if (who === "sidekick") {
      this.say(this.sidekick, this.pick(SIDEKICK_CLICKED));
      return;
    }
    this.say(this.lead, this.pick(LEAD_CLICKED));
    // poking the lead gets you a portal sooner
    if (this.mode === "stand" || this.mode === "walk") this.hopIn = Math.min(this.hopIn, 1.5);
  }

  // ---- frame --------------------------------------------------------------------------------

  update(dt: number, time: number) {
    this.clock += dt;
    this.talkCooldown -= dt;
    switch (this.mode) {
      case "away":
        this.timer -= dt;
        if (this.timer <= 0) this.arrive();
        break;
      case "arrive":
        this.stepArrival(dt);
        break;
      case "walk":
        this.hopIn -= dt;
        this.stepWalk(dt);
        this.follow(dt);
        break;
      case "stand":
        this.hopIn -= dt;
        this.timer -= dt;
        this.follow(dt);
        if (this.hopIn <= 0 && freeAt(this.map, this.lead.x, this.lead.y)) {
          if (!this.startHop()) this.hopIn = 4;
        } else if (this.timer <= 0) {
          if (this.rand() < 0.2 && this.talkCooldown <= 0) {
            this.say(
              this.rand() < 0.6 ? this.lead : this.sidekick,
              this.pick(this.rand() < 0.6 ? LEAD_LINES : SIDEKICK_LINES),
            );
            this.talkCooldown = 4;
          }
          this.stroll();
        }
        break;
      case "hop":
        this.stepHop(dt);
        break;
    }
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]!;
      s.t += dt / 0.25;
      const k = Math.min(1, s.t);
      s.sprite.position.set(
        s.from.x + (s.to.x - s.from.x) * k,
        s.from.y + (s.to.y - s.from.y) * k - Math.sin(k * Math.PI) * 3,
      );
      if (k >= 1) {
        s.sprite.destroy();
        this.shots.splice(i, 1);
        s.onHit();
      }
    }
    for (let i = this.portals.length - 1; i >= 0; i--) {
      const p = this.portals[i]!;
      p.update(dt);
      if (p.gone) {
        p.destroy();
        this.portals.splice(i, 1);
      }
    }
    const away = this.mode === "away";
    this.lead.sprite.visible = !away;
    this.sidekick.sprite.visible = !away;
    if (!away) {
      this.lead.draw(time);
      this.sidekick.draw(time);
    }
  }
}
