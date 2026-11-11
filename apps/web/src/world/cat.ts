/** The office cat: walks over to someone idle and naps next to them (zzz). */
import { seededRandom } from "@agent-office/protocol";
import { type Container, Sprite } from "pixi.js";
import { CAT, catTextures, zzzTextures } from "../art/fx.ts";
import { type OfficeMap, type Point, TILE } from "./map.ts";
import { findPath } from "./pathing.ts";

export class OfficeCat {
  readonly sprite: Sprite;
  private zzz: Sprite;
  private x: number;
  private y: number;
  private path: Point[] = [];
  private mode: "sleep" | "sit" | "walk" = "sleep";
  private timer = 6;
  private dir = 1;
  private rand = seededRandom("cat");

  constructor(
    objects: Container,
    fx: Container,
    private map: OfficeMap,
    private readonly idleSpots: () => Point[],
  ) {
    this.sprite = new Sprite(catTextures()[0]!);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.label = "actor";
    this.zzz = new Sprite(zzzTextures()[0]!);
    this.zzz.anchor.set(0, 1);
    objects.addChild(this.sprite);
    fx.addChild(this.zzz);
    const home = this.home();
    this.x = home.x;
    this.y = home.y;
  }

  setMap(map: OfficeMap) {
    this.map = map;
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

  private pickTarget() {
    const spots = this.idleSpots();
    let target = this.home();
    if (spots.length > 0 && this.rand() < 0.8) {
      const s = spots[Math.floor(this.rand() * spots.length)]!;
      const side = this.rand() < 0.5 ? -1 : 1;
      target = { x: s.x + side * 14, y: s.y + 6 };
      const tx = Math.floor(target.x / TILE);
      const ty = Math.floor(target.y / TILE);
      if (!this.map.isWalkable(tx, ty)) target = { x: s.x, y: s.y + 10 };
      if (!this.map.isWalkable(Math.floor(target.x / TILE), Math.floor(target.y / TILE))) target = this.home();
    }
    if (!this.goTo(target)) this.timer = 5;
  }

  update(dt: number, time: number) {
    const frames = catTextures();
    if (this.mode === "walk") {
      let budget = 26 * dt;
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
      const walk = this.dir < 0 ? CAT.walkLeft : CAT.walkRight;
      this.sprite.texture = frames[walk[Math.floor(time * 6) % 2]!]!;
      if (this.path.length === 0) {
        this.mode = this.rand() < 0.3 ? "sit" : "sleep";
        this.timer = this.mode === "sit" ? 5 + this.rand() * 5 : 18 + this.rand() * 25;
      }
    } else {
      const set = this.mode === "sleep" ? CAT.sleep : CAT.sit;
      const fps = this.mode === "sleep" ? 0.8 : 0.5;
      this.sprite.texture = frames[set[Math.floor(time * fps) % 2]!]!;
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.mode === "sit" && this.rand() < 0.5) {
          this.mode = "sleep";
          this.timer = 20;
        } else this.pickTarget();
      }
    }
    this.sprite.scale.x = this.mode === "walk" ? 1 : this.dir < 0 ? 1 : -1;
    this.sprite.position.set(Math.round(this.x), Math.round(this.y));
    this.sprite.zIndex = this.y - 1;
    this.zzz.visible = this.mode === "sleep";
    this.zzz.texture = zzzTextures()[Math.floor(time * 1.5) % 3]!;
    this.zzz.position.set(Math.round(this.x + 4), Math.round(this.y - 12));
  }
}
