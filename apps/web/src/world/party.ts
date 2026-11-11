/** Shared game effects and rides; appearance comes from the canonical avatar only. */
import {
  type AvatarSpec,
  avatarFromSeed,
  type PartyEvent,
  type PartyState,
} from "@agent-office/protocol";
import { Graphics, Sprite, Texture } from "pixi.js";
import { accentHex } from "../art/costumes.ts";
import { drawText } from "../art/font.ts";
import { C, hexNum } from "../art/palette.ts";
import { avatarPortrait, vehicleCanvas } from "../art/party.ts";
import { PixelCanvas } from "../art/pixel.ts";
import type { OfficeModel } from "../state/officeModel.ts";
import type { CharacterManager, SessionCharacter } from "./characters.ts";
import { TILE } from "./map.ts";
import type { OfficeScene } from "./office.ts";

type Overlay = { sprite: Sprite; key: string };
type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  color: string;
  shape: "pixel" | "bubble" | "star" | "note" | "smoke";
};
type Moment = { event: PartyEvent; age: number; started: boolean; vehicle?: Sprite };
const MAX_PARTICLES = 360;
const MAX_MOMENTS = 32;

/** Timestamp expiry prevents old moves replaying when ordinary office events arrive later. */
export class PartyInbox {
  private seen = new Map<string, number>();

  take(events: readonly PartyEvent[], now: number): PartyEvent[] {
    for (const [id, at] of this.seen) if (now - at >= 15_000) this.seen.delete(id);
    const fresh: PartyEvent[] = [];
    for (const event of events) {
      if (now - event.at >= 15_000 || this.seen.has(event.id)) continue;
      this.seen.set(event.id, event.at);
      fresh.push(event);
    }
    while (this.seen.size > 256) this.seen.delete(this.seen.keys().next().value!);
    return fresh;
  }
}

function floorCanvas(): HTMLCanvasElement {
  const p = new PixelCanvas(80, 44);
  p.round(0, 0, 80, 44, C.night);
  drawText(p, 16, 4, "DANCE FLOOR", C.cyan);
  const colors = [C.berry, C.navy, C.plum, C.sky, C.pink];
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 7; x++)
      p.rect(5 + x * 10, 13 + y * 10, 8, 8, colors[(x + y * 2) % colors.length]!);
  return p.toCanvas();
}

function raceCanvas(): HTMLCanvasElement {
  const p = new PixelCanvas(240, 16);
  p.rect(0, 0, 240, 16, C.slate);
  p.hline(0, 0, 240, C.lemon);
  p.hline(0, 15, 240, C.lemon);
  for (let x = 5; x < 235; x += 16) p.hline(x, 8, 7, C.white);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 2; x++) p.rect(226 + x * 5, y * 4, 5, 4, (x + y) % 2 ? C.white : C.night);
  p.rect(5, 2, 47, 6, C.slate);
  drawText(p, 6, 2, "OFFICE GP", C.lemon);
  return p.toCanvas();
}

export class PartyWorld {
  private overlays = new Map<string, Overlay>();
  private textures = new Map<string, Texture>();
  private inbox = new PartyInbox();
  private moments: Moment[] = [];
  private particles: Particle[] = [];
  private readonly paint = new Graphics();
  private readonly danceTexture = Texture.from(floorCanvas());
  private readonly raceTexture = Texture.from(raceCanvas());
  private danceFloor: Sprite | null = null;
  private raceStrip: Sprite | null = null;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(
    private scene: OfficeScene,
    private chars: CharacterManager,
    private model: OfficeModel,
  ) {
    this.paint.eventMode = "none";
    scene.fx.addChild(this.paint);
  }

  setState(state: PartyState): void {
    for (const event of this.inbox.take(state.events, Date.now() + this.model.clockSkew)) {
      this.moments.push({ event, age: 0, started: false });
    }
    while (this.moments.length > MAX_MOMENTS) this.removeMoment(0);
  }

  private avatar(personId: string): AvatarSpec {
    return this.model.people.get(personId)?.avatar ?? avatarFromSeed(personId);
  }

  private actor(personId: string): SessionCharacter | undefined {
    for (const c of this.chars.chars.values())
      if (
        c.personId === personId &&
        !c.removed &&
        c.sprite.visible &&
        !this.model.sessions.get(c.sessionId)?.offline
      )
        return c;
    return undefined;
  }

  private attachFloor(): void {
    // Decals never change map collisions. Re-attach after the office grows/rebuilds.
    if (!this.danceFloor || this.danceFloor.destroyed) {
      this.danceFloor = new Sprite(this.danceTexture);
      this.danceFloor.position.set(34 * TILE + 4, 24 * TILE + 2);
      this.danceFloor.alpha = 0.78;
      this.danceFloor.eventMode = "none";
      this.scene.decals.addChild(this.danceFloor);
    }
    if (!this.raceStrip || this.raceStrip.destroyed) {
      this.raceStrip = new Sprite(this.raceTexture);
      this.raceStrip.position.set(34 * TILE, (this.scene.map.height - 1) * TILE);
      this.raceStrip.eventMode = "none";
      this.scene.decals.addChild(this.raceStrip);
    }
  }

  update(dt: number, time: number): void {
    this.attachFloor();
    this.danceFloor!.alpha = this.reducedMotion ? 0.8 : 0.72 + Math.sin(time * 2) * 0.1;
    const liveTextures = new Set<string>();
    for (const [id, overlay] of this.overlays) {
      const c = this.chars.chars.get(id);
      if (!c || c.removed || this.avatar(c.personId).vehicle === "none") {
        overlay.sprite.destroy();
        this.overlays.delete(id);
      }
    }
    for (const c of this.chars.chars.values()) {
      if (c.removed || this.avatar(c.personId).vehicle === "none") continue;
      const look = this.avatar(c.personId);
      const key = `${look.vehicle}|${look.accentColor}`;
      liveTextures.add(key);
      let overlay = this.overlays.get(c.sessionId);
      let texture = this.textures.get(key);
      if (!texture) {
        texture = Texture.from(vehicleCanvas(look));
        this.textures.set(key, texture);
      }
      if (!overlay || overlay.sprite.destroyed) {
        const sprite = new Sprite(texture);
        sprite.label = "actor";
        sprite.anchor.set(0.5, 0.75);
        sprite.eventMode = "none";
        this.scene.objects.addChild(sprite);
        overlay = { sprite, key };
        this.overlays.set(c.sessionId, overlay);
      } else if (overlay.key !== key) {
        overlay.sprite.texture = texture;
        overlay.key = key;
      }
      overlay.sprite.position.copyFrom(c.sprite.position);
      overlay.sprite.zIndex = c.sprite.zIndex + 0.2;
      overlay.sprite.visible = c.sprite.visible && c.mode !== "zapped";
      overlay.sprite.alpha = c.sprite.alpha;
      overlay.sprite.rotation = 0;
      // Gestures animate accessories, never falsify the coding session's activity.
      if (!this.reducedMotion) {
        for (const m of this.moments) {
          if (m.event.personId !== c.personId || m.age > 2.2) continue;
          if (m.event.action === "dance") {
            overlay.sprite.rotation = Math.sin(m.age * 14) * 0.12;
            overlay.sprite.y -= Math.abs(Math.sin(m.age * 9)) * 3;
          } else if (m.event.action === "wave" || m.event.action === "high-five") {
            overlay.sprite.rotation = Math.sin(m.age * 10) * 0.07;
          }
        }
      }
    }
    // Destroy only textures no displayed sibling uses (equipment changes cannot leak textures).
    for (const [key, texture] of this.textures)
      if (!liveTextures.has(key)) {
        texture.destroy(true);
        this.textures.delete(key);
      }
    this.paint.clear();
    for (let i = this.moments.length - 1; i >= 0; i--) {
      const m = this.moments[i]!;
      const c = this.actor(m.event.personId);
      m.age += dt;
      if (!m.started && c) {
        m.started = true;
        this.start(m, c);
      }
      if (c) this.drawMoment(m, c);
      if (m.age > 3.5) this.removeMoment(i);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.age += dt;
      if (p.age >= p.life) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (!this.reducedMotion && (p.shape === "pixel" || p.shape === "star")) p.vy += dt * 30;
      this.drawParticle(p);
    }
  }

  private removeMoment(index: number): void {
    const [m] = this.moments.splice(index, 1);
    if (m?.vehicle) {
      const texture = m.vehicle.texture;
      m.vehicle.destroy();
      texture.destroy(true);
    }
  }

  private start(m: Moment, c: SessionCharacter): void {
    const event = m.event;
    const look = this.avatar(c.personId);
    const colors = [C.cyan, C.pink, C.neon, C.lemon, C.berry];
    let shape: Particle["shape"] = "star";
    let color: string = accentHex(look.accentColor);
    let amount = 20;
    let gravity = true;
    if (event.action === "use") {
      switch (event.item) {
        case "confetti":
          shape = "pixel";
          amount = 54;
          break;
        case "bubble-wand":
          shape = "bubble";
          amount = 18;
          gravity = false;
          break;
        case "joint":
        case "cigarette":
          shape = "smoke";
          color = C.silver;
          amount = 10;
          gravity = false;
          break;
        case "coffee":
        case "beer":
          shape = "bubble";
          color = C.lemon;
          amount = 12;
          break;
        case "disco-ball":
          shape = "star";
          amount = 36;
          break;
        case "magic-wand":
          shape = "star";
          color = C.lemon;
          amount = 30;
          break;
        case "balloon":
          shape = "bubble";
          amount = 10;
          gravity = false;
          break;
        case "water-pistol":
          shape = "pixel";
          color = C.cyan;
          amount = 28;
          break;
        case "maracas":
          shape = "note";
          amount = 14;
          gravity = false;
          break;
        case "umbrella":
          shape = "pixel";
          color = C.sky;
          amount = 24;
          break;
        case "lightsaber":
          shape = "star";
          amount = 15;
          break;
      }
    } else if (event.action === "dance") {
      shape = "note";
      amount = 18;
      gravity = false;
    } else if (event.action === "race") {
      m.vehicle = new Sprite(
        Texture.from(
          avatarPortrait(
            { ...look, vehicle: event.vehicle },
            this.model.sessions.get(c.sessionId)?.agent ?? "codex",
          ),
        ),
      );
      m.vehicle.anchor.set(0.5, 0.75);
      m.vehicle.eventMode = "none";
      this.scene.fx.addChild(m.vehicle);
      amount = 10;
    }
    if (this.reducedMotion) amount = Math.min(5, amount);
    for (let i = 0; i < amount && this.particles.length < MAX_PARTICLES; i++) {
      const angle = (i / amount) * Math.PI * 2;
      const speed = 12 + (i % 7) * 5;
      this.particles.push({
        x: c.x + (event.action === "use" ? 12 : 0),
        y: c.y - 20,
        vx: this.reducedMotion ? 0 : Math.cos(angle) * speed,
        vy: this.reducedMotion ? 0 : gravity ? Math.sin(angle) * speed - 18 : -12 - (i % 5) * 5,
        age: 0,
        life: 1.3 + (i % 5) * 0.23,
        color:
          event.item === "confetti" || event.item === "disco-ball"
            ? colors[i % colors.length]!
            : color,
        shape,
      });
    }
  }

  private drawMoment(m: Moment, c: SessionCharacter): void {
    const e = m.event;
    const alpha = Math.max(0, 1 - m.age / 3.5);
    const color = hexNum(accentHex(this.avatar(c.personId).accentColor));
    if (e.action === "race" && m.vehicle) {
      const progress = this.reducedMotion ? 1 : Math.min(1, m.age / 2.7);
      const roll = e.roll ?? 1;
      m.vehicle.position.set(
        34 * TILE + 15 + progress * (155 + roll * 7),
        (this.scene.map.height - 1) * TILE + 10,
      );
      m.vehicle.alpha = Math.min(1, alpha * 4);
      this.paint.rect(m.vehicle.x - 10, m.vehicle.y + 3, 17, 1).fill({ color, alpha });
    } else if (e.action === "high-five" || e.action === "tag") {
      const target = e.targetId ? this.actor(e.targetId) : undefined;
      if (target) {
        this.paint
          .moveTo(c.x, c.y - 15)
          .lineTo(target.x, target.y - 15)
          .stroke({ color, width: 1, alpha: alpha * 0.45 });
        const k = this.reducedMotion ? 1 : Math.min(1, m.age / 0.8);
        const x = c.x + (target.x - c.x) * k;
        const y = c.y - 15 + (target.y - c.y) * k;
        this.paint
          .star(x, y, 5, 6 + (this.reducedMotion ? 0 : Math.sin(m.age * 8) * 2), 2)
          .fill({ color, alpha });
      }
    } else if (e.action === "use" && e.item === "lightsaber") {
      const angle = this.reducedMotion
        ? -Math.PI / 4
        : -Math.PI + Math.min(1, m.age / 0.7) * Math.PI;
      const x = c.x + 12;
      const y = c.y - 12;
      this.paint
        .moveTo(x, y)
        .lineTo(x + Math.cos(angle) * 30, y + Math.sin(angle) * 30)
        .stroke({ color, width: 5, alpha });
      this.paint
        .moveTo(x, y)
        .lineTo(x + Math.cos(angle) * 30, y + Math.sin(angle) * 30)
        .stroke({ color: hexNum(C.white), width: 2, alpha });
    } else if (e.action === "use" && e.item === "water-pistol") {
      const target = e.targetId ? this.actor(e.targetId) : undefined;
      this.paint
        .moveTo(c.x + 12, c.y - 11)
        .lineTo(target?.x ?? c.x + 65, target ? target.y - 14 : c.y - 20)
        .stroke({ color: hexNum(C.cyan), width: 2, alpha });
    } else if (e.action === "wave") {
      this.paint.rect(c.x + 10, c.y - 33, 5, 6).fill({ color: hexNum(C.sand), alpha });
      for (let i = 0; i < 3; i++)
        this.paint.rect(c.x + 8 + i * 4, c.y - 38 - (i % 2) * 2, 1, 3).fill({ color, alpha });
    }
  }

  private drawParticle(p: Particle): void {
    const x = Math.round(p.x),
      y = Math.round(p.y);
    const fill = { color: hexNum(p.color), alpha: Math.min(1, (p.life - p.age) * 2) };
    if (p.shape === "bubble" || p.shape === "smoke") {
      this.paint
        .circle(x, y, p.shape === "smoke" ? 2 + p.age * 3 : 2 + (p.life % 3))
        .stroke({ ...fill, width: 1 });
      this.paint.rect(x - 1, y - 1, 1, 1).fill({ ...fill, color: hexNum(C.white) });
    } else if (p.shape === "star") {
      this.paint
        .rect(x - 2, y, 5, 1)
        .rect(x, y - 2, 1, 5)
        .fill(fill);
    } else if (p.shape === "note") {
      this.paint
        .rect(x, y - 5, 1, 6)
        .rect(x - 2, y, 3, 2)
        .rect(x, y - 5, 4, 1)
        .fill(fill);
    } else this.paint.rect(x, y, 2, p.life > 2 ? 3 : 1).fill(fill);
  }

  /** Resource counts for local diagnostics (including expired-effect cleanup). */
  counts(): { overlays: number; textures: number; moments: number; particles: number } {
    return {
      overlays: this.overlays.size,
      textures: this.textures.size,
      moments: this.moments.length,
      particles: this.particles.length,
    };
  }

  destroy(): void {
    for (const overlay of this.overlays.values()) overlay.sprite.destroy();
    this.overlays.clear();
    for (const texture of this.textures.values()) texture.destroy(true);
    this.textures.clear();
    while (this.moments.length) this.removeMoment(0);
    this.particles = [];
    this.paint.destroy();
    this.danceFloor?.destroy();
    this.raceStrip?.destroy();
    this.danceTexture.destroy(true);
    this.raceTexture.destroy(true);
  }
}
