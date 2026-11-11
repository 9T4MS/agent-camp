/**
 * Ambient office life around the real status (never instead of it): a roomba cleaning the
 * desk floor, a pizza drone at lunch and dinner time, birds in the garden, a ping-pong ball
 * when two people play, the chef bot for someone waiting 10+ minutes, the garden graveyard
 * of today's ended sessions, party mode and the weather of the day.
 * Sprites only, cached textures, position updates per frame; decisions a few times a second.
 */
import { seededRandom } from "@agent-office/protocol";
import { type Container, Sprite } from "pixi.js";
import {
  BIRD,
  birdTextures,
  CHAT_ICONS,
  chatIconTextures,
  chefTextures,
  droneTextures,
  fallenSignTexture,
  headstoneTextures,
  pizzaTextures,
  roombaTextures,
} from "../art/fun.ts";
import { pixelTexture } from "../art/fx.ts";
import type { OfficeModel } from "../state/officeModel.ts";
import type { WaitSpot } from "./cat.ts";
import type { Effects } from "./effects.ts";
import { localDayKey, PARTY_HELPERS, pizzaWindow, type Weather, weatherFor } from "./lifeRules.ts";
import { type OfficeMap, type Point, TILE } from "./map.ts";
import type { OfficeScene } from "./office.ts";
import { findPath } from "./pathing.ts";

export type LifeHooks = {
  /** office-local hour (0..24) */
  hour(): number;
  /** feet of every visible character (birds keep their distance) */
  people(): Point[];
  /** both ping-pong spots are taken */
  pongMatch(): boolean;
  /** people in the meeting room (the pizza box opens when someone is there) */
  inMeeting(): number;
  /** waiting 10+ minutes, longest first */
  longWaiters(): WaitSpot[];
  /** the pizza landed: idle people head over */
  onPizza(): void;
};

export type LifeOptions = {
  weather?: Weather | null;
  /** seconds until the drone shows up once a pizza window starts */
  droneDelay?: number;
};

const tileOf = (p: Point): Point => ({ x: Math.floor(p.x / TILE), y: Math.floor(p.y / TILE) });
const center = (t: Point): Point => ({ x: t.x * TILE + 8, y: t.y * TILE + 12 });

function pathPx(map: OfficeMap, from: Point, to: Point): Point[] | null {
  const tiles = findPath(map, tileOf(from), tileOf(to));
  if (!tiles) return null;
  const out = tiles.slice(1).map(center);
  out.push(to);
  return out;
}

/** Walks a pixel path at a speed; returns true when done. */
function walk(pos: Point, path: Point[], speed: number, dt: number): number {
  let budget = speed * dt;
  let dir = 0;
  while (budget > 0 && path.length) {
    const wp = path[0]!;
    const dx = wp.x - pos.x;
    const dy = wp.y - pos.y;
    const d = Math.hypot(dx, dy);
    if (Math.abs(dx) > 0.3) dir = dx < 0 ? -1 : 1;
    if (d <= budget) {
      pos.x = wp.x;
      pos.y = wp.y;
      budget -= d;
      path.shift();
    } else {
      pos.x += (dx / d) * budget;
      pos.y += (dy / d) * budget;
      budget = 0;
    }
  }
  return dir;
}

// ---- roomba -----------------------------------------------------------------------------------
class Roomba {
  readonly sprite = new Sprite(roombaTextures()[0]!);
  private pos: Point;
  private path: Point[] = [];
  private pause = 2;
  private bump = 0;
  private rand = seededRandom("roomba");

  constructor(
    objects: Container,
    private map: () => OfficeMap,
    private readonly effects: Effects,
  ) {
    this.sprite.anchor.set(0.5, 1);
    this.sprite.label = "actor";
    objects.addChild(this.sprite);
    this.pos = center({ x: 2, y: 9 });
  }

  private next() {
    const map = this.map();
    const desks = map.areas.find((a) => a.name === "desks")!;
    for (let i = 0; i < 12; i++) {
      const t = {
        x: desks.x + Math.floor(this.rand() * desks.w),
        y: desks.y + 1 + Math.floor(this.rand() * (desks.h - 1)),
      };
      if (!map.isWalkable(t.x, t.y)) continue;
      const p = pathPx(map, this.pos, center(t));
      if (p && p.length > 2 && p.length < 24) {
        this.path = p;
        return;
      }
    }
    this.pause = 3;
  }

  update(dt: number, time: number) {
    if (this.pause > 0) {
      this.pause -= dt;
      if (this.pause <= 0) this.next();
    } else if (this.path.length) {
      walk(this.pos, this.path, 13, dt);
      if (this.path.length === 0) {
        // bonk: bumped into a chair leg (or the wall), backs off and thinks about it
        this.bump = 0.35;
        this.pause = 1.2 + this.rand() * 2;
        if (this.rand() < 0.6) this.effects.sparkle(this.pos.x + 6, this.pos.y - 6);
      }
    }
    let jx = 0;
    if (this.bump > 0) {
      this.bump -= dt;
      jx = Math.round(Math.sin(this.bump * 40) * 1.5);
    }
    this.sprite.texture = roombaTextures()[Math.floor(time * 1.5) % 2]!;
    this.sprite.position.set(Math.round(this.pos.x + jx), Math.round(this.pos.y + 2));
    // under everyone's feet
    this.sprite.zIndex = this.pos.y - 8;
  }
}

// ---- pizza drone ------------------------------------------------------------------------------
class PizzaDrone {
  private drone = new Sprite(droneTextures()[0]!);
  private box = new Sprite(pizzaTextures()[0]!);
  private phase: "none" | "wait" | "in" | "lower" | "out" | "served" = "none";
  private t = 0;
  private window: string | null = null;
  private delivered = new Set<string>();
  private pos: Point = { x: 0, y: 0 };
  private rand = seededRandom("drone");

  constructor(
    objects: Container,
    private readonly fx: Container,
    private readonly table: () => Point,
    private readonly worldW: () => number,
    private readonly effects: Effects,
    private readonly hooks: LifeHooks,
    private readonly delay: number | undefined,
  ) {
    this.drone.anchor.set(0.5, 1);
    this.box.anchor.set(0.5, 1);
    this.drone.visible = false;
    this.box.visible = false;
    this.box.label = "actor";
    fx.addChild(this.drone);
    objects.addChild(this.box);
  }

  /** a pizza is on the table */
  get active() {
    return this.phase === "served" || this.phase === "lower";
  }

  slow(day: string) {
    const w = pizzaWindow(this.hooks.hour());
    const key = w ? `${day}:${w}` : null;
    if (key !== this.window) {
      // a window ended: the empty box goes away
      if (this.phase === "served") {
        const tp = this.table();
        this.effects.puff(tp.x, tp.y - 4);
        this.box.visible = false;
      }
      this.phase = "none";
      this.window = key;
    }
    if (key && this.phase === "none" && !this.delivered.has(key)) {
      this.delivered.add(key);
      this.phase = "wait";
      this.t = this.delay ?? 5 + this.rand() * 35;
    }
  }

  update(dt: number, time: number) {
    const tp = this.table();
    this.drone.texture = droneTextures()[Math.floor(time * 14) % 2]!;
    switch (this.phase) {
      case "wait":
        this.t -= dt;
        if (this.t <= 0) {
          this.phase = "in";
          this.pos = { x: this.worldW() + 40, y: tp.y - 120 };
          this.drone.visible = true;
          this.box.visible = true;
          this.box.texture = pizzaTextures()[0]!;
          this.box.zIndex = 99999;
          this.box.parent?.removeChild(this.box);
          this.fx.addChild(this.box);
        }
        break;
      case "in": {
        const target = { x: tp.x, y: tp.y - 34 };
        walk(this.pos, [target], 70, dt);
        if (Math.hypot(this.pos.x - target.x, this.pos.y - target.y) < 0.5) {
          this.phase = "lower";
          this.t = 0;
        }
        break;
      }
      case "lower":
        this.t += dt;
        if (this.t > 1.2) {
          this.phase = "out";
          // drop it on the table (back into the y-sorted layer)
          this.box.parent?.removeChild(this.box);
          const objects = this.dronesObjects;
          objects?.addChild(this.box);
          this.box.position.set(tp.x, tp.y);
          this.box.zIndex = tp.y + 30;
          this.effects.sparkle(tp.x + 8, tp.y - 10);
          this.effects.floater(chatIconTextures()[CHAT_ICONS.indexOf("pizza")]!, tp.x, tp.y - 14);
          this.hooks.onPizza();
        }
        break;
      case "out":
        this.pos.y -= 50 * dt;
        this.pos.x += 30 * dt;
        if (this.pos.y < tp.y - 200) {
          this.drone.visible = false;
          this.phase = "served";
        }
        break;
      default:
        break;
    }
    if (this.drone.visible) {
      const bob = Math.round(Math.sin(time * 6) * 1.5);
      this.drone.position.set(Math.round(this.pos.x), Math.round(this.pos.y + bob));
      if (this.phase === "in" || this.phase === "lower") {
        const drop = this.phase === "lower" ? Math.min(1, this.t / 1.0) * 22 : 0;
        this.box.position.set(Math.round(this.pos.x), Math.round(this.pos.y + 12 + drop + bob));
      }
    }
    if (this.phase === "served" || this.phase === "out") {
      const open = this.hooks.inMeeting() > 0;
      this.box.texture = pizzaTextures()[open ? 1 : 0]!;
    }
  }

  dronesObjects: Container | null = null;
}

// ---- birds ------------------------------------------------------------------------------------
type Bird = {
  sprite: Sprite;
  pos: Point;
  from: Point;
  to: Point;
  t: number;
  mode: "hop" | "peck" | "fly";
  timer: number;
};
class Birds {
  private birds: Bird[] = [];
  private rand = seededRandom("birds");

  constructor(
    objects: Container,
    private map: () => OfficeMap,
    private readonly hooks: LifeHooks,
  ) {
    for (let i = 0; i < 3; i++) {
      const s = new Sprite(birdTextures()[0]!);
      s.anchor.set(0.5, 1);
      s.label = "actor";
      objects.addChild(s);
      const p = this.spot();
      this.birds.push({ sprite: s, pos: p, from: p, to: p, t: 0, mode: "peck", timer: i });
    }
  }

  private spot(): Point {
    const map = this.map();
    const g = map.areas.find((a) => a.name === "garden")!;
    for (let i = 0; i < 30; i++) {
      const t = {
        x: g.x + 1 + Math.floor(this.rand() * (g.w - 2)),
        y: g.y + 2 + Math.floor(this.rand() * (g.h - 4)),
      };
      if (map.terrainAt(t.x, t.y) === "grass" && map.isWalkable(t.x, t.y))
        return { x: t.x * TILE + 4 + this.rand() * 8, y: t.y * TILE + 6 + this.rand() * 8 };
    }
    return { x: g.x * TILE + 40, y: g.y * TILE + 60 };
  }

  update(dt: number, time: number, visible: boolean) {
    const frames = birdTextures();
    const people = visible ? this.hooks.people() : [];
    for (const b of this.birds) {
      b.sprite.visible = visible;
      if (!visible) continue;
      b.timer -= dt;
      if (b.mode === "fly") {
        b.t = Math.min(1, b.t + dt / 1.6);
        const arc = Math.sin(b.t * Math.PI) * 30;
        b.pos = {
          x: b.from.x + (b.to.x - b.from.x) * b.t,
          y: b.from.y + (b.to.y - b.from.y) * b.t - arc,
        };
        b.sprite.texture = frames[BIRD.fly[Math.floor(time * 10) % 2]!]!;
        b.sprite.scale.x = b.to.x < b.from.x ? -1 : 1;
        if (b.t >= 1) {
          b.pos = b.to;
          b.mode = "peck";
          b.timer = 1 + this.rand() * 3;
        }
      } else {
        const scared = people.some((p) => Math.hypot(p.x - b.pos.x, p.y - b.pos.y) < 28);
        if (scared || (b.timer <= 0 && this.rand() < 0.15)) {
          b.mode = "fly";
          b.from = b.pos;
          b.to = this.spot();
          b.t = 0;
        } else if (b.timer <= 0) {
          // hop a little, or peck
          if (this.rand() < 0.5) {
            const nx = b.pos.x + (this.rand() < 0.5 ? -4 : 4);
            const tile = tileOf({ x: nx, y: b.pos.y });
            if (this.map().terrainAt(tile.x, tile.y) === "grass") {
              b.sprite.scale.x = nx < b.pos.x ? -1 : 1;
              b.pos = { x: nx, y: b.pos.y };
            }
            b.mode = "hop";
          } else b.mode = "peck";
          b.timer = 0.4 + this.rand() * 1.6;
        }
        const pecking = b.mode === "peck" && Math.floor(time * 3 + b.pos.x) % 3 === 0;
        b.sprite.texture = frames[pecking ? BIRD.peck : BIRD.stand]!;
      }
      b.sprite.position.set(Math.round(b.pos.x), Math.round(b.pos.y));
      b.sprite.zIndex = b.mode === "fly" ? 99998 : b.pos.y;
    }
  }
}

// ---- chef bot ---------------------------------------------------------------------------------
class Chef {
  private sprite = new Sprite(chefTextures()[0]!);
  private pos: Point = { x: 0, y: 0 };
  private path: Point[] = [];
  private phase: "none" | "go" | "menace" | "serve" | "back" = "none";
  private t = 0;
  private served = new Set<string>();
  private home: Point = { x: 0, y: 0 };

  constructor(
    objects: Container,
    private map: () => OfficeMap,
    private readonly effects: Effects,
    private readonly hooks: LifeHooks,
  ) {
    this.sprite.anchor.set(0.5, 1);
    this.sprite.label = "actor";
    this.sprite.visible = false;
    objects.addChild(this.sprite);
  }

  slow() {
    const waiting = this.hooks.longWaiters();
    const ids = new Set(waiting.map((w) => w.id));
    // a new wait (after they got their sandwich and worked again) can get a new one
    for (const id of this.served) if (!ids.has(id)) this.served.delete(id);
    if (this.phase !== "none") return;
    const w = waiting.find((x) => !this.served.has(x.id));
    if (!w) return;
    const map = this.map();
    this.home = center({ x: 35, y: 4 });
    const target = { x: w.x - 14, y: w.y + 14 };
    const p = map.isWalkable(Math.floor(target.x / TILE), Math.floor(target.y / TILE))
      ? pathPx(map, this.home, target)
      : null;
    if (!p) return;
    this.served.add(w.id);
    this.path = p;
    this.pos = { ...this.home };
    this.phase = "go";
    this.sprite.visible = true;
    this.effects.puff(this.pos.x, this.pos.y - 8);
  }

  update(dt: number, time: number) {
    if (this.phase === "none") return;
    const frames = chefTextures();
    if (this.phase === "go" || this.phase === "back") {
      const dir = walk(this.pos, this.path, 34, dt);
      if (dir) this.sprite.scale.x = dir;
      this.sprite.texture = this.phase === "go" ? frames[Math.floor(time * 4) % 2]! : frames[2]!;
      if (this.path.length === 0) {
        if (this.phase === "go") {
          this.phase = "menace";
          this.t = 1.4;
          this.sprite.scale.x = 1;
        } else {
          this.effects.puff(this.pos.x, this.pos.y - 8);
          this.sprite.visible = false;
          this.phase = "none";
        }
      }
    } else if (this.phase === "menace") {
      // knife up... (beat)
      this.t -= dt;
      this.sprite.texture = frames[Math.floor(time * 10) % 2]!;
      if (this.t <= 0) {
        this.phase = "serve";
        this.t = 2.6;
        this.sprite.texture = frames[2]!;
        this.effects.floater(
          chatIconTextures()[CHAT_ICONS.indexOf("heart")]!,
          this.pos.x,
          this.pos.y - 20,
          2.2,
          8,
        );
      }
    } else if (this.phase === "serve") {
      this.t -= dt;
      if (this.t <= 0) {
        this.phase = "back";
        this.path = pathPx(this.map(), this.pos, this.home) ?? [this.home];
      }
    }
    this.sprite.position.set(Math.round(this.pos.x), Math.round(this.pos.y));
    this.sprite.zIndex = this.pos.y;
  }
}

// ---- garden graveyard ---------------------------------------------------------------------------
const MAX_STONES = 20;
class Graveyard {
  private stones: Sprite[] = [];
  private sign: Sprite;
  private count = 0;
  private day = "";
  private rand = seededRandom("graves");

  constructor(
    private readonly objects: Container,
    private readonly origin: () => Point,
    private readonly effects: Effects,
  ) {
    this.sign = new Sprite(fallenSignTexture(0));
    this.sign.anchor.set(0, 1);
    this.sign.visible = false;
    objects.addChild(this.sign);
  }

  /** The office day rolled over: today's fallen start from zero. */
  setDay(day: string) {
    if (day === this.day) return;
    this.day = day;
    this.count = 0;
    for (const s of this.stones) {
      this.objects.removeChild(s);
      s.destroy();
    }
    this.stones = [];
    this.layout();
  }

  add() {
    this.count++;
    if (this.stones.length >= MAX_STONES) {
      const old = this.stones.shift()!;
      this.objects.removeChild(old);
      old.destroy();
    }
    const r = this.rand();
    const s = new Sprite(headstoneTextures()[r < 0.6 ? 0 : r < 0.9 ? 1 : 2]!);
    s.anchor.set(0.5, 1);
    this.objects.addChild(s);
    this.stones.push(s);
    this.layout();
    const o = this.stones.at(-1)!;
    this.effects.puff(o.x, o.y - 4);
  }

  private layout() {
    const o = this.origin();
    this.sign.visible = this.count > 0;
    this.sign.texture = fallenSignTexture(this.count);
    this.sign.position.set(o.x - 2, o.y);
    this.sign.zIndex = o.y;
    this.stones.forEach((s, i) => {
      const col = i % 5;
      const row = Math.floor(i / 5);
      const x = o.x + 6 + col * 11 + (row % 2) * 5;
      const y = o.y + 13 + row * 9;
      s.position.set(x, y);
      s.zIndex = y;
    });
  }

  relayout() {
    this.layout();
  }
}

// ---- the whole thing ----------------------------------------------------------------------------
export class OfficeLife {
  private roomba: Roomba;
  private drone: PizzaDrone;
  private birds: Birds;
  private chef: Chef;
  readonly graveyard: Graveyard;
  private ball = new Sprite(pixelTexture());
  /** rain streaks over the garden on rainy days */
  private drops: Sprite[] = [];
  private acc = 99;
  private day = "";
  private readonly effects: Effects;
  private partyRand = seededRandom("party");

  constructor(
    private readonly scene: OfficeScene,
    private readonly model: OfficeModel,
    effects: Effects,
    private readonly hooks: LifeHooks,
    private readonly opts: LifeOptions = {},
  ) {
    this.effects = effects;
    const map = () => scene.map;
    this.roomba = new Roomba(scene.objects, map, effects);
    this.drone = new PizzaDrone(
      scene.objects,
      scene.fx,
      () => this.tablePoint(),
      () => scene.widthPx,
      effects,
      hooks,
      opts.droneDelay,
    );
    this.drone.dronesObjects = scene.objects;
    this.birds = new Birds(scene.objects, map, hooks);
    this.chef = new Chef(scene.objects, map, effects, hooks);
    this.graveyard = new Graveyard(
      scene.objects,
      () => {
        const g = scene.map.areas.find((a) => a.name === "garden")!;
        // the quiet strip south of the pond
        return { x: (g.x + 6) * TILE + 2, y: 14 * TILE + 4 };
      },
      effects,
    );
    for (let i = 0; i < 70; i++) {
      const d = new Sprite(pixelTexture());
      d.scale.set(0.5, 3);
      d.tint = 0xc0cbdc;
      d.alpha = 0.8;
      d.visible = false;
      scene.fx.addChild(d);
      this.drops.push(d);
    }
    this.ball.anchor.set(0.5);
    this.ball.visible = false;
    this.ball.label = "actor";
    scene.objects.addChild(this.ball);
  }

  /** Rebuilt map (desk floor grew): actors keep going, labels re-attach them. */
  reattach() {
    this.graveyard.relayout();
  }

  get pizzaOnTable() {
    return this.drone.active;
  }

  private tablePoint(): Point {
    const t = this.scene.map.objects.find((o) => o.kind === "meetingTable");
    if (!t) return { x: 0, y: 0 };
    return { x: (t.x + 3) * TILE + 10, y: t.y * TILE + 20 };
  }

  update(dt: number, time: number) {
    this.acc += dt;
    if (this.acc >= 0.5) {
      this.acc = 0;
      this.slow();
    }
    this.roomba.update(dt, time);
    this.drone.update(dt, time);
    const night = this.scene.night > 0.5;
    this.birds.update(dt, time, !night && this.scene.weather !== "rain");
    this.chef.update(dt, time);
    const raining = this.scene.weather === "rain";
    if (raining || this.drops[0]!.visible) {
      const g = this.scene.map.areas.find((a) => a.name === "garden")!;
      const h = g.h * TILE;
      this.drops.forEach((d, i) => {
        d.visible = raining;
        const x = g.x * TILE + 24 + ((i * 53) % (g.w * TILE - 20));
        const y = (i * 97 + time * 170) % h;
        d.position.set(Math.round(x - y * 0.05), Math.round(g.y * TILE + y));
      });
    }
    // ping-pong rally
    const match = this.hooks.pongMatch();
    this.ball.visible = match;
    if (match) {
      const t = this.scene.map.objects.find((o) => o.kind === "pingpong");
      if (t) {
        const x0 = t.x * TILE + 6;
        const x1 = (t.x + 3) * TILE - 6;
        const k = (time * 0.9) % 2;
        const tri = k < 1 ? k : 2 - k;
        const hop = Math.abs(Math.sin(tri * Math.PI * 2)) * 6;
        this.ball.position.set(Math.round(x0 + (x1 - x0) * tri), Math.round(t.y * TILE - 8 - hop));
        this.ball.zIndex = (t.y + 2) * TILE + 1;
      }
    }
  }

  private slow() {
    const day = localDayKey(this.model.timezone);
    if (day !== this.day) {
      this.day = day;
      this.scene.weather = this.opts.weather ?? weatherFor(day);
      this.graveyard.setDay(day);
    }
    this.drone.slow(day);
    this.chef.slow();
    // party mode: someone runs 10+ helpers at once
    const helpers = new Map<string, number>();
    for (const s of this.model.sessions.values())
      helpers.set(s.personId, (helpers.get(s.personId) ?? 0) + s.subagents);
    this.scene.party = [...helpers.values()].some((n) => n >= PARTY_HELPERS);
    if (this.scene.party) {
      // confetti poppers over the game corner
      const g = this.scene.map.areas.find((a) => a.name === "game")!;
      const r = this.partyRand;
      const x = (g.x + 2 + r() * (g.w - 4)) * TILE;
      const y = (g.y + 2 + r() * 3) * TILE;
      this.effects.confetti(x, y, 14, r, (r() - 0.5) * 1.2);
    }
  }
}
