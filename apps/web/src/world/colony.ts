/**
 * The office cats: one, plus one for every two people (`catCount`), up to MAX_CATS. Every
 * viewer sees cat #k with the same name and coat; new cats walk in through the main door and
 * surplus cats walk out of it. On top of those live the residents (`RESIDENTS`, slots MAX_CATS
 * and up), always in: Cece and Jess, always hungry, take turns begging working agents for
 * treats and, at mealtimes, for a proper meal; Kiwi has the zoomies; Eloy goes from dev to dev
 * and meows at every one of them. Also owns the cat toys viewers drop: food bowls, yarn balls
 * and the laser dot.
 */
import { CAT_SLOTS, MAX_CATS, seededRandom } from "@agent-office/protocol";
import { type Container, Sprite } from "pixi.js";
import { bowlTextures, laserTextures, treatTexture, yarnTextures } from "../art/fun.ts";
import { CAT_COATS, type CatCoat, RESIDENT_COATS } from "../art/fx.ts";
import { type CatTrait, OfficeCat, type Perch, type WaitSpot } from "./cat.ts";
import type { Effects } from "./effects.ts";
import {
  catAnswer,
  catBegLabel,
  catBegLine,
  catMealFor,
  eloyAnswer,
  eloyLabel,
  eloyMeow,
} from "./lifeRules.ts";
import { type OfficeMap, type Point, TILE } from "./map.ts";

export const CAT_NAMES = [
  "Miso",
  "Pixel",
  "Byte",
  "Tofu",
  "Nori",
  "Mochi",
  "Sudo",
  "Ziggy",
  "Cookie",
  "Linus",
] as const;
/** Coat per slot (index into CAT_COATS). */
const SLOT_COATS = [0, 1, 2, 3, 4, 5, 6, 2, 1, 5] as const;
/** Home tile per slot: lounge, kitchen, game corner, garden, meeting room ... */
const HOME_TILES: readonly Point[] = [
  { x: 45, y: 8 },
  { x: 39, y: 9 },
  { x: 44, y: 26 },
  { x: 55, y: 16 },
  { x: 36, y: 17 },
  { x: 44, y: 9 },
  { x: 61, y: 9 },
  { x: 38, y: 19 },
  { x: 35, y: 25 },
  { x: 54, y: 24 },
];

/**
 * The resident cats, in slot order from MAX_CATS: Cece and Jess hang around the fridge, Kiwi
 * in the game corner, Eloy in the lounge next to the desks.
 */
export const RESIDENTS: readonly { name: string; coat: CatCoat; home: Point; trait: CatTrait }[] = [
  { name: "Cece", coat: RESIDENT_COATS.cece, home: { x: 35, y: 5 }, trait: "hungry" },
  { name: "Jess", coat: RESIDENT_COATS.jess, home: { x: 36, y: 6 }, trait: "hungry" },
  { name: "Kiwi", coat: RESIDENT_COATS.kiwi, home: { x: 43, y: 25 }, trait: "zoomies" },
  { name: "Eloy", coat: RESIDENT_COATS.eloy, home: { x: 46, y: 9 }, trait: "chatty" },
];

/** An agent a resident cat can beg from: a seated person with a working or waiting agent. */
export type BegTarget = WaitSpot;

export type ColonyHooks = {
  idleSpots: () => Point[];
  waitSpots: () => WaitSpot[];
  /** where a cat sent to this person sits */
  perchFor: (personId: string, pick: number) => Perch | null;
  personName: (personId: string) => string;
  /** a sent cat arrived at someone's desk */
  onVisit?: (personId: string) => void;
  /** agents the resident cats beg from (`id` = session id) */
  begTargets?: () => BegTarget[];
  /** every dev at a desk (`id` = session id): Eloy meows at all of them, agent busy or not */
  devs?: () => BegTarget[];
  /** who sits at that agent (for the cat card) */
  agentName?: (sessionId: string) => string;
  /** the agent's person answers a begging cat */
  agentSays?: (sessionId: string, text: string) => void;
};

/** Seconds between two begging rounds of a resident cat (after giving up a bit sooner). */
const BEG_GAP: readonly [number, number] = [10, 22];
const BEG_GAP_REFUSED: readonly [number, number] = [5, 10];
/** How long a resident cat sits up next to an agent before it answers. */
const BEG_STAY: readonly [number, number] = [8, 13];
/** Eloy: a meow every this many seconds at a dev, this long per dev, this long in between. */
const ELOY_EVERY: readonly [number, number] = [1, 1.5];
const ELOY_STAY: readonly [number, number] = [6, 10];
const ELOY_GAP: readonly [number, number] = [2, 5];

type Bowl = { sprite: Sprite; food: number; t: number; emptyAt: number | null };
type Yarn = {
  sprite: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  /** tossed in an arc first */
  air: { from: Point; t: number; dur: number } | null;
  roll: number;
};
type Dot = {
  sprite: Sprite;
  x: number;
  y: number;
  tx: number;
  ty: number;
  pause: number;
  t: number;
};

const BOWL_FOOD_S = 9;
const BOWL_MAX_S = 45;
const YARN_S = 14;
/** Bowls and yarn balls on the floor at once, each; a new one drops the oldest (viewers can spam). */
export const MAX_TOYS = 6;
const LASER_S = 7;

export class CatColony {
  /** cat per slot (null = no cat in that slot right now) */
  private slots: (OfficeCat | null)[] = Array.from({ length: CAT_SLOTS }, () => null);
  /** cats walking out of the office */
  private leaving: OfficeCat[] = [];
  private bowls: Bowl[] = [];
  private yarns: Yarn[] = [];
  private dot: Dot | null = null;
  private rand = seededRandom("colony");
  private synced = false;
  /** chance a finished helper nearby gets eaten, and how far a cat dashes for one */
  private eatChance = 0.25;
  private eatRange = 220;
  /** resident slot -> seconds until it goes begging again */
  private begIn = new Map<number, number>();
  /** resident slot -> the agent (session id) it begs from or just begged from */
  private begAt = new Map<number, string>();
  /** Eloy: seconds until he walks over to the next dev, and the devs he meowed at this round */
  private chatIn = new Map<number, number>();
  private chatted = new Map<number, Set<string>>();
  /** office hour (mealtimes); main.ts wires the office clock */
  clock: () => number = () => 10;

  constructor(
    private readonly objects: Container,
    private readonly fx: Container,
    private map: OfficeMap,
    private readonly effects: Effects,
    private readonly hooks: ColonyHooks,
  ) {
    this.spawn(0, false);
    RESIDENTS.forEach((r, i) => {
      this.spawn(MAX_CATS + i, false);
      if (r.trait === "hungry") this.begIn.set(MAX_CATS + i, 6 + i * 7 + this.rand() * 6);
      if (r.trait === "chatty") this.chatIn.set(MAX_CATS + i, 3 + this.rand() * 3);
    });
  }

  /** How hungry the cats are for finished helper bots (the party demo makes them greedy). */
  setHunting(chance: number, range: number) {
    this.eatChance = chance;
    this.eatRange = range;
    for (const c of this.all()) {
      c.eatChance = chance;
      c.eatRange = range;
    }
  }

  setMap(map: OfficeMap) {
    this.map = map;
    for (const c of this.all()) c.setMap(map);
  }

  /** Cats in the office (not the ones walking out). */
  cats(): OfficeCat[] {
    return this.slots.filter((c): c is OfficeCat => c !== null);
  }

  get(slot: number | undefined): OfficeCat | null {
    return this.slots[slot ?? 0] ?? null;
  }

  private all(): OfficeCat[] {
    return [...this.cats(), ...this.leaving];
  }

  /** Grow or shrink to `count` cats; the first sync places them without the parade. */
  sync(count: number) {
    const want = Math.max(1, Math.min(MAX_CATS, count));
    const instant = !this.synced;
    this.synced = true;
    for (let slot = 0; slot < MAX_CATS; slot++) {
      const cat = this.slots[slot];
      if (slot < want && !cat) this.spawn(slot, !instant);
      else if (slot >= want && cat) {
        this.slots[slot] = null;
        if (instant) cat.destroy();
        else {
          cat.leave(this.outside());
          this.leaving.push(cat);
        }
      }
    }
  }

  private spawn(slot: number, walkIn: boolean) {
    const resident = slot >= MAX_CATS ? RESIDENTS[slot - MAX_CATS]! : null;
    const t = this.nearestWalkable(resident?.home ?? HOME_TILES[slot]!);
    const home =
      slot === 0
        ? { x: t.x * TILE + 4, y: t.y * TILE + 12 }
        : { x: t.x * TILE + 8, y: t.y * TILE + 12 };
    const spec = resident
      ? { slot, name: resident.name, coat: resident.coat, home, trait: resident.trait }
      : { slot, name: CAT_NAMES[slot]!, coat: CAT_COATS[SLOT_COATS[slot]!]!, home };
    const cat = new OfficeCat(
      spec,
      this.objects,
      this.fx,
      this.map,
      this.hooks.idleSpots,
      this.effects,
      () => this.freeWaitSpots(cat),
      walkIn ? this.outside() : null,
    );
    cat.eatChance = this.eatChance;
    cat.eatRange = this.eatRange;
    this.slots[slot] = cat;
  }

  /** Long waiters no other cat is already on its way to or sitting with. */
  private freeWaitSpots(me: OfficeCat): WaitSpot[] {
    const all = this.hooks.waitSpots();
    if (all.length === 0) return all;
    const taken = new Set<string>();
    for (const c of this.cats()) {
      if (c === me) continue;
      if (c.guarding) taken.add(c.guarding);
      if (c.heading) taken.add(c.heading);
    }
    return all.filter((w) => !taken.has(w.id));
  }

  /** Just outside the main door (pixels). */
  private outside(): Point {
    const s = this.map.spawn;
    return { x: (s.x + 1) * TILE, y: s.y * TILE + 12 };
  }

  private nearestWalkable(tile: Point): Point {
    if (this.map.isWalkable(tile.x, tile.y)) return tile;
    for (let r = 1; r < 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.map.isWalkable(tile.x + dx, tile.y + dy))
            return { x: tile.x + dx, y: tile.y + dy };
        }
      }
    }
    return tile;
  }

  private walkablePx(p: Point) {
    return this.map.isWalkable(Math.floor(p.x / TILE), Math.floor((p.y - 2) / TILE));
  }

  /** Topmost cat under a world point. */
  hit(wx: number, wy: number): OfficeCat | null {
    let best: OfficeCat | null = null;
    for (const c of this.cats()) if (c.hit(wx, wy) && (!best || c.y > best.y)) best = c;
    return best;
  }

  /** A finished helper bot: the nearest free cat may pounce (one chance per bot). */
  tryEat(sprite: Sprite, x: number, y: number): boolean {
    let best: OfficeCat | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const c of this.cats()) {
      if (c.busy || c.guarding || c.heading) continue;
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    }
    return best?.tryEat(sprite, x, y) ?? false;
  }

  /** Friday meeting: the first cat is the boss. */
  setBoss(spot: Point | null) {
    this.get(0)?.setBoss(spot);
  }

  /** Is any cat near the door (it opens for them)? */
  nearDoor(door: Point): boolean {
    for (const c of this.all())
      if (Math.abs(c.x - door.x) < 22 && Math.abs(c.y - door.y) < 26) return true;
    return false;
  }

  /** A random cat in the office (sending a cat to someone). */
  randomSlot(): number {
    const cats = this.cats();
    return cats[Math.floor(Math.random() * cats.length)]?.slot ?? 0;
  }

  /** A free floor spot next to a cat, where a bowl or a yarn ball lands. */
  dropSpot(slot: number): Point {
    const c = this.get(slot) ?? this.get(0)!;
    for (const [dx, dy] of [
      [16, 4],
      [-16, 4],
      [0, 14],
      [12, 14],
      [-12, 14],
      [0, -12],
    ] as const) {
      const p = { x: Math.round(c.x + dx), y: Math.round(c.y + dy) };
      if (this.walkablePx(p)) return p;
    }
    return { x: Math.round(c.x), y: Math.round(c.y) };
  }

  /** Free cats nearest to a point, the asked-for one first. */
  private crew(slot: number | undefined, at: Point, n: number, range: number): OfficeCat[] {
    const first = slot === undefined ? null : this.get(slot);
    const others = this.cats()
      .filter((c) => c !== first && !c.busy && Math.hypot(c.x - at.x, c.y - at.y) <= range)
      .sort((a, b) => Math.hypot(a.x - at.x, a.y - at.y) - Math.hypot(b.x - at.x, b.y - at.y));
    return [...(first ? [first] : []), ...others].slice(0, n);
  }

  // ---- toys ---------------------------------------------------------------------------------
  /** A food bowl at `spot`: the cat comes to eat, up to two hungry neighbours join. */
  feed(slot: number | undefined, spot: Point) {
    const sprite = new Sprite(bowlTextures()[0]!);
    sprite.anchor.set(0.5, 1);
    sprite.position.set(Math.round(spot.x), Math.round(spot.y));
    sprite.zIndex = spot.y - 2;
    this.objects.addChild(sprite);
    const bowl: Bowl = { sprite, food: BOWL_FOOD_S, t: 0, emptyAt: null };
    while (this.bowls.length >= MAX_TOYS) {
      const old = this.bowls.shift()!;
      old.food = 0; // its eaters finish up
      old.sprite.destroy();
    }
    this.bowls.push(bowl);
    this.effects.puff(spot.x, spot.y - 3);
    const seats = [
      { x: spot.x - 11, y: spot.y + 1 },
      { x: spot.x + 11, y: spot.y + 1 },
      { x: spot.x, y: spot.y + 9 },
    ].map((p) => (this.walkablePx(p) ? p : { x: spot.x, y: spot.y + 2 }));
    this.crew(slot, spot, 3, 320).forEach((cat, i) => {
      cat.assign({
        kind: "eat",
        spot: seats[i]!,
        bowl: spot,
        food: (dt) => {
          bowl.food -= dt;
          return bowl.food > 0;
        },
      });
    });
  }

  /** A yarn ball tossed next to the cat; it and a playmate bat it around the floor. */
  yarn(slot: number | undefined, spot: Point) {
    const sprite = new Sprite(yarnTextures()[0]!);
    sprite.anchor.set(0.5, 1);
    this.objects.addChild(sprite);
    const side = this.rand() < 0.5 ? -1 : 1;
    const y: Yarn = {
      sprite,
      x: spot.x,
      y: spot.y,
      vx: 0,
      vy: 0,
      t: 0,
      air: { from: { x: spot.x + side * 40, y: spot.y - 50 }, t: 0, dur: 0.55 },
      roll: 0,
    };
    while (this.yarns.length >= MAX_TOYS) {
      const old = this.yarns.shift()!;
      old.t = YARN_S + 1; // its players lose interest
      old.sprite.destroy();
    }
    this.yarns.push(y);
    for (const cat of this.crew(slot, spot, 2, 320)) {
      cat.assign({
        kind: "chase",
        label: "playing with yarn",
        // while it is still in the air, run to where it will land
        target: () => (y.t >= YARN_S ? null : y.air ? spot : { x: y.x, y: y.y }),
        onReach: (c) => {
          if (y.air) return;
          // bat it away from the cat, a bit to the side
          const a = Math.atan2(y.y - c.y, y.x - c.x) + (this.rand() - 0.5) * 1.6;
          const v = 70 + this.rand() * 50;
          y.vx = Math.cos(a) * v;
          y.vy = Math.sin(a) * v * 0.7;
        },
      });
    }
  }

  /** The laser dot: it darts around the floor and the nearest cats chase it. */
  laser(slot: number | undefined, spot: Point) {
    if (this.dot) this.removeDot();
    const sprite = new Sprite(laserTextures()[0]!);
    sprite.anchor.set(0.5);
    sprite.position.set(Math.round(spot.x), Math.round(spot.y));
    sprite.zIndex = 99999;
    this.objects.addChild(sprite);
    const dot: Dot = { sprite, x: spot.x, y: spot.y, tx: spot.x, ty: spot.y, pause: 0.6, t: 0 };
    this.dot = dot;
    for (const cat of this.crew(slot, spot, 3, 480)) {
      cat.assign({
        kind: "chase",
        label: "chasing the laser",
        target: () => (this.dot === dot && dot.t < LASER_S ? { x: dot.x, y: dot.y } : null),
        onReach: () => this.dart(dot, 50, 90),
      });
    }
  }

  /** Send a cat to sit with someone (on their desk when they sit at one). */
  visit(slot: number | undefined, personId: string) {
    const cat = this.get(slot) ?? this.cats()[0];
    if (!cat) return;
    const perch = this.hooks.perchFor(personId, cat.slot);
    if (!perch) return;
    cat.assign({
      kind: "visit",
      perch,
      who: this.hooks.personName(personId),
      stay: 60,
      onArrive: () => this.hooks.onVisit?.(personId),
    });
  }

  /** The dot zips to a new spot `min..max` px away (somewhere on the floor). */
  private dart(dot: Dot, min: number, max: number) {
    for (let i = 0; i < 10; i++) {
      const a = this.rand() * Math.PI * 2;
      const r = min + this.rand() * (max - min);
      const p = { x: dot.x + Math.cos(a) * r, y: dot.y + Math.sin(a) * r * 0.7 };
      if (this.walkablePx(p)) {
        dot.tx = p.x;
        dot.ty = p.y;
        dot.pause = 0;
        return;
      }
    }
  }

  private removeDot() {
    this.dot?.sprite.destroy();
    this.dot = null;
  }

  // ---- Eloy ---------------------------------------------------------------------------------
  /** Eloy, when free and his break is over, walks to the next dev and meows at them. */
  private updateChatter(dt: number) {
    const devs = this.hooks.devs;
    if (!devs) return;
    for (const [slot, left] of this.chatIn) {
      const cat = this.get(slot);
      if (!cat || cat.busy || cat.guarding || cat.heading) continue;
      if (left > 0) {
        this.chatIn.set(slot, left - dt);
        continue;
      }
      this.chatIn.set(slot, this.between(ELOY_GAP));
      this.chatAt(cat, devs());
    }
  }

  /** The next dev on Eloy's round (everyone once, then round again), not one a beggar is at. */
  private chatAt(cat: OfficeCat, all: BegTarget[]) {
    const taken = new Set<string>();
    for (const [slot, id] of this.begAt) if (this.get(slot)?.busy) taken.add(id);
    const free = all.filter((t) => !taken.has(t.id));
    if (free.length === 0) return;
    let done = this.chatted.get(cat.slot);
    if (!done) {
      done = new Set();
      this.chatted.set(cat.slot, done);
    }
    let pool = free.filter((t) => !done.has(t.id));
    if (pool.length === 0) {
      // everyone heard him: a new round (just not the same dev twice in a row)
      const last = this.begAt.get(cat.slot);
      done.clear();
      pool = free.length > 1 ? free.filter((t) => t.id !== last) : free;
    }
    const target = pool[Math.floor(this.rand() * pool.length)]!;
    const who = this.hooks.agentName?.(target.id) ?? "a dev";
    const ok = cat.assign({
      kind: "beg",
      seat: { x: target.x, y: target.y },
      label: eloyLabel(who),
      ask: () => eloyMeow(this.rand()),
      every: ELOY_EVERY,
      stay: this.between(ELOY_STAY),
      still: () => (this.hooks.devs?.() ?? []).some((t) => t.id === target.id),
      onDone: (c, asked) => {
        if (asked) this.hooks.agentSays?.(target.id, eloyAnswer(c.name, this.rand()));
      },
    });
    if (ok) {
      done.add(target.id);
      this.begAt.set(cat.slot, target.id);
    }
  }

  // ---- Cece and Jess ----------------------------------------------------------------------
  /** Free resident cats whose break is over go and beg the next agent. */
  private updateBegging(dt: number) {
    const targets = this.hooks.begTargets;
    if (!targets) return;
    for (const [slot, left] of this.begIn) {
      const cat = this.get(slot);
      if (!cat || cat.busy || cat.guarding || cat.heading) continue;
      if (left > 0) {
        this.begIn.set(slot, left - dt);
        continue;
      }
      this.begIn.set(slot, this.between(BEG_GAP));
      this.beg(cat, targets());
    }
  }

  private between([lo, hi]: readonly [number, number]) {
    return lo + this.rand() * (hi - lo);
  }

  /** Pick an agent the other resident isn't working on (not the last one, if possible). */
  private beg(cat: OfficeCat, all: BegTarget[]) {
    const last = this.begAt.get(cat.slot);
    const taken = new Set<string>();
    for (const [slot, id] of this.begAt) {
      if (slot === cat.slot) continue;
      const other = this.get(slot);
      if (other?.busy) taken.add(id);
    }
    const free = all.filter((t) => !taken.has(t.id));
    const fresh = free.filter((t) => t.id !== last);
    const pool = fresh.length > 0 ? fresh : free;
    if (pool.length === 0) return;
    const target = pool[Math.floor(this.rand() * pool.length)]!;
    const meal = catMealFor(this.clock());
    const who = this.hooks.agentName?.(target.id) ?? "an agent";
    const ok = cat.assign({
      kind: "beg",
      seat: { x: target.x, y: target.y },
      label: catBegLabel(meal, who),
      ask: () => catBegLine(meal, this.rand()),
      stay: this.between(BEG_STAY),
      still: () => (this.hooks.begTargets?.() ?? []).some((t) => t.id === target.id),
      onDone: (c, asked) => {
        if (asked) this.answer(c, target, catMealFor(this.clock()));
      },
    });
    if (ok) this.begAt.set(cat.slot, target.id);
  }

  /** The agent gives in (a treat tossed over, or a full bowl at mealtimes), or doesn't. */
  private answer(cat: OfficeCat, agent: BegTarget, meal: ReturnType<typeof catMealFor>) {
    const a = catAnswer(meal, cat.name, this.rand(), this.rand());
    this.hooks.agentSays?.(agent.id, a.text);
    if (!a.give) {
      this.begIn.set(cat.slot, this.between(BEG_GAP_REFUSED));
      this.effects.after(1.2, () => cat.pout());
      return;
    }
    if (meal) {
      this.effects.after(0.8, () => {
        if (!cat.busy && !cat.leaving) this.feed(cat.slot, this.dropSpot(cat.slot));
      });
      return;
    }
    this.effects.after(0.5, () => {
      const to = { x: cat.x + (agent.x < cat.x ? -3 : 3), y: cat.y - 2 };
      this.effects.lob(treatTexture(), agent.x, agent.y - 14, to.x, to.y, () => cat.snack());
    });
  }

  update(dt: number, time: number) {
    this.updateBegging(dt);
    this.updateChatter(dt);
    for (const c of this.cats()) c.update(dt, time);
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const c = this.leaving[i]!;
      c.update(dt, time);
      if (c.gone) {
        c.destroy();
        this.leaving.splice(i, 1);
      }
    }
    this.updateBowls(dt);
    this.updateYarns(dt);
    this.updateDot(dt, time);
  }

  private updateBowls(dt: number) {
    for (let i = this.bowls.length - 1; i >= 0; i--) {
      const b = this.bowls[i]!;
      b.t += dt;
      b.sprite.texture = bowlTextures()[b.food > BOWL_FOOD_S / 2 ? 0 : b.food > 0 ? 1 : 2]!;
      if (b.food <= 0 && b.emptyAt === null) b.emptyAt = b.t;
      // licked clean (or nobody came): fade out
      const end = b.emptyAt === null ? BOWL_MAX_S : Math.min(BOWL_MAX_S, b.emptyAt + 3);
      b.sprite.alpha = Math.max(0, Math.min(1, end - b.t));
      if (b.t >= end) {
        b.sprite.destroy();
        this.bowls.splice(i, 1);
      }
    }
  }

  private updateYarns(dt: number) {
    for (let i = this.yarns.length - 1; i >= 0; i--) {
      const y = this.yarns[i]!;
      y.t += dt;
      if (y.air) {
        const a = y.air;
        a.t += dt;
        const k = Math.min(1, a.t / a.dur);
        const arc = Math.sin(k * Math.PI) * 26;
        y.sprite.position.set(
          Math.round(a.from.x + (y.x - a.from.x) * k),
          Math.round(a.from.y + (y.y - a.from.y) * k - arc),
        );
        y.sprite.zIndex = 99998;
        y.sprite.texture = yarnTextures()[Math.floor(a.t * 12) % 4]!;
        if (k >= 1) y.air = null;
        continue;
      }
      const nx = y.x + y.vx * dt;
      const ny = y.y + y.vy * dt;
      // bounce off walls and furniture
      if (!this.walkablePx({ x: nx, y: y.y })) y.vx = -y.vx * 0.6;
      else y.x = nx;
      if (!this.walkablePx({ x: y.x, y: ny })) y.vy = -y.vy * 0.6;
      else y.y = ny;
      const drag = Math.exp(-1.8 * dt);
      y.vx *= drag;
      y.vy *= drag;
      const speed = Math.hypot(y.vx, y.vy);
      y.roll += speed * dt * 0.25;
      y.sprite.texture = yarnTextures()[Math.floor(y.roll) % 4]!;
      y.sprite.position.set(Math.round(y.x), Math.round(y.y));
      y.sprite.zIndex = y.y - 1;
      y.sprite.alpha = Math.min(1, YARN_S + 1 - y.t);
      if (y.t > YARN_S + 1) {
        y.sprite.destroy();
        this.yarns.splice(i, 1);
      }
    }
  }

  private updateDot(dt: number, time: number) {
    const d = this.dot;
    if (!d) return;
    d.t += dt;
    if (d.t > LASER_S) {
      this.removeDot();
      return;
    }
    if (d.pause > 0) {
      d.pause -= dt;
      if (d.pause <= 0) this.dart(d, 24, 70);
    } else {
      const dx = d.tx - d.x;
      const dy = d.ty - d.y;
      const dist = Math.hypot(dx, dy);
      const step = 150 * dt;
      if (dist <= step) {
        d.x = d.tx;
        d.y = d.ty;
        d.pause = 0.25 + this.rand() * 0.6;
      } else {
        d.x += (dx / dist) * step;
        d.y += (dy / dist) * step;
      }
    }
    d.sprite.texture = laserTextures()[Math.floor(time * 14) % 2]!;
    d.sprite.position.set(Math.round(d.x), Math.round(d.y));
  }
}
