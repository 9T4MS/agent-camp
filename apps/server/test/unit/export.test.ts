import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { OfficeApp } from "../../src/core/app.ts";
import { type ExportTable, MemoryStore, SqlStore, type Store } from "../../src/core/store.ts";
import { type ExportValue, exportToSqlite } from "../../src/dev/sqlite-export.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255]);

const sqlite = () => {
  const db = new Database(":memory:");
  return new SqlStore(
    (sql, ...params) => db.query(sql).all(...(params as never[])) as Record<string, unknown>[],
  );
};

function app(store: Store) {
  return new OfficeApp(
    { CONNECTOR_PASSWORD: "pw", VIEWER_KEY: "kiosk" },
    store,
    {
      broadcast: () => {},
      scheduleAlarm: () => {},
      sendToConnector: () => true,
      waitUntil: () => {},
    },
    { now: () => 1_000_000, log: () => {} },
  );
}
const get = (a: OfficeApp, q = "", auth: string | null = "Bearer pw") =>
  a.handleHttp(
    new Request(`http://x/api/export${q}`, { headers: auth ? { authorization: auth } : {} }),
  );

type Page = { rows: { rowid: number; values: ExportValue[] }[]; next: number | null };

describe("data export", () => {
  test("password only: no kiosk key, no anonymous", async () => {
    const a = app(sqlite());
    expect((await get(a, "", null))!.status).toBe(401);
    expect((await get(a, "?key=kiosk", null))!.status).toBe(401);
    expect((await get(a, "", "Bearer nope"))!.status).toBe(401);
    expect((await get(a))!.status).toBe(200);
  });

  test("lists every table with columns, indexes and counts; pages rows; blobs as base64", async () => {
    const s = sqlite();
    s.appendHistory(
      [1, 2, 3].map((ts) => ({
        ts,
        type: "session.started",
        person: "a",
        agent: "claude",
        project: null,
        subagents: null,
      })),
    );
    s.kvPut("k", "tab\there\nnew\\line");
    s.addSnapshot(7, PNG);
    const a = app(s);
    const meta = (await (await get(a))!.json()) as { tables: ExportTable[] };
    expect(meta.tables.map((t) => t.name)).toEqual([
      "avatars",
      "custom_avatars",
      "history",
      "kv",
      "office_messages",
      "snapshots",
    ]);
    const history = meta.tables.find((t) => t.name === "history")!;
    expect(history.rows).toBe(3);
    expect(history.indexes).toEqual(["CREATE INDEX history_ts ON history(ts)"]);

    const p1 = (await (await get(a, "?table=history&limit=2"))!.json()) as Page;
    expect(p1.rows.map((r) => r.values[1])).toEqual([1, 2]);
    expect(p1.next).toBe(2);
    const p2 = (await (await get(a, `?table=history&after=${p1.next}&limit=2`))!.json()) as Page;
    expect(p2.rows.map((r) => r.values[1])).toEqual([3]);
    expect(p2.next).toBeNull();

    const snap = (await (await get(a, "?table=snapshots"))!.json()) as Page;
    expect(snap.rows[0]!.values[2]).toEqual({ $base64: Buffer.from(PNG).toString("base64") });
    expect((await get(a, "?table=sqlite_sequence"))!.status).toBe(404);
    expect((await get(a, '?table=kv"--'))!.status).toBe(404);
  });

  test("memory store says it cannot export", async () => {
    expect((await get(app(new MemoryStore())))!.status).toBe(501);
  });

  test("exportToSqlite rebuilds the same office in a new file", async () => {
    const s = sqlite();
    s.appendHistory(
      Array.from({ length: 1500 }, (_, i) => ({
        ts: i,
        type: "session.started",
        person: "a",
        agent: "claude" as const,
        project: "p\tq",
        subagents: i % 3,
      })),
    );
    s.kvPut("games", 'line\n"ümlaut" 🐈');
    for (let i = 0; i < 25; i++) s.addSnapshot(i, PNG);
    const a = app(s);
    const db = new Database(":memory:");
    await exportToSqlite(async (q) => (await get(a, q))!.json(), db);

    const copy = new SqlStore(
      (sql, ...params) => db.query(sql).all(...(params as never[])) as Record<string, unknown>[],
    );
    expect(copy.history()).toEqual(s.history());
    expect(copy.kvGet("games")).toBe('line\n"ümlaut" 🐈');
    expect(copy.listSnapshots()).toEqual(s.listSnapshots());
    expect(copy.getSnapshot(25)).toEqual(PNG);
    expect(copy.addSnapshot(99, PNG)).toBe(26);
    const info = db.query("SELECT k FROM export_info ORDER BY k").all();
    expect(info).toEqual([{ k: "exported_at" }, { k: "server_version" }]);
  });
});
