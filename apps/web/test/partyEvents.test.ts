import { expect, test } from "bun:test";
import type { PartyEvent } from "@agent-office/protocol";
import { PartyInbox } from "../src/world/party.ts";

const event = (id: string, at: number): PartyEvent => ({
  id,
  at,
  personId: "anna",
  action: "use",
  item: "confetti",
  vehicle: "none",
});

test("ordinary office messages cannot replay an old move after deduplication expires", () => {
  const inbox = new PartyInbox();
  const move = event("a", 100_000);
  expect(inbox.take([move], 100_000)).toEqual([move]);
  expect(inbox.take([move], 110_000)).toEqual([]);
  expect(inbox.take([move], 115_000)).toEqual([]);
  // The model may retain this last party state while receiving unrelated presence messages.
  expect(inbox.take([move], 170_000)).toEqual([]);
  expect(inbox.take([move], 240_000)).toEqual([]);
  const fresh = event("b", 240_000);
  expect(inbox.take([move, fresh], 240_000)).toEqual([fresh]);
  expect(inbox.take([fresh], 240_100)).toEqual([]);
});

test("reconnecting viewers play only recent moves, preserving a burst's order", () => {
  const inbox = new PartyInbox();
  const first = event("a", 86_000);
  const second = event("b", 100_000);
  expect(inbox.take([event("expired", 85_000), first, second], 100_000)).toEqual([first, second]);
  expect(inbox.take([first, second], 101_000)).toEqual([]);
});
