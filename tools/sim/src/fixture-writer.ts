/**
 * `--fixture-writer`: instead of fake connectors, write fake Claude / Codex / Pi JSONL
 * transcripts into a temp home (formats as in fixtures/home/README.md) and keep appending,
 * so the REAL connector's detectors see sessions whose activity changes over time.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { seededRandom } from "@agent-office/protocol";
import { hex, intBetween } from "./data.ts";

export type FixtureWriterOptions = {
  seed?: number;
  /** time multiplier: base tick is every 3 s */
  speed?: number;
  /** existing directory to write into (default: a fresh temp dir) */
  home?: string;
  log?: (line: string) => void;
};

type Agent = "claude" | "codex" | "pi";
type Tool = { claude: string; codex: string; pi: string };
const TOOLS: Tool[] = [
  { claude: "Read", codex: "shell", pi: "read" },
  { claude: "Grep", codex: "shell", pi: "bash" },
  { claude: "Edit", codex: "apply_patch", pi: "edit" },
  { claude: "Write", codex: "apply_patch", pi: "write" },
  { claude: "Bash", codex: "shell", pi: "bash" },
  { claude: "Glob", codex: "shell", pi: "read" },
];
const PROMPTS = [
  "Make the login form remember the last email.",
  "Why is the CI job flaky on the diff tests?",
  "Add a dark mode toggle to the settings page.",
  "Refactor the config loader into smaller functions.",
  "Write tests for the snapshot debounce.",
  "Rename the office map layers to something clearer.",
];

type Step =
  | { kind: "prompt" }
  | { kind: "think" }
  | { kind: "tool"; tool: Tool }
  | { kind: "result" }
  | { kind: "end" }
  | { kind: "pause" };

type FakeSession = {
  agent: Agent;
  id: string;
  cwd: string;
  path: string;
  plan: Step[];
  n: number;
  lastToolId: string;
  /** claude only: subagent transcripts currently being written */
  subagents: { path: string; ticksLeft: number }[];
};

const iso = (ms: number) => new Date(ms).toISOString();

function uuid(rand: () => number): string {
  const h = hex(rand, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}

function turn(rand: () => number): Step[] {
  const steps: Step[] = [{ kind: "prompt" }, { kind: "think" }];
  for (let i = intBetween(rand, 2, 5); i > 0; i--) {
    steps.push({ kind: "tool", tool: TOOLS[Math.floor(rand() * TOOLS.length)]! });
    steps.push({ kind: "result" });
  }
  steps.push({ kind: "end" });
  for (let i = intBetween(rand, 1, 3); i > 0; i--) steps.push({ kind: "pause" });
  return steps;
}

const append = (path: string, obj: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(obj)}\n`);
};

function claudeLine(s: FakeSession, step: Step, rand: () => number, now: number, extra = {}) {
  const base = {
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: s.cwd,
    sessionId: s.id,
    version: "2.0.31",
    gitBranch: "main",
    uuid: uuid(rand),
    timestamp: iso(now),
    ...extra,
  };
  const assistant = (content: unknown[], stop: string | null) => ({
    ...base,
    type: "assistant",
    requestId: `req_${hex(rand, 12)}`,
    message: {
      id: `msg_${hex(rand, 12)}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-4-5-20251101",
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 12, cache_read_input_tokens: 18000, output_tokens: 240 },
    },
  });
  switch (step.kind) {
    case "prompt":
      return {
        ...base,
        type: "user",
        message: { role: "user", content: PROMPTS[Math.floor(rand() * PROMPTS.length)] },
      };
    case "think":
      return assistant(
        [{ type: "thinking", thinking: "Let me look around.", signature: "sig" }],
        null,
      );
    case "tool":
      s.lastToolId = `toolu_${hex(rand, 16)}`;
      return assistant(
        [
          {
            type: "tool_use",
            id: s.lastToolId,
            name: step.tool.claude,
            input: { file_path: `${s.cwd}/src/index.ts` },
          },
        ],
        "tool_use",
      );
    case "result":
      return {
        ...base,
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: s.lastToolId, content: "ok" }],
        },
      };
    case "end":
      return assistant([{ type: "text", text: "Done. Anything else?" }], "end_turn");
    case "pause":
      return null;
  }
}

function codexLine(s: FakeSession, step: Step, rand: () => number, now: number) {
  const item = (payload: unknown) => ({ timestamp: iso(now), type: "response_item", payload });
  switch (step.kind) {
    case "prompt":
      return item({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: PROMPTS[0] }],
      });
    case "think":
      return item({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Plan" }],
        encrypted_content: "gAAAA",
      });
    case "tool":
      s.lastToolId = `call_${hex(rand, 8)}`;
      return step.tool.codex === "apply_patch"
        ? item({
            type: "custom_tool_call",
            status: "completed",
            call_id: s.lastToolId,
            name: "apply_patch",
            input: "*** Begin Patch\n*** End Patch",
          })
        : item({
            type: "function_call",
            name: "shell",
            arguments: JSON.stringify({ command: ["bash", "-lc", "rg --files"] }),
            call_id: s.lastToolId,
          });
    case "result":
      return item({
        type: "function_call_output",
        call_id: s.lastToolId,
        output: '{"output":"ok"}',
      });
    case "end":
      return {
        timestamp: iso(now),
        type: "event_msg",
        payload: { type: "task_complete", last_agent_message: "Done." },
      };
    case "pause":
      return null;
  }
}

function piLine(s: FakeSession, step: Step, rand: () => number, now: number) {
  const msg = (message: Record<string, unknown>) => ({
    type: "message",
    id: hex(rand, 8),
    parentId: null,
    timestamp: iso(now),
    message: { ...message, timestamp: now },
  });
  switch (step.kind) {
    case "prompt":
      return msg({ role: "user", content: [{ type: "text", text: PROMPTS[1] }] });
    case "think":
      return msg({ role: "assistant", content: [{ type: "thinking", thinking: "Hmm." }] });
    case "tool":
      s.lastToolId = `tc_${hex(rand, 6)}`;
      return msg({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: s.lastToolId,
            name: step.tool.pi,
            arguments: { path: "src/index.ts" },
          },
        ],
        stopReason: "toolUse",
      });
    case "result":
      return msg({
        role: "toolResult",
        toolCallId: s.lastToolId,
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      });
    case "end":
      return msg({
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
      });
    case "pause":
      return null;
  }
}

export type FixtureWriter = {
  home: string;
  /** advance the fake agents by one tick (done automatically on a timer) */
  tick(): void;
  stop(): void;
};

export function startFixtureWriter(opts: FixtureWriterOptions = {}): FixtureWriter {
  const rand = seededRandom(`fixtures:${opts.seed ?? 42}`);
  const log = opts.log ?? ((l: string) => console.log(l));
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "agent-office-home-"));
  const now = () => Date.now();
  const t0 = now();
  const sessions: FakeSession[] = [];

  const make = (agent: Agent, project: string, pid: number) => {
    const id = uuid(rand);
    const cwd = `/Users/sim/code/${project}`;
    let path: string;
    if (agent === "claude") {
      path = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
      mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
      writeFileSync(
        join(home, ".claude", "sessions", `${pid}.json`),
        JSON.stringify({ pid, sessionId: id, cwd, startedAt: t0 }, null, 2),
      );
      append(path, {
        type: "file-history-snapshot",
        messageId: uuid(rand),
        snapshot: { trackedFileBackups: {} },
        isSnapshotUpdate: false,
      });
    } else if (agent === "codex") {
      const d = new Date(t0);
      const ymd = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()].map((x) =>
        String(x).padStart(2, "0"),
      );
      const stamp = iso(t0).replace(/:/g, "-").slice(0, 19);
      path = join(home, ".codex", "sessions", ...ymd, `rollout-${stamp}-${id}.jsonl`);
      append(path, {
        timestamp: iso(t0),
        type: "session_meta",
        payload: {
          id,
          timestamp: iso(t0),
          cwd,
          originator: "codex_cli_rs",
          cli_version: "0.58.0",
          instructions: null,
          git: { branch: "main" },
        },
      });
    } else {
      const folder = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
      path = join(
        home,
        ".pi",
        "agent",
        "sessions",
        folder,
        `${iso(t0).replace(/:/g, "-").replace(".", "-")}_${id}.jsonl`,
      );
      append(path, { type: "session", version: 3, id, timestamp: iso(t0), cwd });
      append(path, {
        type: "model_change",
        id: "m0",
        parentId: null,
        timestamp: iso(t0),
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });
    }
    const s: FakeSession = {
      agent,
      id,
      cwd,
      path,
      plan: turn(rand),
      n: 0,
      lastToolId: "",
      subagents: [],
    };
    sessions.push(s);
    log(`fixture   ${agent.padEnd(7)} ${project.padEnd(15)} ${path.slice(home.length + 1)}`);
  };

  make("claude", "agent-office", 41001);
  make("claude", "website", 41002);
  make("codex", "codex-thing", 41003);
  make("pi", "pi-proj", 41004);

  const advance = (s: FakeSession) => {
    if (s.n >= s.plan.length) {
      s.plan = turn(rand);
      s.n = 0;
    }
    const step = s.plan[s.n++]!;
    const line =
      s.agent === "claude"
        ? claudeLine(s, step, rand, now())
        : s.agent === "codex"
          ? codexLine(s, step, rand, now())
          : piLine(s, step, rand, now());
    if (line) append(s.path, line);
    return step;
  };

  // write the first few lines so every session already has an activity
  for (const s of sessions) for (let i = intBetween(rand, 2, 4); i > 0; i--) advance(s);

  const tick = () => {
    const s = sessions[Math.floor(rand() * sessions.length)]!;
    const step = advance(s);
    const label =
      step.kind === "tool"
        ? `tool ${s.agent === "claude" ? step.tool.claude : s.agent === "codex" ? step.tool.codex : step.tool.pi}`
        : step.kind;
    log(`fixture   ${s.agent.padEnd(7)} ${s.cwd.split("/").pop()!.padEnd(15)} ${label}`);
    // Claude subagent bursts: agent-*.jsonl files stay "live" while written (60 s window)
    const claude = sessions.find((x) => x.agent === "claude")!;
    for (const sub of claude.subagents) {
      if (sub.ticksLeft-- > 0)
        append(sub.path, claudeLine(claude, { kind: "think" }, rand, now(), { isSidechain: true }));
    }
    claude.subagents = claude.subagents.filter((x) => x.ticksLeft > 0);
    if (claude.subagents.length === 0 && rand() < 0.15) {
      const k = intBetween(rand, 1, 4);
      const dir = join(claude.path.slice(0, -".jsonl".length), "subagents");
      for (let i = 0; i < k; i++) {
        const sub =
          rand() < 0.3
            ? join(dir, "workflows", `wf${hex(rand, 4)}`, `agent-${hex(rand, 6)}.jsonl`)
            : join(dir, `agent-${hex(rand, 6)}.jsonl`);
        append(sub, claudeLine(claude, { kind: "prompt" }, rand, now(), { isSidechain: true }));
        claude.subagents.push({ path: sub, ticksLeft: intBetween(rand, 3, 10) });
      }
      log(`fixture   claude  ${claude.cwd.split("/").pop()!.padEnd(15)} ${k} subagent(s) started`);
    }
  };

  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const timer = setInterval(tick, Math.max(100, 3_000 / speed));
  return {
    home,
    tick,
    stop: () => clearInterval(timer),
  };
}

/** Repo root (tools/sim/src -> ../../..). */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
export const CONNECTOR_MAIN = join(REPO_ROOT, "apps", "connector", "src", "main.ts");

export function connectorCommand(
  home: string,
  server: string,
  password: string,
  name: string,
): string[] {
  return [
    "bun",
    "run",
    "apps/connector/src/main.ts",
    "run",
    "--home",
    home,
    "--assume-processes",
    "--server",
    server,
    "--password",
    password,
    "--name",
    name,
  ];
}

/** Spawn the real connector against the temp home (isolated config dir, no self-update). */
export function spawnConnector(
  home: string,
  server: string,
  password: string,
  name: string,
  log: (l: string) => void,
): ChildProcess | null {
  if (!existsSync(CONNECTOR_MAIN)) {
    log(`connector not found at ${CONNECTOR_MAIN}; run the command above yourself`);
    return null;
  }
  const [, ...args] = connectorCommand(home, server, password, name);
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AGENT_OFFICE_CONFIG_DIR: join(home, ".config", "agent-office"),
      AGENT_OFFICE_NO_UPDATE: "1",
      AGENT_OFFICE_CLIENT_ID: `sim-fixture-${hex(Math.random, 8)}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pipe = (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) if (line.trim()) log(`connector ${line}`);
  };
  child.stdout?.on("data", pipe);
  child.stderr?.on("data", pipe);
  child.on("exit", (code) => log(`connector exited with ${code}`));
  return child;
}
