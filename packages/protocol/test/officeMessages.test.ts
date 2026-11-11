import { expect, test } from "bun:test";
import { InteractRequest, MessageQuery, SendMessageRequest } from "../src/index.ts";

const valid = {
  requestId: crypto.randomUUID(),
  text: " hello ",
  audience: { kind: "everyone" },
  notifyDesktop: false,
};
test("message contract is separate from legacy text and rejects ambiguous audiences", () => {
  expect(SendMessageRequest.parse(valid).text).toBe("hello");
  for (const audience of [
    { kind: "everyone", personIds: ["a"] },
    { kind: "selected", personIds: [] },
    { kind: "selected", personIds: ["a", "a"] },
    { kind: "selected", personIds: Array.from({ length: 51 }, (_, i) => String(i)) },
  ])
    expect(SendMessageRequest.safeParse({ ...valid, audience }).success).toBe(false);
  for (const text of ["  \n ", "a".repeat(201), "😀".repeat(101)])
    expect(SendMessageRequest.safeParse({ ...valid, text }).success).toBe(false);
  expect(SendMessageRequest.safeParse({ ...valid, text: "😀".repeat(100) }).success).toBe(true);
  expect(
    InteractRequest.safeParse({ kind: "message", personId: "a", text: "a".repeat(81) }).success,
  ).toBe(false);
  expect(SendMessageRequest.safeParse({ ...valid, requestId: "retry" }).success).toBe(false);
});
test("history cursor validation rejects offsets and unsafe or malformed integers", () => {
  expect(MessageQuery.parse({})).toEqual({ limit: 50 });
  expect(MessageQuery.parse({ after: "0", limit: "100" })).toEqual({ after: 0, limit: 100 });
  for (const q of [
    { after: "-1" },
    { after: "1.5" },
    { after: "9007199254740992" },
    { before: "2", after: "1" },
    { limit: "101" },
    { limit: "0" },
    { after: "1e2" },
  ])
    expect(MessageQuery.safeParse(q).success).toBe(false);
});
