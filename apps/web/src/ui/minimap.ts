/** Corner minimap: the terrain downscaled once, plus agent-colored dots and the viewport. */
import { AGENT_COLORS } from "@agent-office/protocol";
import type { Camera } from "../camera.ts";
import type { CharacterManager } from "../world/characters.ts";

const SCALE = 1 / 6;

export class Minimap {
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private acc = 1;

  constructor(
    host: HTMLElement,
    private readonly camera: Camera,
    private readonly chars: CharacterManager,
  ) {
    this.ctx = this.canvas.getContext("2d")!;
    host.appendChild(this.canvas);
    host.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const r = this.canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * this.canvas.width;
      const y = ((e.clientY - r.top) / r.height) * this.canvas.height;
      this.camera.set({ x: x / SCALE, y: y / SCALE });
    });
  }

  setTerrain(terrain: HTMLCanvasElement) {
    const w = Math.round(terrain.width * SCALE);
    const h = Math.round(terrain.height * SCALE);
    const base = document.createElement("canvas");
    base.width = w;
    base.height = h;
    const bctx = base.getContext("2d")!;
    bctx.imageSmoothingEnabled = true;
    bctx.drawImage(terrain, 0, 0, w, h);
    this.base = base;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.acc = 1;
  }

  update(dt: number) {
    this.acc += dt;
    if (this.acc < 0.2 || !this.base) return;
    this.acc = 0;
    const ctx = this.ctx;
    ctx.drawImage(this.base, 0, 0);
    for (const c of this.chars.chars.values()) {
      if (!c.sprite.visible) continue;
      ctx.fillStyle = "#181425";
      ctx.fillRect(Math.round(c.x * SCALE) - 2, Math.round(c.y * SCALE) - 4, 4, 4);
      ctx.fillStyle = AGENT_COLORS[c.agent];
      ctx.fillRect(Math.round(c.x * SCALE) - 1, Math.round(c.y * SCALE) - 3, 2, 2);
    }
    const v = this.camera.viewRect();
    ctx.strokeStyle = "#fee761";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(v.x * SCALE) + 0.5,
      Math.round(v.y * SCALE) + 0.5,
      Math.round(v.w * SCALE),
      Math.round(v.h * SCALE),
    );
  }
}
