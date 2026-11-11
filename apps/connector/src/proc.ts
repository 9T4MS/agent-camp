/**
 * Process liveness, cheap and dependency-free.
 *   macOS: `ps -axo pid=,args=` (+ `lsof -a -d cwd -p <pids> -Fn` for agent pids only, cached)
 *   Linux: /proc/<pid>/cmdline and /proc/<pid>/cwd
 * We look at argv rather than `comm` because Claude Code / Pi often run as `node .../cli.js`
 * and the native Claude binary's file name is its version number.
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";
import type { AgentKind } from "@agent-office/protocol";

export type ProcInfo = { pid: number; agent: AgentKind };

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

/** Parse `ps -axo pid=,args=` output. */
export function parsePs(out: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const agent = classifyArgv(m[2]!.trim().split(/\s+/));
    if (agent) procs.push({ pid: Number(m[1]), agent });
  }
  return procs;
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
    return parsePs(await run(["ps", "-axo", "pid=,args="]));
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
    const procs: ProcInfo[] = [];
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return procs;
    }
    for (const e of entries) {
      if (!/^\d+$/.test(e)) continue;
      try {
        const argv = readFileSync(`/proc/${e}/cmdline`, "utf8").split("\0").filter(Boolean);
        const agent = classifyArgv(argv);
        if (agent) procs.push({ pid: Number(e), agent });
      } catch {
        // exited or not ours
      }
    }
    return procs;
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
