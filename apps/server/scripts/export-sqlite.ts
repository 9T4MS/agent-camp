/**
 * Downloads the whole office (GET /api/export) into one SQLite file to hand to another server:
 *
 *   AGENT_OFFICE_URL=https://agent-office.<subdomain>.workers.dev CONNECTOR_PASSWORD=... \
 *     bun apps/server/scripts/export-sqlite.ts [agent-office.sqlite]
 *
 * Costs one Worker request per page (1000 rows, 20 timelapse frames), a few hundred at most.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { exportToSqlite } from "../src/dev/sqlite-export.ts";

const base = process.env.AGENT_OFFICE_URL?.replace(/\/+$/, "");
const password = process.env.CONNECTOR_PASSWORD;
const outPath = process.argv[2] ?? "agent-office.sqlite";
if (!base || !password) {
  console.error(
    "usage: AGENT_OFFICE_URL=... CONNECTOR_PASSWORD=... bun apps/server/scripts/export-sqlite.ts [out.sqlite]",
  );
  process.exit(2);
}
if (existsSync(outPath)) {
  console.error(`${outPath} already exists`);
  process.exit(2);
}

const db = new Database(outPath);
await exportToSqlite(
  async (query) => {
    const res = await fetch(`${base}/api/export${query}`, {
      headers: { authorization: `Bearer ${password}` },
    });
    if (!res.ok) throw new Error(`GET /api/export${query}: ${res.status} ${await res.text()}`);
    return res.json();
  },
  db,
  console.log,
);
db.close();
console.log(`wrote ${outPath}`);
