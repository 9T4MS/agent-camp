/**
 * Cross-component end-to-end test: real server + REAL connector process + viewer WebSocket.
 *
 *   bun run test:e2e                                    # starts the Bun harness on a free port
 *   E2E_SERVER_URL=http://localhost:8787 E2E_PASSWORD=devpass bun run test:e2e   # vs `wrangler dev`
 *
 * Gated behind AGENT_OFFICE_E2E=1 (set by the root `test:e2e` script) so a plain `bun test`
 * at the repo root skips it instead of running it twice in CI.
 *
 * Flow: copy fixtures/home to a temp dir (mtimes -> now), open a viewer, spawn
 * `apps/connector/src/main.ts run --home <tmp> --assume-processes`, expect person.joined +
 * session.started for claude x2 / codex / pi with the fixture activities and subagent counts,
 * compare /api/state, then SIGTERM the connector and expect the bye path (all sessions ended).
 * The privacy canary must never appear in any viewer message or /api/state.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const RUN = process.env.AGENT_OFFICE_E2E === "1";
const ROOT = join(import.meta.dir, "..", "..");
const BUN = process.execPath;
const SECRET = "SECRET_DO_NOT_LEAK_8f3a";
const EXTERNAL = process.env.E2E_SERVER_URL?.replace(/\/$/, "");
const PASSWORD = EXTERNAL ? (process.env.E2E_PASSWORD ?? "devpass") : "e2epass";
const AUTH = { authorization: `Bearer ${PASSWORD}` };
// A shared, persistent server may still hold an earlier "E2E Anna" in her grace period, which
// would suppress person.joined; make the name unique there.
const NAME = EXTERNAL ? `E2E Anna ${Math.random().toString(36).slice(2, 6)}` : "E2E Anna";
const PERSON_ID = NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const WAIT_MS = 10_000;

/** What fixtures/home must produce (see fixtures/home/README.md). */
const EXPECTED = [
  { agent: "claude", project: "agent-office", activity: "typing", subagents: 2 },
  { agent: "claude", project: "website", activity: "waiting", subagents: 0 },
  { agent: "codex", project: "codex-thing", activity: "running", subagents: 0 },
  { agent: "pi", project: "pi-proj", activity: "typing", subagents: 0 },
];

type Msg = { type: string; data: Record<string, unknown> };
type Session = {
  sessionId: string;
  agent: string;
  project?: string;
  activity: string;
  subagents: number;
  machine?: string;
};

class Viewer {
  ws: WebSocket;
  raw: string[] = [];
  msgs: Msg[] = [];
  private waiters: (() => void)[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url, { headers: AUTH } as unknown as string[]);
    this.ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      this.raw.push(data);
      if (data !== "pong") this.msgs.push(JSON.parse(data) as Msg);
      for (const w of this.waiters.splice(0)) w();
    };
  }
  open(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error("viewer websocket error"));
    });
  }
  /** Resolve once `check` returns a value over the received messages. */
  async until<T>(what: string, check: (msgs: Msg[]) => T | undefined | false): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const v = check(this.msgs);
      if (v) return v;
      const left = deadline - Date.now();
      if (left <= 0) {
        const types = this.msgs.map((m) => m.type).join(", ");
        throw new Error(`timeout waiting for ${what}; got: ${types}`);
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
}

function touchTree(dir: string, when: Date) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) touchTree(p, when);
    else utimesSync(p, when, when);
  }
}

/** Read lines from a child's stdout until `re` matches; returns the match. */
async function waitForLine(proc: Subprocess<"ignore", "pipe", "inherit">, re: RegExp) {
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    const m = re.exec(buf);
    if (m) {
      reader.releaseLock();
      return m;
    }
  }
  throw new Error(`server did not print ${re}; output:\n${buf}`);
}

const sessionsOf = (m: Msg[]) =>
  m
    .filter((x) => x.type === "session.started" && x.data.personId === PERSON_ID)
    .map((x) => x.data.session as Session);

const sortKey = (s: { agent: string; project?: string }) => `${s.agent}/${s.project}`;
const shape = (s: Session) => ({
  agent: s.agent,
  project: s.project,
  activity: s.activity,
  subagents: s.subagents,
});

describe.skipIf(!RUN)("connector -> server -> viewer (e2e)", () => {
  let base = EXTERNAL ?? "";
  let server: Subprocess<"ignore", "pipe", "inherit"> | null = null;
  let connector: Subprocess | null = null;
  let home = "";
  let viewer: Viewer;
  const stateBodies: string[] = [];

  async function apiState() {
    const res = await fetch(`${base}/api/state`, { headers: AUTH });
    expect(res.status).toBe(200);
    const text = await res.text();
    stateBodies.push(text);
    return JSON.parse(text) as {
      data: { people: { personId: string; name: string; sessions: Session[] }[] };
    };
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "ao-e2e-"));
    cpSync(join(ROOT, "fixtures", "home"), join(home, "home"), { recursive: true });
    touchTree(join(home, "home"), new Date());

    if (!EXTERNAL) {
      server = Bun.spawn([BUN, "run", join(ROOT, "apps/server/src/dev/bun-server.ts")], {
        env: { ...process.env, PORT: "0", DB: ":memory:", CONNECTOR_PASSWORD: PASSWORD },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
      });
      const m = await waitForLine(server, /on (http:\/\/localhost:\d+)/);
      base = m[1]!;
    }
    viewer = new Viewer(`${base.replace(/^http/, "ws")}/ws/viewer`);
    await viewer.open();
    await viewer.until("office.snapshot", (m) => m.some((x) => x.type === "office.snapshot"));
  }, 15_000);

  afterAll(() => {
    connector?.kill("SIGKILL");
    server?.kill("SIGKILL");
    viewer?.ws.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  /** The real connector against the fixture home; `configDir` keeps its clientId apart. */
  function spawnConnector(name: string, configDir: string, extra: string[] = []) {
    return Bun.spawn(
      [
        BUN,
        "run",
        join(ROOT, "apps/connector/src/main.ts"),
        "run",
        "--server",
        `${base.replace(/^http/, "ws")}`,
        "--password",
        PASSWORD,
        "--name",
        name,
        "--machine-name",
        "e2e-box",
        "--home",
        join(home, "home"),
        "--assume-processes",
        ...extra,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          AGENT_OFFICE_CONFIG_DIR: join(home, configDir),
          AGENT_OFFICE_NO_UPDATE: "1",
        },
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
  }

  test("connector sessions reach the viewer, then end on SIGTERM", async () => {
    connector = spawnConnector(NAME, "config");

    // person.joined, then one session.started per fixture session
    const joined = await viewer.until("person.joined", (m) =>
      m.find(
        (x) =>
          x.type === "person.joined" &&
          (x.data.person as { personId: string }).personId === PERSON_ID,
      ),
    );
    expect((joined.data.person as { name: string }).name).toBe(NAME);

    const started = await viewer.until("4 x session.started", (m) => {
      const s = sessionsOf(m);
      return s.length >= EXPECTED.length && s;
    });
    expect(started.map(shape).sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual(
      EXPECTED,
    );
    expect(new Set(started.map((s) => s.agent))).toEqual(new Set(["claude", "codex", "pi"]));
    expect(new Set(started.map((s) => s.machine))).toEqual(new Set(["e2e-box"]));

    // /api/state agrees with the event stream
    const state = await apiState();
    const me = state.data.people.find((p) => p.personId === PERSON_ID);
    expect(me).toBeDefined();
    expect(me!.name).toBe(NAME);
    // the agent card's "today" endpoint sees the same person
    const day = (await (
      await fetch(`${base}/api/people/${PERSON_ID}`, { headers: AUTH })
    ).json()) as {
      online: boolean;
      sessionsToday: number;
    };
    expect(day.online).toBe(true);
    expect(day.sessionsToday).toBeGreaterThanOrEqual(EXPECTED.length);
    expect(me!.sessions.map((s) => s.sessionId).sort()).toEqual(
      started.map((s) => s.sessionId).sort(),
    );
    expect(me!.sessions.map(shape).sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual(
      EXPECTED,
    );

    // SIGTERM -> connector.bye -> every session ends immediately (person.left follows after
    // the 60 s grace period, which this test doesn't wait for)
    connector.kill("SIGTERM");
    expect(await connector.exited).toBe(0);
    connector = null;
    const ended = await viewer.until("session.ended for every session", (m) => {
      const ids = new Set(
        m
          .filter((x) => x.type === "session.ended" && x.data.personId === PERSON_ID)
          .map((x) => x.data.sessionId as string),
      );
      return started.every((s) => ids.has(s.sessionId)) && ids;
    });
    expect(ended.size).toBe(EXPECTED.length);

    const after = await apiState();
    const meAfter = after.data.people.find((p) => p.personId === PERSON_ID);
    // either still in the grace period with no sessions, or already gone
    expect(meAfter?.sessions ?? []).toEqual([]);
    const left = viewer.msgs.some((x) => x.type === "person.left" && x.data.personId === PERSON_ID);
    if (left) expect(meAfter).toBeUndefined();

    // privacy: the canary from the fixture transcripts never leaves the laptop
    const everything = [...viewer.raw, ...stateBodies].join("\n");
    expect(everything.length).toBeGreaterThan(0);
    expect(everything).not.toContain(SECRET);
  }, 25_000);

  test("a detailed look description (> 200 chars) is accepted", async () => {
    const name = `${NAME} Look`;
    const personId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const description =
      "Slicked-back brown hair, tortoiseshell panto glasses, a charcoal Janker with a green " +
      "stand-up collar and horn buttons over a grey-lilac damask vest and a white shirt, " +
      "worn tan lederhosen with vine embroidery, white ankle socks and white sneakers with " +
      "navy heel tabs. Grinning, one hand in his pocket.";
    expect(description.length).toBeGreaterThan(200);
    connector = spawnConnector(name, "config-look", ["--description", description]);
    // an oversized hello would be rejected and close the socket: no person.joined, no sessions
    await viewer.until("person.joined (detailed look)", (m) =>
      m.find(
        (x) =>
          x.type === "person.joined" &&
          (x.data.person as { personId: string }).personId === personId,
      ),
    );
    await viewer.until("session.started (detailed look)", (m) =>
      m.some((x) => x.type === "session.started" && x.data.personId === personId),
    );
    await apiState();
    connector.kill("SIGTERM");
    expect(await connector.exited).toBe(0);
    connector = null;
    // privacy: the description shapes the look but is never sent to viewers, not even a part
    const everything = [...viewer.raw, ...stateBodies].join("\n");
    expect(everything).toContain(personId);
    for (const part of [description, description.slice(0, 200), "tortoiseshell panto glasses"])
      expect(everything).not.toContain(part);
  }, 25_000);
});
