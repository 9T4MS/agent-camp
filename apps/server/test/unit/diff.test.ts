import { describe, expect, test } from "bun:test";
import {
  type Activity,
  type AgentKind,
  avatarFromSeed,
  type PersonView,
  parseViewerMessage,
  type SessionView,
  type ViewerEvent,
} from "@agent-office/protocol";
import { applyEvents, diff, EMPTY_STATE, type OfficeState } from "../../src/core/diff.ts";

const sess = (
  id: string,
  over: Partial<{ agent: AgentKind; activity: Activity; subagents: number; project: string }> = {},
): SessionView => ({
  sessionId: `c1:${id}`,
  agent: over.agent ?? "claude",
  project: over.project ?? "agent-office",
  activity: over.activity ?? "typing",
  subagents: over.subagents ?? 0,
  startedAt: 1000,
});

const person = (id: string, sessions: SessionView[] = [], joinedAt = 1): PersonView => ({
  personId: id,
  name: id[0]!.toUpperCase() + id.slice(1),
  avatar: avatarFromSeed(id),
  sessions,
  joinedAt,
});

const st = (...people: PersonView[]): OfficeState => ({ people });
const types = (evs: ViewerEvent[]) => evs.map((e) => e.type);
const norm = (s: OfficeState) =>
  [...s.people]
    .map((p) => ({
      ...p,
      sessions: [...p.sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    }))
    .sort((a, b) => a.personId.localeCompare(b.personId));

describe("diff", () => {
  test("identical states produce nothing", () => {
    const s = st(person("anna", [sess("a", { subagents: 2 })]));
    expect(diff(s, structuredClone(s))).toEqual([]);
    expect(diff(EMPTY_STATE, EMPTY_STATE)).toEqual([]);
  });

  test("person joins with sessions: joined (empty sessions) before session.started", () => {
    const next = st(person("anna", [sess("a"), sess("b", { agent: "codex" })]));
    const evs = diff(EMPTY_STATE, next, 42);
    expect(types(evs)).toEqual(["person.joined", "session.started", "session.started"]);
    const j = evs[0]!;
    if (j.type !== "person.joined") throw new Error();
    expect(j.data.person.sessions).toEqual([]);
    expect(j.data.person.name).toBe("Anna");
    expect(evs.every((e) => e.ts === 42)).toBe(true);
  });

  test("person joins without sessions", () => {
    expect(types(diff(EMPTY_STATE, st(person("anna"))))).toEqual(["person.joined"]);
  });

  test("person leaves: session.ended before person.left", () => {
    const prev = st(person("anna", [sess("a"), sess("b")]));
    const evs = diff(prev, EMPTY_STATE);
    expect(types(evs)).toEqual(["session.ended", "session.ended", "person.left"]);
  });

  test("session started / ended for a present person", () => {
    const prev = st(person("anna", [sess("a")]));
    const next = st(person("anna", [sess("b")]));
    const evs = diff(prev, next);
    expect(types(evs)).toEqual(["session.ended", "session.started"]);
    expect(evs[0]!.type === "session.ended" && evs[0]!.data.sessionId).toBe("c1:a");
  });

  test("activity change carries previous", () => {
    const evs = diff(
      st(person("anna", [sess("a", { activity: "typing" })])),
      st(person("anna", [sess("a", { activity: "waiting" })])),
    );
    expect(evs).toHaveLength(1);
    const e = evs[0]!;
    if (e.type !== "session.activityChanged") throw new Error();
    expect(e.data).toEqual({
      personId: "anna",
      sessionId: "c1:a",
      activity: "waiting",
      previous: "typing",
    });
  });

  test("subagents: one event per unit with running count (up)", () => {
    const evs = diff(
      st(person("anna", [sess("a", { subagents: 1 })])),
      st(person("anna", [sess("a", { subagents: 4 })])),
    );
    expect(types(evs)).toEqual(["subagent.spawned", "subagent.spawned", "subagent.spawned"]);
    expect(evs.map((e) => (e.type === "subagent.spawned" ? e.data.count : -1))).toEqual([2, 3, 4]);
  });

  test("subagents: one event per unit with running count (down to zero)", () => {
    const evs = diff(
      st(person("anna", [sess("a", { subagents: 3 })])),
      st(person("anna", [sess("a", { subagents: 0 })])),
    );
    expect(types(evs)).toEqual(["subagent.finished", "subagent.finished", "subagent.finished"]);
    expect(evs.map((e) => (e.type === "subagent.finished" ? e.data.count : -1))).toEqual([2, 1, 0]);
  });

  test("new session with subagents does not emit subagent.spawned (count is in the session)", () => {
    const evs = diff(st(person("anna")), st(person("anna", [sess("a", { subagents: 3 })])));
    expect(types(evs)).toEqual(["session.started"]);
  });

  test("ended session with subagents does not emit subagent.finished", () => {
    const evs = diff(st(person("anna", [sess("a", { subagents: 3 })])), st(person("anna")));
    expect(types(evs)).toEqual(["session.ended"]);
  });

  test("avatar change -> avatar.updated, not for joining people", () => {
    const a = person("anna");
    const b = { ...a, avatar: avatarFromSeed("someone-else") };
    expect(types(diff(st(a), st(b)))).toEqual(["avatar.updated"]);
    expect(types(diff(EMPTY_STATE, st(b)))).toEqual(["person.joined"]);
  });

  test("activity and subagents change together: activity before subagent events", () => {
    const evs = diff(
      st(person("anna", [sess("a", { activity: "thinking", subagents: 0 })])),
      st(person("anna", [sess("a", { activity: "running", subagents: 1 })])),
    );
    expect(types(evs)).toEqual(["session.activityChanged", "subagent.spawned"]);
  });

  test("global ordering across people", () => {
    const prev = st(
      person("anna", [sess("a1")]),
      person("bob", [sess("b1", { activity: "typing" })]),
    );
    const next = st(
      person("bob", [sess("b1", { activity: "idle", subagents: 1 }), sess("b2")]),
      person("cara", [sess("c1")]),
    );
    expect(types(diff(prev, next))).toEqual([
      "session.ended", // anna a1
      "person.left", // anna
      "person.joined", // cara
      "session.started", // bob b2
      "session.started", // cara c1
      "session.activityChanged",
      "subagent.spawned",
    ]);
  });

  test("every emitted event validates against the protocol schema", () => {
    const prev = st(person("anna", [sess("a", { subagents: 2 })]), person("bob", [sess("b")]));
    const next = st(
      {
        ...person("anna", [sess("a", { activity: "reading", subagents: 0 }), sess("x")]),
        avatar: avatarFromSeed("z"),
      },
      person("dora", [sess("d", { agent: "pi" })]),
    );
    for (const e of diff(prev, next)) {
      const r = parseViewerMessage(JSON.parse(JSON.stringify(e)));
      expect(r.ok).toBe(true);
    }
  });

  test("helper skin changes emit person.helpersChanged and apply back", () => {
    const prev = st(person("anna", [sess("a")]));
    const cats = st({ ...person("anna", [sess("a")]), helpers: "cats" });
    const toCats = diff(prev, cats);
    expect(toCats.map((e) => e.type)).toEqual(["person.helpersChanged"]);
    expect(toCats[0]!.type === "person.helpersChanged" && toCats[0]!.data.helpers).toBe("cats");
    expect(applyEvents(prev, toCats)).toEqual(cats);
    const back = diff(cats, prev);
    expect(back[0]!.type === "person.helpersChanged" && back[0]!.data.helpers).toBe("robots");
    expect(applyEvents(cats, back)).toEqual(prev);
    // "robots" spelled out is the same as omitted
    expect(diff(prev, st({ ...person("anna", [sess("a")]), helpers: "robots" }))).toEqual([]);
  });

  test("diff is pure (does not mutate inputs)", () => {
    const prev = st(person("anna", [sess("a")]));
    const next = st(person("anna", [sess("a", { subagents: 2 })]), person("bob", [sess("b")]));
    const p0 = structuredClone(prev);
    const n0 = structuredClone(next);
    diff(prev, next);
    expect(prev).toEqual(p0);
    expect(next).toEqual(n0);
  });

  test("property: applyEvents(prev, diff(prev, next)) == next on random states", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const acts: Activity[] = ["typing", "reading", "running", "thinking", "waiting", "idle"];
    const randomState = (): OfficeState => {
      const people: PersonView[] = [];
      for (const id of ["anna", "bob", "cara", "dan"]) {
        if (rnd() < 0.35) continue;
        const sessions: SessionView[] = [];
        for (const k of ["s1", "s2", "s3"]) {
          if (rnd() < 0.5) continue;
          sessions.push(
            sess(`${id}-${k}`, {
              activity: acts[Math.floor(rnd() * acts.length)]!,
              subagents: Math.floor(rnd() * 4),
            }),
          );
        }
        people.push({
          ...person(id, sessions),
          avatar: avatarFromSeed(rnd() < 0.2 ? `${id}x` : id),
          ...(rnd() < 0.3 ? { helpers: "cats" as const } : {}),
        });
      }
      return { people };
    };
    let prev = randomState();
    for (let i = 0; i < 300; i++) {
      const next = randomState();
      const evs = diff(prev, next);
      expect(norm(applyEvents(prev, evs))).toEqual(norm(next));
      // per-person ordering invariants
      const seenJoin = new Set<string>();
      const leftAt = new Map<string, number>();
      evs.forEach((e, idx) => {
        if (e.type === "person.joined") seenJoin.add(e.data.person.personId);
        if (e.type === "person.left") leftAt.set(e.data.personId, idx);
        if (
          e.type === "session.started" &&
          !prev.people.some((p) => p.personId === e.data.personId)
        ) {
          expect(seenJoin.has(e.data.personId)).toBe(true);
        }
        if (e.type === "session.ended") expect(leftAt.has(e.data.personId)).toBe(false);
      });
      prev = next;
    }
  });
});
