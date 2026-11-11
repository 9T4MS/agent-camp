import { describe, expect, test } from "bun:test";
import { envelope, type SessionView, type ViewerEvent } from "@agent-office/protocol";
import type { OfficeState } from "../../src/core/diff.ts";
import { ShameTracker } from "../../src/core/shame.ts";
import { MemoryStore } from "../../src/core/store.ts";

const sv = (id: string, extra: Partial<SessionView> = {}): SessionView => ({
  sessionId: id,
  agent: "claude",
  activity: "typing",
  subagents: 0,
  startedAt: 0,
  ...extra,
});
const started = (person: string, id: string, extra: Partial<SessionView> = {}): ViewerEvent =>
  envelope("session.started", { personId: person, session: sv(id, extra) });
const ended = (person: string, id: string): ViewerEvent =>
  envelope("session.ended", { personId: person, sessionId: id });
const act = (
  person: string,
  id: string,
  activity: "waiting" | "typing",
  previous: "waiting" | "typing",
): ViewerEvent =>
  envelope("session.activityChanged", { personId: person, sessionId: id, activity, previous });
const EMPTY: OfficeState = { people: [] };

describe("wall of shame", () => {
  test("clears, longest waits and fires per person, persisted per day", () => {
    const store = new MemoryStore();
    const t = new ShameTracker(store, () => "2026-11-11");
    t.record([ended("anna", "a1")], EMPTY, 1_000);
    t.record([started("anna", "a2")], EMPTY, 5_000);
    t.record([ended("anna", "a2")], EMPTY, 10_000);
    t.record([started("anna", "a3")], EMPTY, 30_000); // too late: not a /clear
    t.record([act("bob", "b1", "waiting", "typing")], EMPTY, 0);
    t.record([act("bob", "b1", "typing", "waiting")], EMPTY, 60_000);
    t.record([act("bob", "b1", "waiting", "typing")], EMPTY, 70_000);
    const prev: OfficeState = {
      people: [
        {
          personId: "bob",
          name: "Bob",
          avatar: {} as never,
          joinedAt: 0,
          sessions: [sv("b1", { context: 0.5 })],
        },
      ],
    };
    t.record(
      [envelope("session.contextChanged", { personId: "bob", sessionId: "b1", context: 0.85 })],
      prev,
      80_000,
    );
    const s = t.snapshot(200_000);
    expect(s.clears).toEqual({ anna: 1 });
    expect(s.fires).toEqual({ bob: 1 });
    // the running wait (since 70 s) beats the finished 60 s one
    expect(s.longestWaitMs).toEqual({ bob: 130_000 });
    const again = new ShameTracker(store, () => "2026-11-11");
    expect(again.snapshot(0).clears).toEqual({ anna: 1 });
    expect(new ShameTracker(store, () => "2026-11-12").snapshot(0).clears).toEqual({});
  });

  test("a wait survives a restart of the tracker", () => {
    const store = new MemoryStore();
    const day = () => "2026-11-11";
    new ShameTracker(store, day).record([act("bob", "b1", "waiting", "typing")], EMPTY, 0);
    const restarted = new ShameTracker(store, day);
    expect(restarted.snapshot(60_000).longestWaitMs).toEqual({ bob: 60_000 });
    restarted.record([act("bob", "b1", "typing", "waiting")], EMPTY, 3_600_000);
    expect(new ShameTracker(store, day).snapshot(4_000_000).longestWaitMs).toEqual({
      bob: 3_600_000,
    });
  });

  test("writes nothing when no number changed", () => {
    const store = new MemoryStore();
    const t = new ShameTracker(store, () => "2026-11-11");
    t.record([ended("anna", "a1")], EMPTY, 1_000);
    t.record([act("anna", "a2", "typing", "waiting")], EMPTY, 2_000);
    expect(store.kvGet("shame.2026-11-11")).toBeNull();
    expect(store.kvGet("shame.")).toBeNull();
  });
});
