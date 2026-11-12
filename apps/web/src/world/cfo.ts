/**
 * The CFO: sits behind his desk in his own office next to the game corner, buried in paper. Now
 * and then a dev walks in and asks for their contract; it is always hard and it will take
 * time. Now and then he picks up the phone and calls his beloved colleague at WEKAO. And
 * every so often he comes out of his office, walks up to someone at
 * their desk and asks where the wifi is, or whether anyone is ordering lunch at Pho Ha Noi.
 */
import { seededRandom } from "@agent-office/protocol";
import type { Container } from "pixi.js";
import { C } from "../art/palette.ts";
import { cfoPhoneSheet, cfoSheet } from "../art/residents.ts";
import type { Effects } from "./effects.ts";
import { CFO_DESK, type OfficeMap, type Point, TILE } from "./map.ts";
import { type CfoLine, type CfoOuting, cfoCall, cfoOuting, cfoTalk } from "./residentRules.ts";
import { Walker } from "./walker.ts";

const MUTTER = ["SO MUCH TO DO.", "WHERE WAS I?", "ONE THING AFTER ANOTHER."];
const CLICKED = ["VERY BUSY.", "TAKES TIME.", "LATER, LATER."];
/** a visitor at his desk while he is out of his office */
const EMPTY_DESK = ["CFO?", "HE'S OUT AGAIN.", "WIFI HUNT AGAIN?", "LUNCH RUN?"];
/** a visitor at his desk while he is on the phone to WEKAO */
const ON_THE_PHONE = ["ON THE PHONE AGAIN?", "WEKAO AGAIN?", "I'LL COME BACK LATER."];
/** seconds between two lines of his phone call */
const CALL_GAP = 2.2;
/** seconds between two lines of a visit */
const SAY_GAP = 1.5;

/** What the CFO needs from the session characters (CharacterManager). */
export type CfoPeople = {
  /** a visitor standing at his desk says something */
  visitorSays(sessionId: string, text: string): void;
  /** seated people he can ask about the wifi or lunch */
  seated(): (Point & { id: string })[];
  /** a seated person answers from their chair */
  answer(sessionId: string, text: string): void;
};

type Talk = { id: string; lines: CfoLine[]; t: number };
type Call = { lines: string[]; t: number };

export class Cfo {
  readonly walker: Walker;
  private mode: "desk" | "out" | "ask" | "back" = "desk";
  private rand = seededRandom("cfo");
  private talk: Talk | null = null;
  private mutterT = 10;
  private talkCooldown = 0;
  /** seconds between two outings (shorter in the party demo) */
  outingEvery = 60;
  /** seconds until the next outing */
  outingIn = 25;
  private target: string | null = null;
  /** what he is out for (wifi or lunch) */
  private outing: CfoOuting | null = null;
  /** seconds between two calls to WEKAO (shorter in the party demo) */
  callEvery = 75;
  /** seconds until the next call to WEKAO */
  callIn = 40;
  private call: Call | null = null;
  private readonly deskSheet;
  private readonly phoneSheet = cfoPhoneSheet();

  constructor(
    objects: Container,
    map: OfficeMap,
    private readonly effects: Effects,
    private readonly people: CfoPeople,
  ) {
    this.deskSheet = cfoSheet();
    this.walker = new Walker(objects, this.deskSheet, map, effects, this.seat());
    this.walker.pose = "sitFront";
  }

  /** Behind his desk, facing the door. */
  private seat(): Point {
    return { x: (CFO_DESK.x + 1) * TILE, y: CFO_DESK.y * TILE - 3 };
  }

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.rand() * list.length)]!;
  }

  setMap(map: OfficeMap) {
    this.walker.map = map;
  }

  get y() {
    return this.walker.y;
  }
  hit(wx: number, wy: number) {
    return this.walker.hit(wx, wy);
  }
  /** someone is at his desk right now */
  get talking() {
    return this.talk !== null;
  }
  /** on the phone to WEKAO */
  get calling() {
    return this.call !== null;
  }
  /** out of his office, asking about the wifi or lunch */
  get out() {
    return this.mode !== "desk";
  }

  poke() {
    if (this.talkCooldown > 0) return;
    this.talkCooldown = 1.5;
    const text = this.calling
      ? "SHH, I'M ON THE PHONE!"
      : this.out && this.outing
        ? this.outing.ask
        : this.pick(CLICKED);
    this.walker.say(text, C.plum);
  }

  /** A dev arrived at his desk and asks for something (or finds it empty). */
  asked(sessionId: string) {
    if (this.out) {
      const id = sessionId;
      this.effects.after(0.6, () => this.people.visitorSays(id, this.pick(EMPTY_DESK)));
      return;
    }
    if (this.calling) {
      const id = sessionId;
      this.effects.after(0.6, () => this.people.visitorSays(id, this.pick(ON_THE_PHONE)));
      return;
    }
    this.talk = { id: sessionId, lines: cfoTalk(this.rand).lines, t: 0.4 };
  }

  private talkStep(talk: Talk, dt: number) {
    talk.t -= dt;
    if (talk.t > 0) return;
    const line = talk.lines.shift();
    if (!line) {
      this.talk = null;
      this.walker.pose = "sitFront";
      this.mutterT = 6 + this.rand() * 6;
      return;
    }
    talk.t = SAY_GAP;
    if (line.who === "dev") {
      this.walker.pose = "sitFront";
      this.people.visitorSays(talk.id, line.text);
      return;
    }
    this.walker.say(line.text, C.plum, SAY_GAP + 0.5);
    this.walker.pose = "sitFront";
  }

  /** Picks up the phone and calls WEKAO. */
  private startCall() {
    this.call = { lines: cfoCall(this.rand), t: 0.3 };
    this.walker.sheet = this.phoneSheet;
    this.walker.pose = "sitFront";
  }

  private callStep(call: Call, dt: number) {
    call.t -= dt;
    if (call.t > 0) return;
    const line = call.lines.shift();
    if (!line) {
      this.call = null;
      this.walker.sheet = this.deskSheet;
      this.mutterT = 6 + this.rand() * 6;
      return;
    }
    call.t = CALL_GAP;
    this.walker.say(line, C.plum, CALL_GAP + 0.3);
  }

  /** Off to someone at their desk to ask about the wifi or lunch. */
  private goAsk(): boolean {
    const all = this.people.seated();
    if (!all.length) return false;
    const t = this.pick(all);
    const map = this.walker.map;
    for (const spot of [
      { x: t.x + 12, y: t.y + 10 },
      { x: t.x - 12, y: t.y + 10 },
      { x: t.x, y: t.y + 14 },
    ]) {
      if (!map.isWalkable(Math.floor(spot.x / TILE), Math.floor((spot.y - 4) / TILE))) continue;
      if (this.walker.goTo(spot)) {
        this.target = t.id;
        this.outing = cfoOuting(this.rand);
        this.mode = "out";
        this.walker.say(this.outing.leave, C.plum, 1.6);
        return true;
      }
    }
    return false;
  }

  private goBack() {
    this.target = null;
    this.outing = null;
    if (this.walker.goTo(this.seat())) this.mode = "back";
    else this.sitDown();
  }

  private sitDown() {
    const w = this.walker;
    const s = this.seat();
    w.x = s.x;
    w.y = s.y;
    w.path = [];
    w.facing = "down";
    w.pose = "sitFront";
    this.mode = "desk";
    this.mutterT = 8 + this.rand() * 8;
  }

  update(dt: number, time: number) {
    this.talkCooldown -= dt;
    const w = this.walker;
    switch (this.mode) {
      case "desk":
        if (this.talk) {
          this.talkStep(this.talk, dt);
          break;
        }
        if (this.call) {
          this.callStep(this.call, dt);
          break;
        }
        this.callIn -= dt;
        if (this.callIn <= 0) {
          this.callIn = this.callEvery * (0.75 + this.rand() * 0.5);
          this.startCall();
          break;
        }
        this.outingIn -= dt;
        if (this.outingIn <= 0) {
          this.outingIn = this.outingEvery * (0.75 + this.rand() * 0.5);
          if (this.goAsk()) break;
        }
        this.mutterT -= dt;
        if (this.mutterT <= 0) {
          this.mutterT = 12 + this.rand() * 14;
          this.effects.puff(w.x - 10, w.y + 2);
          if (this.rand() < 0.5) w.say(this.pick(MUTTER), C.plum, 2.2);
        }
        break;
      case "out":
        if (!w.walking) {
          const id = this.target;
          const talk = this.outing ?? cfoOuting(this.rand);
          w.facing = "up";
          w.pose = "raiseHand";
          w.say(talk.ask, C.plum, 2.2);
          if (id) this.effects.after(1.6, () => this.people.answer(id, talk.answer));
          this.effects.after(3.4, () => {
            w.pose = null;
            w.say(talk.thanks, C.plum, 1.8);
          });
          this.mode = "ask";
          this.mutterT = 5.2;
        }
        break;
      case "ask":
        // mutterT doubles as the linger timer while he is out
        this.mutterT -= dt;
        if (this.mutterT <= 0) this.goBack();
        break;
      case "back":
        if (!w.walking) this.sitDown();
        break;
    }
    w.update(dt, time, 36);
  }
}
