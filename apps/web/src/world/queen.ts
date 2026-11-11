/**
 * The prom queen: a teammate who works without a coding agent. She strolls between the
 * kitchen, lounge and meeting room, and every minute or so walks up behind someone whose
 * agent is busy (waiting ones first), pages them and gets an answer from the chair.
 */
import { seededRandom } from "@agent-office/protocol";
import { type Container, Sprite } from "pixi.js";
import { textBubbleTexture } from "../art/fun.ts";
import { C } from "../art/palette.ts";
import { QUEEN, queenTextures } from "../art/queen.ts";
import type { Effects } from "./effects.ts";
import { type AreaName, type OfficeMap, type Point, TILE } from "./map.ts";
import { findPath } from "./pathing.ts";

export type PageTarget = Point & { id: string; waiting: boolean };

const STROLL: readonly AreaName[] = ["kitchen", "lounge", "meeting"];
const PAGES = ["STATUS?", "ETA?", "IS IT SHIPPED?", "STANDUP IN 5!", "TICKET UPDATED?"];
const NUDGES = ["YOUR AGENT IS WAITING!", "ANSWER IT. NOW.", "IT ASKED YOU A QUESTION!"];
const REPLIES = ["ON IT!", "5 MORE MINUTES!", "ALMOST DONE!", "IT'S COMPILING!", "YES BOSS!"];
const CLICKED = ["BEEP BEEP!", "TIARA STAYS ON.", "ROSES ARE BLACK.", "PAGING YOU."];

export class OfficeQueen {
  readonly sprite: Sprite;
  x: number;
  y: number;
  private path: Point[] = [];
  private mode: "stand" | "walk" | "page" = "stand";
  private timer = 4;
  private facing: "down" | "up" | "left" | "right" = "down";
  private rand = seededRandom("queen");
  private heading: PageTarget | null = null;
  private pageCooldown = 20;
  private talkCooldown = 0;
  /** seconds between pages (shorter in the party demo) */
  pageEvery = 50;

  constructor(
    objects: Container,
    private map: OfficeMap,
    private readonly effects: Effects,
    private readonly pageable: () => PageTarget[],
    private readonly answer: (id: string, text: string) => void,
  ) {
    this.sprite = new Sprite(queenTextures()[0]!);
    this.sprite.anchor.set(0.5, 23 / 24);
    this.sprite.label = "actor";
    objects.addChild(this.sprite);
    const home = this.strollSpot() ?? { x: 40 * TILE, y: 16 * TILE };
    this.x = home.x;
    this.y = home.y;
  }

  setMap(map: OfficeMap) {
    this.map = map;
    this.path = [];
    this.mode = "stand";
    this.timer = 1;
  }

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.rand() * list.length)]!;
  }

  private walkable(p: Point) {
    return this.map.isWalkable(Math.floor(p.x / TILE), Math.floor(p.y / TILE));
  }

  private strollSpot(): Point | null {
    const areas = this.map.areas.filter((a) => STROLL.includes(a.name));
    for (let tries = 0; tries < 20 && areas.length; tries++) {
      const a = this.pick(areas);
      const tx = a.x + Math.floor(this.rand() * a.w);
      const ty = a.y + Math.floor(this.rand() * a.h);
      if (this.map.isWalkable(tx, ty)) return { x: tx * TILE + 8, y: ty * TILE + 12 };
    }
    return null;
  }

  /** Behind the chair, a step to the side, so she reads over their shoulder. */
  private behind(s: Point): Point | null {
    for (const c of [
      { x: s.x + 12, y: s.y + 10 },
      { x: s.x - 12, y: s.y + 10 },
      { x: s.x, y: s.y + 14 },
      { x: s.x + 14, y: s.y },
      { x: s.x - 14, y: s.y },
    ]) {
      if (this.walkable(c)) return c;
    }
    return null;
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

  private next() {
    this.heading = null;
    if (this.pageCooldown <= 0) {
      const all = this.pageable();
      const waiting = all.filter((t) => t.waiting);
      const pool = waiting.length ? waiting : all;
      if (pool.length) {
        const t = this.pick(pool);
        const spot = this.behind(t);
        if (spot && this.goTo(spot)) {
          this.heading = t;
          return;
        }
      }
    }
    const spot = this.strollSpot();
    if (!spot || !this.goTo(spot)) {
      this.mode = "stand";
      this.timer = 4;
    }
  }

  private say(text: string, color: string = C.berry) {
    this.effects.floater(textBubbleTexture(text, color), this.x, this.y - 28, 2.8, 8);
  }

  private startPage(t: PageTarget) {
    this.mode = "page";
    this.timer = 3.2;
    this.pageCooldown = this.pageEvery * (0.7 + this.rand() * 0.6);
    this.say("BEEP BEEP!", C.red);
    const line = t.waiting ? this.pick(NUDGES) : this.pick(PAGES);
    this.effects.after(1, () => this.say(line));
    this.effects.after(2.2, () => this.answer(t.id, this.pick(REPLIES)));
  }

  /** Clicked: a beep and a line. */
  poke() {
    if (this.talkCooldown > 0) return;
    this.talkCooldown = 1.5;
    this.say(this.pick(CLICKED));
    if (this.mode === "stand") {
      this.mode = "page";
      this.timer = 1.6;
    }
  }

  hit(wx: number, wy: number) {
    return Math.abs(wx - this.x) <= 9 && wy >= this.y - 24 && wy <= this.y + 2;
  }

  private stepPath(dt: number, speed: number) {
    let budget = speed * dt;
    while (budget > 0 && this.path.length) {
      const wp = this.path[0]!;
      const dx = wp.x - this.x;
      const dy = wp.y - this.y;
      const d = Math.hypot(dx, dy);
      if (Math.abs(dx) > Math.abs(dy)) this.facing = dx < 0 ? "left" : "right";
      else if (Math.abs(dy) > 0.5) this.facing = dy < 0 ? "up" : "down";
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
    const frames = queenTextures();
    this.pageCooldown -= dt;
    this.talkCooldown -= dt;
    let set: readonly number[] = QUEEN.idle;
    let fps = 1;
    if (this.mode === "walk") {
      this.stepPath(dt, this.heading ? 34 : 24);
      set =
        this.facing === "up"
          ? QUEEN.walkUp
          : this.facing === "left"
            ? QUEEN.walkLeft
            : this.facing === "right"
              ? QUEEN.walkRight
              : QUEEN.walkDown;
      fps = 6;
      if (this.path.length === 0) {
        const t = this.heading && this.pageable().find((p) => p.id === this.heading?.id);
        if (t) this.startPage(t);
        else {
          this.mode = "stand";
          this.timer = 6 + this.rand() * 14;
        }
      }
    } else {
      if (this.mode === "page") {
        set = QUEEN.page;
        fps = 5;
      }
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.mode === "page") {
          this.mode = "stand";
          this.timer = 2 + this.rand() * 3;
        } else this.next();
      }
    }
    this.sprite.texture = frames[set[Math.floor(time * fps) % set.length]!]!;
    this.sprite.position.set(Math.round(this.x), Math.round(this.y));
    this.sprite.zIndex = this.y;
  }
}
