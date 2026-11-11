import { describe, expect, test } from "bun:test";
import type { Container } from "pixi.js";
import { Camera } from "../src/camera.ts";
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
