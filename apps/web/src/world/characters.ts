/**
 * Session characters and their behavior state machine:
 *   walk in from the door -> sit at desk -> animate by activity
 *   idle -> wander to a point of interest (coffee, sofa, garden...) -> come back when busy
 *   waiting -> turn to camera, raise hand, "!" bubble (at the desk)
 *   ended -> wave, walk out the door, fade
 *
 * Office life around that (never instead of it): idle people fetch coffee and chat in
 * pairs with tiny icon bubbles, play the arcade / ping-pong, gather for pizza; long waits
 * ping; a `/clear` (end + restart within 10 s) zaps the old character into a smoking pile
 * with a tombstone and a ghost; long sessions end with fireworks; new personal records of
 * parallel agents get a banner.
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
import {
  boltTextures,
  CHAT_ICONS,
  chatIconTextures,
  ghostTextures,
  mugTextures,
  pileTextures,
  ringTextures,
  textBubbleTexture,
  toastTexture,
  tombstoneTexture,
} from "../art/fun.ts";
import {
  alertTextures,
  bubbleTexture,
  dotsTextures,
  glowTexture,
  selectArrowTextures,
  zzzTextures,
} from "../art/fx.ts";
import { C } from "../art/palette.ts";
import { POD_MATS } from "../art/tiles.ts";
import type { ModelChange, OfficeModel, PersonState, SessionState } from "../state/officeModel.ts";
import type { WaitSpot } from "./cat.ts";
import type { Effects } from "./effects.ts";
import { HelperSwarm, type HelperWorld } from "./helpers.ts";
import {
  type EndedSession,
  findClearedSession,
  ripLabel,
  SHIP_IT_AFTER_MS,
  sessionAgeMs,
  WAIT_CAT_MS,
  WAIT_CHEF_MS,
  WAIT_PING_MS,
} from "./lifeRules.ts";
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
import { findPath, findPathPx } from "./pathing.ts";

const WALK_SPEED = 44;
const BUBBLE_SECONDS = 2.6;
/** at most this many speech bubbles at once (one per pod) so busy floors stay readable */
const MAX_BUBBLES = 6;

export type Moment = {
  /** joined = someone is about to come in (camera heads to the door); arrived = door opens */
  kind: "joined" | "arrived" | "started" | "waiting" | "left" | "record" | "ended" | "cleared";
  x: number;
  y: number;
  name: string;
  personId?: string;
  /** record: sessions at once */
  count?: number;
};

/** Seconds between `person.joined` and the door/confetti, so an auto camera can get there. */
const JOIN_LEAD = 1.8;

type Mode = "queued" | "walking" | "seated" | "poi" | "waving" | "leaving" | "zapped";
type Goal = "desk" | "poi" | "exit" | "chat";
type Chat = { partner: SessionCharacter; t: number; next: number };
type Remains = {
  pile: Sprite;
  tomb: Sprite;
  ghost: Sprite;
  bolt: Sprite;
  flash: Sprite;
  gx: number;
  gy: number;
  /** -1 left of the pod, 1 right of it, 0 in front of the chair */
  side: number;
  t: number;
};
/** where helper bots run their errands (tiles in front of printer, server rack, bookshelf) */
const ERRANDS: readonly Point[] = [
  { x: 31, y: 9 },
  { x: 31, y: 15 },
  { x: 43, y: 4 },
];

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
  /** a coffee mug in hand (seconds left) */
  mug: Sprite;
  mugT = 0;
  /** chat icon bubble */
  icon: Sprite;
  iconT = 0;
  /** "ping" ring for long waits */
  ring: Sprite;
  chat: Chat | null = null;
  chatCooldown = 8;
  chatCheck = 0;
  /** walking over to chat with them */
  chatTarget: SessionCharacter | null = null;
  zapT = 0;
  startedAt = 0;
  project: string | undefined;
  machine: string | undefined;

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
    this.mug = new Sprite(mugTextures()[0]!);
    this.mug.anchor.set(0.5, 1);
    this.mug.visible = false;
    this.mug.label = "actor";
    this.icon = new Sprite();
    this.icon.anchor.set(0.5, 1);
    this.icon.visible = false;
    this.ring = new Sprite(ringTextures()[0]!);
    this.ring.anchor.set(0.5);
    this.ring.visible = false;
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
  /** multiplies waiting time for the fun thresholds (demo=party runs them 10x faster) */
  timeScale = 1;
  /** how likely idle people strike up a chat (party demo: chattier) */
  chatChance = 0.35;
  /** multiplies how long idle people stay at a spot (party demo: they move around more) */
  dwell = 1;
  /** a pizza is on the meeting table: idle people gather there */
  pizzaActive: () => boolean = () => false;
  /** the office cat may eat a finished helper (wired up in main.ts) */
  catEats: (sprite: Sprite, x: number, y: number) => boolean = () => false;
  /** ended sessions of the last seconds, to spot `/clear` restarts */
  private recentEnds: (EndedSession & { char: SessionCharacter | null; cleared: boolean })[] = [];
  /** most sessions at once per person (personal record) */
  private records = new Map<string, number>();
  private remains: Remains[] = [];
  private readonly helperWorld: HelperWorld = {
    errand: (from, rand) => {
      const map = this.scene.map;
      const dest = ERRANDS[Math.floor(rand() * ERRANDS.length)]!;
      if (!map.isWalkable(dest.x, dest.y)) return null;
      const path = findPathPx(map, from, tileCenter(dest));
      return path && path.length < 70 ? path : null;
    },
    pathTo: (from, to) => findPathPx(this.scene.map, from, to),
    catEats: (sprite, x, y) => this.catEats(sprite, x, y),
  };

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
        this.afterSessionAdded(ch.personId, ch.sessionId, ch.instant);
        break;
      case "sessionRemoved":
        if (!ch.instant) this.sessionEnded(ch.sessionId);
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
      case "connectionChanged": {
        const c = this.chars.get(ch.sessionId);
        if (!c) return;
        if (!ch.offline) {
          this.effects.sparkle(c.x, c.y - 14);
          break;
        }
        c.bubbleT = Math.min(c.bubbleT, 0.25);
        if (c.chat) this.endChat(c);
        if (c.mode === "poi" || (c.mode === "walking" && c.goal !== "exit")) this.goToDesk(c);
        break;
      }
      case "officeRenamed":
      case "interaction":
        break;
    }
  }

  /** Visible characters of a person, for interaction effects. */
  charactersOf(personId: string): SessionCharacter[] {
    return [...this.chars.values()].filter(
      (c) => c.personId === personId && !c.removed && c.sprite.visible,
    );
  }

  /** A short text bubble that floats up over a character (pokes from viewers). */
  say(c: SessionCharacter, text: string) {
    const head = c.y - (c.mode === "seated" ? 21 : 24);
    this.effects.floater(textBubbleTexture(text), c.x, head - 2, 3.2, 10);
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

  /** `/clear` detection and personal records of parallel agents. */
  private afterSessionAdded(personId: string, sessionId: string, instant: boolean) {
    const n = this.model.sessionsOf(personId).length;
    const best = this.records.get(personId) ?? 0;
    if (instant) {
      this.records.set(personId, Math.max(best, n));
      return;
    }
    const s = this.model.sessions.get(sessionId);
    const now = Date.now();
    this.recentEnds = this.recentEnds.filter((e) => now - e.at < 15_000);
    const ended = findClearedSession(this.recentEnds, {
      personId,
      machine: s?.machine,
      at: now,
    });
    if (ended) {
      ended.cleared = true;
      this.recentEnds.splice(this.recentEnds.indexOf(ended), 1);
      const old = ended.char;
      if (old && !old.removed && old.mode !== "zapped") this.zap(old, ended);
      // the successor waits for the smoke to clear before walking in
      const c = this.chars.get(sessionId);
      if (c && c.mode === "queued") c.delay = Math.max(c.delay, 1.4);
    }
    if (n > best) {
      this.records.set(personId, n);
      if (best > 0 && n >= 3) {
        const c = this.chars.get(sessionId);
        this.onMoment({
          kind: "record",
          x: c?.x ?? 0,
          y: c?.y ?? 0,
          name: this.nameOf(personId),
          personId,
          count: n,
        });
      }
    }
  }

  /** A session ended for real (not a snapshot reconcile): graveyard, maybe fireworks. */
  private sessionEnded(sessionId: string) {
    const c = this.chars.get(sessionId);
    if (!c) return;
    const now = Date.now();
    const entry = {
      personId: c.personId,
      machine: c.machine,
      project: c.project,
      at: now,
      char: c,
      cleared: false,
    };
    this.recentEnds.push(entry);
    this.onMoment({ kind: "ended", x: c.x, y: c.y, name: this.nameOf(c.personId) });
    const age = sessionAgeMs(c.startedAt, this.model.clockSkew, now);
    if (age > SHIP_IT_AFTER_MS) {
      const at = c.hasDesk ? this.seatOf(c.pod, c.desk) : { x: c.x, y: c.y };
      // a beat later, unless it turns out to be a /clear (then it gets zapped instead)
      this.effects.after(2.2, () => {
        if (entry.cleared) return;
        this.effects.fireworks(at.x, at.y - 40, this.rand);
        this.effects.floater(toastTexture("SHIP IT!"), at.x, at.y - 34, 3.4, 12);
      });
    }
  }

  /** Lightning out of the monitor, a smoking pile, a tombstone and a ghost. */
  private zap(c: SessionCharacter, ended: EndedSession) {
    c.mode = "zapped";
    c.zapT = 0;
    c.path = [];
    this.endChat(c);
    this.releasePoi(c);
    c.helpers.destroy(true);
    c.sprite.visible = true;
    c.marker.visible = false;
    c.bubbleT = 0;
    c.bubble.visible = false;
    const age = sessionAgeMs(c.startedAt, this.model.clockSkew, ended.at);
    const objects = this.scene.objects;
    const pile = new Sprite(pileTextures()[0]!);
    pile.anchor.set(0.5, 1);
    pile.label = "actor";
    pile.visible = false;
    const tomb = new Sprite(tombstoneTexture(ripLabel(ended.project, age)));
    tomb.anchor.set(0.5, 1);
    tomb.label = "actor";
    tomb.visible = false;
    const ghost = new Sprite(ghostTextures()[0]!);
    ghost.anchor.set(0.5, 1);
    ghost.visible = false;
    const bolt = new Sprite(boltTextures()[0]!);
    bolt.anchor.set(0.5, 1);
    bolt.position.set(Math.round(c.x), Math.round(c.y - 8));
    const flash = new Sprite(glowTexture(26, C.white));
    flash.anchor.set(0.5);
    flash.position.set(Math.round(c.x), Math.round(c.y - 22));
    objects.addChild(pile, tomb);
    this.scene.fx.addChild(bolt, ghost);
    this.scene.glows.addChild(flash);
    const n = this.scene.slotDesks(c.pod);
    const seat = c.hasDesk ? this.seatOf(c.pod, c.desk) : null;
    const atDesk = !!seat && Math.hypot(seat.x - c.x, seat.y - c.y) < 4;
    const where = !atDesk || n === 0 ? 0 : c.desk === 0 ? -1 : c.desk === n - 1 ? 1 : 0;
    this.remains.push({ pile, tomb, ghost, bolt, flash, gx: c.x, gy: c.y, side: where, t: 0 });
    this.onMoment({ kind: "cleared", x: c.x, y: c.y - 16, name: this.nameOf(c.personId) });
  }

  private updateRemains(dt: number, time: number) {
    for (let i = this.remains.length - 1; i >= 0; i--) {
      const r = this.remains[i]!;
      r.t += dt;
      const t = r.t;
      // 0 .. 0.9 s: zap
      r.bolt.visible = t < 0.9 && Math.floor(t * 14) % 5 !== 4;
      r.bolt.scale.set(Math.floor(t * 14) % 2 ? -1.4 : 1.4, 1.4);
      r.bolt.texture = boltTextures()[Math.floor(t * 14) % 3]!;
      r.flash.visible = t < 0.9 && Math.floor(t * 10) % 2 === 0;
      if (t >= 0.9 && !r.pile.visible && r.t - dt < 0.9 + dt) {
        r.pile.visible = true;
        r.tomb.visible = true;
        r.ghost.visible = true;
        r.pile.position.set(Math.round(r.gx), Math.round(r.gy + 2));
        r.pile.zIndex = r.gy + 1.5;
        // the tombstone stands beside the pod (outer desks) or in front of the chair
        r.tomb.position.set(Math.round(r.gx + r.side * 30), Math.round(r.gy + (r.side ? 8 : 16)));
        r.tomb.zIndex = r.gy + 16;
        this.effects.puff(r.gx, r.gy - 6);
        this.effects.burst(r.gx, r.gy - 10, [C.night, C.slate, C.orange, C.amber], {
          count: 12,
          speed: 45,
          life: 1.6,
          floor: r.gy + 2,
        });
      }
      if (r.pile.visible) {
        r.pile.texture = pileTextures()[Math.floor(time * 3) % 3]!;
        r.pile.alpha = Math.min(1, Math.max(0, (14 - t) / 2));
        r.tomb.alpha = Math.min(1, Math.max(0, (21 - t) / 2));
      }
      if (r.ghost.visible) {
        const k = (t - 0.9) / 3.6;
        r.ghost.texture = ghostTextures()[Math.floor(time * 4) % 2]!;
        r.ghost.position.set(Math.round(r.gx + Math.sin(t * 3) * 5), Math.round(r.gy - 8 - k * 90));
        r.ghost.alpha = k < 0.15 ? k / 0.15 : Math.max(0, (1 - k) / 0.5);
        if (k >= 1) r.ghost.visible = false;
      }
      if (t > 21.5) {
        for (const sp of [r.pile, r.tomb]) {
          this.scene.objects.removeChild(sp);
          sp.destroy();
        }
        this.scene.fx.removeChild(r.ghost, r.bolt);
        this.scene.glows.removeChild(r.flash);
        r.ghost.destroy();
        r.bolt.destroy();
        r.flash.destroy();
        this.remains.splice(i, 1);
      }
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
      this.helperWorld,
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
    c.startedAt = s.startedAt;
    c.project = s.project;
    c.machine = s.machine;
    this.chars.set(sessionId, c);
    this.scene.objects.addChild(c.sprite, c.mug);
    this.scene.fx.addChild(c.ring, c.marker, c.icon, c.bubble);
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
    this.endChat(c);
    if (c.mode === "zapped") return;
    if (c.mode === "seated") {
      c.mode = "waving";
      // a little longer at the desk: a quick restart (/clear) still finds them here
      c.timer = 2.4;
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
    this.endChat(c);
    if (c.hasDesk && !this.otherAtDesk(c)) {
      this.setMonitorFor(c, "off");
      this.resetChair(c);
    }
    this.scene.objects.removeChild(c.sprite, c.mug);
    this.scene.fx.removeChild(c.bubble, c.marker, c.icon, c.ring);
    for (const sp of [c.sprite, c.bubble, c.marker, c.mug, c.icon, c.ring]) sp.destroy();
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
    this.endChat(c);
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
    const take = (poi: Poi) => {
      this.releasePoi(c);
      this.poiTaken.set(poi.id, c.sessionId);
      c.poi = poi;
      this.walkTo(c, poi.tile, "poi", poi.spot);
    };
    const all = free(this.scene.map.pois);
    // pizza on the table: everybody idle gathers in the meeting room
    if (this.pizzaActive() && this.rand() < 0.85) {
      const meet = all.filter((p) => p.area === "meeting" && p.id !== "whiteboard");
      if (meet.length) return take(meet[Math.floor(this.rand() * meet.length)]!);
    }
    // someone waits at the ping-pong table: grab the other paddle
    for (const [a, b] of [
      ["pong-l", "pong-r"],
      ["pong-r", "pong-l"],
    ] as const) {
      const other = this.poiTaken.get(a);
      const spot = all.find((p) => p.id === b);
      if (other && other !== c.sessionId && spot && this.rand() < 0.6) return take(spot);
    }
    // a coffee run
    if (c.mugT <= 0 && this.rand() < 0.3) {
      const coffee = all.find((p) => p.id === "coffee");
      if (coffee) return take(coffee);
    }
    // go and chat with someone who hangs around
    if (c.chatCooldown <= 0 && this.rand() < this.chatChance && this.walkOverToChat(c)) return;
    const nooks = free(this.scene.nookPois);
    let pois = nooks.length > 0 && this.rand() < 0.25 ? nooks : free(this.scene.map.pois);
    if (pois.length === 0) pois = nooks;
    if (pois.length === 0) return;
    const favourites = pois.filter((p) => p.area !== "desks" && p.area !== "meeting");
    if (favourites.length > 0 && this.rand() < 0.7) pois = favourites;
    take(pois[Math.floor(this.rand() * pois.length)]!);
  }

  // ---- chats ----------------------------------------------------------------------------
  private chatty(o: SessionCharacter) {
    return (
      !o.removed &&
      o.mode === "poi" &&
      !o.chat &&
      o.chatCooldown <= 0 &&
      this.activityOf(o) === "idle"
    );
  }

  private walkOverToChat(c: SessionCharacter): boolean {
    const map = this.scene.map;
    const visited = new Set([...this.chars.values()].map((o) => o.chatTarget));
    const cands = [...this.chars.values()].filter(
      (o) => o !== c && this.chatty(o) && !visited.has(o),
    );
    if (cands.length === 0) return false;
    const o = cands[Math.floor(this.rand() * cands.length)]!;
    const t = { x: Math.floor(o.x / TILE), y: Math.floor((o.y - 4) / TILE) };
    const taken = new Set(
      [...this.poiTaken.keys()].map((id) => {
        const p = [...map.pois, ...this.scene.nookPois].find((q) => q.id === id);
        return p ? `${p.tile.x},${p.tile.y}` : "";
      }),
    );
    for (const d of [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ]) {
      const n = { x: t.x + d.x, y: t.y + d.y };
      if (!map.isWalkable(n.x, n.y) || taken.has(`${n.x},${n.y}`)) continue;
      this.releasePoi(c);
      c.chatTarget = o;
      this.walkTo(c, n, "chat");
      return true;
    }
    return false;
  }

  private startChat(a: SessionCharacter, b: SessionCharacter) {
    const dur = 5 + this.rand() * 3;
    a.chat = { partner: b, t: dur, next: 0.2 };
    b.chat = { partner: a, t: dur, next: 0.9 };
    a.chatTarget = null;
    const face = (from: SessionCharacter, to: SessionCharacter) => {
      const pose = from.poi?.pose ?? "stand";
      if (pose === "sit" || pose === "sitBack") return;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      from.facing =
        Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
    };
    face(a, b);
    face(b, a);
  }

  private endChat(c: SessionCharacter) {
    c.chatTarget = null;
    const chat = c.chat;
    if (!chat) return;
    c.chat = null;
    c.chatCooldown = 18 + this.rand() * 12;
    c.timer = Math.min(c.timer, 0.6 + this.rand());
    if (chat.partner.chat?.partner === c) this.endChat(chat.partner);
  }

  private chatStep(c: SessionCharacter, dt: number) {
    const chat = c.chat!;
    chat.t -= dt;
    chat.next -= dt;
    const p = chat.partner;
    if (chat.t <= 0 || p.removed || p.chat?.partner !== c || this.activityOf(p) !== "idle") {
      this.endChat(c);
      return;
    }
    if (chat.next <= 0) {
      chat.next = 1.4;
      // coffee people talk coffee; pizza time is pizza time
      let name = CHAT_ICONS[Math.floor(this.rand() * (CHAT_ICONS.length - 1))]!;
      if (this.pizzaActive() && this.rand() < 0.5) name = "pizza";
      else if (c.mugT > 0 && this.rand() < 0.3) name = "coffee";
      c.icon.texture = chatIconTextures()[CHAT_ICONS.indexOf(name)]!;
      c.icon.visible = true;
      c.iconT = 1.1;
    }
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
    const showMug = c.mugT > 0 && c.facing !== "up" && (c.mode === "walking" || c.mode === "poi");
    c.mug.visible = showMug;
    if (showMug) {
      const side = c.facing === "left" ? -6 : c.facing === "right" ? 6 : 6;
      const lift = c.anim === "sitFront" ? 4 : 0;
      c.mug.position.set(Math.round(c.x + side), Math.round(c.y - 6 - lift));
      c.mug.zIndex = c.y + 0.5;
      c.mug.texture = mugTextures()[Math.floor(this.clock * 2.5) % 2]!;
    }
  }
  private clock = 0;

  private waitedMs(c: SessionCharacter): number {
    const s = this.model.sessions.get(c.sessionId);
    if (s?.activity !== "waiting") return 0;
    return (Date.now() - s.activitySince) * this.timeScale;
  }

  /** Seated people waiting at least `minMs` (scaled), longest first. */
  waitingFor(minMs: number): WaitSpot[] {
    const out: (WaitSpot & { w: number })[] = [];
    for (const c of this.chars.values()) {
      if (c.mode !== "seated") continue;
      const w = this.waitedMs(c);
      if (w >= minMs) out.push({ x: c.x, y: c.y, id: c.sessionId, w });
    }
    return out.sort((a, b) => b.w - a.w);
  }

  catWaitSpots(): WaitSpot[] {
    return this.waitingFor(WAIT_CAT_MS);
  }

  chefWaitSpots(): WaitSpot[] {
    return this.waitingFor(WAIT_CHEF_MS);
  }

  /** Idle people at a spot: drop everything when the pizza lands. */
  pizzaArrived() {
    for (const c of this.chars.values()) {
      if (this.activityOf(c) !== "idle" || c.chat) continue;
      if (c.mode === "poi" || c.mode === "seated") c.timer = Math.min(c.timer, this.rand() * 2.5);
    }
  }

  /** Both ping-pong paddles are in hands. */
  pongMatch(): boolean {
    const l = this.chars.get(this.poiTaken.get("pong-l") ?? "");
    const r = this.chars.get(this.poiTaken.get("pong-r") ?? "");
    return l?.mode === "poi" && r?.mode === "poi";
  }

  inArea(area: string): number {
    let n = 0;
    for (const c of this.chars.values()) if (c.mode === "poi" && c.poi?.area === area) n++;
    return n;
  }

  positions(): Point[] {
    const out: Point[] = [];
    for (const c of this.chars.values()) if (c.sprite.visible) out.push({ x: c.x, y: c.y });
    return out;
  }

  private isOffline(c: SessionCharacter): boolean {
    return this.model.sessions.get(c.sessionId)?.offline === true;
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
    this.clock = time;
    this.scene.arcadeBusy.clear();
    for (const c of [...this.chars.values()]) {
      this.step(c, dt, time);
      if (c.removed) continue;
      if (c.mode !== "zapped") {
        const off = this.isOffline(c);
        c.sprite.tint = off ? 0x5a6988 : 0xffffff;
        c.sprite.alpha = off ? 0.6 : 1;
      }
      if (Math.abs(c.x - door.x) < 26 && Math.abs(c.y - door.y) < 30) doorBusy = true;
      c.helpers.update(dt, time);
      if (c.mode === "poi" && c.poi?.id.startsWith("arcade"))
        this.scene.arcadeBusy.add(c.poi.tile.x);
    }
    this.updateRemains(dt, time);
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
    if (c.mugT > 0) c.mugT -= dt;
    const activity = this.activityOf(c);
    c.marker.visible = false;
    c.ring.visible = false;
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
        if (activity !== "idle") {
          this.goToDesk(c);
          break;
        }
        if (c.chat) {
          this.chatStep(c, dt);
          break;
        }
        // someone is on the way over to chat: wait for them
        const visitor = [...this.chars.values()].some(
          (o) => o.chatTarget === c && o.mode === "walking",
        );
        c.timer -= visitor ? 0 : dt;
        // bump into someone standing close by: a quick chat
        c.chatCheck -= dt;
        if (c.chatCheck <= 0) {
          c.chatCheck = 1;
          if (this.chatty(c) && this.rand() < this.chatChance) {
            for (const o of this.chars.values()) {
              if (o !== c && this.chatty(o) && Math.hypot(o.x - c.x, o.y - c.y) < 40) {
                this.startChat(c, o);
                break;
              }
            }
          }
        }
        if (!c.chat && c.timer <= 0) {
          if (c.poi?.id === "coffee") {
            // got the coffee: off with a steaming mug
            c.mugT = 60 + this.rand() * 60;
            this.idleWander(c);
          } else if (this.rand() < 0.6 || c.chatCooldown > 15) this.idleWander(c);
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
      case "zapped": {
        // fried: flicker between charred and blinding, jitter, then gone (remains take over)
        c.zapT += dt;
        const k = Math.floor(c.zapT * 16) % 2;
        c.sprite.tint = k ? 0x000000 : 0xffffff;
        c.sprite.x = Math.round(c.x + (k ? 1 : -1));
        c.sprite.visible = c.zapT < 0.9;
        if (c.zapT >= 0.9) {
          this.destroy(c);
          return;
        }
        return;
      }
    }
    c.chatCooldown -= dt;
    if (c.iconT > 0) {
      c.iconT -= dt;
      c.icon.visible = c.iconT > 0;
      const right = c.facing === "right" ? 1 : c.facing === "left" ? -1 : 0;
      const top = c.y - (c.anim === "sitFront" ? 21 : 24);
      c.icon.position.set(Math.round(c.x + right * 3), Math.round(top - 1));
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
      if (this.isOffline(c)) {
        c.marker.texture = zzzTextures()[Math.floor(time * 1.5 + c.desk) % 3]!;
        c.marker.visible = true;
        c.marker.position.set(Math.round(c.x + 6), Math.round(headY - 1));
      } else if (activity === "waiting") {
        const frames = alertTextures();
        c.marker.texture = frames[Math.floor(time * 3) % 2]!;
        c.marker.visible = true;
        // waiting a long time: the "!" wiggles and a ping ring goes out every few seconds
        const long = this.waitedMs(c) >= WAIT_PING_MS;
        const cycle = (time + c.desk * 0.37) % 2.4;
        const wiggle = long && cycle < 0.8 ? Math.round(Math.sin(time * 30) * 1.5) : 0;
        // on the left of the head: the raised hand (right side) stays visible
        c.marker.position.set(
          Math.round(c.x - 7 + wiggle),
          Math.round(headY - 2 + Math.round(Math.sin(time * 6))),
        );
        c.ring.visible = long && cycle < 0.6;
        if (c.ring.visible) {
          c.ring.texture = ringTextures()[Math.min(3, Math.floor(cycle / 0.15))]!;
          c.ring.position.set(Math.round(c.x), Math.round(c.y - 10));
        }
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
    if (this.isOffline(c)) {
      this.setAnim(c, "sitIdle", 0.25, time);
      this.setMonitorFor(c, "off");
      c.timer = 2;
      return;
    }
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
        this.setMonitorFor(c, "think");
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
    } else if (c.goal === "chat") {
      const o = c.chatTarget;
      c.mode = "poi";
      c.poi = null;
      c.timer = 4;
      if (o && this.chatty(o) && this.activityOf(c) === "idle") this.startChat(c, o);
      else {
        c.chatTarget = null;
        this.idleWander(c);
      }
    } else if (c.goal === "poi") {
      c.mode = "poi";
      c.facing = c.poi?.face ?? "down";
      c.timer = c.poi?.id === "coffee" ? 3 + this.rand() * 2 : (10 + this.rand() * 15) * this.dwell;
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
