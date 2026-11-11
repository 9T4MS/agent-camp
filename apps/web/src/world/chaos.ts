/**
 * Office chaos (life.ts runs it): the fire alarm with sprinklers and the fire brigade, the
 * mafia coffee machine, raccoons at the garden bin, the monthly kaiju, birthday cake drones,
 * tornado / meteor shower / eclipse, and the flooded garden with ducks.
 * Scheduled events come from lifeRules.ts (deterministic per date, same for every viewer);
 * only the flavour (who says what, where a drop falls) is local randomness.
 */
import { Sprite } from "pixi.js";
import {
  binTexture,
  cakeTextures,
  duckTextures,
  fireTruckTextures,
  kaijuTextures,
  meteorTexture,
  raccoonTextures,
  tornadoTextures,
  trashTextures,
  waterTexture,
} from "../art/chaos.ts";
import { droneTextures, textBubbleTexture } from "../art/fun.ts";
import { glowTexture, pixelTexture } from "../art/fx.ts";
import { C, hexNum } from "../art/palette.ts";
import type { Effects } from "./effects.ts";
import { ALARM_IDLE, type AlarmState, alarmTick, KAIJU_S, RACCOON_RAID_H } from "./lifeRules.ts";
import { type Point, TILE } from "./map.ts";
import type { OfficeScene } from "./office.ts";

const SURROUND_PX = 12 * TILE;
const LANE_UP = 30;

const tileCenter = (x: number, y: number): Point => ({ x: x * TILE + 8, y: y * TILE + 12 });

function areaRect(scene: OfficeScene, name: string) {
  const a = scene.map.areas.find((x) => x.name === name);
  return a ? { x: a.x * TILE, y: a.y * TILE, w: a.w * TILE, h: a.h * TILE } : null;
}

// ---- fire alarm -------------------------------------------------------------------------------
export class FireAlarm {
  private state: AlarmState = ALARM_IDLE;
  private lights: Sprite[] = [];
  private drops: Sprite[] = [];
  private truck: Sprite;
  private truckPhase: "away" | "in" | "parked" | "out" = "away";
  private truckX = 0;
  private shout = 0;

  constructor(
    private readonly scene: OfficeScene,
    private readonly effects: Effects,
    private readonly evacuate: (spot: Point | null) => void,
  ) {
    for (let i = 0; i < 4; i++) {
      const g = new Sprite(glowTexture(30, C.red));
      g.anchor.set(0.5);
      g.visible = false;
      scene.glows.addChild(g);
      this.lights.push(g);
    }
    for (let i = 0; i < 80; i++) {
      const d = new Sprite(pixelTexture());
      d.tint = hexNum(C.cyan);
      d.scale.set(0.5, 3);
      d.visible = false;
      scene.fx.addChild(d);
      this.drops.push(d);
    }
    this.truck = new Sprite(fireTruckTextures()[0]!);
    this.truck.anchor.set(0.5, 1);
    this.truck.visible = false;
    scene.decals.addChild(this.truck);
  }

  get on() {
    return this.state.on;
  }

  /** where everybody gathers in the garden */
  assembly(): Point {
    const g = this.scene.map.areas.find((a) => a.name === "garden");
    return g ? tileCenter(g.x + 4, Math.min(g.y + 11, g.y + g.h - 2)) : tileCenter(55, 12);
  }

  slow(burning: number, dt: number, forced: boolean) {
    const was = this.state.on;
    this.state = forced
      ? { ...this.state, on: true, onFor: 0, calm: 0 }
      : alarmTick(this.state, burning, dt);
    if (this.state.on && !was) {
      this.evacuate(this.assembly());
      this.truckPhase = "in";
      this.truckX = -SURROUND_PX - 40;
      this.truck.visible = true;
      this.shout = 0;
    } else if (!this.state.on && was) {
      this.evacuate(null);
      if (this.truckPhase !== "away") this.truckPhase = "out";
    }
  }

  update(dt: number, time: number) {
    const on = this.state.on;
    const desks = areaRect(this.scene, "desks");
    const blink = Math.floor(time * 3) % 2 === 0;
    this.lights.forEach((g, i) => {
      g.visible = on && !!desks && (i % 2 === 0) === blink;
      if (!g.visible || !desks) return;
      g.position.set(
        desks.x + ((i % 2) + 0.5) * (desks.w / 2),
        desks.y + 4 + Math.floor(i / 2) * (desks.h / 2),
      );
      g.alpha = 0.8;
    });
    this.drops.forEach((d, i) => {
      d.visible = on && !!desks;
      if (!d.visible || !desks) return;
      const y = (i * 53 + time * 120) % desks.h;
      d.position.set(desks.x + ((i * 97) % desks.w), desks.y + y);
      d.alpha = 0.7;
    });
    if (on && desks) {
      this.shout -= dt;
      if (this.shout <= 0) {
        this.shout = 6;
        this.effects.floater(
          textBubbleTexture("FIRE ALARM! EVERYBODY OUT!", C.red),
          desks.x + desks.w / 2,
          desks.y + 20,
          4,
          8,
        );
      }
    }
    // the fire brigade
    if (this.truckPhase === "away") return;
    const h = this.scene.heightPx;
    const park = (this.scene.map.door.x - 6) * TILE;
    if (this.truckPhase === "in") {
      this.truckX = Math.min(park, this.truckX + 90 * dt);
      if (this.truckX >= park) {
        this.truckPhase = "parked";
        this.effects.floater(
          textBubbleTexture("WHERE'S THE FIRE?!"),
          park,
          h + LANE_UP - 30,
          3.5,
          8,
        );
      }
    } else if (this.truckPhase === "out") {
      this.truckX += 80 * dt;
      if (this.truckX > this.scene.widthPx + SURROUND_PX + 50) {
        this.truckPhase = "away";
        this.truck.visible = false;
      }
    }
    this.truck.texture = fireTruckTextures()[Math.floor(time * 5) % 2]!;
    this.truck.position.set(Math.round(this.truckX), Math.round(h + LANE_UP + 2));
  }
}

// ---- mafia coffee machine ---------------------------------------------------------------------
const MAFIA_LINES = [
  (n: string, k: number) => `${k} COFFEES, ${n}. WE'LL TALK.`,
  (n: string) => `${n} OWES ME A FAVOR`,
  (n: string) => `NICE LAPTOP, ${n}. SHAME IF IT... CRASHED`,
  (n: string) => `${n}, YOU NEVER CALL. YOU NEVER DESCALE.`,
  (n: string) => `THE ESPRESSO REMEMBERS, ${n}.`,
];

export class MafiaCoffee {
  private cups = new Map<string, { name: string; n: number }>();
  private day = "";
  private next = 120 + Math.random() * 120;

  constructor(
    private readonly scene: OfficeScene,
    private readonly effects: Effects,
  ) {}

  drunk(personId: string, name: string, day: string) {
    this.roll(day);
    const c = this.cups.get(personId) ?? { name, n: 0 };
    c.name = name;
    c.n++;
    this.cups.set(personId, c);
  }

  private roll(day: string) {
    if (day && day !== this.day) {
      this.day = day;
      this.cups.clear();
    }
  }

  update(dt: number, day: string) {
    this.roll(day);
    this.next -= dt;
    if (this.next > 0) return;
    this.next = 180 + Math.random() * 120;
    let top: { name: string; n: number } | null = null;
    for (const c of this.cups.values()) if (!top || c.n > top.n) top = c;
    if (!top || top.n < 2) return;
    const line = MAFIA_LINES[Math.floor(Math.random() * MAFIA_LINES.length)]!;
    const o = this.scene.map.objects.find((x) => x.kind === "coffee");
    const p = o ? { x: o.x * TILE + 8, y: o.y * TILE + 2 } : { x: 37 * TILE, y: 3 * TILE };
    this.effects.floater(
      textBubbleTexture(line(top.name.toUpperCase(), top.n), C.wine),
      p.x,
      p.y,
      5,
      6,
    );
  }
}

// ---- raccoons -------------------------------------------------------------------------------
export class Raccoons {
  private bin: Sprite;
  private coons: Sprite[] = [];
  private trash: Sprite[] = [];
  private rustle = 0;

  constructor(
    private readonly scene: OfficeScene,
    private readonly effects: Effects,
  ) {
    this.bin = new Sprite(binTexture());
    this.bin.anchor.set(0.5, 1);
    this.bin.label = "actor";
    scene.objects.addChild(this.bin);
    for (let i = 0; i < 2; i++) {
      const r = new Sprite(raccoonTextures()[0]!);
      r.anchor.set(0.5, 1);
      r.visible = false;
      r.label = "actor";
      scene.objects.addChild(r);
      this.coons.push(r);
    }
    const spots: [number, number, number][] = [
      [-14, 4, 0],
      [12, 6, 1],
      [-6, 12, 2],
      [20, -2, 2],
      [4, 16, 1],
      [-22, 10, 0],
    ];
    for (const [, , f] of spots) {
      const t = new Sprite(trashTextures()[f]!);
      t.anchor.set(0.5, 1);
      t.visible = false;
      scene.decals.addChild(t);
      this.trash.push(t);
    }
    this.layout(spots);
  }

  private spot(): Point {
    const g = this.scene.map.areas.find((a) => a.name === "garden");
    return g ? { x: (g.x + 2) * TILE + 8, y: (g.y + 7) * TILE + 14 } : tileCenter(53, 8);
  }

  private spots: [number, number, number][] = [];
  private layout(spots: [number, number, number][]) {
    this.spots = spots;
    const b = this.spot();
    this.bin.position.set(b.x, b.y);
    this.bin.zIndex = b.y;
    for (const [i, [dx, dy]] of spots.entries()) this.trash[i]!.position.set(b.x + dx, b.y + dy);
  }

  relayout() {
    this.layout(this.spots);
  }

  /** `phase`: seconds since the raid started (null = no raid), `trash`: leftovers lie around */
  update(dt: number, time: number, phase: number | null, trash: boolean) {
    const b = this.spot();
    for (const t of this.trash) t.visible = trash;
    const total = RACCOON_RAID_H * 3600;
    const on = phase !== null && phase < total;
    this.coons.forEach((r, i) => {
      r.visible = on;
      if (!on || phase === null) return;
      const p = phase - i * 3;
      const g = this.scene.map.areas.find((a) => a.name === "garden");
      const edge = g ? (g.x + g.w) * TILE + 30 : b.x + 160;
      const home = { x: edge + i * 14, y: b.y + (i ? 10 : -6) };
      const at = { x: b.x + (i ? 9 : -9), y: b.y + 3 };
      let x = home.x;
      let y = home.y;
      let frame = Math.floor(time * 6) % 2;
      if (p < 0) {
        r.visible = false;
        return;
      }
      if (p < 14) {
        const k = p / 14;
        x = home.x + (at.x - home.x) * k;
        y = home.y + (at.y - home.y) * k;
        r.scale.x = at.x >= home.x ? 1 : -1;
      } else if (p < total - 14) {
        x = at.x;
        y = at.y;
        frame = Math.floor(time * 4) % 3 === 0 ? 2 : 1;
        r.scale.x = i ? -1 : 1;
      } else {
        const k = Math.min(1, (p - (total - 14)) / 14);
        x = at.x + (home.x - at.x) * k;
        y = at.y + (home.y - at.y) * k;
        r.scale.x = home.x >= at.x ? 1 : -1;
      }
      r.texture = raccoonTextures()[frame]!;
      r.position.set(Math.round(x), Math.round(y));
      r.zIndex = y;
    });
    if (on) {
      this.rustle -= dt;
      if (this.rustle <= 0) {
        this.rustle = 7;
        this.effects.floater(textBubbleTexture("*RUSTLE*", C.slate), b.x, b.y - 16, 2.5, 6);
        this.bin.rotation = 0.15;
      } else this.bin.rotation *= 0.9;
    } else this.bin.rotation = 0;
  }
}

// ---- kaiju ----------------------------------------------------------------------------------
export class Kaiju {
  private sprite: Sprite;
  private lastStep = -1;
  private roared = false;

  constructor(
    private readonly scene: OfficeScene,
    private readonly effects: Effects,
  ) {
    this.sprite = new Sprite(kaijuTextures()[0]!);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.scale.set(2.5);
    this.sprite.alpha = 0.92;
    this.sprite.visible = false;
    scene.decals.addChild(this.sprite);
  }

  /** `p`: 0..1 progress of the walk past the office, or null */
  update(p: number | null) {
    this.sprite.visible = p !== null;
    if (p === null) {
      this.lastStep = -1;
      this.roared = false;
      return;
    }
    const w = this.scene.widthPx;
    const x = -SURROUND_PX - 60 + p * (w + 2 * SURROUND_PX + 120);
    const seconds = p * KAIJU_S;
    const step = Math.floor(seconds / 0.9);
    const roar = p > 0.45 && p < 0.55;
    this.sprite.texture = kaijuTextures()[roar ? 2 : step % 2]!;
    this.sprite.position.set(Math.round(x), -2);
    if (step !== this.lastStep) {
      this.lastStep = step;
      this.scene.shake(roar ? 1.5 : 2.5);
    }
    if (roar && !this.roared) {
      this.roared = true;
      this.scene.shake(4);
      this.effects.floater(textBubbleTexture("ROAAAAR!", C.red), x + 40, -90, 4, 10);
    }
  }
}

// ---- birthday cake drone ----------------------------------------------------------------------
export const CAKE_EVERY_S = 45 * 60;

export class CakeDrone {
  private drone: Sprite;
  private carry: Sprite;
  private cakes = new Map<string, Sprite>();
  private queue: string[] = [];
  private job: { personId: string; to: Point; phase: "in" | "lower" | "out"; t: number } | null =
    null;
  private pos: Point = { x: 0, y: 0 };
  private lastVisit = new Map<string, number>();
  private day = "";

  constructor(
    private readonly scene: OfficeScene,
    private readonly effects: Effects,
    private readonly spotOf: (personId: string) => Point | null,
    private readonly nameOf: (personId: string) => string,
  ) {
    this.drone = new Sprite(droneTextures()[0]!);
    this.drone.anchor.set(0.5, 1);
    this.drone.visible = false;
    this.carry = new Sprite(cakeTextures()[0]!);
    this.carry.anchor.set(0.5, 1);
    this.carry.visible = false;
    scene.fx.addChild(this.drone, this.carry);
  }

  /** Every slow tick: who has their birthday today (and needs a visit). */
  slow(birthdays: string[], day: string, now: number) {
    if (day !== this.day) {
      this.day = day;
      for (const s of this.cakes.values()) s.destroy();
      this.cakes.clear();
      this.lastVisit.clear();
    }
    for (const id of birthdays) {
      const last = this.lastVisit.get(id);
      if (last !== undefined && now - last < CAKE_EVERY_S * 1000) continue;
      if (this.queue.includes(id) || this.job?.personId === id) continue;
      this.queue.push(id);
    }
  }

  update(dt: number, time: number) {
    const cakeFrame = cakeTextures()[Math.floor(time * 5) % 2]!;
    for (const s of this.cakes.values()) s.texture = cakeFrame;
    if (!this.job) {
      const id = this.queue.shift();
      if (!id) return;
      const spot = this.spotOf(id);
      if (!spot) return;
      this.job = { personId: id, to: { x: spot.x + 12, y: spot.y - 2 }, phase: "in", t: 0 };
      this.pos = { x: this.scene.widthPx + 40, y: spot.y - 160 };
      this.drone.visible = true;
      this.carry.visible = true;
      this.carry.texture = cakeFrame;
    }
    const j = this.job;
    const bob = Math.round(Math.sin(time * 6) * 1.5);
    this.drone.texture = droneTextures()[Math.floor(time * 14) % 2]!;
    if (j.phase === "in") {
      const target = { x: j.to.x, y: j.to.y - 40 };
      const dx = target.x - this.pos.x;
      const dy = target.y - this.pos.y;
      const d = Math.hypot(dx, dy);
      const step = 80 * dt;
      if (d <= step) {
        this.pos = target;
        j.phase = "lower";
        j.t = 0;
      } else {
        this.pos.x += (dx / d) * step;
        this.pos.y += (dy / d) * step;
      }
    } else if (j.phase === "lower") {
      j.t += dt;
      if (j.t > 1.2) {
        j.phase = "out";
        this.carry.visible = false;
        this.lastVisit.set(j.personId, Date.now());
        let cake = this.cakes.get(j.personId);
        if (!cake) {
          cake = new Sprite(cakeFrame);
          cake.anchor.set(0.5, 1);
          cake.label = "actor";
          this.scene.objects.addChild(cake);
          this.cakes.set(j.personId, cake);
        }
        cake.position.set(Math.round(j.to.x), Math.round(j.to.y));
        cake.zIndex = j.to.y + 2;
        this.effects.confetti(j.to.x, j.to.y - 12, 40);
        const name = this.nameOf(j.personId).toUpperCase();
        this.effects.floater(
          textBubbleTexture(`HAPPY BIRTHDAY ${name}!`, C.berry),
          j.to.x,
          j.to.y - 22,
          5,
          10,
        );
      }
    } else {
      this.pos.y -= 55 * dt;
      this.pos.x += 30 * dt;
      if (this.pos.y < j.to.y - 220) {
        this.drone.visible = false;
        this.job = null;
        return;
      }
    }
    this.drone.position.set(Math.round(this.pos.x), Math.round(this.pos.y + bob));
    const drop = j.phase === "lower" ? Math.min(1, j.t) * 26 : 0;
    this.carry.position.set(Math.round(this.pos.x), Math.round(this.pos.y + 14 + drop + bob));
  }
}

// ---- tornado, meteors -------------------------------------------------------------------------
export class Tornado {
  private sprite: Sprite;
  private puff = 0;

  constructor(
    private readonly scene: OfficeScene,
    private readonly effects: Effects,
  ) {
    this.sprite = new Sprite(tornadoTextures()[0]!);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.scale.set(2);
    this.sprite.alpha = 1;
    this.sprite.visible = false;
    scene.fx.addChild(this.sprite);
  }

  update(dt: number, time: number, p: number | null) {
    const g = areaRect(this.scene, "garden");
    this.sprite.visible = p !== null && !!g;
    if (p === null || !g) return;
    const x = g.x - 30 + p * (g.w + 60);
    const y = g.y + g.h * 0.55 + Math.sin(p * Math.PI * 3) * 40;
    this.sprite.texture = tornadoTextures()[Math.floor(time * 12) % 3]!;
    this.sprite.position.set(Math.round(x + Math.sin(time * 9) * 2), Math.round(y));
    this.puff -= dt;
    if (this.puff <= 0) {
      this.puff = 0.25;
      this.effects.burst(x, y - 10, [C.leaf, C.moss, C.bark, C.grey], {
        count: 6,
        speed: 70,
        life: 1.6,
      });
    }
  }
}

export class Meteors {
  private stars: { sprite: Sprite; t: number; vx: number; vy: number }[] = [];
  private next = 1;

  constructor(private readonly scene: OfficeScene) {
    for (let i = 0; i < 6; i++) {
      const s = new Sprite(meteorTexture());
      s.anchor.set(1, 1);
      s.visible = false;
      scene.glows.addChild(s);
      this.stars.push({ sprite: s, t: 99, vx: 0, vy: 0 });
    }
  }

  update(dt: number, active: boolean, hour: number) {
    for (const st of this.stars) {
      if (!st.sprite.visible) continue;
      st.t += dt;
      st.sprite.x += st.vx * dt;
      st.sprite.y += st.vy * dt;
      st.sprite.alpha = Math.max(0, 1 - st.t / 0.8);
      if (st.t > 0.8) st.sprite.visible = false;
    }
    if (!active) return;
    this.next -= dt;
    if (this.next > 0) return;
    const peak = hour >= 23 || hour < 2;
    this.next = (peak ? 0.4 : 1.2) + Math.random() * (peak ? 1.0 : 2.0);
    const st = this.stars.find((s) => !s.sprite.visible);
    if (!st) return;
    const w = this.scene.widthPx;
    st.t = 0;
    st.vx = 200 + Math.random() * 80;
    st.vy = 100 + Math.random() * 40;
    st.sprite.visible = true;
    st.sprite.alpha = 1;
    st.sprite.scale.set(1.5);
    st.sprite.position.set(
      Math.round(-SURROUND_PX + Math.random() * (w + SURROUND_PX)),
      Math.round(-SURROUND_PX + 10 + Math.random() * 90),
    );
  }
}

// ---- flood + ducks ----------------------------------------------------------------------------
export class Flood {
  private sheet: Sprite;
  private puddles: Sprite[] = [];
  private ducks: Sprite[] = [];

  constructor(private readonly scene: OfficeScene) {
    this.sheet = new Sprite(waterTexture(120, 64));
    this.sheet.anchor.set(0.5);
    this.sheet.visible = false;
    scene.decals.addChild(this.sheet);
    for (const [w, h] of [
      [22, 9],
      [30, 12],
      [18, 8],
      [26, 10],
    ] as const) {
      const p = new Sprite(waterTexture(w, h));
      p.anchor.set(0.5);
      p.visible = false;
      scene.decals.addChild(p);
      this.puddles.push(p);
    }
    for (let i = 0; i < 4; i++) {
      const d = new Sprite(duckTextures()[0]!);
      d.anchor.set(0.5, 1);
      d.visible = false;
      d.label = "actor";
      scene.objects.addChild(d);
      this.ducks.push(d);
    }
  }

  update(time: number, level: number, ducks: number) {
    const g = areaRect(this.scene, "garden");
    if (!g || level <= 0.01) {
      this.sheet.visible = false;
      for (const p of this.puddles) p.visible = false;
      for (const d of this.ducks) d.visible = false;
      return;
    }
    const cx = g.x + g.w * 0.45;
    const cy = g.y + g.h * 0.5;
    const spots = [
      [-0.3, -0.25],
      [0.25, -0.1],
      [-0.2, 0.3],
      [0.3, 0.28],
    ];
    this.puddles.forEach((p, i) => {
      const [fx, fy] = spots[i]!;
      p.visible = level > 0.1;
      p.position.set(Math.round(cx + fx! * g.w), Math.round(cy + fy! * g.h * 0.6));
      p.scale.set(0.6 + level * 0.8);
      p.alpha = Math.min(1, level * 2);
    });
    const big = Math.max(0, (level - 0.35) / 0.65);
    this.sheet.visible = big > 0;
    this.sheet.position.set(Math.round(cx), Math.round(cy));
    this.sheet.scale.set(0.4 + big * 0.9, 0.4 + big * 1.2);
    this.sheet.alpha = 0.85;
    const rx = 50 * this.sheet.scale.x;
    const ry = 26 * this.sheet.scale.y;
    this.ducks.forEach((d, i) => {
      d.visible = big > 0.3 && i < ducks;
      if (!d.visible) return;
      const a = time * 0.25 + i * 1.6;
      const x = cx + Math.cos(a) * rx * 0.7;
      const y = cy + Math.sin(a) * ry * 0.6;
      d.scale.x = -Math.sin(a) < 0 ? -1 : 1;
      d.texture = duckTextures()[Math.floor(time * 3 + i) % 2]!;
      d.position.set(Math.round(x), Math.round(y + 3));
      d.zIndex = y;
    });
  }
}
