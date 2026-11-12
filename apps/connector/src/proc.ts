/**
 * Process liveness, cheap and dependency-free.
 *   macOS: `ps -axo pid=,ppid=,ucomm=,args=` (+ `lsof -a -d cwd -p <pids> -Fn` for agent pids
 *   only, cached)
 *   Linux: /proc/<pid>/cmdline, /proc/<pid>/stat (ppid) and /proc/<pid>/cwd
 * We classify by the executable's file name first, then by argv, because Claude Code / Pi often
 * run as `node .../cli.js` and the native Claude CLI binary's file name is its version number.
 *
 * macOS `args` is one space-joined string, so an executable path with spaces cannot be split
 * back into argv: the Claude desktop app runs Claude Code as
 * `~/Library/Application Support/Claude/claude-code/<ver>/<hash>/claude.app/Contents/MacOS/claude`,
 * whose whitespace-split argv0 is `…/Library/Application`. `ucomm` (the kernel's copy of the
 * executable's file name, at most MAXCOMLEN = 16 chars, padded to exactly that width) gives the
 * name without a second `ps` spawn (trusted only while argv0 names the same executable: see
 * `runsAsExe`). Its wrapper `Claude.app/Contents/Helpers/disclaimer … --
 * <same path>` is named `disclaimer`, so it never counts.
 *
 * The Codex app's background `codex app-server` (a top-level `app-server daemon pid-update-loop`
 * plus an `app-server --listen unix://…` child) is a daemon, not a session (`ProcInfo.daemon`).
 *
 * Parent pids let us spot an agent running *inside* another agent, e.g. Pi's Claude bridge
 * (pi-claude-bridge) spawning the Claude Agent SDK's `claude` binary as its model backend.
 * Such a process gets `hostPid`; the detector folds its session into the host's and counts
 * hosted agents (e.g. purrness subagent workers) as the host's helpers, except model backends.
 *
 * The Claude desktop app (`Claude.app`) is not an agent process, but we note whether it runs:
 * its Cowork sessions and the Claude Design desk only count while it does.
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
  /**
   * a long-lived server (`codex app-server`) that hosts sessions but is none itself: it means
   * "the agent runs" (fresh transcripts count) but never owns a session by pid file or cwd
   */
  daemon?: boolean;
};

/** Any process: its parent pid and, if it is a coding agent, which one. */
export type ProcRow = {
  pid: number;
  ppid: number;
  agent: AgentKind | null;
  backend?: boolean;
  /** argv0 is a JS runtime (`node …/bin/codex`), not the agent's native binary */
  launcher?: boolean;
  daemon?: boolean;
};

/** The Claude Agent SDK's bundled `claude` (`@anthropic-ai/claude-agent-sdk-<platform>/claude`). */
export function isAgentSdkBackend(argv: readonly string[]): boolean {
  return argv.some((a) => a.includes("claude-agent-sdk"));
}

/**
 * `codex app-server …` (Codex app daemon, IDE extension backend): the subcommand right after the
 * codex executable or script. Looking for the token after the codex path, not at argv[1], keeps
 * this working when a path with spaces was split into several tokens.
 */
export function isCodexAppServer(argv: readonly string[]): boolean {
  const i = argv.findIndex((a) => kindOfName(basename(a)) === "codex");
  return i >= 0 && argv[i + 1] === "app-server";
}

/**
 * Does the command line run the executable `exe` (a `ucomm`, cut to UCOMM_WIDTH chars) under its
 * own name: `exe …`, or a path ending in `/exe …` (which may hold spaces)? Not when argv0 was
 * renamed: Claude Code runs its embedded ripgrep, bfs and ugrep as its own binary with argv0
 * `rg`/`bfs`/`ugrep` (`ARGV0=ugrep "$_cc_bin" …`), so for the desktop app's Claude Code `ps`
 * shows ucomm `claude` with args `ugrep -G …`: a grep, not an agent. Without args (unreadable)
 * there is nothing to contradict the ucomm.
 */
export function runsAsExe(args: string, exe: string): boolean {
  if (args.trim() === "") return true;
  let re = exeRegExps.get(exe);
  if (!re) {
    const name =
      exe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (exe.length >= UCOMM_WIDTH ? "\\S*" : "");
    // a path starts with / ~ or . and, up to `/exe`, has no space that starts another argument
    re = new RegExp(`^(?:(?=[/~.])(?:(?!\\s[-/~]).)*?/)?${name}(?:\\s|$)`);
    if (exeRegExps.size >= 64) exeRegExps.clear();
    exeRegExps.set(exe, re);
  }
  return re.test(args);
}

/** `runsAsExe` patterns per executable name (only agent names reach it from `procRow`). */
const exeRegExps = new Map<string, RegExp>();

/**
 * One process. `exe`: the executable's file name when the platform reports it apart from argv
 * (macOS `ucomm`); it wins over argv, which may be split wrongly, as long as argv0 names that
 * executable too (see `runsAsExe`).
 */
export function procRow(pid: number, ppid: number, argv: readonly string[], exe?: string): ProcRow {
  // only an agent's executable name needs the argv0 check: anything else classifies by argv
  const exeKind = exe ? kindOfName(exe) : null;
  const byExe = exeKind && exe && runsAsExe(argv.join(" "), exe) ? exeKind : null;
  const agent = byExe ?? classifyArgv(argv);
  const r: ProcRow = { pid, ppid, agent };
  if (agent === "claude" && isAgentSdkBackend(argv)) r.backend = true;
  if (agent && !byExe && RUNTIMES.has(basename(argv[0] ?? ""))) r.launcher = true;
  if (agent === "codex" && isCodexAppServer(argv)) r.daemon = true;
  return r;
}

export interface ProcessSource {
  /** All running coding-agent processes. */
  list(): Promise<ProcInfo[]>;
  /** Working directories of the given pids (missing entries = unknown). */
  cwds(pids: number[]): Promise<Map<number, string>>;
  /** Whether the Claude desktop app runs, as of the last `list()`. Absent = never. */
  claudeDesktop?(): Promise<boolean>;
}

/**
 * Does a `ps` args line belong to the Claude desktop app's main process? Its helpers live in
 * `Claude.app/Contents/Frameworks/…` and do not match.
 */
export function isClaudeDesktopArgs(args: string): boolean {
  return /(^|\/)Claude\.app\/Contents\/MacOS\/Claude(\s|$)/.test(args);
}

/** Whether `ps -axo pid=,ppid=,ucomm=,args=` output lists the Claude desktop app. */
export function claudeDesktopInPs(out: string): boolean {
  return psLines(out).some((l) => isClaudeDesktopArgs(l.args));
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
    if (r.daemon) info.daemon = true;
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

/**
 * The `ps -axo` columns `psLines` parses. `ucomm` is what makes an executable path with spaces
 * readable at all (see the header), so tests build their `ps` output from this very string.
 */
export const PS_COLUMNS = "pid=,ppid=,ucomm=,args=";

/** Darwin's MAXCOMLEN: `ucomm` is cut to, and padded to, exactly this many characters. */
export const UCOMM_WIDTH = 16;
const PS_LINE = new RegExp(`^\\s*(\\d+)\\s+(\\d+) (.{1,${UCOMM_WIDTH}})(?: (.*))?$`);

export type PsLine = { pid: number; ppid: number; exe: string; args: string };

/**
 * Lines of `ps -axo pid=,ppid=,ucomm=,args=`. `ucomm` may itself hold spaces ("Claude Helper
 * (R"), so it is cut by width, never by whitespace.
 */
export function psLines(out: string): PsLine[] {
  const lines: PsLine[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(PS_LINE);
    if (!m) continue;
    lines.push({ pid: Number(m[1]), ppid: Number(m[2]), exe: m[3]!.trim(), args: m[4] ?? "" });
  }
  return lines;
}

/** Agent processes of `ps -axo pid=,ppid=,ucomm=,args=` output. */
export function parsePs(out: string): ProcInfo[] {
  return psAgents(psLines(out));
}

function psAgents(lines: readonly PsLine[]): ProcInfo[] {
  return agentProcesses(
    lines.map((l) => procRow(l.pid, l.ppid, l.args.trim().split(/\s+/).filter(Boolean), l.exe)),
  );
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
  private desktop = false;

  async list(): Promise<ProcInfo[]> {
    const lines = psLines(await run(["ps", "-axo", PS_COLUMNS]));
    this.desktop = lines.some((l) => isClaudeDesktopArgs(l.args));
    return psAgents(lines);
  }

  async claudeDesktop(): Promise<boolean> {
    return this.desktop;
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
        rows.push(procRow(Number(e), ppid ?? 0, argv));
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

/** A fixed process list, for tests. `desktop`: the Claude desktop app runs. */
export function fakeProcesses(
  procs: ProcInfo[],
  cwds: Record<number, string> = {},
  desktop = false,
): ProcessSource {
  return {
    list: async () => procs,
    claudeDesktop: async () => desktop,
    cwds: async (pids) => {
      const m = new Map<number, string>();
      for (const p of pids) if (cwds[p]) m.set(p, cwds[p]);
      return m;
    },
  };
}
