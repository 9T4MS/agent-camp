// scratch: node-free fun screenshots against vite dev (deleted before finishing)
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");
const OUT = "/tmp/claude-0/-home-user-agent-camp/2eb63d8b-944b-5fff-8442-8e2d89b81b5b/scratchpad/fun";
mkdirSync(OUT, { recursive: true });
// usage: bun _funshot.ts name "query" waitMs [evalJs] [clip x,y,w,h]
const [name, query, wait, js, shots] = process.argv.slice(2);
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror", e.message));
page.on("console", (m) => {
  if (m.type() === "error" || m.text().startsWith("[fun]")) console.log("console", m.text());
});
await page.goto(`http://localhost:5199/?${query}`);
await page.waitForFunction(() => (window as any).__office?.ready === true, null, { timeout: 30000 });
if (js) await page.evaluate(js);
const n = Number(shots ?? 1);
for (let i = 0; i < n; i++) {
  await new Promise((r) => setTimeout(r, Number(wait)));
  await page.screenshot({ path: `${OUT}/${name}${n > 1 ? `-${i}` : ""}.png` });
  console.log("shot", name, i, await page.evaluate(() => (window as any).__office.fps()));
}
await browser.close();
