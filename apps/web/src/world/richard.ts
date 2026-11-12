/**
 * Richard, the IT guy. He lives in the wooden server cabin in the garden, together with the
 * servers: he potters around it, goes in for a while, now and then wanders to the kitchen for a
 * coffee and drops a cable, a screw or a pizza box wherever he walks. Every few minutes the
 * cabin catches fire and he runs back with the extinguisher; whenever a developer runs short
 * of RAM (agents with a full context window ask first) he fetches a stick from the cabin and
 * slots it into the server rack on the desk floor.
 */
import { seededRandom } from "@agent-office/protocol";
import { type Container, Sprite } from "pixi.js";
import { textBubbleTexture } from "../art/fun.ts";
import { flameTextures, smokeTexture } from "../art/heat.ts";
import { C } from "../art/palette.ts";
import {
  extinguisherTextures,
  messTextures,
  ramTexture,
  richardSheet,
  sootTexture,
} from "../art/richard.ts";
import type { Effects } from "./effects.ts";
import {
  CABIN_DOOR,
  CABIN_HOSE,
  FOOTPRINTS,
  type OfficeMap,
  type Point,
  RACK_SPOT,
  SERVER_CABIN,
  TILE,
} from "./map.ts";
import {
  expiredMess,
  FIRE_EVERY_S,
  FIRE_OUT,
  FIRE_START,
  jitter,
  MESS_LIFE_S,
  MUTTER,
  messAlpha,
  POKED,
  pickRamTarget,
  RAM_ASKS,
  RAM_COMING,
  RAM_EVERY_S,
  RAM_THANKS,
  type RamTarget,
  ramSize,
} from "./richardRules.ts";
import { Walker } from "./walker.ts";

/** The auto-pilot camera looks at a fire at most this often (and not in the first minutes). */
const NOTIFY_EVERY_S = 180;
/** Seconds of spraying a fire needs. */
const SPRAY_S = 4.5;
/** Seconds the soot stays on the roof (fading). */
const SOOT_S = 60;
const WALK = 40;
const RUSH = 78;
/** Flame spots on the roof, relative to the cabin's top-left pixel. */
const FLAMES: readonly Point[] = [
  { x: 12, y: 16 },
  { x: 27, y: 10 },
  { x: 44, y: 14 },
  { x: 54, y: 22 },
  { x: 20, y: 24 },
];

type Mode = "inside" | "walk" | "putter" | "coffee" | "rummage" | "install" | "spray";

type Fire = { flames: Sprite[]; left: number; smokeT: number; foamT: number };
type MessItem = { sprite: Sprite; born: number };

export type RichardHooks = {
  /** seated developers with a working agent and how full its context window is */
  ramTargets: () => RamTarget[];
  /** a developer says something from their chair */
  devSays: (id: string, text: string) => void;
};

export class Richard {
  readonly walker: Walker;
  private mode: Mode = "inside";
  private timer = 8;
  private rand = seededRandom("richard");
  private onArrive: (() => void) | null = null;
  private target: Point | null = null;
  private speed = WALK;
  private errand: { id: string; size: number } | null = null;
  private carrying: "ram" | "extinguisher" | null = null;
  private readonly prop: Sprite;
  private fire: Fire | null = null;
  private readonly soot: Sprite;
  private sootT = 0;
  private mess: MessItem[] = [];
  private messT = 5;
  private sparkT = 0;
  private clock = 0;
  private talkCooldown = 0;
  /** 0, not -Infinity: no camera visit in the first minutes after a (kiosk) reload */
  private lastNotify = 0;
  /** mean seconds between cabin fires / RAM requests (shorter in the party demo) */
  fireEvery = FIRE_EVERY_S;
  ramEvery = RAM_EVERY_S;
  fireIn: number;
  ramIn: number;
  /** The cabin is on fire at (x, y): the auto-pilot camera may come (true if it did). */
  onFire: (x: number, y: number) => boolean = () => false;

  constructor(
    private readonly objects: Container,
    private map: OfficeMap,
    private readonly effects: Effects,
    private readonly hooks: RichardHooks,
  ) {
    this.walker = new Walker(objects, richardSheet(), map, effects, this.doorSpot());
    this.walker.sprite.visible = false;
    this.prop = new Sprite(ramTexture());
    this.prop.anchor.set(0.5, 1);
    this.prop.visible = false;
    this.prop.label = "actor";
    objects.addChild(this.prop);
    const box = this.cabinBox();
    this.soot = new Sprite(sootTexture());
    this.soot.position.set(box.x, box.y);
    this.soot.zIndex = box.bottom + 1;
    this.soot.visible = false;
    // "actor": survives the scene rebuild when the desk floor grows
    this.soot.label = "actor";
    objects.addChild(this.soot);
    this.fireIn = jitter(this.fireEvery, this.rand);
    this.ramIn = 25 + this.rand() * 20;
  }

  // ---- spots ----------------------------------------------------------------------------------

  private spot(t: Point): Point {
    return { x: t.x * TILE + 8, y: t.y * TILE + 13 };
  }
  private doorSpot() {
    return this.spot(CABIN_DOOR);
  }
  /** Pixel box of the cabin sprite (top-left of the drawn art, without the dish headroom). */
  private cabinBox() {
    const fp = FOOTPRINTS.serverCabin;
    const bottom = (SERVER_CABIN.y + fp.h) * TILE;
    return { x: SERVER_CABIN.x * TILE, y: bottom - 60, w: fp.w * TILE, bottom };
  }
  private coffeeSpot(): Point | null {
    const p = this.map.pois.find((q) => q.id === "coffee");
    return p ? this.spot(p.tile) : null;
  }
  /** A walkable tile around the cabin to potter about on. */
  private aroundCabin(): Point | null {
    for (let tries = 0; tries < 20; tries++) {
      const tx = SERVER_CABIN.x - 2 + Math.floor(this.rand() * 7);
      const ty = SERVER_CABIN.y - 2 + Math.floor(this.rand() * 6);
      if (this.map.isWalkable(tx, ty)) return this.spot({ x: tx, y: ty });
    }
    return null;
  }

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.rand() * list.length)]!;
  }

  setMap(map: OfficeMap) {
    this.map = map;
    this.walker.map = map;
    if (this.mode === "walk" && this.target && !this.walker.goTo(this.target)) {
      this.walker.path = [];
    }
  }

  get y() {
    return this.walker.y;
  }
  get inside() {
    return !this.walker.sprite.visible;
  }
  /** The cabin is burning right now. */
  get burning() {
    return this.fire !== null;
  }

  /** For screenshots and tests: where he is and what he is up to. */
  where() {
    const w = this.walker;
    return { x: w.x, y: w.y, mode: this.mode, inside: this.inside, burning: this.burning };
  }

  hit(wx: number, wy: number) {
    return !this.inside && this.walker.hit(wx, wy);
  }

  poke() {
    if (this.talkCooldown > 0 || this.inside) return;
    this.talkCooldown = 1.5;
    this.say(this.pick(POKED));
  }

  private say(text: string, color: string = C.navy) {
    if (this.inside) {
      // from inside the cabin: the bubble rises from the doorway
      const d = this.doorSpot();
      this.effects.floater(textBubbleTexture(text, color), d.x, d.y - 30, 2.6, 8);
    } else this.walker.say(text, color);
  }

  // ---- moving -------------------------------------------------------------------------------

  private walkTo(target: Point | null, then: () => void, speed = WALK) {
    this.show();
    this.speed = speed;
    if (!target || !this.walker.goTo(target)) {
      then();
      return;
    }
    this.target = target;
    this.onArrive = then;
    this.mode = "walk";
  }

  private show() {
    if (!this.inside) return;
    const d = this.doorSpot();
    this.walker.x = d.x;
    this.walker.y = d.y;
    this.walker.facing = "down";
    this.walker.sprite.visible = true;
  }

  private goInside(seconds: number, mode: Mode = "inside") {
    this.walker.sprite.visible = false;
    this.walker.path = [];
    this.walker.pose = null;
    this.mode = mode;
    this.timer = seconds;
  }

  /** Walk to the door and in. */
  private home(seconds: number, mode: Mode = "inside") {
    if (this.inside) {
      this.goInside(seconds, mode);
      return;
    }
    this.walkTo(this.doorSpot(), () => this.goInside(seconds, mode));
  }

  private idle() {
    this.walker.pose = null;
    if (this.errand) {
      this.home(2.5, "rummage");
      return;
    }
    const r = this.rand();
    if (r < 0.4) this.home(15 + this.rand() * 25);
    else if (r < 0.82) {
      this.walkTo(this.aroundCabin(), () => {
        this.mode = "putter";
        this.walker.facing = this.pick(["down", "left", "right", "up"] as const);
        this.timer = 4 + this.rand() * 8;
        if (this.rand() < 0.3) this.say(this.pick(MUTTER), C.cocoa);
      });
    } else {
      this.walkTo(this.coffeeSpot(), () => {
        this.mode = "coffee";
        this.walker.facing = "up";
        this.walker.pose = "play";
        this.timer = 4 + this.rand() * 3;
      });
    }
  }

  // ---- RAM ----------------------------------------------------------------------------------

  private askForRam() {
    const t = pickRamTarget(this.hooks.ramTargets(), this.rand);
    if (!t) {
      this.ramIn = 12;
      return;
    }
    this.errand = { id: t.id, size: ramSize(t.context, this.rand) };
    this.hooks.devSays(t.id, this.pick(RAM_ASKS));
    this.effects.after(1.3, () => this.say(this.pick(RAM_COMING)));
    if (this.mode === "inside") {
      this.mode = "rummage";
      this.timer = Math.max(this.timer, 2.5);
    } else if (this.mode !== "walk") this.home(2.5, "rummage");
    // already walking somewhere: `idle()` after the walk picks the errand up
  }

  private rummaged() {
    this.carrying = "ram";
    this.walkTo(
      this.spot(RACK_SPOT),
      () => {
        this.mode = "install";
        this.walker.facing = "up";
        this.walker.pose = "play";
        this.timer = 3;
        this.sparkT = 0;
      },
      48,
    );
  }

  private installed() {
    const e = this.errand;
    this.errand = null;
    this.carrying = null;
    this.walker.pose = null;
    this.ramIn = jitter(this.ramEvery, this.rand);
    const rack = this.rackTop();
    this.effects.sparkle(rack.x, rack.y);
    if (e) {
      this.say(`+${e.size} GB!`, C.forest);
      this.effects.after(1.2, () => this.hooks.devSays(e.id, this.pick(RAM_THANKS)));
    }
    this.effects.after(1.6, () => {
      if (this.mode === "install") this.home(10 + this.rand() * 20);
    });
    this.mode = "install";
    this.timer = 99;
  }

  /** The upper slots of the rack right above where he stands. */
  private rackTop(): Point {
    return { x: RACK_SPOT.x * TILE + 8, y: (RACK_SPOT.y - 1) * TILE - 4 };
  }

  // ---- fire ---------------------------------------------------------------------------------

  private ignite() {
    const box = this.cabinBox();
    const frames = flameTextures();
    const flames = FLAMES.map((p, i) => {
      const s = new Sprite(frames[i % frames.length]!);
      s.anchor.set(0.5, 1);
      s.scale.set(2);
      s.position.set(box.x + p.x, box.y + p.y);
      s.zIndex = box.bottom + 2;
      s.label = "actor";
      this.objects.addChild(s);
      return s;
    });
    this.fire = { flames, left: SPRAY_S, smokeT: 0, foamT: 0 };
    this.sootT = 0;
    this.soot.visible = false;
    this.notify(box.x + box.w / 2, box.y + 20);
    // whatever he was doing: drop it and run (a RAM errand waits until the fire is out)
    this.carrying = "extinguisher";
    this.walker.pose = null;
    this.say(this.pick(FIRE_START), C.red);
    this.walkTo(
      this.spot(CABIN_HOSE),
      () => {
        this.mode = "spray";
        this.walker.facing = "up";
        this.walker.pose = null;
      },
      RUSH,
    );
  }

  private notify(x: number, y: number) {
    if (this.clock - this.lastNotify < NOTIFY_EVERY_S) return;
    if (this.onFire(x, y)) this.lastNotify = this.clock;
  }

  private updateFire(dt: number, time: number) {
    const f = this.fire;
    if (!f) return;
    const box = this.cabinBox();
    const frames = flameTextures();
    const share = f.left / SPRAY_S;
    const lit = Math.ceil(share * f.flames.length);
    f.flames.forEach((s, i) => {
      s.visible = i < lit;
      s.texture = frames[Math.floor(time * 9 + i) % frames.length]!;
      s.scale.set(1.4 + share * 0.8);
    });
    f.smokeT -= dt;
    if (f.smokeT <= 0) {
      f.smokeT = 0.35;
      const p = this.pick(FLAMES);
      this.effects.floater(smokeTexture(), box.x + p.x, box.y + p.y - 12, 2.2, 22, 3);
    }
    if (this.mode !== "spray") return;
    f.left -= dt;
    f.foamT -= dt;
    if (f.foamT <= 0) {
      // white foam: blobs that splash on the roof and drip down, and a puff now and then
      f.foamT = 0.16;
      const p = f.flames.find((s) => s.visible) ?? f.flames[0]!;
      this.effects.burst(p.x, p.y - 6, [C.white, C.white, C.silver], {
        count: 8,
        speed: 30,
        life: 0.9,
        floor: p.y + 6,
        rand: this.rand,
      });
      if (this.rand() < 0.35) this.effects.puff(p.x + (this.rand() - 0.5) * 10, p.y - 4);
    }
    if (f.left <= 0) this.extinguished();
  }

  private extinguished() {
    const f = this.fire;
    if (!f) return;
    for (const s of f.flames) {
      this.effects.puff(s.x, s.y - 6);
      s.destroy();
    }
    this.fire = null;
    this.fireIn = jitter(this.fireEvery, this.rand);
    this.soot.visible = true;
    this.soot.alpha = 1;
    this.sootT = SOOT_S;
    this.say(this.pick(FIRE_OUT));
    this.mode = "putter";
    this.walker.facing = "down";
    this.timer = 2.5;
    this.effects.after(1.5, () => {
      if (this.carrying === "extinguisher") this.carrying = null;
    });
  }

  // ---- mess ---------------------------------------------------------------------------------

  private dropMess() {
    for (const m of expiredMess(this.mess, this.clock, true)) m.sprite.destroy();
    this.mess = this.mess.filter((m) => !m.sprite.destroyed);
    const tex = this.pick(messTextures());
    const s = new Sprite(tex);
    s.anchor.set(0.5, 1);
    s.position.set(Math.round(this.walker.x + (this.rand() - 0.5) * 8), Math.round(this.walker.y));
    s.zIndex = this.walker.y - 14;
    s.label = "actor";
    this.objects.addChild(s);
    this.mess.push({ sprite: s, born: this.clock });
  }

  private updateMess(dt: number) {
    if (this.walker.walking && !this.inside) {
      this.messT -= dt;
      if (this.messT <= 0) {
        this.messT = 7 + this.rand() * 12;
        if (this.rand() < 0.55) this.dropMess();
      }
    }
    for (const m of this.mess) m.sprite.alpha = messAlpha(this.clock - m.born, MESS_LIFE_S);
    const gone = expiredMess(this.mess, this.clock);
    if (gone.length) {
      for (const m of gone) m.sprite.destroy();
      this.mess = this.mess.filter((m) => !m.sprite.destroyed);
    }
  }

  // ---- frame --------------------------------------------------------------------------------

  private updateProp(time: number) {
    const w = this.walker;
    const p = this.prop;
    if (!this.carrying || this.inside) {
      p.visible = false;
      return;
    }
    p.visible = true;
    if (this.carrying === "ram") {
      p.texture = ramTexture();
      // held up high on the way; in the rack, right in front of him, while installing
      const installing = this.mode === "install";
      p.position.set(
        Math.round(w.x + (installing ? 2 : 6)),
        Math.round(w.y - (installing ? 25 : 19)),
      );
      p.zIndex = installing ? w.y - 1 : w.y + 1;
      p.scale.x = 1;
      return;
    }
    const frames = extinguisherTextures();
    p.texture = frames[this.mode === "spray" ? Math.floor(time * 10) % 2 : 0]!;
    const side = w.facing === "left" ? -1 : 1;
    p.scale.x = side;
    p.position.set(Math.round(w.x + side * 7), Math.round(w.y - 3));
    p.zIndex = w.y + (w.facing === "up" ? -1 : 1);
  }

  update(dt: number, time: number) {
    this.clock += dt;
    this.talkCooldown -= dt;
    const w = this.walker;
    if (!this.fire) {
      this.fireIn -= dt;
      if (this.fireIn <= 0) this.ignite();
    }
    if (!this.fire && !this.errand) {
      this.ramIn -= dt;
      if (this.ramIn <= 0) this.askForRam();
    }
    switch (this.mode) {
      case "walk":
        if (!w.walking) {
          const arrive = this.onArrive;
          this.onArrive = null;
          this.target = null;
          this.mode = "putter";
          this.timer = 1;
          arrive?.();
          // a RAM request came in on the way: get to it soon
          if (this.errand && ["inside", "putter", "coffee"].includes(this.mode)) {
            this.timer = Math.min(this.timer, 0.5);
          }
        }
        break;
      case "inside":
      case "putter":
      case "coffee":
        this.timer -= dt;
        if (this.timer <= 0) {
          if (this.mode === "coffee") w.pose = null;
          this.idle();
        }
        break;
      case "rummage":
        this.timer -= dt;
        if (this.timer <= 0) this.rummaged();
        break;
      case "install":
        this.timer -= dt;
        this.sparkT -= dt;
        if (this.sparkT <= 0 && this.errand) {
          this.sparkT = 0.55;
          const r = this.rackTop();
          this.effects.burst(r.x + (this.rand() - 0.5) * 8, r.y + 6, [C.lemon, C.white, C.cyan], {
            count: 6,
            speed: 30,
            life: 0.5,
            rand: this.rand,
          });
        }
        if (this.timer <= 0) this.installed();
        break;
      case "spray":
        break;
    }
    this.updateFire(dt, time);
    if (this.sootT > 0) {
      this.sootT -= dt;
      this.soot.alpha = Math.max(0, Math.min(1, this.sootT / (SOOT_S * 0.5)));
      if (this.sootT <= 0) this.soot.visible = false;
    }
    this.updateMess(dt);
    w.update(dt, time, this.speed);
    this.updateProp(time);
  }
}
