/**
 * The static-ish office scene: terrain sprite, furniture (y-sorted), desk pods, window
 * panes, lamp glows, coffee steam and idle loops. Characters live in characters.ts.
 *
 * Layers (bottom to top): floor, decals, objects (y-sorted), night overlay, glows, fx.
 */
import { type AvatarSpec, AGENT_PALETTES } from "@agent-office/protocol";
import { Container, Sprite, type Texture } from "pixi.js";
import {
  chairTexture,
  deskTexture,
  MONITOR,
  type MonitorState,
  messTextures,
  monitorTextures,
  nameplateTexture,
  propTexture,
  doorTextures,
} from "../art/desk.ts";
import { furnitureFrames, furnitureMeta } from "../art/furniture.ts";
import { glowTexture, pixelTexture, whiteboardTexture } from "../art/fx.ts";
import { C, hexNum } from "../art/palette.ts";
import { renderTerrain, type WindowRect, windowPane } from "../art/tiles.ts";
import {
  DESKS_PER_POD,
  deskTile,
  FOOTPRINTS,
  type MapObject,
  type OfficeMap,
  POD_COLS,
  podOrigin,
  seatPoint,
  TILE,
} from "./map.ts";

type Anim = { sprite: Sprite; frames: Texture[]; fps: number; phase: number; kind: "loop" | "arcade" | "neon" };
type Glow = { sprite: Sprite; base: number; kind: "lamp" | "window" };

export type DeskView = {
  pod: number;
  desk: number;
  chair: Sprite;
  monitor: Sprite;
  glow: Sprite;
  state: MonitorState;
  seat: { x: number; y: number };
};

type PodView = { nameplate: Sprite | null; props: Sprite[]; personId: string | null };

export class OfficeScene {
  readonly root = new Container();
  readonly floor = new Container();
  readonly decals = new Container();
  readonly objects = new Container();
  readonly overlay: Sprite;
  readonly glows = new Container();
  readonly fx = new Container();
  terrainCanvas!: HTMLCanvasElement;
  readonly desks = new Map<string, DeskView>();
  private pods: PodView[] = [];
  private anims: Anim[] = [];
  private lampGlows: Glow[] = [];
  private panes: { sprite: Sprite; rect: WindowRect }[] = [];
  private steam: { sprite: Sprite; t: number }[] = [];
  private steamOrigin = { x: 0, y: 0 };
  private door!: Sprite;
  private doorOpen = 0;
  doorWanted = false;
  private whiteboard!: Sprite;
  private whiteboardKey = "";
  gameLit = false;

  constructor(public map: OfficeMap) {
    this.objects.sortableChildren = true;
    this.overlay = new Sprite(pixelTexture());
    this.overlay.blendMode = "multiply";
    this.overlay.alpha = 0;
    this.glows.blendMode = "add";
    this.root.addChild(this.floor, this.decals, this.objects, this.overlay, this.glows, this.fx);
    this.build();
  }

  get widthPx() {
    return this.map.width * TILE;
  }
  get heightPx() {
    return this.map.height * TILE;
  }

  /** Rebuild everything static (used when the desk floor grows). Characters re-attach. */
  rebuild(map: OfficeMap) {
    const keepChars = this.objects.children.filter((c) => c.label === "character" || c.label === "actor");
    for (const c of keepChars) this.objects.removeChild(c);
    for (const layer of [this.floor, this.decals, this.objects, this.glows]) {
      for (const c of layer.removeChildren()) c.destroy();
    }
    this.map = map;
    this.desks.clear();
    this.pods = [];
    this.anims = [];
    this.lampGlows = [];
    this.panes = [];
    this.steam = [];
    this.whiteboardKey = "";
    this.build();
    for (const c of keepChars) this.objects.addChild(c);
  }

  private build() {
    const terrain = renderTerrain(this.map);
    this.terrainCanvas = terrain.canvas;
    this.floor.addChild(new Sprite(terrain.texture));
    this.overlay.width = this.widthPx;
    this.overlay.height = this.heightPx;

    for (const rect of terrain.windows) {
      const s = new Sprite(windowPane("day", rect.w, rect.h));
      s.position.set(rect.x, rect.y);
      this.decals.addChild(s);
      this.panes.push({ sprite: s, rect });
      this.addGlow(rect.x + rect.w / 2, rect.y + rect.h + 6, 20, C.cyan, 0.0, "window");
    }
    for (const ob of this.map.objects) this.placeObject(ob);
    for (let pod = 0; pod < this.map.podRows * POD_COLS; pod++) this.buildPod(pod);

    const d = this.map.door;
    this.door = new Sprite(doorTextures()[0]!);
    this.door.position.set(d.x * TILE, d.y * TILE - 1);
    this.door.zIndex = (d.y + 1) * TILE;
    this.objects.addChild(this.door);
  }

  private addGlow(x: number, y: number, r: number, color: string, base: number, kind: Glow["kind"]) {
    const s = new Sprite(glowTexture(r, color));
    s.anchor.set(0.5);
    s.position.set(Math.round(x), Math.round(y));
    s.alpha = 0;
    s.visible = false;
    this.glows.addChild(s);
    this.lampGlows.push({ sprite: s, base, kind });
  }

  private placeObject(ob: MapObject) {
    const frames = furnitureFrames(ob.kind, ob.variant ?? 0);
    const meta = furnitureMeta(ob.kind);
    if (!frames || !meta) return;
    const fp = FOOTPRINTS[ob.kind];
    const fx = ob.x * TILE;
    const bottom = (ob.y + fp.h) * TILE + meta.dy;
    const s = new Sprite(frames[0]!);
    s.position.set(fx + Math.round((fp.w * TILE - meta.w) / 2) - meta.pad, bottom - meta.h - meta.pad);
    s.zIndex = bottom + meta.z;
    this.objects.addChild(s);
    const left = s.x + meta.pad;
    const top = s.y + meta.pad;
    if (frames.length > 1) {
      const kind = ob.kind === "arcade" ? "arcade" : ob.kind === "neon" ? "neon" : "loop";
      const fps = ob.kind === "tree" ? 0.7 : ob.kind === "tv" ? 2 : 1.4;
      this.anims.push({ sprite: s, frames, fps, phase: (ob.x * 7 + ob.y * 3) % 10, kind });
    }
    switch (ob.kind) {
      case "floorLamp":
        this.addGlow(left + 6, top + 6, 26, C.amber, 0.9, "lamp");
        break;
      case "lampPost":
        this.addGlow(left + 5, top + 5, 30, C.lemon, 1, "lamp");
        break;
      case "coffee":
        this.steamOrigin = { x: left + 6, y: top - 1 };
        for (let i = 0; i < 5; i++) {
          const p = new Sprite(pixelTexture());
          p.scale.set(0.5);
          p.zIndex = 9999;
          this.objects.addChild(p);
          this.steam.push({ sprite: p, t: i / 5 });
        }
        break;
      case "whiteboard":
        this.whiteboard = new Sprite(whiteboardTexture(0, 0, 0, []));
        this.whiteboard.position.set(left + 2, top + 2);
        this.whiteboard.zIndex = s.zIndex + 1;
        this.objects.addChild(this.whiteboard);
        break;
      case "arcade":
      case "tv":
        this.addGlow(left + meta.w / 2, top + 10, 16, ob.kind === "tv" ? C.sky : C.berry, 0.6, "lamp");
        break;
      default:
        break;
    }
  }

  private buildPod(pod: number) {
    const o = podOrigin(pod);
    this.pods[pod] = { nameplate: null, props: [], personId: null };
    for (let d = 0; d < DESKS_PER_POD; d++) {
      const t = deskTile(pod, d);
      const desk = new Sprite(deskTexture());
      desk.position.set(t.x * TILE - 1, t.y * TILE + 3);
      desk.zIndex = t.y * TILE + 32;
      const monitor = new Sprite(monitorTextures()[MONITOR.off[0]]!);
      monitor.position.set(t.x * TILE + 6, t.y * TILE - 5);
      monitor.zIndex = desk.zIndex + 0.5;
      const seat = seatPoint(pod, d);
      const chair = new Sprite(chairTexture());
      chair.position.set(seat.x - 8, seat.y - 4);
      chair.zIndex = seat.y + 1;
      const glow = new Sprite(glowTexture(14, C.leaf));
      glow.anchor.set(0.5);
      glow.position.set(t.x * TILE + 16, t.y * TILE + 2);
      glow.alpha = 0;
      glow.visible = false;
      this.glows.addChild(glow);
      this.objects.addChild(desk, monitor, chair);
      this.desks.set(`${pod}:${d}`, { pod, desk: d, chair, monitor, glow, state: "off", seat });
    }
    void o;
  }

  desk(pod: number, desk: number): DeskView | undefined {
    return this.desks.get(`${pod}:${desk}`);
  }

  setMonitor(pod: number, desk: number, state: MonitorState) {
    const d = this.desk(pod, desk);
    if (!d || d.state === state) return;
    d.state = state;
    d.monitor.texture = monitorTextures()[MONITOR[state][0]]!;
    d.glow.texture = glowTexture(14, state === "run" ? C.leaf : state === "wait" ? C.amber : C.sky);
  }

  /** Show the owner's name + desk props on a pod (null clears it). */
  setPodOwner(pod: number, owner: { personId: string; name: string; avatar: AvatarSpec; accent: string } | null) {
    const p = this.pods[pod];
    if (!p) return;
    if (p.nameplate) {
      this.decals.removeChild(p.nameplate);
      p.nameplate.destroy({ texture: true, textureSource: true });
      p.nameplate = null;
    }
    for (const s of p.props) {
      this.objects.removeChild(s);
      s.destroy();
    }
    p.props = [];
    p.personId = owner?.personId ?? null;
    if (!owner) return;
    const o = podOrigin(pod);
    const plate = new Sprite(nameplateTexture(owner.name, owner.accent));
    plate.position.set(Math.round((o.x + 4) * TILE - plate.width / 2), (o.y + 3) * TILE + 2);
    this.decals.addChild(plate);
    p.nameplate = plate;
    owner.avatar.deskProps.forEach((prop, i) => {
      const t = deskTile(pod, i % DESKS_PER_POD);
      const tex = propTexture(prop);
      const s = new Sprite(tex);
      const right = i % 2 === 1;
      s.position.set(t.x * TILE + (right ? 24 : -1), t.y * TILE + 14 - tex.height);
      s.zIndex = t.y * TILE + 33;
      this.objects.addChild(s);
      p.props.push(s);
    });
    const mess = messTextures();
    for (let i = 0; i < owner.avatar.deskMess; i++) {
      const t = deskTile(pod, (i + 1) % DESKS_PER_POD);
      const s = new Sprite(mess[i % mess.length]!);
      s.position.set(t.x * TILE + (i % 2 ? 3 : 22), t.y * TILE + 12);
      s.zIndex = t.y * TILE + 32.6;
      this.objects.addChild(s);
      p.props.push(s);
    }
  }

  accentFor(agent: keyof typeof AGENT_PALETTES) {
    return AGENT_PALETTES[agent].main;
  }

  updateWhiteboard(now: number, peak: number, started: number, history: number[]) {
    const key = `${now}|${peak}|${started}|${history.join(",")}`;
    if (key === this.whiteboardKey || !this.whiteboard) return;
    this.whiteboardKey = key;
    const old = this.whiteboard.texture;
    this.whiteboard.texture = whiteboardTexture(now, peak, started, history);
    old.destroy(true);
  }

  /** Called ~once a minute by living.ts. */
  setDaylight(night: number, sky: "day" | "dusk" | "night", tint: string, alpha: number) {
    this.overlay.tint = hexNum(tint);
    this.overlay.alpha = alpha;
    this.overlay.visible = alpha > 0.01;
    for (const p of this.panes) p.sprite.texture = windowPane(sky, p.rect.w, p.rect.h);
    for (const g of this.lampGlows) {
      g.sprite.alpha = g.kind === "lamp" ? g.base * night : sky === "day" ? 0.12 : 0;
      g.sprite.visible = g.sprite.alpha > 0.01;
    }
    this.night = night;
  }
  night = 0;

  update(time: number, dt: number) {
    for (const a of this.anims) {
      let idx: number;
      if (a.kind === "arcade") idx = this.gameLit ? 1 + (Math.floor(time * 3 + a.phase) % 2) : 0;
      else if (a.kind === "neon") idx = this.gameLit ? 1 : Math.floor(time * 0.5 + a.phase) % 7 === 0 ? 1 : 0;
      else idx = Math.floor(time * a.fps + a.phase) % a.frames.length;
      const tex = a.frames[idx]!;
      if (a.sprite.texture !== tex) a.sprite.texture = tex;
    }
    // monitors: animate on-screens at ~2 fps
    const blink = Math.floor(time * 2);
    for (const d of this.desks.values()) {
      if (d.state === "off") {
        d.glow.visible = false;
        continue;
      }
      const frames = MONITOR[d.state];
      const tex = monitorTextures()[frames[(blink + d.desk) % frames.length]!]!;
      if (d.monitor.texture !== tex) d.monitor.texture = tex;
      d.glow.alpha = d.state === "run" ? 0.55 + 0.15 * Math.sin(time * 4 + d.desk) : 0.35 * this.night;
      d.glow.visible = d.glow.alpha > 0.01;
    }
    // coffee steam
    for (const p of this.steam) {
      p.t = (p.t + dt * 0.45) % 1;
      const s = p.sprite;
      s.x = Math.round(this.steamOrigin.x + Math.sin(p.t * 6 + s.zIndex) * 1.5);
      s.y = Math.round(this.steamOrigin.y - p.t * 14);
      s.alpha = 0.8 * (1 - p.t);
    }
    // main door eases open/closed
    const target = this.doorWanted ? 3 : 0;
    this.doorOpen += Math.sign(target - this.doorOpen) * Math.min(Math.abs(target - this.doorOpen), dt * 10);
    const tex = doorTextures()[Math.round(this.doorOpen)]!;
    if (this.door.texture !== tex) this.door.texture = tex;
  }
}
