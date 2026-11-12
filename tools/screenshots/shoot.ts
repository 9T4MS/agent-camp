/**
 * Screenshots for the PR / README, taken against the REAL server (Bun harness, in-memory DB)
 * fed by the REAL simulator over the connector protocol. No demo feeds.
 *
 *   bun run screenshots                 # everything -> screenshots/
 *   bun run screenshots -- --only busy  # scenes whose name contains "busy"
 *   bun run screenshots -- --no-build   # reuse apps/web/dist
 *   bun run screenshots -- --no-gif
 *   bun run screenshots -- --shard 2/4  # one of 4 balanced parts (CI runs them in parallel)
 *
 * Each scene gets a fresh server so nobody lingers in the 60 s leave grace between scenes.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { LOOK_FIXTURES } from "@agent-office/protocol/fixtures";
import { generateWeek, postBackfill, runScenario, type SimHandle } from "@agent-office/sim";
import type { Browser, BrowserContext, Page } from "playwright";
import { checkChatOverlay } from "./chat-smoke.ts";
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
/** `--shard 2/4`: only this part of the scenes (parallel CI jobs) */
const SHARD = (() => {
  const m = argv.includes("--shard")
    ? /^(\d+)\/(\d+)$/.exec(argv[argv.indexOf("--shard") + 1] ?? "")
    : null;
  if (!m) return null;
  const index = Number(m[1]);
  const of = Number(m[2]);
  if (index < 1 || index > of) throw new Error(`--shard ${index}/${of}: index out of range`);
  return { index, of };
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`[shots] ${s}`);
const pageErrors: string[] = [];
const trackPageErrors = (page: Page) =>
  page.on("pageerror", (error) => {
    const detail = error.stack ?? error.message;
    pageErrors.push(detail);
    log(`  page error: ${detail}`);
  });

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
    // every scene's server is a new origin, so each would keep its own service worker alive
    // for the rest of the run; shots never need the offline cache
    serviceWorkers: "block",
  });
  return contexts[vp];
}

async function openPage(vp: Viewport, url: string): Promise<Page> {
  const page = await (await context(vp)).newPage();
  trackPageErrors(page);
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
      trackPageErrors(page);
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

/**
 * 16: Friday after work in the east street block (`?feierabend=1`): happy hour in the bar,
 * beers at the standing tables, someone smoking in the corner by the weed shop.
 */
async function sceneBarAndShop() {
  const name = "16-bar-and-shop";
  if (!want(name)) return;
  log(name);
  const o = await office("busy");
  try {
    for (const vp of Object.keys(VIEWPORTS) as Viewport[]) {
      const page = await openOffice(
        vp,
        `${o.http}/?feierabend=1&weather=sun&zoom=1.7`,
        BUSY.people,
        BUSY.sessions,
        800,
      );
      await livenUp(page);
      await sleep(40_000);
      // frame both buildings: the bar on top, the shop and the smokers' corner below
      await page.evaluate(() => window.__office.camera.lookAt(68, 15.5, 1.7));
      await sleep(1000);
      await page.evaluate(() => window.__office.setSpeed(0));
      await shoot(page, `${name}-${vp}`);
      await page.close();
    }
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

/**
 * 14: a detailed look (the hand-authored `tracht` fixture, no AI) on Anna of the `one`
 * scenario, close up. Injected client-side as the server's avatar.updated would carry it;
 * she is set to waiting so she faces the camera.
 */
async function sceneDetailedLook() {
  const name = "14-detailed-look";
  if (!want(name)) return;
  log(name);
  const o = await office("one");
  try {
    for (const vp of Object.keys(VIEWPORTS) as Viewport[]) {
      const page = await openOffice(vp, `${o.http}/?hour=14`, 1, 1, 1500);
      const [x] = await sessionsOf(page);
      if (!x) throw new Error("no session in scenario one");
      await inject(page, "avatar.updated", { personId: x.personId, avatar: LOOK_FIXTURES.tracht });
      await inject(page, "session.activityChanged", {
        personId: x.personId,
        sessionId: x.sessionId,
        activity: "waiting",
        previous: x.activity,
      });
      await page.evaluate((p) => window.__office.camera.focusPerson(p, 6), x.personId);
      await sleep(1500);
      await shoot(page, `${name}-${vp}`);
      await page.close();
    }
  } finally {
    o.stop();
  }
}

/** 15: the dev look gallery (`?gallery=look`): hero frames of the tracht look + full sheets. */
async function sceneLookGallery() {
  const name = "15-look-gallery";
  if (!want(name)) return;
  log(name);
  const srv = await startServer();
  try {
    const page = await openPage("laptop", `${srv.http}/?gallery=look&look=tracht`);
    await page.waitForFunction(() => window.__galleryReady === true, null, { timeout: 30_000 });
    await sleep(500);
    await shoot(page, name, { fullPage: true });
    await page.close();
  } finally {
    srv.stop();
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

/** A deploy must not discard an unfocused/collapsed draft or a pending send. */
async function checkMessageReloadGuard(url: string) {
  const ctx = await browser.newContext({
    viewport: VIEWPORTS.laptop,
    serviceWorkers: "block",
    extraHTTPHeaders: { authorization: `Bearer ${PASSWORD}` },
  });
  try {
    await ctx.addInitScript(() => {
      if (localStorage.getItem("agent-office.messages.expanded") === null)
        localStorage.setItem("agent-office.messages.expanded", "false");
    });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__office?.ready);
    await page.locator(".messages-launch").click();
    const text = page.locator('textarea[aria-label="Office message"]');
    await text.fill("Keep this unfocused draft across a release");
    await text.press("Escape");
    await page.clock.install();
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    await page.route(url, async (route) => {
      if (route.request().isNavigationRequest()) return route.continue();
      await route.fulfill({
        contentType: "text/html",
        body: '<script type="module" src="/assets/new-release.js"></script>',
      });
    });
    await page.clock.fastForward(10 * 60_000);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.locator('[title="A new version is out: refresh"]').waitFor();
    await page.clock.fastForward(75_000);
    assert.equal(navigations, 0, "collapsed unfocused draft blocks idle release reload");
    assert.equal(await text.inputValue(), "Keep this unfocused draft across a release");

    let pending: (() => Promise<void>) | undefined;
    await page.route("**/api/messages", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      pending = () =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Local pending-send check" }),
        });
    });
    await page.locator(".messages-launch").click();
    await text.press("Control+Enter");
    await page.waitForFunction(
      () => document.querySelector(".messages-send-status")?.textContent === "Saving…",
    );
    // Isolate the busy flag from text length: an in-flight request must block reload itself.
    await text.evaluate((el) => {
      (el as HTMLTextAreaElement).value = "";
    });
    await page.locator(".messages-panel").press("Escape");
    await page.clock.fastForward(75_000);
    assert.equal(navigations, 0, "pending send alone blocks idle release reload");
    assert.ok(pending, "send is pending at the network boundary");
    await pending();
    await page.waitForFunction(() =>
      document
        .querySelector(".messages-send-status")
        ?.textContent?.includes("Local pending-send check"),
    );
    const reloaded = page.waitForEvent("framenavigated");
    await page.clock.fastForward(75_000);
    await reloaded;
    assert.equal(navigations, 1, "idle release reload resumes after draft/pending state clears");
  } finally {
    await ctx.close();
  }
}

/** Real HTTP + socket history and DOM interaction checks, no real desktop notifications. */
async function sceneMessages() {
  const name = "15-office-messages";
  if (!want(name)) return;
  log(name);
  const o = await office("busy");
  let serial = 0;
  const post = async (text: string) => {
    const response = await fetch(`${o.http}/api/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${PASSWORD}`,
        "content-type": "application/json",
        "cf-connecting-ip": `shots-${++serial}`,
      },
      body: JSON.stringify({
        audience: { kind: "everyone" },
        text,
        notifyDesktop: false,
        from: "Demo",
      }),
    });
    assert.equal(response.status, 201);
  };
  try {
    await post("Lunch in five! Everyone can read this shared office log.");
    // Keep the shipped popup regression path; fresh-browser overlay has its own scene.
    for (const vp of Object.keys(VIEWPORTS) as Viewport[]) {
      await (await context(vp)).addInitScript(() => {
        if (localStorage.getItem("agent-office.messages.expanded") === null)
          localStorage.setItem("agent-office.messages.expanded", "false");
      });
    }
    for (const vp of Object.keys(VIEWPORTS) as Viewport[]) {
      const page = await openOffice(vp, `${o.http}/?hour=15`, BUSY.people, BUSY.sessions, 500);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const launcher = page.locator(".messages-launch");
      await page.waitForFunction(
        () => document.querySelector(".messages-history-status")?.textContent === "",
      );
      assert.equal(await page.locator(".messages-panel").isVisible(), false);
      let historyReads = 0;
      page.on("request", (request) => {
        if (request.method() === "GET" && new URL(request.url()).pathname === "/api/messages")
          historyReads++;
      });
      await post(`New announcement for ${vp}`);
      await page.waitForFunction(() =>
        document.querySelector(".messages-launch")?.textContent?.includes("· 1"),
      );
      assert.equal(await page.locator(".messages-panel").isVisible(), false);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await sleep(150);
      assert.equal(
        historyReads,
        0,
        "contiguous live arrivals / healthy-tab returns must not fetch history",
      );
      await launcher.click();
      assert.equal(
        await page.locator("select[aria-label='Notification recipients']").inputValue(),
        "everyone",
      );
      assert.equal(await page.locator(".messages-notify input").isChecked(), false);
      await page.locator(".messages-log article").last().waitFor();
      await page.waitForFunction(
        () => document.querySelector(".messages-launch")?.textContent === "Messages",
      );
      const sessionId = await page.evaluate(() => [...window.__office.model.sessions.keys()][0]!);
      await page.evaluate((id) => window.__office.openSession(id), sessionId);
      await page.locator(".poke-message").click();
      assert.equal(
        await page
          .locator(".messages-panel select[aria-label='Notification recipients']")
          .inputValue(),
        "selected",
      );
      await page.getByRole("button", { name: "Add people", exact: true }).click();
      await page.getByRole("searchbox", { name: "Find recipients" }).fill("Lena");
      await page
        .locator(".messages-picker label")
        .filter({ hasText: "Lena" })
        .getByRole("checkbox")
        .check();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".messages-panel").isVisible(), true);
      assert.equal(await page.locator(".messages-picker").isVisible(), false);
      // Use only history delivery: fake connectors are present but nobody's Mac is involved.
      await page.locator(".messages-notify input").uncheck();
      const text = page.getByRole("textbox", { name: "Office message", exact: true });
      await text.fill(`<img src=x onerror=alert(1)> ${vp}`);
      await text.press("Enter");
      await text.press("End");
      await text.press("x");
      assert.ok((await text.inputValue()).includes("\n"));
      await text.press("Control+Enter");
      await page.waitForFunction(
        () =>
          document.querySelector(".messages-send-status")?.textContent ===
          "Saved to office history.",
      );
      assert.equal(await text.inputValue(), "");
      await page.waitForFunction(
        () => document.querySelector(".messages-launch")?.textContent === "Messages",
      );
      assert.equal(await page.locator(".messages-log img").count(), 0);
      assert.ok((await page.locator(".messages-log").textContent())?.includes("<img src=x"));
      assert.equal(
        historyReads,
        0,
        "HTTP acknowledgement + live echo must not trigger history reads",
      );
      // Keep the draft across card refreshes; wheel events stay inside the overlay.
      await text.fill("Draft survives surface changes");
      await page.evaluate((id) => window.__office.openSession(id), sessionId);
      await page.locator(".poke-message").click();
      assert.equal(await text.inputValue(), "Draft survives surface changes");
      assert.equal(await page.locator(".messages-notify input").isChecked(), false);
      if (vp === "laptop") {
        await sleep(2100); // the existing shared viewer-IP send guard
        // Save, lose the acknowledgement, and verify the UI warns without automatically resending.
        let attempts = 0;
        await page.route("**/api/messages", async (route) => {
          if (route.request().method() !== "POST") {
            await route.continue();
            return;
          }
          attempts++;
          await route.fetch();
          await route.abort();
        });
        await text.press("Control+Enter");
        await page.waitForFunction(() =>
          document
            .querySelector(".messages-send-status")
            ?.textContent?.includes("may already be saved"),
        );
        assert.equal(await text.isDisabled(), false);
        await page.unroute("**/api/messages");
        await sleep(150);
        assert.equal(attempts, 1);
        const history = await (await page.request.get(`${o.http}/api/messages`)).json();
        assert.equal(
          history.messages.filter(
            (m: { text: string }) => m.text === "Draft survives surface changes",
          ).length,
          1,
        );
        assert.equal(await text.inputValue(), "Draft survives surface changes");
        await sleep(2100);
        await text.fill("Who wants to pair after lunch?"); // A deliberate new message, not a retry.
        await text.press("Control+Enter");
        await page.waitForFunction(
          () =>
            document.querySelector(".messages-send-status")?.textContent ===
            "Saved to office history.",
        );
        await text.fill("Draft survives surface changes");
        // Restore history after a network break, with no extra alerts or duplicated rows.
        await page.context().setOffline(true);
        await post("Sent while this viewer was offline");
        await page.context().setOffline(false);
        await page.waitForFunction(() =>
          document
            .querySelector(".messages-log")
            ?.textContent?.includes("Sent while this viewer was offline"),
        );
      }
      const isolated = await page.evaluate(() => {
        let heard = 0;
        const listener = () => heard++;
        window.addEventListener("wheel", listener);
        document
          .querySelector(".messages-panel")!
          .dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
        window.removeEventListener("wheel", listener);
        return heard;
      });
      assert.equal(isolated, 0);
      const box = await page.locator(".messages-panel").boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= VIEWPORTS[vp].width);
      await shoot(page, `${name}-${vp}`);
      await text.press("Escape");
      assert.equal(await page.locator(".messages-panel").isVisible(), false);
      await page.reload();
      await page.waitForFunction(() => window.__office?.ready);
      assert.equal(await page.locator(".messages-panel").isVisible(), false);
      await launcher.click();
      const deleteButton = page
        .getByRole("button", { name: "Delete your message", exact: true, includeHidden: true })
        .last();
      const row = page
        .locator(".messages-log article")
        .filter({ has: page.locator("details") })
        .last();
      await row.locator("summary").click();
      await deleteButton.waitFor();
      const deletedId = await deleteButton.evaluate(
        (el) => el.closest("article")?.dataset.messageId,
      );
      assert.ok(deletedId);
      page.once("dialog", (dialog) => void dialog.accept());
      await deleteButton.click();
      await page.locator(`article[data-message-id="${deletedId}"]`).waitFor({ state: "detached" });
      const afterDelete = await (await page.request.get(`${o.http}/api/messages`)).json();
      assert.equal(
        afterDelete.messages.some((m: { id: string }) => m.id === deletedId),
        false,
      );
      assert.deepEqual(errors, []);
      await page.close();
    }
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
      extraHTTPHeaders: { authorization: `Bearer ${PASSWORD}` },
    });
    try {
      await mobile.addInitScript(() => {
        if (localStorage.getItem("agent-office.messages.expanded") === null)
          localStorage.setItem("agent-office.messages.expanded", "false");
      });
      const page = await mobile.newPage();
      await page.goto(o.http);
      await page.waitForFunction(() => window.__office?.ready);
      await page.locator(".messages-launch").tap();
      const id = await page.evaluate(() => [...window.__office.model.sessions.keys()][0]!);
      await page.evaluate((session) => window.__office.openSession(session), id);
      assert.equal(await page.locator(".messages-panel").isVisible(), false);
      await page.locator(".poke-message").tap();
      assert.equal(await page.locator(".hud-panel").isVisible(), false);
      assert.equal(await page.locator(".messages-panel").isVisible(), true);
      await page.getByRole("textbox", { name: "Office message", exact: true }).fill("Touch draft");
      await shoot(page, `${name}-phone`);
      await page.setViewportSize({ width: 390, height: 420 });
      await page.locator(".messages-panel.messages-keyboard").waitFor();
      const keyboardBox = await page.locator(".messages-panel").boundingBox();
      assert.ok(keyboardBox && keyboardBox.y >= 0 && keyboardBox.y + keyboardBox.height <= 420);
      assert.equal(await page.locator(".messages-privacy").isVisible(), true);
      assert.equal(await page.locator(".messages-send-row").isVisible(), true);
      await shoot(page, `${name}-phone-keyboard`);
      await page.getByRole("textbox", { name: "Office message", exact: true }).press("Escape");
      assert.equal(
        await page.locator(".messages-launch").evaluate((el) => el === document.activeElement),
        true,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      const demoRequests: string[] = [];
      page.on("request", (request) => {
        if (/\/api\/messages|\/api\/interact/.test(request.url())) demoRequests.push(request.url());
      });
      page.on("websocket", (socket) => demoRequests.push(socket.url()));
      await page.goto(`${o.http}/?demo=busy`);
      await page.waitForFunction(() => window.__office?.ready);
      await page.locator(".messages-launch").tap();
      const demoText = page.getByRole("textbox", { name: "Office message", exact: true });
      await demoText.fill("Local demo message");
      await demoText.press("Control+Enter");
      await page.waitForFunction(() =>
        document
          .querySelector(".messages-send-status")
          ?.textContent?.includes("Saved in this demo"),
      );
      assert.deepEqual(demoRequests, []);
      for (const query of ["?kiosk=1", "?nohud=1"]) {
        await page.goto(`${o.http}/${query}`);
        await page.waitForFunction(() => window.__office?.ready);
        assert.equal(await page.locator(".messages-launch").count(), 0);
        assert.equal(await page.locator(".messages-panel").count(), 0);
      }
    } finally {
      await mobile.close();
    }
    await checkMessageReloadGuard(o.http);
    log(
      "  message checks: zero live/tab history reads, browser-owned deletion after reload, history/unread, selection, plain text, lost-ack warning without resend, recovery, keyboard, draft/pending release guard, touch, demo and kiosk/nohud passed",
    );
  } finally {
    o.stop();
  }
}

async function sceneChatOverlay() {
  if (!want("18-chat-overlay")) return;
  const o = await office("busy");
  try {
    await checkChatOverlay(browser, o.http, PASSWORD, shoot);
  } finally {
    o.stop();
  }
}

// ---- main -------------------------------------------------------------------------------------

/** [seconds a scene took in CI, scene]: `--shard` balances by these */
const SCENES: readonly [number, () => Promise<void>][] = [
  [18, () => sceneSimple("01-empty", "empty", "hour=14", { people: 0, sessions: 0 })],
  [
    20,
    () =>
      sceneSimple("02-one-typing", "one", "hour=14&zoom=4", { people: 1, sessions: 1 }, 2500, {
        person: "anna",
        zoom: 4,
      }),
  ],
  [20, () => sceneSimple("03-busy", "busy", "hour=15", BUSY, 3500)],
  [30, busyGif],
  [32, sceneJoined],
  [23, () => sceneSimple("05-kiosk", "busy", "kiosk=1&hour=16", BUSY, 5000)],
  [18, () => sceneSimple("06-zoomed-out", "busy", "zoom=fit&hour=13", BUSY, 3000)],
  [4, sceneStats],
  [60, sceneTimelapse],
  [26, sceneSidePanel],
  [52, sceneAgentCard],
  [110, sceneMessages],
  [60, sceneChatOverlay],
  [25, sceneOfficeLife],
  [18, sceneCleared],
  [162, sceneBarAndShop],
  [13, sceneTerminal],
  [44, sceneDetailedLook],
  [5, sceneLookGallery],
];

/** Greedy split: the longest scene goes to the shard with the least work so far. */
function shardOf(weights: readonly number[], shards: number): number[] {
  const load = Array<number>(shards).fill(0);
  const out = Array<number>(weights.length).fill(0);
  const order = weights.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [w, i] of order) {
    const s = load.indexOf(Math.min(...load));
    out[i] = s;
    load[s] = load[s]! + w;
  }
  return out;
}

const SHARDS = SHARD
  ? shardOf(
      SCENES.map(([w]) => w),
      SHARD.of,
    )
  : null;
const inShard = (i: number) => !SHARDS || !SHARD || SHARDS[i] === SHARD.index - 1;

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
    for (const [, run] of SCENES.filter((_, i) => inShard(i))) await run();
    assert.deepEqual(pageErrors, [], "screenshot scenes must not hide browser exceptions");
  } finally {
    await browser.close();
    cleanup();
  }
  if (!ONLY && !SHARD) rmSync(join(OUT, "dev"), { recursive: true, force: true });
  log(`done: ${shots.length} files in ${OUT}`);
}

declare global {
  interface Window {
    /** set by the `?gallery=look` dev page once every sheet is drawn */
    __galleryReady?: boolean;
    __office: {
      ready: boolean;
      fps(): number;
      model: {
        people: Map<string, unknown>;
        sessions: Map<string, unknown>;
        games: { id: string }[];
      };
      camera: {
        zoomToFit(): void;
        focusArea(name: string): void;
        lookAt(tileX: number, tileY: number, zoom: number): void;
        focusPerson(personId: string, zoom?: number): boolean;
      };
      snapshotPng(): Promise<string | null>;
      openPerson(personId: string): void;
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
