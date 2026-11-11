/**
 * Session characters and their behavior state machine:
 *   walk in from the door -> sit at desk -> animate by activity
 *   idle -> wander to a point of interest (coffee, sofa, garden...) -> come back when busy
 *   waiting -> turn to camera, raise hand, "!" bubble (at the desk)
 *   ended -> wave, walk out the door, fade
 */
import {
  type Activity,
  type AgentKind,
  hashString,
  seededRandom,
  sessionVariation,
} from "@agent-office/protocol";
import { Sprite, type Texture } from "pixi.js";
import {
  type AnimName,
  CHAR_H,
  type CharacterSheet,
  characterSheet,
  lookFor,
} from "../art/characters.ts";
import type { MonitorState } from "../art/desk.ts";
import { alertTextures, bubbleTexture, dotsTextures, selectArrowTextures } from "../art/fx.ts";
import { C } from "../art/palette.ts";
import { POD_MATS } from "../art/tiles.ts";
import type { ModelChange, OfficeModel, PersonState, SessionState } from "../state/officeModel.ts";
import type { Effects } from "./effects.ts";
import { HelperSwarm } from "./helpers.ts";
import {
  chairTile,
  clampDesks,
  type Facing,
  MAX_DESKS,
  type Poi,
  type Point,
  podAisle,
  podDeskSpan,
  TILE,
} from "./map.ts";
import type { OfficeScene } from "./office.ts";
import { findPath } from "./pathing.ts";

const WALK_SPEED = 44;
const BUBBLE_SECONDS = 2.6;
/** at most this many speech bubbles at once (one per pod) so busy floors stay readable */
const MAX_BUBBLES = 6;

export type Moment = {
  /** joined = someone is about to come in (camera heads to the door); arrived = door opens */
  kind: "joined" | "arrived" | "started" | "waiting" | "left";
  x: number;
  y: number;
  name: string;
  personId?: string;
};

/** Seconds between `person.joined` and the door/confetti, so an auto camera can get there. */
const JOIN_LEAD = 1.8;

type Mode = "queued" | "walking" | "seated" | "poi" | "waving" | "leaving";
type Goal = "desk" | "poi" | "exit";

const tileCenter = (t: Point): Point => ({ x: t.x * TILE + 8, y: t.y * TILE + 13 });

export class SessionCharacter {
  readonly sprite: Sprite;
  sheet: CharacterSheet;
  x = 0;
  y = 0;
  facing: Facing = "up";
  mode: Mode = "seated";
  goal: Goal | null = null;
  path: Point[] = [];
  poi: Poi | null = null;
  timer = 0;
  animTime = 0;
  anim: AnimName = "sitType";
  bubble: Sprite;
  bubbleT = 0;
  marker: Sprite;
  helpers: HelperSwarm;
  delay = 0;
  removed = false;

  constructor(
    readonly sessionId: string,
    readonly personId: string,
    public agent: AgentKind,
    public pod: number,
    public desk: number,
    sheet: CharacterSheet,
    helpers: HelperSwarm,
  ) {
    this.sheet = sheet;
    this.sprite = new Sprite(sheet.anims.sitType[0]!);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.label = "character";
    this.bubble = new Sprite();
    this.bubble.anchor.set(0.5, 1);
    this.bubble.visible = false;
    this.marker = new Sprite();
    this.marker.anchor.set(0.5, 1);
    this.marker.visible = false;
    this.helpers = helpers;
  }

  get hasDesk() {
    return this.desk < MAX_DESKS;
  }
}

export class CharacterManager {
  readonly chars = new Map<string, SessionCharacter>();
  private poiTaken = new Map<string, string>();
  private rand = seededRandom("characters");
  /** desks per pod, kept at the high-water mark while the same person owns it */
  private podDesks = new Map<number, { personId: string; n: number }>();
  onMoment: (m: Moment) => void = () => {};
  /** pending join celebrations (door opens, confetti, banner) */
  private joins: { personId: string; t: number; done: boolean }[] = [];

  constructor(
    private readonly scene: OfficeScene,
    private readonly model: OfficeModel,
    private readonly effects: Effects,
  ) {}

  // ---- model changes --------------------------------------------------------------------
  handle(ch: ModelChange) {
    switch (ch.kind) {
      case "personAdded": {
        const p = this.model.people.get(ch.personId);
        if (!p) return;
        this.syncSlots();
        if (!ch.instant) {
          const door = this.doorPoint();
          this.joins.push({ personId: p.personId, t: JOIN_LEAD, done: false });
          this.onMoment({
            kind: "joined",
            x: door.x,
            y: door.y - 44,
            name: p.name,
            personId: p.personId,
          });
        }
        break;
      }
      case "personRemoved":
        // the pod stays until the person's characters have walked out (see destroy())
        this.syncSlots();
        break;
      case "avatarChanged": {
        const p = this.model.people.get(ch.personId);
        if (!p) return;
        for (const c of this.chars.values()) {
          if (c.personId !== p.personId) continue;
          const s = this.model.sessions.get(c.sessionId);
          if (s) c.sheet = this.sheetFor(p, s);
        }
        this.syncSlots();
        break;
      }
      case "sessionAdded":
        this.addSession(ch.sessionId, ch.instant);
        break;
      case "sessionRemoved":
        this.removeSession(ch.sessionId, ch.instant);
        break;
      case "activityChanged": {
        const c = this.chars.get(ch.sessionId);
        const s = this.model.sessions.get(ch.sessionId);
        if (!c || !s) return;
        this.showBubble(c, s.activity, s.project ?? "");
        if (s.activity === "waiting") {
          this.onMoment({ kind: "waiting", x: c.x, y: c.y - 16, name: this.nameOf(c.personId) });
        }
        if (
          s.activity !== "idle" &&
          (c.mode === "poi" || (c.mode === "walking" && c.goal === "poi"))
        ) {
          this.goToDesk(c);
        }
        break;
      }
      case "subagentsChanged": {
        const c = this.chars.get(ch.sessionId);
        c?.helpers.set(ch.count, true);
        break;
      }
      case "officeRenamed":
        break;
    }
  }

  /**
   * Bring the pod slots in line with the model: owned slots become pods with one desk per
   * session (2..6, never shrinking while the same person owns it), a slot still holding
   * characters of someone who left keeps its desks, the first free slot shows the
   * "free desk" placeholder and every other slot is a cozy nook.
   */
  syncSlots() {
    const owners = new Map<number, PersonState>();
    for (const p of this.model.people.values()) owners.set(p.pod, p);
    const lingering = new Set<number>();
    const deskNeed = new Map<number, number>();
    for (const c of this.chars.values()) {
      const owner = owners.get(c.pod);
      if (!owner || owner.personId !== c.personId) lingering.add(c.pod);
      else if (c.hasDesk) deskNeed.set(c.pod, Math.max(deskNeed.get(c.pod) ?? 0, c.desk + 1));
    }
    let freeShown = false;
    const changed: number[] = [];
    for (let pod = 0; pod < this.scene.slotCount; pod++) {
      const p = owners.get(pod);
      let did = false;
      if (p) {
        let need = deskNeed.get(pod) ?? 0;
        for (const s of this.model.sessionsOf(p.personId))
          if (s.desk < MAX_DESKS) need = Math.max(need, s.desk + 1);
        const hw = this.podDesks.get(pod);
        const n = clampDesks(Math.max(need, hw?.personId === p.personId ? hw.n : 0));
        this.podDesks.set(pod, { personId: p.personId, n });
        did = this.scene.setSlot(pod, {
          kind: "pod",
          desks: n,
          owner: {
            personId: p.personId,
            name: p.name,
            avatar: p.avatar,
            accent: C.leaf,
            mat: hashString(p.personId) % POD_MATS.length,
          },
        });
      } else if (lingering.has(pod)) {
        continue;
      } else {
        this.podDesks.delete(pod);
        did = this.scene.setSlot(pod, { kind: freeShown ? "nook" : "free" });
        freeShown = true;
      }
      if (did) changed.push(pod);
    }
    if (changed.length === 0) return;
    const pois = new Set([...this.scene.map.pois, ...this.scene.nookPois]);
    const map = this.scene.map;
    for (const c of this.chars.values()) {
      if (c.poi && (!pois.has(c.poi) || !map.isWalkable(c.poi.tile.x, c.poi.tile.y))) {
        // the nook they were lounging in became someone's pod
        this.releasePoi(c);
        if (c.mode === "poi" || c.mode === "walking") this.idleWander(c);
      }
      if (!changed.includes(c.pod)) continue;
      const seat = this.seatOf(c.pod, c.desk);
      c.helpers.setArea(podAisle(c.pod), seat);
      if (c.mode === "seated" && c.hasDesk) this.sit(c);
      else if (c.mode === "walking" && c.goal === "desk") this.goToDesk(c);
    }
  }

  private nameOf(personId: string) {
    return this.model.people.get(personId)?.name ?? personId;
  }

  private sheetFor(p: PersonState, s: SessionState): CharacterSheet {
    const variation = s.desk === 0 ? null : sessionVariation(s.sessionId);
    return characterSheet(lookFor(p.avatar, s.agent, variation));
  }

  private doorPoint(): Point {
    const d = this.scene.map.door;
    return { x: (d.x + 1) * TILE, y: (d.y + 1) * TILE };
  }

  private addSession(sessionId: string, instant: boolean) {
    const s = this.model.sessions.get(sessionId);
    const p = s && this.model.people.get(s.personId);
    if (!s || !p) return;
    if (this.chars.has(sessionId)) return;
    this.syncSlots();
    const seat = this.seatOf(p.pod, s.desk);
    const helpers = new HelperSwarm(
      this.scene.objects,
      this.scene.fx,
      this.effects,
      s.agent,
      podAisle(p.pod),
      seat,
      seededRandom(`helpers:${sessionId}`),
    );
    const c = new SessionCharacter(
      sessionId,
      p.personId,
      s.agent,
      p.pod,
      s.desk,
      this.sheetFor(p, s),
      helpers,
    );
    this.chars.set(sessionId, c);
    this.scene.objects.addChild(c.sprite);
    this.scene.fx.addChild(c.marker, c.bubble);
    if (instant) {
      if (c.hasDesk) {
        this.sit(c);
      } else {
        const sp = this.scene.map.spawn;
        c.x = sp.x * TILE + 16;
        c.y = (sp.y - 2) * TILE;
        this.idleWander(c);
      }
      helpers.set(s.subagents, false);
    } else {
      const sp = this.scene.map.spawn;
      c.x = sp.x * TILE + 16;
      c.y = sp.y * TILE + 14;
      c.mode = "queued";
      // stagger siblings walking in together
      const queued = [...this.chars.values()].filter((o) => o.mode === "queued").length;
      c.delay = (queued - 1) * 0.9;
      // someone new: walk in right as the door opens and the confetti pops
      const join = this.joins.find((j) => j.personId === p.personId);
      if (join) c.delay = Math.max(c.delay, join.t + 0.35);
      c.sprite.visible = false;
      helpers.set(s.subagents, false);
      const name = p.name;
      if (Date.now() - p.joinedAt > 5000) {
        this.onMoment({ kind: "started", x: c.x, y: c.y - 30, name });
      }
    }
    this.place(c);
  }

  private removeSession(sessionId: string, instant: boolean) {
    const c = this.chars.get(sessionId);
    if (!c) return;
    if (instant || c.mode === "queued") {
      this.destroy(c);
      return;
    }
    c.helpers.destroy(true);
    this.releasePoi(c);
    if (c.mode === "seated") {
      c.mode = "waving";
      c.timer = 1.6;
      c.facing = "down";
      this.setMonitorFor(c, "off");
    } else {
      this.walkTo(c, this.scene.map.spawn, "exit");
    }
  }

  private destroy(c: SessionCharacter) {
    c.removed = true;
    c.helpers.destroy(false);
    this.releasePoi(c);
    if (c.hasDesk && !this.otherAtDesk(c)) {
      this.setMonitorFor(c, "off");
      this.resetChair(c);
    }
    this.scene.objects.removeChild(c.sprite);
    this.scene.fx.removeChild(c.bubble, c.marker);
    c.sprite.destroy();
    c.bubble.destroy();
    c.marker.destroy();
    this.chars.delete(c.sessionId);
    this.syncSlots();
  }

  private otherAtDesk(c: SessionCharacter) {
    for (const o of this.chars.values()) {
      if (o !== c && o.pod === c.pod && o.desk === c.desk) return true;
    }
    return false;
  }

  // ---- helpers --------------------------------------------------------------------------
  private seatOf(pod: number, desk: number): Point {
    if (desk >= MAX_DESKS) {
      const a = podAisle(pod);
      return { x: a.x + a.w / 2, y: a.y + 10 };
    }
    return this.scene.desk(pod, desk)?.seat ?? { x: 0, y: 0 };
  }

  private setMonitorFor(c: SessionCharacter, state: MonitorState) {
    if (c.hasDesk) this.scene.setMonitor(c.pod, c.desk, state);
  }

  private resetChair(c: SessionCharacter) {
    const d = this.scene.desk(c.pod, c.desk);
    if (d) d.chair.zIndex = d.seat.y + 1;
  }

  private sit(c: SessionCharacter) {
    const seat = this.seatOf(c.pod, c.desk);
    c.x = seat.x;
    c.y = seat.y;
    c.mode = "seated";
    c.goal = null;
    c.path = [];
    c.timer = 2 + this.rand() * 5;
  }

  private walkTo(c: SessionCharacter, tile: Point, goal: Goal, finalSpot?: Point) {
    const map = this.scene.map;
    const from = { x: Math.floor(c.x / TILE), y: Math.floor((c.y - 4) / TILE) };
    const tiles = findPath(map, from, tile);
    c.path = tiles ? tiles.slice(1).map(tileCenter) : [tileCenter(tile)];
    if (finalSpot) c.path.push(finalSpot);
    c.goal = goal;
    c.mode = "walking";
  }

  private goToDesk(c: SessionCharacter) {
    this.releasePoi(c);
    if (!c.hasDesk) {
      this.idleWander(c);
      return;
    }
    this.walkTo(c, this.chairOf(c), "desk", this.seatOf(c.pod, c.desk));
  }

  private chairOf(c: SessionCharacter): Point {
    return chairTile(c.pod, c.desk, Math.max(this.scene.slotDesks(c.pod), c.desk + 1));
  }

  private releasePoi(c: SessionCharacter) {
    if (c.poi) this.poiTaken.delete(c.poi.id);
    c.poi = null;
  }

  private idleWander(c: SessionCharacter) {
    // mostly the coffee machine, lounge and garden (PLAN), sometimes a nook between pods
    const map = this.scene.map;
    // never a spot that furniture or a new pod now covers
    const free = (list: readonly Poi[]) =>
      list.filter((p) => !this.poiTaken.has(p.id) && map.isWalkable(p.tile.x, p.tile.y));
    const nooks = free(this.scene.nookPois);
    let pois = nooks.length > 0 && this.rand() < 0.25 ? nooks : free(this.scene.map.pois);
    if (pois.length === 0) pois = nooks;
    if (pois.length === 0) return;
    const favourites = pois.filter((p) => p.area !== "desks" && p.area !== "meeting");
    if (favourites.length > 0 && this.rand() < 0.7) pois = favourites;
    const poi = pois[Math.floor(this.rand() * pois.length)]!;
    this.releasePoi(c);
    this.poiTaken.set(poi.id, c.sessionId);
    c.poi = poi;
    this.walkTo(c, poi.tile, "poi", poi.spot);
  }

  private showBubble(c: SessionCharacter, activity: Activity, project: string) {
    // one bubble per pod: a new one quickly fades its neighbour's; and a global cap
    let shown = 0;
    let oldest: SessionCharacter | null = null;
    for (const o of this.chars.values()) {
      if (o === c || o.bubbleT <= 0) continue;
      if (o.pod === c.pod && o.hasDesk && c.hasDesk) o.bubbleT = Math.min(o.bubbleT, 0.25);
      else {
        shown++;
        if (!oldest || o.bubbleT < oldest.bubbleT) oldest = o;
      }
    }
    if (shown >= MAX_BUBBLES && oldest) oldest.bubbleT = Math.min(oldest.bubbleT, 0.25);
    c.bubble.texture = bubbleTexture(activity, project);
    c.bubble.visible = true;
    c.bubbleT = BUBBLE_SECONDS;
  }

  /** Bubble x: seated characters keep their bubble over their own pod. */
  private bubbleX(c: SessionCharacter): number {
    if (c.mode !== "seated" || !c.hasDesk) return c.x;
    const n = this.scene.slotDesks(c.pod);
    if (n === 0) return c.x;
    const span = podDeskSpan(c.pod, n);
    const half = c.bubble.width / 2;
    return Math.max(span.x + half - 4, Math.min(span.x + span.w - half + 4, c.x));
  }

  private place(c: SessionCharacter) {
    c.sprite.position.set(Math.round(c.x), Math.round(c.y));
    c.sprite.zIndex = c.y;
  }

  private activityOf(c: SessionCharacter): Activity {
    return this.model.sessions.get(c.sessionId)?.activity ?? "idle";
  }

  // ---- per frame ------------------------------------------------------------------------
  update(dt: number, time: number) {
    let doorBusy = false;
    const door = this.doorPoint();
    for (const j of this.joins) {
      j.t -= dt;
      if (!j.done && j.t <= 0) {
        j.done = true;
        const p = this.model.people.get(j.personId);
        this.effects.confetti(door.x - 14, door.y - 6, 40, this.rand, 0.35);
        this.effects.confetti(door.x + 14, door.y - 6, 40, this.rand, -0.35);
        if (p)
          this.onMoment({
            kind: "arrived",
            x: door.x,
            y: door.y - 44,
            name: p.name,
            personId: p.personId,
          });
      }
      if (j.t > -3.2 && j.t < 0.4) doorBusy = true;
    }
    this.joins = this.joins.filter((j) => j.t > -3.2);
    for (const c of [...this.chars.values()]) {
      this.step(c, dt, time);
      if (c.removed) continue;
      if (Math.abs(c.x - door.x) < 26 && Math.abs(c.y - door.y) < 30) doorBusy = true;
      c.helpers.update(dt, time);
    }
    this.scene.doorWanted = doorBusy;
    this.updateSelection(time);
  }

  /** Session whose agent card is open: gets a bouncing arrow over its head. */
  selected: string | null = null;
  private selArrow: Sprite | null = null;

  private updateSelection(time: number) {
    const c = this.selected ? this.chars.get(this.selected) : undefined;
    if (!c?.sprite.visible) {
      if (this.selArrow) this.selArrow.visible = false;
      return;
    }
    if (!this.selArrow) {
      this.selArrow = new Sprite(selectArrowTextures()[0]!);
      this.selArrow.anchor.set(0.5, 1);
      this.scene.fx.addChild(this.selArrow);
    }
    const a = this.selArrow;
    a.texture = selectArrowTextures()[Math.floor(time * 3) % 2]!;
    const headY = c.y - (c.mode === "seated" || c.anim === "sitFront" ? 21 : 24);
    a.position.set(Math.round(c.x), Math.round(headY - 5 + Math.round(Math.sin(time * 5) * 1.5)));
    a.visible = true;
  }

  private setAnim(c: SessionCharacter, name: AnimName, fps: number, time: number) {
    c.anim = name;
    const frames = c.sheet.anims[name];
    const f = frames[Math.floor((time + c.sprite.x * 0.013) * fps) % frames.length]!;
    if (c.sprite.texture !== f) c.sprite.texture = f as Texture;
  }

  private step(c: SessionCharacter, dt: number, time: number) {
    const activity = this.activityOf(c);
    c.marker.visible = false;
    switch (c.mode) {
      case "queued": {
        c.delay -= dt;
        if (c.delay <= 0) {
          c.sprite.visible = true;
          if (c.hasDesk) this.goToDesk(c);
          else this.idleWander(c);
        }
        break;
      }
      case "walking": {
        this.walkStep(c, dt);
        const walkAnim =
          c.facing === "left"
            ? "walkLeft"
            : c.facing === "right"
              ? "walkRight"
              : c.facing === "up"
                ? "walkUp"
                : "walkDown";
        this.setAnim(c, walkAnim, 8, time);
        if (c.path.length === 0) this.arrive(c);
        break;
      }
      case "seated": {
        this.seatedStep(c, activity, dt, time);
        break;
      }
      case "poi": {
        const poi = c.poi;
        const pose = poi?.pose ?? "stand";
        if (pose === "sit") this.setAnim(c, "sitFront", 1, time);
        else if (pose === "sitBack") this.setAnim(c, "sitIdle", 0.8, time);
        else if (pose === "play" && c.facing === "up") this.setAnim(c, "play", 5, time);
        else this.setAnim(c, standAnim(c.facing), 1.2, time);
        this.setMonitorFor(c, "idle");
        c.timer -= dt;
        if (activity !== "idle") this.goToDesk(c);
        else if (c.timer <= 0) {
          if (this.rand() < 0.6) this.idleWander(c);
          else c.timer = 8 + this.rand() * 10;
        }
        break;
      }
      case "waving": {
        this.setAnim(c, "wave", 4, time);
        c.timer -= dt;
        if (c.timer <= 0) {
          this.resetChair(c);
          this.walkTo(c, this.scene.map.spawn, "exit");
        }
        break;
      }
      case "leaving":
        break;
    }
    // bubbles + markers
    if (c.bubbleT > 0) {
      c.bubbleT -= dt;
      c.bubble.alpha = Math.min(1, c.bubbleT / 0.5);
      c.bubble.visible = c.bubbleT > 0;
    }
    const headY = c.y - (c.mode === "seated" || c.anim === "sitFront" ? 21 : 24);
    if (c.bubble.visible) {
      // stagger heights between neighbouring pods (and desks) so bubbles don't stack up
      const lift = c.mode === "seated" ? (c.pod % 2) * 6 + (c.desk % 2) * 2 : 0;
      c.bubble.position.set(Math.round(this.bubbleX(c)), Math.round(headY - 1 - lift));
    }
    if (c.mode === "seated" && c.bubbleT <= 0) {
      if (activity === "waiting") {
        const frames = alertTextures();
        c.marker.texture = frames[Math.floor(time * 3) % 2]!;
        c.marker.visible = true;
        // on the left of the head: the raised hand (right side) stays visible
        c.marker.position.set(
          Math.round(c.x - 7),
          Math.round(headY - 2 + Math.round(Math.sin(time * 6))),
        );
      } else if (activity === "thinking") {
        const frames = dotsTextures();
        c.marker.texture = frames[Math.floor(time * 2.5) % 3]!;
        c.marker.visible = true;
        c.marker.position.set(Math.round(c.x + 8), Math.round(headY + 1));
      }
    }
    if (!c.removed) this.place(c);
  }

  private seatedStep(c: SessionCharacter, activity: Activity, dt: number, time: number) {
    const d = c.hasDesk ? this.scene.desk(c.pod, c.desk) : undefined;
    if (d) d.chair.zIndex = activity === "waiting" ? c.y - 1 : c.y + 1;
    switch (activity) {
      case "typing":
        this.setAnim(c, "sitType", 7, time);
        this.setMonitorFor(c, "code");
        break;
      case "reading": {
        const flip = (time + c.desk * 0.7) % 2.4 < 0.35;
        c.sprite.texture = c.sheet.anims.sitRead[flip ? 1 : 0]!;
        c.anim = "sitRead";
        this.setMonitorFor(c, "read");
        break;
      }
      case "running":
        this.setAnim(c, "sitIdle", 0.7, time);
        this.setMonitorFor(c, "run");
        break;
      case "thinking":
        this.setAnim(c, "sitIdle", 1.6, time);
        this.setMonitorFor(c, "code");
        break;
      case "waiting":
        this.setAnim(c, "raiseHand", 3, time);
        this.setMonitorFor(c, "wait");
        break;
      case "idle":
        this.setAnim(c, "sitIdle", 0.5, time);
        this.setMonitorFor(c, "idle");
        c.timer -= dt;
        if (c.timer <= 0) this.idleWander(c);
        return;
    }
    c.timer = 2 + this.rand() * 4;
  }

  private walkStep(c: SessionCharacter, dt: number) {
    let budget = WALK_SPEED * dt;
    while (budget > 0 && c.path.length > 0) {
      const wp = c.path[0]!;
      const dx = wp.x - c.x;
      const dy = wp.y - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.01) {
        c.facing =
          Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
      }
      if (dist <= budget) {
        c.x = wp.x;
        c.y = wp.y;
        budget -= dist;
        c.path.shift();
      } else {
        c.x += (dx / dist) * budget;
        c.y += (dy / dist) * budget;
        budget = 0;
      }
    }
  }

  private arrive(c: SessionCharacter) {
    if (c.goal === "desk") {
      this.sit(c);
      const s = this.model.sessions.get(c.sessionId);
      if (s && s.activity !== "idle") this.showBubble(c, s.activity, s.project ?? "");
    } else if (c.goal === "poi") {
      c.mode = "poi";
      c.facing = c.poi?.face ?? "down";
      c.timer = 10 + this.rand() * 15;
    } else if (c.goal === "exit") {
      c.mode = "leaving";
      this.destroy(c);
    }
  }

  // ---- queries --------------------------------------------------------------------------
  /** Character under a world point (topmost first). */
  pick(wx: number, wy: number): SessionCharacter | null {
    let best: SessionCharacter | null = null;
    for (const c of this.chars.values()) {
      if (!c.sprite.visible) continue;
      if (wx >= c.x - 8 && wx <= c.x + 8 && wy >= c.y - CHAR_H + 2 && wy <= c.y + 2) {
        if (!best || c.y > best.y) best = c;
      }
    }
    return best;
  }

  /** Characters that are idle somewhere (for the cat). */
  idleSpots(): Point[] {
    const out: Point[] = [];
    for (const c of this.chars.values()) {
      if (c.mode === "poi" || (c.mode === "seated" && this.activityOf(c) === "idle"))
        out.push({ x: c.x, y: c.y });
    }
    return out;
  }
}

function standAnim(f: Facing): AnimName {
  return f === "up"
    ? "idleUp"
    : f === "left"
      ? "idleLeft"
      : f === "right"
        ? "idleRight"
        : "idleDown";
}
