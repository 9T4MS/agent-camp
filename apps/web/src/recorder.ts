/**
 * Timelapse recorder (?recorder=1, the iPad kiosk): every 15 min, if anyone is in the
 * office, render the whole map at ~480 px wide and POST the PNG to /api/snapshots.
 * Failures are ignored.
 */
import { type Application, RenderTexture } from "pixi.js";
import type { OfficeModel } from "./state/officeModel.ts";
import type { OfficeScene } from "./world/office.ts";

export const SNAPSHOT_WIDTH = 480;

export async function captureSnapshot(app: Application, scene: OfficeScene): Promise<Blob | null> {
  const scale = SNAPSHOT_WIDTH / scene.widthPx;
  const w = SNAPSHOT_WIDTH;
  const h = Math.round(scene.heightPx * scale);
  const rt = RenderTexture.create({ width: w, height: h, scaleMode: "nearest" });
  const root = scene.root;
  const saved = { sx: root.scale.x, sy: root.scale.y, x: root.x, y: root.y };
  try {
    root.scale.set(scale);
    root.position.set(0, 0);
    app.renderer.render({ container: root, target: rt, clear: true });
    const canvas = app.renderer.extract.canvas(rt) as HTMLCanvasElement;
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
  } catch {
    return null;
  } finally {
    root.scale.set(saved.sx, saved.sy);
    root.position.set(saved.x, saved.y);
    rt.destroy(true);
  }
}

export function startRecorder(
  app: Application,
  scene: OfficeScene,
  model: OfficeModel,
  opts: { everyMs: number; key?: string | null },
) {
  const tick = async () => {
    if (model.people.size === 0) return;
    const blob = await captureSnapshot(app, scene);
    if (!blob) return;
    const q = opts.key ? `?key=${encodeURIComponent(opts.key)}` : "";
    try {
      await fetch(`/api/snapshots${q}`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: blob,
      });
    } catch {
      // offline or no server: skip this frame
    }
  };
  const timer = setInterval(tick, opts.everyMs);
  return { stop: () => clearInterval(timer), tick };
}
