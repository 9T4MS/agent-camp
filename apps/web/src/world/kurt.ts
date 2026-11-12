/**
 * Kurt: sits behind his desk in his own office next to the game corner, buried in paper. Now
 * and then a dev walks in and asks for the Klima ticket or a contract; it is always hard, he
 * is doing this and that, and it will take time. And every so often he comes out of his
 * office, walks up to someone at their desk and asks where the wifi is.
 */
import { seededRandom } from "@agent-office/protocol";
import type { Container } from "pixi.js";
import { C } from "../art/palette.ts";
import { kurtSheet } from "../art/residents.ts";
import type { Effects } from "./effects.ts";
import { KURT_DESK, type OfficeMap, type Point, TILE } from "./map.ts";
import { type KurtLine, kurtTalk, kurtWifi } from "./residentRules.ts";
import { Walker } from "./walker.ts";

const MUTTER = ["THIS AND THAT...", "SO MUCH TO DO.", "WHERE WAS I?", "ONE THING AFTER ANOTHER."];
const CLICKED = ["VERY BUSY.", "THIS AND THAT.", "TAKES TIME.", "LATER, LATER."];
/** a visitor at his desk while he is out looking for the wifi */
const EMPTY_DESK = ["KURT?", "HE'S OUT AGAIN.", "WIFI HUNT AGAIN?"];
/** seconds between two lines of a visit */
const SAY_GAP = 1.5;

/** What Kurt needs from the session characters (CharacterManager). */
export type KurtPeople = {
  /** a visitor standing at his desk says something */
  visitorSays(sessionId: string, text: string): void;
  /** seated people he can ask about the wifi */
  seated(): (Point & { id: string })[];
  /** a seated person answers from their chair */
  answer(sessionId: string, text: string): void;
};

type Talk = { id: string; lines: KurtLine[]; t: number };

export class Kurt {
  readonly walker: Walker;
  private mode: "desk" | "out" | "ask" | "back" = "desk";
  private rand = seededRandom("kurt");
  private talk: Talk | null = null;
  private mutterT = 10;
  private talkCooldown = 0;
  /** seconds between two wifi hunts (shorter in the party demo) */
  wifiEvery = 60;
  /** seconds until the next wifi hunt */
  wifiIn = 25;
  private target: string | null = null;

  constructor(
    objects: Container,
    map: OfficeMap,
    private readonly effects: Effects,
    private readonly people: KurtPeople,
  ) {
    this.walker = new Walker(objects, kurtSheet(), map, effects, this.seat());
    this.walker.pose = "sitFront";
  }

  /** Behind his desk, facing the door. */
  private seat(): Point {
    return { x: (KURT_DESK.x + 1) * TILE, y: KURT_DESK.y * TILE - 3 };
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
  /** out of his office, looking for the wifi */
  get out() {
    return this.mode !== "desk";
  }

  poke() {
    if (this.talkCooldown > 0) return;
    this.talkCooldown = 1.5;
    this.walker.say(this.out ? "WHERE IS THE WIFI?!" : this.pick(CLICKED), C.plum);
  }

  /** A dev arrived at his desk and asks for something (or finds it empty). */
  asked(sessionId: string) {
    if (this.out) {
      const id = sessionId;
      this.effects.after(0.6, () => this.people.visitorSays(id, this.pick(EMPTY_DESK)));
      return;
    }
    this.talk = { id: sessionId, lines: kurtTalk(this.rand).lines, t: 0.4 };
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
    // "this and that": hands up, papers fly
    this.walker.pose = /THIS|THAT/.test(line.text) ? "raiseHand" : "sitFront";
    if (this.walker.pose === "raiseHand") this.effects.puff(this.walker.x - 10, this.walker.y + 2);
  }

  /** Off to someone at their desk to ask about the wifi. */
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
        this.mode = "out";
        this.walker.say("WIFI IS DOWN!", C.plum, 1.6);
        return true;
      }
    }
    return false;
  }

  private goBack() {
    this.target = null;
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
        this.wifiIn -= dt;
        if (this.wifiIn <= 0) {
          this.wifiIn = this.wifiEvery * (0.75 + this.rand() * 0.5);
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
          const talk = kurtWifi(this.rand);
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
