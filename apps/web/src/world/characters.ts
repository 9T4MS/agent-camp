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
import { Sprite, Texture } from "pixi.js";
import {
  type AnimName,
  CHAR_H,
  type CharacterSheet,
  characterSheet,
  lookFor,
  releaseSheet,
  retainSheet,
} from "../art/characters.ts";
import type { MonitorState } from "../art/desk.ts";
import {
  cobwebTexture,
  craterTexture,
  signTexture,
  skeletonTexture,
  splatTexture,
} from "../art/drama.ts";
import {
  beerTextures,
  boltTextures,
  CHAT_ICONS,
  CHAT_TOPICS,
  chatIconTextures,
  ghostTextures,
  jointTextures,
  mugTextures,
  pileTextures,
  plateTextures,
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
import { flameTextures, smokeTexture } from "../art/heat.ts";
import { C } from "../art/palette.ts";
import { POD_MATS } from "../art/tiles.ts";
import { type DeskSeat, deskSwaps, preferMover, stateSince } from "../state/deskRules.ts";
import type { ModelChange, OfficeModel, PersonState, SessionState } from "../state/officeModel.ts";
import type { Perch, WaitSpot } from "./cat.ts";
import {
  CRATER_S,
  type EndedDesk,
  explodeCheck,
  HitCounter,
  isGhostHour,
  pickGhosts,
  REARM_BELOW,
  REBELLION_EVERY_S,
  REBELLION_HELPERS,
  REBELLION_S,
  SPLAT_S,
  skeletonAmount,
  ZOMBIE_AFTER_MS,
} from "./dramaRules.ts";
import type { Effects } from "./effects.ts";
import { helperArea } from "./helperRules.ts";
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
  isBarPoi,
  isBarStool,
  isShopPoi,
  isSmokePoi,
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
/** the hourly bow: everybody runs */
const RUN_SPEED = 92;
const HOP_S = 0.35;
const BUBBLE_SECONDS = 2.6;
/** seats sort by their bottom edge, 5 px below a sitter's feet */
const SEAT_LIFT = 6;
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

/** What someone carries around after a break: a coffee, a beer, a joint, a plate from the kitchen. */
type Carry = "coffee" | "beer" | "joint" | "plate";
const CARRY_TEXTURES: Record<Carry, () => Texture[]> = {
  coffee: mugTextures,
  beer: beerTextures,
  joint: jointTextures,
  plate: plateTextures,
};

type Mode = "queued" | "walking" | "seated" | "poi" | "waving" | "leaving" | "zapped" | "carried";
type Goal = "desk" | "poi" | "exit" | "chat" | "lunch" | "evac" | "rally";
type Crater = { crater: Sprite; sign: Sprite; t: number };
type Rebellion = { cool: number; t: number; c: SessionCharacter | null; seat: Point };
type Ghost = EndedDesk & { sheet: CharacterSheet };
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

/** Local calendar day key (night ghosts belong to one day). */
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Context-window share where a session starts smoking / catches fire. */
export const SMOKE_AT = 0.5;
export const FIRE_AT = 0.8;

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
  /** a coffee mug, beer or joint in hand (seconds left) */
  mug: Sprite;
  mugT = 0;
  carry: Carry = "coffee";
  /** smokers' corner: next smoke puff / "chill" bubble */
  puffT = 0;
  /** chat icon bubble */
  icon: Sprite;
  iconT = 0;
  /** "ping" ring for long waits */
  ring: Sprite;
  /** flames over the head: context window nearly full */
  flame: Sprite;
  smokeT = 0;
  /** blows up once its context crosses EXPLODE_AT (re-arms below REARM_BELOW) */
  explodeArmed = true;
  /** skeleton overlay (long waits) and its cobweb; skelK = 0..1 */
  skel: Sprite;
  web: Sprite;
  skelK = 0;
  /** tomato splat that stays on for a while */
  splat: Sprite;
  splatT = 0;
  zombieT = 8;
  /** standing outside during a fire alarm */
  evac = false;
  /** lined up for the hourly bow at the head desk (the line runs them) */
  rally = false;
  /** seconds left of the bow / of the jump up from the chair */
  bowT = 0;
  hopT = 0;
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
    this.flame = new Sprite(flameTextures()[0]!);
    this.flame.anchor.set(0.5, 1);
    this.flame.visible = false;
    this.skel = new Sprite(skeletonTexture());
    this.skel.anchor.set(0.5, 1);
    this.skel.label = "actor";
    this.skel.visible = false;
    this.web = new Sprite(cobwebTexture());
    this.web.anchor.set(0.5, 1);
    this.web.visible = false;
    this.splat = new Sprite(splatTexture());
    this.splat.anchor.set(0.5);
    this.splat.visible = false;
  }

  get hasDesk() {
    return this.desk < MAX_DESKS;
  }
}

export class CharacterManager {
  readonly chars = new Map<string, SessionCharacter>();
  private poiTaken = new Map<string, string>();
  private rand = seededRandom("characters");
  onMoment: (m: Moment) => void = () => {};
  /** pending join celebrations (door opens, confetti, banner) */
  private joins: { personId: string; t: number; done: boolean }[] = [];
  /** multiplies waiting time for the fun thresholds (demo=party runs them 10x faster) */
  timeScale = 1;
  /** how likely idle people strike up a chat (party demo: chattier) */
  chatChance = 0.35;
  /** multiplies how long idle people stay at a spot (party demo: they move around more) */
  dwell = 1;
  /** how likely an idle wander goes to the weed shop while it is open (feierabend demo: more) */
  shopChance = 0.1;
  /** a pizza is on the meeting table: idle people gather there */
  pizzaActive: () => boolean = () => false;
  /** an office cat may eat a finished helper (wired up in main.ts) */
  catEats: (sprite: Sprite, x: number, y: number) => boolean = () => false;
  /** office-local hour 0..24 (night ghosts) */
  hour: () => number = () => 12;
  /** where the parked food truck serves (world px), or null when there is none */
  lunchSpot: () => { x: number; y: number } | null = () => null;
  /** a character just picked up a coffee */
  onCoffee: (personId: string) => void = () => {};
  /** the cook is at the stove: plates at the kitchen pass */
  snackOpen: () => boolean = () => false;
  /** someone got a plate (at x, y) */
  onSnack: (x: number, y: number) => void = () => {};
  /** someone punched their hours at the time clock (at x, y) */
  onPunch: (x: number, y: number) => void = () => {};
  private hits = new HitCounter();
  private craters: Crater[] = [];
  private rebels = new Map<string, Rebellion>();
  private endedDesks: Ghost[] = [];
  private ghostSprites: Sprite[] = [];
  private ghosts: Ghost[] = [];
  private ghostCheck = 0;
  /** seconds until the next look for idle desk holders and working roamers */
  private deskCheck = 0;
  /** when a session last won or lost a desk in a swap (Date.now), for the cooldown */
  private swappedAt = new Map<string, number>();
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
          if (!s) continue;
          // swap to the new sheet right away (same frame), then free the old one
          const old = c.sheet;
          c.sheet = this.sheetFor(p, s);
          const i = old.frames.indexOf(c.sprite.texture);
          c.sprite.texture = c.sheet.frames[Math.max(0, i)]!;
          releaseSheet(old);
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
          !c.evac &&
          !c.rally &&
          (c.mode === "poi" || (c.mode === "walking" && (c.goal === "poi" || c.goal === "lunch")))
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
        c.rally = false;
        if (c.chat) this.endChat(c);
        if (c.mode === "poi" || (c.mode === "walking" && c.goal !== "exit")) this.goToDesk(c);
        break;
      }
      case "contextChanged": {
        const c = this.chars.get(ch.sessionId);
        if (c && (ch.context ?? 0) >= FIRE_AT) this.effects.puff(c.x, c.y - 20);
        break;
      }
      case "helpersChanged":
        for (const c of this.chars.values())
          if (c.personId === ch.personId && !c.removed) c.helpers.setSkin(ch.helpers, true);
        break;
      case "officeRenamed":
      case "interaction":
      case "birthdayChanged":
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
   * session (2..6), a slot still holding characters of someone who left keeps its desks,
   * the first free slot shows the "free desk" placeholder and every other slot is a nook.
   */
  syncSlots(moved: ReadonlySet<SessionCharacter> = new Set()) {
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
        const n = clampDesks(need);
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
        did = this.scene.setSlot(pod, { kind: freeShown ? "nook" : "free" });
        freeShown = true;
      }
      if (did) changed.push(pod);
    }
    if (changed.length === 0 && moved.size === 0) return;
    const pois = new Set([...this.scene.map.pois, ...this.scene.nookPois]);
    const map = this.scene.map;
    for (const c of this.chars.values()) {
      if (c.poi && (!pois.has(c.poi) || !map.isWalkable(c.poi.tile.x, c.poi.tile.y))) {
        // the nook they were lounging in became someone's pod
        this.releasePoi(c);
        if (c.mode === "poi" || c.mode === "walking") this.idleWander(c);
      }
      if (!changed.includes(c.pod) && !moved.has(c)) continue;
      const seat = this.seatOf(c.pod, c.desk);
      c.helpers.setArea((n) => helperArea(podAisle(c.pod), seat, n), seat);
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
    if (c.hasDesk) {
      // the ghost holds its own sheet reference (the character releases its one when it leaves)
      retainSheet(c.sheet);
      this.endedDesks.push({ pod: c.pod, desk: c.desk, day: dayKey(now), at: now, sheet: c.sheet });
      if (this.endedDesks.length > 60) this.dropGhosts([this.endedDesks.shift()!]);
    }
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

  /** Holds one sheet reference: release it when the character drops or replaces it. */
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
      (n) => helperArea(podAisle(p.pod), seat, n),
      seat,
      seededRandom(`helpers:${sessionId}`),
      this.helperWorld,
      p.helpers,
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
    c.explodeArmed = (s.context ?? 0) < REARM_BELOW;
    this.scene.objects.addChild(c.sprite, c.mug, c.skel);
    this.scene.fx.addChild(c.ring, c.marker, c.icon, c.bubble, c.flame, c.web, c.splat);
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
    this.scene.objects.removeChild(c.sprite, c.mug, c.skel);
    this.scene.fx.removeChild(c.bubble, c.marker, c.icon, c.ring, c.flame, c.web, c.splat);
    for (const sp of [
      c.sprite,
      c.bubble,
      c.marker,
      c.mug,
      c.icon,
      c.ring,
      c.flame,
      c.skel,
      c.web,
      c.splat,
    ])
      sp.destroy();
    releaseSheet(c.sheet);
    this.chars.delete(c.sessionId);
    this.swappedAt.delete(c.sessionId);
    const { moved, promoted } = this.fillDeskGaps(c.personId);
    this.syncSlots(moved);
    for (const m of promoted) {
      if (!m.evac && !m.rally && (m.mode === "poi" || m.mode === "walking")) this.goToDesk(m);
    }
  }

  /**
   * Move agents from the highest desks (or roaming) into freed ones, so the pod matches a
   * fresh load. `promoted` were roaming and now have a desk to walk to.
   */
  private fillDeskGaps(personId: string) {
    const moved = new Set<SessionCharacter>();
    const promoted = new Set<SessionCharacter>();
    const p = this.model.people.get(personId);
    if (!p) return { moved, promoted };
    for (;;) {
      const used = new Set(this.model.sessionsOf(personId).map((s) => s.desk));
      for (const o of this.chars.values()) if (o.pod === p.pod) used.add(o.desk);
      let gap = 0;
      while (used.has(gap)) gap++;
      if (gap >= MAX_DESKS) return { moved, promoted };
      let best: { c: SessionCharacter; desk: number; working: boolean } | undefined;
      for (const o of this.chars.values()) {
        if (o.personId !== personId || o.removed || o.desk <= gap) continue;
        if (o.mode === "waving" || o.mode === "leaving" || o.mode === "zapped") continue;
        if (!this.model.sessions.has(o.sessionId)) continue;
        best = preferMover(best, { c: o, desk: o.desk, working: this.working(o) }, MAX_DESKS);
      }
      const mover = best?.c;
      if (!mover) return { moved, promoted };
      if (!mover.hasDesk) promoted.add(mover);
      else if (!this.otherAtDesk(mover)) {
        this.setMonitorFor(mover, "off");
        this.resetChair(mover);
      }
      this.model.moveDesk(mover.sessionId, gap);
      mover.desk = gap;
      moved.add(mover);
    }
  }

  /**
   * Working sessions win desks: a person's working roamer takes the desk of their idle desk
   * holder, who gets up and roams instead (rules and hysteresis in deskRules.ts). Runs about
   * once a second and only looks at people who have roamers, so it costs next to nothing.
   */
  private balanceDesks() {
    const roaming = new Set<string>();
    for (const c of this.chars.values()) if (!c.hasDesk && !c.removed) roaming.add(c.personId);
    if (roaming.size === 0) return;
    const now = Date.now();
    for (const personId of roaming) {
      const mine = new Map<string, SessionCharacter>();
      const seats: DeskSeat[] = [];
      for (const c of this.chars.values()) {
        if (c.personId !== personId || c.removed) continue;
        const s = this.model.sessions.get(c.sessionId);
        if (!s) continue;
        mine.set(c.sessionId, c);
        seats.push({
          id: c.sessionId,
          desk: c.desk,
          idle: s.activity === "idle",
          since: stateSince(s.activityLog, s.activitySince),
          movable:
            !s.offline &&
            !c.evac &&
            c.mode !== "waving" &&
            c.mode !== "leaving" &&
            c.mode !== "zapped" &&
            c.mode !== "carried",
          swappedAt: this.swappedAt.get(c.sessionId),
        });
      }
      for (const sw of deskSwaps(seats, now, MAX_DESKS)) {
        const taker = mine.get(sw.taker);
        const yielder = mine.get(sw.yielder);
        if (taker && yielder) this.swapDesks(taker, yielder, now);
      }
    }
  }

  /** `taker` (roaming) gets `yielder`'s desk and walks over; the yielder gets up and roams. */
  private swapDesks(taker: SessionCharacter, yielder: SessionCharacter, now: number) {
    const desk = yielder.desk;
    const roam = taker.desk;
    // the desk goes dark with its chair pushed in until the new owner sits down
    if (!this.otherAtDesk(yielder)) {
      this.setMonitorFor(yielder, "off");
      this.resetChair(yielder);
    }
    this.model.moveDesk(yielder.sessionId, roam);
    yielder.desk = roam;
    this.model.moveDesk(taker.sessionId, desk);
    taker.desk = desk;
    this.swappedAt.set(taker.sessionId, now);
    this.swappedAt.set(yielder.sessionId, now);
    // helpers follow their agent's new spot; nobody here is seated at a desk any more
    this.syncSlots(new Set([taker, yielder]));
    if (yielder.mode === "seated" || (yielder.mode === "walking" && yielder.goal === "desk"))
      this.idleWander(yielder);
    if (
      !taker.evac &&
      (taker.mode === "poi" || (taker.mode === "walking" && taker.goal !== "exit"))
    )
      this.goToDesk(taker);
  }

  /** Busy and online: the kind of session that should have a desk. */
  private working(c: SessionCharacter): boolean {
    const s = this.model.sessions.get(c.sessionId);
    return !!s && s.activity !== "idle" && !s.offline;
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
      list.filter(
        (p) => !this.poiTaken.has(p.id) && map.isWalkable(p.tile.x, p.tile.y) && this.isOpen(p),
      );
    const take = (poi: Poi) => {
      this.releasePoi(c);
      this.poiTaken.set(poi.id, c.sessionId);
      c.poi = poi;
      this.walkTo(c, poi.tile, "poi", poi.spot);
    };
    const all = free(this.scene.map.pois);
    const pick = (list: Poi[]) => take(list[Math.floor(this.rand() * list.length)]!);
    // fresh from the shop: light it up in the smokers' corner
    if (c.carry === "joint" && c.mugT > 0 && this.rand() < 0.85) {
      const smoke = all.filter(isSmokePoi);
      if (smoke.length) return pick(smoke);
    }
    // a beer in hand: find a stool or a standing table
    if (c.carry === "beer" && c.mugT > 0 && this.rand() < 0.6) {
      const seats = all.filter((p) => isBarPoi(p) && p.id !== "tap");
      if (seats.length) return pick(seats);
    }
    // the bar is open (happy hour: everybody goes): pour one at the tap or grab a stool
    if (this.scene.barOpen && this.rand() < (this.scene.happyHour ? 0.55 : 0.18)) {
      const tap = all.find((p) => p.id === "tap");
      if (tap && (c.mugT <= 0 || c.carry !== "beer") && this.rand() < 0.6) return take(tap);
      const bar = all.filter(isBarPoi);
      if (bar.length) return pick(bar);
    }
    // the shop is open: buy something at the counter, or just look at the jars
    if (this.scene.shopOpen && this.rand() < this.shopChance) {
      const counter = all.find((p) => p.id === "shop-counter");
      if (counter && c.mugT <= 0 && this.rand() < 0.6) return take(counter);
      const shop = all.filter(isShopPoi);
      if (shop.length) return pick(shop);
    }
    // the food truck is outside: grab something to eat
    if (this.rand() < 0.45 && this.goLunch(c)) return;
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
    // without their own odds these two would be one POI in sixty
    if (c.mugT <= 0 && this.rand() < 0.15) {
      const snack = all.find((p) => p.id === "snack");
      if (snack) return take(snack);
    }
    if (this.rand() < 0.1) {
      const clock = all.find((p) => p.id === "timeclock");
      if (clock) return take(clock);
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

  /** Bar spots only while the bar is open, the shop's inside only while the shop is open. */
  private isOpen(p: Poi): boolean {
    if (p.id === "snack") return this.snackOpen();
    if (isBarPoi(p)) return this.scene.barOpen;
    if (isShopPoi(p)) return this.scene.shopOpen;
    return true;
  }

  /** Something to carry around for a while (replaces whatever was in hand). */
  private hold(c: SessionCharacter, item: Carry, seconds: number) {
    c.carry = item;
    c.mugT = seconds;
  }

  // ---- chats ----------------------------------------------------------------------------
  private chatty(o: SessionCharacter) {
    return (
      !o.removed &&
      o.mode === "poi" &&
      !o.rally &&
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
      let name = CHAT_TOPICS[Math.floor(this.rand() * CHAT_TOPICS.length)]!;
      if (this.pizzaActive() && this.rand() < 0.5) name = "pizza";
      else if (c.mugT > 0 && this.rand() < 0.3) name = c.carry === "joint" ? "chill" : c.carry;
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
    const hop = c.hopT > 0 ? Math.round(Math.sin((1 - c.hopT / HOP_S) * Math.PI) * 5) : 0;
    c.sprite.position.set(Math.round(c.x), Math.round(c.y) - hop);
    c.sprite.zIndex =
      c.y + (c.mode === "poi" && c.poi?.spot && c.poi.pose === "sit" ? SEAT_LIFT : 0);
    // at the bar counter (stool, back to the camera) the glass stands on the counter beside them
    const onCounter =
      c.mugT > 0 && c.mode === "poi" && c.facing === "up" && !!c.poi && isBarStool(c.poi);
    const showMug =
      onCounter || (c.mugT > 0 && c.facing !== "up" && (c.mode === "walking" || c.mode === "poi"));
    c.mug.visible = showMug;
    if (onCounter) {
      c.mug.position.set(Math.round(c.x + 9), Math.round(c.y - 28));
      c.mug.zIndex = c.y - 0.5;
      c.mug.texture = CARRY_TEXTURES[c.carry]()[Math.floor(this.clock * 2.5) % 2]!;
    } else if (showMug) {
      const side = c.facing === "left" ? -6 : c.facing === "right" ? 6 : 6;
      const lift = c.anim === "sitFront" ? 4 : 0;
      c.mug.position.set(Math.round(c.x + side), Math.round(c.y - 6 - lift));
      c.mug.zIndex = c.sprite.zIndex + 0.5;
      c.mug.texture = CARRY_TEXTURES[c.carry]()[Math.floor(this.clock * 2.5) % 2]!;
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

  /** Seated, online people with a working or waiting agent (who the queen pages). */
  pageable(): (WaitSpot & { waiting: boolean })[] {
    const out: (WaitSpot & { waiting: boolean })[] = [];
    for (const c of this.chars.values()) {
      if (c.mode !== "seated" || this.isOffline(c) || !c.sprite.visible) continue;
      const a = this.activityOf(c);
      if (a === "idle") continue;
      out.push({ x: c.x, y: c.y, id: c.sessionId, waiting: a === "waiting" });
    }
    return out;
  }

  /** Every seated, online person at a desk, whatever their agent is doing (Eloy meows at them). */
  devs(): WaitSpot[] {
    const out: WaitSpot[] = [];
    for (const c of this.chars.values()) {
      if (c.mode !== "seated" || this.isOffline(c) || !c.sprite.visible) continue;
      out.push({ x: c.x, y: c.y, id: c.sessionId });
    }
    return out;
  }

  /** A paged person answers from their chair. */
  answerPage(sessionId: string, text: string) {
    const c = this.chars.get(sessionId);
    if (c && !c.removed && c.mode === "seated") this.say(c, text);
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

  /** In the smokers' corner with a joint: puffs of smoke and now and then a "chill" bubble. */
  private smokeStep(c: SessionCharacter, dt: number) {
    c.puffT -= dt;
    if (c.puffT > 0) return;
    c.puffT = 1 + this.rand() * 0.8;
    const side = c.facing === "left" ? -6 : 6;
    const head = c.y - (c.anim === "sitFront" ? 21 : 24);
    this.effects.floater(smokeTexture(), c.x + side, head + 6, 2.2, 16, 2);
    if (!c.chat && c.iconT <= 0 && this.rand() < 0.3) {
      c.icon.texture = chatIconTextures()[CHAT_ICONS.indexOf("chill")]!;
      c.icon.visible = true;
      c.iconT = 1.6;
    }
  }

  /** Past half the context window: smoke; past 80%: on fire. Only at the desk, only online. */
  private heat(c: SessionCharacter, dt: number, time: number) {
    const ctx = this.model.sessions.get(c.sessionId)?.context ?? 0;
    const hot = c.mode === "seated" && c.sprite.visible && !this.isOffline(c);
    const head = c.y - 21;
    c.flame.visible = hot && ctx >= FIRE_AT;
    if (c.flame.visible) {
      c.flame.texture = flameTextures()[Math.floor(time * 8 + c.desk) % 3]!;
      c.flame.position.set(Math.round(c.x + 1), Math.round(head + 3));
    }
    if (!hot || ctx < SMOKE_AT) return;
    c.smokeT -= dt;
    if (c.smokeT > 0) return;
    // fuller context, thicker smoke
    c.smokeT = ctx >= FIRE_AT ? 0.45 : 1.6 - (ctx - SMOKE_AT) * 3;
    this.effects.floater(smokeTexture(), c.x + (this.rand() - 0.5) * 6, head - 2, 1.8, 14, 1.5);
  }

  // ---- drama ----------------------------------------------------------------------------
  /** Explosions, skeletons, zombies and splats of one character (each frame). */
  private drama(c: SessionCharacter, dt: number) {
    const s = this.model.sessions.get(c.sessionId);
    const offline = this.isOffline(c);
    const chk = explodeCheck(c.explodeArmed, s?.context);
    c.explodeArmed = chk.armed;
    if (chk.explode) {
      if (c.mode === "seated" && c.hasDesk && !offline) this.explode(c);
      else c.explodeArmed = true;
    }
    // skeleton: fades in with the wait, back in one puff
    const target = c.mode === "seated" && !offline ? skeletonAmount(this.waitedMs(c)) : 0;
    if (target === 0 && c.skelK > 0.05) this.effects.puff(c.x, c.y - 14);
    c.skelK = target;
    c.skel.visible = c.skelK > 0 && c.sprite.visible;
    if (c.skel.visible) {
      c.skel.position.copyFrom(c.sprite.position);
      c.skel.zIndex = c.sprite.zIndex + 0.01;
      c.skel.alpha = c.skelK;
    }
    c.web.visible = c.skelK > 0.5 && c.hasDesk;
    if (c.web.visible) {
      const seat = this.seatOf(c.pod, c.desk);
      c.web.position.set(Math.round(seat.x - 9), Math.round(seat.y - 16));
      c.web.alpha = Math.min(1, (c.skelK - 0.5) * 4);
    }
    if (this.isZombie(c)) {
      c.zombieT -= dt;
      if (c.zombieT <= 0) {
        c.zombieT = 15 + this.rand() * 20;
        this.say(c, "BRAINNNS...");
      }
    }
    if (c.splatT > 0) c.splatT -= dt;
    c.splat.visible = c.splatT > 0 && c.sprite.visible;
    if (c.splat.visible) {
      const up = c.mode === "seated" ? 14 : 16;
      c.splat.position.set(Math.round(c.x + 1), Math.round(c.y - up));
      c.splat.alpha = Math.min(1, c.splatT / 30);
    }
  }

  private idleMs(c: SessionCharacter): number {
    const s = this.model.sessions.get(c.sessionId);
    if (s?.activity !== "idle") return 0;
    return (Date.now() - s.activitySince) * this.timeScale;
  }

  private isZombie(c: SessionCharacter): boolean {
    return !this.isOffline(c) && this.idleMs(c) > ZOMBIE_AFTER_MS;
  }

  /** Context full: BOOM, a crater with a sign, and the agent walks back in fresh. */
  private explode(c: SessionCharacter) {
    const x = c.x;
    const y = c.y;
    const flash = new Sprite(glowTexture(30, C.white));
    flash.anchor.set(0.5);
    flash.position.set(Math.round(x), Math.round(y - 16));
    this.scene.glows.addChild(flash);
    this.effects.after(0.35, () => {
      this.scene.glows.removeChild(flash);
      flash.destroy();
    });
    this.effects.burst(x, y - 14, [C.orange, C.amber, C.red, C.night, C.lemon], {
      count: 36,
      speed: 90,
      life: 1.6,
      floor: y + 4,
      rand: this.rand,
    });
    this.effects.puff(x, y - 10);
    this.effects.after(0.2, () => this.effects.puff(x + 6, y - 18));
    this.effects.floater(toastTexture("BOOM!"), x, y - 30, 1.6, 14);
    const crater = new Sprite(craterTexture());
    crater.anchor.set(0.5);
    crater.position.set(Math.round(x), Math.round(y + 8));
    crater.zIndex = y + 1.5;
    crater.label = "actor";
    const sign = new Sprite(signTexture("COMPACTED"));
    sign.anchor.set(0.5, 1);
    sign.position.set(Math.round(x + 18), Math.round(y + 14));
    sign.zIndex = y + 14;
    sign.label = "actor";
    this.scene.objects.addChild(crater, sign);
    this.craters.push({ crater, sign, t: 0 });
    this.endChat(c);
    this.releasePoi(c);
    this.setMonitorFor(c, "off");
    this.resetChair(c);
    c.skelK = 0;
    c.sprite.visible = false;
    c.flame.visible = false;
    c.bubbleT = 0;
    c.bubble.visible = false;
    const sp = this.scene.map.spawn;
    c.x = sp.x * TILE + 16;
    c.y = sp.y * TILE + 14;
    c.path = [];
    c.mode = "queued";
    c.delay = 2.5;
  }

  private updateCraters(dt: number) {
    for (let i = this.craters.length - 1; i >= 0; i--) {
      const k = this.craters[i]!;
      k.t += dt;
      const a = Math.min(1, Math.max(0, (CRATER_S - k.t) / 2));
      k.crater.alpha = a;
      k.sign.alpha = a;
      if (k.t < CRATER_S) continue;
      this.scene.objects.removeChild(k.crater, k.sign);
      k.crater.destroy();
      k.sign.destroy();
      this.craters.splice(i, 1);
    }
  }

  /** ≥ 10 helpers: now and then they carry their boss once around the pod. */
  private updateRebellions(dt: number) {
    for (const id of this.rebels.keys()) if (!this.model.people.has(id)) this.rebels.delete(id);
    for (const p of this.model.people.values()) {
      const r = this.rebels.get(p.personId) ?? { cool: 5, t: 0, c: null, seat: { x: 0, y: 0 } };
      this.rebels.set(p.personId, r);
      const mine = this.charactersOf(p.personId);
      if (r.c) {
        const c = r.c;
        r.t += dt;
        const u = r.t / REBELLION_S;
        if (c.removed || c.mode !== "carried" || u >= 1) {
          if (!c.removed && c.mode === "carried") this.sit(c);
          for (const o of mine) o.helpers.escort = null;
          r.c = null;
          r.cool = REBELLION_EVERY_S;
          continue;
        }
        const a = u * Math.PI * 2;
        c.x = r.seat.x + 30 * Math.sin(a);
        c.y = r.seat.y + 14 * (1 - Math.cos(a));
        c.facing = "down";
        for (const o of mine) o.helpers.escort = { x: c.x, y: c.y };
        continue;
      }
      const total = this.model.sessionsOf(p.personId).reduce((n, s) => n + s.subagents, 0);
      if (total < REBELLION_HELPERS) {
        r.cool = Math.min(r.cool, 5);
        continue;
      }
      r.cool -= dt;
      if (r.cool > 0) continue;
      const c = mine.find(
        (o) => o.mode === "seated" && o.hasDesk && !this.isOffline(o) && o.skelK === 0,
      );
      if (!c) {
        r.cool = 5;
        continue;
      }
      r.c = c;
      r.t = 0;
      r.seat = this.seatOf(c.pod, c.desk);
      c.mode = "carried";
      this.effects.puff(c.x, c.y - 6);
      this.say(c, "WHOA!");
    }
  }

  /** Forget ended desks: give back their sheet references (`ghosts` is re-picked from the rest). */
  private dropGhosts(gone: Ghost[]) {
    if (!gone.length) return;
    // no ghost sprite may keep showing a texture that is about to be freed (re-set next update)
    for (const sp of this.ghostSprites) sp.texture = Texture.EMPTY;
    this.ghosts = this.ghosts.filter((g) => !gone.includes(g));
    for (const g of gone) releaseSheet(g.sheet);
  }

  /** At night today's ended sessions haunt their free desks. */
  private updateGhosts(dt: number, time: number) {
    this.ghostCheck -= dt;
    if (this.ghostCheck <= 0) {
      this.ghostCheck = 2;
      const day = dayKey(Date.now());
      this.dropGhosts(this.endedDesks.filter((g) => g.day !== day));
      this.endedDesks = this.endedDesks.filter((g) => g.day === day);
      const occupied = (pod: number, desk: number) =>
        !this.scene.desk(pod, desk) ||
        [...this.chars.values()].some((c) => c.pod === pod && c.desk === desk);
      this.ghosts = isGhostHour(this.hour()) ? pickGhosts(this.endedDesks, occupied, day) : [];
    }
    while (this.ghostSprites.length < this.ghosts.length) {
      const g = new Sprite();
      g.anchor.set(0.5, 1);
      g.label = "actor";
      g.tint = 0xc0e8ff;
      this.scene.objects.addChild(g);
      this.ghostSprites.push(g);
    }
    while (this.ghostSprites.length > this.ghosts.length) {
      const g = this.ghostSprites.pop()!;
      this.scene.objects.removeChild(g);
      g.destroy();
    }
    this.ghosts.forEach((g, i) => {
      const sp = this.ghostSprites[i]!;
      const frames = g.sheet.anims.sitType;
      sp.texture = frames[Math.floor(time * 6 + i) % frames.length]!;
      const seat = this.seatOf(g.pod, g.desk);
      sp.position.set(Math.round(seat.x), Math.round(seat.y + Math.sin(time * 2 + i)));
      sp.zIndex = seat.y;
      sp.alpha = 0.28 + 0.08 * Math.sin(time * 2.3 + i);
    });
  }

  private nearestWalkable(t: Point, radius: number): Point | null {
    const map = this.scene.map;
    for (let r = 0; r <= radius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (map.isWalkable(t.x + dx, t.y + dy)) return { x: t.x + dx, y: t.y + dy };
        }
      }
    }
    return null;
  }

  /** Walk to (around) a pixel spot over walkable tiles; false when there is no way. */
  private walkToSpot(c: SessionCharacter, spot: Point, goal: Goal, scatter: number): boolean {
    const tile = this.nearestWalkable(
      { x: Math.floor(spot.x / TILE), y: Math.floor(spot.y / TILE) },
      6,
    );
    if (!tile) return false;
    const from = { x: Math.floor(c.x / TILE), y: Math.floor((c.y - 4) / TILE) };
    const tiles = findPath(this.scene.map, from, tile);
    if (!tiles) return false;
    this.releasePoi(c);
    this.endChat(c);
    const end = tileCenter(tile);
    c.path = tiles.slice(1).map(tileCenter);
    c.path.push({ x: end.x + (this.rand() - 0.5) * scatter, y: end.y });
    c.goal = goal;
    c.mode = "walking";
    return true;
  }

  private goLunch(c: SessionCharacter): boolean {
    const spot = this.lunchSpot();
    return !!spot && this.walkToSpot(c, spot, "lunch", 14);
  }

  /** A tomato hit: red splat on the character for a while. */
  tomato(c: SessionCharacter) {
    c.splatT = SPLAT_S;
    this.effects.puff(c.x, c.y - 16);
  }

  /** Count a paper/tomato hit; true once a person got 3 within a minute (they throw back). */
  hitBy(personId: string, _kind: "paper" | "tomato"): boolean {
    return this.hits.hit(personId, Date.now());
  }

  /** Some visible character of someone else (a throw-back target). */
  randomOther(personId: string): SessionCharacter | null {
    const cands = [...this.chars.values()].filter(
      (c) =>
        c.personId !== personId &&
        !c.removed &&
        c.sprite.visible &&
        c.mode !== "queued" &&
        c.mode !== "zapped",
    );
    return cands.length ? cands[Math.floor(this.rand() * cands.length)]! : null;
  }

  /** Seated, online sessions on fire (context ≥ 80%). */
  burningCount(): number {
    let n = 0;
    for (const c of this.chars.values()) {
      if (c.mode !== "seated" || this.isOffline(c)) continue;
      if ((this.model.sessions.get(c.sessionId)?.context ?? 0) >= FIRE_AT) n++;
    }
    return n;
  }

  /** Fire alarm: everyone online runs out to `spot` and waits; null sends them back. */
  evacuate(spot: Point | null) {
    for (const c of [...this.chars.values()]) {
      if (c.removed || this.isOffline(c)) continue;
      if (spot) {
        if (["zapped", "queued", "waving", "leaving"].includes(c.mode) || c.evac) continue;
        c.rally = false;
        c.bowT = 0;
        if (c.mode === "carried") this.sit(c);
        if (c.mode === "seated") this.resetChair(c);
        if (this.walkToSpot(c, spot, "evac", 40)) c.evac = true;
      } else if (c.evac) {
        c.evac = false;
        if (c.hasDesk) this.goToDesk(c);
        else this.idleWander(c);
      }
    }
  }

  /** The hourly bow: everyone online who can drop what they are doing right now. */
  rallyable(): SessionCharacter[] {
    return [...this.chars.values()].filter(
      (c) =>
        !c.removed &&
        !c.evac &&
        c.sprite.visible &&
        !this.isOffline(c) &&
        !["zapped", "queued", "waving", "leaving"].includes(c.mode),
    );
  }

  /** Jump up and run to a spot in the line (again: move up a place). False when there is no way. */
  rallyTo(c: SessionCharacter, spot: Point): boolean {
    if (c.removed || this.isOffline(c)) return false;
    const map = this.scene.map;
    const tile = { x: Math.floor(spot.x / TILE), y: Math.floor(spot.y / TILE) };
    const from = { x: Math.floor(c.x / TILE), y: Math.floor((c.y - 4) / TILE) };
    const tiles = findPath(map, from, tile);
    if (!tiles) return false;
    if (!c.rally) {
      c.rally = true;
      c.hopT = HOP_S;
      if (c.mode === "carried") this.sit(c);
      if (c.mode === "seated") this.resetChair(c);
      this.releasePoi(c);
      this.endChat(c);
      c.chatTarget = null;
    }
    c.bowT = 0;
    c.path = tiles.slice(1).map(tileCenter);
    c.path.push(spot);
    c.goal = "rally";
    c.mode = "walking";
    return true;
  }

  /** In the line and standing still at its spot. */
  rallied(c: SessionCharacter): boolean {
    return c.rally && !c.removed && c.mode === "poi" && c.goal === "rally";
  }

  inLine(c: SessionCharacter): boolean {
    return c.rally && !c.removed;
  }

  bow(c: SessionCharacter, seconds: number) {
    if (!c.rally) return;
    c.facing = "up";
    c.bowT = seconds;
  }

  /** Done bowing (or the line broke up): back to work. */
  release(c: SessionCharacter) {
    if (!c.rally) return;
    c.rally = false;
    c.bowT = 0;
    if (c.removed) return;
    if (c.hasDesk) this.goToDesk(c);
    else this.idleWander(c);
  }

  /**
   * Where a cat sent to someone sits: up on the desk of one of their seated agents, beside the
   * monitor (drawn above the desk, below the person), else next to wherever they are.
   */
  catPerch(personId: string, pick: number): Perch | null {
    const mine = this.charactersOf(personId);
    const seated = mine.filter((c) => c.mode === "seated" && c.hasDesk);
    const c = seated.length > 0 ? seated[pick % seated.length] : mine[pick % (mine.length || 1)];
    if (!c) {
      const spot = this.personSpot(personId);
      return spot ? { seat: spot, desk: null, z: spot.y } : null;
    }
    // no desk to hop onto (not seated, or seated without a desk): sit next to them
    if (c.mode !== "seated" || !c.hasDesk) return { seat: { x: c.x, y: c.y }, desk: null, z: c.y };
    return { seat: { x: c.x, y: c.y }, desk: { x: c.x + 12, y: c.y - 19 }, z: c.y - 1.2 };
  }

  /** Centre of a person's pod desks (cake drone target). */
  personSpot(personId: string): Point | null {
    const p = this.model.people.get(personId);
    if (!p) return null;
    const n = Math.max(2, this.scene.slotDesks(p.pod));
    const span = podDeskSpan(p.pod, n);
    return { x: span.x + span.w / 2, y: this.seatOf(p.pod, 0).y };
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
      this.drama(c, dt);
      if (c.mode !== "zapped") {
        const off = this.isOffline(c);
        c.sprite.tint = off ? 0x5a6988 : this.isZombie(c) ? 0x8fdc7a : 0xffffff;
        c.sprite.alpha = off ? 0.6 : 1 - c.skelK * 0.95;
      }
      if (c.mode === "carried") c.sprite.y -= 10;
      this.heat(c, dt, time);
      if (Math.abs(c.x - door.x) < 26 && Math.abs(c.y - door.y) < 30) doorBusy = true;
      c.helpers.update(dt, time);
      if (c.mode === "poi" && c.poi?.id.startsWith("arcade"))
        this.scene.arcadeBusy.add(c.poi.tile.x);
    }
    this.deskCheck -= dt;
    if (this.deskCheck <= 0) {
      this.deskCheck = 1;
      this.balanceDesks();
    }
    this.updateRemains(dt, time);
    this.updateRebellions(dt);
    this.updateGhosts(dt, time);
    this.updateCraters(dt);
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
    if (c.hopT > 0) c.hopT -= dt;
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
        const zombie = this.isZombie(c);
        this.walkStep(c, zombie ? dt * 0.45 : dt);
        const walkAnim =
          c.facing === "left"
            ? "walkLeft"
            : c.facing === "right"
              ? "walkRight"
              : c.facing === "up"
                ? "walkUp"
                : "walkDown";
        this.setAnim(c, walkAnim, zombie ? 4 : c.rally ? 14 : 8, time);
        if (c.path.length === 0) this.arrive(c);
        break;
      }
      case "carried":
        this.setAnim(c, "wave", 4, time);
        break;
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
        if (c.rally && c.bowT > 0) {
          c.bowT -= dt;
          this.setAnim(c, "bow", 1, time);
        }
        if (c.evac || c.rally) break;
        this.setMonitorFor(c, "idle");
        if (activity !== "idle") {
          this.goToDesk(c);
          break;
        }
        // closing time: the bar / shop sends everybody out
        if (c.poi && !this.isOpen(c.poi)) {
          this.endChat(c);
          this.releasePoi(c);
          this.idleWander(c);
          break;
        }
        if (c.poi && isSmokePoi(c.poi) && c.carry === "joint" && c.mugT > 0) this.smokeStep(c, dt);
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
            this.hold(c, "coffee", 60 + this.rand() * 60);
            this.onCoffee(c.personId);
            this.idleWander(c);
          } else if (c.poi?.id === "tap") {
            // a fresh beer: off to a stool or a standing table
            this.hold(c, "beer", 60 + this.rand() * 60);
            this.idleWander(c);
          } else if (c.poi?.id === "snack") {
            this.hold(c, "plate", 50 + this.rand() * 40);
            this.onSnack(c.x, c.y);
            this.idleWander(c);
          } else if (c.poi?.id === "timeclock") {
            this.onPunch(c.x, c.y);
            this.idleWander(c);
          } else if (c.poi?.id === "shop-counter") {
            // bought something: straight to the smokers' corner
            this.hold(c, "joint", 45 + this.rand() * 30);
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
    if (c.removed) return;
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
    this.place(c);
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
    let budget = (c.rally ? RUN_SPEED : WALK_SPEED) * dt;
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
      const quick =
        c.poi?.id === "coffee" ||
        c.poi?.id === "tap" ||
        c.poi?.id === "shop-counter" ||
        c.poi?.id === "snack" ||
        c.poi?.id === "timeclock";
      c.timer = quick ? 3 + this.rand() * 2 : (10 + this.rand() * 15) * this.dwell;
      // a seat at the counter comes with a beer (it stands on the counter beside them)
      if (c.poi && isBarStool(c.poi) && (c.carry !== "beer" || c.mugT < c.timer + 5))
        this.hold(c, "beer", c.timer + 20 + this.rand() * 40);
      c.puffT = 0.4;
    } else if (c.goal === "lunch") {
      c.mode = "poi";
      c.poi = null;
      c.timer = 4 + this.rand() * 4;
      const spot = this.lunchSpot();
      c.facing = spot && spot.y < c.y ? "up" : "down";
      c.icon.texture = chatIconTextures()[CHAT_ICONS.indexOf("pizza")]!;
      c.icon.visible = true;
      c.iconT = 3;
    } else if (c.goal === "rally") {
      c.mode = "poi";
      c.poi = null;
      c.timer = Number.POSITIVE_INFINITY;
      c.facing = "up";
    } else if (c.goal === "evac") {
      c.mode = "poi";
      c.poi = null;
      c.timer = Number.POSITIVE_INFINITY;
      c.facing = "down";
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

  /** Characters that are idle somewhere (for the cats). */
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
