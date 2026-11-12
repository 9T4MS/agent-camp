import { describe, expect, test } from "bun:test";
import type { Container } from "pixi.js";
import { AMBIENT_QUIET_S, Camera } from "../src/camera.ts";
import { buildOfficeMap, OFFICE_COLS, TILE } from "../src/world/map.ts";

/** Just enough of a Pixi container for Camera.apply(). */
const fakeWorld = () => ({ scale: { set() {} }, position: { set() {} } }) as unknown as Container;

function camera(kiosk = true, screen = { width: 1920, height: 1080 }) {
  const map = buildOfficeMap();
  const cam = new Camera(
    fakeWorld(),
    () => screen,
    () => ({ width: map.width * TILE, height: map.height * TILE }),
    () => map.areas,
    kiosk ? { kiosk: true } : { kiosk: false, holdAuto: true },
  );
  return { cam, map };
}

describe("camera framing with the east street block", () => {
  test("the fit view frames the original office; the block joins only when asked", () => {
    const { cam, map } = camera(false);
    let east = false;
    cam.fitWidth = () => (east ? map.width * TILE : OFFICE_COLS * TILE);
    cam.zoomToFit(true);
    // 1920 px over 64 columns: 30 px tiles, as before the block was added
    expect(cam.zoom * TILE).toBeCloseTo(30, 5);
    expect(cam.x).toBe((OFFICE_COLS * TILE) / 2);
    // someone walks into the bar: the fitted view eases out to the whole map
    east = true;
    for (let i = 0; i < 400; i++) cam.update(1 / 30);
    expect(cam.zoom * TILE).toBeCloseTo(1920 / map.width, 1);
    expect(cam.x).toBeCloseTo((map.width * TILE) / 2, 0);
  });

  test("after panning / zooming by hand, the east block no longer snaps the view back", () => {
    const { cam, map } = camera(false);
    let east = false;
    cam.fitWidth = () => (east ? map.width * TILE : OFFICE_COLS * TILE);
    const handlers = new Map<string, (e: unknown) => void>();
    const el = {
      addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    } as unknown as HTMLElement;
    cam.attach(el);
    cam.zoomToFit(true);
    handlers.get("wheel")!({
      preventDefault() {},
      deltaY: -300,
      ctrlKey: false,
      clientX: 400,
      clientY: 300,
    });
    for (let i = 0; i < 60; i++) cam.update(1 / 30);
    const before = { x: cam.x, zoom: cam.zoom };
    east = true;
    for (let i = 0; i < 120; i++) cam.update(1 / 30);
    expect(cam.zoom).toBeCloseTo(before.zoom, 5);
    expect(cam.x).toBeCloseTo(before.x, 5);
  });

  test("zooming out by hand still reaches the whole map", () => {
    const { cam, map } = camera();
    cam.fitWidth = () => OFFICE_COLS * TILE;
    cam.set({ zoom: 0.01 }, true);
    expect(cam.zoom).toBeCloseTo(Math.min(1, (1920 / (map.width * TILE)) * 0.95), 5);
  });

  test("the tour skips closed places", () => {
    const { cam } = camera();
    const visited: string[] = [];
    const focusArea = cam.focusArea.bind(cam);
    cam.focusArea = (name, instant) => {
      visited.push(name);
      focusArea(name, instant);
    };
    cam.skipStop = (name) => name === "bar" || name === "shop";
    for (let i = 0; i < 30 * 12 * 24; i++) cam.update(1 / 30);
    expect(visited).toContain("garden");
    expect(visited).not.toContain("bar");
    expect(visited).not.toContain("shop");
    cam.skipStop = () => false;
    for (let i = 0; i < 30 * 12 * 24; i++) cam.update(1 / 30);
    expect(visited).toContain("bar");
    expect(visited).toContain("shop");
  });
});

describe("the tour keeps the agents in view", () => {
  test("every other stop is the desk floor, and desk stops visit the busy pods in turn", () => {
    const { cam } = camera();
    const busy = [
      { x: 100, y: 200 },
      { x: 300, y: 400 },
    ];
    cam.busyDesks = () => busy;
    let current = "";
    let inArea = false;
    const deskVisits: { x: number; y: number }[] = [];
    const focusArea = cam.focusArea.bind(cam);
    cam.focusArea = (name, instant) => {
      current = name;
      inArea = true;
      focusArea(name, instant);
      inArea = false;
    };
    const set = cam.set.bind(cam);
    cam.set = (view, instant) => {
      if (!inArea) {
        current = "desks";
        deskVisits.push({ x: view.x!, y: view.y! });
      }
      set(view, instant);
    };
    const frames = 30 * 60 * 10;
    let deskFrames = 0;
    for (let i = 0; i < frames; i++) {
      cam.update(1 / 30);
      if (current === "desks") deskFrames++;
    }
    expect(deskVisits.slice(0, 4)).toEqual([busy[0]!, busy[1]!, busy[0]!, busy[1]!]);
    expect(deskFrames / frames).toBeGreaterThan(0.55);
  });
});

describe("ambient camera notifies (the portal characters)", () => {
  const run = (cam: Camera, seconds: number) => {
    for (let t = 0; t < seconds; t += 0.5) cam.update(0.5);
  };
  // well inside the hold time, so the tour has not moved on yet
  const settle = (cam: Camera) => run(cam, 6);

  test("a portal never interrupts a look at a real agent event", () => {
    const { cam } = camera();
    expect(cam.notify(500, 300, { hold: 9 })).toBe(true);
    run(cam, 2);
    expect(cam.notify(900, 300, { hold: 8, ambient: true })).toBe(false);
    settle(cam);
    expect(cam.x).toBeCloseTo(500, -1);
  });

  test("a portal waits a while after a real event, then may take a look", () => {
    const { cam } = camera();
    cam.notify(100, 100, { hold: 2 });
    run(cam, 5);
    expect(cam.notify(900, 300, { ambient: true })).toBe(false);
    run(cam, AMBIENT_QUIET_S);
    expect(cam.notify(900, 300, { hold: 8, ambient: true })).toBe(true);
  });

  test("a real event takes the camera straight from a portal look", () => {
    const { cam } = camera();
    expect(cam.notify(900, 300, { hold: 8, ambient: true })).toBe(true);
    run(cam, 1);
    expect(cam.notify(500, 250, { hold: 9 })).toBe(true);
    settle(cam);
    expect(cam.x).toBeCloseTo(500, -1);
    // and it holds the real event for its own time, not the portal's leftover
    expect(cam.notify(900, 300, { ambient: true })).toBe(false);
  });
});
