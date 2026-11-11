/**
 * Storage interface the Hub depends on. Synchronous on purpose: Durable Object SQLite
 * (`ctx.storage.sql`) and bun:sqlite are both synchronous, and tests use memory.
 */
import {
  AvatarSpec,
  type HistoryRow,
  MESSAGE_MAX_ROWS,
  MESSAGE_RETENTION_MS,
  type MessageRecord,
  type SnapshotMeta,
} from "@agent-office/protocol";

export type MessageSlice = { limit: number; before?: number; after?: number; since?: number };
export type StoredMessageRecord = MessageRecord & { ownerHash?: string };
export type StoredMessage = { message: MessageRecord; ownerHash?: string };

/**
 * A person's look. `selfDescription` is the person-level description the look was made
 * for ("" = none); missing on rows written before it was stored.
 */
export type StoredAvatar = { avatar: AvatarSpec; key: string; selfDescription?: string };

export interface Store {
  findMessageById(id: string): StoredMessage | null;
  deleteMessage(id: string): void;
  insertMessage(message: Omit<MessageRecord, "seq">, ownerHash?: string): MessageRecord;
  messages(query: MessageSlice): StoredMessageRecord[];
  messageHead(): number;
  nextMessageExpiry(): number | null;
  pruneMessages(now: number): void;
  appendHistory(rows: readonly HistoryRow[]): void;
  /** All rows with ts >= since, oldest first. */
  history(since?: number): HistoryRow[];
  getAvatar(personId: string): StoredAvatar | null;
  putAvatar(personId: string, avatar: AvatarSpec, key: string, selfDescription?: string): void;
  /**
   * Look picked in the look editor. Kept next to the automatic look (`getAvatar`), so going
   * back to automatic is a free restore. `null` removes it.
   */
  getCustomAvatar(personId: string): AvatarSpec | null;
  putCustomAvatar(personId: string, avatar: AvatarSpec | null): void;
  kvGet(key: string): string | null;
  kvPut(key: string, value: string): void;
  addSnapshot(ts: number, png: Uint8Array): number;
  listSnapshots(): Omit<SnapshotMeta, "url">[];
  getSnapshot(id: number): Uint8Array | null;
}

export class MemoryStore implements Store {
  private messageSeq = 0;
  private messageLog = new Map<string, StoredMessage>();
  findMessageById(id: string): StoredMessage | null {
    const row = this.messageLog.get(id);
    return row ? structuredClone(row) : null;
  }
  deleteMessage(id: string): void {
    this.messageLog.delete(id);
  }
  insertMessage(message: Omit<MessageRecord, "seq">, ownerHash?: string): MessageRecord {
    const record = { ...structuredClone(message), seq: ++this.messageSeq };
    this.messageLog.set(record.id, { message: record, ...(ownerHash ? { ownerHash } : {}) });
    return structuredClone(record);
  }
  messages(query: MessageSlice): StoredMessageRecord[] {
    const rows = [...this.messageLog.values()]
      .flatMap((r) =>
        r.message.ts > (query.since ?? -1)
          ? [{ ...r.message, ...(r.ownerHash ? { ownerHash: r.ownerHash } : {}) }]
          : [],
      )
      .filter(
        (m) =>
          (query.before === undefined || m.seq < query.before) &&
          (query.after === undefined || m.seq > query.after),
      );
    return structuredClone(
      query.after === undefined ? rows.slice(-query.limit) : rows.slice(0, query.limit),
    );
  }
  messageHead(): number {
    return this.messageSeq;
  }
  nextMessageExpiry(): number | null {
    const times = [...this.messageLog.values()].map((row) => row.message.ts);
    return times.length ? Math.min(...times) + MESSAGE_RETENTION_MS : null;
  }
  pruneMessages(now: number): void {
    for (const [id, row] of this.messageLog) {
      if (row.message.ts + MESSAGE_RETENTION_MS <= now || this.messageLog.size > MESSAGE_MAX_ROWS)
        this.messageLog.delete(id);
    }
  }
  rows: HistoryRow[] = [];
  avatars = new Map<string, StoredAvatar>();
  customAvatars = new Map<string, AvatarSpec>();
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
  putAvatar(personId: string, avatar: AvatarSpec, key: string, selfDescription?: string): void {
    this.avatars.set(personId, {
      avatar,
      key,
      ...(selfDescription !== undefined ? { selfDescription } : {}),
    });
  }
  getCustomAvatar(personId: string): AvatarSpec | null {
    return this.customAvatars.get(personId) ?? null;
  }
  putCustomAvatar(personId: string, avatar: AvatarSpec | null): void {
    if (avatar) this.customAvatars.set(personId, avatar);
    else this.customAvatars.delete(personId);
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
  `CREATE TABLE IF NOT EXISTS office_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, ts INTEGER NOT NULL, record TEXT NOT NULL, owner_hash TEXT)`,
  "CREATE INDEX IF NOT EXISTS office_messages_ts ON office_messages(ts)",
  `CREATE TABLE IF NOT EXISTS avatars (
     person TEXT PRIMARY KEY, spec TEXT NOT NULL, key TEXT NOT NULL, updated INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS custom_avatars (
     person TEXT PRIMARY KEY, spec TEXT NOT NULL, updated INTEGER NOT NULL)`,
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
    if (!run("PRAGMA table_info(office_messages)").some((r) => r.name === "owner_hash"))
      run("ALTER TABLE office_messages ADD COLUMN owner_hash TEXT");
    // migration: the person-level look description lives next to the avatar
    let hasDescr = false;
    try {
      hasDescr = run("PRAGMA table_info(avatars)").some((r) => r.name === "descr");
    } catch {
      // PRAGMA not allowed: just try the ALTER
    }
    if (!hasDescr) {
      try {
        run("ALTER TABLE avatars ADD COLUMN descr TEXT");
      } catch {
        // already there
      }
    }
  }
  findMessageById(id: string): StoredMessage | null {
    const row = this.run(
      "SELECT seq, record, owner_hash FROM office_messages WHERE id = ? AND record <> 'null'",
      id,
    )[0];
    return row ? this.storedMessage(row) : null;
  }
  private storedMessage(row: Record<string, unknown>): StoredMessage {
    return {
      message: this.readMessage(row),
      ...(row.owner_hash ? { ownerHash: String(row.owner_hash) } : {}),
    };
  }
  deleteMessage(id: string): void {
    const head = this.messageHead();
    if (head > Number(this.kvGet("messages.head") ?? 0)) this.kvPut("messages.head", String(head));
    this.run("DELETE FROM office_messages WHERE id = ?", id);
  }
  private readMessage(row: Record<string, unknown>): MessageRecord {
    return { ...JSON.parse(String(row.record)), seq: Number(row.seq) };
  }
  insertMessage(message: Omit<MessageRecord, "seq">, ownerHash?: string): MessageRecord {
    const row = this.run(
      "INSERT INTO office_messages (id, request_id, payload, ts, record, owner_hash) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
      message.id,
      message.id, // Compatibility with the prototype schema; no client retry ledger.
      "",
      message.ts,
      JSON.stringify(message),
      ownerHash ?? null,
    )[0]!;
    return { ...message, seq: Number(row.seq) };
  }
  messages(query: MessageSlice): StoredMessageRecord[] {
    const after = query.after !== undefined;
    const rows = this.run(
      `SELECT seq, record, owner_hash FROM office_messages WHERE record <> 'null' AND ts > ? AND seq ${after ? ">" : "<"} ? ORDER BY seq ${after ? "ASC" : "DESC"} LIMIT ?`,
      query.since ?? -1,
      query.after ?? query.before ?? Number.MAX_SAFE_INTEGER,
      query.limit,
    ).map((row) => ({
      ...this.readMessage(row),
      ...(row.owner_hash ? { ownerHash: String(row.owner_hash) } : {}),
    }));
    return after ? rows : rows.reverse();
  }
  messageHead(): number {
    const row = this.run("SELECT MAX(seq) AS head FROM office_messages")[0];
    return Math.max(Number(row?.head ?? 0), Number(this.kvGet("messages.head") ?? 0));
  }
  nextMessageExpiry(): number | null {
    const row = this.run("SELECT MIN(ts) AS ts FROM office_messages")[0];
    return row?.ts == null ? null : Number(row.ts) + MESSAGE_RETENTION_MS;
  }
  pruneMessages(now: number): void {
    const head = this.messageHead();
    if (head > Number(this.kvGet("messages.head") ?? 0)) this.kvPut("messages.head", String(head));
    this.run(
      "DELETE FROM office_messages WHERE ts <= ? OR seq < COALESCE((SELECT seq FROM office_messages ORDER BY seq DESC LIMIT 1 OFFSET ?), 0)",
      now - MESSAGE_RETENTION_MS,
      MESSAGE_MAX_ROWS - 1,
    );
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
    const r = this.run("SELECT spec, key, descr FROM avatars WHERE person = ?", personId)[0];
    if (!r) return null;
    try {
      const desc = optStr(r.descr);
      const raw: unknown = JSON.parse(String(r.spec));
      // rows from before newer catalog fields existed get their defaults
      const look = AvatarSpec.safeParse(raw);
      return {
        avatar: look.success ? look.data : (raw as AvatarSpec),
        key: String(r.key),
        ...(desc !== null ? { selfDescription: desc } : {}),
      };
    } catch {
      return null;
    }
  }
  putAvatar(personId: string, avatar: AvatarSpec, key: string, selfDescription?: string): void {
    this.run(
      "INSERT OR REPLACE INTO avatars (person, spec, key, updated, descr) VALUES (?, ?, ?, ?, ?)",
      personId,
      JSON.stringify(avatar),
      key,
      Date.now(),
      selfDescription ?? null,
    );
  }
  getCustomAvatar(personId: string): AvatarSpec | null {
    const r = this.run("SELECT spec FROM custom_avatars WHERE person = ?", personId)[0];
    if (!r) return null;
    try {
      const look = AvatarSpec.safeParse(JSON.parse(String(r.spec)));
      return look.success ? look.data : null;
    } catch {
      return null;
    }
  }
  putCustomAvatar(personId: string, avatar: AvatarSpec | null): void {
    if (!avatar) {
      this.run("DELETE FROM custom_avatars WHERE person = ?", personId);
      return;
    }
    this.run(
      "INSERT OR REPLACE INTO custom_avatars (person, spec, updated) VALUES (?, ?, ?)",
      personId,
      JSON.stringify(avatar),
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
