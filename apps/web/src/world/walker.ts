/**
 * A character without a session (residents, clients): an HD sheet sprite that walks a tile
 * path, plays one animation at a time and says things in speech bubbles.
 */
import { type Container, Sprite } from "pixi.js";
import type { AnimName, CharacterSheet } from "../art/characters.ts";
import { textBubbleTexture } from "../art/fun.ts";
import { C } from "../art/palette.ts";
import type { Effects } from "./effects.ts";
import { type Facing, type OfficeMap, type Point, TILE } from "./map.ts";
import { findPath } from "./pathing.ts";

const STAND: Record<Facing, AnimName> = {
  down: "idleDown",
  up: "idleUp",
  left: "idleLeft",
  right: "idleRight",
};
const WALK: Record<Facing, AnimName> = {
  down: "walkDown",
  up: "walkUp",
  left: "walkLeft",
  right: "walkRight",
};

export class Walker {
  readonly sprite: Sprite;
  x: number;
  y: number;
  facing: Facing = "down";
  path: Point[] = [];
  /** what to play while not walking (null: stand facing `facing`) */
  pose: AnimName | null = null;
  /** z bias, e.g. -10 to stay behind the desk while seated */
  zBias = 0;

  constructor(
    layer: Container,
    public sheet: CharacterSheet,
    public map: OfficeMap,
    private readonly effects: Effects,
    at: Point,
  ) {
    this.sprite = new Sprite(sheet.anims.idleDown[0]!);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.label = "actor";
    layer.addChild(this.sprite);
    this.x = at.x;
    this.y = at.y;
  }

  get walking() {
    return this.path.length > 0;
  }

  /** Path over walkable tiles to a pixel spot (the last step goes straight to it). */
  goTo(target: Point): boolean {
    const from = { x: Math.floor(this.x / TILE), y: Math.floor((this.y - 4) / TILE) };
    const to = { x: Math.floor(target.x / TILE), y: Math.floor((target.y - 4) / TILE) };
    const tiles = findPath(this.map, from, to);
    if (!tiles) return false;
    this.path = tiles.slice(1).map((t) => ({ x: t.x * TILE + 8, y: t.y * TILE + 13 }));
    this.path.push(target);
    this.pose = null;
    return true;
  }

  /** A speech bubble over the head, or (`beside`) next to it, clear of someone standing above. */
  say(text: string, color: string = C.ink, life = 2.6, beside = false) {
    const tex = textBubbleTexture(text, color);
    const x = beside ? this.x + 9 + tex.width / 2 : this.x;
    this.effects.floater(tex, x, beside ? this.y - 12 : this.y - 28, life, 8);
  }

  hit(wx: number, wy: number) {
    return Math.abs(wx - this.x) <= 8 && wy >= this.y - 24 && wy <= this.y + 2;
  }

  update(dt: number, time: number, speed = 40) {
    let budget = speed * dt;
    while (budget > 0 && this.path.length) {
      const wp = this.path[0]!;
      const dx = wp.x - this.x;
      const dy = wp.y - this.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.01)
        this.facing =
          Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
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
    const anim = this.path.length ? WALK[this.facing] : (this.pose ?? STAND[this.facing]);
    const fps = this.path.length ? 8 : anim === "play" ? 5 : anim === "raiseHand" ? 3 : 1;
    const frames = this.sheet.anims[anim];
    this.sprite.texture = frames[Math.floor(time * fps) % frames.length]!;
    this.sprite.position.set(Math.round(this.x), Math.round(this.y));
    this.sprite.zIndex = this.y + this.zBias;
  }

  destroy() {
    this.sprite.destroy();
  }
}
