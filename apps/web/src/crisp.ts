/**
 * At in-between zooms nearest scaling draws some art pixels 1 device px wide and others 2, which
 * mangles the 3x5 font: render at the next whole scale instead and filter it down smoothly.
 */
import { type Application, type Container, RenderTexture, Sprite } from "pixi.js";

const WHOLE_EPS = 0.02;

/** How much larger than the screen the offscreen render is, or 1 when no detour is needed. */
export function crispFactor(zoom: number, resolution: number): number {
  const d = zoom * resolution;
  if (Math.abs(d - Math.round(d)) < WHOLE_EPS) return 1;
  return Math.ceil(d) / d;
}

export class CrispView {
  private readonly rt: RenderTexture;
  private readonly display: Sprite;
  private readonly enabled: boolean;

  constructor(
    private readonly app: Application,
    private readonly world: Container,
  ) {
    this.rt = RenderTexture.create({
      width: 1,
      height: 1,
      resolution: app.renderer.resolution,
      scaleMode: "linear",
      // without it the sprite keeps the quad size of the texture's first size after a resize
      dynamic: true,
    });
    this.enabled = !softwareGl(app);
    this.display = new Sprite(this.rt);
    this.display.visible = false;
    app.stage.addChild(this.display);
  }

  /** Call after the camera placed the world, before the frame is drawn. */
  update() {
    const world = this.world;
    const res = this.app.renderer.resolution;
    const f = this.enabled ? crispFactor(world.scale.x, res) : 1;
    if (f === 1) {
      world.visible = true;
      this.display.visible = false;
      return;
    }
    const screen = this.app.screen;
    const w = Math.ceil(screen.width * f);
    const h = Math.ceil(screen.height * f);
    if (this.rt.width !== w || this.rt.height !== h) this.rt.resize(w, h, res);
    const { x, y } = world.position;
    const scale = world.scale.x;
    world.scale.set(scale * f);
    world.position.set(Math.round(x * f * res) / res, Math.round(y * f * res) / res);
    world.visible = true;
    this.app.renderer.render({ container: world, target: this.rt, clear: true });
    world.scale.set(scale);
    world.position.set(x, y);
    world.visible = false;
    this.display.scale.set(1 / f);
    this.display.visible = true;
  }
}

/** Without a GPU (SwiftShader, llvmpipe) the extra pass costs about a third of the frame rate. */
function softwareGl(app: Application): boolean {
  const gl = (app.renderer as { gl?: WebGLRenderingContext }).gl;
  if (!gl) return false;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  return /swiftshader|llvmpipe|softpipe|software/i.test(name);
}
