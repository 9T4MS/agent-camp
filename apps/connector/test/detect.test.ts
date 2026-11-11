import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo } from "@agent-office/protocol";
import { deriveActivity, TEXT_SETTLE_MS, toolActivity } from "../src/detect/activity.ts";
import { decodeClaudeFolder, encodeClaudeCwd, normalizeClaude } from "../src/detect/claude.ts";
import { normalizeCodex } from "../src/detect/codex.ts";
import { Detector, projectName, sessionKeyFor } from "../src/detect/index.ts";
import { encodePiCwd, normalizePi } from "../src/detect/pi.ts";
import { parseJsonl, readHead, TailReader } from "../src/detect/tail.ts";
import { agentDirs } from "../src/paths.ts";
import {
  agentProcesses,
  classifyArgv,
  fakeProcesses,
  type ProcInfo,
  parseLsof,
  parsePs,
  parseStatPpid,
} from "../src/proc.ts";
import { type FakeHome, makeHome, P, RAW_IDS } from "./helpers.ts";

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
    h.age(P.codex, 5 * 60_000);
    h.age(P.pi, 5 * 60_000);
    const sessions = await detector({
      procs: [
        { pid: 777, agent: "codex" },
        { pid: 778, agent: "pi" },
      ],
      cwds: { 777: "/Users/anna/code/codex-thing", 778: "/Users/anna/code/pi-proj" },
    }).poll();
    const s = byProject(sessions);
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
    // nothing hosted: the quiet transcript is idle again
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
    expect(
      parsePs("  123     1 claude --resume\n 456 1 /bin/zsh\n789 456 node /x/bin/pi\n"),
    ).toEqual([
      { pid: 123, agent: "claude" },
      { pid: 789, agent: "pi" },
    ]);
    // Pi's Claude bridge: pi -> (sh) -> Agent SDK claude binary
    const sdk = "/x/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
    expect(
      parsePs(
        `10 1 /bin/zsh\n20 10 pi\n25 20 /bin/sh -c x\n30 25 ${sdk} --output-format stream-json\n`,
      ),
    ).toEqual([
      { pid: 20, agent: "pi" },
      { pid: 30, agent: "claude", hostPid: 20, backend: true },
    ]);
    // a purrness worker is a hosted pi, not a backend; native claude is never a backend
    expect(
      parsePs("20 1 pi\n40 20 pi --mode json --print\n50 1 /Users/a/.local/bin/claude\n"),
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
        `60 1 node /opt/homebrew/bin/codex\n61 60 ${vendored} --sandbox\n62 61 /bin/zsh -c x\n63 62 claude -p hi\n`,
      ),
    ).toEqual([
      { pid: 60, agent: "codex" },
      { pid: 63, agent: "claude", hostPid: 60 },
    ]);
    // a JS-run pi worker under a JS-run pi (Linux argv) is still a hosted helper
    expect(parsePs("70 1 node /x/bin/pi\n71 70 node /x/bin/pi --mode json\n")).toEqual([
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
