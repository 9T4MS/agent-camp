/**
 * End-to-end smoke test against a running server (wrangler dev or the Bun harness):
 *
 *   SERVER_URL=http://localhost:8787 CONNECTOR_PASSWORD=devpass bun run apps/server/test/smoke.e2e.ts
 *   SMOKE_PHASE=verify  ... (only check that history from an earlier run survived a restart)
 *
 * Connects a viewer and a fake connector over real WebSockets and checks the protocol flow
 * plus every HTTP endpoint. Exits non-zero on the first failure.
 */
import {
  CLOSE_BAD_PASSWORD,
  envelope,
  parseServerToConnector,
  parseViewerMessage,
  type ServerToViewer,
  type SessionInfo,
  StatsResponse,
} from "@agent-office/protocol";

const BASE = (process.env.SERVER_URL ?? "http://localhost:8787").replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const PASSWORD = process.env.CONNECTOR_PASSWORD ?? "devpass";
const VIEWER_KEY = process.env.VIEWER_KEY;
const NAME = "Smoke Tester";
const PERSON = "smoke-tester";
const TIMEOUT = 10_000;

let step = 0;
function ok(cond: unknown, what: string): asserts cond {
  step++;
  if (!cond) {
    console.error(`FAIL ${step}: ${what}`);
    process.exit(1);
  }
  console.log(`ok ${step} - ${what}`);
}

/** A WebSocket with a message queue and awaitable predicates. */
class Client {
  ws: WebSocket;
  queue: unknown[] = [];
  waiters: { pred: (m: unknown) => boolean; resolve: (m: unknown) => void }[] = [];
  closed: Promise<{ code: number; reason: string }>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      const msg = data === "pong" ? "pong" : JSON.parse(data);
      const w = this.waiters.find((x) => x.pred(msg));
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(msg);
      } else this.queue.push(msg);
    };
    this.closed = new Promise((res) => {
      this.ws.onclose = (ev) => res({ code: ev.code, reason: ev.reason });
    });
  }
  open(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error("websocket error"));
    });
  }
  send(m: unknown) {
    this.ws.send(typeof m === "string" ? m : JSON.stringify(m));
  }
  next<T>(pred: (m: unknown) => boolean, what: string): Promise<T> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0] as T);
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), TIMEOUT);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m as T);
        },
      });
    });
  }
}

const isType =
  (type: string, extra: (m: ServerToViewer) => boolean = () => true) =>
  (m: unknown) => {
    const r = parseViewerMessage(m);
    return r.ok && r.msg.type === type && extra(r.msg);
  };

async function http(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, init);
  return res;
}

async function verifyPersisted() {
  const csv = await (await http("/api/history.csv")).text();
  const rows = csv.split("\n").filter((l) => l.includes(`,session.started,${PERSON},`));
  ok(
    rows.length > 0,
    `history survived restart (${rows.length} session.started rows for ${PERSON})`,
  );
}

async function main() {
  if (process.env.SMOKE_PHASE === "verify") return verifyPersisted();

  const health = await http("/healthz");
  ok(health.ok, "/healthz responds 200");

  // ---- viewer ----
  const viewer = new Client(`${WS_BASE}/ws/viewer${VIEWER_KEY ? `?key=${VIEWER_KEY}` : ""}`);
  await viewer.open();
  const snap = await viewer.next<ServerToViewer>(isType("office.snapshot"), "office.snapshot");
  ok(snap.type === "office.snapshot", "viewer gets office.snapshot on connect");
  viewer.send("ping");
  ok((await viewer.next((m) => m === "pong", "pong")) === "pong", "ping -> pong auto-response");

  // ---- bad password ----
  const bad = new Client(`${WS_BASE}/ws/connector`);
  await bad.open();
  bad.send(
    envelope("connector.hello", {
      name: NAME,
      password: "wrong",
      clientId: "smoke-bad",
      connectorVersion: "0.1.0",
    }),
  );
  const rej = await bad.next<{ type: string }>(() => true, "connector.rejected");
  ok(
    parseServerToConnector(rej).ok && rej.type === "connector.rejected",
    "bad password -> connector.rejected",
  );
  ok((await bad.closed).code === CLOSE_BAD_PASSWORD, "bad password -> close 4001");

  // ---- good connector ----
  const runKey = `smoke${Date.now().toString(36)}`.padEnd(12, "0");
  const clientId = "smoke-client";
  const sessionId = `${clientId}:${runKey}`;
  const conn = new Client(`${WS_BASE}/ws/connector`);
  await conn.open();
  conn.send(
    envelope("connector.hello", {
      name: NAME,
      password: PASSWORD,
      clientId,
      connectorVersion: "0.1.0",
      selfDescription: "a robot made of curl commands",
    }),
  );
  const welcome = await conn.next<{ type: string; data: { personId: string } }>(
    () => true,
    "welcomed",
  );
  ok(
    welcome.type === "connector.welcomed" && welcome.data.personId === PERSON,
    "hello -> connector.welcomed",
  );

  const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
    sessionKey: runKey,
    agent: "claude",
    project: "agent-office",
    activity: "typing",
    subagents: 0,
    startedAt: Date.now(),
    ...over,
  });
  conn.send(envelope("presence.snapshot", { sessions: [session()] }));
  const started = await viewer.next<ServerToViewer>(
    isType(
      "session.started",
      (m) => m.type === "session.started" && m.data.session.sessionId === sessionId,
    ),
    "session.started",
  );
  ok(started.type === "session.started", "snapshot -> viewer receives session.started");

  conn.send(
    envelope("presence.snapshot", { sessions: [session({ activity: "waiting", subagents: 2 })] }),
  );
  await viewer.next(isType("session.activityChanged"), "session.activityChanged");
  ok(true, "activity change -> session.activityChanged");
  const sp1 = await viewer.next<ServerToViewer>(isType("subagent.spawned"), "subagent.spawned #1");
  const sp2 = await viewer.next<ServerToViewer>(isType("subagent.spawned"), "subagent.spawned #2");
  ok(
    sp1.type === "subagent.spawned" &&
      sp2.type === "subagent.spawned" &&
      sp1.data.count === 1 &&
      sp2.data.count === 2,
    "two subagents -> two subagent.spawned with running count",
  );

  const state = await (await http("/api/state")).json();
  const me = parseViewerMessage(state);
  ok(
    me.ok &&
      me.msg.type === "office.snapshot" &&
      me.msg.data.people.some((p) => p.sessions.some((s) => s.sessionId === sessionId)),
    "/api/state shows the live session",
  );

  conn.send(envelope("connector.bye", {}));
  await viewer.next(
    isType("session.ended", (m) => m.type === "session.ended" && m.data.sessionId === sessionId),
    "session.ended",
  );
  ok(true, "bye -> session.ended");
  conn.ws.close(1000);

  // ---- HTTP API ----
  const stats = StatsResponse.safeParse(await (await http("/api/stats")).json());
  ok(stats.success && stats.data.totalSessions >= 1, "/api/stats returns valid stats");
  const csvRes = await http("/api/history.csv");
  const csv = await csvRes.text();
  ok(
    csvRes.ok && csv.startsWith("ts,iso,type,person") && csv.includes(`session.started,${PERSON}`),
    "/api/history.csv has our rows",
  );

  const auth = { authorization: `Bearer ${PASSWORD}` };
  const unauth = await http("/api/history/backfill", { method: "POST", body: "[]" });
  ok(unauth.status === 401, "backfill without password -> 401");
  const bf = await http("/api/history/backfill", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify([
      {
        ts: Date.now() - 86_400_000,
        type: "session.started",
        person: "backfill-bot",
        agent: "codex",
        project: "sim",
      },
      {
        ts: Date.now() - 86_000_000,
        type: "session.ended",
        person: "backfill-bot",
        agent: "codex",
        project: "sim",
      },
    ]),
  });
  ok(
    bf.ok && ((await bf.json()) as { inserted: number }).inserted === 2,
    "backfill with password inserts rows",
  );

  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
  );
  const up = await http("/api/snapshots", {
    method: "POST",
    headers: { ...auth, "content-type": "image/png" },
    body: png,
  });
  ok(up.status === 201, "POST /api/snapshots stores a PNG");
  const { url } = (await up.json()) as { url: string };
  const list = (await (await http("/api/snapshots")).json()) as { snapshots: { url: string }[] };
  ok(
    list.snapshots.some((s) => s.url === url),
    "GET /api/snapshots lists it",
  );
  const img = await http(url);
  ok(
    img.headers.get("content-type") === "image/png" &&
      (await img.arrayBuffer()).byteLength === png.byteLength,
    "GET snapshot PNG",
  );
  const notPng = await http("/api/snapshots", { method: "POST", headers: auth, body: "hello" });
  ok(notPng.status === 415, "non-PNG snapshot -> 415");

  const install = await http("/install.sh");
  ok(install.ok && (await install.text()).startsWith("#!"), "/install.sh serves a shell script");

  viewer.ws.close(1000);
  console.log(`\nall ${step} checks passed against ${BASE}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`FAIL: ${(err as Error).message}`);
  process.exit(1);
});
