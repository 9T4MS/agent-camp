/**
 * The head of sales, who is also the office cook: he works the stove in the kitchen (people
 * come by for a plate of Eierspeis while he is there), and whenever a client shows up he walks
 * out to the sales stand in the garden and haggles the price up.
 */
import { seededRandom } from "@agent-office/protocol";
import type { Container } from "pixi.js";
import { releaseSheet } from "../art/characters.ts";
import { C } from "../art/palette.ts";
import { clientSheet, salesSheet } from "../art/residents.ts";
import type { Effects } from "./effects.ts";
import { type OfficeMap, type Point, SALES_STAND, STOVE_SPOT, TILE } from "./map.ts";
import { haggle } from "./residentRules.ts";
import { Walker } from "./walker.ts";

const COOKING = ["EIERSPEIS!", "WHO'S HUNGRY?", "WITH CHIVES!", "ORDER UP!", "MORE BUTTER!"];
const SERVING = ["EIERSPEIS FOR YOU!", "MAHLZEIT!", "FRESH FROM THE PAN!", "EAT, EAT!"];
const CLICKED = ["WANNA BUY SOMETHING?", "HUNGRY?", "SPECIAL PRICE FOR YOU!", "EIERSPEIS?"];
const CLIENT_COLORS = 4;
const SAY_GAP = 1.7;

type Client = { w: Walker; look: number; leaving: boolean };

export class SalesChef {
  readonly walker: Walker;
  private mode: "cook" | "toStand" | "sell" | "toKitchen" = "cook";
  private rand = seededRandom("sales-chef");
  private client: Client | null = null;
  private script: { who: "seller" | "client"; text: string }[] = [];
  private deal = false;
  private sayT = 0;
  private chatterT = 6;
  private talkCooldown = 0;
  private looks = 0;
  /** seconds until the next client walks up */
  clientIn = 35;
  /** seconds between clients (shorter in the party demo) */
  clientEvery = 75;

  constructor(
    private readonly objects: Container,
    private map: OfficeMap,
    private readonly effects: Effects,
  ) {
    this.walker = new Walker(objects, salesSheet(), map, effects, this.stoveSpot());
    this.walker.facing = "up";
    this.walker.pose = "play";
  }

  private stoveSpot(): Point {
    return { x: STOVE_SPOT.x * TILE + 8, y: STOVE_SPOT.y * TILE + 13 };
  }
  private standSpot(): Point {
    return { x: (SALES_STAND.x + 1) * TILE, y: (SALES_STAND.y - 1) * TILE + 13 };
  }
  private clientSpot(): Point {
    return { x: (SALES_STAND.x + 1) * TILE, y: (SALES_STAND.y + 1) * TILE + 13 };
  }
  /** On the sidewalk below the garden. */
  private street(): Point {
    return { x: (SALES_STAND.x - 1) * TILE + 8, y: this.map.spawn.y * TILE + 13 };
  }

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.rand() * list.length)]!;
  }

  setMap(map: OfficeMap) {
    this.map = map;
    this.walker.map = map;
    if (this.client) this.client.w.map = map;
  }

  /** At the stove: the kitchen pass hands out plates. */
  get cooking() {
    return this.mode === "cook";
  }

  /** Someone picked up a plate at the pass. */
  served(x: number, y: number) {
    if (this.mode !== "cook") return;
    this.walker.say(this.pick(SERVING), C.wine);
    this.effects.sparkle(x, y - 20);
  }

  poke() {
    if (this.talkCooldown > 0) return;
    this.talkCooldown = 1.5;
    this.walker.say(this.pick(CLICKED), C.navy);
  }

  hit(wx: number, wy: number) {
    return this.walker.hit(wx, wy) || !!this.client?.w.hit(wx, wy);
  }
  get y() {
    return this.walker.y;
  }

  private callClient() {
    const look = this.looks++ % CLIENT_COLORS;
    const w = new Walker(this.objects, clientSheet(look), this.map, this.effects, this.street());
    if (!w.goTo(this.clientSpot()) || !this.walker.goTo(this.standSpot())) {
      releaseSheet(w.sheet);
      w.destroy();
      this.walker.path = [];
      this.clientIn = 20;
      return;
    }
    this.client = { w, look, leaving: false };
    const h = haggle(this.rand);
    this.script = h.lines;
    this.deal = h.deal;
    this.mode = "toStand";
    this.walker.say("A CLIENT!", C.navy);
  }

  private backToKitchen() {
    this.mode = this.walker.goTo(this.stoveSpot()) ? "toKitchen" : "cook";
    this.clientIn = this.clientEvery * (0.7 + this.rand() * 0.6);
  }

  private updateClient(dt: number, time: number) {
    const c = this.client;
    if (!c) return;
    c.w.update(dt, time, 34);
    if (c.leaving && !c.w.walking) {
      releaseSheet(c.w.sheet);
      c.w.destroy();
      this.client = null;
    }
  }

  update(dt: number, time: number) {
    this.talkCooldown -= dt;
    const w = this.walker;
    switch (this.mode) {
      case "cook": {
        w.facing = "up";
        w.pose = "play";
        this.chatterT -= dt;
        if (this.chatterT <= 0) {
          this.chatterT = 7 + this.rand() * 9;
          this.effects.puff(w.x + 2, w.y - 26);
          if (this.rand() < 0.45) w.say(this.pick(COOKING), C.wine);
        }
        this.clientIn -= dt;
        if (this.clientIn <= 0 && !this.client) this.callClient();
        break;
      }
      case "toStand": {
        const c = this.client;
        if (!c) {
          this.backToKitchen();
          break;
        }
        if (!w.walking) {
          w.facing = "down";
          w.pose = null;
        }
        if (!w.walking && !c.w.walking) {
          c.w.facing = "up";
          this.mode = "sell";
          this.sayT = 0.4;
        }
        break;
      }
      case "sell": {
        const c = this.client;
        if (!c) {
          this.backToKitchen();
          break;
        }
        this.sayT -= dt;
        if (this.sayT > 0) break;
        const line = this.script.shift();
        if (line) {
          const who = line.who === "seller" ? w : c.w;
          if (who === w) w.say(line.text, C.navy, SAY_GAP + 0.6);
          // the client stands right under the seller: his bubble goes beside him
          else who.say(line.text, C.ink, SAY_GAP + 0.6, true);
          who.pose = "wave";
          this.effects.after(0.8, () => {
            who.pose = null;
          });
          this.sayT = SAY_GAP;
          break;
        }
        if (this.deal) {
          this.effects.burst(w.x, w.y - 30, [C.lemon, C.amber, C.leaf], {
            count: 18,
            speed: 40,
            life: 0.9,
          });
          this.effects.sparkle(c.w.x, c.w.y - 20);
        }
        c.leaving = true;
        if (!c.w.goTo(this.street())) c.w.path = [];
        this.backToKitchen();
        break;
      }
      case "toKitchen":
        if (!w.walking) {
          this.mode = "cook";
          this.chatterT = 2;
        }
        break;
    }
    w.update(dt, time, 40);
    this.updateClient(dt, time);
  }
}
