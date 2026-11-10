import { describe, expect, test } from "bun:test";
import { envelope } from "@agent-office/protocol";
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

  test("unknown /api path -> 404, non-api -> null", async () => {
    const { app } = setup();
    expect((await app.handleHttp(req("/api/nope")))!.status).toBe(404);
    expect(await app.handleHttp(req("/stats"))).toBeNull();
  });
});
