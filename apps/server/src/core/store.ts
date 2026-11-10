/**
 * Storage interface the Hub depends on. Synchronous on purpose: Durable Object SQLite
 * (`ctx.storage.sql`) and bun:sqlite are both synchronous, and tests use memory.
 */
import type { AvatarSpec, HistoryRow, SnapshotMeta } from "@agent-office/protocol";

export type StoredAvatar = { avatar: AvatarSpec; key: string };

export interface Store {
  appendHistory(rows: readonly HistoryRow[]): void;
  /** All rows with ts >= since, oldest first. */
  history(since?: number): HistoryRow[];
  getAvatar(personId: string): StoredAvatar | null;
  putAvatar(personId: string, avatar: AvatarSpec, key: string): void;
  kvGet(key: string): string | null;
  kvPut(key: string, value: string): void;
  addSnapshot(ts: number, png: Uint8Array): number;
  listSnapshots(): Omit<SnapshotMeta, "url">[];
  getSnapshot(id: number): Uint8Array | null;
}

export class MemoryStore implements Store {
  rows: HistoryRow[] = [];
  avatars = new Map<string, StoredAvatar>();
  kv = new Map<string, string>();
  snapshots: { id: number; ts: number; png: Uint8Array }[] = [];

  appendHistory(rows: readonly HistoryRow[]): void {
    this.rows.push(...rows.map((r) => ({ ...r })));
  }
  history(since = 0): HistoryRow[] {
    return this.rows.filter((r) => r.ts >= since).sort((a, b) => a.ts - b.ts);
  }
  getAvatar(personId: string): StoredAvatar | null {
    return this.avatars.get(personId) ?? null;
  }
  putAvatar(personId: string, avatar: AvatarSpec, key: string): void {
    this.avatars.set(personId, { avatar, key });
  }
  kvGet(key: string): string | null {
    return this.kv.get(key) ?? null;
  }
  kvPut(key: string, value: string): void {
    this.kv.set(key, value);
  }
  addSnapshot(ts: number, png: Uint8Array): number {
    const id = this.snapshots.length + 1;
    this.snapshots.push({ id, ts, png });
    return id;
  }
  listSnapshots() {
    return this.snapshots.map(({ id, ts, png }) => ({ id, ts, size: png.byteLength }));
  }
  getSnapshot(id: number): Uint8Array | null {
    return this.snapshots.find((s) => s.id === id)?.png ?? null;
  }
}

/** Minimal SQL runner: execute one statement, return result rows as plain objects. */
export type SqlRun = (sql: string, ...params: unknown[]) => Record<string, unknown>[];

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL, type TEXT NOT NULL, person TEXT NOT NULL,
     agent TEXT, project TEXT, subagents INTEGER)`,
  "CREATE INDEX IF NOT EXISTS history_ts ON history(ts)",
  `CREATE TABLE IF NOT EXISTS avatars (
     person TEXT PRIMARY KEY, spec TEXT NOT NULL, key TEXT NOT NULL, updated INTEGER NOT NULL)`,
  "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS snapshots (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, png BLOB NOT NULL)`,
];

const toBytes = (v: unknown): Uint8Array | null => {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
};
const optStr = (v: unknown) => (typeof v === "string" ? v : null);
const optNum = (v: unknown) => (typeof v === "number" ? v : null);

/** SQLite-backed store, shared by the Durable Object and the Bun dev server. */
export class SqlStore implements Store {
  constructor(private run: SqlRun) {
    for (const s of SCHEMA) run(s);
  }
  appendHistory(rows: readonly HistoryRow[]): void {
    for (const r of rows) {
      this.run(
        "INSERT INTO history (ts, type, person, agent, project, subagents) VALUES (?, ?, ?, ?, ?, ?)",
        r.ts,
        r.type,
        r.person,
        r.agent ?? null,
        r.project ?? null,
        r.subagents ?? null,
      );
    }
  }
  history(since = 0): HistoryRow[] {
    return this.run(
      "SELECT ts, type, person, agent, project, subagents FROM history WHERE ts >= ? ORDER BY ts, id",
      since,
    ).map((r) => ({
      ts: Number(r.ts),
      type: String(r.type),
      person: String(r.person),
      agent: optStr(r.agent) as HistoryRow["agent"],
      project: optStr(r.project),
      subagents: optNum(r.subagents),
    }));
  }
  getAvatar(personId: string): StoredAvatar | null {
    const r = this.run("SELECT spec, key FROM avatars WHERE person = ?", personId)[0];
    if (!r) return null;
    try {
      return { avatar: JSON.parse(String(r.spec)) as AvatarSpec, key: String(r.key) };
    } catch {
      return null;
    }
  }
  putAvatar(personId: string, avatar: AvatarSpec, key: string): void {
    this.run(
      "INSERT OR REPLACE INTO avatars (person, spec, key, updated) VALUES (?, ?, ?, ?)",
      personId,
      JSON.stringify(avatar),
      key,
      Date.now(),
    );
  }
  kvGet(key: string): string | null {
    const r = this.run("SELECT v FROM kv WHERE k = ?", key)[0];
    return r ? String(r.v) : null;
  }
  kvPut(key: string, value: string): void {
    this.run("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", key, value);
  }
  addSnapshot(ts: number, png: Uint8Array): number {
    const r = this.run("INSERT INTO snapshots (ts, png) VALUES (?, ?) RETURNING id", ts, png)[0];
    return Number(r?.id ?? 0);
  }
  listSnapshots() {
    return this.run("SELECT id, ts, length(png) AS size FROM snapshots ORDER BY ts").map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      size: Number(r.size),
    }));
  }
  getSnapshot(id: number): Uint8Array | null {
    const r = this.run("SELECT png FROM snapshots WHERE id = ?", id)[0];
    return r ? toBytes(r.png) : null;
  }
}
