import { describe, expect, test } from "bun:test";
import {
  avatarFromSeed,
  CLOSE_BAD_MESSAGE,
  CLOSE_BAD_PASSWORD,
  CLOSE_TOO_OLD,
  CONNECTOR_STALE_MS,
  CONNECTOR_TIMEOUT_MS,
  envelope,
  PERSON_GRACE_MS,
  parseServerToConnector,
  parseViewerMessage,
  type SessionInfo,
  type ViewerEvent,
} from "@agent-office/protocol";
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
