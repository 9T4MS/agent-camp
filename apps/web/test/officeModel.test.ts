import { describe, expect, test } from "bun:test";
import {
  avatarFromSeed,
  envelope,
  type PersonView,
  type SessionView,
} from "@agent-office/protocol";
import { DemoFeed } from "../src/demo/demoFeed.ts";
import { OfficeModel } from "../src/state/officeModel.ts";

const T0 = new Date(2026, 10, 10, 12, 0, 0).getTime();
const sess = (id: string, extra: Partial<SessionView> = {}): SessionView => ({
  sessionId: `laptop:${id}`,
  agent: "claude",
  project: "agent-office",
  activity: "typing",
  subagents: 0,
  startedAt: T0 - 1000,
  ...extra,
});
const person = (name: string, sessions: SessionView[] = []): PersonView => ({
  personId: name.toLowerCase(),
  name,
  avatar: avatarFromSeed(name.toLowerCase()),
  sessions,
  joinedAt: T0 - 5000,
});
const snap = (people: PersonView[]) =>
  envelope("office.snapshot", { officeName: "Camp", serverTime: T0, people }, { ts: T0 });

describe("OfficeModel", () => {
  test("helper skin: robots by default, cats from snapshot and event", () => {
    const m = new OfficeModel(() => T0);
    m.apply(snap([person("Anna"), { ...person("Bob"), helpers: "cats" }]));
    expect(m.people.get("anna")?.helpers).toBe("robots");
    expect(m.people.get("bob")?.helpers).toBe("cats");
    const ch = m.apply(envelope("person.helpersChanged", { personId: "anna", helpers: "cats" }));
    expect(ch).toEqual([{ kind: "helpersChanged", personId: "anna", helpers: "cats" }]);
    expect(
      m.apply(envelope("person.helpersChanged", { personId: "anna", helpers: "cats" })),
    ).toEqual([]);
    // a resync snapshot without the field turns Bob back to robots
    const back = m.apply(snap([{ ...person("Anna"), helpers: "cats" }, person("Bob")]));
    expect(back).toContainEqual({ kind: "helpersChanged", personId: "bob", helpers: "robots" });
  });

  test("cat interactions carry the cat and the floor spot", () => {
    const m = new OfficeModel(() => T0);
    m.apply(snap([person("Anna")]));
    const yarn = m.apply(
      envelope("interaction.happened", { kind: "yarn", from: "Lea", catId: 2, x: 600, y: 140 }),
    );
    expect(yarn).toEqual([
      {
        kind: "interaction",
        interaction: "yarn",
        personId: undefined,
        from: "Lea",
        text: undefined,
        delivered: undefined,
        catId: 2,
        spot: { x: 600, y: 140 },
      },
    ]);
    const visit = m.apply(
      envelope("interaction.happened", { kind: "cat", personId: "anna", catId: 1, delivered: 0 }),
    );
    expect(visit[0]).toMatchObject({ interaction: "cat", personId: "anna", catId: 1 });
    expect(visit[0]).toMatchObject({ spot: undefined });
  });

  test("party scores and equipment reconcile through socket snapshots and events", () => {
    const m = new OfficeModel(() => T0);
    const p = person("Anna", [sess("a1")]);
    m.apply(snap([p]));
    const avatar = { ...p.avatar, rightHand: "lightsaber" as const, vehicle: "car" as const };
    m.apply(envelope("avatar.updated", { personId: "anna", avatar }));
    const party = {
      scores: { anna: 3 },
      events: [
        {
          id: "party-1",
          personId: "anna",
          action: "race" as const,
          item: "lightsaber" as const,
          vehicle: "car" as const,
          at: T0,
          roll: 3,
        },
      ],
    };
    expect(m.apply(envelope("party.updated", { party }))).toEqual([{ kind: "partyChanged" }]);
    expect(m.party.scores.anna).toBe(3);
    expect(m.people.get("anna")!.avatar.rightHand).toBe("lightsaber");
    // Party updates must leave the reported coding session state intact.
    expect(m.sessions.get("laptop:a1")!.activity).toBe("typing");
    m.apply(
      envelope("office.snapshot", {
        officeName: "Camp",
        serverTime: T0,
        people: [{ ...p, avatar }],
        party,
      }),
    );
    expect(m.party).toEqual(party);
    m.apply(snap([p]));
    expect(m.party).toEqual({ events: [], scores: {} });
  });

  test("agent card data: machine, subagent peak, activity timeline", () => {
    let now = T0;
    const m = new OfficeModel(() => now);
    m.apply(snap([person("Martin", [sess("m1", { machine: "devbox", subagents: 2 })])]));
    const id = "laptop:m1";
    expect(m.sessions.get(id)).toMatchObject({ machine: "devbox", peakSubagents: 2 });
    const ev = (type: "subagent.spawned" | "subagent.finished", count: number) =>
      m.apply(envelope(type, { personId: "martin", sessionId: id, count }));
    ev("subagent.spawned", 3);
    ev("subagent.spawned", 5);
    ev("subagent.finished", 1);
    expect(m.sessions.get(id)).toMatchObject({ subagents: 1, peakSubagents: 5 });
    const act = (activity: "reading" | "waiting", previous: "typing" | "reading") =>
      m.apply(
        envelope("session.activityChanged", {
          personId: "martin",
          sessionId: id,
          activity,
          previous,
        }),
      );
    now += 10 * 60_000;
    act("reading", "typing");
    now += 5 * 60_000;
    act("waiting", "reading");
    now += 60_000;
    expect(m.timeline(id, 30 * 60_000, now)).toEqual([
      { activity: "typing", from: T0, to: T0 + 10 * 60_000 },
      { activity: "reading", from: T0 + 10 * 60_000, to: T0 + 15 * 60_000 },
      { activity: "waiting", from: T0 + 15 * 60_000, to: now },
    ]);
    // a 5 min window clips the first segment away and cuts the second
    expect(m.timeline(id, 5 * 60_000, now)[0]).toEqual({
      activity: "reading",
      from: now - 5 * 60_000,
      to: T0 + 15 * 60_000,
    });
    expect(m.timeline("nope")).toEqual([]);
    // server history from before the page was opened is prepended (server clock == T0 here)
    m.mergeActivityHistory(id, [
      { activity: "thinking", at: T0 - 20 * 60_000 },
      { activity: "typing", at: T0 - 5 * 60_000 },
      { activity: "reading", at: T0 + 60_000 }, // newer than what we saw: ignored
    ]);
    expect(m.timeline(id, 30 * 60_000, now).map((g) => g.activity)).toEqual([
      "thinking",
      "typing",
      "reading",
      "waiting",
    ]);
    expect(m.timeline(id, 30 * 60_000, now)[0]!.from).toBe(now - 30 * 60_000);
  });

  test("snapshot adds people and sessions instantly", () => {
    const m = new OfficeModel(() => T0);
    const ch = m.apply(snap([person("Anna", [sess("a1"), sess("a2", { agent: "codex" })])]));
    expect(ch.map((c) => c.kind)).toEqual([
      "officeRenamed",
      "personAdded",
      "sessionAdded",
      "sessionAdded",
    ]);
    expect(ch.every((c) => !("instant" in c) || c.instant)).toBe(true);
    expect(m.officeName).toBe("Camp");
    const st = m.stats();
    expect(st).toMatchObject({ people: 1, sessions: 2, peakToday: 2, startedToday: 2 });
    expect(st.byAgent).toMatchObject({ claude: 1, codex: 1 });
  });

  test("pods and desks are stable and reuse the lowest free slot", () => {
    const m = new OfficeModel(() => T0);
    m.apply(snap([person("Anna", [sess("a1")]), person("Ben", [sess("b1")])]));
    expect(m.people.get("anna")!.pod).toBe(0);
    expect(m.people.get("ben")!.pod).toBe(1);
    m.apply(envelope("person.left", { personId: "anna" }));
    m.apply(envelope("person.joined", { person: person("Cleo", [sess("c1")]) }));
    expect(m.people.get("cleo")!.pod).toBe(0);
    m.apply(envelope("session.started", { personId: "ben", session: sess("b2") }));
    m.apply(envelope("session.started", { personId: "ben", session: sess("b3") }));
    expect(m.sessionsOf("ben").map((s) => s.desk)).toEqual([0, 1, 2]);
    m.apply(envelope("session.ended", { personId: "ben", sessionId: "laptop:b2" }));
    m.apply(envelope("session.started", { personId: "ben", session: sess("b4") }));
    expect(m.sessions.get("laptop:b4")!.desk).toBe(1);
  });

  test("a session moved into a freed desk frees its old one", () => {
    const m = new OfficeModel(() => T0);
    m.apply(snap([person("Ben", [sess("b1"), sess("b2"), sess("b3")])]));
    m.apply(envelope("session.ended", { personId: "ben", sessionId: "laptop:b1" }));
    m.moveDesk("laptop:b3", 0);
    expect(m.sessionsOf("ben").map((s) => s.desk)).toEqual([0, 1]);
    m.apply(envelope("session.started", { personId: "ben", session: sess("b4") }));
    expect(m.sessions.get("laptop:b4")!.desk).toBe(2);
  });

  test("events produce animated changes", () => {
    const m = new OfficeModel(() => T0);
    m.apply(snap([]));
    const joined = m.apply(envelope("person.joined", { person: person("Anna", [sess("a1")]) }));
    expect(joined).toEqual([
      { kind: "personAdded", personId: "anna", instant: false },
      { kind: "sessionAdded", personId: "anna", sessionId: "laptop:a1", instant: false },
    ]);
    const act = m.apply(
      envelope("session.activityChanged", {
        personId: "anna",
        sessionId: "laptop:a1",
        activity: "waiting",
        previous: "typing",
      }),
    );
    expect(act).toEqual([
      {
        kind: "activityChanged",
        personId: "anna",
        sessionId: "laptop:a1",
        activity: "waiting",
        previous: "typing",
      },
    ]);
    const sub = m.apply(
      envelope("subagent.spawned", { personId: "anna", sessionId: "laptop:a1", count: 1 }),
    );
    expect(sub[0]).toMatchObject({ kind: "subagentsChanged", count: 1, previous: 0 });
    expect(m.stats().subagents).toBe(1);
    const left = m.apply(envelope("person.left", { personId: "anna" }));
    expect(left.map((c) => c.kind)).toEqual(["sessionRemoved", "personRemoved"]);
    expect(m.stats()).toMatchObject({ people: 0, sessions: 0, peakToday: 1 });
  });

  test("unknown sessions are ignored and duplicates are idempotent", () => {
    const m = new OfficeModel(() => T0);
    m.apply(snap([person("Anna", [sess("a1")])]));
    expect(m.apply(envelope("session.ended", { personId: "anna", sessionId: "nope" }))).toEqual([]);
    expect(m.apply(envelope("session.started", { personId: "anna", session: sess("a1") }))).toEqual(
      [],
    );
    expect(
      m.apply(
        envelope("session.activityChanged", {
          personId: "anna",
          sessionId: "laptop:a1",
          activity: "typing",
          previous: "typing",
        }),
      ),
    ).toEqual([]);
  });

  test("session for an unknown person creates a placeholder person", () => {
    const m = new OfficeModel(() => T0);
    const ch = m.apply(envelope("session.started", { personId: "zoe", session: sess("z1") }));
    expect(ch.map((c) => c.kind)).toEqual(["personAdded", "sessionAdded"]);
    expect(m.people.get("zoe")!.name).toBe("zoe");
  });

  test("a reconnect snapshot reconciles silently", () => {
    const m = new OfficeModel(() => T0);
    m.apply(snap([person("Anna", [sess("a1"), sess("a2")]), person("Ben", [sess("b1")])]));
    const ch = m.apply(
      snap([
        person("Anna", [sess("a1", { activity: "reading" }), sess("a3")]),
        person("Cleo", [sess("c1")]),
      ]),
    );
    const kinds = ch.map(
      (c) => `${c.kind}:${"sessionId" in c ? c.sessionId : "personId" in c ? c.personId : ""}`,
    );
    expect(kinds).toContain("sessionRemoved:laptop:b1");
    expect(kinds).toContain("personRemoved:ben");
    expect(kinds).toContain("sessionRemoved:laptop:a2");
    expect(kinds).toContain("activityChanged:laptop:a1");
    expect(kinds).toContain("sessionAdded:laptop:a3");
    expect(kinds).toContain("personAdded:cleo");
    expect(ch.filter((c) => "instant" in c).every((c) => "instant" in c && c.instant)).toBe(true);
    expect(m.sessions.get("laptop:a3")!.desk).toBe(1);
  });

  test("avatar updates are reported", () => {
    const m = new OfficeModel(() => T0);
    m.apply(snap([person("Anna")]));
    const avatar = { ...avatarFromSeed("anna"), hairStyle: "mohawk" as const };
    expect(m.apply(envelope("avatar.updated", { personId: "anna", avatar }))).toEqual([
      { kind: "avatarChanged", personId: "anna" },
    ]);
    expect(m.people.get("anna")!.avatar.hairStyle).toBe("mohawk");
  });

  test("podCount follows the highest pod in use", () => {
    const m = new OfficeModel(() => T0);
    const people = Array.from({ length: 14 }, (_, i) => person(`P${i}`, [sess(`s${i}`)]));
    m.apply(snap(people));
    expect(m.podCount()).toBe(14);
  });
});

describe("DemoFeed", () => {
  const run = (mode: "busy" | "one" | "empty" | "join") => {
    const msgs: unknown[] = [];
    const feed = new DemoFeed(
      { mode, seed: "x" },
      (m) => msgs.push(m),
      () => T0,
    );
    feed.start();
    feed.stop();
    return msgs as { type: string; data: { people: PersonView[] } }[];
  };
  test("busy demo: 12 people, 30 sessions, applies cleanly", () => {
    const [first] = run("busy");
    expect(first!.type).toBe("office.snapshot");
    expect(first!.data.people.length).toBe(12);
    expect(first!.data.people.flatMap((p) => p.sessions).length).toBe(30);
    const m = new OfficeModel(() => T0);
    m.apply(first as never);
    expect(m.stats().sessions).toBe(30);
  });
  test("deterministic per seed", () => {
    const strip = (x: unknown) => JSON.stringify(x).replace(/"id":"[^"]+"/g, "");
    expect(strip(run("busy"))).toBe(strip(run("busy")));
  });
  test("empty and one", () => {
    expect(run("empty")[0]!.data.people).toEqual([]);
    expect(run("one")[0]!.data.people[0]!.sessions.length).toBe(1);
  });
});
