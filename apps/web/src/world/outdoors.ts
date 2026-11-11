/**
 * Life outside the building: a car on the street every minute or so (click it for /stats),
 * the lunch food truck, eyes and a werewolf in the forest at night, and the sky of the hour
 * (drifting cloud shadows, rain or snow that ramps up and down, petals or leaves in the wind).
 * Sprites only; textures cached in art/vehicles.ts.
 */
import { type Container, Sprite } from "pixi.js";
import { textBubbleTexture } from "../art/fun.ts";
import { pixelTexture } from "../art/fx.ts";
import {
  CAR_VARIANTS,
  carTextures,
  cloudShadowTexture,
  eyesTextures,
  particleTexture,
  truckTextures,
  werewolfTextures,
} from "../art/vehicles.ts";
import type { Effects } from "./effects.ts";
import { isFullMoon, type Season, type SkyNow, truckWindow, werewolfHour } from "./lifeRules.ts";
import { TILE } from "./map.ts";
import type { OfficeScene } from "./office.ts";

const SURROUND_PX = 12 * TILE;
/** street geometry (art/tiles.ts renderSurround): starts 10 px below the map, 44 px tall */
const STREET_TOP = 10;
const LANE_UP = STREET_TOP + 20;
const LANE_DOWN = STREET_TOP + 40;

type Layers = { decals: Container; glows: Container; fx: Container };

// ---- the car --------------------------------------------------------------------------------
class Car {
  readonly sprite: Sprite;
  private dir = 1;
  private x = 0;
  private speed = 70;
  private wait = 6 + Math.random() * 10;
  private variant = 0;

  constructor(
    layer: Container,
    private readonly world: () => { w: number; h: number },
  ) {
    this.sprite = new Sprite(carTextures(0)[0]!);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.visible = false;
    layer.addChild(this.sprite);
  }

  get driving() {
    return this.sprite.visible;
  }

  update(dt: number, time: number, swerve: (x: number, dir: number) => number) {
    const { w, h } = this.world();
    if (!this.sprite.visible) {
      this.wait -= dt;
      if (this.wait > 0) return;
      this.dir = Math.random() < 0.5 ? 1 : -1;
      this.variant = Math.floor(Math.random() * CAR_VARIANTS);
      this.speed = 60 + Math.random() * 30;
      this.x = this.dir > 0 ? -SURROUND_PX : w + SURROUND_PX;
      this.sprite.visible = true;
      this.sprite.scale.x = this.dir;
    }
    this.x += this.dir * this.speed * dt;
    const frames = carTextures(this.variant);
    this.sprite.texture = frames[Math.floor(time * 8) % 2]!;
    const lane = (this.dir > 0 ? LANE_DOWN : LANE_UP) + swerve(this.x, this.dir);
    this.sprite.position.set(Math.round(this.x), Math.round(h + lane));
    if (this.x < -SURROUND_PX - 40 || this.x > w + SURROUND_PX + 40) {
      this.sprite.visible = false;
      this.wait = 45 + Math.random() * 30;
    }
  }

  hit(wx: number, wy: number): boolean {
    if (!this.sprite.visible) return false;
    const s = this.sprite;
    return Math.abs(wx - s.x) <= 16 && wy >= s.y - 18 && wy <= s.y + 2;
  }
}

// ---- the food truck -------------------------------------------------------------------------
class FoodTruck {
  readonly sprite: Sprite;
  private phase: "away" | "in" | "parked" | "out" = "away";
  private x = 0;
  private ding = 0;
  private servedDay = "";
  /** the window must be seen on two slow ticks in a row (the clock settles after boot) */
  private openSeen = false;

  constructor(
    layer: Container,
    private readonly world: () => { w: number; h: number },
    private readonly park: () => number,
    private readonly effects: Effects,
  ) {
    this.sprite = new Sprite(truckTextures()[0]!);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.visible = false;
    layer.addChild(this.sprite);
  }

  get parked(): number | null {
    return this.phase === "parked" ? this.x : null;
  }

  /** where it stands (cars wait behind it) */
  get blocking(): number | null {
    return this.phase === "away" ? null : this.x;
  }

  slow(day: string, hour: number) {
    const open = truckWindow(hour);
    const confirmed = open && this.openSeen;
    this.openSeen = open;
    if (confirmed && this.phase === "away" && this.servedDay !== day) {
      this.servedDay = day;
      this.phase = "in";
      this.x = -SURROUND_PX - 30;
      this.sprite.visible = true;
    } else if (!open && this.phase === "parked") {
      this.phase = "out";
      this.sprite.texture = truckTextures()[0]!;
      this.say("BYE! SEE YOU TOMORROW");
    }
  }

  private say(text: string) {
    this.effects.floater(textBubbleTexture(text), this.x, this.sprite.y - 34, 4, 8);
  }

  update(dt: number, time: number) {
    if (this.phase === "away") return;
    const { w, h } = this.world();
    const stop = this.park();
    const bob = this.phase === "parked" ? 0 : Math.round(Math.sin(time * 18) * 0.6);
    if (this.phase === "in") {
      this.x = Math.min(stop, this.x + 55 * dt);
      if (this.x >= stop) {
        this.phase = "parked";
        this.sprite.texture = truckTextures()[1]!;
        this.ding = 0;
        this.effects.sparkle(this.x, h + LANE_UP - 30);
        this.say("LUNCH! (FOR LIKE 1 HOUR)");
      }
    } else if (this.phase === "parked") {
      this.ding += dt;
      if (this.ding > 28) {
        this.ding = 0;
        this.say("DING DING!");
      }
    } else if (this.phase === "out") {
      this.x += 60 * dt;
      if (this.x > w + SURROUND_PX + 40) {
        this.phase = "away";
        this.sprite.visible = false;
      }
    }
    this.sprite.position.set(Math.round(this.x), Math.round(h + LANE_UP + 2 + bob));
  }
}

// ---- forest at night ------------------------------------------------------------------------
type Eyes = { sprite: Sprite; t: number; life: number };

class Forest {
  private eyes: Eyes[] = [];
  private wolf: Sprite;
  private wolfEye: Sprite;
  private wolfX = 0;
  private wolfDir = 1;
  private wolfT = 0;
  private wolfMode: "none" | "trot" | "howl" = "none";
  private nextWolf = 40 + Math.random() * 80;
  private nextEyes = 3;
  private howled = "";

  constructor(
    layers: Layers,
    private readonly world: () => { w: number; h: number },
    private readonly effects: Effects,
  ) {
    for (let i = 0; i < 4; i++) {
      const s = new Sprite(eyesTextures()[0]!);
      s.anchor.set(0.5);
      s.scale.set(2);
      s.visible = false;
      layers.glows.addChild(s);
      this.eyes.push({ sprite: s, t: 0, life: 0 });
    }
    this.wolf = new Sprite(werewolfTextures()[0]!);
    this.wolf.anchor.set(0.5, 1);
    this.wolf.visible = false;
    layers.decals.addChild(this.wolf);
    this.wolfEye = new Sprite(pixelTexture());
    this.wolfEye.tint = 0xfee761;
    this.wolfEye.visible = false;
    layers.glows.addChild(this.wolfEye);
  }

  update(dt: number, time: number, active: boolean, day: string) {
    const { w } = this.world();
    if (!active) {
      for (const e of this.eyes) e.sprite.visible = false;
      if (this.wolfMode !== "none") this.wolfMode = "none";
      this.wolf.visible = false;
      this.wolfEye.visible = false;
      return;
    }
    // eyes open somewhere in the forest above the office, blink, and are gone again
    this.nextEyes -= dt;
    if (this.nextEyes <= 0) {
      this.nextEyes = 4 + Math.random() * 9;
      const e = this.eyes.find((x) => !x.sprite.visible);
      if (e) {
        e.t = 0;
        e.life = 4 + Math.random() * 5;
        e.sprite.position.set(
          Math.round(-SURROUND_PX + 20 + Math.random() * (w + 2 * SURROUND_PX - 40)),
          Math.round(-75 + Math.random() * 50),
        );
        e.sprite.visible = true;
      }
    }
    for (const e of this.eyes) {
      if (!e.sprite.visible) continue;
      e.t += dt;
      const blink = e.t % 2.6 > 2.45;
      const fading = e.t < 0.3 || e.t > e.life - 0.3;
      e.sprite.texture = eyesTextures()[blink ? 2 : fading ? 1 : 0]!;
      if (e.t > e.life) e.sprite.visible = false;
    }
    // now and then a werewolf trots along the forest edge; on full-moon nights it howls
    if (this.wolfMode === "none") {
      this.nextWolf -= dt;
      if (this.nextWolf > 0) return;
      this.nextWolf = 90 + Math.random() * 150;
      this.wolfDir = Math.random() < 0.5 ? 1 : -1;
      this.wolfX = this.wolfDir > 0 ? -SURROUND_PX : w + SURROUND_PX;
      this.wolfMode = "trot";
      this.wolfT = 0;
      this.wolf.visible = true;
      this.wolf.scale.x = this.wolfDir;
    }
    const y = -18;
    this.wolfT += dt;
    if (this.wolfMode === "trot") {
      this.wolfX += this.wolfDir * 34 * dt;
      this.wolf.texture = werewolfTextures()[Math.floor(time * 6) % 2]!;
      const mid = Math.abs(this.wolfX - w / 2) < 20;
      if (mid && this.howled !== day && isFullMoon(Date.now())) {
        this.howled = day;
        this.wolfMode = "howl";
        this.wolfT = 0;
        this.effects.floater(textBubbleTexture("AWOOOO!"), this.wolfX, y - 18, 3.5, 12);
      }
      if (this.wolfX < -SURROUND_PX - 30 || this.wolfX > w + SURROUND_PX + 30) {
        this.wolfMode = "none";
        this.wolf.visible = false;
      }
    } else if (this.wolfMode === "howl") {
      this.wolf.texture = werewolfTextures()[2]!;
      if (this.wolfT > 3.5) this.wolfMode = "trot";
    }
    this.wolf.position.set(Math.round(this.wolfX), y);
    this.wolfEye.visible = this.wolf.visible;
    const eyeDx = this.wolfMode === "howl" ? 1 : 5;
    this.wolfEye.position.set(
      Math.round(this.wolfX + this.wolfDir * eyeDx),
      y - (this.wolfMode === "howl" ? 13 : 11),
    );
  }
}

// ---- the sky of the hour --------------------------------------------------------------------
type Drop = { sprite: Sprite; seed: number };
type Region = { x: number; y: number; w: number; h: number };
/** 110 used to cover garden + forest + street; the smokers' corner got its own share */
const DROPS = 140;
const DRIFT = 8;

class SkyLayer {
  private drops: Drop[] = [];
  private shadows: Sprite[] = [];
  private drift: Drop[] = [];

  constructor(
    layers: Layers,
    private readonly regions: () => Region[],
    private readonly world: () => { w: number; h: number },
    private readonly season: Season,
  ) {
    for (let i = 0; i < 4; i++) {
      const s = new Sprite(cloudShadowTexture());
      s.anchor.set(0.5);
      s.scale.set(2 + (i % 2), 2);
      s.alpha = 0;
      layers.fx.addChild(s);
      this.shadows.push(s);
    }
    for (let i = 0; i < DROPS; i++) {
      const s = new Sprite(pixelTexture());
      s.visible = false;
      layers.fx.addChild(s);
      this.drops.push({ sprite: s, seed: i });
    }
    const kind = season === "autumn" ? "leaf" : season === "spring" ? "petal" : null;
    if (kind) {
      for (let i = 0; i < DRIFT; i++) {
        const s = new Sprite(particleTexture(kind));
        s.visible = false;
        layers.fx.addChild(s);
        this.drift.push({ sprite: s, seed: i });
      }
    }
  }

  update(sky: SkyNow, time: number) {
    const { w, h } = this.world();
    // cloud shadows drift with the wind across everything
    const span = w + 2 * SURROUND_PX + 400;
    const speed = 6 + sky.wind * 22;
    this.shadows.forEach((s, i) => {
      s.alpha = Math.max(0, sky.cloud - 0.25) * 0.16;
      s.visible = s.alpha > 0.005;
      if (!s.visible) return;
      const x = ((i * span) / 4 + time * speed) % span;
      s.position.set(Math.round(-SURROUND_PX - 200 + x), Math.round(((i * 211) % (h + 100)) - 50));
    });
    // rain or snow: how many drops show follows the intensity of the hour
    const snow = sky.weather === "snow" || (this.season === "winter" && sky.precip > 0);
    const n = Math.round(Math.min(1, sky.precip * 1.25) * DROPS);
    const regions = this.regions();
    const slant = 0.05 + sky.wind * 0.25;
    this.drops.forEach((d, i) => {
      const s = d.sprite;
      s.visible = i < n && regions.length > 0;
      if (!s.visible) return;
      const r = regions[i % regions.length]!;
      const fall = snow ? 26 : 170;
      const y = (i * 97 + time * fall) % r.h;
      let x = r.x + ((i * 53) % Math.max(1, r.w));
      if (snow) {
        s.texture = particleTexture("snow");
        s.scale.set(1);
        x += Math.sin(time * 1.3 + i) * 3 + y * slant * 0.6;
      } else {
        s.texture = pixelTexture();
        s.scale.set(0.5, 4);
        s.tint = 0xdfe6f0;
        s.alpha = 0.9;
        x -= y * slant;
      }
      s.position.set(Math.round(x), Math.round(r.y + y));
    });
    // a few petals / leaves blow through the garden, more when it is windy
    const m = Math.round(DRIFT * (0.3 + sky.wind * 0.7));
    const g = regions[0];
    this.drift.forEach((d, i) => {
      const s = d.sprite;
      s.visible = !!g && i < m;
      if (!s.visible || !g) return;
      const p = ((time * (0.06 + sky.wind * 0.08) + i / DRIFT) % 1) * 1.0;
      s.position.set(
        Math.round(g.x + g.w * p + Math.sin(time * 2 + i * 1.7) * 8),
        Math.round(g.y + ((i * 131) % g.h) + p * 40 + Math.sin(time * 3 + i) * 4),
      );
      s.rotation = Math.round(time * 2 + i) * (Math.PI / 2);
    });
  }
}

// ---- the whole outside ----------------------------------------------------------------------
export class Outdoors {
  /** solar eclipse darkness 0..1 (forest eyes come out during it) */
  eclipse = 0;
  private car: Car;
  private truck: FoodTruck;
  private forest: Forest;
  private sky: SkyLayer;

  constructor(
    private readonly scene: OfficeScene,
    effects: Effects,
    season: Season,
  ) {
    const layers = { decals: scene.decals, glows: scene.glows, fx: scene.fx };
    const world = () => ({ w: scene.widthPx, h: scene.heightPx });
    this.car = new Car(scene.decals, world);
    this.truck = new FoodTruck(scene.decals, world, () => (scene.map.door.x + 3) * TILE, effects);
    this.forest = new Forest(layers, world, effects);
    this.sky = new SkyLayer(
      layers,
      () => {
        const g = scene.map.areas.find((a) => a.name === "garden");
        const { w, h } = world();
        const out: Region[] = [];
        if (g) out.push({ x: g.x * TILE + 24, y: g.y * TILE, w: g.w * TILE - 20, h: g.h * TILE });
        // the smokers' corner (and the sidewalk lane next to it) below the weed shop
        const shop = scene.map.areas.find((a) => a.name === "shop");
        if (shop) {
          const top = shop.y + 10;
          out.push({
            x: (shop.x - 1) * TILE,
            y: top * TILE,
            w: (shop.w + 1) * TILE,
            h: (scene.map.height - 1 - top) * TILE,
          });
        }
        out.push({ x: -SURROUND_PX, y: -SURROUND_PX, w: w + 2 * SURROUND_PX, h: SURROUND_PX - 4 });
        out.push({ x: -SURROUND_PX, y: h + 2, w: w + 2 * SURROUND_PX, h: SURROUND_PX - 4 });
        return out;
      },
      world,
      season,
    );
  }

  /** a viewer clicked the street: true if it was the car */
  hitCar(wx: number, wy: number): boolean {
    return this.car.hit(wx, wy);
  }

  slow(day: string, hour: number) {
    this.truck.slow(day, hour);
  }

  /** x of the parked food truck (open for lunch), else null */
  truckParked(): number | null {
    return this.truck.parked;
  }

  update(dt: number, time: number, sky: SkyNow, hour: number, day: string) {
    const truckX = this.truck.blocking;
    this.car.update(dt, time, (x, dir) => {
      // cars on the truck's lane pull out around it
      if (truckX === null || dir > 0) return 0;
      const d = Math.abs(x - truckX);
      return d > 70 ? 0 : Math.round(Math.min(1, (70 - d) / 30) * (LANE_DOWN - LANE_UP));
    });
    this.truck.update(dt, time);
    const dark = this.scene.night > 0.5;
    this.forest.update(dt, time, (werewolfHour(hour) || this.eclipse > 0.6) && dark, day);
    this.sky.update(sky, time);
  }
}
