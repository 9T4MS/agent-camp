/**
 * One office cat: naps next to someone idle (zzz), is the waiting alarm (walks over and sits
 * next to anyone waiting for 5+ minutes), meows and purrs hearts when clicked, and now and
 * then pounces on a finished helper bot (crunch). Viewers can also give it something to do
 * (`CatTask`): eat from a bowl, chase a laser dot or a yarn ball, or go and sit on someone's
 * desk. The resident cats have a `trait`: a `hungry` one (Cece, Jess) also sits up and begs
 * next to working agents, snaps up tossed treats and is never full for long; `zoomies` (Kiwi)
 * races from one end of the office to the other and hardly ever naps; `chatty` (Eloy) meows all
 * the time and goes from dev to dev to meow at them. `CatColony` (colony.ts) owns all the cats
 * and the toys.
 */
import { seededRandom } from "@agent-office/protocol";
import { type Container, Sprite } from "pixi.js";
import { tieTexture } from "../art/chaos.ts";
import { heartTexture, textBubbleTexture } from "../art/fun.ts";
import { CAT, type CatCoat, catTextures, zzzTextures } from "../art/fx.ts";
import { C } from "../art/palette.ts";
import type { Effects } from "./effects.ts";
import { eloyMeow, KIWI_ZOOM_SPEED, kiwiShout, kiwiZoomWorthy } from "./lifeRules.ts";
import { type OfficeMap, type Point, TILE } from "./map.ts";
import { findPath } from "./pathing.ts";
import { indoorTile } from "./portalRules.ts";

export type WaitSpot = Point & { id: string };

/** Where a cat sent to someone sits: next to their chair, then up on the desk (if any). */
export type Perch = { seat: Point; desk: Point | null; z: number };

export type CatTask =
  /** walk to `spot` and eat while `food()` says there is some left */
  | { kind: "eat"; spot: Point; bowl: Point; food: (dt: number) => boolean }
  /** follow a moving target; `onReach` when the cat gets it (pounce) */
  | {
      kind: "chase";
      label: string;
      target: () => Point | null;
      onReach: (cat: OfficeCat) => void;
    }
  /** sit by (or on the desk of) someone for a while */
  | { kind: "visit"; perch: Perch; who: string; stay: number; onArrive?: () => void }
  /**
   * sit up next to someone's agent and beg (`ask()` says what for) for `stay` seconds, or until
   * `still()` turns false; then `onDone` (the agent answers)
   */
  | {
      kind: "beg";
      seat: Point;
      label: string;
      ask: () => string;
      stay: number;
      still: () => boolean;
      onDone: (cat: OfficeCat, asked: boolean) => void;
      /** seconds between two asks (default 2.6..3.8) */
      every?: readonly [number, number];
    };

/**
 * What makes a resident cat special: `hungry` (Cece, Jess) begs and is never full for long,
 * `zoomies` (Kiwi) races around the office, `chatty` (Eloy) never stops meowing.
 */
export type CatTrait = "hungry" | "zoomies" | "chatty";

export type CatSpec = { slot: number; name: string; coat: CatCoat; home: Point; trait?: CatTrait };

type Mode = "sleep" | "sit" | "walk" | "pounce" | "smug" | "eat" | "perch" | "beg";

export class OfficeCat {
  readonly sprite: Sprite;
  readonly slot: number;
  readonly name: string;
  readonly coat: CatCoat;
  /** a resident cat's quirk (null = an ordinary colony cat) */
  readonly trait: CatTrait | null;
  private zzz: Sprite;
  x: number;
  y: number;
  private path: Point[] = [];
  private mode: Mode = "sleep";
  private timer = 6;
  private dir = 1;
  private rand: () => number;
  /** whose side the cat sits at as the waiting alarm */
  guarding: string | null = null;
  heading: string | null = null;
  private prey: { sprite: Sprite; x: number; y: number } | null = null;
  private meowCooldown = 0;
  /** begging: seconds until the next "TREAT?" */
  private askT = 0;
  /** begging: the gap that `askT` started from (the mouth stays open early on) */
  private askGap = 3;
  /** racing to a far spot (Kiwi) */
  private zooming = false;
  /** seconds until the next dust puff behind a zooming cat */
  private dustT = 0;
  /** seconds until a chatty cat meows again on its own */
  private chatterT = 2;
  private tie: Sprite;
  /** Friday meeting: where the boss sits (null = an ordinary cat) */
  private boss: Point | null = null;
  private bossTalk = 3;
  /** what a viewer asked for, if anything */
  private task: CatTask | null = null;
  private repath = 0;
  /** The last chase goTo found no path: wait for the repath timer instead of retrying. */
  private chaseStuck = false;
  private reachCooldown = 0;
  /** a short jump (onto a desk, at a laser dot); `then` runs on landing */
  private hop: { from: Point; to: Point; t: number; dur: number; then: () => void } | null = null;
  /** pounce wiggle at a toy, seconds left */
  private bounce = 0;
  /** on a desk: drawn above it */
  private perched: { floor: Point; z: number } | null = null;
  private readonly speedK: number;
  private readonly home: Point;
  /** walking out of the office (the office shrank); `gone` once outside */
  leaving = false;
  gone = false;
  /** chance a finished helper nearby gets eaten */
  eatChance = 0.25;
  /** how far (px) the cat will dash for a finished helper */
  eatRange = 220;

  constructor(
    spec: CatSpec,
    objects: Container,
    fx: Container,
    private map: OfficeMap,
    private readonly idleSpots: () => Point[],
    private readonly effects: Effects,
    private readonly waitSpots: () => WaitSpot[] = () => [],
    /** walk in from here (a new cat), else start napping at home */
    enterAt: Point | null = null,
  ) {
    this.slot = spec.slot;
    this.name = spec.name;
    this.coat = spec.coat;
    this.trait = spec.trait ?? null;
    this.home = spec.home;
    // the first cat keeps the seed it always had
    this.rand = seededRandom(spec.slot === 0 ? "cat" : `cat-${spec.slot}`);
    this.speedK = spec.slot === 0 ? 1 : 0.85 + this.rand() * 0.35;
    this.sprite = new Sprite(catTextures(this.coat)[0]!);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.label = "actor";
    this.zzz = new Sprite(zzzTextures()[0]!);
    this.zzz.anchor.set(0, 1);
    this.tie = new Sprite(tieTexture());
    this.tie.anchor.set(0.5, 0);
    this.tie.visible = false;
    objects.addChild(this.sprite);
    fx.addChild(this.zzz, this.tie);
    const start = enterAt ?? this.home;
    this.x = start.x;
    this.y = start.y;
    if (enterAt && !this.goTo(this.home)) {
      this.x = this.home.x;
      this.y = this.home.y;
    }
    if (!enterAt && spec.slot > 0) this.timer = 2 + this.rand() * 10;
  }

  setMap(map: OfficeMap) {
    this.map = map;
  }

  /** always hungry: begs agents for treats and meals, and is never full for long */
  get hungry() {
    return this.trait === "hungry";
  }

  destroy() {
    this.sprite.destroy();
    this.zzz.destroy();
    this.tie.destroy();
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
    this.zooming = false;
    if (!spot) {
      this.effects.floater(textBubbleTexture("MEETING OVER."), this.x, this.y - 14, 2.5, 8);
      this.mode = "sit";
      this.timer = 3;
      return;
    }
    this.prey = null;
    this.dropTask();
    this.bossTalk = 2;
    if (!this.goTo(spot)) {
      this.x = spot.x;
      this.y = spot.y;
      this.mode = "sit";
    }
    this.timer = 9999;
  }

  /** Walk out through the main door (`exit` is outside); `gone` turns true out there. */
  leave(exit: Point) {
    if (this.leaving) return;
    this.dropTask();
    this.prey?.sprite.destroy();
    this.prey = null;
    this.guarding = null;
    this.heading = null;
    this.leaving = true;
    this.zooming = false;
    if (!this.goTo(exit)) this.gone = true;
  }

  /** What the cat is up to, for its card. */
  status(): string {
    if (this.leaving) return "heading home";
    if (this.boss) return "chairing the meeting";
    if (this.prey) return "hunting a helper bot";
    if (this.task?.kind === "eat") return this.mode === "eat" ? "eating" : "off to the food bowl";
    if (this.task?.kind === "chase") return this.task.label;
    if (this.task?.kind === "beg") return this.task.label;
    if (this.task?.kind === "visit")
      return this.mode === "perch" ? `sitting with ${this.task.who}` : `off to ${this.task.who}`;
    if (this.guarding || this.heading) return "keeping a waiting human company";
    if (this.zooming) return "zooming around the office";
    if (this.mode === "smug") return "looking very pleased";
    if (this.mode === "sleep") return "napping";
    if (this.mode === "walk") return "on patrol";
    return "sitting around";
  }

  get busy() {
    return this.prey !== null || this.task !== null || this.boss !== null || this.leaving;
  }

  /** Something to do from a viewer. False when the cat can't (meeting, leaving, mid-pounce). */
  assign(task: CatTask): boolean {
    if (this.boss || this.leaving || this.prey) return false;
    this.dropTask();
    this.guarding = null;
    this.heading = null;
    this.zooming = false;
    this.task = task;
    this.path = [];
    this.repath = 0;
    this.chaseStuck = false;
    if (task.kind === "eat") {
      if (!this.goTo(task.spot)) return this.fail();
    } else if (task.kind === "visit") {
      const floor = this.beside(task.perch.seat) ?? task.perch.seat;
      if (!this.goTo(floor)) return this.fail();
    } else if (task.kind === "beg") {
      const floor = this.beside(task.seat);
      if (!floor || !this.goTo(floor)) return this.fail();
    } else {
      this.mode = "walk";
    }
    return true;
  }

  private fail() {
    this.task = null;
    this.mode = "sit";
    this.timer = 2;
    return false;
  }

  /** Forget the current task (off the desk first). */
  private dropTask() {
    this.task = null;
    this.hop = null;
    this.bounce = 0;
    if (this.perched) {
      this.x = this.perched.floor.x;
      this.y = this.perched.floor.y;
      this.perched = null;
    }
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
    this.zooming = false;
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
    if (this.trait === "zoomies" && this.rand() < 0.85 && this.zoom()) return;
    const spots = this.idleSpots();
    let target = this.home;
    if (spots.length > 0 && this.rand() < 0.8) {
      const s = spots[Math.floor(this.rand() * spots.length)]!;
      target = this.beside(s) ?? this.home;
    }
    if (!this.goTo(target)) this.timer = 5;
  }

  /** Kiwi: race to a random spot on the office floor, far from here. */
  private zoom(): boolean {
    const from = { x: Math.floor(this.x / TILE), y: Math.floor((this.y - 2) / TILE) };
    for (let i = 0; i < 40; i++) {
      const t = {
        x: Math.floor(this.rand() * this.map.width),
        y: Math.floor(this.rand() * this.map.height),
      };
      if (!indoorTile(this.map, t.x, t.y) || !kiwiZoomWorthy(from, t)) continue;
      if (!this.goTo({ x: t.x * TILE + 8, y: t.y * TILE + 12 })) continue;
      this.zooming = true;
      this.dustT = 0;
      if (this.rand() < 0.4)
        this.effects.after(0.3, () => {
          if (this.zooming) this.say(kiwiShout(this.rand()), C.plum, 1.4);
        });
      return true;
    }
    return false;
  }

  private say(text: string, color: string = C.plum, life = 2.2) {
    this.effects.floater(textBubbleTexture(text, color), this.x + 6, this.y - 14, life, 6);
  }

  /** Clicked: "mrrp?" and a few purr hearts. */
  meow() {
    if (this.meowCooldown > 0) return;
    this.meowCooldown = 1.2;
    const lines = this.hungry
      ? ["TREAT?", "FOOD?", "MEOW!", "SNACK?", "PRRR"]
      : this.trait === "chatty"
        ? ["MIAU!", "MIAU MIAU", "MIAAAU!", "PRRRMIAU"]
        : this.trait === "zoomies"
          ? ["MRRP!", "PRRR", "ZOOM?", "MEOW!"]
          : ["MRRP?", "MEOW!", "PRRR", "MRRRP"];
    this.say(lines[Math.floor(this.rand() * lines.length)]!);
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

  /** Begged and got nothing: a short, offended remark. */
  pout() {
    if (this.leaving || this.boss || this.task) return;
    const lines = ["HMPF", "RUDE.", "...FINE", "I'LL BE BACK"];
    this.say(lines[Math.floor(this.rand() * lines.length)]!, C.ink, 1.8);
  }

  /** A treat landed right in front of the cat: gone in one bite, and it wants another. */
  snack() {
    if (this.leaving || this.boss) return;
    this.say("NOM!", C.bark, 1.4);
    for (let i = 0; i < 2; i++) {
      this.effects.after(0.3 + i * 0.3, () =>
        this.effects.floater(heartTexture(), this.x - 2 + i * 4, this.y - 10, 1.4, 16, 2),
      );
    }
    if (this.task) return;
    this.mode = "smug";
    this.timer = 3;
    if (this.hungry)
      this.effects.after(2.6, () => {
        if (!this.task && !this.leaving) this.say("MORE?");
      });
  }

  hit(wx: number, wy: number) {
    return Math.abs(wx - this.x) <= 10 && wy >= this.y - 14 && wy <= this.y + 3;
  }

  /** A finished helper bot at (x, y): pounce on it (true = the cat owns the sprite now). */
  tryEat(sprite: Sprite, x: number, y: number): boolean {
    if (this.prey || this.guarding || this.heading || this.busy) return false;
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

  private hopTo(to: Point, dur: number, then: () => void) {
    if (Math.abs(to.x - this.x) > 0.5) this.dir = to.x < this.x ? -1 : 1;
    this.hop = { from: { x: this.x, y: this.y }, to, t: 0, dur, then };
  }

  /** Walked to the end of the path. */
  private arrived() {
    if (this.leaving) {
      this.gone = true;
      return;
    }
    if (this.boss) {
      this.mode = "sit";
      this.timer = 9999;
      return;
    }
    const task = this.task;
    if (task?.kind === "eat") {
      this.mode = "eat";
      this.dir = task.bowl.x < this.x ? -1 : 1;
      this.timer = 4 + this.rand() * 2;
      this.say("NOM", C.bark, 1.4);
      return;
    }
    if (task?.kind === "visit") {
      const floor = { x: this.x, y: this.y };
      const settle = () => {
        this.mode = "perch";
        this.dir = 1;
        this.timer = task.stay;
        this.say("MRRP!");
        task.onArrive?.();
      };
      if (task.perch.desk) {
        this.perched = { floor, z: task.perch.z };
        this.hopTo(task.perch.desk, 0.35, settle);
      } else settle();
      return;
    }
    if (task?.kind === "chase") {
      if (!this.chaseStuck) this.repath = 0;
      return;
    }
    if (task?.kind === "beg") {
      this.mode = "beg";
      this.dir = task.seat.x < this.x ? -1 : 1;
      this.timer = task.stay;
      this.askT = 0;
      return;
    }
    if (this.heading) {
      this.guarding = this.heading;
      this.heading = null;
      this.mode = "sit";
      this.timer = 2;
      return;
    }
    if (this.zooming) {
      // a skid, a breather, and off again (now and then a very short nap)
      this.zooming = false;
      this.effects.burst(this.x, this.y - 1, [C.silver, C.grey], {
        count: 5,
        speed: 22,
        life: 0.6,
        floor: this.y + 1,
      });
      this.mode = this.rand() < 0.1 ? "sleep" : "sit";
      this.timer = this.mode === "sit" ? 1 + this.rand() * 2 : 6 + this.rand() * 4;
      return;
    }
    this.mode = this.rand() < 0.3 ? "sit" : "sleep";
    this.timer = this.mode === "sit" ? 5 + this.rand() * 5 : 18 + this.rand() * 25;
  }

  /** Chasing a toy: re-aim a few times a second, leap at it when close. */
  private chase(dt: number, task: Extract<CatTask, { kind: "chase" }>) {
    this.reachCooldown -= dt;
    const t = task.target();
    if (!t) {
      this.task = null;
      this.path = [];
      this.mode = "sit";
      this.timer = 3 + this.rand() * 3;
      this.say(this.rand() < 0.5 ? "?" : "...", C.ink, 1.6);
      return;
    }
    const d = Math.hypot(t.x - this.x, t.y - this.y);
    if (d < 6 && this.reachCooldown <= 0) {
      this.reachCooldown = 0.7;
      this.bounce = 0.3;
      task.onReach(this);
      return;
    }
    this.repath -= dt;
    // a walked path re-aims at once (arrived() zeroes the timer); a failed goTo waits for it
    if (this.repath <= 0) {
      this.repath = 0.3;
      this.chaseStuck = false;
      if (d < 28) this.path = [t];
      else if (!this.goTo(t)) {
        this.path = [];
        this.chaseStuck = true;
      }
      this.mode = "walk";
    }
  }

  update(dt: number, time: number) {
    const frames = catTextures(this.coat);
    this.meowCooldown -= dt;
    let hopY = 0;
    const walkFrame = (fps: number) =>
      frames[(this.dir < 0 ? CAT.walkLeft : CAT.walkRight)[Math.floor(time * fps) % 2]!]!;
    if (this.hop) {
      const h = this.hop;
      h.t += dt;
      const k = Math.min(1, h.t / h.dur);
      this.x = h.from.x + (h.to.x - h.from.x) * k;
      this.y = h.from.y + (h.to.y - h.from.y) * k;
      hopY = -Math.sin(k * Math.PI) * 8;
      this.sprite.texture = walkFrame(12);
      if (k >= 1) {
        this.hop = null;
        h.then();
      }
    } else if (this.mode === "pounce" && this.prey) {
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
      this.sprite.texture = walkFrame(12);
    } else if (this.mode === "walk") {
      const task = this.task;
      if (task?.kind === "chase" && !this.leaving) this.chase(dt, task);
      if (this.mode === "walk") {
        // errands (food, a visit, a waiting human) at a trot, strolls slowly
        const fast = task !== null || this.heading;
        const speed = this.zooming
          ? KIWI_ZOOM_SPEED
          : task?.kind === "chase"
            ? 70
            : fast
              ? 40
              : this.leaving
                ? 34
                : 26;
        this.stepPath(dt, speed * this.speedK);
        this.sprite.texture = walkFrame(this.zooming ? 18 : task?.kind === "chase" ? 10 : 6);
        if (this.zooming) {
          this.dustT -= dt;
          if (this.dustT <= 0) {
            this.dustT = 0.09;
            this.effects.burst(this.x - this.dir * 6, this.y - 1, [C.silver, C.grey], {
              count: 2,
              speed: 12,
              life: 0.45,
              floor: this.y + 1,
            });
          }
        }
        if (this.path.length === 0) this.arrived();
      }
      if (this.bounce > 0) {
        this.bounce -= dt;
        hopY = -Math.sin(Math.max(0, this.bounce / 0.3) * Math.PI) * 5;
      }
    } else if (this.mode === "eat") {
      const task = this.task;
      this.sprite.texture = frames[CAT.sit[Math.floor(time * 4) % 2]!]!;
      this.timer -= dt;
      const food = task?.kind === "eat" && task.food(dt);
      if (Math.floor(time * 1.5) !== Math.floor((time - dt) * 1.5) && task?.kind === "eat")
        this.effects.burst(task.bowl.x, task.bowl.y - 4, [C.wood, C.bark], {
          count: 3,
          speed: 14,
          life: 0.8,
          floor: task.bowl.y,
        });
      if (this.timer <= 0 || !food) {
        this.task = null;
        if (this.hungry) {
          // never full for long
          this.mode = "sit";
          this.timer = 4 + this.rand() * 3;
          this.effects.after(0.6, () => {
            if (!this.task) this.say(this.rand() < 0.5 ? "MORE?" : "STILL HUNGRY");
          });
        } else {
          // food coma
          this.mode = "sleep";
          this.timer = 20 + this.rand() * 15;
          if (this.rand() < 0.5) this.say("PRRR");
        }
      }
    } else if (this.mode === "beg") {
      const task = this.task;
      this.askT -= dt;
      // the mouth stays open for a moment after every "TREAT?"
      const meowing = this.askT > this.askGap - 0.7;
      this.sprite.texture = frames[meowing ? CAT.beg[1] : CAT.beg[Math.floor(time * 1.2) % 2]!]!;
      this.timer -= dt;
      if (task?.kind !== "beg") {
        this.mode = "sit";
        this.timer = 2;
      } else if (this.timer <= 0 || !task.still()) {
        const asked = this.timer <= 0;
        this.task = null;
        this.mode = "sit";
        this.timer = 3 + this.rand() * 3;
        task.onDone(this, asked);
      } else if (this.askT <= 0) {
        const [lo, hi] = task.every ?? [2.6, 3.8];
        this.askGap = lo + this.rand() * (hi - lo);
        this.askT = this.askGap;
        this.say(task.ask(), C.plum, Math.min(2, this.askGap + 0.4));
      }
    } else if (this.mode === "perch") {
      this.sprite.texture = frames[CAT.sit[Math.floor(time * 0.5) % 2]!]!;
      this.timer -= dt;
      if (this.timer <= 0) {
        const floor = this.perched?.floor;
        this.task = null;
        if (floor) {
          this.hopTo(floor, 0.35, () => {
            this.perched = null;
            this.pickTarget();
          });
        } else this.pickTarget();
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
        } else if (this.mode === "sit" && this.trait !== "zoomies" && this.rand() < 0.5) {
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
    // Eloy: a meow every few seconds whatever he does (not in his sleep, not while begging,
    // which has its own)
    if (this.trait === "chatty" && this.mode !== "sleep" && this.mode !== "beg" && !this.boss) {
      this.chatterT -= dt;
      if (this.chatterT <= 0) {
        this.chatterT = 2 + this.rand() * 1.5;
        this.say(eloyMeow(this.rand()), C.plum, 1.6);
      }
    }
    const moving = this.mode === "walk" || this.mode === "pounce" || this.hop !== null;
    this.sprite.scale.x = moving ? 1 : this.dir < 0 ? 1 : -1;
    this.sprite.position.set(Math.round(this.x), Math.round(this.y + hopY));
    this.sprite.zIndex = this.perched ? this.perched.z : this.y - 1;
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
    this.zzz.visible = this.mode === "sleep" && !this.hop;
    this.zzz.texture = zzzTextures()[Math.floor(time * 1.5) % 3]!;
    this.zzz.position.set(Math.round(this.x + 4), Math.round(this.y - 12));
  }
}
