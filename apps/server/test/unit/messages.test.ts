import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  avatarFromSeed,
  envelope,
  MESSAGE_DAILY_CAP,
  MESSAGE_MAX_ROWS,
  MESSAGE_RETENTION_MS,
  MessagePage,
  type MessageRecord,
  SendMessageResponse,
} from "@agent-office/protocol";
import { OfficeApp } from "../../src/core/app.ts";
import { MESSAGE_EXPIRY_BATCH_MS } from "../../src/core/messages.ts";
import { MemoryStore, SqlStore, type Store } from "../../src/core/store.ts";

const record = (n: number, ts = 1_000_000): Omit<MessageRecord, "seq"> => ({
  id: `message-${n}`,
  ts,
  text: `hello ${n}`,
  audience: "everyone",
  recipients: [],
  notifyDesktop: false,
});
const sql = (db = new Database(":memory:")) =>
  new SqlStore(
    (query, ...args) => db.query(query).all(...(args as never[])) as Record<string, unknown>[],
  );
for (const [name, make] of [
  ["memory", () => new MemoryStore()],
  ["sqlite", () => sql()],
] as const) {
  describe(`messages: ${name}`, () => {
    test("100-row/24h retention, both cursor directions and monotonic empty watermark", () => {
      const store = make();
      for (let n = 1; n <= MESSAGE_MAX_ROWS + 2; n++) store.insertMessage(record(n));
      store.pruneMessages(1_000_000);
      expect(store.messages({ after: 0, limit: 2 }).map((m) => m.seq)).toEqual([3, 4]);
      expect(store.messages({ before: 6, limit: 2 }).map((m) => m.seq)).toEqual([4, 5]);
      expect(store.messages({ limit: 2 }).map((m) => m.seq)).toEqual([101, 102]);
      expect(store.findMessageById("message-1")).toBeNull();
      expect(store.nextMessageExpiry()).toBe(1_000_000 + MESSAGE_RETENTION_MS);
      expect(store.messages({ limit: 100, since: 1_000_000 })).toEqual([]);
      store.pruneMessages(1_000_000 + MESSAGE_RETENTION_MS);
      expect(store.messages({ limit: 100 })).toEqual([]);
      expect(store.messageHead()).toBe(102);
      expect(store.nextMessageExpiry()).toBeNull();
      expect(store.insertMessage(record(103)).seq).toBe(103);
    });
    test("deletion removes the complete stored row and preserves sequence ordering", () => {
      const store = make();
      const saved = store.insertMessage(record(1), "owner-hash");
      expect(store.findMessageById(saved.id)?.ownerHash).toBe("owner-hash");
      store.deleteMessage(saved.id);
      expect(store.findMessageById(saved.id)).toBeNull();
      expect(store.messages({ limit: 100 })).toEqual([]);
      expect(store.messageHead()).toBe(1);
      expect(store.insertMessage(record(2)).seq).toBe(2);
    });
  });
}
test("SQLite restart/migration preserves unrelated data and prototype schema compatibility", () => {
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE office_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, ts INTEGER NOT NULL, record TEXT NOT NULL)",
  );
  const first = sql(db);
  first.putAvatar("a", avatarFromSeed("a"), "k");
  first.appendHistory([{ type: "person.joined", person: "a", ts: 1 }]);
  first.addSnapshot(1, new Uint8Array([1, 2]));
  const saved = first.insertMessage(record(1), "owner");
  const second = sql(db);
  expect(second.findMessageById(saved.id)?.message).toEqual(saved);
  expect(second.getAvatar("a")?.key).toBe("k");
  expect(second.history()).toHaveLength(1);
  expect(second.getSnapshot(1)).toEqual(new Uint8Array([1, 2]));
  expect(db.query("SELECT payload FROM office_messages").get()).toEqual({ payload: "" });
  second.deleteMessage(saved.id);
  expect(db.query("SELECT COUNT(*) AS n FROM office_messages").get()).toEqual({ n: 0 });
  expect(sql(db).messageHead()).toBe(1);
});

function setup(store: Store = new MemoryStore()) {
  let now = 1_000_000;
  let failSocket = "";
  const sent: string[] = [];
  const queued: string[] = [];
  const alarms: (number | null)[] = [];
  const env = { CONNECTOR_PASSWORD: "pw", DEV_MODE: "1" };
  const transport = {
    broadcast: (data: string) => sent.push(data),
    scheduleAlarm: (at: number | null) => alarms.push(at),
    sendToConnector: (id: string, _data: string) => {
      if (id === failSocket) throw new Error("socket closed");
      queued.push(id);
      return true;
    },
  };
  const app = new OfficeApp(env, store, transport, { now: () => now, log: () => {} });
  const hello = (name: string, id: string) =>
    app.connectorMessage(
      id,
      envelope("connector.hello", {
        name,
        clientId: id,
        password: "pw",
        connectorVersion: "1.0.0",
      }),
    );
  const post = async (body: unknown, path = "/api/messages", headers = {}) =>
    (await app.handleHttp(
      new Request(`http://x${path}`, {
        method: "POST",
        headers: { authorization: "Bearer pw", "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    ))!;
  const page = async (q = "", cookie = "") =>
    MessagePage.parse(
      await (await app.handleHttp(
        new Request(`http://x/api/messages${q}`, {
          headers: { authorization: "Bearer pw", cookie },
        }),
      ))!.json(),
    );
  const body = (extra = {}) => ({
    text: "Lunch!",
    audience: { kind: "everyone" },
    notifyDesktop: false,
    ...extra,
  });
  return {
    app,
    store,
    env,
    transport,
    hello,
    post,
    page,
    body,
    sent,
    queued,
    alarms,
    advance: (ms: number) => (now += ms),
    now: () => now,
    fail: (id: string) => (failSocket = id),
  };
}

describe("small office message service", () => {
  test("one row/event, multi-machine best-effort fanout, no delivery ledger", async () => {
    const s = setup();
    s.hello("Anna", "a1");
    s.hello("Anna", "a2");
    s.hello("Ben", "b1");
    s.sent.length = 0;
    const response = await s.post(
      s.body({ notifyDesktop: true, audience: { kind: "selected", personIds: ["anna", "ben"] } }),
    );
    expect(response.status).toBe(201);
    const result = SendMessageResponse.parse(await response.json());
    expect(result.queued).toBe(3);
    expect(s.queued).toEqual(["a1", "a2", "b1"]);
    expect(result.message.recipients.map((p) => p.name)).toEqual(["Anna", "Ben"]);
    expect(result.message).not.toHaveProperty("delivery");
    expect(s.sent.filter((e) => JSON.parse(e).type === "message.sent")).toHaveLength(1);
    expect((await s.page()).messages).toEqual([result.message]);
    expect(JSON.stringify(s.store.history())).not.toContain("Lunch!");
  });
  test("office-wide alerts write cooldowns once, quick pokes and legacy messages stay transient/in memory", async () => {
    const s = setup();
    s.hello("Anna", "a");
    s.hello("Ben", "b");
    let writes = 0;
    const put = s.store.kvPut.bind(s.store);
    s.store.kvPut = (key, value) => {
      if (key === "notifications.cooldowns") writes++;
      put(key, value);
    };
    await s.post({ kind: "wave", personId: "anna" }, "/api/interact");
    expect(writes).toBe(0);
    s.advance(10_000);
    const response = SendMessageResponse.parse(
      await (await s.post(s.body({ notifyDesktop: true }))).json(),
    );
    expect(response.queued).toBe(2);
    expect(writes).toBe(1);
    s.advance(10_000);
    s.sent.length = 0;
    expect(
      await (
        await s.post({ kind: "message", personId: "anna", text: "Legacy" }, "/api/interact")
      ).json(),
    ).toEqual({ ok: true, delivered: 1 });
    expect(writes).toBe(1);
    expect(s.sent.map((e) => JSON.parse(e).type)).toEqual(["interaction.happened"]);
    expect(JSON.parse(s.sent[0]!).data).not.toHaveProperty("messageId");
    expect((await s.page()).messages).toHaveLength(1);
  });
  test("cooldown/offline/socket failures do not prevent saving; broad notify cooldown remains stored", async () => {
    const s = setup();
    s.hello("Anna", "a");
    s.hello("Ben", "b");
    s.hello("Offline", "o");
    s.app.connectorClosed("o");
    await s.post({ kind: "wave", personId: "anna" }, "/api/interact");
    s.advance(2000);
    s.fail("b");
    const saved = SendMessageResponse.parse(
      await (await s.post(s.body({ notifyDesktop: true }))).json(),
    );
    expect(saved.queued).toBe(0);
    expect((await s.page()).messages).toHaveLength(1);
    const restarted = new OfficeApp(s.env, s.store, s.transport, { now: s.now, log: () => {} });
    const capped = await restarted.handleHttp(
      new Request("http://x/api/messages", {
        method: "POST",
        headers: { authorization: "Bearer pw", "content-type": "application/json" },
        body: JSON.stringify(s.body({ notifyDesktop: true })),
      }),
    );
    expect(capped?.status).toBe(429);
    s.advance(2000);
    expect((await s.post(s.body())).status).toBe(201);
  });
  test("empty office, atomic unknown recipients, validation, auth and origin", async () => {
    const s = setup();
    expect(
      (await s.post(s.body({ audience: { kind: "selected", personIds: ["gone"] } }))).status,
    ).toBe(422);
    expect((await s.post(s.body({ text: "  " }))).status).toBe(400);
    expect((await s.post(s.body(), undefined, { origin: "https://evil.test" })).status).toBe(403);
    expect((await s.post(s.body(), undefined, { "content-type": "text/plain" })).status).toBe(415);
    expect((await s.post(s.body(), undefined, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await s.app.handleHttp(new Request("http://x/api/messages")))?.status).toBe(401);
    expect((await s.post(s.body())).status).toBe(201);
    expect((await s.page()).messages[0]?.recipients).toEqual([]);
  });
  test("reads/restore do not prune; visibility expires at 24h and physical cleanup batches to the hour", async () => {
    const s = setup();
    let prunes = 0;
    const prune = s.store.pruneMessages.bind(s.store);
    s.store.pruneMessages = (now) => {
      prunes++;
      prune(now);
    };
    s.app.restore([]);
    await s.page();
    expect(prunes).toBe(0);
    await s.post(s.body());
    expect(prunes).toBe(1);
    const expiry = s.now() + MESSAGE_RETENTION_MS;
    const deadline = Math.ceil(expiry / MESSAGE_EXPIRY_BATCH_MS) * MESSAGE_EXPIRY_BATCH_MS;
    expect(s.alarms.at(-1)).toBe(deadline);
    expect(deadline - expiry).toBeLessThan(MESSAGE_EXPIRY_BATCH_MS);
    s.advance(MESSAGE_RETENTION_MS);
    expect((await s.page()).messages).toEqual([]);
    expect(prunes).toBe(1);
    expect(s.store.messages({ limit: 100 })).toHaveLength(1);
    s.app.restore([]);
    expect(prunes).toBe(1);
    s.advance(deadline - s.now());
    s.app.alarm();
    expect(prunes).toBe(2);
    expect(s.store.messages({ limit: 100 })).toEqual([]);
  });
  test("200/day cap persists across IPs/restarts; deleting does not refund it; UTC midnight resets", async () => {
    const s = setup();
    let lastCookie = "";
    let lastId = "";
    for (let i = 0; i < MESSAGE_DAILY_CAP; i++) {
      const response = await s.post(s.body(), undefined, { "cf-connecting-ip": `ip-${i}` });
      expect(response.status).toBe(201);
      lastCookie = response.headers.get("set-cookie")!.split(";")[0]!;
      lastId = SendMessageResponse.parse(await response.json()).message.id;
    }
    const remove = await s.app.handleHttp(
      new Request(`http://x/api/messages/${lastId}`, {
        method: "DELETE",
        headers: {
          authorization: "Bearer pw",
          cookie: lastCookie,
          "content-type": "application/json",
        },
      }),
    );
    expect(remove?.status).toBe(200);
    expect(JSON.parse(s.store.kvGet("messages.daily")!).count).toBe(MESSAGE_DAILY_CAP);
    const restarted = new OfficeApp(s.env, s.store, s.transport, { now: s.now, log: () => {} });
    const post = () =>
      restarted.handleHttp(
        new Request("http://x/api/messages", {
          method: "POST",
          headers: { authorization: "Bearer pw", "content-type": "application/json" },
          body: JSON.stringify(s.body()),
        }),
      );
    expect((await post())?.status).toBe(429);
    s.advance(86_400_000);
    expect((await post())?.status).toBe(201);
    expect(JSON.parse(s.store.kvGet("messages.daily")!).count).toBe(1);
  });
  test("only the sending browser can delete, with no ownership secrets in history/events", async () => {
    const s = setup();
    const response = await s.post(s.body({ from: "Unverified" }));
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const { message } = SendMessageResponse.parse(await response.json());
    expect((await s.page("", cookie)).ownedIds).toEqual([message.id]);
    expect((await s.page()).ownedIds).toEqual([]);
    expect(JSON.stringify(await s.page())).not.toContain("ownerHash");
    expect(s.sent.join("")).not.toContain("ownerHash");
    const remove = (headers = {}) =>
      s.app.handleHttp(
        new Request(`http://x/api/messages/${message.id}`, {
          method: "DELETE",
          headers: { authorization: "Bearer pw", "content-type": "application/json", ...headers },
        }),
      );
    expect((await remove())?.status).toBe(403);
    expect((await remove({ cookie, origin: "https://evil.test" }))?.status).toBe(403);
    expect((await remove({ cookie }))?.status).toBe(200);
    expect((await remove({ cookie }))?.status).toBe(404);
    expect(s.store.findMessageById(message.id)).toBeNull();
    expect((await s.page()).messages).toEqual([]);
    expect(s.sent.filter((e) => JSON.parse(e).type === "message.deleted")).toHaveLength(1);
  });
  test("storage failure sends nothing and warns rather than promising a safe retry", async () => {
    const s = setup();
    s.hello("Anna", "a");
    s.sent.length = 0;
    s.store.insertMessage = () => {
      throw new Error("storage unavailable");
    };
    const response = await s.post(s.body({ notifyDesktop: true }));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("check history before sending again");
    expect(s.queued).toEqual([]);
    expect(s.sent).toEqual([]);
  });
  test("chunked oversized bodies are rejected before storage", async () => {
    const s = setup();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(17000)));
        controller.close();
      },
    });
    expect(
      (
        await s.app.handleHttp(
          new Request("http://x/api/messages", {
            method: "POST",
            headers: { authorization: "Bearer pw", "content-type": "application/json" },
            body: stream,
          }),
        )
      )?.status,
    ).toBe(413);
    expect(s.store.messageHead()).toBe(0);
  });
});
