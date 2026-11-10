/** Create .dev.vars from .dev.vars.example on first `bun run dev`. */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const vars = join(root, ".dev.vars");
if (!existsSync(vars)) {
  copyFileSync(join(root, ".dev.vars.example"), vars);
  console.log("created apps/server/.dev.vars (CONNECTOR_PASSWORD=devpass)");
}
// wrangler refuses to start without the assets directory; give it a placeholder until web is built
const dist = join(root, "..", "web", "dist");
if (!existsSync(dist)) {
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    join(dist, "index.html"),
    "<!doctype html><title>Agent Office</title><p>Web client not built yet: run <code>bun run --filter @agent-office/web build</code>.</p>\n",
  );
  console.log("created placeholder apps/web/dist (build apps/web for the real client)");
}
