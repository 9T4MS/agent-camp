import { describe, expect, test } from "bun:test";
import { parseConnectorMessage } from "@agent-office/protocol";
import { dryRun } from "../src/runner.ts";
import { SCENARIOS } from "../src/scenarios.ts";

const sessionsOf = (r: ReturnType<typeof dryRun>) => r.world.liveSessions().map((x) => x.session);

describe("scenario generators", () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario} is deterministic per seed`, () => {
      const a = dryRun({ scenario, seed: 7, maxSteps: 400 });
      const b = dryRun({ scenario, seed: 7, maxSteps: 400 });
      expect(JSON.stringify(a.steps)).toBe(JSON.stringify(b.steps));
      expect(a.settledAt).not.toBeNull();
    });

    test(`${scenario} only produces schema-valid connector messages`, () => {
      for (const chaos of [false, true]) {
        const r = dryRun({ scenario, seed: 3, chaos, maxSteps: 600 });
        for (const m of r.messages) {
          const p = parseConnectorMessage(JSON.stringify(m));
          if (!p.ok) throw new Error(p.error);
        }
      }
    });
  }

  test("different seeds give different live runs", () => {
    const a = dryRun({ scenario: "live", seed: 1, maxSteps: 200 });
    const b = dryRun({ scenario: "live", seed: 2, maxSteps: 200 });
    expect(JSON.stringify(a.steps)).not.toBe(JSON.stringify(b.steps));
  });

  test("empty connects nothing", () => {
    const r = dryRun({ scenario: "empty", maxSteps: 20 });
    expect(r.messages).toHaveLength(0);
    expect(r.settledAt).toBe(0);
  });

  test("one = 1 person, 1 claude session typing", () => {
    const r = dryRun({ scenario: "one", maxSteps: 20 });
    expect(r.world.expectedPeople()).toEqual(new Map([["anna", 1]]));
    const [s] = sessionsOf(r);
    expect(s?.agent).toBe("claude");
    expect(s?.activity).toBe("typing");
  });

  test("busy = 6 people, mixed agents, 8 subagents somewhere, one waiting, two laptops", () => {
    const r = dryRun({ scenario: "busy", maxSteps: 60 });
    expect(r.world.expectedPeople().size).toBe(6);
    const s = sessionsOf(r);
    expect(new Set(s.map((x) => x.agent))).toEqual(new Set(["claude", "codex", "pi", "unknown"]));
    expect(s.some((x) => x.subagents === 8)).toBe(true);
    expect(s.filter((x) => x.activity === "waiting")).toHaveLength(1);
    const martin = r.world.online().filter((l) => l.personId === "martin");
    expect(martin).toHaveLength(2);
  });

  test("busy holds still after settling", () => {
    const r = dryRun({ scenario: "busy", maxSteps: 200 });
    const after = r.steps.filter((s) => s.t > (r.settledAt ?? 0));
    expect(after.every((s) => s.step.op === "wait")).toBe(true);
  });

  test("stress = 12 people, 30 sessions at settle, then keeps changing", () => {
    const r = dryRun({ scenario: "stress", maxSteps: 2000 });
    const settleIdx = r.steps.findIndex((s) => s.step.op === "settled");
    const before = dryRun({ scenario: "stress", maxSteps: settleIdx + 1 });
    expect(before.world.expectedPeople().size).toBe(12);
    expect(sessionsOf(before)).toHaveLength(30);
    const changes = r.steps.slice(settleIdx).filter((s) => s.step.op === "activity");
    expect(changes.length).toBeGreaterThan(100);
  });

  test("join adds a person roughly every 8 s after settling", () => {
    const r = dryRun({ scenario: "join", untilMs: 60_000, maxSteps: 10_000 });
    const joins = r.steps.filter((s) => s.step.op === "connect" && s.t > (r.settledAt ?? 0));
    expect(joins.length).toBeGreaterThanOrEqual(6);
    expect(joins.length).toBeLessThanOrEqual(8);
  });

  test("live drops one laptop without a bye", () => {
    const r = dryRun({ scenario: "live", seed: 42, maxSteps: 400 });
    expect(r.steps.some((s) => s.step.op === "drop")).toBe(true);
    expect(r.steps.some((s) => s.step.op === "bye")).toBe(false);
  });

  test("live respects --people and --sessions-per-person while joining", () => {
    const r = dryRun({ scenario: "live", people: 4, sessionsPerPerson: [2, 2], maxSteps: 10_000 });
    const idx = r.steps.findIndex((s) => s.step.op === "settled");
    const settled = dryRun({
      scenario: "live",
      people: 4,
      sessionsPerPerson: [2, 2],
      maxSteps: idx + 1,
    });
    expect([...settled.world.expectedPeople().values()]).toEqual([2, 2, 2, 2]);
  });
});
