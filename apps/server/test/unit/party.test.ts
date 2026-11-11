import { describe, expect, test } from "bun:test";
import { DEFAULT_PARTY_LOOK, envelope, type PartyLook, PartyState } from "@agent-office/protocol";
import { OfficeApp } from "../../src/core/app.ts";
import { makeSessionToken, SESSION_COOKIE } from "../../src/core/auth.ts";
import {
  PARTY_BODY_MAX_BYTES,
  PARTY_COOLDOWN_MS,
  PARTY_EVENT_TTL_MS,
} from "../../src/core/party.ts";
import { MemoryStore } from "../../src/core/store.ts";

function setup(store = new MemoryStore(), env: Record<string, string> = {}) {
  let now = 1_000_000;
  const app = new OfficeApp(
    { CONNECTOR_PASSWORD: "pw", ...env },
    store,
    { broadcast: () => {}, scheduleAlarm: () => {} },
    { now: () => now, log: () => {} },
  );
  const join = (name: string) =>
    app.connectorMessage(
      name,
      envelope("connector.hello", {
        name,
        password: "pw",
        clientId: name,
        connectorVersion: "1.0.0",
      }),
    );
  join("Anna");
  join("Bob");
  const get = (query = "", headers: Record<string, string> = { authorization: "Bearer pw" }) =>
    app.handleHttp(new Request(`http://office/api/party${query}`, { headers }));
  const post = (body: unknown, auth: string | null = "Bearer pw") =>
    app.handleHttp(
      new Request("http://office/api/party", {
        method: "POST",
        body: JSON.stringify(body),
        headers: auth ? { authorization: auth } : {},
      }),
    );
  const state = async (response: Response | null) => PartyState.parse(await response!.json());
  return {
    app,
    get,
    post,
    state,
    store,
    advance: (ms = PARTY_COOLDOWN_MS) => {
      now += ms;
    },
  };
}

const look: PartyLook = {
  ...DEFAULT_PARTY_LOOK,
  headwear: "cat-ears",
  wrist: "neon-pink",
  item: "confetti",
  vehicle: "car",
};

describe("party API", () => {
  test("all writes require shared office credentials before body validation", async () => {
    const { post } = setup();
    expect((await post({ malformed: true }, null))!.status).toBe(401);
    expect((await post({ personId: "anna", look }, "Bearer wrong"))!.status).toBe(401);
  });

  test("GET respects viewer gate and cannot mutate", async () => {
    const { get, state, post } = setup(undefined, { VIEWER_KEY: "view" });
    expect((await get("", {}))!.status).toBe(401);
    expect((await get("?key=wrong", {}))!.status).toBe(401);
    expect(await state(await get("?key=view&personId=anna&action=dance", {}))).toEqual({
      profiles: {},
      events: [],
      scores: {},
    });
    expect((await post({ personId: "anna", look }))!.status).toBe(200);
  });

  test("GET accepts viewer sessions while mutations still require bearer credentials", async () => {
    const { app, get } = setup();
    const cookie = `${SESSION_COOKIE}=${await makeSessionToken("pw", 1_000_000)}`;
    expect((await get("", { cookie }))!.status).toBe(200);
    expect((await get("", { cookie: `${SESSION_COOKIE}=bad` }))!.status).toBe(401);
    expect(
      (await app.handleHttp(
        new Request("http://office/api/party", {
          method: "POST",
          headers: { cookie },
          body: JSON.stringify({ personId: "anna", look }),
        }),
      ))!.status,
    ).toBe(401);
  });

  test("disconnected and stale actors or targets cannot play during presence grace", async () => {
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

  test("cooldowns survive recreation and expire on the server clock", async () => {
    const first = setup();
    expect(
      (await first.post({ personId: "anna", action: "high-five", targetId: "bob" }))!.status,
    ).toBe(200);
    const restarted = setup(first.store);
    expect(
      (await restarted.post({ personId: "anna", action: "high-five", targetId: "bob" }))!.status,
    ).toBe(429);
    restarted.advance(PARTY_COOLDOWN_MS - 1);
    expect((await restarted.post({ personId: "anna", action: "dance" }))!.status).toBe(429);
    restarted.advance(1);
    expect(
      (await restarted.post({ personId: "anna", action: "high-five", targetId: "bob" }))!.status,
    ).toBe(200);
    expect((await restarted.state(await restarted.get())).scores).toEqual({ anna: 2, bob: 2 });
  });

  test("validates full wardrobe, payload shape and online actor/target", async () => {
    const { post } = setup();
    for (const body of [
      { personId: "anna", look: { ...look, headwear: "not-a-hat" } },
      { personId: "anna", look: { ...look, forged: "secret" } },
      { personId: "anna", action: "dance", scores: { anna: 999 } },
      { personId: "anna", action: "race", roll: 6 },
      { personId: "anna", action: "use", item: "confetti" },
      { personId: "anna" },
      { personId: "anna", action: "teleport" },
      { personId: "anna", action: "tag" },
      { personId: "anna", action: "high-five", targetId: "anna" },
    ])
      expect((await post(body))!.status).toBe(400);
    expect((await post({ personId: "offline", look }))!.status).toBe(404);
    expect((await post({ personId: "anna", action: "tag", targetId: "offline" }))!.status).toBe(
      404,
    );
    expect((await post({ personId: "anna", action: "use" }))!.status).toBe(400);
    expect((await post({ personId: "anna", action: "race" }))!.status).toBe(400);
  });

  test("persists combinations independently of generated avatars, restart and reconnect", async () => {
    const first = setup();
    const originalAvatar = first.app.hub.state().people.find((p) => p.personId === "anna")!.avatar;
    expect((await first.post({ personId: "anna", look }))!.status).toBe(200);
    expect(first.app.hub.state().people.find((p) => p.personId === "anna")!.avatar).toEqual(
      originalAvatar,
    );
    const restarted = setup(first.store);
    expect((await restarted.state(await restarted.get())).profiles.anna).toEqual(look);
    expect(first.store.kvGet("party.v1")).not.toContain("pw");
  });

  test("infers equipped item, checks actor cooldown, and applies server-generated race scores", async () => {
    const { post, state, advance, get } = setup();
    const use = await state(await post({ personId: "anna", look, action: "use" }));
    expect(use.events[0]).toMatchObject({ personId: "anna", item: "confetti", action: "use" });
    expect((await post({ personId: "anna", action: "race" }))!.status).toBe(429);
    expect((await post({ personId: "bob", action: "wave" }))!.status).toBe(200);
    advance();
    const race = await state(await post({ personId: "anna", action: "race" }));
    const event = race.events.at(-1)!;
    expect(event.roll).toBeGreaterThanOrEqual(1);
    expect(event.roll).toBeLessThanOrEqual(6);
    expect(race.scores.anna).toBe(event.roll!);
    advance();
    const five = await state(
      await post({ personId: "anna", action: "high-five", targetId: "bob" }),
    );
    expect(five.scores.anna).toBe(event.roll! + 1);
    expect(five.scores.bob).toBe(1);
    advance();
    await post({ personId: "anna", action: "tag", targetId: "bob" });
    expect((await state(await get())).scores.anna).toBe(event.roll! + 2);
  });

  test("persists scores, expires transient actions and does not replay actions after restart", async () => {
    const first = setup();
    await first.post({ personId: "anna", action: "high-five", targetId: "bob" });
    const second = setup(first.store);
    expect(await second.state(await second.get())).toMatchObject({
      scores: { anna: 1, bob: 1 },
      events: [],
    });
    first.advance(PARTY_EVENT_TTL_MS);
    expect((await first.state(await first.get())).events).toHaveLength(0);
  });

  test("bounds event history at 32 without viewers polling", async () => {
    const { app, post, state, get } = setup();
    for (let i = 0; i < 40; i++) {
      const name = `Guest${i}`;
      app.connectorMessage(
        name,
        envelope("connector.hello", {
          name,
          password: "pw",
          clientId: name,
          connectorVersion: "1.0.0",
        }),
      );
      await post({ personId: name.toLowerCase(), action: "dance" });
    }
    expect((await state(await get())).events).toHaveLength(32);
  });

  test("rejects over-limit actual bytes without Content-Length and malformed JSON", async () => {
    const { app } = setup();
    const send = (body: string) =>
      app.handleHttp(
        new Request("http://office/api/party", {
          method: "POST",
          body,
          headers: { authorization: "Bearer pw" },
        }),
      );
    expect((await send(" ".repeat(PARTY_BODY_MAX_BYTES + 1)))!.status).toBe(413);
    expect((await send("{"))!.status).toBe(400);
  });
});
