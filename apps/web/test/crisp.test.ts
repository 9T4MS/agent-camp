import { describe, expect, test } from "bun:test";
import { type Application, Container, type Sprite } from "pixi.js";
import { CrispView, crispFactor } from "../src/crisp.ts";

function crispView(screen = { width: 800, height: 600 }, resolution = 2) {
  const stage = new Container();
  const world = new Container();
  stage.addChild(world);
  const app = { renderer: { resolution, render() {} }, stage, screen } as unknown as Application;
  const crisp = new CrispView(app, world);
  const display = stage.children.find((c) => c !== world) as Sprite;
  return { crisp, world, display, screen, resolution };
}

describe("crisp view", () => {
  test("the offscreen picture covers the screen exactly, also after the texture was resized", () => {
    const { crisp, world, display, screen, resolution } = crispView();
    for (const zoom of [2.3, 2.75, 3.3, 3.55, 3.9]) {
      expect(crispFactor(zoom, resolution)).toBeGreaterThan(1);
      world.scale.set(zoom);
      crisp.update();
      const b = display.getBounds();
      expect(display.visible).toBe(true);
      expect(Math.abs(b.width - screen.width)).toBeLessThan(1.5);
      expect(Math.abs(b.height - screen.height)).toBeLessThan(1.5);
    }
  });
});
