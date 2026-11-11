// Playwright screenshots of the office (no server needed: uses the ?demo feeds).
//   node scripts/shot.mjs [--out ../../screenshots/dev] [--url http://localhost:4173] [--only busy]
// Without --url it runs `vite preview` on the existing dist/ (run `bun run build` first).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const OUT = resolve(arg("--out", join(here, "..", "..", "..", "screenshots", "dev")));
const ONLY = arg("--only", "");
let BASE = arg("--url", "");
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  laptop: { width: 1440, height: 900 },
  ipad: { width: 1180, height: 820 },
};
// name, query, wait ms after ready
const SCENES = [
  ["empty", "demo=empty&hour=14", 1500],
  ["one", "demo=one&hour=14&zoom=4&focus=anna", 2500],
  ["busy", "demo=busy&people=6&sessions=14&hour=14", 4000],
  ["busy-12p-30s", "demo=busy&hour=15", 4000],
  ["join", "demo=join&hour=11", 3300],
  ["kiosk", "demo=busy&kiosk=1&hour=16", 5000],
  ["fit", "demo=busy&zoom=fit&hour=13", 4000],
  ["night", "demo=busy&zoom=fit&hour=22", 4000],
];

let server;
async function startPreview() {
  server = spawn("./node_modules/.bin/vite", ["preview", "--port", "4179", "--strictPort"], {
    cwd: join(here, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  BASE = "http://localhost:4179";
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("vite preview did not start");
}

async function main() {
  if (!BASE) await startPreview();
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const results = {};
  try {
    for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
      for (const [name, query, wait] of SCENES) {
        if (ONLY && !name.includes(ONLY)) continue;
        const page = await ctx.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
        await page.goto(`${BASE}/?${query}`);
        await page.waitForFunction(() => window.__office?.ready === true, null, { timeout: 20000 });
        await page.waitForTimeout(wait);
        const file = join(OUT, `${name}-${vpName}.png`);
        await page.screenshot({ path: file });
        const fps = await page.evaluate(() => window.__office.fps());
        const ms = await page.evaluate(() => window.__office.frameMs());
        results[`${name}-${vpName}`] = { fps, ms, errors: errors.slice(0, 3) };
        console.log(
          `${name}-${vpName}: fps=${fps} upd=${ms.update}ms render=${ms.render}ms${errors.length ? ` errors=${errors.join(" | ")}` : ""}`,
        );
        await page.close();
      }
      await ctx.close();
    }
    // fps measurement: 12 people / 30 sessions, 8 s
    if (!ONLY || ONLY === "fps") {
      const ctx = await browser.newContext({ viewport: VIEWPORTS.laptop });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/?demo=busy&hour=15`);
      await page.waitForFunction(() => window.__office?.ready === true, null, { timeout: 20000 });
      const samples = [];
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(1000);
        samples.push(await page.evaluate(() => window.__office.fps()));
      }
      const info = await page.evaluate(() => ({
        people: window.__office.model.people.size,
        sessions: window.__office.model.sessions.size,
        characters: window.__office.characters(),
      }));
      console.log(
        `fps busy ${info.people}p/${info.sessions}s (${info.characters} chars): ${samples.join(", ")}`,
      );
      await ctx.close();
    }
  } finally {
    await browser.close();
    server?.kill();
  }
}

main().catch((e) => {
  console.error(e);
  server?.kill();
  process.exit(1);
});
