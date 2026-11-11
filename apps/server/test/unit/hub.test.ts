import { describe, expect, test } from "bun:test";
import {
  type AvatarSpec,
  avatarFromSeed,
  CLOSE_BAD_MESSAGE,
  CLOSE_BAD_PASSWORD,
  CLOSE_TOO_OLD,
  CONNECTOR_STALE_MS,
  CONNECTOR_TIMEOUT_MS,
  envelope,
  hashString,
  lookFromCatalog,
  MAX_SELF_DESCRIPTION,
  PERSON_GRACE_MS,
  parseServerToConnector,
  parseViewerMessage,
  resolveLook,
  type SessionInfo,
  type ViewerEvent,
} from "@agent-office/protocol";
import { LOOK_FIXTURES } from "@agent-office/protocol/fixtures";
import { createAvatarService } from "../../src/core/genui.ts";
import { defaultAvatarKey, Hub, type HubConfig, RECENT_ACTIVITY_MS } from "../../src/core/hub.ts";
import { MemoryStore } from "../../src/core/store.ts";

const CFG: HubConfig = {
  password: "devpass",
  minConnectorVersion: "0.1.0",
  latestConnectorVersion: "0.1.9",
  serverVersion: "0.1.9",
  officeName: "Test Office",
  timezone: "Europe/Vienna",
};

const hello = (name: string, clientId: string, over: Record<string, unknown> = {}) =>
  JSON.stringify(
    envelope("connector.hello", {
      name,
      password: "devpass",
      clientId,
      connectorVersion: "0.1.5",
      ...over,
    }),
  );

const s = (key: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionKey: `${key}-0123456789`,
  agent: "claude",
  project: "agent-office",
  activity: "typing",
  subagents: 0,
  startedAt: 1_000,
  ...over,
});
const snap = (...sessions: SessionInfo[]) => envelope("presence.snapshot", { sessions });
const bye = () => envelope("connector.bye", {});
const types = (evs: ViewerEvent[]) => evs.map((e) => e.type);

function setup(cfg: Partial<HubConfig> = {}) {
  const store = new MemoryStore();
  const hub = new Hub({ ...CFG, ...cfg }, store);
  const lines: string[] = [];
  hub.log = (l) => lines.push(l);
  return { hub, store, lines };
}

describe("hub: hello", () => {
  test("welcomes, joins the person, returns binding and avatar job", () => {
    const { hub } = setup();
    const r = hub.onConnectorMessage("sock1", hello("Martin", "laptop-1"), 100);
    expect(r.close).toBeUndefined();
    const reply = parseServerToConnector(JSON.parse(JSON.stringify(r.reply)));
    expect(reply.ok).toBe(true);
    if (!reply.ok || reply.msg.type !== "connector.welcomed") throw new Error("not welcomed");
    expect(reply.msg.data).toEqual({
      personId: "martin",
      serverVersion: "0.1.9",
      latestConnectorVersion: "0.1.9",
      minConnectorVersion: "0.1.0",
    });
    expect(types(r.events)).toEqual(["person.joined"]);
    expect(r.binding?.personId).toBe("martin");
    expect(r.avatarJob?.personId).toBe("martin");
  });

  test("bad password -> rejected + 4001", () => {
    const { hub } = setup();
    const r = hub.onConnectorMessage("s", hello("M", "c", { password: "nope" }), 1);
    expect(r.reply?.type).toBe("connector.rejected");
    expect(r.reply?.type === "connector.rejected" && r.reply.data.reason).toBe("bad_password");
    expect(r.close?.code).toBe(CLOSE_BAD_PASSWORD);
    expect(r.events).toEqual([]);
    expect(hub.state().people).toEqual([]);
  });

  test("no password configured -> everyone rejected", () => {
    const { hub } = setup({ password: undefined });
    expect(hub.onConnectorMessage("s", hello("M", "c"), 1).close?.code).toBe(CLOSE_BAD_PASSWORD);
  });

  test("too old -> rejected + 4002", () => {
    const { hub } = setup({ minConnectorVersion: "0.2.0" });
    const r = hub.onConnectorMessage("s", hello("M", "c"), 1);
    expect(r.reply?.type === "connector.rejected" && r.reply.data.reason).toBe("too_old");
    expect(r.close?.code).toBe(CLOSE_TOO_OLD);
  });

  test("dev connector version passes min 0.0.0", () => {
    const { hub } = setup({ minConnectorVersion: "0.0.0" });
    const r = hub.onConnectorMessage("s", hello("M", "c", { connectorVersion: "0.0.0-dev" }), 1);
    expect(r.reply?.type).toBe("connector.welcomed");
  });

  test("garbage -> 4003", () => {
    const { hub } = setup();
    expect(hub.onConnectorMessage("s", "{nope", 1).close?.code).toBe(CLOSE_BAD_MESSAGE);
    expect(hub.onConnectorMessage("s", { v: 1, type: "x" }, 1).close?.code).toBe(CLOSE_BAD_MESSAGE);
  });

  test("snapshot before hello -> 4003", () => {
    const { hub } = setup();
    expect(hub.onConnectorMessage("s", snap(s("a")), 1).close?.code).toBe(CLOSE_BAD_MESSAGE);
  });
});

describe("hub: sessions", () => {
  test("snapshot -> session.started, activity, subagents, end", () => {
    const { hub, lines } = setup();
    hub.onConnectorMessage("s1", hello("Martin", "c1"), 0);
    expect(types(hub.onConnectorMessage("s1", snap(s("a")), 1).events)).toEqual([
      "session.started",
    ]);
    expect(lines.at(-1)).toBe("session.started martin claude agent-office");
    // heartbeat with no change -> nothing
    expect(hub.onConnectorMessage("s1", snap(s("a")), 2).events).toEqual([]);
    expect(
      types(
        hub.onConnectorMessage("s1", snap(s("a", { activity: "waiting", subagents: 2 })), 3).events,
      ),
    ).toEqual(["session.activityChanged", "subagent.spawned", "subagent.spawned"]);
    const ended = hub.onConnectorMessage("s1", snap(), 4).events;
    expect(types(ended)).toEqual(["session.ended"]);
    expect(lines.at(-1)).toBe("session.ended martin claude agent-office");
    expect(hub.state().people[0]?.sessions).toEqual([]);
  });

  test("a Claude Design window (no project) reaches viewers as agent design", () => {
    const { hub, lines } = setup();
    hub.onConnectorMessage("s1", hello("Dana", "c1"), 0);
    // what the connector sends: JSON, so `project` is absent rather than undefined
    const design = JSON.parse(
      JSON.stringify(snap(s("d", { agent: "design", project: undefined, activity: "thinking" }))),
    );
    const started = hub.onConnectorMessage("s1", design, 1).events;
    expect(types(started)).toEqual(["session.started"]);
    for (const e of started)
      expect(parseViewerMessage(JSON.parse(JSON.stringify(e))).ok).toBe(true);
    expect(lines.at(-1)).toContain("session.started dana design");
    const view = hub.state().people[0]?.sessions[0];
    expect(view).toMatchObject({ agent: "design", activity: "thinking", subagents: 0 });
    expect(view?.project).toBeUndefined();
    const snapshot = parseViewerMessage(JSON.parse(JSON.stringify(hub.snapshot(2))));
    expect(snapshot.ok).toBe(true);
  });

  test("session ids are clientId:sessionKey", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("Martin", "c1"), 0);
    const e = hub.onConnectorMessage("s1", snap(s("a")), 1).events[0]!;
    expect(e.type === "session.started" && e.data.session.sessionId).toBe("c1:a-0123456789");
  });

  test("two laptops with the same name = one person", () => {
    const { hub } = setup();
    expect(types(hub.onConnectorMessage("s1", hello("Martin", "mac-a"), 0).events)).toEqual([
      "person.joined",
    ]);
    expect(hub.onConnectorMessage("s2", hello("martin", "mac-b"), 0).events).toEqual([]);
    hub.onConnectorMessage("s1", snap(s("a")), 1);
    hub.onConnectorMessage("s2", snap(s("b"), s("c")), 1);
    const people = hub.state().people;
    expect(people).toHaveLength(1);
    expect(people[0]!.sessions).toHaveLength(3);
    // one laptop says bye: its sessions end, person stays
    const evs = hub.onConnectorMessage("s1", bye(), 2).events;
    expect(types(evs)).toEqual(["session.ended"]);
    expect(hub.state().people[0]!.sessions).toHaveLength(2);
  });

  test("helpers: cats when any of the person's connectors says so", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("Martin", "mac-a"), 0);
    expect(hub.state().people[0]!.helpers).toBeUndefined();
    const evs = hub.onConnectorMessage(
      "s2",
      hello("martin", "mac-b", { helpers: "cats" }),
      1,
    ).events;
    expect(types(evs)).toEqual(["person.helpersChanged"]);
    expect(hub.state().people[0]!.helpers).toBe("cats");
    // the cat machine leaves: back to robots
    expect(types(hub.onConnectorMessage("s2", bye(), 2).events)).toContain("person.helpersChanged");
    expect(hub.state().people[0]!.helpers).toBeUndefined();
  });

  test("duplicate session keys in one snapshot are collapsed", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("M", "c1"), 0);
    expect(hub.onConnectorMessage("s1", snap(s("a"), s("a")), 1).events).toHaveLength(1);
  });

  test("all emitted events and the snapshot validate", () => {
    const { hub } = setup();
    const all: unknown[] = [];
    all.push(...hub.onConnectorMessage("s1", hello("Anna Müller", "c1"), 0).events);
    all.push(
      ...hub.onConnectorMessage(
        "s1",
        snap(s("a", { subagents: 1 }), s("b", { agent: "pi", project: undefined })),
        1,
      ).events,
    );
    all.push(hub.snapshot(5));
    all.push(...hub.onConnectorMessage("s1", bye(), 6).events);
    all.push(...hub.tick(6 + PERSON_GRACE_MS));
    for (const m of all) expect(parseViewerMessage(JSON.parse(JSON.stringify(m))).ok).toBe(true);
  });
});

describe("hub: liveness", () => {
  test("silent connector goes offline, then ends; person leaves after the grace period", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("Martin", "c1"), 0);
    hub.onConnectorMessage("s1", snap(s("a")), 1_000);
    expect(hub.nextDeadline()).toBe(1_000 + CONNECTOR_STALE_MS + 1);
    expect(hub.tick(1_000 + CONNECTOR_STALE_MS)).toEqual([]);
    const off = hub.tick(1_000 + CONNECTOR_STALE_MS + 1);
    expect(
      off.map((e) => [e.type, e.type === "session.connectionChanged" && e.data.offline]),
    ).toEqual([["session.connectionChanged", true]]);
    expect(hub.state().people[0]!.sessions[0]!.offline).toBe(true);
    expect(hub.liveSocketsOf("martin", 1_000 + CONNECTOR_STALE_MS + 1)).toEqual([]);
    expect(hub.nextDeadline()).toBe(1_000 + CONNECTOR_TIMEOUT_MS + 1);
    expect(hub.tick(1_000 + CONNECTOR_TIMEOUT_MS)).toEqual([]);
    const t1 = 1_000 + CONNECTOR_TIMEOUT_MS + 1;
    expect(types(hub.tick(t1))).toEqual(["session.ended"]);
    expect(hub.state().people).toHaveLength(1);
    expect(hub.nextDeadline()).toBe(t1 + PERSON_GRACE_MS);
    expect(hub.tick(t1 + PERSON_GRACE_MS - 1)).toEqual([]);
    expect(types(hub.tick(t1 + PERSON_GRACE_MS))).toEqual(["person.left"]);
    expect(hub.nextDeadline()).toBeNull();
  });

  test("a heartbeat after going offline brings the sessions back online", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("M", "c1"), 0);
    hub.onConnectorMessage("s1", snap(s("a")), 0);
    hub.tick(CONNECTOR_STALE_MS + 1);
    expect(hub.liveSocketsOf("m", CONNECTOR_STALE_MS + 1)).toEqual([]);
    const back = hub.onConnectorMessage("s1", snap(s("a")), CONNECTOR_STALE_MS + 2).events;
    expect(
      back.map((e) => [e.type, e.type === "session.connectionChanged" && e.data.offline]),
    ).toEqual([["session.connectionChanged", false]]);
    expect(hub.state().people[0]!.sessions[0]!.offline).toBeUndefined();
    expect(hub.liveSocketsOf("m", CONNECTOR_STALE_MS + 2)).toEqual(["s1"]);
  });

  test("heartbeats keep a connector alive", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("M", "c1"), 0);
    hub.onConnectorMessage("s1", snap(s("a")), 0);
    for (let t = 30_000; t <= 600_000; t += 30_000) {
      expect(hub.onConnectorMessage("s1", snap(s("a")), t).events).toEqual([]);
      expect(hub.tick(t + 1)).toEqual([]);
    }
  });

  test("socket close without bye keeps sessions until timeout; reconnect is seamless", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("M", "c1"), 0);
    hub.onConnectorMessage("s1", snap(s("a")), 0);
    expect(hub.onConnectorClosed("s1", 10).events).toEqual([]);
    expect(hub.state().people[0]!.sessions).toHaveLength(1);
    // reconnect on a new socket within the window: no events at all
    expect(hub.onConnectorMessage("s2", hello("M", "c1"), 5_000).events).toEqual([]);
    expect(hub.onConnectorMessage("s2", snap(s("a")), 5_001).events).toEqual([]);
  });

  test("bye ends sessions immediately; person leaves after grace; rejoin during grace is silent", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("M", "c1"), 0);
    hub.onConnectorMessage("s1", snap(s("a")), 0);
    expect(types(hub.onConnectorMessage("s1", bye(), 100).events)).toEqual(["session.ended"]);
    expect(hub.nextDeadline()).toBe(100 + PERSON_GRACE_MS);
    expect(hub.onConnectorMessage("s2", hello("M", "c1"), 200).events).toEqual([]);
    expect(hub.tick(100 + PERSON_GRACE_MS + 1)).toEqual([]);
    expect(hub.state().people).toHaveLength(1);
  });

  test("stale socket after takeover is told to go away", () => {
    const { hub } = setup();
    hub.onConnectorMessage("old", hello("M", "c1"), 0);
    hub.onConnectorMessage("new", hello("M", "c1"), 1);
    const r = hub.onConnectorMessage("old", snap(s("a")), 2);
    expect(r.close?.reason).toBe("superseded");
    expect(r.events).toEqual([]);
    // closing the old socket does not affect the connector
    hub.onConnectorClosed("old", 3);
    expect(hub.onConnectorMessage("new", snap(s("a")), 4).events).toHaveLength(1);
  });

  test("timed-out connector whose socket is still open revives on next snapshot", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("M", "c1"), 0);
    hub.onConnectorMessage("s1", snap(s("a")), 0);
    const t = CONNECTOR_TIMEOUT_MS + 1;
    hub.tick(t);
    expect(types(hub.onConnectorMessage("s1", snap(s("a")), t + 10).events)).toEqual([
      "session.started",
    ]);
  });

  test("renaming a laptop moves its sessions to the new person", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("Anna", "c1"), 0);
    hub.onConnectorMessage("s1", snap(s("a")), 0);
    const evs = hub.onConnectorMessage("s2", hello("Annabel", "c1"), 10).events;
    expect(types(evs)).toEqual(["session.ended", "person.joined"]);
  });
});

describe("hub: recent activity (agent card timeline)", () => {
  test("logs activity changes of live sessions, prunes to 30 min, forgets ended ones", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("Martin", "c1"), 0);
    hub.onConnectorMessage("s1", snap(s("a")), 1_000);
    hub.onConnectorMessage("s1", snap(s("a", { activity: "reading" })), 2_000);
    hub.onConnectorMessage("s1", snap(s("a", { activity: "waiting" })), 3_000);
    const id = "c1:a-0123456789";
    expect(hub.recentActivity("martin", 4_000)).toEqual({
      [id]: [
        { activity: "typing", at: 1_000 },
        { activity: "reading", at: 2_000 },
        { activity: "waiting", at: 3_000 },
      ],
    });
    const late = 3_000 + RECENT_ACTIVITY_MS + 10;
    // keep the heartbeat going so the connector stays alive
    hub.onConnectorMessage("s1", snap(s("a", { activity: "typing" })), late);
    expect(hub.recentActivity("martin", late)[id]!.map((e) => e.activity)).toEqual([
      "waiting",
      "typing",
    ]);
    hub.onConnectorMessage("s1", snap(), late + 1);
    expect(hub.recentActivity("martin", late + 2)).toEqual({});
    expect(hub.recentActivity("nobody", 0)).toEqual({});
  });
});

describe("hub: persistence + history", () => {
  test("restore after restart emits nothing and keeps sessions", () => {
    const { hub, store } = setup();
    hub.onConnectorMessage("s1", hello("Martin", "c1"), 0);
    hub.onConnectorMessage("s1", snap(s("a"), s("b", { agent: "codex" })), 1);
    const hub2 = new Hub(CFG, store);
    hub2.restore(50_000, [{ socketId: "s1", binding: hub.bindingOf("s1")! }]);
    expect(hub2.state().people[0]!.sessions.map((x) => x.sessionId)).toEqual(
      hub.state().people[0]!.sessions.map((x) => x.sessionId),
    );
    // hibernation wake: same socket keeps talking, no spurious events
    expect(
      hub2.onConnectorMessage("s1", snap(s("a"), s("b", { agent: "codex" })), 50_001).events,
    ).toEqual([]);
    // restore gives a fresh liveness window
    expect(hub2.nextDeadline()).toBe(50_001 + CONNECTOR_STALE_MS + 1);
  });

  test("restore without the old socket (deploy): connector reconnects silently", () => {
    const { hub, store } = setup();
    hub.onConnectorMessage("s1", hello("Martin", "c1"), 0);
    hub.onConnectorMessage("s1", snap(s("a")), 1);
    const hub2 = new Hub(CFG, store);
    hub2.restore(10_000);
    expect(hub2.onConnectorMessage("s9", hello("Martin", "c1"), 10_001).events).toEqual([]);
    expect(hub2.onConnectorMessage("s9", snap(s("a")), 10_002).events).toEqual([]);
  });

  test("heartbeats and activity changes do not rewrite persisted state", () => {
    const { hub, store } = setup();
    let writes = 0;
    const orig = store.kvPut.bind(store);
    store.kvPut = (k, v) => {
      if (k === "hub.state") writes++;
      orig(k, v);
    };
    hub.onConnectorMessage("s1", hello("M", "c1"), 0);
    hub.onConnectorMessage("s1", snap(s("a")), 1);
    const before = writes;
    hub.onConnectorMessage("s1", snap(s("a")), 2);
    hub.onConnectorMessage("s1", snap(s("a", { activity: "reading", subagents: 3 })), 3);
    expect(writes).toBe(before);
  });

  test("history rows: no activity rows, ended rows carry agent/project", () => {
    const { hub, store } = setup();
    hub.onConnectorMessage("s1", hello("Martin", "c1"), 0);
    hub.onConnectorMessage("s1", snap(s("a", { agent: "codex", project: "p1" })), 1);
    hub.onConnectorMessage(
      "s1",
      snap(s("a", { agent: "codex", project: "p1", activity: "idle", subagents: 1 })),
      2,
    );
    hub.onConnectorMessage("s1", bye(), 3);
    hub.tick(3 + PERSON_GRACE_MS);
    expect(store.history().map((r) => r.type)).toEqual([
      "person.joined",
      "session.started",
      "subagent.spawned",
      "session.ended",
      "person.left",
    ]);
    const ended = store.history().find((r) => r.type === "session.ended")!;
    expect(ended).toMatchObject({ person: "martin", agent: "codex", project: "p1", subagents: 1 });
  });

  test("avatar: stored look is reused; setAvatar emits avatar.updated; same key -> no job", () => {
    const { hub, store } = setup();
    const r = hub.onConnectorMessage("s1", hello("Martin", "c1", { selfDescription: "beard" }), 0);
    const job = r.avatarJob!;
    const look = {
      ...hub.state().people[0]!.avatar,
      hairStyle: "mohawk" as const,
      glasses: "round" as const,
    };
    expect(types(hub.setAvatar("martin", look, job.key, 1))).toEqual(["avatar.updated"]);
    expect(store.getAvatar("martin")?.avatar).toEqual(look);
    // reconnect with same description -> no job
    expect(
      hub.onConnectorMessage("s2", hello("Martin", "c1", { selfDescription: "beard" }), 2)
        .avatarJob,
    ).toBeUndefined();
    // description changes -> job
    expect(
      hub.onConnectorMessage("s3", hello("Martin", "c1", { selfDescription: "bald" }), 3).avatarJob,
    ).toBeDefined();
    // a fresh hub (after the person left) starts from the stored look
    const hub2 = new Hub(CFG, store);
    hub2.onConnectorMessage("x", hello("Martin", "c9", { selfDescription: "beard" }), 10);
    expect(hub2.state().people[0]!.avatar).toEqual(look);
  });

  test("snapshot carries office name, timezone and people", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("Martin", "c1"), 0);
    hub.onConnectorMessage("s1", snap(s("a")), 1);
    const m = hub.snapshot(99);
    expect(m.data.officeName).toBe("Test Office");
    expect(m.data.timezone).toBe("Europe/Vienna");
    expect(m.data.serverTime).toBe(99);
    expect(m.data.people[0]!.sessions).toHaveLength(1);
  });
});

describe("hub: same name on two machines = one persona", () => {
  const two = () => {
    const ctx = setup();
    const { hub } = ctx;
    const a = hub.onConnectorMessage(
      "s1",
      hello("Martin", "laptop", { selfDescription: "beard, hoodie", machine: "laptop" }),
      0,
    );
    const b = hub.onConnectorMessage("s2", hello(" martin", "devbox", { machine: "devbox" }), 5);
    return { ...ctx, a, b };
  };

  test("one person, sessions from both machines, one avatar job", () => {
    const { hub, a, b } = two();
    expect(a.avatarJob).toMatchObject({ personId: "martin", selfDescription: "beard, hoodie" });
    expect(b.avatarJob).toBeUndefined();
    expect(types(b.events)).toEqual([]);
    hub.onConnectorMessage("s1", snap(s("a")), 10);
    hub.onConnectorMessage("s2", snap(s("b"), s("c", { agent: "codex" })), 10);
    const people = hub.state().people;
    expect(people).toHaveLength(1);
    expect(people[0]!.name).toBe("Martin");
    const machines = people[0]!.sessions.map((x) => x.machine).sort();
    expect(machines).toEqual(["devbox", "devbox", "laptop"]);
  });

  test("reconnecting either machine issues no new job, name does not flip", () => {
    const { hub, a } = two();
    hub.setAvatar("martin", hub.state().people[0]!.avatar, a.avatarJob!.key, 6);
    for (let i = 0; i < 3; i++) {
      const r1 = hub.onConnectorMessage(`x${i}`, hello("martin ", "devbox"), 100 + i);
      const r2 = hub.onConnectorMessage(
        `y${i}`,
        hello("Martin", "laptop", { selfDescription: "beard, hoodie" }),
        100 + i,
      );
      expect(r1.avatarJob).toBeUndefined();
      expect(r2.avatarJob).toBeUndefined();
      expect(hub.state().people[0]!.name).toBe("Martin");
    }
  });

  test("no job even while the first one is still running", () => {
    const { hub } = two();
    expect(hub.onConnectorMessage("s3", hello("MARTIN", "devbox"), 50).avatarJob).toBeUndefined();
    expect(
      hub.onConnectorMessage(
        "s4",
        hello("Martin", "laptop", { selfDescription: "beard, hoodie" }),
        51,
      ).avatarJob,
    ).toBeUndefined();
  });

  test("a changed non-empty description issues exactly one new job", () => {
    const { hub, a } = two();
    hub.setAvatar("martin", hub.state().people[0]!.avatar, a.avatarJob!.key, 6);
    const r = hub.onConnectorMessage(
      "s3",
      hello("martin", "devbox", { selfDescription: "bald" }),
      20,
    );
    expect(r.avatarJob).toMatchObject({ selfDescription: "bald" });
    expect(r.avatarJob!.key).not.toBe(a.avatarJob!.key);
    // the laptop (no description now) and the devbox reconnecting: nothing new
    expect(hub.onConnectorMessage("s4", hello("Martin", "laptop"), 21).avatarJob).toBeUndefined();
    expect(
      hub.onConnectorMessage("s5", hello("martin", "devbox", { selfDescription: "bald" }), 22)
        .avatarJob,
    ).toBeUndefined();
    // a stale result of the first job is ignored, the new one lands
    expect(hub.setAvatar("martin", hub.state().people[0]!.avatar, a.avatarJob!.key, 23)).toEqual(
      [],
    );
    hub.setAvatar("martin", hub.state().people[0]!.avatar, r.avatarJob!.key, 24);
  });

  test("person-level description survives a restart", () => {
    const { hub, store, a } = two();
    hub.setAvatar("martin", hub.state().people[0]!.avatar, a.avatarJob!.key, 6);
    expect(store.getAvatar("martin")?.selfDescription).toBe("beard, hoodie");
    for (const restore of [true, false]) {
      const hub2 = new Hub(CFG, store);
      if (restore) hub2.restore(1_000);
      // the machine without a description reconnects first: look stays, no job
      expect(hub2.onConnectorMessage("z1", hello("martin", "devbox"), 1_001).avatarJob).toBe(
        undefined,
      );
      expect(
        hub2.onConnectorMessage(
          "z2",
          hello("Martin", "laptop", { selfDescription: "beard, hoodie" }),
          1_002,
        ).avatarJob,
      ).toBeUndefined();
    }
  });

  test("avatar rows from before descriptions were stored are adopted, not regenerated", () => {
    const { store } = setup();
    const look = avatarFromSeed("someone-else");
    // legacy row: key = defaultAvatarKey(display name, description), no description column
    store.avatars.set("martin", { avatar: look, key: defaultAvatarKey("Martin", "beard") });
    const hub = new Hub(CFG, store);
    expect(hub.onConnectorMessage("a", hello("martin", "devbox"), 0).avatarJob).toBeUndefined();
    expect(hub.state().people[0]!.avatar).toEqual(look);
    expect(
      hub.onConnectorMessage("b", hello("Martin", "laptop", { selfDescription: "beard" }), 1)
        .avatarJob,
    ).toBeUndefined();
    expect(store.getAvatar("martin")).toMatchObject({ avatar: look, selfDescription: "beard" });
    const hub2 = new Hub(CFG, store);
    expect(hub2.onConnectorMessage("c", hello("martin", "devbox"), 2).avatarJob).toBeUndefined();
  });
});

describe("hub: head gif", () => {
  const GIF = "JIX9t2j0ZTN9S";
  const OTHER = "l0HlBO7eyXzSZkJri";

  test("hello carries the gif into the person view", () => {
    const { hub } = setup();
    const r = hub.onConnectorMessage("s1", hello("Anna", "c1", { gif: GIF }), 0);
    const joined = r.events.find((e) => e.type === "person.joined");
    expect(joined?.type === "person.joined" && joined.data.person.gif).toBe(GIF);
    expect(hub.state().people[0]!.gif).toBe(GIF);
    expect(hub.snapshot(1).data.people[0]!.gif).toBe(GIF);
  });

  test("change -> gif.updated; omitted leaves it; empty removes it", () => {
    const { hub, lines } = setup();
    hub.onConnectorMessage("s1", hello("Anna", "c1", { gif: GIF }), 0);
    // a second machine that never set a gif does not touch it
    expect(types(hub.onConnectorMessage("s2", hello("Anna", "c2"), 1).events)).toEqual([]);
    expect(hub.state().people[0]!.gif).toBe(GIF);

    const changed = hub.onConnectorMessage("s1", hello("Anna", "c1", { gif: OTHER }), 2).events;
    expect(types(changed)).toEqual(["gif.updated"]);
    expect(changed[0]!.type === "gif.updated" && changed[0]!.data.gif).toBe(OTHER);
    expect(parseViewerMessage(JSON.parse(JSON.stringify(changed[0]))).ok).toBe(true);
    expect(lines).toContain(`gif.updated anna ${OTHER}`);

    const removed = hub.onConnectorMessage("s1", hello("Anna", "c1", { gif: "" }), 3).events;
    expect(types(removed)).toEqual(["gif.updated"]);
    expect(removed[0]!.type === "gif.updated" && "gif" in removed[0]!.data).toBe(false);
    expect(hub.state().people[0]!.gif).toBeUndefined();
  });

  test("gif changes are not written to history", () => {
    const { hub, store } = setup();
    hub.onConnectorMessage("s1", hello("Anna", "c1"), 0);
    const before = store.history().length;
    hub.onConnectorMessage("s1", hello("Anna", "c1", { gif: GIF }), 1);
    expect(store.history().length).toBe(before);
  });

  test("survives a restart", () => {
    const { hub, store } = setup();
    hub.onConnectorMessage("s1", hello("Anna", "c1", { gif: GIF }), 0);
    const hub2 = new Hub(CFG, store);
    hub2.restore(1_000, [{ socketId: "s1", binding: hub.bindingOf("s1")! }]);
    expect(hub2.state().people[0]!.gif).toBe(GIF);
  });

  test("a hello with a URL instead of an id is rejected", () => {
    const { hub } = setup();
    const r = hub.onConnectorMessage(
      "s1",
      hello("Anna", "c1", { gif: `https://i.giphy.com/${GIF}.gif` }),
      0,
    );
    expect(r.close?.code).toBe(CLOSE_BAD_MESSAGE);
  });

  test("setGif: set, unchanged, remove, unknown person", () => {
    const { hub, store } = setup();
    hub.onConnectorMessage("s1", hello("Anna", "c1"), 0);
    const set = hub.setGif("anna", GIF, 1)!;
    expect(types(set)).toEqual(["gif.updated"]);
    expect(set[0]!.type === "gif.updated" && set[0]!.data).toEqual({ personId: "anna", gif: GIF });
    expect(hub.state().people[0]!.gif).toBe(GIF);
    expect(store.kvGet("hub.state")).toContain(GIF);
    expect(hub.setGif("anna", GIF, 2)).toEqual([]);
    const removed = hub.setGif("anna", undefined, 3)!;
    expect(types(removed)).toEqual(["gif.updated"]);
    expect(removed[0]!.type === "gif.updated" && "gif" in removed[0]!.data).toBe(false);
    expect(hub.state().people[0]!.gif).toBeUndefined();
    expect(hub.setGif("nobody", GIF, 4)).toBeNull();
  });

  test("setGif: a person who left the office is not found", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("Anna", "c1"), 0);
    hub.onConnectorMessage("s1", bye(), 1);
    // still visible during the grace period
    expect(hub.setGif("anna", GIF, 2)).not.toBeNull();
    hub.tick(1 + PERSON_GRACE_MS);
    expect(hub.state().people).toEqual([]);
    expect(hub.setGif("anna", OTHER, 2 + PERSON_GRACE_MS)).toBeNull();
  });

  test("a UI choice survives reconnects until the connector sends a new gif", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("Anna", "c1", { gif: GIF }), 0);
    hub.setGif("anna", OTHER, 1);
    // same connector reconnects on a new socket with the unchanged config value
    hub.onConnectorClosed("s1", 2);
    expect(hub.onConnectorMessage("s2", hello("Anna", "c1", { gif: GIF }), 3).events).toEqual([]);
    expect(hub.state().people[0]!.gif).toBe(OTHER);
    // a hello without gif changes nothing and does not forget the last value
    expect(hub.onConnectorMessage("s3", hello("Anna", "c1"), 4).events).toEqual([]);
    expect(hub.onConnectorMessage("s4", hello("Anna", "c1", { gif: GIF }), 5).events).toEqual([]);
    expect(hub.state().people[0]!.gif).toBe(OTHER);
    // the user ran `agent-office gif` again: that wins
    const third = "xT9IgG50Fb7Mi0prBC";
    const r = hub.onConnectorMessage("s5", hello("Anna", "c1", { gif: third }), 6).events;
    expect(types(r)).toEqual(["gif.updated"]);
    expect(hub.state().people[0]!.gif).toBe(third);
    // ... and so does `agent-office gif off`, after another UI choice
    hub.setGif("anna", GIF, 7);
    hub.onConnectorMessage("s6", hello("Anna", "c1", { gif: "" }), 8);
    expect(hub.state().people[0]!.gif).toBeUndefined();
  });

  test("each machine of a person tracks its own last gif", () => {
    const { hub } = setup();
    hub.onConnectorMessage("a1", hello("Anna", "laptop", { gif: GIF }), 0);
    // a brand-new connector with a gif counts as a change
    hub.onConnectorMessage("b1", hello("Anna", "desktop", { gif: OTHER }), 1);
    expect(hub.state().people[0]!.gif).toBe(OTHER);
    // the laptop reconnecting with its unchanged value does not flip it back
    hub.onConnectorMessage("a2", hello("Anna", "laptop", { gif: GIF }), 2);
    expect(hub.state().people[0]!.gif).toBe(OTHER);
  });

  test("renaming applies the config gif to the new person; renaming back does not undo a UI choice", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("Anna", "c1", { gif: GIF }), 0);
    hub.setGif("anna", OTHER, 1);
    // renamed: a new person, so the connector's gif counts for them
    hub.onConnectorMessage("s2", hello("Annie", "c1", { gif: GIF }), 2);
    expect(hub.state().people.find((p) => p.personId === "annie")?.gif).toBe(GIF);
    // back to Anna with the same config value: anna keeps the GIF chosen in the UI
    hub.onConnectorMessage("s3", hello("Anna", "c1", { gif: GIF }), 3);
    expect(hub.state().people.find((p) => p.personId === "anna")?.gif).toBe(OTHER);
  });

  test("the gif is back when a person returns after leaving", () => {
    const { hub } = setup();
    hub.onConnectorMessage("s1", hello("Anna", "c1", { gif: GIF }), 0);
    hub.setGif("anna", OTHER, 1);
    hub.onConnectorMessage("s1", bye(), 2);
    hub.tick(2 + PERSON_GRACE_MS);
    expect(hub.state().people).toEqual([]);
    const r = hub.onConnectorMessage("s2", hello("Anna", "c1", { gif: GIF }), 10 * PERSON_GRACE_MS);
    const joined = r.events.find((e) => e.type === "person.joined");
    expect(joined?.type === "person.joined" && joined.data.person.gif).toBe(OTHER);
  });

  test("UI choice and remembered hello values survive a restart and connector expiry", () => {
    const { hub, store } = setup();
    hub.onConnectorMessage("s1", hello("Anna", "c1", { gif: GIF }), 0);
    hub.setGif("anna", OTHER, 1);
    const hub2 = new Hub(CFG, store);
    hub2.restore(1_000, [{ socketId: "s1", binding: hub.bindingOf("s1")! }]);
    expect(hub2.state().people[0]!.gif).toBe(OTHER);
    // the laptop goes offline long enough for its connector record and the person to expire
    hub2.onConnectorClosed("s1", 1_001);
    const gone = 1_001 + CONNECTOR_TIMEOUT_MS + 10;
    hub2.tick(gone);
    hub2.tick(gone + PERSON_GRACE_MS);
    expect(hub2.state().people).toEqual([]);
    const hub3 = new Hub(CFG, store);
    hub3.restore(10_000_000);
    expect(
      hub3.onConnectorMessage("s2", hello("Anna", "c1", { gif: GIF }), 10_000_001).events,
    ).toHaveLength(1); // person.joined only
    expect(hub3.state().people[0]!.gif).toBe(OTHER);
  });

  test("old persisted state: gif on the person, last hello values seeded from connectors", () => {
    const store = new MemoryStore();
    const binding = { clientId: "c1", name: "Anna", personId: "anna", connectorVersion: "0.1.5" };
    store.kvPut(
      "hub.state",
      JSON.stringify({
        v: 1,
        connectors: [{ ...binding, gif: GIF, socketId: null, lastSeen: 0, sessions: [] }],
        people: [
          {
            personId: "anna",
            name: "Anna",
            joinedAt: 0,
            goneSince: null,
            avatar: avatarFromSeed("anna"),
            gif: OTHER,
          },
        ],
      }),
    );
    const hub = new Hub(CFG, store);
    hub.restore(10);
    expect(hub.state().people[0]!.gif).toBe(OTHER);
    // the first reconnect after the deploy does not re-apply the unchanged config value
    expect(hub.onConnectorMessage("s1", hello("Anna", "c1", { gif: GIF }), 11).events).toEqual([]);
    expect(hub.state().people[0]!.gif).toBe(OTHER);
    // the new format is written
    const saved = JSON.parse(store.kvGet("hub.state")!);
    expect(saved.gifs).toEqual({ anna: OTHER });
    expect(saved.helloGifs).toEqual({ "c1/anna": GIF });
    expect(saved.people[0].gif).toBeUndefined();
  });
});

describe("hub: detailed looks", () => {
  const TRACHT = LOOK_FIXTURES.tracht;
  const LONG =
    `Slicked-back brown hair, panto glasses. ${"Janker, lederhosen, white sneakers. ".repeat(250)}`
      .slice(0, MAX_SELF_DESCRIPTION)
      .trim();
  const longHello = (clientId: string) =>
    hello("Thomas", clientId, { selfDescription: LONG.slice(0, 200), lookDescription: LONG });

  test("lookDescription wins over the 200-char head; the job carries the full text", () => {
    const { hub, store } = setup();
    const r = hub.onConnectorMessage("s1", longHello("c1"), 0);
    expect(r.avatarJob?.selfDescription).toBe(LONG);
    hub.setAvatar("thomas", TRACHT, r.avatarJob!.key, 1);
    expect(store.getAvatar("thomas")).toMatchObject({ avatar: TRACHT, selfDescription: LONG });
    // hub.state carries neither the text nor the look; the avatars row does, so restored
    // people regenerate nothing and keep their look
    const persisted = store.kvGet("hub.state")!;
    expect(persisted).not.toContain("lederhosen");
    expect(persisted).not.toContain('"look"');
    const hub2 = new Hub(CFG, store);
    hub2.restore(10);
    expect(hub2.onConnectorMessage("s2", longHello("c1"), 11).avatarJob).toBeUndefined();
    expect(hub2.state().people[0]!.avatar).toEqual(TRACHT);
  });

  test("a long description stays out of the socket attachment (2 KiB cap)", () => {
    const { hub, store } = setup();
    const r = hub.onConnectorMessage("s1", longHello("c1"), 0);
    expect(r.binding).toBeDefined();
    expect(r.binding!.selfDescription).toBeUndefined();
    expect(JSON.stringify(r.binding).length).toBeLessThan(2048);
    hub.setAvatar("thomas", TRACHT, r.avatarJob!.key, 1);
    hub.onConnectorMessage("s1", snap(s("a")), 2);
    // hibernation wake with the attachment's binding; the connector timed out meanwhile, so
    // the snapshot revives it from that binding: no description change, no job, same look
    const hub2 = new Hub(CFG, store);
    hub2.restore(3, [{ socketId: "s1", binding: r.binding! }]);
    hub2.tick(3 + CONNECTOR_TIMEOUT_MS + CONNECTOR_STALE_MS + 10);
    const revived = hub2.onConnectorMessage("s1", snap(s("a")), 4 + CONNECTOR_TIMEOUT_MS * 2);
    expect(revived.avatarJob).toBeUndefined();
    expect(store.getAvatar("thomas")?.selfDescription).toBe(LONG);
    expect(
      hub2.onConnectorMessage("s3", longHello("c1"), 5 + CONNECTOR_TIMEOUT_MS * 2).avatarJob,
    ).toBeUndefined();
  });

  test("short descriptions keep the old wire shape and behaviour", () => {
    const { hub } = setup();
    const desc = "b".repeat(200);
    const r = hub.onConnectorMessage("s1", hello("Old", "c1", { selfDescription: desc }), 0);
    expect(r.avatarJob?.selfDescription).toBe(desc);
    expect(r.binding?.selfDescription).toBe(desc);
  });

  test("the job carries the stored look as `previous`", () => {
    const { hub, store } = setup();
    expect(
      hub.onConnectorMessage("s1", hello("Ann", "c1", { selfDescription: "x" }), 0).avatarJob,
    ).not.toHaveProperty("previous");
    store.putAvatar("bob", TRACHT, "old-key", "old");
    const job = hub.onConnectorMessage("s2", hello("Bob", "c2", { selfDescription: "new" }), 1)
      .avatarJob!;
    expect(job.previous).toEqual(TRACHT);
  });

  test("stored and persisted avatars are repaired on load", () => {
    const { store } = setup();
    const bad = {
      ...TRACHT,
      look: { ...TRACHT.look, vest: 42, shirt: { ...TRACHT.look.shirt, ramp: "white" } },
    } as unknown as AvatarSpec;
    store.putAvatar("thomas", bad, "k", "d");
    const hub = new Hub(CFG, store);
    hub.onConnectorMessage("s1", hello("Thomas", "c1"), 0);
    const avatar = hub.state().people[0]!.avatar;
    expect(avatar.look?.outer).toEqual(TRACHT.look.outer);
    expect(avatar.look?.vest.kind).toBe("none");
    expect(avatar.look?.shirt.ramp.base).toMatch(/^#[0-9a-f]{6}$/);
    expect(parseViewerMessage(JSON.stringify(hub.snapshot(1))).ok).toBe(true);

    // persisted hub.state with garbage avatar and no avatars row
    const store2 = setup().store;
    store2.kvPut(
      "hub.state",
      JSON.stringify({
        v: 1,
        connectors: [],
        people: [
          { personId: "zed", name: "Zed", joinedAt: 0, goneSince: 0, avatar: { hairStyle: 7 } },
        ],
      }),
    );
    const hub2 = new Hub(CFG, store2);
    hub2.restore(1);
    expect(hub2.state().people[0]!.avatar).toEqual(avatarFromSeed("zed"));
  });

  test("restore takes the look from the avatars table (setAvatar does not re-persist)", () => {
    const { hub, store } = setup();
    const r = hub.onConnectorMessage("s1", hello("Thomas", "c1", { selfDescription: "x" }), 0);
    hub.onConnectorMessage("s1", snap(s("a")), 1);
    hub.setAvatar("thomas", TRACHT, r.avatarJob!.key, 2);
    const hub2 = new Hub(CFG, store);
    hub2.restore(3, [{ socketId: "s1", binding: hub.bindingOf("s1")! }]);
    expect(hub2.state().people[0]!.avatar).toEqual(TRACHT);
  });

  test("L1 key bump: one job per person, then stable across reconnects and restarts", async () => {
    const store = new MemoryStore();
    const svc = createAvatarService(
      { GENUI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" },
      store,
      {
        fetch: async () =>
          Response.json({
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify(TRACHT) }],
          }),
      },
    );
    const cfg = { ...CFG, avatarKey: svc.cacheKey };
    // rows written by the previous release: `${provider}:${hash}` without the revision
    const oldKey = (id: string, d: string) => `anthropic:${hashString(`${id}\n${d}`).toString(36)}`;
    const oldLook = avatarFromSeed("old-look");
    store.putAvatar("thomas", oldLook, oldKey("thomas", "tracht"), "tracht");
    store.putAvatar("nora", oldLook, oldKey("nora", ""), "");
    const hub = new Hub(cfg, store);
    const jobs = [
      hub.onConnectorMessage("a", hello("Thomas", "c1", { selfDescription: "tracht" }), 0)
        .avatarJob,
      hub.onConnectorMessage("b", hello("Nora", "c2"), 0).avatarJob,
    ];
    expect(jobs.map((j) => j?.personId)).toEqual(["thomas", "nora"]);
    for (const j of jobs) {
      const res = await svc.resolve(j!);
      hub.setAvatar(j!.personId, res.avatar, res.key, 1);
    }
    expect(svc.callsToday()).toBe(1); // nora has no description: no call, look kept
    expect(store.getAvatar("thomas")?.avatar).toEqual(TRACHT);
    expect(store.getAvatar("nora")?.avatar).toEqual(oldLook);
    expect(
      hub.onConnectorMessage("c", hello("Thomas", "c1", { selfDescription: "tracht" }), 2)
        .avatarJob,
    ).toBeUndefined();
    const hub2 = new Hub(cfg, store);
    expect(
      hub2.onConnectorMessage("d", hello("Thomas", "c1", { selfDescription: "tracht" }), 3)
        .avatarJob,
    ).toBeUndefined();
    expect(hub2.onConnectorMessage("e", hello("Nora", "c2"), 3).avatarJob).toBeUndefined();
  });

  test("two machines with different descriptions do not flip the look on reconnects", () => {
    const { hub, store } = setup();
    const head = LONG.slice(0, 200); // e.g. an old connector config holding the truncated text
    const laptop = () => hello("Thomas", "laptop", { selfDescription: head });
    let jobs = 0;
    let t = 0;
    const run = (sock: string, msg: string) => {
      const r = hub.onConnectorMessage(sock, msg, t++);
      if (r.avatarJob) {
        jobs++;
        hub.setAvatar("thomas", TRACHT, r.avatarJob.key, t++);
      }
    };
    run("a0", laptop());
    run("b0", longHello("devbox"));
    expect(jobs).toBe(2); // first description, then the new machine's (newer) one
    for (let i = 1; i <= 6; i++) {
      run(`a${i}`, laptop());
      run(`b${i}`, longHello("devbox"));
    }
    expect(jobs).toBe(2);
    // the same, after the people and connectors expired and a fresh hub restarted
    const hub2 = new Hub(CFG, store);
    for (const [sock, msg] of [
      ["x1", laptop()],
      ["x2", longHello("devbox")],
      ["x3", laptop()],
    ] as const)
      expect(hub2.onConnectorMessage(sock, msg, 1_000).avatarJob).toBeUndefined();
    // a description newly set on one machine still wins
    const r = hub2.onConnectorMessage(
      "x4",
      hello("Thomas", "laptop", { selfDescription: "bald" }),
      1_001,
    );
    expect(r.avatarJob?.selfDescription).toBe("bald");
  });

  test("hub.state stays small: no descriptions, no detailed looks", () => {
    const { hub, store } = setup();
    for (let i = 0; i < 50; i++) {
      const desc = `${i} ${"x".repeat(MAX_SELF_DESCRIPTION - 8)}`;
      const r = hub.onConnectorMessage(
        `s${i}`,
        hello(`Person ${i}`, `c${i}`, {
          selfDescription: desc.slice(0, 200),
          lookDescription: desc,
        }),
        i,
      );
      hub.onConnectorMessage(`s${i}`, snap(s("a")), i);
      hub.setAvatar(`person-${i}`, TRACHT, r.avatarJob!.key, i);
    }
    const state = store.kvGet("hub.state")!;
    expect(JSON.parse(state).people).toHaveLength(50);
    expect(state.length).toBeLessThan(50 * 1_000);
    expect(store.kvGet("hub.clientDescs")!.length).toBeLessThan(50 * 40);
    // restore: looks from the avatars table; without a row, the catalog avatar from hub.state
    store.avatars.delete("person-0");
    const hub2 = new Hub(CFG, store);
    hub2.restore(100);
    const people = hub2.state().people;
    expect(people.find((p) => p.personId === "person-1")?.avatar).toEqual(TRACHT);
    const { look: _l, ...catalog } = TRACHT;
    expect(people.find((p) => p.personId === "person-0")?.avatar).toEqual(catalog);
  });

  test("descriptions never reach viewers", () => {
    const { hub } = setup();
    const events = [
      ...hub.onConnectorMessage("s1", longHello("c1"), 0).events,
      ...hub.onConnectorMessage("s1", snap(s("a")), 1).events,
    ];
    const r = hub.onConnectorMessage("s2", hello("Ann", "c2", { selfDescription: "red scarf" }), 2);
    events.push(...r.events, ...hub.setAvatar("ann", TRACHT, r.avatarJob!.key, 3));
    const wire = JSON.stringify([events, hub.snapshot(4)]);
    expect(wire).not.toContain("Janker, lederhosen");
    expect(wire).not.toContain("red scarf");
  });

  test("provider off / key missing: a generated look survives and is not regenerated later", async () => {
    const store = new MemoryStore();
    const fetchTracht = async () =>
      Response.json({
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(TRACHT) }],
      });
    const on = createAvatarService({ GENUI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }, store, {
      fetch: fetchTracht,
    });
    const off = createAvatarService({ GENUI_PROVIDER: "anthropic" }, store); // key missing
    const cycle = async (svc: typeof on, t: number) => {
      const hub = new Hub({ ...CFG, avatarKey: svc.cacheKey }, store);
      const r = hub.onConnectorMessage("s", longHello("c1"), t);
      if (r.avatarJob) {
        const res = await svc.resolve(r.avatarJob);
        hub.setAvatar("thomas", res.avatar, res.key, t + 1);
      }
      return { job: r.avatarJob, avatar: hub.state().people[0]!.avatar };
    };
    expect((await cycle(on, 0)).avatar).toEqual(TRACHT);
    expect(on.callsToday()).toBe(1);
    const offRun = await cycle(off, 10);
    expect(offRun.job).toBeUndefined(); // same key regardless of provider
    expect(offRun.avatar).toEqual(TRACHT);
    expect((await cycle(on, 20)).job).toBeUndefined();
    expect(on.callsToday()).toBe(1);
    // a person described while off keeps the seeded look under a retry key, generated later
    const hubOff = new Hub({ ...CFG, avatarKey: off.cacheKey }, store);
    const j = hubOff.onConnectorMessage(
      "n",
      hello("Nina", "n1", { selfDescription: "red scarf" }),
      30,
    ).avatarJob!;
    const res = await off.resolve(j);
    expect(res.key).toEndWith(":fallback");
    hubOff.setAvatar("nina", res.avatar, res.key, 31);
    const hubOn = new Hub({ ...CFG, avatarKey: on.cacheKey }, store);
    expect(
      hubOn.onConnectorMessage("n", hello("Nina", "n1", { selfDescription: "red scarf" }), 40)
        .avatarJob,
    ).toBeDefined();
  });
});

describe("hub: custom looks", () => {
  const custom = {
    ...avatarFromSeed("tom"),
    accessory: "cap-mint",
    outfit: "flannel",
    leftHand: "beer",
    rightHand: "joint",
  } as const;
  const join = (hub: Hub, desc?: string, sock = "s1") => {
    const r = hub.onConnectorMessage(
      sock,
      hello("Tom", "mac", desc ? { selfDescription: desc } : {}),
      1_000,
    );
    if (r.avatarJob) hub.setAvatar("tom", avatarFromSeed("tom"), r.avatarJob.key, 1_000);
    return r;
  };

  test("an edited look is persisted and survives a restart (hibernation)", () => {
    const { hub, store } = setup();
    join(hub);
    const r = hub.setCustomAvatar("tom", custom, 2_000)!;
    expect(types(r.events)).toEqual(["avatar.updated"]);
    expect(JSON.parse(store.kvGet("hub.state")!).people[0].avatar).toEqual(custom);

    const hub2 = new Hub(CFG, store);
    hub2.restore(3_000, [{ socketId: "s1", binding: hub.bindingOf("s1")! }]);
    expect(hub2.snapshot(3_000).data.people[0]!.avatar).toEqual(custom);
    // and a reconnect after the restart neither replaces it nor asks GenUI
    const again = hub2.onConnectorMessage("s2", hello("Tom", "mac"), 4_000);
    expect(again.avatarJob).toBeUndefined();
    expect(hub2.snapshot(4_000).data.people[0]!.avatar).toEqual(custom);
  });

  test("restore repairs persisted state written before the edit", () => {
    const { hub, store } = setup();
    join(hub);
    const stale = store.kvGet("hub.state")!;
    hub.setCustomAvatar("tom", custom, 2_000);
    store.kvPut("hub.state", stale);
    const hub2 = new Hub(CFG, store);
    hub2.restore(3_000);
    expect(hub2.snapshot(3_000).data.people[0]!.avatar).toEqual(custom);
  });

  test("Automatic restores the kept automatic look without a GenUI job", () => {
    const { hub, store } = setup();
    join(hub, "curly hair");
    const auto = store.getAvatar("tom")!;
    hub.setCustomAvatar("tom", custom, 2_000);
    expect(store.getAvatar("tom")).toEqual(auto); // the automatic row is untouched
    const back = hub.setCustomAvatar("tom", null, 3_000)!;
    expect(back.avatarJob).toBeUndefined();
    expect(back.avatar).toEqual(auto.avatar);
    expect(types(back.events)).toEqual(["avatar.updated"]);
    expect(hub.isCustomLook("tom")).toBe(false);
  });

  test("a new description while custom: no job now, one job on Automatic", () => {
    const { hub } = setup();
    join(hub, "curly hair");
    hub.setCustomAvatar("tom", custom, 2_000);
    const r = join(hub, "blue mohawk", "s2");
    expect(r.avatarJob).toBeUndefined();
    expect(hub.snapshot(2_500).data.people[0]!.avatar).toEqual(custom);
    const back = hub.setCustomAvatar("tom", null, 3_000)!;
    expect(back.avatarJob?.selfDescription).toBe("blue mohawk");
  });

  test("GenUI results while custom fill the automatic row but don't show", () => {
    const { hub, store } = setup();
    const r = hub.onConnectorMessage("s1", hello("Tom", "mac", { selfDescription: "x" }), 1_000);
    hub.setCustomAvatar("tom", custom, 1_500);
    const generated = { ...avatarFromSeed("someone"), outfit: "jacket" } as const;
    expect(hub.setAvatar("tom", generated, r.avatarJob!.key, 2_000)).toEqual([]);
    expect(store.getAvatar("tom")!.avatar).toEqual(generated);
    expect(hub.setCustomAvatar("tom", null, 3_000)!.avatar).toEqual(generated);
  });
});

describe("hub: custom looks win over GenUI (detailed looks)", () => {
  const TRACHT = LOOK_FIXTURES.tracht;
  /** what the editor sends: the avatar it was opened with (GenUI look included) + picks */
  const edited: AvatarSpec = {
    ...TRACHT,
    accessory: "cap-mint",
    outfit: "flannel",
    leftHand: "beer",
    rightHand: "joint",
  };
  const { look: _l, ...picked } = edited;

  test("a custom look is stored and shown with catalog ids only", () => {
    const { hub, store } = setup();
    hub.onConnectorMessage("s1", hello("Tom", "mac"), 1_000);
    const r = hub.setCustomAvatar("tom", edited, 2_000)!;
    expect(r.avatar).toEqual(picked);
    expect(store.getCustomAvatar("tom")).toEqual(picked);
    const shown = hub.snapshot(2_000).data.people[0]!.avatar;
    expect(shown).toEqual(picked);
    // so the renderer derives the look from the picks: flannel, beer, mint cap
    const look = resolveLook(shown);
    expect(look).toEqual(lookFromCatalog(picked));
    expect(look.outer.pattern.kind).toBe("plaid");
    expect(look.extras).toMatchObject({ leftHand: "beer", rightHand: "joint" });
  });

  test("a custom row stored with a detailed look is shown without it", () => {
    const { hub, store } = setup();
    store.putCustomAvatar("tom", edited); // e.g. written before this rule
    hub.onConnectorMessage("s1", hello("Tom", "mac"), 1_000);
    expect(hub.snapshot(1_000).data.people[0]!.avatar).toEqual(picked);
    const hub2 = new Hub(CFG, store);
    hub2.restore(2_000, [{ socketId: "s1", binding: hub.bindingOf("s1")! }]);
    expect(hub2.snapshot(2_000).data.people[0]!.avatar).toEqual(picked);
  });

  test("a detailed GenUI answer while custom fills the automatic row, never the shown look", () => {
    const { hub, store } = setup();
    const r = hub.onConnectorMessage(
      "s1",
      hello("Tom", "mac", { selfDescription: "tracht", lookDescription: "Tracht. ".repeat(40) }),
      1_000,
    );
    const job = r.avatarJob!;
    hub.setCustomAvatar("tom", edited, 1_500);
    // the job that was in flight comes back with a detailed look
    expect(hub.setAvatar("tom", TRACHT, job.key, 2_000)).toEqual([]);
    expect(hub.snapshot(2_000).data.people[0]!.avatar).toEqual(picked);
    expect(store.getAvatar("tom")!.avatar).toEqual(TRACHT);
    // a reconnect neither asks GenUI nor swaps the look
    expect(hub.onConnectorMessage("s2", hello("Tom", "mac"), 3_000).avatarJob).toBeUndefined();
    expect(hub.snapshot(3_000).data.people[0]!.avatar).toEqual(picked);
    // Automatic brings the detailed look back for free
    const back = hub.setCustomAvatar("tom", null, 4_000)!;
    expect(back.avatarJob).toBeUndefined();
    expect(back.avatar).toEqual(TRACHT);
  });

  test("a new description while custom never writes the custom look into the automatic row", () => {
    const { hub, store } = setup();
    hub.onConnectorMessage("s1", hello("Tom", "mac"), 1_000); // no automatic row yet
    hub.setCustomAvatar("tom", edited, 1_500);
    const r = hub.onConnectorMessage(
      "s2",
      hello("Tom", "laptop", { selfDescription: "red scarf, blue beanie" }),
      2_000,
    );
    expect(r.avatarJob).toBeUndefined();
    const auto = store.getAvatar("tom")!;
    expect(auto.selfDescription).toBe("red scarf, blue beanie");
    expect(auto.avatar).toEqual(avatarFromSeed("tom"));
    // Automatic generates for the new description, with the automatic row as `previous`
    const back = hub.setCustomAvatar("tom", null, 3_000)!;
    expect(back.avatarJob).toMatchObject({
      selfDescription: "red scarf, blue beanie",
      previous: avatarFromSeed("tom"),
    });
  });
});

describe("hub: look studio (describeLook)", () => {
  const countWrites = (store: MemoryStore) => {
    const writes: (string | undefined)[] = [];
    const put = store.putAvatar.bind(store);
    store.putAvatar = (personId, avatar, key, selfDescription) => {
      writes.push(selfDescription);
      put(personId, avatar, key, selfDescription);
    };
    return writes;
  };

  test("the same text again still returns a job but writes no row; new text does", () => {
    const { hub, store } = setup();
    hub.onConnectorMessage("s1", hello("Tom", "mac"), 1_000);
    const writes = countWrites(store);

    const first = hub.describeLook("tom", "curly hair")!;
    expect(first.selfDescription).toBe("curly hair");
    expect(writes).toEqual(["curly hair"]);
    expect(store.getAvatar("tom")!.selfDescription).toBe("curly hair");

    // "Generate" again (AI off / cap reached: no setAvatar in between)
    const again = hub.describeLook("tom", "curly hair")!;
    expect(again.key).toBe(first.key);
    expect(writes).toEqual(["curly hair"]);

    hub.describeLook("tom", "blue mohawk");
    expect(writes).toEqual(["curly hair", "blue mohawk"]);
    expect(store.getAvatar("tom")!.selfDescription).toBe("blue mohawk");
  });

  test("no row: an empty text writes nothing, a non-empty one is kept for a restart", () => {
    const { hub, store } = setup();
    hub.onConnectorMessage("s1", hello("Tom", "mac"), 1_000);
    expect(store.getAvatar("tom")).toBeNull();
    const writes = countWrites(store);

    expect(hub.describeLook("tom", "")).not.toBeNull();
    expect(writes).toEqual([]);
    expect(hub.descriptionOf("tom")).toBe("");

    hub.describeLook("tom", "curly hair");
    expect(writes).toEqual(["curly hair"]);
    expect(new Hub(CFG, store).descriptionOf("tom")).toBe("curly hair");
  });
});
