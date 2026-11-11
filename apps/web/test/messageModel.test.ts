import { expect, test } from "bun:test";
import { MESSAGE_RETENTION_MS, type MessagePage, type MessageRecord } from "@agent-office/protocol";
import { MessageModel, messageRetryExpired } from "../src/state/messageModel.ts";

export const message = (seq: number): MessageRecord => ({
  id: `message-${seq}`,
  seq,
  ts: 1_000_000,
  text: `text ${seq}`,
  audience: "everyone",
  recipients: [],
  notifyDesktop: false,
  delivery: { people: [], socketSends: 0 },
});
export const page = (
  seqs: number[],
  head = seqs.at(-1) ?? 0,
  extra: Partial<MessagePage> = {},
): MessagePage => ({
  messages: seqs.map(message),
  head,
  older: null,
  next: seqs.at(-1) ?? head,
  hasMore: false,
  gap: false,
  retention: { maxAgeMs: MESSAGE_RETENTION_MS, maxRows: 1000, expiresAt: null },
  ...extra,
});
test("uncertain retries expire at either retention bound, not only after seven days", () => {
  expect(messageRetryExpired(1000, 10, 2000, 1009)).toBe(false);
  expect(messageRetryExpired(1000, 10, 2000, 1010)).toBe(true);
  expect(messageRetryExpired(1000, 10, 1000 + MESSAGE_RETENTION_MS, 11)).toBe(true);
});

test("first load/live and POST echoes merge without advancing the catch-up cursor", () => {
  const model = new MessageModel(null, () => 1_000_000);
  model.receive(message(6));
  model.page(page([3, 4, 5], 5, { older: 3 }), "initial");
  expect(model.rows.map((m) => m.seq)).toEqual([3, 4, 5, 6]);
  expect(model.cursor).toBe(5);
  expect(model.unread).toBe(1);
  expect(model.receive(message(6))).toBe(false);
  model.receive(message(9));
  expect(model.cursor).toBe(5);
  model.page(page([6, 7], 9, { hasMore: true }), "catchup");
  expect(model.cursor).toBe(7);
  model.page(page([8, 9], 9), "catchup");
  expect(model.cursor).toBe(9);
  expect(model.rows.map((m) => m.seq)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  expect(model.unread).toBe(4);
});
test("read state requires visible expanded bottom of unfiltered contiguous history", () => {
  const model = new MessageModel(1, () => 1_000_000);
  model.page(page([1, 2]), "initial");
  for (const args of [
    [false, true, true],
    [true, false, true],
    [true, true, false],
  ] as const) {
    model.markRead(args[0], args[1], args[2]);
    expect(model.unread).toBe(1);
  }
  model.receive(message(5));
  model.markRead(true, true, true);
  expect(model.lastRead).toBe(2); // cannot skip 3/4 just because 5 is live
  expect(model.unread).toBe(1);
  model.page(page([3, 4, 5]), "catchup");
  model.markRead(true, true, true);
  expect(model.unread).toBe(0);
  model.page(page([1], 5), "older");
  expect(model.unread).toBe(0);
});
test("retention and gap resets remove old content but preserve racing newer events", () => {
  let now = 1_000_000;
  const model = new MessageModel(1, () => now);
  model.page(page([1, 2]), "initial");
  model.receive(message(10));
  model.page(page([7, 8, 9], 9), "initial");
  expect(model.rows.map((m) => m.seq)).toEqual([7, 8, 9, 10]);
  expect(model.unread).toBe(4); // never sequence subtraction
  now += MESSAGE_RETENTION_MS;
  model.prune();
  expect(model.rows).toEqual([]);
  expect(model.unread).toBe(0);
  model.clear();
  expect(model.initialized).toBe(false);
});
test("client window is bounded without virtualizing or storing message bodies locally", () => {
  const model = new MessageModel(null, () => 1_000_000);
  for (let i = 1; i <= 1003; i++) model.receive(message(i));
  expect(model.rows.length).toBe(1000);
  expect(model.rows[0]?.seq).toBe(4);
});
