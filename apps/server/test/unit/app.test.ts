import { describe, expect, test } from "bun:test";
import {
  type AvatarSpec,
  envelope,
  PersonDayResponse,
  parseViewerMessage,
  resolveLook,
} from "@agent-office/protocol";
import { LOOK_FIXTURES } from "@agent-office/protocol/fixtures";
import { OfficeApp, SNAPSHOT_MAX_BYTES, SNAPSHOT_MIN_INTERVAL_MS } from "../../src/core/app.ts";
import { MemoryStore } from "../../src/core/store.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function setup(
  env: Record<string, string> = { CONNECTOR_PASSWORD: "pw" },
  fetch?: typeof globalThis.fetch,
) {
  let now = 1_000_000;
  const sent: string[] = [];
  const alarms: (number | null)[] = [];
  /** background work (avatar jobs) */
  const pending: Promise<unknown>[] = [];
  /** messages the app sent to single connector sockets (pokes, claim codes) */
  const toConnector: { socketId: string; data: string }[] = [];
  const app = new OfficeApp(
    env,
    new MemoryStore(),
    {
      broadcast: (d) => sent.push(d),
      scheduleAlarm: (a) => alarms.push(a),
      sendToConnector: (socketId, data) => {
        toConnector.push({ socketId, data });
        return true;
      },
      waitUntil: (p) => pending.push(p),
    },
    { now: () => now, log: () => {}, ...(fetch ? { fetch } : {}) },
  );
  return { app, sent, alarms, toConnector, pending, advance: (ms: number) => (now += ms) };
}
const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);

describe("OfficeApp", () => {
  test("connector flow broadcasts events and arms the alarm", async () => {
    const { app, sent, alarms } = setup();
    const a = app.connectorMessage(
      "s1",
      JSON.stringify(
        envelope("connector.hello", {
          name: "Anna",
          password: "pw",
          clientId: "c",
          connectorVersion: "1.0.0",
        }),
      ),
    );
    expect(a.reply?.type).toBe("connector.welcomed");
    expect(a.binding?.personId).toBe("anna");
    await Bun.sleep(1); // avatar job (provider off) settles: seeded look == current, no update
    expect(sent.map((s) => JSON.parse(s).type)).toEqual(["person.joined"]);
    expect(alarms.at(-1)).toBeGreaterThan(1_000_000);
  });

  test("DEV_MODE defaults the password to devpass", () => {
    const { app } = setup({ DEV_MODE: "1" });
    const a = app.connectorMessage(
      "s1",
      JSON.stringify(
        envelope("connector.hello", {
          name: "A",
          password: "devpass",
          clientId: "c",
          connectorVersion: "1",
        }),
      ),
    );
    expect(a.reply?.type).toBe("connector.welcomed");
  });

  test("snapshots: PNG only, size limit, rate limit (bearer bypasses)", async () => {
    const { app, advance } = setup();
    const post = (body: string | Uint8Array, headers: Record<string, string> = {}) =>
      app.handleHttp(req("/api/snapshots", { method: "POST", body, headers }));
    expect((await post("nope"))!.status).toBe(415);
    expect((await post(new Uint8Array(SNAPSHOT_MAX_BYTES + 1)))!.status).toBe(413);
    expect((await post(PNG))!.status).toBe(201);
    const limited = (await post(PNG))!;
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(PNG, { authorization: "Bearer pw" }))!.status).toBe(201);
    advance(SNAPSHOT_MIN_INTERVAL_MS);
    expect((await post(PNG))!.status).toBe(201);
    const list = (await (await app.handleHttp(req("/api/snapshots")))!.json()) as {
      snapshots: unknown[];
    };
    expect(list.snapshots).toHaveLength(3);
    const img = (await app.handleHttp(req("/api/snapshots/1.png")))!;
    expect(img.headers.get("content-type")).toBe("image/png");
    expect((await app.handleHttp(req("/api/snapshots/99.png")))!.status).toBe(404);
  });

  test("snapshots: bearer uploads may backdate with ?ts=, others may not", async () => {
    const { app } = setup();
    const post = (q: string, headers: Record<string, string> = {}) =>
      app.handleHttp(req(`/api/snapshots${q}`, { method: "POST", body: PNG, headers }));
    const back = (await (await post("?ts=500000", { authorization: "Bearer pw" }))!.json()) as {
      ts: number;
    };
    expect(back.ts).toBe(500_000);
    const future = (await (await post("?ts=9000000", { authorization: "Bearer pw" }))!.json()) as {
      ts: number;
    };
    expect(future.ts).toBe(1_000_000);
    const anon = (await (await post("?ts=500000"))!.json()) as { ts: number };
    expect(anon.ts).toBe(1_000_000);
  });

  test("backfill requires bearer and validates rows; stats + csv reflect it", async () => {
    const { app } = setup();
    const rows = [{ ts: 5, type: "session.started", person: "bot", agent: "codex", project: "p" }];
    const post = (body: unknown, auth?: string) =>
      app.handleHttp(
        req("/api/history/backfill", {
          method: "POST",
          body: JSON.stringify(body),
          headers: auth ? { authorization: auth } : {},
        }),
      );
    expect((await post(rows))!.status).toBe(401);
    expect((await post(rows, "Bearer nope"))!.status).toBe(401);
    expect((await post([{ ts: "x" }], "Bearer pw"))!.status).toBe(400);
    expect(await (await post({ rows }, "Bearer pw"))!.json()).toEqual({ inserted: 1 });
    const stats = (await (await app.handleHttp(req("/api/stats")))!.json()) as {
      totalSessions: number;
    };
    expect(stats.totalSessions).toBe(1);
    const csv = await (await app.handleHttp(req("/api/history.csv")))!.text();
    expect(csv).toContain("session.started,bot,codex,p");
  });

  test("same name on two machines: one person, one avatar job, machine on sessions", async () => {
    const { app, sent } = setup();
    let jobs = 0;
    const resolve = app.genui.resolve.bind(app.genui);
    app.genui.resolve = (job) => {
      jobs++;
      return resolve(job);
    };
    const hello = (name: string, clientId: string, extra: Record<string, string> = {}) =>
      JSON.stringify(
        envelope("connector.hello", {
          name,
          password: "pw",
          clientId,
          connectorVersion: "1.0.0",
          ...extra,
        }),
      );
    const snap = (key: string) =>
      JSON.stringify(
        envelope("presence.snapshot", {
          sessions: [
            { sessionKey: key, agent: "claude", activity: "typing", subagents: 0, startedAt: 1 },
          ],
        }),
      );
    app.connectorMessage(
      "s1",
      hello("Martin", "laptop", { selfDescription: "beard", machine: "laptop" }),
    );
    app.connectorMessage("s2", hello(" martin", "devbox", { machine: "devbox" }));
    app.connectorMessage("s1", snap("aaaaaaaaaaaaaaaa"));
    app.connectorMessage("s2", snap("bbbbbbbbbbbbbbbb"));
    await Bun.sleep(1);
    // both machines reconnect (e.g. after a network blip)
    app.connectorMessage("s3", hello("martin", "devbox", { machine: "devbox" }));
    app.connectorMessage(
      "s4",
      hello("Martin", "laptop", { selfDescription: "beard", machine: "laptop" }),
    );
    await Bun.sleep(1);
    expect(jobs).toBe(1);
    const state = JSON.parse(app.viewerSnapshot()).data;
    expect(state.people).toHaveLength(1);
    expect(state.people[0].name).toBe("Martin");
    expect(state.people[0].sessions.map((x: { machine: string }) => x.machine).sort()).toEqual([
      "devbox",
      "laptop",
    ]);
    expect(sent.filter((m) => JSON.parse(m).type === "person.joined")).toHaveLength(1);

    const res = (await app.handleHttp(req("/api/people/martin")))!;
    expect(res.status).toBe(200);
    const day = PersonDayResponse.parse(await res.json());
    expect(day).toMatchObject({
      personId: "martin",
      name: "Martin",
      online: true,
      sessionsToday: 2,
      peakParallelToday: 2,
      subagentsToday: 0,
    });
    expect((await app.handleHttp(req("/api/people/nobody")))!.status).toBe(404);
  });

  test("unknown /api path -> 404, non-api -> null", async () => {
    const { app } = setup();
    expect((await app.handleHttp(req("/api/nope")))!.status).toBe(404);
    expect(await app.handleHttp(req("/stats"))).toBeNull();
  });
});

describe("OfficeApp detailed looks", () => {
  test("anthropic look for a long description reaches viewers as avatar.updated", async () => {
    const desc = "Tracht: Janker, lederhosen, panto glasses. ".repeat(40);
    const bodies: Record<string, unknown>[] = [];
    const sent: string[] = [];
    const pending: Promise<unknown>[] = [];
    const app = new OfficeApp(
      {
        CONNECTOR_PASSWORD: "pw",
        GENUI_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "k",
        LATEST_CONNECTOR_VERSION: "1.0.0",
      },
      new MemoryStore(),
      {
        broadcast: (d) => sent.push(d),
        scheduleAlarm: () => {},
        waitUntil: (p) => pending.push(p),
      },
      {
        log: () => {},
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init.body)));
          return Response.json({
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify(LOOK_FIXTURES.tracht) }],
          });
        },
      },
    );
    app.connectorMessage(
      "s1",
      JSON.stringify(
        envelope("connector.hello", {
          name: "Thomas",
          password: "pw",
          clientId: "c",
          connectorVersion: "1.0.0",
          selfDescription: desc.slice(0, 200),
          lookDescription: desc,
        }),
      ),
    );
    await Promise.all(pending);
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies[0]!.messages)).toContain(desc.trim());
    const updated = sent
      .map((d) => parseViewerMessage(d))
      .find((m) => m.ok && m.msg.type === "avatar.updated");
    expect(updated?.ok && updated.msg.type === "avatar.updated" && updated.msg.data.avatar).toEqual(
      LOOK_FIXTURES.tracht,
    );
    expect(app.store.getAvatar("thomas")?.avatar).toEqual(LOOK_FIXTURES.tracht);
  });
});

describe("OfficeApp interactions", () => {
  function withPerson() {
    let now = 1_000_000;
    const sent: string[] = [];
    const toConnector: [string, string][] = [];
    const app = new OfficeApp(
      { CONNECTOR_PASSWORD: "pw" },
      new MemoryStore(),
      {
        broadcast: (d) => sent.push(d),
        scheduleAlarm: () => {},
        sendToConnector: (id, d) => {
          toConnector.push([id, d]);
          return true;
        },
      },
      { now: () => now, log: () => {} },
    );
    app.connectorMessage(
      "s1",
      JSON.stringify(
        envelope("connector.hello", {
          name: "Anna",
          password: "pw",
          clientId: "c",
          connectorVersion: "1.0.0",
        }),
      ),
    );
    sent.length = 0;
    const post = (body: unknown, ip = "1.1.1.1") =>
      app.handleHttp(
        req("/api/interact", {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "cf-connecting-ip": ip },
        }),
      );
    return { app, sent, toConnector, post, advance: (ms: number) => (now += ms) };
  }

  test("a wave notifies the person's connector and is broadcast to viewers", async () => {
    const { sent, toConnector, post } = withPerson();
    const res = await post({ kind: "wave", personId: "anna", from: "Martin" });
    expect(await res!.json()).toEqual({ ok: true, delivered: 1 });
    expect(toConnector).toHaveLength(1);
    const poke = JSON.parse(toConnector[0]![1]);
    expect(poke.type).toBe("connector.poked");
    expect(poke.data).toEqual({ kind: "wave", from: "Martin", text: "Martin waved at you 👋" });
    const ev = JSON.parse(sent.at(-1)!);
    expect(ev.type).toBe("interaction.happened");
    expect(ev.data).toEqual({ kind: "wave", personId: "anna", from: "Martin", delivered: 1 });
  });

  test("paper balls and the cat never reach a Mac", async () => {
    const { sent, toConnector, post, advance } = withPerson();
    expect((await post({ kind: "paper", personId: "anna" }))!.status).toBe(200);
    advance(5_000);
    expect((await post({ kind: "pet" }))!.status).toBe(200);
    expect(toConnector).toHaveLength(0);
    expect(sent.map((s) => JSON.parse(s).data.kind)).toEqual(["paper", "pet"]);
  });

  test("rate limits per viewer and per poked person", async () => {
    const { post, advance, toConnector } = withPerson();
    expect((await post({ kind: "cheer", personId: "anna" }))!.status).toBe(200);
    expect((await post({ kind: "pet" }))!.status).toBe(429);
    expect((await post({ kind: "wave", personId: "anna" }, "2.2.2.2"))!.status).toBe(429);
    advance(10_000);
    expect((await post({ kind: "wave", personId: "anna" }, "2.2.2.2"))!.status).toBe(200);
    expect(toConnector).toHaveLength(2);
  });

  test("bad requests", async () => {
    const { post, advance } = withPerson();
    expect((await post({ kind: "wave" }))!.status).toBe(400);
    expect((await post({ kind: "message", personId: "anna" }))!.status).toBe(400);
    expect((await post({ kind: "wave", personId: "anna", text: "x".repeat(81) }))!.status).toBe(
      400,
    );
    advance(5_000);
    expect((await post({ kind: "wave", personId: "bob" }))!.status).toBe(404);
  });
});

describe("OfficeApp look editor", () => {
  const hello = (name: string, selfDescription?: string) =>
    JSON.stringify(
      envelope("connector.hello", {
        name,
        password: "pw",
        clientId: `c-${name}`,
        connectorVersion: "1.0.0",
        ...(selfDescription ? { selfDescription } : {}),
      }),
    );
  const tomLook = {
    hairStyle: "short",
    hairColor: "dark-brown",
    skinTone: "light",
    glasses: "round",
    facialHair: "beard",
    accessory: "cap-mint",
    outfit: "flannel",
    leftHand: "beer",
    rightHand: "joint",
    deskProps: ["plant"],
    deskMess: 1,
  };
  /** the `ao_me` cookie of the current test's browser */
  let me = "";
  const put = (app: OfficeApp, personId: string, body: unknown, ip = "1.1.1.1", cookie = me) =>
    app.handleHttp(
      req(`/api/people/${personId}/avatar`, {
        method: "PUT",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip, cookie },
        body: JSON.stringify(body),
      }),
    );
  const post = (app: OfficeApp, path: string, body: unknown = {}, ip = "9.9.9.9") =>
    app.handleHttp(
      req(path, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify(body),
      }),
    );
  /** "This is me": ask for a code, read it off the Mac notification, confirm it. */
  async function claim(
    { app, toConnector }: ReturnType<typeof setup>,
    personId: string,
  ): Promise<string> {
    expect((await post(app, `/api/people/${personId}/claim`))!.status).toBe(200);
    const poke = JSON.parse(toConnector.at(-1)!.data);
    expect(poke.type).toBe("connector.poked");
    const code = /\b(\d{6})\b/.exec(poke.data.text)![1];
    const r = (await post(app, `/api/people/${personId}/claim/verify`, { code }))!;
    expect(r.status).toBe(200);
    return r.headers.get("set-cookie")!.split(";")[0]!;
  }

  test("pins a custom look, broadcasts it and survives a new description", async () => {
    const t = setup();
    const { app, sent, advance } = t;
    app.connectorMessage("s1", hello("Tom"));
    await Bun.sleep(1);
    me = await claim(t, "tom");
    const r = (await put(app, "tom", { avatar: tomLook, from: "Tom" }))!;
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, custom: true, avatar: tomLook });
    const ev = JSON.parse(sent.at(-1)!);
    expect(ev.type).toBe("avatar.updated");
    expect(ev.data.avatar).toMatchObject(tomLook);

    const get = (await (await app.handleHttp(req("/api/people/tom/avatar")))!.json()) as {
      custom: boolean;
    };
    expect(get.custom).toBe(true);

    // a hello with a new description does not replace the custom look
    const before = sent.length;
    app.connectorMessage("s2", hello("Tom", "blue mohawk"));
    await Bun.sleep(1);
    expect(sent.slice(before).some((s) => JSON.parse(s).type === "avatar.updated")).toBe(false);
    expect(app.hub.state().people[0]!.avatar).toMatchObject(tomLook);

    // back to automatic: the seeded look again, no longer custom
    advance(2_000);
    const back = (await put(app, "tom", { avatar: null }))!;
    expect(back.status).toBe(200);
    const body = (await back.json()) as { custom: boolean; avatar: { outfit: string } };
    expect(body.custom).toBe(false);
    expect(body.avatar.outfit).toBe("jacket");
    expect(app.hub.isCustomLook("tom")).toBe(false);
  });

  test("a custom look wins over GenUI: its look comes from the picked ids", async () => {
    // GenUI on (mocked Anthropic answering with the detailed tracht look)
    const bodies: unknown[] = [];
    const t = setup(
      {
        CONNECTOR_PASSWORD: "pw",
        GENUI_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "k",
        LATEST_CONNECTOR_VERSION: "1.0.0",
      },
      (async (_url: unknown, init: RequestInit) => {
        bodies.push(init.body);
        return Response.json({
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(LOOK_FIXTURES.tracht) }],
        });
      }) as unknown as typeof globalThis.fetch,
    );
    const { app, sent, pending, advance } = t;
    app.connectorMessage("s1", hello("Tom", "Tracht: Janker and lederhosen"));
    await Promise.all(pending);
    expect(bodies).toHaveLength(1);
    expect(app.hub.state().people[0]!.avatar.look).toEqual(LOOK_FIXTURES.tracht.look);

    // the editor sends the avatar it was opened with (detailed look included) + a flannel and a
    // beer: the look is dropped, the picked ids are what everybody sees
    me = await claim(t, "tom");
    const edited = {
      ...LOOK_FIXTURES.tracht,
      outfit: "flannel",
      leftHand: "beer",
      rightHand: "none",
      accessory: "cap-mint",
    };
    const r = (await put(app, "tom", { avatar: edited }))!;
    expect(r.status).toBe(200);
    const body = (await r.json()) as { avatar: AvatarSpec };
    expect(body.avatar.look).toBeUndefined();
    const ev = parseViewerMessage(sent.at(-1)!);
    if (!ev.ok || ev.msg.type !== "avatar.updated") throw new Error("no avatar.updated");
    expect(ev.msg.data.avatar.look).toBeUndefined();
    const look = resolveLook(ev.msg.data.avatar as AvatarSpec);
    expect(look.outer.pattern.kind).toBe("plaid");
    expect(look.extras?.leftHand).toBe("beer");
    expect(look.headwear).toMatchObject({ style: "cap", logo: "#ffffff" });

    // a new description: no AI call, nothing replaces the custom look
    const before = sent.length;
    const again = app.connectorMessage("s2", hello("Tom", "Now a red hoodie and a beanie"));
    expect(again.reply?.type).toBe("connector.welcomed");
    await Promise.all(pending);
    expect(bodies).toHaveLength(1);
    expect(sent.slice(before).some((s) => JSON.parse(s).type === "avatar.updated")).toBe(false);
    expect(app.hub.state().people[0]!.avatar).toEqual(body.avatar);

    // Automatic: GenUI runs for the new description and its detailed look shows again
    advance(2_000);
    const back = (await put(app, "tom", { avatar: null }))!;
    expect(((await back.json()) as { custom: boolean }).custom).toBe(false);
    expect(bodies).toHaveLength(2);
    expect(app.hub.state().people[0]!.avatar.look).toEqual(LOOK_FIXTURES.tracht.look);
  });

  test("validates, rate limits and needs the person in the office", async () => {
    const t = setup();
    const { app, advance } = t;
    app.connectorMessage("s1", hello("Tom"));
    me = await claim(t, "tom");
    expect((await put(app, "tom", { avatar: { ...tomLook, outfit: "tux" } }))!.status).toBe(400);
    // someone else (even one not in the office) is never yours to edit
    expect((await put(app, "nobody", { avatar: tomLook }, "2.2.2.2"))!.status).toBe(403);
    expect((await put(app, "tom", { avatar: tomLook }, "3.3.3.3"))!.status).toBe(200);
    expect((await put(app, "tom", { avatar: tomLook }, "3.3.3.3"))!.status).toBe(429);
    advance(2_000);
    expect((await put(app, "tom", { avatar: tomLook }, "3.3.3.3"))!.status).toBe(200);
  });

  test("only your own look: no cookie or someone else's cookie -> 403", async () => {
    const t = setup();
    const { app, advance } = t;
    app.connectorMessage("s1", hello("Tom"));
    app.connectorMessage("s2", hello("Anna"));
    expect((await put(app, "tom", { avatar: tomLook }, "1.1.1.1", ""))!.status).toBe(403);
    const anna = await claim(t, "anna");
    advance(2_000);
    expect((await put(app, "tom", { avatar: tomLook }, "1.1.1.2", anna))!.status).toBe(403);
    expect((await put(app, "tom", { avatar: null }, "1.1.1.3", anna))!.status).toBe(403);
    expect((await put(app, "anna", { avatar: tomLook }, "1.1.1.4", anna))!.status).toBe(200);
    // a forged cookie for tom is rejected
    const forged = anna.replace("ao_me=anna.", "ao_me=tom.");
    expect((await put(app, "tom", { avatar: tomLook }, "1.1.1.5", forged))!.status).toBe(403);
    const who = (await (await app.handleHttp(
      req("/api/me", { headers: { cookie: anna } }),
    ))!.json()) as { personId: string | null };
    expect(who.personId).toBe("anna");
  });

  test("claim codes: sent only to that person's Macs, single use, limited tries", async () => {
    const t = setup();
    const { app, toConnector, advance } = t;
    app.connectorMessage("s1", hello("Tom"));
    app.connectorMessage("s2", hello("Anna"));
    expect((await post(app, "/api/people/tom/claim"))!.status).toBe(200);
    expect(toConnector.map((m) => m.socketId)).toEqual(["s1"]);
    const code = /\b(\d{6})\b/.exec(JSON.parse(toConnector[0]!.data).data.text)![1]!;
    // resend is throttled
    advance(5_000);
    expect((await post(app, "/api/people/tom/claim", {}, "8.8.8.8"))!.status).toBe(429);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++)
      expect((await post(app, "/api/people/tom/claim/verify", { code: wrong }))!.status).toBe(403);
    // too many wrong tries burn the code, even the right one no longer works
    expect((await post(app, "/api/people/tom/claim/verify", { code }))!.status).toBe(410);
    advance(30_000);
    const cookie = await claim(t, "tom");
    expect(cookie.startsWith("ao_me=tom.")).toBe(true);
    const codeNow = /\b(\d{6})\b/.exec(JSON.parse(toConnector.at(-1)!.data).data.text)![1];
    expect((await post(app, "/api/people/tom/claim/verify", { code: codeNow }))!.status).toBe(410);
    expect((await post(app, "/api/people/nobody/claim", {}, "7.7.7.7"))!.status).toBe(404);
  });

  test("at most 10 codes per person per day, so guessing and Mac spam stay bounded", async () => {
    const t = setup();
    t.app.connectorMessage("s1", hello("Tom"));
    for (let i = 0; i < 10; i++) {
      expect((await post(t.app, "/api/people/tom/claim", {}, `10.0.0.${i}`))!.status).toBe(200);
      t.advance(30_000);
      t.app.connectorMessage("s1", hello("Tom")); // keep the connector fresh
    }
    const r = (await post(t.app, "/api/people/tom/claim", {}, "10.0.1.1"))!;
    expect(r.status).toBe(429);
    expect(t.toConnector).toHaveLength(10);
    t.advance(86_400_000);
    t.app.connectorMessage("s1", hello("Tom"));
    expect((await post(t.app, "/api/people/tom/claim", {}, "10.0.1.2"))!.status).toBe(200);
  });

  test("an expired code is rejected", async () => {
    const t = setup();
    t.app.connectorMessage("s1", hello("Tom"));
    expect((await post(t.app, "/api/people/tom/claim"))!.status).toBe(200);
    const code = /\b(\d{6})\b/.exec(JSON.parse(t.toConnector[0]!.data).data.text)![1];
    t.advance(5 * 60_000 + 1);
    expect((await post(t.app, "/api/people/tom/claim/verify", { code }))!.status).toBe(410);
  });
});
