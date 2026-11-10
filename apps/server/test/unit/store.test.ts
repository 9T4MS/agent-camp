import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { avatarFromSeed } from "@agent-office/protocol";
import { MemoryStore, SqlStore, type Store } from "../../src/core/store.ts";

const sqlite = () => {
  const db = new Database(":memory:");
  return new SqlStore(
    (sql, ...params) => db.query(sql).all(...(params as never[])) as Record<string, unknown>[],
  );
};

for (const [name, make] of [
  ["memory", () => new MemoryStore()],
  ["sqlite", sqlite],
] as [string, () => Store][]) {
  describe(`store: ${name}`, () => {
    test("history roundtrip and since filter", () => {
      const s = make();
      s.appendHistory([
        {
          ts: 2,
          type: "session.started",
          person: "a",
          agent: "claude",
          project: "p",
          subagents: 0,
        },
        { ts: 1, type: "person.joined", person: "a", agent: null, project: null, subagents: null },
      ]);
      expect(s.history().map((r) => r.ts)).toEqual([1, 2]);
      expect(s.history(2)).toEqual([
        {
          ts: 2,
          type: "session.started",
          person: "a",
          agent: "claude",
          project: "p",
          subagents: 0,
        },
      ]);
    });
    test("avatars, kv, snapshots", () => {
      const s = make();
      expect(s.getAvatar("a")).toBeNull();
      s.putAvatar("a", avatarFromSeed("a"), "k");
      expect(s.getAvatar("a")).toEqual({ avatar: avatarFromSeed("a"), key: "k" });
      s.kvPut("x", "1");
      s.kvPut("x", "2");
      expect(s.kvGet("x")).toBe("2");
      expect(s.kvGet("nope")).toBeNull();
      const id = s.addSnapshot(5, new Uint8Array([137, 80, 78, 71]));
      expect(s.listSnapshots()).toEqual([{ id, ts: 5, size: 4 }]);
      expect([...(s.getSnapshot(id) ?? [])]).toEqual([137, 80, 78, 71]);
      expect(s.getSnapshot(999)).toBeNull();
    });
  });
}
