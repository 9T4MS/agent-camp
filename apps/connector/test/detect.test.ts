import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { IDLE_AFTER_MS, type SessionInfo } from "@agent-office/protocol";
import {
  type ActivityHold,
  BUSY_HOLD_MS,
  deriveActivity,
  PENDING_TOOL_HOLD_MS,
  TEXT_SETTLE_MS,
  toolActivity,
} from "../src/detect/activity.ts";
import {
  decodeClaudeFolder,
  encodeClaudeCwd,
  latestSubagentWrite,
  normalizeClaude,
} from "../src/detect/claude.ts";
import { normalizeCodex } from "../src/detect/codex.ts";
import { Detector, projectName, sessionKeyFor } from "../src/detect/index.ts";
import { encodePiCwd, normalizePi } from "../src/detect/pi.ts";
import { parseJsonl, readHead, TailReader } from "../src/detect/tail.ts";
import { agentDirs } from "../src/paths.ts";
import {
  agentProcesses,
  classifyArgv,
  claudeDesktopInPs,
  fakeProcesses,
  isCodexAppServer,
  type ProcInfo,
  PS_COLUMNS,
  parseLsof,
  parsePs,
  parseStatPpid,
  procRow,
  psLines,
  runsAsExe,
  UCOMM_WIDTH,
} from "../src/proc.ts";
import { type FakeHome, makeHome, P, psOut, RAW_IDS } from "./helpers.ts";

let h: FakeHome;
afterEach(() => h?.cleanup());

function detector(opts: {
  procs?: ProcInfo[];
  cwds?: Record<number, string>;
  assume?: boolean;
  share?: boolean;
  now?: number;
  clientId?: string;
}) {
  return new Detector({
    dirs: agentDirs({}, h.home),
    clientId: opts.clientId ?? "c_test",
    shareProjectNames: opts.share ?? true,
    processes: fakeProcesses(opts.procs ?? [], opts.cwds ?? {}),
    assumeProcesses: opts.assume ?? false,
    now: opts.now ? () => opts.now! : undefined,
  });
}

const byProject = (sessions: SessionInfo[]) =>
  Object.fromEntries(sessions.map((s) => [s.project ?? "?", s]));

const jsonl = (o: object) => `${JSON.stringify(o)}\n`;
const ASSISTANT_DONE = {
  type: "assistant",
  message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
};

describe("detectors on fixtures/home", () => {
  test("all fresh + assumed processes: kinds, activities, subagents, projects", async () => {
    h = makeHome();
    const sessions = await detector({ assume: true }).poll();
    expect(sessions).toHaveLength(4);
    const s = byProject(sessions);
    expect(s["agent-office"]).toMatchObject({ agent: "claude", activity: "typing", subagents: 2 });
    expect(s.website).toMatchObject({ agent: "claude", activity: "waiting", subagents: 0 });
    expect(s["codex-thing"]).toMatchObject({ agent: "codex", activity: "running", subagents: 0 });
    expect(s["pi-proj"]).toMatchObject({ agent: "pi", activity: "typing", subagents: 0 });
    // startedAt from pid file / headers
    expect(s["agent-office"]!.startedAt).toBe(1793178000000);
    expect(s["codex-thing"]!.startedAt).toBe(Date.parse("2026-11-10T09:00:00.000Z"));
    for (const x of sessions) expect(x.sessionKey).toMatch(/^[0-9a-f]{16}$/);
  });

  test("stale transcripts (no tied process) are absent", async () => {
    h = makeHome();
    h.age(P.codex, 10 * 60_000);
    h.age(P.pi, 91_000);
    const sessions = await detector({ assume: true }).poll();
    const agents = sessions.map((s) => s.agent).sort();
    expect(agents).toEqual(["claude", "claude"]);
  });

  test("agent process not running -> absent, even when fresh", async () => {
    h = makeHome();
    expect(await detector({ procs: [] }).poll()).toEqual([]);
    // only claude runs: codex and pi vanish
    const sessions = await detector({ procs: [{ pid: 12345, agent: "claude" }] }).poll();
    expect(sessions.map((s) => s.agent)).toEqual(["claude", "claude"]);
  });

  test("pid file ties a session to a pid; a pid of another agent does not count", async () => {
    h = makeHome();
    h.age(P.claudeActive, 100_000); // past the 90 s window
    let sessions = await detector({ procs: [{ pid: 12345, agent: "claude" }] }).poll();
    expect(byProject(sessions)["agent-office"]?.activity).toBe("typing");
    sessions = await detector({ procs: [{ pid: 12345, agent: "codex" }] }).poll();
    expect(byProject(sessions)["agent-office"]).toBeUndefined();
  });

  test("idle after 2+ min while the process is alive; dead pid -> gone", async () => {
    h = makeHome();
    // finish the pending Edit first: a pending tool call would hold the session (see below)
    appendFileSync(h.path(P.claudeActive), jsonl(ASSISTANT_DONE));
    h.age(P.claudeActive, 3 * 60_000);
    h.age(P.claudeWaiting, 3 * 60_000);
    h.age(P.sub1, 3 * 60_000);
    h.age(P.sub2, 3 * 60_000);
    const sessions = await detector({ procs: [{ pid: 12345, agent: "claude" }] }).poll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ project: "agent-office", activity: "idle", subagents: 0 });
  });

  test("process cwd keeps the newest matching transcript live (idle)", async () => {
    h = makeHome();
    const poll = () =>
      detector({
        procs: [
          { pid: 777, agent: "codex" },
          { pid: 778, agent: "pi" },
        ],
        cwds: { 777: "/Users/anna/code/codex-thing", 778: "/Users/anna/code/pi-proj" },
      })
        .poll()
        .then(byProject);
    // both end on a pending tool call and report no status: held off idle for a while ...
    h.age(P.codex, 5 * 60_000);
    h.age(P.pi, 5 * 60_000);
    let s = await poll();
    expect(s["codex-thing"]).toMatchObject({ agent: "codex", activity: "running" });
    expect(s["pi-proj"]).toMatchObject({ agent: "pi", activity: "typing" });
    // ... but not past the hold
    h.age(P.codex, BUSY_HOLD_MS + 60_000);
    h.age(P.pi, BUSY_HOLD_MS + 60_000);
    s = await poll();
    expect(s["codex-thing"]).toMatchObject({ agent: "codex", activity: "idle" });
    expect(s["pi-proj"]).toMatchObject({ agent: "pi", activity: "idle" });
    // a process in another folder doesn't keep them
    const none = await detector({
      procs: [{ pid: 777, agent: "codex" }],
      cwds: { 777: "/Users/anna/elsewhere" },
    }).poll();
    expect(none).toEqual([]);
  });

  test("an agent hosted inside another agent (Pi's Claude bridge) is not a second desk", async () => {
    h = makeHome();
    // pid 12345 is the agent-office Claude pid file; here it runs under pi 778
    const cwds = { 778: "/Users/anna/code/pi-proj" };
    let procs: ProcInfo[] = [
      { pid: 778, agent: "pi" },
      { pid: 12345, agent: "claude", hostPid: 778 },
    ];
    const d = new Detector({
      dirs: agentDirs({}, h.home),
      clientId: "c_test",
      shareProjectNames: true,
      processes: { list: async () => procs, cwds: () => fakeProcesses([], cwds).cwds([778]) },
    });
    let sessions = await d.poll();
    expect(sessions.map((s) => `${s.agent}:${s.project}`)).toEqual(["pi:pi-proj"]);
    // after the hosted process exits its transcript is still fresh: still hidden, even though
    // an unrelated real Claude now runs (which keeps the other fresh Claude session live)
    procs = [
      { pid: 778, agent: "pi" },
      { pid: 999, agent: "claude" },
    ];
    sessions = await d.poll();
    expect(sessions.map((s) => `${s.agent}:${s.project}`).sort()).toEqual([
      "claude:website",
      "pi:pi-proj",
    ]);
    // resumed natively (`claude --resume <id>`): a top-level pid owns it -> visible again
    procs = [
      { pid: 778, agent: "pi" },
      { pid: 12345, agent: "claude" },
    ];
    sessions = await d.poll();
    expect(byProject(sessions)["agent-office"]?.agent).toBe("claude");
    // a standalone Claude on the same pid file is a desk as usual
    sessions = await detector({ procs: [{ pid: 12345, agent: "claude" }] }).poll();
    expect(byProject(sessions)["agent-office"]?.agent).toBe("claude");
  });

  test("hosted helpers (purrness workers) are robots of the host's desk and keep it busy", async () => {
    h = makeHome();
    h.age(P.pi, 5 * 60_000); // Pi writes nothing while it waits for the subagent tool
    const host = { pid: 778, agent: "pi" as const };
    const cwds = { 778: "/Users/anna/code/pi-proj" };
    const sdk = { agent: "claude" as const, backend: true };
    const busy = await detector({
      procs: [
        host,
        { pid: 801, ...sdk, hostPid: 778 }, // the host's own bridge backend: no robot
        { pid: 810, agent: "pi", hostPid: 778 }, // worker
        { pid: 811, ...sdk, hostPid: 810 }, // the worker's backend: no robot
        { pid: 820, agent: "pi", hostPid: 810 }, // nested worker
        { pid: 830, agent: "pi", hostPid: 778 }, // worker
      ],
      cwds,
    }).poll();
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({
      agent: "pi",
      project: "pi-proj",
      activity: "typing",
      subagents: 3,
    });
    // only the backend runs: busy, no robots
    const turn = await detector({ procs: [host, { pid: 801, ...sdk, hostPid: 778 }], cwds }).poll();
    expect(turn[0]).toMatchObject({ activity: "typing", subagents: 0 });
    // nothing hosted and the turn over: the quiet transcript is idle again (a still pending
    // tool call alone would hold it, see "busy sessions are not idle")
    appendFileSync(
      h.path(P.pi),
      jsonl({
        type: "message",
        message: { role: "assistant", content: [], stopReason: "aborted" },
      }),
    );
    h.age(P.pi, 5 * 60_000);
    const idle = await detector({ procs: [host], cwds }).poll();
    expect(idle[0]).toMatchObject({ activity: "idle", subagents: 0 });
    // a long-lived hosted process (e.g. `claude mcp serve`) keeps it busy for 10 min at most
    h.age(P.pi, 11 * 60_000);
    const stale = await detector({
      procs: [host, { pid: 810, agent: "pi", hostPid: 778 }],
      cwds,
    }).poll();
    expect(stale[0]).toMatchObject({ activity: "idle", subagents: 0 });
  });

  test("subagents older than 60 s are not counted", async () => {
    h = makeHome();
    h.age(P.sub2, 61_000);
    const s = byProject(await detector({ assume: true }).poll());
    expect(s["agent-office"]?.subagents).toBe(1);
  });

  test("share_project_names=false omits project", async () => {
    h = makeHome();
    const sessions = await detector({ assume: true, share: false }).poll();
    expect(sessions).toHaveLength(4);
    for (const s of sessions) expect(s.project).toBeUndefined();
  });

  test("session keys are salted hashes, never raw ids", async () => {
    h = makeHome();
    const a = await detector({ assume: true, clientId: "c_one" }).poll();
    const b = await detector({ assume: true, clientId: "c_two" }).poll();
    const keysA = a.map((s) => s.sessionKey);
    const keysB = b.map((s) => s.sessionKey);
    for (const k of keysA) expect(keysB).not.toContain(k);
    const json = JSON.stringify(a);
    for (const id of RAW_IDS) {
      expect(json).not.toContain(id);
      expect(json).not.toContain(id.slice(0, 8));
    }
    expect(sessionKeyFor("c", "claude", RAW_IDS[0]!)).toMatch(/^[0-9a-f]{16}$/);
  });

  test("incremental tailing follows appended lines", async () => {
    h = makeHome();
    const d = detector({ assume: true });
    const active = () => d.poll().then((s) => byProject(s)["agent-office"]?.activity);
    expect(await active()).toBe("typing");
    const line = (o: object) => `${JSON.stringify(o)}\n`;
    appendFileSync(
      h.path(P.claudeActive),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result" }] } }),
    );
    expect(await active()).toBe("thinking");
    appendFileSync(
      h.path(P.claudeActive),
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: {} }], stop_reason: null },
      }),
    );
    expect(await active()).toBe("running");
    // a partial line is held back until its newline arrives
    const end = line({
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    });
    appendFileSync(h.path(P.claudeActive), end.slice(0, 20));
    expect(await active()).toBe("running");
    appendFileSync(h.path(P.claudeActive), end.slice(20));
    expect(await active()).toBe("waiting");
  });

  test("garbage never throws", async () => {
    h = makeHome();
    writeFileSync(h.path(".claude/sessions/999.json"), "{nope");
    writeFileSync(h.path(".claude/sessions/1000.json"), "[1,2,3]");
    mkdirSync(h.path(".claude/projects/-x"), { recursive: true });
    writeFileSync(h.path(".claude/projects/-x/abc.jsonl"), "\u0000\u0001garbage\n{\n[1]\nnull\n");
    writeFileSync(h.path(".codex/sessions/2026/11/10/rollout-broken.jsonl"), "{{{{");
    // legacy sidechain transcript next to sessions: not a session of its own
    writeFileSync(
      h.path(".claude/projects/-Users-anna-code-website/agent-1234.jsonl"),
      '{"type":"user","isSidechain":true}\n',
    );
    const sessions = await detector({ assume: true }).poll();
    // the broken codex rollout is fresh, so it counts (as waiting); agent-*.jsonl does not
    expect(sessions.filter((s) => s.agent === "claude")).toHaveLength(3);
    expect(sessions.length).toBe(6);
    // missing home entirely
    h.cleanup();
    expect(await detector({ assume: true }).poll()).toEqual([]);
  });

  test("Codex waiting for command approval goes idle; a pending command holds 11 min", async () => {
    h = makeHome();
    const codex = () =>
      detector({
        procs: [{ pid: 777, agent: "codex" }],
        cwds: { 777: "/Users/anna/code/codex-thing" },
      })
        .poll()
        .then((s) => byProject(s)["codex-thing"]?.activity);
    // the fixture ends on a pending (sandboxed) `cargo test`: held off idle ...
    h.age(P.codex, 10 * 60_000);
    expect(await codex()).toBe("running");
    // ... but not as long as an explicit busy status would be
    h.age(P.codex, PENDING_TOOL_HOLD_MS + 1000);
    expect(await codex()).toBe("idle");
    // a command that needs approval may sit at the prompt: idle after the usual 2 min
    appendFileSync(
      h.path(P.codex),
      jsonl({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: "cargo publish",
            sandbox_permissions: "require_escalated",
          }),
          call_id: "call_A4",
        },
      }),
    );
    h.age(P.codex, 30_000);
    expect(await codex()).toBe("running");
    h.age(P.codex, 3 * 60_000);
    expect(await codex()).toBe("idle");
  });

  test("pid file without a transcript yet -> waiting session", async () => {
    h = makeHome();
    writeFileSync(
      h.path(".claude/sessions/4242.json"),
      JSON.stringify({ pid: 4242, sessionId: "fresh-id", cwd: "/Users/anna/code/new-thing" }),
    );
    const sessions = await detector({ procs: [{ pid: 4242, agent: "claude" }] }).poll();
    // also the website session is fresh and a claude process runs
    expect(byProject(sessions)["new-thing"]).toMatchObject({
      agent: "claude",
      activity: "waiting",
    });
  });
});

describe("busy sessions are not idle", () => {
  const WEBSITE_ID = RAW_IDS[1]!;
  const websiteSub = (name: string) =>
    `.claude/projects/-Users-anna-code-website/${WEBSITE_ID}/subagents/${name}`;
  /** (Re)write a Claude pid file like Claude Code 2.1.32x does, with an optional status. */
  const pidFile = (pid: number, sessionId: string, status?: string) =>
    writeFileSync(
      h.path(`.claude/sessions/${pid}.json`),
      JSON.stringify({
        pid,
        sessionId,
        cwd: "/Users/anna/code/website",
        startedAt: 1793177400000,
        ...(status ? { status, statusUpdatedAt: 1793177500000, updatedAt: 1793177500000 } : {}),
      }),
    );
  const website = (procs: ProcInfo[]) =>
    detector({ procs })
      .poll()
      .then((s) => byProject(s).website);

  test("pid file says busy: a finished-looking, quiet turn is thinking, subagents count", async () => {
    h = makeHome();
    pidFile(12346, WEBSITE_ID, "busy");
    h.age(P.claudeWaiting, 10 * 60_000); // ends with end_turn, 10 min quiet
    mkdirSync(h.path(websiteSub("")), { recursive: true });
    writeFileSync(h.path(websiteSub("agent-bg.jsonl")), jsonl({ type: "user" }));
    expect(await website([{ pid: 12346, agent: "claude" }])).toMatchObject({
      activity: "thinking",
      subagents: 1,
    });
    // the same session reporting "idle", its subagent quiet (no meta.json: 60 s rule), falls
    // back to the transcript: idle, no subagents
    pidFile(12346, WEBSITE_ID, "idle");
    h.age(websiteSub("agent-bg.jsonl"), 2 * 60_000);
    expect(await website([{ pid: 12346, agent: "claude" }])).toMatchObject({
      activity: "idle",
      subagents: 0,
    });
  });

  test("busy + pending tool -> that tool's activity, however long it runs", async () => {
    h = makeHome();
    pidFile(12346, WEBSITE_ID, "busy");
    appendFileSync(
      h.path(P.claudeWaiting),
      jsonl({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: {} }], stop_reason: null },
      }),
    );
    h.age(P.claudeWaiting, 8 * 60_000);
    expect((await website([{ pid: 12346, agent: "claude" }]))?.activity).toBe("running");
  });

  test("busy holds only until the transcript and its subagents are silent too long", async () => {
    h = makeHome();
    pidFile(12346, WEBSITE_ID, "busy");
    h.age(P.claudeWaiting, BUSY_HOLD_MS + 60_000);
    // a stale "busy" (e.g. a forgotten background dev server) no longer pins the desk
    expect((await website([{ pid: 12346, agent: "claude" }]))?.activity).toBe("idle");
    // a subagent that wrote recently (but > SUBAGENT_LIVE_MS ago) proves work goes on
    mkdirSync(h.path(websiteSub("workflows/w1")), { recursive: true });
    writeFileSync(h.path(websiteSub("workflows/w1/agent-x.jsonl")), jsonl({ type: "user" }));
    h.age(websiteSub("workflows/w1/agent-x.jsonl"), 5 * 60_000);
    expect(await website([{ pid: 12346, agent: "claude" }])).toMatchObject({
      activity: "thinking",
      subagents: 0,
    });
  });

  test("busy from a dead process's pid file is ignored", async () => {
    h = makeHome();
    pidFile(12346, WEBSITE_ID); // the live process, no status
    pidFile(55555, WEBSITE_ID, "busy"); // left behind by a process that is gone
    h.age(P.claudeWaiting, 10 * 60_000);
    expect((await website([{ pid: 12346, agent: "claude" }]))?.activity).toBe("idle");
  });

  test("an open question to the human is waiting, then idle, even when busy", async () => {
    h = makeHome();
    pidFile(12346, WEBSITE_ID, "busy");
    appendFileSync(
      h.path(P.claudeWaiting),
      jsonl({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "AskUserQuestion", input: {} }],
          stop_reason: "tool_use",
        },
      }),
    );
    expect((await website([{ pid: 12346, agent: "claude" }]))?.activity).toBe("waiting");
    h.age(P.claudeWaiting, 3 * 60_000);
    expect((await website([{ pid: 12346, agent: "claude" }]))?.activity).toBe("idle");
  });

  test("no status field: a pending tool call holds, a non-busy status does not", async () => {
    h = makeHome();
    // agent-office ends on a pending Edit; its fixture pid file has no status
    h.age(P.claudeActive, 10 * 60_000);
    h.age(P.sub1, 10 * 60_000);
    h.age(P.sub2, 10 * 60_000);
    const office = () =>
      detector({ procs: [{ pid: 12345, agent: "claude" }] })
        .poll()
        .then((s) => byProject(s)["agent-office"]);
    expect(await office()).toMatchObject({ activity: "typing", subagents: 0 });
    // a reported "idle" outranks the pending tool (e.g. it sits at a permission prompt)
    writeFileSync(
      h.path(".claude/sessions/12345.json"),
      JSON.stringify({ pid: 12345, sessionId: RAW_IDS[0], status: "idle" }),
    );
    expect((await office())?.activity).toBe("idle");
    // without a status the hold still ends after BUSY_HOLD_MS of silence
    writeFileSync(
      h.path(".claude/sessions/12345.json"),
      JSON.stringify({ pid: 12345, sessionId: RAW_IDS[0] }),
    );
    h.age(P.claudeActive, BUSY_HOLD_MS + 1);
    expect((await office())?.activity).toBe("typing"); // its subagents wrote 10 min ago
    h.age(P.sub1, BUSY_HOLD_MS + 1);
    h.age(P.sub2, BUSY_HOLD_MS + 1);
    expect((await office())?.activity).toBe("idle");
  });

  describe("bookkeeping lines after a turn do not wake the session", () => {
    const T = Date.now() - 10 * 60_000; // the website turn ends with end_turn at T
    const AWAY = { type: "system", subtype: "away_summary", content: "recap" };
    /** A Detector whose clock the test moves. */
    const clocked = () => {
      const clock = { now: T };
      const d = new Detector({
        dirs: agentDirs({}, h.home),
        clientId: "c_test",
        shareProjectNames: true,
        processes: fakeProcesses([{ pid: 12346, agent: "claude" }]),
        now: () => clock.now,
      });
      const at = async (ms: number) => {
        clock.now = T + ms;
        return byProject(await d.poll()).website?.activity;
      };
      return { at, fresh: async (ms: number) => clocked().at(ms) };
    };
    /** Append a line and stamp the transcript as written `ms` after T. */
    const write = (o: object, ms: number) => {
      appendFileSync(h.path(P.claudeWaiting), jsonl(o));
      h.age(P.claudeWaiting, -ms, T);
    };

    test("Claude Code's away_summary ~182 s later: no bar -> desk -> bar bounce", async () => {
      h = makeHome();
      h.age(P.claudeWaiting, 0, T);
      // the live process reports "idle" since the turn ended
      writeFileSync(
        h.path(".claude/sessions/12346.json"),
        JSON.stringify({ pid: 12346, sessionId: WEBSITE_ID, status: "idle", statusUpdatedAt: T }),
      );
      const d = clocked();
      expect(await d.at(60_000)).toBe("waiting");
      expect(await d.at(150_000)).toBe("idle");
      write(AWAY, 182_000);
      expect(await d.at(190_000)).toBe("idle");
      expect(await d.at(310_000)).toBe("idle");
      // a connector started after the write knows only the mtime: the status settles it
      expect(await d.fresh(190_000)).toBe("idle");
      // a new prompt wakes it at once, status or not
      write({ type: "user", message: { role: "user", content: "next" } }, 400_000);
      expect(await d.at(401_000)).toBe("thinking");
    });

    test("without a status, the time a new event was first seen counts, not the mtime", async () => {
      h = makeHome();
      h.age(P.claudeWaiting, 0, T); // its fixture pid file reports no status
      const d = clocked();
      expect(await d.at(150_000)).toBe("idle");
      // the desktop app's titles and ledgers carry no conversation
      write({ type: "custom-title", customTitle: "x" }, 182_000);
      write({ type: "artifact-autoreact-ledger", entries: [] }, 183_000);
      expect(await d.at(190_000)).toBe("idle");
      // a real turn does
      write({ type: "user", message: { role: "user", content: "next" } }, 200_000);
      expect(await d.at(201_000)).toBe("thinking");
      write(ASSISTANT_DONE, 210_000);
      expect(await d.at(211_000)).toBe("waiting");
      write(AWAY, 392_000);
      expect(await d.at(400_000)).toBe("idle");
    });

    test("a recent switch to idle, or a hosted process, does not settle it", async () => {
      h = makeHome();
      h.age(P.claudeWaiting, 0, T);
      writeFileSync(
        h.path(".claude/sessions/12346.json"),
        JSON.stringify({ pid: 12346, sessionId: WEBSITE_ID, status: "idle", statusUpdatedAt: T }),
      );
      // the turn ended 30 s ago: waiting at the desk, as for any finished turn
      expect(await clocked().fresh(30_000)).toBe("waiting");
      // a hosted helper still runs: the host stays at its desk (a finished turn: waiting)
      const hosted = await new Detector({
        dirs: agentDirs({}, h.home),
        clientId: "c_test",
        shareProjectNames: true,
        processes: fakeProcesses([
          { pid: 12346, agent: "claude" },
          { pid: 40000, agent: "pi", hostPid: 12346 },
        ]),
        now: () => T + 190_000,
      }).poll();
      expect(byProject(hosted).website).toMatchObject({ activity: "waiting", subagents: 1 });
    });
  });

  test("the status never leaves the machine", async () => {
    h = makeHome();
    pidFile(12346, WEBSITE_ID, "busy");
    const json = JSON.stringify(await detector({ assume: true }).poll());
    expect(json).not.toContain("busy");
    expect(json).not.toContain("1793177500000");
  });
});

describe("activity mapping", () => {
  test("tools", () => {
    for (const t of [
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
      "apply_patch",
      "edit",
      "write",
    ]) {
      expect(toolActivity(t)).toBe("typing");
    }
    for (const t of [
      "Read",
      "Grep",
      "Glob",
      "LS",
      "WebFetch",
      "WebSearch",
      "read",
      "grep",
      "find",
    ]) {
      expect(toolActivity(t)).toBe("reading");
    }
    for (const t of ["Bash", "shell", "exec", "bash", "exec_command"]) {
      expect(toolActivity(t)).toBe("running");
    }
    for (const t of ["Task", "TodoWrite", "mcp__github__get_me", "whatever"]) {
      expect(toolActivity(t)).toBe("thinking");
    }
    for (const t of [
      "AskUserQuestion",
      "request_user_input",
      "purrness_ask_question",
      "mcp__custom-tools__purrness_ask_question",
    ]) {
      expect(toolActivity(t)).toBe("waiting");
    }
    for (const t of [
      "ask_questions_later",
      "task",
      "ask_question",
      "mcp__deepwiki__ask_question",
    ]) {
      expect(toolActivity(t)).toBe("thinking");
    }
  });

  test("events + time", () => {
    const now = 1_000_000;
    expect(deriveActivity([{ kind: "user" }], now - 1000, now)).toBe("thinking");
    expect(deriveActivity([{ kind: "toolResult" }], now - 1000, now)).toBe("thinking");
    expect(deriveActivity([{ kind: "assistant", final: false }], now - 1000, now)).toBe("thinking");
    expect(
      deriveActivity([{ kind: "assistant", final: false }], now - TEXT_SETTLE_MS - 1, now),
    ).toBe("waiting");
    expect(deriveActivity([{ kind: "assistant", final: true }], now - 1000, now)).toBe("waiting");
    expect(deriveActivity([{ kind: "turnEnd" }, null], now - 1000, now)).toBe("waiting");
    expect(deriveActivity([{ kind: "tool", name: "Edit" }], now - 120_000, now)).toBe("idle");
    expect(deriveActivity([], now, now)).toBe("waiting");
  });

  test("questions to the human are waiting", () => {
    for (const t of ["AskUserQuestion", "ExitPlanMode", "request_user_input"]) {
      expect(toolActivity(t)).toBe("waiting");
    }
    const now = 10_000_000;
    expect(deriveActivity([{ kind: "tool", name: "AskUserQuestion" }], now - 1000, now)).toBe(
      "waiting",
    );
  });

  test("holds: busy status, pending tool fallback, cap", () => {
    const now = 100_000_000;
    const quiet = now - 10 * 60_000; // well past IDLE_AFTER_MS, inside the hold
    const stale = now - BUSY_HOLD_MS - 1;
    let walked = 0;
    const hold = (busy: boolean | undefined, lastWrite?: number): ActivityHold => ({
      busy,
      lastWriteMs: () => {
        walked++;
        return lastWrite ?? 0;
      },
    });
    const done = { kind: "assistant", final: true } as const;
    const bash = { kind: "tool", name: "Bash" } as const;
    const ask = { kind: "tool", name: "AskUserQuestion" } as const;

    // busy: last event decides, age ignored; not-a-tool -> thinking
    expect(deriveActivity([bash], quiet, now, hold(true))).toBe("running");
    expect(deriveActivity([done], quiet, now, hold(true))).toBe("thinking");
    expect(deriveActivity([{ kind: "turnEnd" }], now - 1000, now, hold(true))).toBe("thinking");
    expect(deriveActivity([{ kind: "user" }], quiet, now, hold(true))).toBe("thinking");
    expect(deriveActivity([], quiet, now, hold(true))).toBe("thinking");
    // a pending question is never held
    expect(deriveActivity([ask], quiet, now, hold(true))).toBe("idle");
    expect(deriveActivity([ask], quiet, now, hold(undefined))).toBe("idle");
    // no status: only a pending tool holds
    expect(deriveActivity([bash], quiet, now, hold(undefined))).toBe("running");
    expect(deriveActivity([{ kind: "toolResult" }], quiet, now, hold(undefined))).toBe("idle");
    expect(deriveActivity([done], quiet, now, hold(undefined))).toBe("idle");
    // a reported non-busy status: the old rules
    expect(deriveActivity([bash], quiet, now, hold(false))).toBe("idle");
    expect(deriveActivity([bash], now - 1000, now, hold(false))).toBe("running");
    expect(deriveActivity([done], now - 1000, now, hold(false))).toBe("waiting");
    // subagent folders are only walked once the transcript alone is past the cap
    expect(walked).toBe(0);
    // cap: transcript and subagents silent too long -> idle; a recent subagent write extends it
    expect(deriveActivity([bash], stale, now, hold(true))).toBe("idle");
    expect(deriveActivity([bash], stale, now, hold(undefined))).toBe("idle");
    expect(deriveActivity([done], stale, now, hold(true, now - 60_000))).toBe("thinking");
    expect(deriveActivity([bash], stale, now, hold(undefined, now - 60_000))).toBe("running");
    expect(walked).toBe(4);
  });

  test("no status: the pending-tool hold is shorter, and never for a call asking approval", () => {
    const now = 100_000_000;
    const hold: ActivityHold = { lastWriteMs: () => 0 };
    const bash = { kind: "tool", name: "exec_command" } as const;
    const asks = { kind: "tool", name: "exec_command", approval: true } as const;
    expect(deriveActivity([bash], now - PENDING_TOOL_HOLD_MS + 1000, now, hold)).toBe("running");
    expect(deriveActivity([bash], now - PENDING_TOOL_HOLD_MS - 1, now, hold)).toBe("idle");
    // a busy status keeps the long hold
    expect(
      deriveActivity([bash], now - PENDING_TOOL_HOLD_MS - 1, now, { ...hold, busy: true }),
    ).toBe("running");
    // it may sit at an approval prompt: running while fresh, then idle like before the hold
    expect(deriveActivity([asks], now - 1000, now, hold)).toBe("running");
    expect(deriveActivity([asks], now - IDLE_AFTER_MS, now, hold)).toBe("idle");
  });

  test("a settled idle status outranks fresh writes after a finished turn", () => {
    const now = 100_000_000;
    const settled = { lastWriteMs: () => 0, busy: false, idleSinceMs: now - IDLE_AFTER_MS };
    const done = { kind: "assistant", final: true } as const;
    expect(deriveActivity([done], now - 1000, now, settled)).toBe("idle");
    expect(deriveActivity([{ kind: "turnEnd" }], now - 1000, now, settled)).toBe("idle");
    // just switched: the usual waiting
    expect(deriveActivity([done], now - 1000, now, { ...settled, idleSinceMs: now - 1000 })).toBe(
      "waiting",
    );
    // a new prompt or anything mid-turn is not "finished": the status may lag behind it
    expect(deriveActivity([done, { kind: "user" }], now - 1000, now, settled)).toBe("thinking");
    expect(deriveActivity([{ kind: "tool", name: "Bash" }], now - 1000, now, settled)).toBe(
      "running",
    );
  });

  test("Codex: a command asking for escalated permissions is marked as asking for approval", () => {
    const call = (payload: object) => normalizeCodex({ type: "response_item", payload });
    expect(
      call({
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "pnpm test", sandbox_permissions: "require_escalated" }),
      }),
    ).toEqual({ kind: "tool", name: "exec_command", approval: true });
    expect(
      call({
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["ls"], with_escalated_permissions: true }),
      }),
    ).toEqual({ kind: "tool", name: "shell", approval: true });
    // the `exec` tool's JS: an object literal, not JSON
    expect(
      call({
        type: "custom_tool_call",
        name: "exec",
        input:
          'text(await tools.exec_command({cmd:"pnpm test",sandbox_permissions:"require_escalated"}))',
      }),
    ).toEqual({ kind: "tool", name: "exec", approval: true });
    // sandboxed, or merely mentioning the words
    expect(
      call({
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "grep -r require_escalated .",
          sandbox_permissions: "use_default",
        }),
      }),
    ).toEqual({ kind: "tool", name: "exec_command" });
    expect(
      call({
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["ls"], with_escalated_permissions: false }),
      }),
    ).toEqual({ kind: "tool", name: "shell" });
  });

  test("normalizers", () => {
    expect(normalizeClaude({ type: "summary" })).toBeNull();
    expect(
      normalizeClaude({
        type: "user",
        message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
      }),
    ).toEqual({ kind: "turnEnd" });
    expect(normalizeClaude({ type: "assistant", isSidechain: true, message: {} })).toBeNull();
    expect(normalizeCodex({ type: "event_msg", payload: { type: "task_complete" } })).toEqual({
      kind: "turnEnd",
    });
    expect(
      normalizeCodex({
        type: "response_item",
        payload: { type: "custom_tool_call", name: "apply_patch" },
      }),
    ).toEqual({ kind: "tool", name: "apply_patch" });
    expect(
      normalizePi({
        type: "message",
        message: { role: "assistant", content: [], stopReason: "stop" },
      }),
    ).toEqual({ kind: "assistant", final: true });
    expect(normalizePi({ type: "model_change" })).toBeNull();
  });
});

describe("helpers", () => {
  test("tail parsing skips bad lines; head reads the first lines", () => {
    expect(parseJsonl('{"a":1}\nnot json\n[1]\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
    h = makeHome();
    const t = new TailReader();
    const entries = t.read(h.path(P.claudeWaiting));
    expect(entries.length).toBe(5); // 6 lines, one invalid
    expect(t.read("/nonexistent/file.jsonl")).toEqual([]);
    expect(readHead(h.path(P.codex), 1)[0]?.type).toBe("session_meta");
  });

  test("latest subagent write: newest agent-*.jsonl up to 3 levels deep, 0 if none", () => {
    h = makeHome();
    const now = Date.now();
    h.age(P.sub1, 7 * 60_000, now);
    h.age(P.sub2, 3 * 60_000, now);
    const dir = h.path(P.sub1.slice(0, -"/agent-abc.jsonl".length));
    expect(Math.round(latestSubagentWrite(dir))).toBe(Math.round(now - 3 * 60_000));
    expect(latestSubagentWrite(h.path("nope"))).toBe(0);
  });

  test("tail only reads the last 32 KB of big files", () => {
    h = makeHome();
    const big = join(h.home, "big.jsonl");
    const filler = `${JSON.stringify({ type: "user", pad: "x".repeat(1000) })}\n`;
    writeFileSync(big, filler.repeat(200)); // ~200 KB
    appendFileSync(big, `${JSON.stringify({ type: "last" })}\n`);
    const entries = new TailReader().read(big);
    expect(entries.length).toBeLessThan(40);
    expect(entries.at(-1)).toEqual({ type: "last" });
  });

  test("folder encodings + project names", () => {
    expect(encodeClaudeCwd("/Users/anna/code/agent-office")).toBe("-Users-anna-code-agent-office");
    expect(encodeClaudeCwd("/Users/a/my.app")).toBe("-Users-a-my-app");
    expect(encodePiCwd("/Users/anna/code/pi-proj")).toBe("--Users-anna-code-pi-proj--");
    const dirs = new Set(["/Users", "/Users/anna", "/Users/anna/code"]);
    expect(decodeClaudeFolder("-Users-anna-code-agent-office", (p) => dirs.has(p))).toBe(
      "/Users/anna/code/agent-office",
    );
    expect(projectName("/Users/anna/code/agent-office/")).toBe("agent-office");
    expect(projectName(undefined)).toBeUndefined();
  });

  test("env vars: CLAUDE_CONFIG_DIR etc., AGENT_OFFICE_HOME wins", () => {
    const env = {
      HOME: "/home/u",
      CLAUDE_CONFIG_DIR: "/cfg/claude",
      CODEX_HOME: "/cfg/codex",
      PI_CODING_AGENT_DIR: "/cfg/pi",
    };
    expect(agentDirs(env)).toEqual({
      claude: "/cfg/claude",
      codex: "/cfg/codex",
      pi: "/cfg/pi",
      claudeDesktop: "/home/u/Library/Application Support/Claude",
    });
    expect(agentDirs({ HOME: "/home/u" })).toEqual({
      claude: "/home/u/.claude",
      codex: "/home/u/.codex",
      pi: "/home/u/.pi/agent",
      claudeDesktop: "/home/u/Library/Application Support/Claude",
    });
    expect(agentDirs(env, "/fy").claudeDesktop).toBe("/fy/Library/Application Support/Claude");
    expect(agentDirs({ ...env, AGENT_OFFICE_HOME: "/fx" }).claude).toBe("/fx/.claude");
    expect(agentDirs(env, "/fy").pi).toBe("/fy/.pi/agent");
  });

  test("process classification", () => {
    expect(classifyArgv(["claude"])).toBe("claude");
    expect(classifyArgv(["/Users/a/.local/bin/claude", "--resume"])).toBe("claude");
    expect(classifyArgv(["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"])).toBe(
      "claude",
    );
    expect(classifyArgv(["node", "/opt/homebrew/bin/codex"])).toBe("codex");
    expect(classifyArgv(["/x/codex-aarch64-apple-darwin", "exec"])).toBe("codex");
    expect(classifyArgv(["node", "--no-warnings", "/x/bin/pi"])).toBe("pi");
    expect(classifyArgv(["/Applications/Claude.app/Contents/MacOS/Claude"])).toBeNull();
    expect(classifyArgv(["vim", "claude.md"])).toBeNull();
    expect(classifyArgv([])).toBeNull();
    // the native Claude CLI's file name (ucomm) is its version: argv0 `claude` names it
    expect(
      parsePs(
        psOut(
          [123, 1, "claude --resume", "2.1.322"],
          [456, 1, "/bin/zsh"],
          [789, 456, "node /x/bin/pi"],
        ),
      ),
    ).toEqual([
      { pid: 123, agent: "claude" },
      { pid: 789, agent: "pi" },
    ]);
    // Pi's Claude bridge: pi -> (sh) -> Agent SDK claude binary
    const sdk = "/x/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
    expect(
      parsePs(
        psOut(
          [10, 1, "/bin/zsh"],
          [20, 10, "pi"],
          [25, 20, "/bin/sh -c x"],
          [30, 25, `${sdk} --output-format stream-json`],
        ),
      ),
    ).toEqual([
      { pid: 20, agent: "pi" },
      { pid: 30, agent: "claude", hostPid: 20, backend: true },
    ]);
    // a purrness worker is a hosted pi, not a backend; native claude is never a backend
    expect(
      parsePs(
        psOut(
          [20, 1, "pi"],
          [40, 20, "pi --mode json --print"],
          [50, 1, "/Users/a/.local/bin/claude", "2.1.322"],
        ),
      ),
    ).toEqual([
      { pid: 20, agent: "pi" },
      { pid: 40, agent: "pi", hostPid: 20 },
      { pid: 50, agent: "claude" },
    ]);
    // npm Codex: `node …/bin/codex` and its vendored native binary are one agent, not a host
    // + hosted helper; an agent below the native binary is hosted by the launcher
    const vendored = "/x/@openai/codex/vendor/aarch64-apple-darwin/codex/codex";
    expect(
      parsePs(
        psOut(
          [60, 1, "node /opt/homebrew/bin/codex"],
          [61, 60, `${vendored} --sandbox`],
          [62, 61, "/bin/zsh -c x"],
          [63, 62, "claude -p hi"],
        ),
      ),
    ).toEqual([
      { pid: 60, agent: "codex" },
      { pid: 63, agent: "claude", hostPid: 60 },
    ]);
    // a JS-run pi worker under a JS-run pi (Linux argv) is still a hosted helper
    expect(
      parsePs(psOut([70, 1, "node /x/bin/pi"], [71, 70, "node /x/bin/pi --mode json"])),
    ).toEqual([
      { pid: 70, agent: "pi" },
      { pid: 71, agent: "pi", hostPid: 70 },
    ]);
    // parent cycles and missing parents never hang
    expect(
      agentProcesses([
        { pid: 1, ppid: 2, agent: null },
        { pid: 2, ppid: 1, agent: null },
        { pid: 3, ppid: 1, agent: "claude" },
        { pid: 4, ppid: 99, agent: "codex" },
      ]),
    ).toEqual([
      { pid: 3, agent: "claude" },
      { pid: 4, agent: "codex" },
    ]);
    expect(parseStatPpid("4242 (my (odd) proc) S 17 4242 4242 0 -1")).toBe(17);
    expect(parseLsof("p123\nfcwd\nn/Users/a/x\np456\nfcwd\nn/tmp\n")).toEqual(
      new Map([
        [123, "/Users/a/x"],
        [456, "/tmp"],
      ]),
    );
  });
});

// Shapes copied from `ps -axo pid=,ppid=,ucomm=,args=` on a Mac running the Claude and Codex apps.
const DESKTOP_CLAUDE =
  "/Users/a/Library/Application Support/Claude/claude-code/2.1.321/ddbdf2b334e1/claude.app/Contents/MacOS/claude";
const DESKTOP_FLAGS = "--output-format stream-json --verbose --input-format stream-json";
const CODEX_DAEMON =
  "/Users/a/.codex/packages/app-server-daemon/releases/0.167.2-aarch64-apple-darwin/bin/codex";
const MAC_PS = psOut(
  [58935, 1, "/Applications/Claude.app/Contents/MacOS/Claude", "Claude"],
  [
    39917,
    58935,
    "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer --user-data-dir=/Users/a/Library/Application Support/Claude",
    "Claude Helper (Renderer)",
  ],
  [
    12344,
    58935,
    `/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- ${DESKTOP_CLAUDE} ${DESKTOP_FLAGS} --resume=7a735e29`,
  ],
  [12345, 12344, `${DESKTOP_CLAUDE} ${DESKTOP_FLAGS} --resume=7a735e29`, "claude"],
  [94331, 1, `${CODEX_DAEMON} app-server daemon pid-update-loop`],
  [
    36879,
    94331,
    `${CODEX_DAEMON} app-server --listen unix:// --analytics-default-enabled -c features.code_mode_host=true --managed-daemon`,
  ],
  [
    68150,
    1895,
    "/Users/a/.codex/plugins/cache/openai-bundled/chrome/latest/extension-host/macos/arm64/ChatGPT for Chrome chrome-extension://x/",
    "ChatGPT for Chrome",
  ],
  [50833, 50125, "claude", "2.1.319"],
);

describe("macOS app processes", () => {
  test("Claude Code run by the Claude desktop app is an agent; its disclaimer wrapper is not", () => {
    const procs = parsePs(MAC_PS);
    expect(procs.filter((p) => p.agent === "claude")).toEqual([
      { pid: 12345, agent: "claude" },
      { pid: 50833, agent: "claude" },
    ]);
    // whitespace-split argv alone cannot tell (argv0 = `…/Library/Application`)
    expect(classifyArgv(`${DESKTOP_CLAUDE} ${DESKTOP_FLAGS}`.split(" "))).toBeNull();
    // ucomm holds spaces and is cut at 16 chars: split by width, not by whitespace
    expect(psLines(MAC_PS).find((l) => l.pid === 39917)?.exe).toBe("Claude Helper (R");
    expect(psLines(MAC_PS).find((l) => l.pid === 12344)?.exe).toBe("disclaimer");
    expect(claudeDesktopInPs(MAC_PS)).toBe(true);
    // a line without args, and junk, never throw
    expect(parsePs("  123     1 claude          \nnot ps\n\n")).toEqual([
      { pid: 123, agent: "claude" },
    ]);
  });

  test("the desktop app's session stays live through its pid file", async () => {
    h = makeHome();
    h.age(P.claudeActive, 100_000); // past the 90 s window
    const d = new Detector({
      dirs: agentDirs({}, h.home),
      clientId: "c_test",
      shareProjectNames: true,
      processes: fakeProcesses(parsePs(MAC_PS)),
    });
    expect(byProject(await d.poll())["agent-office"]).toMatchObject({ agent: "claude" });
  });

  test("Claude Code's own rg/ugrep/bfs (its binary under another argv0) are not agents", () => {
    // `ARGV0=ugrep "$_cc_bin" …` in Claude Code's shell snapshot, and the Grep tool's embedded
    // ripgrep: ucomm is the binary's name (`claude`), argv0 the tool's
    const procs = parsePs(
      psOut(
        [12345, 12344, `${DESKTOP_CLAUDE} ${DESKTOP_FLAGS}`, "claude"],
        [40000, 12345, "/bin/zsh -c -l source snapshot.sh && grep -r foo .", "zsh"],
        [40001, 40000, "ugrep -G --hidden -r foo .", "claude"],
        [40002, 12345, "rg --no-config --files /Users/a/code", "claude"],
        [40003, 40000, "bfs -S dfs /Users/a/code -name claude", "claude"],
        [40004, 40000, "rg foo /Users/a/.local/bin/claude", "claude"],
      ),
    );
    expect(procs).toEqual([{ pid: 12345, agent: "claude" }]);
    // the CLI started by name or path, or with an unreadable args line, still counts
    expect(procRow(1, 0, ["claude", "--resume", "x"], "claude").agent).toBe("claude");
    expect(procRow(1, 0, ["/opt/homebrew/bin/claude"], "claude").agent).toBe("claude");
    expect(procRow(1, 0, [], "claude").agent).toBe("claude");
    // a ucomm cut at 16 chars matches the full file name
    expect(
      procRow(1, 0, ["/x/codex/codex-aarch64-apple-darwin", "exec"], "codex-aarch64-apple-darwin")
        .agent,
    ).toBe("codex");
    expect(runsAsExe("ugrep -G foo", "claude")).toBe(false);
  });

  test.skipIf(process.platform !== "darwin")(
    "real `ps -axo PS_COLUMNS` parses as psLines expects",
    async () => {
      const p = Bun.spawn(["ps", "-axo", PS_COLUMNS], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      await p.exited;
      const lines = psLines(out);
      // every row parses (none dropped by a column layout psLines does not know) ...
      expect(lines.length).toBe(out.split("\n").filter((l) => l.trim() !== "").length);
      // ... and this test runner is found by its executable's name, its args intact
      const self = lines.find((l) => l.pid === process.pid);
      expect(self?.exe).toBe(basename(process.execPath).slice(0, UCOMM_WIDTH));
      expect(self?.args).toContain(basename(process.execPath));
    },
  );

  test("the Codex app-server daemon is marked; codex subcommand args elsewhere are not", () => {
    expect(parsePs(MAC_PS).filter((p) => p.agent === "codex")).toEqual([
      { pid: 94331, agent: "codex", daemon: true },
      { pid: 36879, agent: "codex", hostPid: 94331, daemon: true },
    ]);
    expect(isCodexAppServer(["node", "/opt/homebrew/bin/codex", "app-server"])).toBe(true);
    expect(isCodexAppServer(["/x/codex-aarch64-apple-darwin", "app-server", "--listen"])).toBe(
      true,
    );
    expect(isCodexAppServer(["codex", "exec", "fix", "the", "app-server"])).toBe(false);
    expect(isCodexAppServer(["/x/bin/app-server"])).toBe(false);
    expect(procRow(1, 0, ["codex", "exec", "app-server"]).daemon).toBeUndefined();
    expect(procRow(1, 0, ["/x/pi", "app-server"]).daemon).toBeUndefined();
    // Linux argv (no ucomm) marks it too
    expect(procRow(1, 0, [CODEX_DAEMON, "app-server", "daemon"])).toMatchObject({
      agent: "codex",
      daemon: true,
    });
  });

  test("a daemon owns no session (cwd or pid file) but fresh transcripts still show", async () => {
    h = makeHome();
    h.age(P.codex, 5 * 60_000);
    const daemon: ProcInfo = { pid: 94331, agent: "codex", daemon: true };
    const cwd = "/Users/anna/code/codex-thing";
    // quiet transcript in the daemon's cwd: no ghost desk
    expect(await detector({ procs: [daemon], cwds: { 94331: cwd } }).poll()).toEqual([]);
    // the same cwd held by a real codex process keeps it (idle) as before
    const real = await detector({
      procs: [{ pid: 777, agent: "codex" }],
      cwds: { 777: cwd },
    }).poll();
    expect(real.map((s) => s.agent)).toEqual(["codex"]);
    // a Codex-app session writing its transcript shows while the daemon runs
    h.age(P.codex, 5_000);
    const fresh = await detector({ procs: [daemon], cwds: { 94331: cwd } }).poll();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ agent: "codex", project: "codex-thing" });
    // a daemon pid named by a pid file does not tie that session
    h.age(P.claudeActive, 100_000);
    const tied = await detector({ procs: [{ pid: 12345, agent: "claude", daemon: true }] }).poll();
    expect(byProject(tied)["agent-office"]).toBeUndefined();
  });

  test("agents hosted below the daemon are nobody's helpers and keep nobody busy", async () => {
    h = makeHome();
    // a finished turn, so only a (wrong) hosted-busy flag could keep it off idle
    appendFileSync(
      h.path(P.codex),
      jsonl({ type: "event_msg", payload: { type: "task_complete" } }),
    );
    h.age(P.codex, 5 * 60_000);
    const cwd = "/Users/anna/code/codex-thing";
    const sessions = await detector({
      procs: [
        { pid: 777, agent: "codex" },
        { pid: 94331, agent: "codex", daemon: true },
        { pid: 36879, agent: "codex", hostPid: 94331, daemon: true },
        { pid: 40000, agent: "codex", hostPid: 36879 },
        { pid: 40001, agent: "claude", hostPid: 94331 },
      ],
      cwds: { 777: cwd, 94331: cwd, 36879: cwd },
    }).poll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ agent: "codex", activity: "idle", subagents: 0 });
  });
});
