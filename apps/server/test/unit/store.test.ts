import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { avatarFromSeed, MAX_SELF_DESCRIPTION } from "@agent-office/protocol";
import { LOOK_FIXTURES } from "@agent-office/protocol/fixtures";
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
      s.putAvatar("b", avatarFromSeed("b"), "k2", "round glasses");
      expect(s.getAvatar("b")?.selfDescription).toBe("round glasses");
      s.putAvatar("b", avatarFromSeed("b"), "k3", "");
      expect(s.getAvatar("b")?.selfDescription).toBe("");
      s.kvPut("x", "1");
      s.kvPut("x", "2");
      expect(s.kvGet("x")).toBe("2");
      expect(s.kvGet("nope")).toBeNull();
      const id = s.addSnapshot(5, new Uint8Array([137, 80, 78, 71]));
      expect(s.listSnapshots()).toEqual([{ id, ts: 5, size: 4 }]);
      expect([...(s.getSnapshot(id) ?? [])]).toEqual([137, 80, 78, 71]);
      expect(s.getSnapshot(999)).toBeNull();
    });
    test("avatars: detailed look and a max-length description roundtrip unchanged", () => {
      const s = make();
      const desc = "x".repeat(MAX_SELF_DESCRIPTION);
      s.putAvatar("t", LOOK_FIXTURES.tracht, "anthropic:L1:abc", desc);
      expect(s.getAvatar("t")).toEqual({
        avatar: LOOK_FIXTURES.tracht,
        key: "anthropic:L1:abc",
        selfDescription: desc,
      });
    });
  });
}

test("sqlite: avatars table from before the descr column is migrated", () => {
  const db = new Database(":memory:");
  const run = (sql: string, ...params: unknown[]) =>
    db.query(sql).all(...(params as never[])) as Record<string, unknown>[];
  run(
    "CREATE TABLE avatars (person TEXT PRIMARY KEY, spec TEXT NOT NULL, key TEXT NOT NULL, updated INTEGER NOT NULL)",
  );
  run(
    "INSERT INTO avatars (person, spec, key, updated) VALUES (?, ?, ?, ?)",
    "old",
    JSON.stringify(avatarFromSeed("old")),
    "k0",
    1,
  );
  const s = new SqlStore(run);
  expect(s.getAvatar("old")).toEqual({ avatar: avatarFromSeed("old"), key: "k0" });
  s.putAvatar("old", avatarFromSeed("old"), "k1", "beard");
  expect(s.getAvatar("old")?.selfDescription).toBe("beard");
  new SqlStore(run); // idempotent
});

test("sqlite: avatar rows from before outfits get the new fields' defaults", () => {
  const db = new Database(":memory:");
  const store = new SqlStore(
    (sql, ...params) => db.query(sql).all(...(params as never[])) as Record<string, unknown>[],
  );
  const { outfit: _o, leftHand: _l, rightHand: _r, ...old } = avatarFromSeed("anna");
  db.query("INSERT INTO avatars (person, spec, key, updated) VALUES (?, ?, ?, ?)").run(
    "anna",
    JSON.stringify(old),
    "k",
    1,
  );
  expect(store.getAvatar("anna")?.avatar).toEqual(avatarFromSeed("anna"));
});

for (const [name, make] of [
  ["memory", () => new MemoryStore()],
  ["sqlite", sqlite],
] as [string, () => Store][]) {
  test(`${name}: custom look lives next to the automatic one`, () => {
    const s = make();
    const auto = avatarFromSeed("tom");
    const custom = { ...auto, outfit: "flannel", leftHand: "beer" } as const;
    s.putAvatar("tom", auto, "k", "");
    expect(s.getCustomAvatar("tom")).toBeNull();
    s.putCustomAvatar("tom", custom);
    expect(s.getCustomAvatar("tom")).toEqual(custom);
    expect(s.getAvatar("tom")?.avatar).toEqual(auto);
    s.putCustomAvatar("tom", null);
    expect(s.getCustomAvatar("tom")).toBeNull();
    expect(s.getAvatar("tom")?.avatar).toEqual(auto);
  });
}
