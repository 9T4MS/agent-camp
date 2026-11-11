/**
 * Camera: drag to pan, wheel / pinch to zoom (limits + easing), double-tap to focus,
 * and an auto-pilot (always on in kiosk, otherwise after 30 s without input) that
 * follows the latest event or slowly tours the areas.
 */
import type { Container } from "pixi.js";
import { type Area, type AreaName, TILE } from "./world/map.ts";

const IDLE_BEFORE_AUTO_MS = 30_000;
const TOUR_STOP_S = 12;
const FOLLOW_S = 9;
const MAX_ZOOM = 6;

type View = { x: number; y: number; zoom: number };

export type CameraOptions = {
  kiosk: boolean;
  /** disable auto-pilot until the user interacts (e.g. ?zoom=fit screenshots) */
  holdAuto?: boolean;
  /** HUD height at the top (px, or read live: it grows by the notch inset), kept clear when fitting */
  topInset?: number | (() => number);
};

export class Camera {
  x = 0;
  y = 0;
  zoom = 2;
  private target: View = { x: 0, y: 0, zoom: 2 };
  private lastInput = performance.now();
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number; t: number }>();
  private pinchDist = 0;
  private lastTap = { t: 0, x: 0, y: 0 };
  private tourIdx = 0;
  private tourT = 0;
  private followT = 0;
  private hold: boolean;
  /** last placed by zoomToFit (re-fit on resize) */
  private fitted = false;
  onTap: (wx: number, wy: number) => void = () => {};
  onDoubleTap: (wx: number, wy: number) => boolean = () => false;

  constructor(
    private readonly world: Container,
    private readonly screen: () => { width: number; height: number },
    private worldSize: () => { width: number; height: number },
    private areas: () => readonly Area[],
    private readonly opts: CameraOptions,
  ) {
    this.hold = !!opts.holdAuto;
    const w = worldSize();
    this.x = this.target.x = w.width / 2;
    this.y = this.target.y = w.height / 2;
  }

  /** while true the auto-pilot stays off (e.g. an agent card is open) */
  holdWhile: () => boolean = () => false;

  get auto() {
    if (this.hold || (!this.opts.kiosk && this.holdWhile())) return false;
    return this.opts.kiosk || performance.now() - this.lastInput > IDLE_BEFORE_AUTO_MS;
  }

  private inset() {
    const t = this.opts.topInset;
    return typeof t === "function" ? t() : (t ?? 0);
  }

  fitZoom() {
    const s = this.screen();
    const w = this.worldSize();
    const inset = this.inset();
    return Math.min(s.width / w.width, (s.height - inset) / w.height);
  }

  minZoom() {
    return Math.min(1, this.fitZoom() * 0.95);
  }

  private clampTarget() {
    const t = this.target;
    t.zoom = Math.min(MAX_ZOOM, Math.max(this.minZoom(), t.zoom));
    const s = this.screen();
    const w = this.worldSize();
    const inset = this.inset();
    // the HUD covers the top `inset` px: the usable view is centered below it
    const shiftY = inset / 2 / t.zoom;
    const halfW = s.width / 2 / t.zoom;
    const halfH = (s.height - inset) / 2 / t.zoom;
    const margin = 2 * TILE;
    const clampAxis = (v: number, half: number, size: number) =>
      half * 2 >= size + margin * 2
        ? size / 2
        : Math.min(size + margin - half, Math.max(half - margin, v));
    t.x = clampAxis(t.x, halfW, w.width);
    t.y = clampAxis(t.y + shiftY, halfH, w.height) - shiftY;
  }

  set(view: Partial<View>, instant = false) {
    this.fitted = false;
    Object.assign(this.target, view);
    this.clampTarget();
    if (instant) {
      this.x = this.target.x;
      this.y = this.target.y;
      this.zoom = this.target.zoom;
      this.apply();
    }
  }

  zoomToFit(instant = false) {
    const w = this.worldSize();
    const inset = this.inset();
    const z = this.fitZoom();
    this.set({ x: w.width / 2, y: w.height / 2 - inset / 2 / z, zoom: z }, instant);
    this.fitted = true;
  }

  focus(x: number, y: number, zoom?: number) {
    this.set({ x, y, zoom: zoom ?? Math.max(this.target.zoom, 3) });
  }

  focusArea(name: AreaName | "all", instant = false) {
    if (name === "all") return this.zoomToFit(instant);
    const a = this.areas().find((ar) => ar.name === name);
    if (!a) return;
    const s = this.screen();
    const fit = Math.min(s.width / (a.w * TILE + 64), s.height / (a.h * TILE + 64));
    const zoom = Math.max(2, Math.min(4, Math.floor(fit)));
    this.set({ x: (a.x + a.w / 2) * TILE, y: (a.y + a.h / 2) * TILE, zoom }, instant);
  }

  /**
   * Something happened at (x, y): the auto-pilot goes there for a while. `rush` pans there
   * quickly (e.g. a join, so the door + confetti are in view when they happen).
   */
  notify(x: number, y: number, opts: { zoom?: number; hold?: number; rush?: boolean } = {}) {
    if (!this.auto) return;
    this.followT = Math.max(this.followT, opts.hold ?? FOLLOW_S);
    if (opts.rush) this.rushT = 1.6;
    this.set({ x, y, zoom: opts.zoom ?? 3 });
  }
  private rushT = 0;

  screenToWorld(sx: number, sy: number) {
    const s = this.screen();
    return {
      x: (sx - s.width / 2) / this.zoom + this.x,
      y: (sy - s.height / 2) / this.zoom + this.y,
    };
  }

  private touch() {
    this.lastInput = performance.now();
    this.hold = false;
    this.followT = 0;
  }

  attach(el: HTMLElement) {
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        sx: e.clientX,
        sy: e.clientY,
        t: performance.now(),
      });
      if (this.pointers.size === 2) this.pinchDist = this.pinchDistance();
    });
    el.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 4) return;
      this.touch();
      if (this.pointers.size === 1) {
        this.target.x -= dx / this.zoom;
        this.target.y -= dy / this.zoom;
        this.x = this.target.x;
        this.y = this.target.y;
        this.clampTarget();
      } else if (this.pointers.size === 2) {
        const d = this.pinchDistance();
        if (this.pinchDist > 0) {
          const mid = this.midpoint();
          this.zoomAt(mid.x, mid.y, d / this.pinchDist, true);
          this.target.x -= dx / 2 / this.zoom;
          this.target.y -= dy / 2 / this.zoom;
          this.x = this.target.x;
          this.y = this.target.y;
        }
        this.pinchDist = d;
      }
    });
    const up = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDist = 0;
      if (!p) return;
      const moved = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
      if (moved < 6 && performance.now() - p.t < 400) {
        const rect = el.getBoundingClientRect();
        const w = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        const now = performance.now();
        if (
          now - this.lastTap.t < 320 &&
          Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 24
        ) {
          this.touch();
          if (!this.onDoubleTap(w.x, w.y))
            this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1.6);
          this.lastTap.t = 0;
        } else {
          this.lastTap = { t: now, x: e.clientX, y: e.clientY };
          this.onTap(w.x, w.y);
        }
      }
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.touch();
        const rect = el.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
        this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
      },
      { passive: false },
    );
  }

  private pinchDistance() {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
  private midpoint() {
    const [a, b] = [...this.pointers.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: 0, y: 0 };
  }

  /** Zoom around a screen point, keeping the world point under it fixed. */
  zoomAt(sx: number, sy: number, factor: number, instant = false) {
    const before = this.screenToWorldAt(sx, sy, this.target);
    this.target.zoom = Math.min(MAX_ZOOM, Math.max(this.minZoom(), this.target.zoom * factor));
    const after = this.screenToWorldAt(sx, sy, this.target);
    this.target.x += before.x - after.x;
    this.target.y += before.y - after.y;
    this.clampTarget();
    if (instant) {
      this.x = this.target.x;
      this.y = this.target.y;
      this.zoom = this.target.zoom;
    }
  }

  private screenToWorldAt(sx: number, sy: number, v: View) {
    const s = this.screen();
    return { x: (sx - s.width / 2) / v.zoom + v.x, y: (sy - s.height / 2) / v.zoom + v.y };
  }

  private tour(dt: number) {
    if (this.followT > 0) {
      this.followT -= dt;
      return;
    }
    this.tourT -= dt;
    if (this.tourT > 0) return;
    const stops: (AreaName | "all")[] = [
      "desks",
      "lounge",
      "desks",
      "meeting",
      "game",
      "desks",
      "garden",
      "all",
    ];
    let stop = stops[this.tourIdx++ % stops.length]!;
    // a portrait phone would show the whole office as a thin strip: stay on the desks
    const s = this.screen();
    if (stop === "all" && s.height > s.width * 1.15) stop = "desks";
    this.tourT = TOUR_STOP_S;
    if (stop === "desks") {
      // pan across the desk floor in thirds
      const a = this.areas().find((ar) => ar.name === "desks");
      if (a) {
        const third = this.tourIdx % 3;
        this.set({ x: (a.x + 6 + third * 10) * TILE, y: (a.y + a.h / 2) * TILE, zoom: 2.5 });
        return;
      }
    }
    this.focusArea(stop);
  }

  update(dt: number) {
    if (this.auto) this.tour(dt);
    if (this.rushT > 0) this.rushT -= dt;
    const k = 1 - Math.exp(-dt * (!this.auto ? 9 : this.rushT > 0 ? 3.2 : 1.4));
    this.x += (this.target.x - this.x) * k;
    this.y += (this.target.y - this.y) * k;
    this.zoom += (this.target.zoom - this.zoom) * k;
    if (Math.abs(this.target.zoom - this.zoom) < 0.002) this.zoom = this.target.zoom;
    this.apply();
  }

  apply() {
    const s = this.screen();
    this.world.scale.set(this.zoom);
    this.world.position.set(
      Math.round(s.width / 2 - this.x * this.zoom),
      Math.round(s.height / 2 - this.y * this.zoom),
    );
  }

  /** Visible world rect (for the minimap). */
  viewRect() {
    const s = this.screen();
    return {
      x: this.x - s.width / 2 / this.zoom,
      y: this.y - s.height / 2 / this.zoom,
      w: s.width / this.zoom,
      h: s.height / this.zoom,
    };
  }

  /** The world grew (more pod rows): keep a fitted view fitted. */
  worldChanged() {
    if (this.fitted) this.zoomToFit();
    else this.clampTarget();
  }

  resized() {
    if (this.fitted) this.zoomToFit(true);
    else this.clampTarget();
  }
}
