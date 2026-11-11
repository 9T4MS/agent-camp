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
import { MemoryStore, SqlStore, type Store } from "../../src/core/store.ts";

const record = (n: number, ts = 1_000_000): Omit<MessageRecord, "seq"> => ({
  id: `message-${n}`,
  ts,
  text: `hello ${n}`,
  audience: "everyone",
  recipients: [],
  notifyDesktop: false,
  delivery: { people: [], socketSends: 0 },
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
    test("deletion erases content/payload but retains bounded retry tombstones and private ownership", () => {
      const store = make();
      const inserted = store.insertMessage("request", "PRIVATE_PAYLOAD", record(1), "owner-hash");
      store.deleteMessage(inserted.id);
      expect(store.messages({ limit: 100 })).toEqual([]);
      expect(store.findMessage("request")?.message).toBeNull();
      expect(store.findMessage("request")?.payload).toBe("");
      expect(store.findMessageById(inserted.id)?.ownerHash).toBe("owner-hash");
      store.updateMessage(inserted); // a late delivery update must not restore a deleted body
      expect(store.findMessage("request")?.message).toBeNull();
      store.pruneMessages(1_000_000 + MESSAGE_RETENTION_MS);
      expect(store.findMessage("request")).toBeNull();
      expect(store.messageHead()).toBe(1);
    });
    test("bounded retention, both cursor directions, request lookup and monotonic empty watermark", () => {
      const store = make();
      for (let n = 1; n <= MESSAGE_MAX_ROWS + 2; n++)
        store.insertMessage(`request-${n}`, `payload-${n}`, record(n));
      store.pruneMessages(1_000_000);
      expect(store.messages({ after: 0, limit: 2 }).map((m) => m.seq)).toEqual([3, 4]);
      expect(store.messages({ before: 6, limit: 2 }).map((m) => m.seq)).toEqual([4, 5]);
      expect(store.messages({ limit: 2 }).map((m) => m.seq)).toEqual([
        MESSAGE_MAX_ROWS + 1,
        MESSAGE_MAX_ROWS + 2,
      ]);
      expect(store.findMessage("request-1")).toBeNull();
      expect(store.findMessage("request-3")?.payload).toBe("payload-3");
      const found = store.findMessage("request-3")!.message!;
      found.text = "updated";
      store.updateMessage(found);
      expect(store.findMessage("request-3")?.message?.text).toBe("updated");
      expect(store.nextMessageExpiry()).toBe(1_000_000 + MESSAGE_RETENTION_MS);
      store.pruneMessages(1_000_000 + MESSAGE_RETENTION_MS);
      expect(store.messages({ limit: 100 })).toEqual([]);
      expect(store.messageHead()).toBe(MESSAGE_MAX_ROWS + 2);
      expect(store.nextMessageExpiry()).toBeNull();
      expect(store.insertMessage("new", "new", record(MESSAGE_MAX_ROWS + 3)).seq).toBe(
        MESSAGE_MAX_ROWS + 3,
      );
    });
  });
}
test("SQLite restart/migration preserves existing data and message request IDs", () => {
  const db = new Database(":memory:");
  const first = sql(db);
  first.putAvatar("a", avatarFromSeed("a"), "k");
  first.appendHistory([{ type: "person.joined", person: "a", ts: 1 }]);
  first.addSnapshot(1, new Uint8Array([1, 2]));
  first.insertMessage("request", "payload", record(1));
  const second = sql(db);
  expect(second.findMessage("request")?.message?.seq).toBe(1);
  expect(second.getAvatar("a")?.key).toBe("k");
  expect(second.history()).toHaveLength(1);
  expect(second.getSnapshot(1)).toEqual(new Uint8Array([1, 2]));
  second.pruneMessages(1_000_000 + MESSAGE_RETENTION_MS);
  expect(sql(db).messageHead()).toBe(1);
});

function setup(store: Store = new MemoryStore()) {
  let now = 1_000_000;
  const sent: string[] = [];
  const queued: string[] = [];
  const alarms: (number | null)[] = [];
  let failSocket = "";
  const env = { CONNECTOR_PASSWORD: "pw", DEV_MODE: "1" };
  const transport = {
    broadcast: (s: string) => sent.push(s),
    scheduleAlarm: (at: number | null) => alarms.push(at),
    sendToConnector: (id: string, _s: string) => {
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
  const request = (body: unknown, path = "/api/messages", headers = {}) =>
    new Request(`http://x${path}`, {
      method: "POST",
      headers: { authorization: "Bearer pw", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const post = async (body: unknown, path?: string, headers?: Record<string, string>) =>
    (await app.handleHttp(request(body, path, headers)))!;
  const page = async (q = "") =>
    MessagePage.parse(
      await (await app.handleHttp(
        new Request(`http://x/api/messages${q}`, { headers: { authorization: "Bearer pw" } }),
      ))!.json(),
    );
  const body = (extra = {}) => ({
    requestId: crypto.randomUUID(),
    text: "Lunch!",
    audience: { kind: "everyone" },
    notifyDesktop: false,
    ...extra,
  });
  return {
    app,
    store,
    hello,
    post,
    page,
    body,
    sent,
    queued,
    alarms,
    transport,
    env,
    advance: (ms: number) => (now += ms),
    now: () => now,
    fail: (id: string) => (failSocket = id),
  };
}

describe("authored messages service", () => {
  test("multi-machine fanout, one canonical event, name snapshots, no status content", async () => {
    const s = setup();
    s.hello("Anna", "a1");
    s.hello("Anna", "a2");
    s.hello("Ben", "b1");
    s.sent.length = 0;
    const request = s.body({
      notifyDesktop: true,
      audience: { kind: "selected", personIds: ["anna", "ben"] },
    });
    const response = await s.post(request);
    expect(response.status).toBe(201);
    const { message } = SendMessageResponse.parse(await response.json());
    expect(message.recipients.map((r) => r.name)).toEqual(["Anna", "Ben"]);
    expect(message.delivery).toEqual({
      socketSends: 3,
      people: [
        { personId: "anna", status: "queued" },
        { personId: "ben", status: "queued" },
      ],
    });
    expect(s.queued).toEqual(["a1", "a2", "b1"]);
    expect(s.sent.filter((m) => JSON.parse(m).type === "message.sent")).toHaveLength(1);
    expect(JSON.stringify(s.store.history())).not.toContain("Lunch!");
    const retry = await s.post(request);
    expect(retry.status).toBe(200);
    expect(SendMessageResponse.parse(await retry.json()).message).toEqual(message);
    expect(s.queued).toHaveLength(3);
    expect((await s.post({ ...request, text: "Changed" })).status).toBe(409);
    expect((await s.page()).messages).toEqual([message]);
    expect(
      (await s.post({ ...request, audience: { kind: "selected", personIds: ["ben", "anna"] } }))
        .status,
    ).toBe(200);
  });
  test("offline, cooldown and partial socket errors save history independently", async () => {
    const s = setup();
    s.hello("Anna", "a");
    s.hello("Ben", "b");
    s.hello("Offline", "o");
    s.app.connectorClosed("o");
    await s.post({ kind: "wave", personId: "anna" }, "/api/interact");
    s.advance(2000);
    s.fail("b");
    const result = SendMessageResponse.parse(
      await (await s.post(s.body({ notifyDesktop: true }))).json(),
    );
    expect(result.message.delivery.people).toEqual([
      { personId: "anna", status: "cooldown" },
      { personId: "ben", status: "unknown" },
      { personId: "offline", status: "offline" },
    ]);
    expect((await s.page()).messages).toHaveLength(1);
    s.advance(2000);
    expect((await s.post(s.body({ notifyDesktop: true }))).status).toBe(429);
    expect((await s.post(s.body())).status).toBe(201);
  });
  test("empty broadcasts, atomic unknown recipients, validation, origin and auth", async () => {
    const s = setup();
    expect(
      (await s.post(s.body({ audience: { kind: "selected", personIds: ["gone"] } }))).status,
    ).toBe(422);
    expect((await s.post(s.body({ text: "  " }))).status).toBe(400);
    expect((await s.post(s.body(), undefined, { origin: "https://evil.test" })).status).toBe(403);
    expect((await s.post(s.body(), undefined, { "content-type": "text/plain" })).status).toBe(415);
    expect((await s.post(s.body(), undefined, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await s.app.handleHttp(new Request("http://x/api/messages")))!.status).toBe(401);
    expect((await s.post(s.body())).status).toBe(201);
    expect((await s.page()).messages[0]?.recipients).toEqual([]);
    expect(
      (await s.app.handleHttp(
        new Request("http://x/api/messages?after=-1", { headers: { authorization: "Bearer pw" } }),
      ))!.status,
    ).toBe(400);
  });
  test("legacy message persists once with additive bubble link, other pokes stay transient", async () => {
    const s = setup();
    s.hello("Anna", "a");
    s.sent.length = 0;
    expect(
      await (
        await s.post({ kind: "message", personId: "anna", text: "Hi" }, "/api/interact")
      ).json(),
    ).toEqual({ ok: true, delivered: 1 });
    const events = s.sent.map((m) => JSON.parse(m));
    expect(events.map((m) => m.type)).toEqual(["message.sent", "interaction.happened"]);
    expect(events[1].data.messageId).toBe(events[0].data.message.id);
    expect((await s.page()).messages).toHaveLength(1);
    s.advance(2000);
    await s.post({ kind: "paper", personId: "anna" }, "/api/interact");
    expect((await s.page()).messages).toHaveLength(1);
  });
  test("coordinated alarm expires idle history and catch-up reports retention gaps", async () => {
    const s = setup();
    for (let i = 0; i < 4; i++) {
      await s.post(s.body());
      s.advance(2000);
    }
    expect((await s.page("?limit=2")).messages.map((m) => m.seq)).toEqual([3, 4]);
    expect((await s.page("?before=3&limit=2")).messages.map((m) => m.seq)).toEqual([1, 2]);
    expect((await s.page("?after=1&limit=2")).hasMore).toBe(true);
    expect(s.alarms.at(-1)).toBe(1_000_000 + MESSAGE_RETENTION_MS);
    s.advance(MESSAGE_RETENTION_MS);
    s.app.alarm();
    expect(s.store.messageHead()).toBe(4);
    expect((await s.page("?after=1")).gap).toBe(true);
    expect(s.alarms.at(-1)).toBeNull();
  });
  test("office-wide daily cap survives restart, cannot be bypassed by IP, and resets at UTC midnight", async () => {
    const s = setup();
    let first: ReturnType<typeof s.body> | null = null;
    let latest: ReturnType<typeof s.body> | null = null;
    for (let i = 0; i < MESSAGE_DAILY_CAP; i++) {
      const body = s.body();
      first ??= body;
      latest = body;
      expect((await s.post(body, undefined, { "cf-connecting-ip": `ip-${i}` })).status).toBe(201);
    }
    const restarted = new OfficeApp(s.env, s.store, s.transport, { now: s.now, log: () => {} });
    const post = (body: unknown) =>
      restarted.handleHttp(
        new Request("http://x/api/messages", {
          method: "POST",
          headers: {
            authorization: "Bearer pw",
            "content-type": "application/json",
            "cf-connecting-ip": "new-ip",
          },
          body: JSON.stringify(body),
        }),
      );
    expect((await post(s.body()))?.status).toBe(429);
    // A retained identical retry is free and still works at the cap.
    expect((await post(latest))?.status).toBe(200);
    const latestRequest = s.body();
    // Old pruned request IDs cannot evade the cap either.
    expect((await post(first))?.status).toBe(429);
    s.advance(86_400_000);
    expect((await post(latestRequest))?.status).toBe(201);
    expect(JSON.parse(s.store.kvGet("messages.daily")!).count).toBe(1);
  });
  test("history reads and restore never prune/write; insert and alarm do", async () => {
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
    s.advance(MESSAGE_RETENTION_MS);
    expect((await s.page()).messages).toEqual([]);
    expect(prunes).toBe(1);
    s.app.restore([]);
    expect(prunes).toBe(1);
    s.app.alarm();
    expect(prunes).toBe(2);
  });
  test("only the sending browser can delete, with no ownership secrets in history/events", async () => {
    const s = setup();
    const request = s.body({ from: "Unverified" });
    const response = await s.post(request);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const { message } = SendMessageResponse.parse(await response.json());
    const history = await s.app.handleHttp(
      new Request("http://x/api/messages", { headers: { authorization: "Bearer pw", cookie } }),
    );
    expect(MessagePage.parse(await history!.json()).ownedIds).toEqual([message.id]);
    const other = await s.page();
    expect(other.ownedIds).toEqual([]);
    expect(JSON.stringify(other)).not.toContain("ownerHash");
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
    expect((await remove({ cookie }))?.status).toBe(200);
    expect((await s.page()).messages).toEqual([]);
    expect(s.store.findMessage(request.requestId)?.payload).toBe("");
    expect((await s.post(request))?.status).toBe(410);
    expect(s.sent.filter((event) => JSON.parse(event).type === "message.deleted")).toHaveLength(1);
  });
  test("storage failure before insertion sends nothing and returns a safe retryable error", async () => {
    const s = setup();
    s.hello("Anna", "a");
    s.sent.length = 0;
    s.store.insertMessage = () => {
      throw new Error("storage unavailable");
    };
    const result = await s.post(s.body({ notifyDesktop: true }));
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("storage unavailable");
    expect(s.queued).toEqual([]);
    expect(s.sent).toEqual([]);
  });
  test("chunked oversized bodies are rejected without storing or alerting", async () => {
    const s = setup();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(17000)));
        controller.close();
      },
    });
    const result = await s.app.handleHttp(
      new Request("http://x/api/messages", {
        method: "POST",
        headers: { authorization: "Bearer pw", "content-type": "application/json" },
        body: stream,
      }),
    );
    expect(result?.status).toBe(413);
    expect(s.store.messageHead()).toBe(0);
    expect(s.queued).toEqual([]);
  });
  test("restart retries and interrupted delivery never replay notifications", async () => {
    const s = setup();
    s.hello("Anna", "a");
    const request = s.body({ notifyDesktop: true });
    // Failure updating the delivery summary keeps the persisted pre-send unknown record.
    s.store.updateMessage = () => {
      throw new Error("storage interrupted");
    };
    expect((await s.post(request)).status).toBe(201);
    expect(s.queued).toHaveLength(1);
    const restored = new OfficeApp(s.env, s.store, s.transport, { now: s.now, log: () => {} });
    restored.restore([]);
    const response = (await restored.handleHttp(
      new Request("http://x/api/messages", {
        method: "POST",
        headers: { authorization: "Bearer pw", "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    ))!;
    expect(response.status).toBe(200);
    expect(
      SendMessageResponse.parse(await response.json()).message.delivery.people[0]?.status,
    ).toBe("unknown");
    expect(s.queued).toHaveLength(1);
    expect(restored.messages.pokeWait("anna", s.now())).toBeGreaterThan(0);
  });
});
