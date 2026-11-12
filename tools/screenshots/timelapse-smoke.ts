/** Real-server browser regression: build web first, then bun run tools/screenshots/timelapse-smoke.ts. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { encodePng } from "@agent-office/sim";
import type { SnapshotList } from "../../packages/protocol/src/api.ts";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");
const root = resolve(import.meta.dir, "../..");
const password = "timelapse-smoke-pass";
const server = Bun.spawn([process.execPath, "run", "apps/server/src/dev/bun-server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: "0",
    DB: ":memory:",
    CONNECTOR_PASSWORD: password,
    GENUI_PROVIDER: "off",
  },
  stdout: "pipe",
  stderr: "inherit",
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const reader = server.stdout.getReader();
  const origin = await Promise.race([
    (async () => {
      let output = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`Server exited before startup: ${output}`);
        output += new TextDecoder().decode(value);
        const match = /on (http:\/\/localhost:\d+)/.exec(output);
        if (match) {
          void (async () => {
            while (!(await reader.read()).done) {}
          })();
          return match[1]!;
        }
      }
    })(),
    Bun.sleep(15_000).then(() => {
      throw new Error("Server startup timeout");
    }),
  ]);
  const headers = { authorization: `Bearer ${password}` };
  assert.equal((await fetch(`${origin}/api/snapshots`)).status, 401);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    timezoneId: "Europe/Vienna",
    locale: "en-GB",
    serviceWorkers: "block",
    extraHTTPHeaders: headers,
  });
  const page = await context.newPage();
  const text = async (selector: string) => (await page.locator(selector).textContent()) ?? "";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.clock.install();
  await page.goto(`${origin}/timelapse`);
  await page.waitForSelector("body[data-ready='1']");
  assert.match(await text(".notice"), /No frames yet/);
  assert.equal(await text(".day-count"), "0 of 0 frames");

  const timestamps = [
    "2024-03-30T09:00:00Z",
    "2024-03-30T10:00:00Z",
    "2024-03-30T11:00:00Z",
    "2024-03-30T12:00:00Z",
    "2024-03-31T09:00:00Z",
    "2024-03-31T10:00:00Z",
    "2024-03-31T11:00:00Z",
    "2024-04-01T09:00:00Z",
  ];
  for (const [i, ts] of timestamps.entries()) {
    const png = encodePng(1, 1, new Uint8Array([i * 30, 100, 200]));
    const response = await fetch(`${origin}/api/snapshots?ts=${Date.parse(ts)}`, {
      method: "POST",
      headers: { ...headers, "content-type": "image/png" },
      body: Buffer.from(png),
    });
    assert.equal(response.status, 201, await response.text());
  }
  const list = (await (await fetch(`${origin}/api/snapshots`, { headers })).json()) as SnapshotList;
  const frames = [...list.snapshots].sort((a, b) => a.ts - b.ts || a.id - b.id);
  await page.reload();
  await page.waitForSelector("body[data-ready='1']");
  assert.equal(await text(".count"), "8 / 8");
  assert.match(await text(".day-controls"), /Browser-local time \(Europe\/Vienna\)/);

  const checkRange = async (start: number, length: number, index: number) => {
    assert.equal(await text(".day-count"), `${length} of 8 frames`);
    assert.equal(await text(".count"), `${index + 1} / ${length}`);
    assert.equal(await page.locator(".scrub").getAttribute("max"), String(length - 1));
    assert.equal(await page.locator(".scrub").inputValue(), String(index));
    const urls = await page
      .locator(".thumb img")
      .evaluateAll((imgs) => imgs.map((img) => img.getAttribute("src")));
    assert.deepEqual(
      urls,
      frames.slice(start, start + length).map((frame) => frame.url),
    );
    assert.equal(await page.locator(".frame").getAttribute("src"), frames[start + index]!.url);
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>(".frame")!;
      return image.complete && image.naturalWidth > 0;
    });
  };
  await checkRange(0, 8, 7);
  await page.locator(".play").click();
  await page.clock.fastForward(300);
  await page.locator(".day").fill("2024-03-30");
  const stopped = await text(".count");
  await page.clock.fastForward(2000);
  assert.equal(await text(".count"), stopped, "old playback timer survived day switch");
  assert.match(await text(".play"), /Play/);
  // Switch repeatedly: a leaked global listener would step multiple times or toggle space twice.
  for (const day of ["2024-03-31", "2024-03-30", "2024-03-31", "2024-03-30"])
    await page.locator(".day").fill(day);
  await checkRange(0, 4, 3);
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("ArrowLeft");
  await checkRange(0, 4, 2);
  await page.keyboard.press("Space");
  assert.match(await text(".play"), /Pause/);
  await page.clock.fastForward(300);
  await checkRange(0, 4, 3);
  await page.keyboard.press("Space");
  assert.match(await text(".play"), /Play/);
  for (const selector of [".day", ".speed", ".scrub"]) {
    const prevented = await page.locator(selector).evaluate((control) =>
      [" ", "ArrowLeft", "ArrowRight"].map((key) => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        control.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    );
    assert.deepEqual(prevented, [false, false, false], `${selector} keys were hijacked`);
  }
  await checkRange(0, 4, 3);
  await page.locator(".thumb").nth(1).click();
  await page.locator(".all-days").click();
  await checkRange(0, 8, 1); // preserved selection when it remains in range
  await page.locator(".day").fill("2024-03-30");
  await checkRange(0, 4, 1);
  await page.locator(".day").fill("2024-04-01");
  await checkRange(7, 1, 0);
  assert.equal(await page.locator(".play").isDisabled(), true);
  await page.locator(".day").fill("2024-04-02");
  assert.match(await text(".notice"), /No frames for this day/);
  assert.equal(await page.locator(".thumb").count(), 0);
  assert.equal(await text(".day-count"), "0 of 8 frames");
  await page.goto(`${origin}/timelapse?day=invalid`);
  await page.waitForSelector("body[data-ready='1']");
  await checkRange(0, 8, 7);
  assert.deepEqual(errors, [], "browser console/page errors");
  console.log(
    "PASS: latest/All, day filter, selection, counts/scrubber/thumbnails, empty/one-frame, timer cleanup, keyboard once, control keys, valid images; no console errors",
  );

  // Remove only the API request's credentials: exercise getJson's real 401 login redirect.
  await page.route("**/api/snapshots", async (route) => {
    const requestHeaders = { ...route.request().headers() };
    delete requestHeaders.authorization;
    // Static page was authenticated; the expired viewer must also reach /login without Bearer.
    await context.setExtraHTTPHeaders({});
    await route.continue({ headers: requestHeaders });
  });
  await page.goto(`${origin}/timelapse?day=2024-03-30`);
  await page.waitForURL(/\/login\?next=/);
  assert.equal(new URL(page.url()).searchParams.get("next"), "/timelapse?day=2024-03-30");
  console.log(
    "PASS: unauthenticated API remains 401; client redirects to login preserving next URL",
  );
} finally {
  await browser?.close();
  server.kill();
  await server.exited;
}
