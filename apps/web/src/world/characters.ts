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
import { alertTextures, bubbleTexture, dotsTextures } from "../art/fx.ts";
import { C } from "../art/palette.ts";
import type { ModelChange, OfficeModel, PersonState, SessionState } from "../state/officeModel.ts";
import type { Effects } from "./effects.ts";
import { HelperSwarm } from "./helpers.ts";
import {
  chairTile,
  DESKS_PER_POD,
  type Facing,
  type Point,
  type Poi,
  podAisle,
  TILE,
} from "./map.ts";
import type { OfficeScene } from "./office.ts";
import { findPath } from "./pathing.ts";

const WALK_SPEED = 44;
const BUBBLE_SECONDS = 3.5;

export type Moment = { kind: "joined" | "started" | "waiting" | "left"; x: number; y: number; name: string };

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
    return this.desk < DESKS_PER_POD;
  }
}

export class CharacterManager {
  readonly chars = new Map<string, SessionCharacter>();
  private poiTaken = new Map<string, string>();
  private rand = seededRandom("characters");
  private pendingPodClear = new Map<number, number>();
  onMoment: (m: Moment) => void = () => {};

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
        this.pendingPodClear.delete(p.pod);
        this.scene.setPodOwner(p.pod, {
          personId: p.personId,
          name: p.name,
          avatar: p.avatar,
          accent: C.leaf,
        });
        if (!ch.instant) {
          const door = this.doorPoint();
          this.effects.confetti(door.x, door.y - 8, 46, this.rand);
          this.onMoment({ kind: "joined", x: door.x, y: door.y - 40, name: p.name });
        }
        break;
      }
      case "personRemoved": {
        const pod = [...this.chars.values()].find((c) => c.personId === ch.personId)?.pod;
        // pod already reassigned in the model; clear when its owner's characters are gone
        const podIdx = pod ?? this.findPodOf(ch.personId);
        if (podIdx !== undefined) this.pendingPodClear.set(podIdx, ch.instant ? 0 : 7);
        break;
      }
      case "avatarChanged": {
        const p = this.model.people.get(ch.personId);
        if (!p) return;
        for (const c of this.chars.values()) {
          if (c.personId !== p.personId) continue;
          const s = this.model.sessions.get(c.sessionId);
          if (s) c.sheet = this.sheetFor(p, s);
        }
        this.scene.setPodOwner(p.pod, { personId: p.personId, name: p.name, avatar: p.avatar, accent: C.leaf });
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
        if (s.activity !== "idle" && (c.mode === "poi" || (c.mode === "walking" && c.goal === "poi"))) {
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

  private findPodOf(personId: string): number | undefined {
    for (const c of this.chars.values()) if (c.personId === personId) return c.pod;
    return undefined;
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
    const c = new SessionCharacter(sessionId, p.personId, s.agent, p.pod, s.desk, this.sheetFor(p, s), helpers);
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
  }

  private otherAtDesk(c: SessionCharacter) {
    for (const o of this.chars.values()) {
      if (o !== c && o.pod === c.pod && o.desk === c.desk) return true;
    }
    return false;
  }

  // ---- helpers --------------------------------------------------------------------------
  private seatOf(pod: number, desk: number): Point {
    if (desk >= DESKS_PER_POD) {
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
    this.walkTo(c, chairTile(c.pod, c.desk), "desk", this.seatOf(c.pod, c.desk));
  }

  private releasePoi(c: SessionCharacter) {
    if (c.poi) this.poiTaken.delete(c.poi.id);
    c.poi = null;
  }

  private idleWander(c: SessionCharacter) {
    const pois = this.scene.map.pois.filter((p) => !this.poiTaken.has(p.id));
    if (pois.length === 0) return;
    const poi = pois[Math.floor(this.rand() * pois.length)]!;
    this.releasePoi(c);
    this.poiTaken.set(poi.id, c.sessionId);
    c.poi = poi;
    this.walkTo(c, poi.tile, "poi", poi.spot);
  }

  private showBubble(c: SessionCharacter, activity: Activity, project: string) {
    c.bubble.texture = bubbleTexture(activity, project);
    c.bubble.visible = true;
    c.bubbleT = BUBBLE_SECONDS;
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
    for (const [pod, t] of this.pendingPodClear) {
      const left = t - dt;
      const owner = [...this.model.people.values()].find((p) => p.pod === pod);
      const busy = [...this.chars.values()].some((c) => c.pod === pod && (!owner || c.personId !== owner.personId));
      if (owner && !busy) {
        this.pendingPodClear.delete(pod);
        continue;
      }
      if (left <= 0 && !busy) {
        this.pendingPodClear.delete(pod);
        if (!owner) this.scene.setPodOwner(pod, null);
      } else this.pendingPodClear.set(pod, left);
    }
    let doorBusy = false;
    const door = this.doorPoint();
    for (const c of [...this.chars.values()]) {
      this.step(c, dt, time);
      if (c.removed) continue;
      if (Math.abs(c.x - door.x) < 26 && Math.abs(c.y - door.y) < 30) doorBusy = true;
      c.helpers.update(dt, time);
    }
    this.scene.doorWanted = doorBusy;
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
          if (c.hasDesk) this.walkTo(c, chairTile(c.pod, c.desk), "desk", this.seatOf(c.pod, c.desk));
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
    c.bubble.position.set(Math.round(c.x), Math.round(headY - 1));
    if (c.mode === "seated" && c.bubbleT <= 0) {
      if (activity === "waiting") {
        const frames = alertTextures();
        c.marker.texture = frames[Math.floor(time * 3) % 2]!;
        c.marker.visible = true;
        c.marker.position.set(Math.round(c.x + 5), Math.round(headY - 3 + Math.round(Math.sin(time * 6))));
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
        c.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
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
      if (c.mode === "poi" || (c.mode === "seated" && this.activityOf(c) === "idle")) out.push({ x: c.x, y: c.y });
    }
    return out;
  }
}

function standAnim(f: Facing): AnimName {
  return f === "up" ? "idleUp" : f === "left" ? "idleLeft" : f === "right" ? "idleRight" : "idleDown";
}
