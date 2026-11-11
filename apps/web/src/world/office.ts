/**
 * The static-ish office scene: terrain sprite, furniture (y-sorted), desk pods, window
 * panes, lamp glows, coffee steam and idle loops. Characters live in characters.ts.
 *
 * Layers (bottom to top): floor, decals, objects (y-sorted), night overlay, glows, fx.
 */
import { AGENT_PALETTES, type AvatarSpec } from "@agent-office/protocol";
import { Container, Sprite, type Texture } from "pixi.js";
import {
  chairTexture,
  deskTexture,
  doorTextures,
  MONITOR,
  MONITOR_FPS,
  type MonitorState,
  messTextures,
  monitorTextures,
  nameplateTexture,
  propTexture,
} from "../art/desk.ts";
import { furnitureFrames, furnitureMeta } from "../art/furniture.ts";
import { deskLampTextures, leafTexture } from "../art/fun.ts";
import { glowTexture, pixelTexture, whiteboardTexture } from "../art/fx.ts";
import { C, hexNum } from "../art/palette.ts";
import {
  podMatTexture,
  renderSurround,
  renderTerrain,
  rugTexture,
  SURROUND,
  WEATHER_FRAMES,
  type Weather,
  type WindowRect,
  windowPane,
} from "../art/tiles.ts";
import {
  deskPitch,
  deskPx,
  FOOTPRINTS,
  type MapObject,
  nookLayout,
  type OfficeMap,
  POD_COLS,
  type Poi,
  podBlockTiles,
  podDeskSpan,
  podOrigin,
  seatPoint,
  setSlotBlocked,
  TILE,
} from "./map.ts";

type Anim = {
  sprite: Sprite;
  frames: Texture[];
  fps: number;
  phase: number;
  kind: "loop" | "arcade" | "neon";
  /** tile x of the object (arcades: which machine someone plays) */
  tileX: number;
};
type Glow = { sprite: Sprite; base: number; kind: "lamp" | "window" };

export type DeskView = {
  pod: number;
  desk: number;
  chair: Sprite;
  monitor: Sprite;
  glow: Sprite;
  state: MonitorState;
  seat: { x: number; y: number };
  /** desk lamp (shown at night, lit while the session works) */
  lamp: Sprite;
  lampGlow: Sprite;
};

export type PodOwner = {
  personId: string;
  name: string;
  avatar: AvatarSpec;
  accent: string;
  /** index into POD_MATS (personal floor mat color) */
  mat: number;
};
/** What a pod slot shows: someone's pod (n desks), the free-desk placeholder, or a nook. */
export type SlotSpec =
  | { kind: "pod"; desks: number; owner: PodOwner }
  | { kind: "free" }
  | { kind: "nook" };

type SlotView = {
  key: string;
  spec: SlotSpec;
  desks: number;
  /** every display object this slot added (removed on change) */
  items: { layer: Container; obj: Sprite }[];
  /** textures made just for this slot (nameplates), destroyed with it */
  owned: Texture[];
  pois: Poi[];
  /** the owner's nameplate in world px (click target for the person panel) */
  plate?: { x: number; y: number; w: number; h: number; personId: string };
};

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
  private slots: SlotView[] = [];
  /** points of interest added by nooks (idle characters visit them too) */
  nookPois: Poi[] = [];
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
  /** someone has 10+ helpers: the game corner throws a party */
  party = false;
  /** tile x of arcade machines someone is playing right now */
  readonly arcadeBusy = new Set<number>();
  private partyGlows: { sprite: Sprite; y: number }[] = [];
  private leaves: { sprite: Sprite; from: number }[] = [];
  private sky: "day" | "dusk" | "night" = "day";
  weather: Weather = "sun";

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
    const keepChars = this.objects.children.filter(
      (c) => c.label === "character" || c.label === "actor",
    );
    for (const c of keepChars) this.objects.removeChild(c);
    for (const c of this.floor.removeChildren()) c.destroy({ texture: true, textureSource: true });
    for (const layer of [this.decals, this.objects, this.glows]) {
      for (const c of layer.removeChildren()) c.destroy();
    }
    this.map = map;
    this.desks.clear();
    this.slots = [];
    this.nookPois = [];
    this.anims = [];
    this.lampGlows = [];
    this.panes = [];
    this.steam = [];
    this.partyGlows = [];
    this.leaves = [];
    this.whiteboardKey = "";
    this.build();
    for (const c of keepChars) this.objects.addChild(c);
  }

  private build() {
    const terrain = renderTerrain(this.map);
    this.terrainCanvas = terrain.canvas;
    this.floor.addChild(new Sprite(terrain.texture));
    for (const piece of renderSurround(this.map)) {
      const s = new Sprite(piece.texture);
      s.position.set(piece.x, piece.y);
      this.floor.addChild(s);
    }
    this.overlay.position.set(-SURROUND, -SURROUND);
    this.overlay.width = this.widthPx + 2 * SURROUND;
    this.overlay.height = this.heightPx + 2 * SURROUND;

    for (const rect of terrain.windows) {
      const s = new Sprite(windowPane("day", rect.w, rect.h));
      s.position.set(rect.x, rect.y);
      this.decals.addChild(s);
      this.panes.push({ sprite: s, rect });
      this.addGlow(rect.x + rect.w / 2, rect.y + rect.h + 6, 20, C.cyan, 0.0, "window");
    }
    for (const ob of this.map.objects) this.placeObject(ob);
    // party lights over the game corner (hidden until someone runs 10+ helpers)
    const game = this.map.areas.find((a) => a.name === "game");
    if (game) {
      for (let i = 0; i < 4; i++) {
        const g = new Sprite(glowTexture(30, C.neon));
        g.anchor.set(0.5);
        g.visible = false;
        g.position.set((game.x + 3 + i * 3.5) * TILE, (game.y + 2.5) * TILE);
        this.glows.addChild(g);
        this.partyGlows.push({ sprite: g, y: g.y });
      }
    }
    for (let pod = 0; pod < this.slotCount; pod++) this.setSlot(pod, { kind: "nook" });

    const d = this.map.door;
    this.door = new Sprite(doorTextures()[0]!);
    this.door.position.set(d.x * TILE, d.y * TILE - 1);
    this.door.zIndex = (d.y + 1) * TILE;
    this.objects.addChild(this.door);
  }

  private addGlow(
    x: number,
    y: number,
    r: number,
    color: string,
    base: number,
    kind: Glow["kind"],
  ) {
    const s = new Sprite(glowTexture(r, color));
    s.anchor.set(0.5);
    s.position.set(Math.round(x), Math.round(y));
    s.alpha = 0;
    s.visible = false;
    this.glows.addChild(s);
    this.lampGlows.push({ sprite: s, base, kind });
  }

  get slotCount() {
    return this.map.podRows * POD_COLS;
  }

  private placeObject(ob: MapObject): Sprite[] {
    const frames = furnitureFrames(ob.kind, ob.variant ?? 0);
    const meta = furnitureMeta(ob.kind);
    if (!frames || !meta) return [];
    const added: Sprite[] = [];
    const glowsBefore = this.lampGlows.length;
    const fp = FOOTPRINTS[ob.kind];
    const fx = ob.x * TILE;
    const bottom = (ob.y + fp.h) * TILE + meta.dy;
    const s = new Sprite(frames[0]!);
    s.position.set(
      fx + Math.round((fp.w * TILE - meta.w) / 2) - meta.pad,
      bottom - meta.h - meta.pad,
    );
    s.zIndex = bottom + meta.z;
    this.objects.addChild(s);
    added.push(s);
    const left = s.x + meta.pad;
    const top = s.y + meta.pad;
    if (frames.length > 1) {
      const kind = ob.kind === "arcade" ? "arcade" : ob.kind === "neon" ? "neon" : "loop";
      const fps = ob.kind === "tree" ? 0.7 : ob.kind === "tv" ? 2 : 1.4;
      this.anims.push({
        sprite: s,
        frames,
        fps,
        phase: (ob.x * 7 + ob.y * 3) % 10,
        kind,
        tileX: ob.x,
      });
    }
    if (ob.kind === "plant" || ob.kind === "plantBig") {
      // a new leaf or two sprouts as the day goes on
      const spots =
        ob.kind === "plant"
          ? [
              { x: left - 2, y: top + 3, from: 11 },
              { x: left + meta.w - 3, y: top + 6, from: 15 },
            ]
          : [
              { x: left - 2, y: top + 4, from: 10.5 },
              { x: left + meta.w - 3, y: top + 9, from: 14.5 },
            ];
      for (const sp of spots) {
        const leaf = new Sprite(leafTexture());
        leaf.position.set(sp.x, sp.y);
        leaf.zIndex = s.zIndex + 0.1;
        leaf.visible = false;
        if (sp.x > left + 4) leaf.scale.x = -1;
        if (sp.x > left + 4) leaf.x += 6;
        this.objects.addChild(leaf);
        added.push(leaf);
        this.leaves.push({ sprite: leaf, from: sp.from });
      }
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
        this.addGlow(
          left + meta.w / 2,
          top + 10,
          16,
          ob.kind === "tv" ? C.sky : C.berry,
          0.6,
          "lamp",
        );
        break;
      default:
        break;
    }
    for (const g of this.lampGlows.slice(glowsBefore)) added.push(g.sprite);
    return added;
  }

  /** Show a slot as someone's pod, the free-desk placeholder or a cozy nook (idempotent). */
  setSlot(pod: number, spec: SlotSpec): boolean {
    if (pod >= this.slotCount) return false;
    const key =
      spec.kind === "pod"
        ? `pod:${spec.desks}:${spec.owner.personId}:${spec.owner.name}:${JSON.stringify(spec.owner.avatar)}:${spec.owner.mat}`
        : spec.kind;
    const old = this.slots[pod];
    if (old && old.key === key) return false;
    if (old) this.clearSlot(pod, old);
    const view: SlotView = { key, spec, desks: 0, items: [], owned: [], pois: [] };
    this.slots[pod] = view;
    if (spec.kind === "nook") this.buildNook(pod, view);
    else this.buildPod(pod, view, spec.kind === "pod" ? spec.desks : 2, spec);
    return true;
  }

  /** Desk rows of pods (and the free desk) in world px, for the minimap. */
  deskRects(): { x: number; y: number; w: number; h: number; mine: boolean }[] {
    const out: { x: number; y: number; w: number; h: number; mine: boolean }[] = [];
    this.slots.forEach((v, pod) => {
      if (v.spec.kind === "nook") return;
      const n = v.spec.kind === "pod" ? v.spec.desks : 2;
      const span = podDeskSpan(pod, n);
      out.push({ x: span.x, y: podOrigin(pod).y * TILE, w: span.w, h: 28, mine: v.desks > 0 });
    });
    return out;
  }

  /** personId whose nameplate is under a world point (a little slack for fingers). */
  pickNameplate(wx: number, wy: number): string | null {
    for (const v of this.slots) {
      const p = v?.plate;
      if (p && wx >= p.x - 3 && wx <= p.x + p.w + 3 && wy >= p.y - 3 && wy <= p.y + p.h + 3)
        return p.personId;
    }
    return null;
  }

  slotDesks(pod: number): number {
    return this.slots[pod]?.desks ?? 0;
  }

  private clearSlot(pod: number, view: SlotView) {
    for (const { layer, obj } of view.items) {
      layer.removeChild(obj);
      obj.destroy();
    }
    for (const t of view.owned) t.destroy(true);
    const gone = new Set(view.items.map((i) => i.obj));
    this.anims = this.anims.filter((a) => !gone.has(a.sprite));
    this.leaves = this.leaves.filter((l) => !gone.has(l.sprite));
    this.lampGlows = this.lampGlows.filter((g) => !gone.has(g.sprite));
    for (let d = 0; d < view.desks; d++) this.desks.delete(`${pod}:${d}`);
    if (view.pois.length) this.nookPois = this.nookPois.filter((p) => !view.pois.includes(p));
    setSlotBlocked(this.map, pod, []);
  }

  private track(view: SlotView, layer: Container, ...objs: Sprite[]) {
    for (const obj of objs) {
      layer.addChild(obj);
      view.items.push({ layer, obj });
    }
  }

  private buildNook(pod: number, view: SlotView) {
    const nook = nookLayout(pod);
    const rug = new Sprite(rugTexture(nook.rug.w, nook.rug.h, nook.rug.variant));
    rug.position.set(nook.rug.x, nook.rug.y - 1);
    this.track(view, this.decals, rug);
    for (const ob of nook.objects) {
      for (const s of this.placeObject(ob)) {
        // placeObject already added them to their layer; just remember them
        view.items.push({ layer: s.parent as Container, obj: s });
      }
    }
    view.pois = nook.pois;
    this.nookPois.push(...nook.pois);
    setSlotBlocked(this.map, pod, nook.block);
  }

  private buildPod(pod: number, view: SlotView, n: number, spec: SlotSpec) {
    const o = podOrigin(pod);
    const pitch = deskPitch(n);
    const span = podDeskSpan(pod, n);
    view.desks = spec.kind === "pod" ? n : 0;
    const owner = spec.kind === "pod" ? spec.owner : null;
    const mat = new Sprite(podMatTexture(span.w + 12, owner ? owner.mat : 0));
    mat.position.set(span.x - 6, o.y * TILE + 30);
    this.track(view, this.decals, mat);
    for (let d = 0; d < n; d++) {
      const t = deskPx(pod, d, n);
      const desk = new Sprite(deskTexture(pitch));
      desk.position.set(t.x - 1, t.y + 3);
      desk.zIndex = t.y + 32;
      const monitor = new Sprite(monitorTextures()[MONITOR.off[0]]!);
      monitor.position.set(t.x + Math.round(pitch / 2) - 10, t.y - 5);
      monitor.zIndex = desk.zIndex + 0.5;
      const seat = seatPoint(pod, d, n);
      const chair = new Sprite(chairTexture());
      chair.position.set(seat.x - 8, seat.y - 4);
      chair.zIndex = seat.y + 1;
      this.track(view, this.objects, desk, monitor, chair);
      if (!owner) continue;
      const glow = new Sprite(glowTexture(14, C.leaf));
      glow.anchor.set(0.5);
      glow.position.set(t.x + Math.round(pitch / 2), t.y + 2);
      glow.alpha = 0;
      glow.visible = false;
      const lamp = new Sprite(deskLampTextures()[0]!);
      lamp.position.set(t.x + 1, t.y + 1);
      lamp.zIndex = desk.zIndex + 0.4;
      lamp.visible = false;
      const lampGlow = new Sprite(glowTexture(16, C.amber));
      lampGlow.anchor.set(0.5);
      lampGlow.position.set(t.x + 5, t.y + 10);
      lampGlow.visible = false;
      lampGlow.alpha = 0.75;
      this.track(view, this.glows, glow, lampGlow);
      this.track(view, this.objects, lamp);
      this.desks.set(`${pod}:${d}`, {
        pod,
        desk: d,
        chair,
        monitor,
        glow,
        state: "off",
        seat,
        lamp,
        lampGlow,
      });
    }
    setSlotBlocked(this.map, pod, podBlockTiles(pod, n));
    const plate = new Sprite(
      owner ? nameplateTexture(owner.name, owner.accent) : nameplateTexture("free desk", C.grey),
    );
    plate.position.set(Math.round(span.x + span.w / 2 - plate.width / 2), (o.y + 3) * TILE + 2);
    if (!owner) plate.alpha = 0.75;
    else
      view.plate = {
        x: plate.x,
        y: plate.y,
        w: plate.width,
        h: plate.height,
        personId: owner.personId,
      };
    this.track(view, this.decals, plate);
    view.owned.push(plate.texture);
    if (!owner) {
      // a welcome plant on the free desk
      const t = deskPx(pod, 1, n);
      const tex = propTexture("plant");
      const s = new Sprite(tex);
      s.position.set(t.x + pitch - 9, t.y + 14 - tex.height);
      s.zIndex = t.y + 33;
      this.track(view, this.objects, s);
      return;
    }
    // personal touches: the avatar's desk props spread over the desks, mess by level
    owner.avatar.deskProps.forEach((prop, i) => {
      const desk = i === 0 ? 0 : i === 1 ? n - 1 : Math.min(n - 1, 1);
      const t = deskPx(pod, desk, n);
      const tex = propTexture(prop);
      const s = new Sprite(tex);
      const right = i % 2 === 1;
      s.position.set(t.x + (right ? pitch - 9 : -1), t.y + 14 - tex.height);
      s.zIndex = t.y + 33;
      this.track(view, this.objects, s);
    });
    const mess = messTextures();
    const level = owner.avatar.deskMess;
    for (let i = 0; i < level * 2; i++) {
      const desk = (i * 3 + 1) % n;
      const t = deskPx(pod, desk, n);
      const s = new Sprite(mess[(i + pod) % mess.length]!);
      s.position.set(t.x + (i % 2 ? 2 : pitch - 10), t.y + 11 - (i % 3));
      s.zIndex = t.y + 32.6;
      this.track(view, this.objects, s);
    }
    if (level >= 2) {
      // chaos spills onto the floor mat
      for (let i = 0; i < level - 1; i++) {
        const s = new Sprite(mess[(i * 2 + 1) % mess.length]!);
        s.position.set(span.x + span.w - 4 - i * 9, o.y * TILE + 46 + (i % 2) * 3);
        this.track(view, this.decals, s);
      }
    }
  }

  desk(pod: number, desk: number): DeskView | undefined {
    return this.desks.get(`${pod}:${desk}`);
  }

  setMonitor(pod: number, desk: number, state: MonitorState) {
    const d = this.desk(pod, desk);
    if (!d || d.state === state) return;
    d.state = state;
    d.monitor.texture = monitorTextures()[MONITOR[state][0]]!;
    d.glow.texture = glowTexture(
      14,
      state === "run" ? C.leaf : state === "wait" ? C.amber : state === "think" ? C.lemon : C.sky,
    );
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
    this.sky = sky;
    for (const p of this.panes) p.sprite.texture = windowPane(sky, p.rect.w, p.rect.h, this.weather);
    for (const g of this.lampGlows) {
      g.sprite.alpha = g.kind === "lamp" ? g.base * night : sky === "day" ? 0.12 : 0;
      g.sprite.visible = g.sprite.alpha > 0.01;
    }
    this.night = night;
  }
  night = 0;

  /** Local hour (living.ts, every 2 s): plants sprout their new leaves through the day. */
  setHour(hour: number) {
    for (const l of this.leaves) l.sprite.visible = hour >= l.from;
  }

  update(time: number, dt: number) {
    for (const a of this.anims) {
      let idx: number;
      if (a.kind === "arcade") {
        if (this.party) idx = 1 + (Math.floor(time * 8 + a.phase) % 2);
        else if (this.arcadeBusy.has(a.tileX))
          // someone plays: the screen flashes with the action
          idx = Math.floor(time * 5 + a.phase) % 5 === 0 ? 0 : 1 + (Math.floor(time * 4) % 2);
        else idx = this.gameLit ? 1 + (Math.floor(time * 3 + a.phase) % 2) : 0;
      } else if (a.kind === "neon")
        idx = this.party
          ? Math.floor(time * 4) % 2
          : this.gameLit
            ? 1
            : Math.floor(time * 0.5 + a.phase) % 7 === 0
              ? 1
              : 0;
      else idx = Math.floor(time * a.fps + a.phase) % a.frames.length;
      const tex = a.frames[idx]!;
      if (a.sprite.texture !== tex) a.sprite.texture = tex;
    }
    // monitors: per-state speed (running output scrolls, reading flips pages)
    const lampsOn = this.night > 0.35;
    for (const d of this.desks.values()) {
      const working = d.state !== "off" && d.state !== "idle";
      d.lamp.visible = lampsOn;
      if (lampsOn) {
        const lt = deskLampTextures()[working ? 1 : 0]!;
        if (d.lamp.texture !== lt) d.lamp.texture = lt;
      }
      d.lampGlow.visible = lampsOn && working;
      if (d.state === "off") {
        d.glow.visible = false;
        continue;
      }
      const frames = MONITOR[d.state];
      const tick = Math.floor(time * MONITOR_FPS[d.state] + d.desk * 1.7 + d.pod * 0.9);
      const tex = monitorTextures()[frames[tick % frames.length]!]!;
      if (d.monitor.texture !== tex) d.monitor.texture = tex;
      d.glow.alpha =
        d.state === "run" ? 0.55 + 0.15 * Math.sin(time * 4 + d.desk) : 0.35 * this.night;
      d.glow.visible = d.glow.alpha > 0.01;
    }
    // weather drifting by in the window panes
    const wn = WEATHER_FRAMES[this.weather];
    if (wn > 1) {
      const f = Math.floor(time * (this.weather === "rain" ? 6 : 0.25)) % wn;
      for (const p of this.panes) {
        const t = windowPane(this.sky, p.rect.w, p.rect.h, this.weather, f);
        if (p.sprite.texture !== t) p.sprite.texture = t;
      }
    }
    // party lights in the game corner
    for (const [i, { sprite: g, y }] of this.partyGlows.entries()) {
      g.visible = this.party;
      if (!this.party) continue;
      const cols = [C.neon, C.cyan, C.lemon, C.pink, C.leaf];
      g.texture = glowTexture(30, cols[(Math.floor(time * 3) + i) % cols.length]!);
      g.alpha = 0.35 + 0.25 * Math.sin(time * 7 + i * 1.3);
      g.y = Math.round(y + Math.sin(time * 2 + i) * 6);
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
    this.doorOpen +=
      Math.sign(target - this.doorOpen) * Math.min(Math.abs(target - this.doorOpen), dt * 10);
    const tex = doorTextures()[Math.round(this.doorOpen)]!;
    if (this.door.texture !== tex) this.door.texture = tex;
  }
}
