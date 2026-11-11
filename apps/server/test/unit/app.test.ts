import { describe, expect, test } from "bun:test";
import { envelope, PersonDayResponse } from "@agent-office/protocol";
import { OfficeApp, SNAPSHOT_MAX_BYTES, SNAPSHOT_MIN_INTERVAL_MS } from "../../src/core/app.ts";
import { MemoryStore } from "../../src/core/store.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function setup(env: Record<string, string> = { CONNECTOR_PASSWORD: "pw" }) {
  let now = 1_000_000;
  const sent: string[] = [];
  const alarms: (number | null)[] = [];
  const app = new OfficeApp(
    env,
    new MemoryStore(),
    { broadcast: (d) => sent.push(d), scheduleAlarm: (a) => alarms.push(a) },
    { now: () => now, log: () => {} },
  );
  return { app, sent, alarms, advance: (ms: number) => (now += ms) };
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
