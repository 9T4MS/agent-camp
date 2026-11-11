import { expect, test } from "bun:test";
import {
  MESSAGE_MAX_ROWS,
  MESSAGE_RETENTION_MS,
  type MessagePage,
  type MessageRecord,
} from "@agent-office/protocol";
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
  retention: { maxAgeMs: MESSAGE_RETENTION_MS, maxRows: MESSAGE_MAX_ROWS, expiresAt: null },
  ...extra,
});
test("uncertain retries expire at either the 24-hour or 100-row retention bound", () => {
  expect(messageRetryExpired(1000, 10, 2000, 10 + MESSAGE_MAX_ROWS - 1)).toBe(false);
  expect(messageRetryExpired(1000, 10, 2000, 10 + MESSAGE_MAX_ROWS)).toBe(true);
  expect(messageRetryExpired(1000, 10, 1000 + MESSAGE_RETENTION_MS, 11)).toBe(true);
});

test("contiguous live/POST echoes advance the cursor, but higher events cannot skip gaps", () => {
  const model = new MessageModel(null, () => 1_000_000);
  model.receive(message(6));
  model.page(page([3, 4, 5], 5, { older: 3 }), "initial");
  expect(model.rows.map((m) => m.seq)).toEqual([3, 4, 5, 6]);
  expect(model.cursor).toBe(6);
  expect(model.unread).toBe(1);
  expect(model.receive(message(6))).toBe(false);
  model.receive(message(9));
  expect(model.cursor).toBe(6);
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
test("deletion wins over racing history, including a previously owned message", () => {
  const model = new MessageModel(null, () => 1_000_000);
  model.page(page([1, 2], 2, { ownedIds: ["message-2"] }), "initial");
  expect(model.ownedIds.has("message-2")).toBe(true);
  model.remove("message-2");
  model.page(page([1, 2], 2, { ownedIds: ["message-2"] }), "initial");
  expect(model.rows.map((m) => m.seq)).toEqual([1]);
  expect(model.ownedIds.size).toBe(0);
  expect(model.receive(message(2))).toBe(false);
});

test("deleted slots still bound how far back a live viewer retains bodies", () => {
  const model = new MessageModel(null, () => 1_000_000);
  model.page(page(Array.from({ length: MESSAGE_MAX_ROWS }, (_, i) => i + 1)), "initial");
  for (let i = 2; i <= MESSAGE_MAX_ROWS; i++) model.remove(`message-${i}`);
  model.receive(message(MESSAGE_MAX_ROWS + 1));
  expect(model.rows.map((m) => m.seq)).toEqual([MESSAGE_MAX_ROWS + 1]);
});

test("client window is bounded without virtualizing or storing message bodies locally", () => {
  const model = new MessageModel(null, () => 1_000_000);
  for (let i = 1; i <= MESSAGE_MAX_ROWS + 3; i++) model.receive(message(i));
  expect(model.rows.length).toBe(MESSAGE_MAX_ROWS);
  expect(model.rows[0]?.seq).toBe(4);
});
