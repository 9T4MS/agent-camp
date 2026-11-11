/**
 * Living office: day/night tint from the office's local time (lamps glow at night),
 * whiteboard with today's numbers, game corner lights up above 10 agents.
 * Runs a few times a minute, never per frame.
 */
import { C } from "../art/palette.ts";
import type { OfficeModel } from "../state/officeModel.ts";
import type { OfficeScene } from "./office.ts";

export const GAME_LIGHTS_ABOVE = 10;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export type Daylight = {
  night: number;
  sky: "day" | "dusk" | "night";
  tint: string;
  alpha: number;
};

/** Lighting for a fractional local hour (0..24). */
export function daylight(hour: number): Daylight {
  const night = Math.max(smooth(17.5, 20.5, hour), 1 - smooth(5.5, 7.5, hour));
  const dusk = Math.max(
    Math.exp(-(((hour - 18.6) / 1.1) ** 2)),
    Math.exp(-(((hour - 6.4) / 0.9) ** 2)),
  );
  const sky = night > 0.65 ? "night" : dusk > 0.35 ? "dusk" : "day";
  const tint = night > 0.5 ? C.dusk : C.amber;
  const alpha = night > 0.5 ? 0.62 * night : 0.28 * dusk + 0.3 * night;
  return { night, sky, tint, alpha };
}

export function localHour(timezone: string | undefined, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(timezone ? { timeZone: timezone } : {}),
    }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? at.getHours());
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return h + m / 60;
  } catch {
    return at.getHours() + at.getMinutes() / 60;
  }
}

export class Living {
  private history: number[] = [];
  private lastSample = 0;
  private acc = 99;

  constructor(
    private readonly scene: OfficeScene,
    private readonly model: OfficeModel,
    private readonly hourOverride: number | null,
  ) {}

  /** Force a refresh soon (after model changes). */
  poke() {
    this.acc = 99;
  }

  update(dt: number) {
    this.acc += dt;
    if (this.acc < 2) return;
    this.acc = 0;
    const hour = this.hourOverride ?? localHour(this.model.timezone);
    const d = daylight(hour);
    this.scene.setDaylight(d.night, d.sky, d.tint, d.alpha);
    const st = this.model.stats();
    const now = Date.now();
    if (this.history.length === 0 || now - this.lastSample > 5 * 60_000) {
      this.history.push(st.sessions);
      this.history = this.history.slice(-8);
      this.lastSample = now;
    } else {
      this.history[this.history.length - 1] = Math.max(this.history.at(-1) ?? 0, st.sessions);
    }
    this.scene.updateWhiteboard(st.sessions, st.peakToday, st.startedToday, this.history);
    this.scene.gameLit = st.sessions > GAME_LIGHTS_ABOVE;
  }
}
