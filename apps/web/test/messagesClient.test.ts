import { expect, test } from "bun:test";
import {
  MESSAGE_MAX_ROWS,
  MESSAGE_RETENTION_MS,
  type MessagePage,
  type MessageRecord,
} from "@agent-office/protocol";
import { MessageRequestError, MessagesClient } from "../src/net/messages.ts";
import { MessageModel } from "../src/state/messageModel.ts";

const message = (seq: number): MessageRecord => ({
  id: `m-${seq}`,
  seq,
  ts: 1_000_000,
  text: "Hi",
  audience: "everyone",
  recipients: [],
  notifyDesktop: false,
  delivery: { people: [], socketSends: 0 },
});
const page = (seqs: number[], head: number, extra = {}): MessagePage => ({
  messages: seqs.map(message),
  head,
  next: seqs.at(-1) ?? head,
  older: null,
  hasMore: false,
  gap: false,
  retention: { maxAgeMs: MESSAGE_RETENTION_MS, maxRows: MESSAGE_MAX_ROWS, expiresAt: null },
  ...extra,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const response = (value: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers });

test("catch-up drains multiple pages even when a higher live event races the request", async () => {
  const model = new MessageModel(null, () => 1_000_000);
  const urls: string[] = [];
  const pending = deferred<Response>();
  let calls = 0;
  const client = new MessagesClient(model, {
    changed: () => {},
    authFailed: () => {},
    key: "view-key",
    fetch: async (url) => {
      urls.push(String(url));
      calls++;
      if (calls === 1) return response(page([1], 1));
      if (calls === 2) return pending.promise;
      if (calls === 3) return response(page([4, 5], 5));
      return response(page([], 5));
    },
  });
  await client.sync();
  const catchup = client.sync();
  client.receive(message(5));
  pending.resolve(response(page([2, 3], 5, { hasMore: true })));
  await catchup;
  await Bun.sleep(0);
  expect(model.rows.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(model.cursor).toBe(5);
  expect(urls[1]).toContain("after=1");
  expect(urls[2]).toContain("after=3");
  expect(urls.every((url) => url.includes("key=view-key"))).toBe(true);
});
test("failed history keeps live rows, retry recovers, gap resets with truthful status", async () => {
  const model = new MessageModel(0, () => 1_000_000);
  let calls = 0;
  const client = new MessagesClient(model, {
    changed: () => {},
    authFailed: () => {},
    fetch: async () => {
      calls++;
      if (calls === 1) throw new Error("offline");
      if (calls === 2) return response(page([1, 2], 2));
      if (calls === 3) return response(page([8], 8, { gap: true }));
      return response(page([7, 8], 8));
    },
  });
  client.receive(message(2));
  await client.sync();
  expect(client.status).toContain("unavailable");
  expect(model.rows).toHaveLength(1);
  await client.sync();
  expect(model.initialized).toBe(true);
  await client.sync();
  expect(client.status).toBe("Older messages expired or were deleted.");
  expect(model.rows.map((m) => m.seq)).toEqual([7, 8]);
});
test("uncertain acknowledgement preserves retry identity; auth clears and blocks stale requests", async () => {
  const model = new MessageModel(null, () => 1_000_000);
  const bodies: string[] = [];
  let calls = 0;
  let loggedOut = 0;
  const client = new MessagesClient(model, {
    changed: () => {},
    authFailed: () => loggedOut++,
    fetch: async (url, init) => {
      if (url.endsWith("/owner")) return response({ ok: true });
      if (init?.body) bodies.push(String(init.body));
      calls++;
      if (calls === 1) throw new Error("lost response");
      if (calls === 2) return response({ ok: true, message: message(1) });
      return response({ error: "unauthorized" }, 401);
    },
  });
  const request = {
    requestId: crypto.randomUUID(),
    audience: { kind: "everyone" as const },
    text: "hello",
    notifyDesktop: false,
  };
  try {
    await client.send(request);
    throw new Error("expected failure");
  } catch (error) {
    expect(error instanceof MessageRequestError && error.uncertain).toBe(true);
  }
  await client.send(request);
  expect(bodies[0]).toBe(bodies[1]);
  await client.sync();
  expect(loggedOut).toBe(1);
  expect(model.rows).toEqual([]);
  client.receive(message(9));
  expect(model.rows).toEqual([]);
  await expect(client.send(request)).rejects.toThrow("login expired");
});
test("an initial-page/live race fetches the missing interval immediately", async () => {
  const pending = deferred<Response>();
  const model = new MessageModel(null, () => 1_000_000);
  const urls: string[] = [];
  const client = new MessagesClient(model, {
    changed: () => {},
    authFailed: () => {},
    fetch: async (url) => {
      urls.push(url);
      if (urls.length === 1) return pending.promise;
      return response(page([4, 5], 5));
    },
  });
  const initial = client.sync();
  client.receive(message(5));
  pending.resolve(response(page([1, 2, 3], 3)));
  await initial;
  await Bun.sleep(0);
  expect(urls[1]).toContain("after=3");
  expect(model.rows.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(model.cursor).toBe(5);
});

test("contiguous live messages cost zero history requests; only a real gap fetches", async () => {
  const model = new MessageModel(null, () => 1_000_000);
  const urls: string[] = [];
  const client = new MessagesClient(model, {
    changed: () => {},
    authFailed: () => {},
    fetch: async (url) => {
      urls.push(url);
      return response(urls.length === 1 ? page([1], 1) : page([4, 5], 5));
    },
  });
  await client.sync();
  client.receive(message(2));
  client.receive(message(3));
  client.receive(message(3));
  expect(urls).toHaveLength(1);
  expect(model.cursor).toBe(3);
  client.receive(message(5));
  await client.sync();
  expect(urls[1]).toContain("after=3");
  expect(model.cursor).toBe(5);
});

test("reconnect replaces stale rows and restores browser-owned delete controls", async () => {
  const model = new MessageModel(null, () => 1_000_000);
  let calls = 0;
  const client = new MessagesClient(model, {
    changed: () => {},
    authFailed: () => {},
    fetch: async () => {
      calls++;
      return response(calls === 1 ? page([1, 2], 2) : page([2], 2, { ownedIds: ["m-2"] }));
    },
  });
  await client.sync();
  await client.sync(true);
  expect(model.rows.map((m) => m.id)).toEqual(["m-2"]);
  expect(model.ownedIds.has("m-2")).toBe(true);
  client.removed("m-2");
  expect(model.rows).toEqual([]);
});

test("in-flight history cannot restore content after logout", async () => {
  const pending = deferred<Response>();
  const model = new MessageModel(null, () => 1_000_000);
  const client = new MessagesClient(model, {
    changed: () => {},
    authFailed: () => {},
    fetch: () => pending.promise,
  });
  const sync = client.sync();
  client.clear();
  pending.resolve(response(page([1], 1)));
  await sync;
  expect(model.rows).toEqual([]);
});
