/** Real local server + two browser viewers. Run after building web: bun tools/screenshots/party-smoke.ts */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { avatarFromSeed, envelope, PARTY_ITEMS, PartyState } from "@agent-office/protocol";
import type { Browser, Page } from "playwright";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");
const root = resolve(import.meta.dir, "../..");
const out = process.env.PARTY_SHOTS ?? "/private/tmp/agent-office-party-shots";
mkdirSync(out, { recursive: true });
const server = Bun.spawn([process.execPath, "apps/server/src/dev/bun-server.ts"], {
  cwd: root,
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
let heartbeat: ReturnType<typeof setInterval> | undefined;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  for (const name of ["Schobes", "Disco Cat"]) {
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
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as { type: string };
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
  const errors: string[] = [];
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }),
    browser.newContext({ viewport: { width: 1180, height: 820 } }),
  ]);
  const pages: Page[] = [];
  for (const ctx of contexts) {
    await ctx.request.post(`${base}/api/login`, { form: { password: "local-party-test" } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (e) => {
      if (e.type() === "error") errors.push(e.text());
    });
    await page.goto(`${base}/?zoom=fit`);
    await page.waitForFunction(
      () => window.__office?.ready && window.__office.model.people.size === 2,
    );
    await page.getByRole("button", { name: "Dress up & play", exact: false }).click();
    await page.locator("#party-person").selectOption("schobes");
    pages.push(page);
  }
  const [page, other] = pages as [Page, Page];
  await page.getByRole("button", { name: "Neon cat", exact: true }).click();
  await page.getByRole("button", { name: "Save outfit", exact: true }).click();
  assert.match((await page.locator(".party-notice").textContent()) ?? "", /password/);
  await page.locator("#party-password").fill("local-party-test");
  await page.getByRole("button", { name: "Save outfit", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector(".party-notice")?.textContent?.includes("Outfit saved"),
  );
  await other.waitForFunction(
    () => (document.querySelector("#party-headwear") as HTMLSelectElement)?.value === "cat-ears",
  );
  assert.equal(
    await other.locator("#party-wrist").inputValue(),
    "neon-cyan",
    "other viewer receives look",
  );
  // An unrelated roster change must preserve an unsaved wardrobe draft.
  await page.locator("#party-color").selectOption("lime");
  await page.evaluate((avatar) => {
    window.__office.injectEvent({
      v: 1,
      type: "person.joined",
      id: "roster-test",
      ts: Date.now(),
      data: {
        person: {
          personId: "new-buddy",
          name: "New Buddy",
          avatar,
          sessions: [],
          joinedAt: Date.now(),
        },
      },
    });
  }, avatarFromSeed("new-buddy"));
  await page.waitForTimeout(1700);
  assert.equal(
    await page.locator("#party-color").inputValue(),
    "lime",
    "joining teammate preserves draft",
  );
  await page.evaluate(() =>
    window.__office.injectEvent({
      v: 1,
      type: "person.left",
      id: "roster-left",
      ts: Date.now(),
      data: { personId: "new-buddy" },
    }),
  );
  // Freeze editing during an in-flight save, then reject a stale poll begun before it.
  let releaseRead: (() => void) | undefined;
  let readCaptured: (() => void) | undefined;
  const captured = new Promise<void>((resolve) => {
    readCaptured = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let held = false;
  await page.route("**/api/party", async (route) => {
    if (route.request().method() === "GET" && !held) {
      held = true;
      const response = await route.fetch();
      readCaptured!();
      await release;
      await route.fulfill({ response });
    } else if (route.request().method() === "POST") {
      await pause(300);
      await route.continue();
    } else await route.continue();
  });
  await captured;
  await page.getByRole("button", { name: "Save outfit", exact: true }).click();
  assert(await page.locator("#party-person").isDisabled(), "selection frozen during save");
  assert(await page.locator("#party-item").isDisabled(), "draft frozen during save");
  await page.waitForFunction(() =>
    document.querySelector(".party-notice")?.textContent?.includes("Outfit saved"),
  );
  releaseRead!();
  await page.waitForTimeout(200);
  assert.equal(
    await page.locator("#party-color").inputValue(),
    "lime",
    "stale read cannot overwrite saved look",
  );
  await page.unroute("**/api/party");
  await page.screenshot({ path: `${out}/wardrobe-desktop.png` });
  const previews = new Set<string>();
  // Every usable hand item must save, render differently and produce its matching shared event.
  for (const item of PARTY_ITEMS.filter((i) => i.id !== "none")) {
    await page.locator("#party-item").selectOption(item.id);
    previews.add(
      await page
        .locator(".party-portrait canvas")
        .evaluate((el) => (el as HTMLCanvasElement).toDataURL()),
    );
    await page.getByRole("button", { name: "Save outfit", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector(".party-notice")?.textContent?.includes("Outfit saved"),
    );
    await pause(1550);
    await page.getByRole("button", { name: "Use item", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector(".party-notice")?.textContent?.includes("Party move sent"),
    );
    const state = PartyState.parse(
      await (await contexts[0]!.request.get(`${base}/api/party`)).json(),
    );
    assert.equal(state.events.at(-1)?.item, item.id);
    await page.waitForTimeout(100);
  }
  assert.equal(previews.size, 11, "each item has distinct rendered art");
  await page.locator("#party-target").selectOption("disco-cat");
  for (const action of ["High-five", "Play tag", "Roll & race", "Dance", "Wave"]) {
    await pause(1550);
    await page.getByRole("button", { name: action, exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector(".party-notice")?.textContent?.includes("Party move sent"),
    );
  }
  const state = PartyState.parse(
    await (await contexts[0]!.request.get(`${base}/api/party`)).json(),
  );
  assert.equal(state.scores["disco-cat"], 1);
  assert(state.scores.schobes! >= 3 && state.scores.schobes! <= 8);
  await other.waitForFunction(() =>
    document.querySelector(".party-board")?.textContent?.includes("Schobes"),
  );
  // Reload must retain server profile; then verify the phone layout doesn't overflow.
  await page.reload();
  await page.waitForFunction(() => window.__office?.ready);
  await page.getByRole("button", { name: "Dress up & play", exact: false }).click();
  await page.waitForFunction(
    () => (document.querySelector("#party-headwear") as HTMLSelectElement)?.value === "cat-ears",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/wardrobe-mobile.png` });
  const rect = await page.locator(".party-panel").boundingBox();
  assert(rect && rect.x >= 0 && rect.x + rect.width <= 390, "mobile panel fits");
  await page.keyboard.press("Escape");
  assert(await page.locator(".party-panel").isHidden());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: `${out}/office-party.png` });
  const unauthorized = await fetch(`${base}/api/party`, {
    method: "POST",
    body: JSON.stringify({ personId: "schobes", action: "dance" }),
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(errors, [], "no browser runtime or console errors");
  console.log(
    `PASS: two viewers, profile sync/reload, 11 distinct usable items, 5 social/game actions, scores, auth, mobile, Escape; 0 browser errors. Screenshots: ${out}`,
  );
} finally {
  if (heartbeat) clearInterval(heartbeat);
  for (const ws of sockets) ws.close();
  await browser?.close();
  server.kill();
  await server.exited;
}
