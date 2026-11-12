import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVITIES, AGENTS } from "@agent-office/protocol";
import { parseArgs } from "../src/cli.ts";
import { type SessionStatus, type StatusSnapshot, statusSnapshot } from "../src/status.ts";
import { VERSION } from "../src/version.ts";

const NOW = 1_800_000_000_000;
const SECRET = "STATUS_SECRET_CANARY";
const session: SessionStatus = {
  agent: "claude",
  activity: "reading",
  subagents: 2,
  startedAt: NOW - 60_000,
};
const stored = {
  pid: 123,
  updatedAt: NOW,
  connected: true,
  welcomed: true,
  sessions: [session],
};
const empty: StatusSnapshot = {
  schemaVersion: 1,
  connectorVersion: "0.2.123",
  daemonRunning: false,
  connected: false,
  updatedAt: null,
  sessions: [],
};
const snapshot = (raw: string | null, alive = true) =>
  statusSnapshot(raw, { connectorVersion: "0.2.123", now: NOW, pidAlive: () => alive });
const from = (patch: Record<string, unknown> = {}, alive = true) =>
  snapshot(JSON.stringify({ ...stored, ...patch }), alive);

describe("statusSnapshot", () => {
  test("missing, corrupt and non-object JSON return a stable empty snapshot", () => {
    for (const raw of [null, "", "{broken", "null", "[]", "true", "42", '"text"']) {
      expect(snapshot(raw)).toEqual(empty);
    }
    expect(snapshot("{}")).toEqual(empty);
  });

  test("fresh live PID plus active socket and welcome are required for connected", () => {
    expect(from()).toEqual({
      ...empty,
      daemonRunning: true,
      connected: true,
      updatedAt: NOW,
      sessions: [session],
    });
    for (const flag of [false, undefined, null, 1, "true"]) {
      expect(from({ welcomed: flag })).toMatchObject({ daemonRunning: true, connected: false });
      expect(from({ connected: flag })).toMatchObject({ daemonRunning: true, connected: false });
    }
    expect(from({ connected: false, welcomed: false }).sessions).toEqual([session]);
  });

  test("freshness has strict boundaries and stale/dead sessions are hidden", () => {
    expect(from({ updatedAt: NOW - 9_999 }).daemonRunning).toBe(true);
    for (const updatedAt of [NOW - 10_000, NOW - 10_001, NOW + 1]) {
      expect(from({ updatedAt })).toEqual({ ...empty, updatedAt });
    }
    expect(from({}, false)).toEqual({ ...empty, updatedAt: NOW });
    for (const updatedAt of [null, "1800000000000", -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(from({ updatedAt })).toEqual(empty);
    }
  });

  test("invalid or stale PIDs are never passed to the liveness check", () => {
    const checked: number[] = [];
    const options = {
      connectorVersion: "test",
      now: NOW,
      pidAlive: (pid: number) => {
        checked.push(pid);
        return true;
      },
    };
    for (const pid of [null, "123", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(statusSnapshot(JSON.stringify({ ...stored, pid }), options).daemonRunning).toBe(false);
    }
    statusSnapshot(JSON.stringify({ ...stored, updatedAt: NOW - 10_000 }), options);
    expect(checked).toEqual([]);
    statusSnapshot(JSON.stringify(stored), options);
    expect(checked).toEqual([123]);
  });

  test("only enum and validated numeric session metadata passes the allowlist", () => {
    const sessions = AGENTS.flatMap((agent) =>
      ACTIVITIES.map((activity) => ({ ...session, agent, activity, context: 0.5 })),
    );
    expect(from({ sessions }).sessions).toEqual(sessions);
    for (const sessions of [null, {}, 42, "secret"])
      expect(from({ sessions }).sessions).toEqual([]);
    const malformed = [
      null,
      [],
      SECRET,
      {},
      { ...session, agent: SECRET },
      { ...session, activity: SECRET },
      ...[-1, 0.5, "2", null, Number.MAX_SAFE_INTEGER + 1].map((subagents) => ({
        ...session,
        subagents,
      })),
      ...[-1, 0.5, "123", null, Number.MAX_SAFE_INTEGER + 1].map((startedAt) => ({
        ...session,
        startedAt,
      })),
    ];
    expect(from({ sessions: [...malformed, session] }).sessions).toEqual([session]);
    for (const context of [0, 1, 0.5]) {
      expect(from({ sessions: [{ ...session, context }] }).sessions).toEqual([
        { ...session, context },
      ]);
    }
    for (const context of [-1, 1.1, null, "0.5", SECRET]) {
      expect(from({ sessions: [{ ...session, context }] }).sessions).toEqual([session]);
    }
    for (const context of ["1e999", "-1e999"]) {
      const raw = JSON.stringify({
        ...stored,
        sessions: [{ ...session, context: "NUMBER" }],
      }).replace('"NUMBER"', context);
      expect(snapshot(raw).sessions).toEqual([session]);
    }
  });

  test("never reflects arbitrary disk fields, identity, project names, paths or errors", () => {
    const unsafe = {
      version: SECRET,
      server: `wss://user:${SECRET}@example.invalid/ws?token=${SECRET}`,
      name: SECRET,
      personId: SECRET,
      lastError: SECRET,
      looks: `/Users/${SECRET}/claude`,
      config: { password: SECRET },
      [SECRET]: SECRET,
      sessions: [
        {
          ...session,
          context: 0.75,
          project: SECRET,
          sessionKey: SECRET,
          cwd: `/Users/${SECRET}`,
          prompt: SECRET,
          error: SECRET,
          extra: { secret: SECRET },
        },
      ],
    };
    const result = from(unsafe);
    expect(result.sessions).toEqual([{ ...session, context: 0.75 }]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(Object.keys(result)).toEqual(Object.keys(empty));
  });
});

describe("status CLI", () => {
  test("--json is boolean and never consumes the command or following positional argument", () => {
    expect(parseArgs(["--json", "status"])).toEqual({
      command: "status",
      flags: { json: true },
      rest: [],
    });
    expect(parseArgs(["status", "--json", "extra"]).rest).toEqual(["extra"]);
  });

  test("isolated subprocess prints exactly one safe JSON object for all health states", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-status-"));
    const main = join(import.meta.dir, "..", "src", "main.ts");
    const run = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, main, ...args], {
        env: { ...process.env, HOME: dir, AGENT_OFFICE_CONFIG_DIR: dir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { out, err, code };
    };
    try {
      // No config/status: also guard the unchanged default text behavior and help.
      const text = await run("status");
      expect(text.code).toBe(0);
      expect(text.out).toContain(`agent-office ${VERSION}`);
      expect(text.out).toContain("config    missing");
      expect(text.out).toContain("daemon    not running (no status file yet)");
      expect((await run("help")).out).toContain("--json");
      // A config full of secrets must never be loaded or echoed in JSON mode.
      writeFileSync(
        join(dir, "config.toml"),
        `password = "${SECRET}"\nserver = "https://${SECRET}"\n`,
      );
      const exited = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await exited.exited).toBe(0);
      const live = {
        ...stored,
        pid: process.pid,
        updatedAt: Date.now(),
        server: `wss://user:${SECRET}@example.invalid/?token=${SECRET}`,
        lastError: SECRET,
        looks: SECRET,
        version: SECRET,
        sessions: [{ ...session, project: SECRET, sessionKey: SECRET, prompt: SECRET }],
      };
      const scenarios = [
        { label: "missing", raw: null, running: false, connected: false, updatedAt: null },
        { label: "corrupt", raw: `{${SECRET}`, running: false, connected: false, updatedAt: null },
        { label: "null", raw: "null", running: false, connected: false, updatedAt: null },
        { label: "array", raw: "[]", running: false, connected: false, updatedAt: null },
        { label: "fresh", patch: {}, running: true, connected: true },
        {
          label: "stale",
          patch: { updatedAt: Date.now() - 60_000 },
          running: false,
          connected: false,
        },
        { label: "dead", patch: { pid: exited.pid }, running: false, connected: false },
        { label: "unwelcomed", patch: { welcomed: false }, running: true, connected: false },
        {
          label: "disconnected",
          patch: { connected: false, welcomed: false },
          running: true,
          connected: false,
        },
        {
          label: "bad sessions",
          patch: { sessions: [null, { agent: SECRET }] },
          running: true,
          connected: true,
        },
      ];
      for (const scenario of scenarios) {
        const raw =
          "patch" in scenario ? JSON.stringify({ ...live, ...scenario.patch }) : scenario.raw;
        if (raw === null) rmSync(join(dir, "status.json"), { force: true });
        else writeFileSync(join(dir, "status.json"), raw!);
        const { out, err, code } = await run("status", "--json");
        expect(code, scenario.label).toBe(0);
        expect(err, scenario.label).toBe("");
        const parsed = JSON.parse(out);
        expect(out, scenario.label).toBe(`${JSON.stringify(parsed)}\n`);
        expect(parsed).toEqual({
          schemaVersion: 1,
          connectorVersion: VERSION,
          daemonRunning: scenario.running,
          connected: scenario.connected,
          updatedAt:
            "patch" in scenario
              ? (scenario.patch?.updatedAt ?? live.updatedAt)
              : scenario.updatedAt,
          sessions: scenario.running && scenario.label !== "bad sessions" ? [session] : [],
        });
        expect(out).not.toContain(SECRET);
        expect(out).not.toContain(dir);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
