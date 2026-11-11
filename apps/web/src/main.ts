/**
 * Office renderer entry. URL params:
 *   ?demo=busy|one|empty|join (or 1)  local fake feed, no server; &seed=, &people=, &sessions=
 *   ?key=...      viewer key passed through to /ws/viewer
 *   ?kiosk=1      iPad kiosk (no cursor, big text, no panels, wake lock, 30 fps, auto-tour)
 *   ?recorder=1   upload a timelapse PNG every 15 min (&recordEvery=ms to override)
 *   ?nohud=1      hide all DOM overlays     ?zoom=fit|<n>  initial zoom
 *   ?hour=0..24   force the time of day     ?gallery=1     art gallery (dev)
 *   ?focus=<personId>  start focused on that person's desk pod
 */
import "./ui/theme.css";
import "./ui/office.css";
import { parseViewerMessage, type ServerToViewer } from "@agent-office/protocol";
import { Application, TextureStyle } from "pixi.js";
import { C } from "./art/palette.ts";
import { Camera } from "./camera.ts";
import { DemoFeed, parseDemoMode } from "./demo/demoFeed.ts";
import { Hud } from "./hud.ts";
import { keepAwake } from "./kiosk.ts";
import { connectViewer } from "./net/viewer.ts";
import { captureSnapshot, startRecorder } from "./recorder.ts";
import { OfficeModel } from "./state/officeModel.ts";
import { Minimap } from "./ui/minimap.ts";
import { OfficeCat } from "./world/cat.ts";
import { CharacterManager } from "./world/characters.ts";
import { Effects } from "./world/effects.ts";
import { Living } from "./world/living.ts";
import {
  type AreaName,
  BASE_POD_ROWS,
  buildOfficeMap,
  POD_COLS,
  podOrigin,
  podRowsFor,
} from "./world/map.ts";
import { OfficeScene } from "./world/office.ts";

type OfficeApi = {
  ready: boolean;
  fps(): number;
  /** average ms per frame spent in update / render over the last second */
  frameMs(): { update: number; render: number };
  model: OfficeModel;
  camera: {
    zoomToFit(): void;
    focusArea(name: AreaName | "all"): void;
    focusPerson(personId: string, zoom?: number): boolean;
  };
  injectEvent(msg: unknown): boolean;
  snapshotPng(): Promise<string | null>;
  characters(): number;
};
declare global {
  interface Window {
    __office: OfficeApi;
  }
}

const params = new URLSearchParams(location.search);
const flag = (k: string) => params.get(k) === "1" || params.get(k) === "true";
const kiosk = flag("kiosk");
const nohud = flag("nohud");
const recorder = flag("recorder");
const demo = parseDemoMode(params.get("demo"));
const zoomParam = params.get("zoom");
const hourParam = params.get("hour");
const key = params.get("key");

async function boot() {
  TextureStyle.defaultOptions.scaleMode = "nearest";
  const host = document.getElementById("app")!;
  if (kiosk) document.body.classList.add("kiosk");
  if (nohud) document.body.classList.add("nohud");

  const app = new Application();
  await app.init({
    resizeTo: host,
    background: C.night,
    antialias: false,
    roundPixels: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    preference: "webgl",
  });
  host.appendChild(app.canvas);
  if (kiosk) app.ticker.maxFPS = 30;

  if (params.has("gallery")) {
    const { showGallery } = await import("./dev/gallery.ts");
    showGallery(app);
    window.__office = { ready: true } as OfficeApi;
    return;
  }

  const model = new OfficeModel();
  const scene = new OfficeScene(buildOfficeMap(BASE_POD_ROWS));
  app.stage.addChild(scene.root);
  const effects = new Effects(scene.fx);
  const chars = new CharacterManager(scene, model, effects);
  const cat = new OfficeCat(scene.objects, scene.fx, scene.map, () => chars.idleSpots());
  const living = new Living(scene, model, hourParam !== null ? Number(hourParam) : null);
  const hud = new Hud(host, model, { kiosk });
  const topInset = nohud ? 0 : kiosk ? 46 : 36;
  const camera = new Camera(
    scene.root,
    () => app.screen,
    () => ({ width: scene.widthPx, height: scene.heightPx }),
    () => scene.map.areas,
    { kiosk, holdAuto: zoomParam !== null && !kiosk, topInset },
  );
  camera.attach(app.canvas);
  const minimap = new Minimap(hud.minimapHost, camera, chars);
  minimap.setTerrain(scene.terrainCanvas);

  // initial view
  if (zoomParam === "fit") camera.zoomToFit(true);
  else if (zoomParam && Number(zoomParam) > 0)
    camera.set({ x: 25 * 16, y: 15 * 16, zoom: Number(zoomParam) }, true);
  else if (app.screen.width / scene.widthPx > 1.6)
    camera.set({ x: 32 * 16, y: 15 * 16, zoom: 2 }, true);
  else camera.set({ x: 22 * 16, y: 14 * 16, zoom: 2 }, true);

  // ---- events -----------------------------------------------------------------------------
  const ensureCapacity = () => {
    const need = model.podCount();
    if (need <= scene.map.podRows * POD_COLS) return;
    scene.rebuild(buildOfficeMap(podRowsFor(need)));
    cat.setMap(scene.map);
    minimap.setTerrain(scene.terrainCanvas);
    for (const p of model.people.values())
      chars.handle({ kind: "avatarChanged", personId: p.personId });
  };

  let snapshotSeen = false;
  const ingest = (msg: ServerToViewer) => {
    const changes = model.apply(msg);
    ensureCapacity();
    for (const ch of changes) {
      chars.handle(ch);
      if (ch.kind === "officeRenamed") hud.setOfficeName(ch.name);
    }
    if (msg.type === "office.snapshot") snapshotSeen = true;
    hud.setStats(model.stats());
    living.poke();
  };

  chars.onMoment = (m) => {
    camera.notify(m.x, m.y);
    if (m.kind === "joined") hud.showBanner(`${m.name} joined`, "welcome to the office!");
  };

  camera.onTap = (wx, wy) => {
    const c = chars.pick(wx, wy);
    if (c) hud.openPanel(c.personId);
    else hud.closePanel();
  };
  camera.onDoubleTap = (wx, wy) => {
    const c = chars.pick(wx, wy);
    if (!c) return false;
    camera.focus(c.x, c.y - 12, 4);
    return true;
  };
  hud.portrait = (personId) => {
    const c = [...chars.chars.values()].find((ch) => ch.personId === personId);
    const frame = c?.sheet.frames[0];
    const src = frame?.source.resource as HTMLCanvasElement | undefined;
    if (!frame || !src) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 96;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, frame.frame.x, frame.frame.y, 16, 24, 0, 0, 64, 96);
    return canvas;
  };

  if (demo) {
    const feed = new DemoFeed(
      {
        mode: demo,
        seed: params.get("seed") ?? "1",
        ...(params.get("people") ? { people: Number(params.get("people")) } : {}),
        ...(params.get("sessions") ? { sessions: Number(params.get("sessions")) } : {}),
        ...(params.get("speed") ? { speed: Number(params.get("speed")) } : {}),
      },
      (msg) => {
        // round-trip through the real parser so demo data is schema-checked too
        const r = parseViewerMessage(JSON.stringify(msg));
        if (r.ok) ingest(r.msg);
        else console.error("[demo] invalid message", r.error, msg);
      },
    );
    feed.start();
  } else {
    connectViewer({ key, onMessage: ingest, onStatus: (s) => hud.setStatus(s) });
  }

  const focusPerson = (personId: string, zoom = 3) => {
    const p = model.people.get(personId);
    if (!p) return false;
    const o = podOrigin(p.pod);
    camera.set({ x: (o.x + 4) * 16, y: (o.y + 2) * 16, zoom }, true);
    return true;
  };
  const focusParam = params.get("focus");
  if (focusParam) focusPerson(focusParam, Number(zoomParam) || 3);

  if (kiosk) keepAwake();
  if (recorder) {
    startRecorder(app, scene, model, {
      everyMs: Number(params.get("recordEvery")) || 15 * 60_000,
      key,
    });
  }

  // ---- frame loop ---------------------------------------------------------------------------
  let time = 0;
  let frames = 0;
  let fpsWindowStart = performance.now();
  let fps = 0;
  let updMs = 0;
  let renMs = 0;
  let lastUpd = 0;
  let lastRen = 0;
  const renderer = app.renderer;
  const render = renderer.render.bind(renderer) as (...a: unknown[]) => void;
  (renderer as unknown as { render: (...a: unknown[]) => void }).render = (...a: unknown[]) => {
    const t0 = performance.now();
    render(...a);
    renMs += performance.now() - t0;
  };
  app.ticker.add((ticker) => {
    const t0 = performance.now();
    const dt = Math.min(0.1, ticker.deltaMS / 1000);
    time += dt;
    scene.update(time, dt);
    chars.update(dt, time);
    cat.update(dt, time);
    effects.update(dt);
    living.update(dt);
    camera.update(dt);
    if (!nohud && !kiosk) minimap.update(dt);
    frames++;
    const now = performance.now();
    updMs += now - t0;
    if (now - fpsWindowStart >= 1000) {
      fps = (frames * 1000) / (now - fpsWindowStart);
      lastUpd = updMs / frames;
      lastRen = renMs / frames;
      updMs = 0;
      renMs = 0;
      frames = 0;
      fpsWindowStart = now;
    }
  });
  window.addEventListener("resize", () => camera.resized());

  const api: OfficeApi = {
    ready: false,
    fps: () => Math.round(fps * 10) / 10,
    frameMs: () => ({
      update: Math.round(lastUpd * 100) / 100,
      render: Math.round(lastRen * 100) / 100,
    }),
    model,
    camera: {
      zoomToFit: () => camera.zoomToFit(true),
      focusArea: (name) => camera.focusArea(name, true),
      focusPerson: (personId, zoom) => focusPerson(personId, zoom),
    },
    injectEvent(raw) {
      const r = parseViewerMessage(typeof raw === "string" ? raw : JSON.stringify(raw));
      if (r.ok) ingest(r.msg);
      return r.ok;
    },
    snapshotPng: async () => {
      const blob = await captureSnapshot(app, scene);
      if (!blob) return null;
      return await new Promise<string>((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.readAsDataURL(blob);
      });
    },
    characters: () => chars.chars.size,
  };
  window.__office = api;
  await document.fonts?.ready;
  const markReady = () => {
    if (snapshotSeen || !demo) {
      requestAnimationFrame(() => {
        api.ready = true;
      });
    } else setTimeout(markReady, 50);
  };
  markReady();
}

void boot();
