/**
 * Screenshots for the PR / README, taken against the REAL server (Bun harness, in-memory DB)
 * fed by the REAL simulator over the connector protocol. No demo feeds.
 *
 *   bun run screenshots                 # everything -> screenshots/
 *   bun run screenshots -- --only busy  # scenes whose name contains "busy"
 *   bun run screenshots -- --no-build   # reuse apps/web/dist
 *   bun run screenshots -- --no-gif
 *
 * Each scene gets a fresh server so nobody lingers in the 60 s leave grace between scenes.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { generateWeek, postBackfill, runScenario, type SimHandle } from "@agent-office/sim";
import type { Browser, BrowserContext, Page } from "playwright";
import { encodeGif, type RgbaFrame } from "./gif.ts";
import { terminalHtml } from "./terminal.ts";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");

const ROOT = resolve(import.meta.dir, "..", "..");
const OUT = join(ROOT, "screenshots");
const PASSWORD = "screenshots-pass";
const TIMEZONE = "Europe/Vienna";
const VIEWPORTS = {
  laptop: { width: 1440, height: 900 },
  ipad: { width: 1180, height: 820 },
} as const;
type Viewport = keyof typeof VIEWPORTS;

const argv = process.argv.slice(2);
const ONLY = argv.includes("--only") ? (argv[argv.indexOf("--only") + 1] ?? "") : "";
const BUILD = !argv.includes("--no-build");
const GIF = !argv.includes("--no-gif");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`[shots] ${s}`);

// ---- server ---------------------------------------------------------------------------------

type Server = { http: string; ws: string; stop(): void };
const servers = new Set<Bun.Subprocess>();

async function startServer(): Promise<Server> {
  const proc = Bun.spawn(["bun", "run", join(ROOT, "apps/server/src/dev/bun-server.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "0",
      DB: ":memory:",
      CONNECTOR_PASSWORD: PASSWORD,
      OFFICE_TIMEZONE: TIMEZONE,
      GENUI_PROVIDER: "off",
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  servers.add(proc);
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    const m = /on http:\/\/localhost:(\d+)/.exec(buf);
    if (m) {
      // keep draining stdout so the child never blocks on a full pipe
      void (async () => {
        while (!(await reader.read()).done) {}
      })().catch(() => {});
      const port = Number(m[1]);
      return {
        http: `http://localhost:${port}`,
        ws: `ws://localhost:${port}`,
        stop: () => {
          proc.kill();
          servers.delete(proc);
        },
      };
    }
  }
  proc.kill();
  throw new Error(`server did not start: ${buf}`);
}

/** Server + simulator scenario, settled (the server's /api/state matches the sim). */
async function office(
  scenario: "empty" | "one" | "busy" | "join",
): Promise<Server & { sim: SimHandle }> {
  const srv = await startServer();
  const sim = runScenario({ scenario, server: srv.ws, password: PASSWORD, log: false });
  await Promise.race([
    sim.settled,
    sleep(20_000).then(() => {
      throw new Error(`${scenario}: sim did not settle`);
    }),
  ]);
  return {
    ...srv,
    sim,
    stop: () => {
      void sim.stop().catch(() => {});
      srv.stop();
    },
  };
}

// ---- browser helpers --------------------------------------------------------------------------

let browser: Browser;
const contexts: Partial<Record<Viewport, BrowserContext>> = {};

async function context(vp: Viewport): Promise<BrowserContext> {
  contexts[vp] ??= await browser.newContext({
    viewport: VIEWPORTS[vp],
    deviceScaleFactor: 1,
    timezoneId: TIMEZONE,
    locale: "en-GB",
    extraHTTPHeaders: { authorization: `Bearer ${PASSWORD}` },
  });
  return contexts[vp];
}

async function openPage(vp: Viewport, url: string): Promise<Page> {
  const page = await (await context(vp)).newPage();
  page.on("pageerror", (e) => log(`  page error (${vp}): ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") log(`  console error (${vp}): ${m.text()}`);
  });
  await page.goto(url);
  return page;
}

/** Open the office and wait until the renderer is up and the model shows the scenario. */
async function openOffice(
  vp: Viewport,
  url: string,
  people: number,
  sessions: number,
  settleMs = 2500,
): Promise<Page> {
  const page = await openPage(vp, url);
  await page.waitForFunction(() => window.__office?.ready === true, null, { timeout: 30_000 });
  await page.waitForFunction(
    ([p, s]) =>
      window.__office.model.people.size === p && window.__office.model.sessions.size === s,
    [people, sessions] as const,
    { timeout: 20_000 },
  );
  await sleep(settleMs);
  return page;
}

const shots: string[] = [];
async function shoot(page: Page, name: string, opts: { fullPage?: boolean } = {}) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  shots.push(file);
  let fps = "";
  try {
    const v = await page.evaluate(() => window.__office?.fps?.());
    if (typeof v === "number") fps = ` (${v} fps)`;
  } catch {}
  log(`  ${name}.png${fps}`);
}

const want = (name: string) => !ONLY || name.includes(ONLY);

// ---- scenes -----------------------------------------------------------------------------------

const BUSY = { people: 6, sessions: 11 };
const GIF_FRAMES = 48;

async function sceneSimple(
  name: string,
  scenario: "empty" | "one" | "busy",
  query: string,
  counts: { people: number; sessions: number },
  settleMs = 2500,
  focus?: { person: string; zoom: number },
) {
  if (!want(name)) return;
  log(name);
  const o = await office(scenario);
  try {
    for (const vp of Object.keys(VIEWPORTS) as Viewport[]) {
      const page = await openOffice(
        vp,
        `${o.http}/?${query}`,
        counts.people,
        counts.sessions,
        settleMs,
      );
      if (focus) {
        // ?focus= only works when the person is known at boot (demo feeds); do it once the
        // live snapshot is in
        await page.evaluate(([p, z]) => window.__office.camera.focusPerson(p, z), [
          focus.person,
          focus.zoom,
        ] as const);
        await sleep(800);
      }
      await shoot(page, `${name}-${vp}`);
      await page.close();
    }
  } finally {
    o.stop();
  }
}

/** Busy office, then the `join` scenario walks a 7th person in; shot ~1.2 s after the join. */
async function sceneJoined() {
  const name = "04-person-joined";
  if (!want(name)) return;
  log(name);
  for (const vp of Object.keys(VIEWPORTS) as Viewport[]) {
    const o = await office("join");
    try {
      const page = await openOffice(vp, `${o.http}/?zoom=3&hour=11`, 6, BUSY.sessions, 600);
      // pan so the main door (bottom wall, x 16..17) is in view: drag the floor up and right
      const { width, height } = VIEWPORTS[vp];
      await page.mouse.move(width / 2, height / 2 + 150);
      await page.mouse.down();
      await page.mouse.move(width / 2 + 300, height / 2 - 150, { steps: 12 });
      await page.mouse.up();
      // the walk-in starts (confetti + "X joined" banner) shortly after the joiner's first session
      await page.waitForFunction(
        () =>
          window.__office.model.people.size >= 7 &&
          /joined/i.test(document.querySelector(".hud-banner.show")?.textContent ?? ""),
        null,
        { timeout: 25_000 },
      );
      await sleep(1200);
      await shoot(page, `${name}-${vp}`);
      await page.close();
    } finally {
      o.stop();
    }
  }
}

/** Click around the focused person until the HUD side panel opens. */
async function sceneSidePanel() {
  const name = "09-side-panel";
  if (!want(name)) return;
  log(name);
  const o = await office("busy");
  try {
    for (const vp of Object.keys(VIEWPORTS) as Viewport[]) {
      const page = await openOffice(vp, `${o.http}/?hour=15`, BUSY.people, BUSY.sessions, 1500);
      await page.evaluate(() => window.__office.camera.focusPerson("martin", 4));
      await sleep(800);
      const { width, height } = VIEWPORTS[vp];
      const points: [number, number][] = [];
      for (let dy = -260; dy <= 260; dy += 26)
        for (let dx = -420; dx <= 420; dx += 26) points.push([width / 2 + dx, height / 2 + dy]);
      points.sort(
        (a, b) =>
          Math.hypot(a[0] - width / 2, a[1] - height / 2) -
          Math.hypot(b[0] - width / 2, b[1] - height / 2),
      );
      let opened = false;
      for (const [x, y] of points) {
        await page.mouse.click(x, y);
        opened = await page.evaluate(() => !!document.querySelector(".hud-panel.show"));
        if (opened) break;
        await sleep(30);
      }
      if (!opened) log("  side panel did not open (no character hit)");
      // a character opens its agent card; its person chip opens the person panel
      if (await page.evaluate(() => !!document.querySelector(".hud-panel.card"))) {
        await page.click(".hud-panel .who");
      }
      await sleep(700);
      await shoot(page, `${name}-${vp}`);
      await page.close();
    }
  } finally {
    o.stop();
  }
}

/**
 * Agent card of Martin's busiest session. The busy scenario holds still, so the card's
 * 30-min activity strip is filled by replaying a plausible half hour client-side under
 * Playwright's fake clock (inject activity change, jump the clock, repeat).
 */
async function sceneAgentCard() {
  const name = "11-agent-card";
  if (!want(name)) return;
  log(name);
  const o = await office("busy");
  try {
    for (const vp of Object.keys(VIEWPORTS) as Viewport[]) {
      const page = await (await context(vp)).newPage();
      page.on("pageerror", (e) => log(`  page error (${vp}): ${e.message}`));
      await page.clock.install();
      await page.goto(`${o.http}/?hour=15`);
      await page.waitForFunction(() => window.__office?.ready === true, null, { timeout: 30_000 });
      await page.waitForFunction(
        ([p, n]) =>
          window.__office.model.people.size === p && window.__office.model.sessions.size === n,
        [BUSY.people, BUSY.sessions] as const,
        { timeout: 20_000 },
      );
      await sleep(1500);
      const target = await page.evaluate(() => {
        const all = [...window.__office.model.sessions.values()] as {
          sessionId: string;
          personId: string;
          subagents: number;
          activity: string;
        }[];
        const mine = all.filter((x) => x.personId === "martin");
        mine.sort((a, b) => b.subagents - a.subagents);
        return mine[0] ?? null;
      });
      if (!target) throw new Error("no session of martin");
      const plan: [string, string][] = [
        ["thinking", "03:00"],
        ["reading", "05:00"],
        ["typing", "08:00"],
        ["waiting", "02:00"],
        ["thinking", "01:00"],
        ["typing", "06:00"],
        [target.activity, "04:10"],
      ];
      let previous = target.activity;
      for (const [activity, wait] of plan) {
        if (activity !== previous) {
          await page.evaluate(
            ([sessionId, act, prev]) =>
              window.__office.injectEvent({
                v: 1,
                type: "session.activityChanged",
                id: `shot-${Math.random().toString(36).slice(2)}`,
                ts: Date.now(),
                data: { personId: "martin", sessionId, activity: act, previous: prev },
              }),
            [target.sessionId, activity, previous] as const,
          );
          previous = activity;
        }
        await page.clock.fastForward(wait);
      }
      await page.evaluate((id) => window.__office.openSession(id), target.sessionId);
      await sleep(2200);
      await shoot(page, `${name}-${vp}`);
      await page.close();
    }
  } finally {
    o.stop();
  }
}

type SessionInfo = {
  sessionId: string;
  personId: string;
  agent: string;
  project?: string;
  activity: string;
  subagents: number;
  startedAt: number;
  machine?: string;
};

/** Inject a viewer event client-side (the busy scenario holds still on purpose). */
async function inject(page: Page, type: string, data: Record<string, unknown>) {
  await page.evaluate(
    ([t, d]) =>
      window.__office.injectEvent({
        v: 1,
        type: t,
        id: `shot-${Math.random().toString(36).slice(2)}`,
        ts: Date.now(),
        data: d,
      }),
    [type, data] as const,
  );
}

async function sessionsOf(page: Page): Promise<SessionInfo[]> {
  return (await page.evaluate(() => [
    ...window.__office.model.sessions.values(),
  ])) as unknown as SessionInfo[];
}

/** Make the office lively: a few people go idle (coffee, chats, games), helpers burst to 11. */
async function livenUp(page: Page) {
  const all = await sessionsOf(page);
  const byPerson = new Map<string, SessionInfo[]>();
  for (const x of all) byPerson.set(x.personId, [...(byPerson.get(x.personId) ?? []), x]);
  // one session of every person but Martin and the waiting one takes a break
  for (const [personId, list] of byPerson) {
    if (personId === "martin") continue;
    const x = list.find((y) => y.activity !== "waiting" && y.activity !== "idle");
    if (!x || list.some((y) => y.activity === "waiting")) continue;
    await inject(page, "session.activityChanged", {
      personId,
      sessionId: x.sessionId,
      activity: "idle",
      previous: x.activity,
    });
  }
  const m = all.filter((x) => x.personId === "martin").sort((a, b) => b.subagents - a.subagents)[0];
  if (m) {
    for (let n = m.subagents + 1; n <= 11; n++) {
      await inject(page, "subagent.spawned", {
        personId: "martin",
        sessionId: m.sessionId,
        count: n,
      });
    }
  }
}

/**
 * 12: office life at lunch time (`?lively=1` = party speed): idle people grab coffee, chat,
 * play, the pizza drone delivers, Martin's 11 helpers throw a party in the game corner.
 */
async function sceneOfficeLife() {
  const name = "12-office-life";
  if (!want(name)) return;
  log(name);
  const o = await office("busy");
  try {
    const page = await openOffice(
      "laptop",
      `${o.http}/?hour=12.4&lively=1&weather=clouds`,
      BUSY.people,
      BUSY.sessions,
      800,
    );
    await livenUp(page);
    await page.evaluate(() => window.__office.camera.focusArea("all"));
    await sleep(14_000);
    await page.evaluate(() => window.__office.setSpeed(0));
    await shoot(page, `${name}-laptop`);
    await page.close();
  } finally {
    o.stop();
  }
}

/** 13: a `/clear` (end + restart a second later): the old character gets zapped. */
async function sceneCleared() {
  const name = "13-cleared-session";
  if (!want(name)) return;
  log(name);
  const o = await office("busy");
  try {
    const page = await openOffice(
      "laptop",
      `${o.http}/?hour=15&zoom=3`,
      BUSY.people,
      BUSY.sessions,
      1500,
    );
    const all = await sessionsOf(page);
    const felix = all.filter((x) => x.personId === "felix" && x.activity !== "idle");
    const x = felix.sort((a, b) => a.startedAt - b.startedAt)[0] ?? all[0];
    if (!x) throw new Error("no session to clear");
    await page.evaluate((p) => window.__office.camera.focusPerson(p, 4), x.personId);
    await sleep(600);
    await inject(page, "session.ended", { personId: x.personId, sessionId: x.sessionId });
    await sleep(900);
    await inject(page, "session.started", {
      personId: x.personId,
      session: {
        sessionId: `${x.sessionId.split(":")[0]}:cleared${Date.now().toString(36)}`,
        agent: x.agent,
        project: x.project,
        activity: "thinking",
        subagents: 0,
        startedAt: Date.now(),
        ...(x.machine ? { machine: x.machine } : {}),
      },
    });
    // freeze the world clock mid-zap (screenshots take a while under SwiftShader)
    await sleep(250);
    await page.evaluate(() => window.__office.setSpeed(0));
    await shoot(page, `${name}-laptop`);
    await page.close();
  } finally {
    o.stop();
  }
}

async function sceneStats() {
  const name = "07-stats";
  if (!want(name)) return;
  log(name);
  const srv = await startServer();
  try {
    const rows = generateWeek({ seed: 42, people: 8, timezone: TIMEZONE });
    const n = await postBackfill(srv.http, PASSWORD, rows);
    log(`  backfilled ${n} history rows`);
    for (const vp of Object.keys(VIEWPORTS) as Viewport[]) {
      const page = await openPage(vp, `${srv.http}/stats?days=7`);
      await page.waitForSelector("body[data-ready='1']", { timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      await sleep(300);
      await shoot(page, `${name}-${vp}`);
      await page.close();
    }
  } finally {
    srv.stop();
  }
}

/** Real frames: the office's own recorder capture (snapshotPng) at a few hours of a day. */
async function sceneTimelapse() {
  const name = "08-timelapse";
  if (!want(name)) return;
  log(name);
  const o = await office("join");
  try {
    // yesterday, office-local hours (Vienna is UTC+1 in winter, UTC+2 in summer)
    const y = new Date(Date.now() - 86_400_000);
    const midnight = Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate());
    const offsetH = vpOffsetHours(new Date(midnight + 12 * 3_600_000));
    const hours = [8, 9, 11, 13, 15, 17, 19, 21];
    for (const [i, h] of hours.entries()) {
      const page = await openPage("laptop", `${o.http}/?hour=${h}&nohud=1`);
      await page.waitForFunction(() => window.__office?.ready === true, null, { timeout: 30_000 });
      await page.waitForFunction(() => window.__office.model.people.size >= 6, null, {
        timeout: 20_000,
      });
      await sleep(1500);
      const dataUrl = await page.evaluate(() => window.__office.snapshotPng());
      await page.close();
      if (!dataUrl) throw new Error("snapshotPng returned null");
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      const ts = midnight + (h - offsetH) * 3_600_000 + i * 7 * 60_000;
      const res = await fetch(`${o.http}/api/snapshots?ts=${ts}`, {
        method: "POST",
        headers: { authorization: `Bearer ${PASSWORD}`, "content-type": "image/png" },
        body: png,
      });
      if (!res.ok) throw new Error(`snapshot upload: ${res.status} ${await res.text()}`);
    }
    log(`  uploaded ${hours.length} real frames`);
    for (const vp of Object.keys(VIEWPORTS) as Viewport[]) {
      const page = await openPage(vp, `${o.http}/timelapse`);
      await page.waitForSelector("body[data-ready='1']", { timeout: 15_000 });
      await page.waitForFunction(() =>
        [...document.images].every((img) => img.complete && img.naturalWidth > 0),
      );
      // step to a mid-day frame so the big player shows daylight
      await page.locator(".thumb").nth(3).click();
      await sleep(500);
      await shoot(page, `${name}-${vp}`);
      await page.close();
    }
  } finally {
    o.stop();
  }
}

/** Hours `TIMEZONE` is ahead of UTC at `d`. */
function vpOffsetHours(d: Date): number {
  const local = new Date(d.toLocaleString("en-US", { timeZone: TIMEZONE }));
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((local.getTime() - utc.getTime()) / 3_600_000);
}

async function sceneTerminal() {
  const name = "10-terminal-install";
  if (!want(name)) return;
  log(name);
  const text = readFileSync(join(OUT, "terminal-install.txt"), "utf8");
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  await page.setContent(terminalHtml(text));
  await shoot(page, name, { fullPage: true });
  await ctx.close();
}

/** ~2.5 s loop of the busy office at half size (pixel-exact 2x -> 1x downscale). */
async function busyGif() {
  const name = "03-busy";
  if (!GIF || !want("gif")) return;
  log("03-busy.gif");
  const o = await office("busy");
  try {
    // an explicit zoom holds the auto-pilot, so the camera stays put while we capture
    const page = await openOffice(
      "laptop",
      `${o.http}/?hour=12.4&zoom=2&lively=1`,
      BUSY.people,
      BUSY.sessions,
      800,
    );
    // people on the move: breaks, coffee, chats, a helper burst and the pizza drone
    await livenUp(page);
    await sleep(3500);
    const pngs: Buffer[] = [];
    // CDP screencast pushes frames as the compositor produces them (page.screenshot() takes
    // ~1.5 s per frame under SwiftShader), at full size (downscaled below, nearest neighbour)
    const cdp = await page.context().newCDPSession(page);
    const t0 = Date.now();
    await new Promise<void>((resolve) => {
      cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
        void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
        if (pngs.length < GIF_FRAMES) pngs.push(Buffer.from(f.data, "base64"));
        if (pngs.length === GIF_FRAMES) resolve();
      });
      void cdp.send("Page.startScreencast", {
        format: "png",
        maxWidth: 1440,
        maxHeight: 900,
        everyNthFrame: 1,
      });
    });
    await cdp.send("Page.stopScreencast").catch(() => {});
    const intervalMs = (Date.now() - t0) / pngs.length;
    await page.close();
    // decode + downscale in a blank page (canvas, nearest neighbour)
    const scratch = await (await context("laptop")).newPage();
    const frames: RgbaFrame[] = [];
    for (const png of pngs) {
      const b64 = await scratch.evaluate(
        async (src) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = Math.floor(img.width / 2);
          c.height = Math.floor(img.height / 2);
          const g = c.getContext("2d")!;
          g.imageSmoothingEnabled = false;
          g.drawImage(img, 0, 0, c.width, c.height);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let s = "";
          for (let i = 0; i < d.length; i += 0x8000)
            s += String.fromCharCode(...d.subarray(i, i + 0x8000));
          return `${c.width}x${c.height}:${btoa(s)}`;
        },
        `data:image/png;base64,${png.toString("base64")}`,
      );
      const [size, data] = b64.split(":") as [string, string];
      const [w, h] = size.split("x").map(Number) as [number, number];
      frames.push({ width: w, height: h, rgba: new Uint8Array(Buffer.from(data, "base64")) });
    }
    await scratch.close();
    // play back at capture speed (headless SwiftShader screenshots are not instant)
    const gif = encodeGif(frames, Math.max(6, Math.min(25, Math.round(intervalMs / 10))));
    const file = join(OUT, `${name}.gif`);
    writeFileSync(file, gif);
    shots.push(file);
    log(
      `  ${name}.gif (${frames.length} frames every ${Math.round(intervalMs)} ms, ${Math.round(gif.length / 1024)} KB)`,
    );
  } finally {
    o.stop();
  }
}

// ---- main -------------------------------------------------------------------------------------

function cleanup() {
  for (const p of servers) p.kill();
  servers.clear();
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function main() {
  mkdirSync(OUT, { recursive: true });
  if (BUILD) {
    log("building web (apps/web/dist, served by the Bun harness)");
    const b = Bun.spawnSync(["bun", "run", "--filter", "@agent-office/web", "build"], {
      cwd: ROOT,
      stdout: "ignore",
      stderr: "inherit",
    });
    if (b.exitCode !== 0) throw new Error("web build failed");
  }
  browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  try {
    await sceneSimple("01-empty", "empty", "hour=14", { people: 0, sessions: 0 });
    await sceneSimple("02-one-typing", "one", "hour=14&zoom=4", { people: 1, sessions: 1 }, 2500, {
      person: "anna",
      zoom: 4,
    });
    await sceneSimple("03-busy", "busy", "hour=15", BUSY, 3500);
    await busyGif();
    await sceneJoined();
    await sceneSimple("05-kiosk", "busy", "kiosk=1&hour=16", BUSY, 5000);
    await sceneSimple("06-zoomed-out", "busy", "zoom=fit&hour=13", BUSY, 3000);
    await sceneStats();
    await sceneTimelapse();
    await sceneSidePanel();
    await sceneAgentCard();
    await sceneOfficeLife();
    await sceneCleared();
    await sceneTerminal();
  } finally {
    await browser.close();
    cleanup();
  }
  if (!ONLY) rmSync(join(OUT, "dev"), { recursive: true, force: true });
  log(`done: ${shots.length} files in ${OUT}`);
}

declare global {
  interface Window {
    __office: {
      ready: boolean;
      fps(): number;
      model: { people: Map<string, unknown>; sessions: Map<string, unknown> };
      camera: {
        zoomToFit(): void;
        focusArea(name: string): void;
        focusPerson(personId: string, zoom?: number): boolean;
      };
      snapshotPng(): Promise<string | null>;
      injectEvent(msg: unknown): boolean;
      openSession(sessionId: string): boolean;
      setSpeed(k: number): void;
    };
  }
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
