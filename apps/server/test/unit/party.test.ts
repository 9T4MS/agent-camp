import { describe, expect, test } from "bun:test";
import {
  avatarFromSeed,
  envelope,
  type HeldItem,
  PartyState,
  parseViewerMessage,
  type Vehicle,
} from "@agent-office/protocol";
import { OfficeApp } from "../../src/core/app.ts";
import { makeSessionToken, SESSION_COOKIE } from "../../src/core/auth.ts";
import {
  PARTY_BODY_MAX_BYTES,
  PARTY_COOLDOWN_MS,
  PARTY_EVENT_TTL_MS,
  PARTY_MAX_REQUESTERS,
  PARTY_REQUEST_INTERVAL_MS,
  Party,
} from "../../src/core/party.ts";
import { MemoryStore } from "../../src/core/store.ts";

function setup(store = new MemoryStore(), env: Record<string, string> = {}) {
  let now = 1_000_000;
  let requester = 0;
  const sent: string[] = [];
  const alarms: (number | null)[] = [];
  const app = new OfficeApp(
    { CONNECTOR_PASSWORD: "pw", ...env },
    store,
    { broadcast: (value) => sent.push(value), scheduleAlarm: (value) => alarms.push(value) },
    { now: () => now, log: () => {} },
  );
  for (const name of ["Anna", "Bob"])
    app.connectorMessage(
      name,
      envelope("connector.hello", {
        name,
        password: "pw",
        clientId: name,
        connectorVersion: "1.0.0",
      }),
    );
  const post = (
    body: unknown,
    opts: { auth?: string | null; cookie?: string; ip?: string; raw?: string; key?: string } = {},
  ) =>
    app.handleHttp(
      new Request(`http://office/api/party${opts.key ? `?key=${opts.key}` : ""}`, {
        method: "POST",
        body: opts.raw ?? JSON.stringify(body),
        headers: {
          ...(opts.auth === null ? {} : { authorization: opts.auth ?? "Bearer pw" }),
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
          "cf-connecting-ip": opts.ip ?? `test-ip-${++requester}`,
        },
      }),
    );
  const state = () => PartyState.parse(app.snapshot().data.party);
  const equip = (
    item: HeldItem = "confetti",
    vehicle: Vehicle = "car",
    left: HeldItem = "beer",
  ) => {
    app.hub.setCustomAvatar(
      "anna",
      { ...avatarFromSeed("anna"), rightHand: item, leftHand: left, vehicle },
      now,
    );
  };
  return {
    app,
    post,
    state,
    equip,
    store,
    sent,
    alarms,
    advance: (ms = PARTY_COOLDOWN_MS) => {
      now += ms;
    },
  };
}

describe("party API uses canonical avatars and viewer socket state", () => {
  test("cookie/bearer/viewer-key authorized writes; unauthorized reads do not exist", async () => {
    const { app, post, advance } = setup(undefined, { VIEWER_KEY: "view" });
    const cookie = `${SESSION_COOKIE}=${await makeSessionToken("pw", 1_000_000)}`;
    expect((await post({ personId: "anna", action: "wave" }, { auth: null, cookie }))!.status).toBe(
      200,
    );
    advance();
    expect(
      (await post({ personId: "anna", action: "wave" }, { auth: null, key: "view" }))!.status,
    ).toBe(200);
    expect((await post({ malformed: true }, { auth: null }))!.status).toBe(401);
    expect(
      (await post({ personId: "anna", action: "wave" }, { auth: "Bearer wrong" }))!.status,
    ).toBe(401);
    expect((await app.handleHttp(new Request("http://office/api/party")))!.status).toBe(405);
  });

  test("strict action payload rejects all old/forged cosmetics and server fields", async () => {
    const { post } = setup();
    for (const body of [
      { personId: "anna", action: "wave", look: {} },
      { personId: "anna", action: "wave", profiles: {} },
      { personId: "anna", action: "race", roll: 6 },
      { personId: "anna", action: "use", item: "confetti" },
      { personId: "anna", action: "race", vehicle: "car" },
      { personId: "anna", action: "wave", scores: { anna: 999 } },
      { personId: "anna" },
      { personId: "anna", action: "teleport" },
      { personId: "anna", action: "use", hand: "third" },
      { personId: "anna", action: "tag" },
      { personId: "anna", action: "high-five", targetId: "anna" },
    ])
      expect((await post(body))!.status).toBe(400);
  });

  test("default right hand falls back left; explicit hand is honored and cannot forge an empty slot", async () => {
    const { post, state, equip, advance } = setup();
    expect((await post({ personId: "anna", action: "use" }))!.status).toBe(400);
    expect((await post({ personId: "anna", action: "race" }))!.status).toBe(400);
    equip();
    expect((await post({ personId: "anna", action: "use" }))!.status).toBe(200);
    expect(state().events.at(-1)).toMatchObject({ item: "confetti", vehicle: "car" });
    advance();
    await post({ personId: "anna", action: "use", hand: "left" });
    expect(state().events.at(-1)!.item).toBe("beer");
    advance();
    equip("none", "none", "umbrella");
    expect((await post({ personId: "anna", action: "use", hand: "right" }))!.status).toBe(400);
    await post({ personId: "anna", action: "use" });
    expect(state().events.at(-1)).toMatchObject({ item: "umbrella", vehicle: "none" });
  });

  test("rejects disconnected/stale actors and targets retained in the roster", async () => {
    const first = setup();
    first.app.connectorClosed("Anna");
    expect(first.app.hub.state().people.some((p) => p.personId === "anna")).toBe(true);
    expect((await first.post({ personId: "anna", action: "dance" }))!.status).toBe(404);
    expect((await first.post({ personId: "bob", action: "tag", targetId: "anna" }))!.status).toBe(
      404,
    );
    const second = setup();
    second.advance(76_000);
    expect((await second.post({ personId: "anna", action: "dance" }))!.status).toBe(404);
  });

  test("snapshot and broadcast schemas validate; no private cooldown/IP/equipment profile data escapes", async () => {
    const { app, equip, post, state, sent, alarms } = setup();
    equip();
    const beforeAlarms = alarms.length;
    const result = (await post({ personId: "anna", action: "use" }))!;
    expect(PartyState.parse(await result.json())).toEqual(state());
    const broadcast = parseViewerMessage(sent.at(-1)!);
    expect(broadcast.ok).toBe(true);
    if (broadcast.ok && broadcast.msg.type === "party.updated")
      expect(broadcast.msg.data.party).toEqual(state());
    else throw new Error("missing party.updated");
    const snapshot = parseViewerMessage(app.viewerSnapshot());
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok && snapshot.msg.type === "office.snapshot")
      expect(snapshot.msg.data.party).toEqual(state());
    expect(Object.keys(state()).sort()).toEqual(["events", "scores"]);
    expect(JSON.stringify(state())).not.toContain("test-ip");
    expect(JSON.stringify(state())).not.toContain("cooldowns");
    expect(alarms).toHaveLength(beforeAlarms); // no party timer/periodic wakeup
  });

  test("server-generated race scores and social points survive restart with actor cooldown", async () => {
    const first = setup();
    first.equip();
    await first.post({ personId: "anna", action: "race" });
    const race = first.state().events.at(-1)!;
    expect(race.roll).toBeGreaterThanOrEqual(1);
    expect(race.roll).toBeLessThanOrEqual(6);
    expect(first.state().scores.anna).toBe(race.roll!);
    const restarted = setup(first.store);
    expect(restarted.state().events).toEqual([]);
    const limited = (await restarted.post({ personId: "anna", action: "wave" }))!;
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    restarted.advance();
    await restarted.post({ personId: "anna", action: "high-five", targetId: "bob" });
    expect(restarted.state().scores).toEqual({ anna: race.roll! + 1, bob: 1 });
    restarted.advance();
    await restarted.post({ personId: "anna", action: "tag", targetId: "bob" });
    expect(restarted.state().scores).toEqual({ anna: race.roll! + 2, bob: 1 });
    restarted.advance(PARTY_EVENT_TTL_MS);
    expect(restarted.state().events).toEqual([]);
  });

  test("rate limits malformed and unauthorized attempts before parsing, persists by IP across actors/restart", async () => {
    const first = setup();
    expect((await first.post(null, { raw: "{", ip: "same" }))!.status).toBe(400);
    expect((await first.post({ personId: "bob", action: "dance" }, { ip: "same" }))!.status).toBe(
      429,
    );
    expect((await first.post(null, { auth: null, ip: "unauthorized" }))!.status).toBe(401);
    expect(
      (await first.post({ personId: "anna", action: "dance" }, { ip: "unauthorized" }))!.status,
    ).toBe(429);
    const restarted = setup(first.store);
    const limited = (await restarted.post({ personId: "bob", action: "dance" }, { ip: "same" }))!;
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    restarted.advance(PARTY_REQUEST_INTERVAL_MS);
    expect(
      (await restarted.post({ personId: "bob", action: "dance" }, { ip: "same" }))!.status,
    ).toBe(200);
    expect(
      (await restarted.post({ personId: "anna", action: "dance" }, { ip: "same" }))!.status,
    ).toBe(429);
  });

  test("limiter capacity preserves active entries and prunes expired ones without resetting all limits", () => {
    const store = new MemoryStore();
    const party = new Party(store);
    const now = 1_000_000;
    for (let i = 0; i < PARTY_MAX_REQUESTERS; i++)
      expect(party.requestAllowed(`ip-${i}`, now)).toBeNull();
    expect(party.requestAllowed("overflow", now)).toBeGreaterThan(0);
    expect(party.requestAllowed("ip-0", now)).toBeGreaterThan(0);
    expect(Object.keys(JSON.parse(store.kvGet("party.requests.v1")!))).toHaveLength(
      PARTY_MAX_REQUESTERS,
    );
    expect(party.requestAllowed("new", now + PARTY_REQUEST_INTERVAL_MS)).toBeNull();
    expect(Object.keys(JSON.parse(store.kvGet("party.requests.v1")!))).toEqual(["new"]);
  });

  test("rejects actual oversized bytes without Content-Length and bounds transient events", async () => {
    const { post } = setup();
    expect((await post(null, { raw: " ".repeat(PARTY_BODY_MAX_BYTES + 1) }))!.status).toBe(413);
    const party = new Party(new MemoryStore());
    const people = new Map(
      Array.from({ length: 40 }, (_, i) => [`p${i}`, avatarFromSeed(`p${i}`)]),
    );
    for (const id of people.keys())
      expect(party.mutate({ personId: id, action: "wave" }, people, 1_000_000).status).toBe(200);
    expect(party.state(1_000_000).events).toHaveLength(32);
  });

  test("migrates old party scores/cooldowns and removes obsolete parallel cosmetics", () => {
    const store = new MemoryStore();
    store.kvPut(
      "party.v1",
      JSON.stringify({
        profiles: { anna: { headwear: "cat-ears" } },
        scores: { anna: 3 },
        events: [],
        cooldowns: { anna: 1_000_000 },
      }),
    );
    const party = new Party(store);
    expect(party.state(1_000_000)).toEqual({ events: [], scores: { anna: 3 } });
    expect(store.kvGet("party.v1")).not.toContain("profiles");
    const online = new Map([["anna", avatarFromSeed("anna")]]);
    expect(party.mutate({ personId: "anna", action: "wave" }, online, 1_000_000).status).toBe(429);
  });
});
