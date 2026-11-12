/**
 * Copies every table behind GET /api/export into a local SQLite database with the office's own
 * schema, so the whole office is one file. Used by apps/server/scripts/export-sqlite.ts.
 */
import type { Database } from "bun:sqlite";
import type { ExportTable } from "../core/store.ts";

export type ExportValue = string | number | null | { $base64: string };
export type ExportPage = { rows: { rowid: number; values: ExportValue[] }[]; next: number | null };
export type ExportGet = (query: string) => Promise<unknown>;

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

const decode = (v: ExportValue) =>
  v !== null && typeof v === "object" ? Uint8Array.from(Buffer.from(v.$base64, "base64")) : v;

export async function exportToSqlite(
  get: ExportGet,
  db: Database,
  log: (line: string) => void = () => {},
): Promise<{ version: string; exportedAt: number }> {
  const meta = (await get("")) as { version: string; exportedAt: number; tables: ExportTable[] };
  for (const t of meta.tables) {
    db.run(t.sql);
    for (const index of t.indexes) db.run(index);
    const cols = t.columns.map((c) => ident(c.name)).join(", ");
    const insert = db.prepare(
      `INSERT INTO ${ident(t.name)} (${cols}) VALUES (${t.columns.map(() => "?").join(", ")})`,
    );
    const insertPage = db.transaction((rows: ExportPage["rows"]) => {
      for (const r of rows) insert.run(...(r.values.map(decode) as never[]));
    });
    const limit = t.columns.some((c) => /BLOB/i.test(c.type)) ? 20 : 1000;
    let after = 0;
    let count = 0;
    for (;;) {
      const page = (await get(
        `?table=${encodeURIComponent(t.name)}&after=${after}&limit=${limit}`,
      )) as ExportPage;
      insertPage(page.rows);
      count += page.rows.length;
      if (page.next === null) break;
      after = page.next;
    }
    // rows written while the export runs (history, messages) can move the count a little
    log(`${t.name}: ${count} rows${count !== t.rows ? ` (counted ${t.rows} at start)` : ""}`);
  }
  db.run("CREATE TABLE export_info (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  db.run("INSERT INTO export_info VALUES ('server_version', ?), ('exported_at', ?)", [
    meta.version,
    new Date(meta.exportedAt).toISOString(),
  ]);
  return { version: meta.version, exportedAt: meta.exportedAt };
}
