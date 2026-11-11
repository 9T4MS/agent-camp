/** Isolated real server + viewers. Build web first: bun tools/screenshots/party-smoke.ts */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { envelope, type PartyState, parseViewerMessage } from "@agent-office/protocol";
import type { Browser, Page } from "playwright";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");
const out = process.env.PARTY_SHOTS ?? "/private/tmp/agent-office-party-shots";
mkdirSync(out, { recursive: true });
const server = Bun.spawn([process.execPath, "apps/server/src/dev/bun-server.ts"], {
  cwd: resolve(import.meta.dir, "../.."),
  env: {
    ...process.env,
    PORT: "0",
    DB: ":memory:",
    CONNECTOR_PASSWORD: "local-party-test",
    GENUI_PROVIDER: "off",
  },
  stdout: "pipe",
  stderr: "inherit",
});
let browser: Browser | undefined;
const sockets: WebSocket[] = [];
/** latest "This is me" code each fake Mac got as a notification (by connector name) */
const macCodes = new Map<string, string>();
let heartbeat: ReturnType<typeof setInterval> | undefined;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usable = [
  "lightsaber",
  "confetti",
  "beer",
  "cigarette",
  "bubble-wand",
  "disco-ball",
  "magic-wand",
  "balloon",
  "water-pistol",
  "maracas",
  "umbrella",
  "joint",
  "coffee",
  "phone",
];
try {
  const reader = server.stdout.getReader();
  let log = "";
  while (!/localhost:(\d+)/.test(log)) {
    const { value, done } = await reader.read();
    assert(!done, "local server exited before listening");
    log += new TextDecoder().decode(value);
  }
  const base = `http://localhost:${/localhost:(\d+)/.exec(log)![1]}`;
  void (async () => {
    while (!(await reader.read()).done) {
      /* drain */
    }
  })();
  const presence = () =>
    envelope("presence.snapshot", {
      sessions: [
        {
          sessionKey: "party-session-123",
          agent: "codex",
          activity: "idle",
          subagents: 0,
          startedAt: Date.now(),
        },
      ],
    });
  for (const name of ["Player One", "Player Two"]) {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/connector`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () =>
        ws.send(
          JSON.stringify(
            envelope("connector.hello", {
              name,
              password: "local-party-test",
              clientId: name.replaceAll(" ", "-"),
              connectorVersion: "99.0.0",
            }),
          ),
        );
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as { type: string; data?: { text?: string } };
        const code = msg.type === "connector.poked" && /\b(\d{6})\b/.exec(msg.data?.text ?? "");
        if (code) macCodes.set(name, code[1]!);
        if (msg.type === "connector.welcomed") {
          ws.send(JSON.stringify(presence()));
          resolve();
        }
        if (msg.type === "connector.rejected") reject(new Error("connector rejected"));
      };
      ws.onerror = () => reject(new Error("connector failed"));
    });
  }
  heartbeat = setInterval(() => {
    for (const ws of sockets) ws.send(JSON.stringify(presence()));
  }, 5000);
  browser = await chromium.launch({
    headless: true,
    args: [
      "--enable-webgl",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  const contexts = await Promise.all([
    browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    }),
    browser.newContext({ viewport: { width: 1180, height: 820 }, serviceWorkers: "block" }),
    browser.newContext({ viewport: { width: 1180, height: 820 }, serviceWorkers: "block" }),
  ]);
  const errors: string[] = [];
  const requests: string[] = [];
  const received: PartyState[][] = [[], [], []];
  const pages: Page[] = [];
  for (const [i, ctx] of contexts.entries()) {
    await ctx.request.post(`${base}/api/login`, { form: { password: "local-party-test" } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (e) => {
      if (e.type() === "error") errors.push(e.text());
    });
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/"))
        requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    page.on("websocket", (ws) =>
      ws.on("framereceived", ({ payload }) => {
        const r = parseViewerMessage(typeof payload === "string" ? payload : payload.toString());
        if (r.ok && r.msg.type === "party.updated") received[i]!.push(r.msg.data.party);
      }),
    );
    await page.goto(`${base}/?zoom=fit${i === 2 ? "&kiosk=1" : ""}`);
    await page.waitForFunction(
      () => window.__office?.ready && window.__office.model.people.size === 2,
    );
    if (i < 2) await page.getByRole("button", { name: "Office games", exact: false }).click();
    pages.push(page);
  }
  const [page, other, kiosk] = pages as [Page, Page, Page];
  assert.equal(
    await page.locator("#party-person").inputValue(),
    "player-one",
    "defaults to first person",
  );
  assert.equal(
    await page.locator('input[type="password"]').count(),
    0,
    "uses login cookie, no extra password",
  );
  assert(await kiosk.locator(".party-launch").isHidden());
  const idleStart = requests.length;
  await pause(6500);
  assert.equal(requests.length, idleStart, "open pages/kiosk generate zero idle HTTP API requests");
  console.log("PASS: 3 idle viewers, zero periodic HTTP requests; cookie-only UI");

  const saveLook = async () => {
    const response = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().includes("/avatar"),
    );
    await page.getByRole("button", { name: "Save look", exact: true }).click();
    assert.equal((await response).status(), 200);
  };
  /** Look studio rows are arrow carousels: click "next" until the row shows `value`. */
  const pick = async (field: string, value: string) => {
    const row = page.locator(`.look-row[data-field="${field}"]`);
    for (let i = 0; i < 60 && (await row.getAttribute("data-value")) !== value; i++)
      await row.locator(".next").click();
    assert.equal(await row.getAttribute("data-value"), value, `${field} reaches ${value}`);
  };
  // Only your own look: without proving it, Customize opens the "This is me" box, not the
  // studio, and the API refuses a direct PUT.
  await page.getByRole("button", { name: "Customize look", exact: true }).click();
  assert.equal(await page.locator(".look-studio").count(), 0, "no studio before the code");
  const forged = await other.evaluate(async () => {
    const r = await fetch("/api/people/player-one/avatar", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ avatar: null }),
    });
    return r.status;
  });
  assert.equal(forged, 403, "someone else's look cannot be changed");
  // the browser logs that refused request; it is the expected one, not a bug
  await pause(200);
  const refused = errors.findIndex((e) => e.includes("status of 403"));
  if (refused >= 0) errors.splice(refused, 1);
  await page.locator(".claim-send").click();
  for (let i = 0; i < 50 && !macCodes.has("Player One"); i++) await pause(100);
  assert(!macCodes.has("Player Two"), "the code only goes to that person's Mac");
  await page.locator(".claim-form input").fill(macCodes.get("Player One")!);
  await page.locator(".claim-form button").click();
  await page.locator(".look-studio").waitFor();
  console.log("PASS: looks are owner-only (courtesy lock: a code on that person's Mac)");
  await pick("accessory", "cat-ears");
  await pick("wrist", "neon-cyan");
  await pick("outfit", "cat");
  await pick("accentColor", "pink");
  await pick("vehicle", "hoverboard");
  await pick("leftHand", "confetti");
  await pick("rightHand", "lightsaber");
  await saveLook();
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.locator(".look-studio .studio-rows").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: `${out}/shared-look-editor-desktop.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await other.waitForFunction(() => {
    const p = window.__office.model.people.get("player-one") as {
      avatar: { wrist: string; rightHand: string };
    };
    return p?.avatar.wrist === "neon-cyan" && p.avatar.rightHand === "lightsaber";
  });
  console.log("PASS: canonical look editor saves and synchronizes avatar equipment");

  // Every hand item can be saved in the shared editor and used through cookie auth.
  for (const item of usable) {
    await pause(1300);
    await pick("rightHand", item);
    await saveLook();
    await page.locator(".look-editor .close").click();
    await page.getByRole("button", { name: "Office games", exact: false }).click();
    const response = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/party",
    );
    await page.getByRole("button", { name: "Use right item", exact: true }).click();
    assert.equal((await response).status(), 200);
    await other.waitForFunction((id) => {
      const state = (window.__office.model as typeof window.__office.model & { party: PartyState })
        .party;
      return state.events.at(-1)?.item === id;
    }, item);
    await page.getByRole("button", { name: "Customize look", exact: true }).click();
  }
  await page.locator(".look-editor .close").click();
  await page.getByRole("button", { name: "Office games", exact: false }).click();
  await pause(1600);
  await page.locator("#party-target").selectOption("player-two");
  for (const action of ["Use left item", "High-five", "Play tag", "Roll & race", "Dance", "Wave"]) {
    const response = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/party",
    );
    await page.getByRole("button", { name: action, exact: true }).click();
    assert.equal((await response).status(), 200);
    await pause(1600);
  }
  const snapshot = await contexts[0]!.request.get(`${base}/api/state`);
  const parsed = parseViewerMessage(await snapshot.json());
  assert(parsed.ok && parsed.msg.type === "office.snapshot");
  const state = parsed.msg.data.party!;
  assert.equal(state.scores["player-two"], 1);
  assert(state.scores["player-one"]! >= 3 && state.scores["player-one"]! <= 8);
  for (const events of received)
    assert(
      events.length >= usable.length + 6,
      "normal and kiosk viewers receive all moves over websocket",
    );
  await other.waitForFunction(() =>
    document.querySelector(".party-board")?.textContent?.includes("Player One"),
  );
  await page.screenshot({ path: `${out}/office-games-desktop.png` });

  // New/reconnected viewer restores scores and gear from the socket snapshot without GET party.
  await page.reload();
  await page.waitForFunction(() => window.__office?.ready);
  await page.getByRole("button", { name: "Office games", exact: false }).click();
  await page.waitForFunction(() =>
    document.querySelector(".party-board")?.textContent?.includes("Player One"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/office-games-mobile.png` });
  const rect = await page.locator(".party-panel").boundingBox();
  assert(rect && rect.x >= 0 && rect.x + rect.width <= 390, "mobile game panel fits");
  await page.keyboard.press("Escape");
  assert(await page.locator(".party-panel").isHidden());

  // The same IP cannot bypass limits by changing actor or using malformed payloads.
  const malformed = await contexts[0]!.request.post(`${base}/api/party`, {
    data: { personId: "player-one", action: "dance", item: "forged" },
  });
  assert.equal(malformed.status(), 400);
  const burst = await contexts[0]!.request.post(`${base}/api/party`, {
    data: { personId: "player-two", action: "wave" },
  });
  assert.equal(burst.status(), 429);
  assert(Number(burst.headers()["retry-after"]) >= 1);
  const denied = await fetch(`${base}/api/party`, { method: "POST", body: "{}" });
  assert.equal(denied.status, 401);
  assert.equal(requests.filter((r) => r === "GET /api/party").length, 0);
  assert.deepEqual(errors, [], "zero browser errors");
  console.log(
    `PASS: shared editor, 14 hand items + left hand, games/scores, 3 WS viewers incl kiosk, reconnect, mobile, auth, per-IP limits; 0 polling requests, 0 browser errors. Screenshots: ${out}`,
  );
} finally {
  if (heartbeat) clearInterval(heartbeat);
  for (const ws of sockets) ws.close();
  await browser?.close();
  server.kill();
  await server.exited;
}
