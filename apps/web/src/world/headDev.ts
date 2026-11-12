/**
 * The head of development: sits at the head desk next to the time clock, keeps everybody's
 * hours in check (cheers when someone punches in, walks over to nag someone now and then),
 * and every full hour the whole office jumps up, runs over, lines up in two lines and bows to
 * her one by one.
 */
import { seededRandom } from "@agent-office/protocol";
import type { Container } from "pixi.js";
import { C } from "../art/palette.ts";
import { headDevSheet } from "../art/residents.ts";
import type { Effects } from "./effects.ts";
import { HEAD_DESK, type OfficeMap, type Point, TILE } from "./map.ts";
import { hourCrossed, lineSpots } from "./residentRules.ts";
import { Walker } from "./walker.ts";

/** What the bow line needs from the session characters (CharacterManager). */
export type Bowers<T extends Point> = {
  rallyable(): T[];
  rallyTo(c: T, spot: Point): boolean;
  rallied(c: T): boolean;
  /** still in the line (false once offline, gone or evacuated) */
  inLine(c: T): boolean;
  bow(c: T, seconds: number): void;
  release(c: T): void;
  /** seated people (waiting ones flagged) she can nag about their hours */
  nagTargets(): (Point & { id: string; waiting: boolean })[];
  answer(id: string, text: string): void;
};

const NAGS = ["HOURS BOOKED?", "TIMESHEET!", "BOOK YOUR HOURS!", "WHICH TICKET?", "CLOCK IN!"];
const EXCUSES = ["TOMORROW!", "ALREADY DID!", "UHH... YES?", "FRIDAY, PROMISE!", "DOING IT NOW!"];
const PUNCHED = ["FINALLY!", "THANK YOU!", "TICKET NUMBER?", "SEE? EASY.", "GOOD."];
const CLICKED = ["HOURS BOOKED?", "I SEE YOUR TIMESHEET.", "BOOK. YOUR. HOURS.", "NEXT!"];
const RITUAL_START = ["OH NO. AGAIN?", "IT'S ON THE HOUR...", "NOT THIS AGAIN."];
const RITUAL_NODS = ["NOTED.", "GOOD.", "HOURS?", "RISE."];
const BOW_S = 1;
const GAP_S = 0.3;
/** someone at the front who never arrives is skipped after this long */
const FRONT_WAIT_S = 20;
const RITUAL_MAX_S = 180;

type Member<T> = { c: T; since: number };
type Ritual<T> = {
  lines: Member<T>[][];
  spots: Point[][];
  t: number;
  turn: number;
  bowing: { line: number; t: number } | null;
  gap: number;
  bows: number;
};

export class HeadDev<T extends Point> {
  readonly walker: Walker;
  private mode: "desk" | "nag" | "linger" | "back" = "desk";
  private rand = seededRandom("head-dev");
  private nagIn = 40;
  private nagTarget: { id: string } | null = null;
  private talkCooldown = 0;
  private punchCooldown = 0;
  private lastHour: number | null = null;
  private pending = false;
  private ritual: Ritual<T> | null = null;
  /** seconds between nags (shorter in the party demo) */
  nagEvery = 90;
  /** `?bow=1`: a bow line this often (seconds) instead of on the full hour */
  bowEvery: number | null = null;
  private bowIn = 8;
  private lingerT = 0;

  constructor(
    objects: Container,
    private map: OfficeMap,
    private readonly effects: Effects,
    private readonly bowers: Bowers<T>,
    private readonly hour: () => number,
  ) {
    this.walker = new Walker(objects, headDevSheet(), map, effects, this.seat());
    this.walker.pose = "sitFront";
  }

  /** Behind the head desk, facing the room. */
  private seat(): Point {
    return { x: (HEAD_DESK.x + 1) * TILE + 8, y: HEAD_DESK.y * TILE - 3 };
  }

  private pick<T2>(list: readonly T2[]): T2 {
    return list[Math.floor(this.rand() * list.length)]!;
  }

  setMap(map: OfficeMap) {
    this.map = map;
    this.walker.map = map;
  }

  get y() {
    return this.walker.y;
  }
  hit(wx: number, wy: number) {
    return this.walker.hit(wx, wy);
  }

  poke() {
    if (this.talkCooldown > 0) return;
    this.talkCooldown = 1.5;
    this.walker.say(this.pick(CLICKED), C.wine);
  }

  /** Someone punched their hours at the time clock. */
  punched(x: number, y: number) {
    this.effects.sparkle(x, y - 26);
    if (this.punchCooldown > 0 || this.ritual) return;
    this.punchCooldown = 6;
    this.walker.say(this.pick(PUNCHED), C.forest);
  }

  /** Start the bow line now (she walks back to her desk first if she is away). */
  summon() {
    if (this.ritual) return;
    this.pending = true;
    if (this.mode !== "desk") this.goBack();
  }

  private goBack() {
    this.nagTarget = null;
    this.mode = this.walker.goTo(this.seat()) ? "back" : "desk";
    if (this.mode === "desk") this.sitDown();
  }

  private sitDown() {
    const w = this.walker;
    const s = this.seat();
    w.x = s.x;
    w.y = s.y;
    w.path = [];
    w.facing = "down";
    w.pose = "sitFront";
    this.mode = "desk";
  }

  private begin() {
    this.pending = false;
    const desk = { x: (HEAD_DESK.x + 1) * TILE + 8, y: (HEAD_DESK.y + 1) * TILE };
    const all = this.bowers
      .rallyable()
      .sort(
        (a, b) => Math.hypot(a.x - desk.x, a.y - desk.y) - Math.hypot(b.x - desk.x, b.y - desk.y),
      );
    if (all.length === 0) return;
    const fronts = [
      { x: HEAD_DESK.x, y: HEAD_DESK.y + 1 },
      { x: HEAD_DESK.x + 2, y: HEAD_DESK.y + 1 },
    ];
    const split: T[][] = [[], []];
    for (const [i, c] of all.entries()) split[i % 2]!.push(c);
    const tiles = lineSpots(
      this.map,
      fronts,
      split.map((l) => l.length),
    );
    const spots = tiles.map((l) => l.map((t) => ({ x: t.x * TILE + 8, y: t.y * TILE + 13 })));
    const lines: Member<T>[][] = [[], []];
    split.forEach((list, li) => {
      list.forEach((c, k) => {
        const spot = spots[li]![k];
        if (spot && this.bowers.rallyTo(c, spot)) lines[li]!.push({ c, since: 0 });
      });
    });
    if (lines.every((l) => l.length === 0)) return;
    this.ritual = { lines, spots, t: 0, turn: 0, bowing: null, gap: 2, bows: 0 };
    this.walker.say(this.pick(RITUAL_START), C.wine);
  }

  /** Everyone behind walks up to their (new) place. */
  private moveUp(r: Ritual<T>, li: number) {
    r.lines[li]!.forEach((m, k) => {
      const spot = r.spots[li]![k];
      if (spot) this.bowers.rallyTo(m.c, spot);
    });
  }

  private end() {
    const r = this.ritual;
    if (!r) return;
    for (const line of r.lines) for (const m of line) this.bowers.release(m.c);
    this.ritual = null;
    this.walker.pose = "sitFront";
    this.walker.say("AS YOU WERE.", C.wine);
  }

  private ritualStep(r: Ritual<T>, dt: number) {
    r.t += dt;
    r.lines.forEach((line, li) => {
      const kept = line.filter((m) => this.bowers.inLine(m.c));
      if (kept.length !== line.length) {
        r.lines[li] = kept;
        this.moveUp(r, li);
      }
    });
    if (r.t > RITUAL_MAX_S || r.lines.every((l) => l.length === 0)) {
      this.end();
      return;
    }
    if (r.bowing) {
      r.bowing.t -= dt;
      if (r.bowing.t > 0) return;
      const line = r.lines[r.bowing.line]!;
      const done = line.shift();
      if (done) this.bowers.release(done.c);
      this.moveUp(r, r.bowing.line);
      r.bowing = null;
      r.gap = GAP_S;
      this.walker.pose = "sitFront";
      return;
    }
    r.gap -= dt;
    if (r.gap > 0) return;
    for (let k = 0; k < r.lines.length; k++) {
      const li = (r.turn + k) % r.lines.length;
      const front = r.lines[li]![0];
      if (!front) continue;
      if (this.bowers.rallied(front.c)) {
        this.bowers.bow(front.c, BOW_S);
        r.bowing = { line: li, t: BOW_S + 0.15 };
        r.turn = li + 1;
        r.bows++;
        this.walker.pose = "raiseHand";
        if (r.bows % 4 === 1) this.walker.say(this.pick(RITUAL_NODS), C.wine, 1.4);
        return;
      }
      front.since += dt;
      if (front.since > FRONT_WAIT_S) {
        r.lines[li]!.shift();
        this.bowers.release(front.c);
        this.moveUp(r, li);
      }
    }
  }

  private nag() {
    const all = this.bowers.nagTargets();
    const busy = all.filter((t) => !t.waiting);
    const pool = busy.length ? busy : all;
    if (!pool.length) return false;
    const t = this.pick(pool);
    for (const spot of [
      { x: t.x + 12, y: t.y + 10 },
      { x: t.x - 12, y: t.y + 10 },
      { x: t.x, y: t.y + 14 },
    ]) {
      if (!this.map.isWalkable(Math.floor(spot.x / TILE), Math.floor(spot.y / TILE))) continue;
      if (this.walker.goTo(spot)) {
        this.nagTarget = { id: t.id };
        this.mode = "nag";
        return true;
      }
    }
    return false;
  }

  update(dt: number, time: number) {
    this.talkCooldown -= dt;
    this.punchCooldown -= dt;
    const hour = this.hour();
    if (this.bowEvery !== null) {
      this.bowIn -= dt;
      if (this.bowIn <= 0) {
        this.bowIn = this.bowEvery;
        this.summon();
      }
    } else if (hourCrossed(this.lastHour, hour)) this.summon();
    this.lastHour = hour;

    const w = this.walker;
    switch (this.mode) {
      case "desk":
        if (this.ritual) this.ritualStep(this.ritual, dt);
        else if (this.pending) this.begin();
        else {
          this.nagIn -= dt;
          if (this.nagIn <= 0) {
            this.nagIn = this.nagEvery * (0.7 + this.rand() * 0.6);
            if (this.nag()) w.say("BRB.", C.wine, 1.4);
          }
        }
        break;
      case "nag":
        if (!w.walking) {
          const id = this.nagTarget?.id;
          w.pose = null;
          w.facing = "up";
          w.say(this.pick(NAGS), C.wine);
          if (id) this.effects.after(1.4, () => this.bowers.answer(id, this.pick(EXCUSES)));
          this.nagTarget = null;
          this.mode = "linger";
          this.lingerT = 3;
        }
        break;
      case "linger":
        this.lingerT -= dt;
        if (this.lingerT <= 0) this.goBack();
        break;
      case "back":
        if (!w.walking) this.sitDown();
        break;
    }
    w.update(dt, time, this.pending ? 70 : 38);
  }
}
