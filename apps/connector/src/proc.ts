/**
 * Process liveness, cheap and dependency-free.
 *   macOS: `ps -axo pid=,ppid=,args=` (+ `lsof -a -d cwd -p <pids> -Fn` for agent pids only, cached)
 *   Linux: /proc/<pid>/cmdline, /proc/<pid>/stat (ppid) and /proc/<pid>/cwd
 * We look at argv rather than `comm` because Claude Code / Pi often run as `node .../cli.js`
 * and the native Claude binary's file name is its version number.
 *
 * Parent pids let us spot an agent running *inside* another agent, e.g. Pi's Claude bridge
 * (pi-claude-bridge) spawning the Claude Agent SDK's `claude` binary as its model backend.
 * Such a process gets `hostPid`; the detector folds its session into the host's and counts
 * hosted agents (e.g. purrness subagent workers) as the host's helpers, except model backends.
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";
import type { AgentKind } from "@agent-office/protocol";

export type ProcInfo = {
  pid: number;
  agent: AgentKind;
  /** pid of the nearest ancestor that is itself a coding agent (this one runs inside it) */
  hostPid?: number;
  /** the Claude Agent SDK binary: a model backend of its host, not a helper */
  backend?: boolean;
};

/** Any process: its parent pid and, if it is a coding agent, which one. */
export type ProcRow = {
  pid: number;
  ppid: number;
  agent: AgentKind | null;
  backend?: boolean;
  /** argv0 is a JS runtime (`node …/bin/codex`), not the agent's native binary */
  launcher?: boolean;
};

/** The Claude Agent SDK's bundled `claude` (`@anthropic-ai/claude-agent-sdk-<platform>/claude`). */
export function isAgentSdkBackend(argv: readonly string[]): boolean {
  return argv.some((a) => a.includes("claude-agent-sdk"));
}

function row(pid: number, ppid: number, argv: readonly string[]): ProcRow {
  const agent = classifyArgv(argv);
  const r: ProcRow = { pid, ppid, agent };
  if (agent === "claude" && isAgentSdkBackend(argv)) r.backend = true;
  if (agent && RUNTIMES.has(basename(argv[0] ?? ""))) r.launcher = true;
  return r;
}

export interface ProcessSource {
  /** All running coding-agent processes. */
  list(): Promise<ProcInfo[]>;
  /** Working directories of the given pids (missing entries = unknown). */
  cwds(pids: number[]): Promise<Map<number, string>>;
}

const RUNTIMES = new Set(["node", "bun", "deno", "nodejs"]);

function kindOfName(name: string): AgentKind | null {
  if (name === "claude") return "claude";
  if (name === "codex" || /^codex-(aarch64|x86_64)/.test(name)) return "codex";
  if (name === "pi") return "pi";
  return null;
}

/** Classify a process by its argv. Returns null for anything that isn't a coding agent. */
export function classifyArgv(argv: readonly string[]): AgentKind | null {
  const a0 = argv[0];
  if (!a0) return null;
  const direct = kindOfName(basename(a0));
  if (direct) return direct;
  if (!RUNTIMES.has(basename(a0))) return null;
  // node [flags] <script> ...
  const script = argv.slice(1).find((a) => !a.startsWith("-"));
  if (!script) return null;
  const viaName = kindOfName(basename(script));
  if (viaName) return viaName;
  if (script.includes("@anthropic-ai/claude-code")) return "claude";
  if (script.includes("@openai/codex")) return "codex";
  if (script.includes("pi-coding-agent")) return "pi";
  return null;
}

async function run(cmd: string[]): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  } catch {
    return "";
  }
}

/**
 * Agent processes of a process table, each with the pid of its nearest agent ancestor
 * (`hostPid`) when it runs inside another coding agent.
 *
 * A JS launcher's own native binary is the same agent, not a hosted one: npm-installed Codex
 * runs as `node …/bin/codex` plus a child `…/vendor/…/codex/codex`. Such a child (same kind,
 * native, direct parent a launcher) is left out, and agents below it see the launcher as host.
 */
export function agentProcesses(rows: readonly ProcRow[]): ProcInfo[] {
  const byPid = new Map<number, ProcRow>();
  for (const r of rows) byPid.set(r.pid, r);
  const wrapped = (r: ProcRow) => {
    const parent = byPid.get(r.ppid);
    return !r.launcher && parent?.launcher === true && parent.agent === r.agent;
  };
  const isAgent = (r: ProcRow) => r.agent !== null && !wrapped(r);
  const procs: ProcInfo[] = [];
  for (const r of rows) {
    if (!r.agent || !isAgent(r)) continue;
    const info: ProcInfo = { pid: r.pid, agent: r.agent };
    if (r.backend) info.backend = true;
    const seen = new Set<number>([r.pid]);
    let parent = byPid.get(r.ppid);
    while (parent && !seen.has(parent.pid)) {
      if (isAgent(parent)) {
        info.hostPid = parent.pid;
        break;
      }
      seen.add(parent.pid);
      parent = byPid.get(parent.ppid);
    }
    procs.push(info);
  }
  return procs;
}

/** Parse `ps -axo pid=,ppid=,args=` output. */
export function parsePs(out: string): ProcInfo[] {
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push(row(Number(m[1]), Number(m[2]), m[3]!.trim().split(/\s+/)));
  }
  return agentProcesses(rows);
}

/** Parent pid from `/proc/<pid>/stat` ("pid (comm) state ppid ..."; comm may hold spaces). */
export function parseStatPpid(stat: string): number | undefined {
  const rest = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

/** Parse `lsof -Fn` output ("p123\nfcwd\nn/path"). */
export function parseLsof(out: string): Map<number, string> {
  const map = new Map<number, string>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) map.set(pid, line.slice(1));
  }
  return map;
}

class MacProcesses implements ProcessSource {
  private cwdCache = new Map<number, string>();

  async list(): Promise<ProcInfo[]> {
    return parsePs(await run(["ps", "-axo", "pid=,ppid=,args="]));
  }

  async cwds(pids: number[]): Promise<Map<number, string>> {
    const missing = pids.filter((p) => !this.cwdCache.has(p));
    if (missing.length > 0) {
      const found = parseLsof(
        await run(["lsof", "-a", "-d", "cwd", "-p", missing.join(","), "-Fn"]),
      );
      for (const [pid, cwd] of found) this.cwdCache.set(pid, cwd);
    }
    // forget dead pids
    for (const pid of this.cwdCache.keys()) if (!pids.includes(pid)) this.cwdCache.delete(pid);
    const out = new Map<number, string>();
    for (const pid of pids) {
      const c = this.cwdCache.get(pid);
      if (c) out.set(pid, c);
    }
    return out;
  }
}

class LinuxProcesses implements ProcessSource {
  async list(): Promise<ProcInfo[]> {
    const rows: ProcRow[] = [];
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return [];
    }
    for (const e of entries) {
      if (!/^\d+$/.test(e)) continue;
      try {
        const ppid = parseStatPpid(readFileSync(`/proc/${e}/stat`, "utf8"));
        const argv = readFileSync(`/proc/${e}/cmdline`, "utf8").split("\0").filter(Boolean);
        rows.push(row(Number(e), ppid ?? 0, argv));
      } catch {
        // exited or not ours
      }
    }
    return agentProcesses(rows);
  }

  async cwds(pids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (const pid of pids) {
      try {
        out.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // not permitted / gone
      }
    }
    return out;
  }
}

class NoProcesses implements ProcessSource {
  async list(): Promise<ProcInfo[]> {
    return [];
  }
  async cwds(): Promise<Map<number, string>> {
    return new Map();
  }
}

export function systemProcesses(platform: string = process.platform): ProcessSource {
  if (platform === "darwin") return new MacProcesses();
  if (platform === "linux") return new LinuxProcesses();
  return new NoProcesses();
}

/** A fixed process list, for tests. */
export function fakeProcesses(procs: ProcInfo[], cwds: Record<number, string> = {}): ProcessSource {
  return {
    list: async () => procs,
    cwds: async (pids) => {
      const m = new Map<number, string>();
      for (const p of pids) if (cwds[p]) m.set(p, cwds[p]);
      return m;
    },
  };
}
