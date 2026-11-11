/**
 * Claude Code detector.
 *   <claudeDir>/projects/<encoded-cwd>/<session-id>.jsonl                 transcript
 *   <claudeDir>/projects/<encoded-cwd>/<session-id>/subagents/**\/agent-*.jsonl  subagents
 *   <claudeDir>/sessions/<pid>.json                                       { pid, sessionId, cwd, startedAt }
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SUBAGENT_LIVE_MS } from "@agent-office/protocol";
import { arr, isObj, str, type TurnEvent } from "./activity.ts";
import { readHead } from "./tail.ts";
import type { Candidate, CandidateMeta, MetaCache } from "./types.ts";

type PidFile = { pid: number; sessionId: string; cwd?: string; startedAt?: number };

/** Claude Code's folder encoding: every non-alphanumeric char becomes "-". */
export function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Best-effort inverse of `encodeClaudeCwd` (last resort for the project name). The encoding is
 * lossy, so walk the real filesystem: take the shortest run of parts that names an existing
 * directory, and once nothing matches, the remaining parts form the leaf name.
 */
export function decodeClaudeFolder(
  folder: string,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const parts = folder.replace(/^-+/, "").split("-");
  if (parts.length === 0 || parts[0] === "") return undefined;
  let path = "";
  let i = 0;
  outer: while (i < parts.length) {
    for (let j = i; j < parts.length; j++) {
      const seg = parts.slice(i, j + 1).join("-");
      if (seg && exists(`${path}/${seg}`)) {
        path = `${path}/${seg}`;
        i = j + 1;
        continue outer;
      }
    }
    return `${path}/${parts.slice(i).join("-")}`;
  }
  return path || undefined;
}

function readPidFiles(claudeDir: string): PidFile[] {
  const dir = join(claudeDir, "sessions");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PidFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!isObj(raw)) continue;
      const pid = typeof raw.pid === "number" ? raw.pid : Number.parseInt(name, 10);
      const sessionId = str(raw.sessionId);
      if (!Number.isFinite(pid) || !sessionId) continue;
      out.push({
        pid,
        sessionId,
        cwd: str(raw.cwd),
        startedAt: typeof raw.startedAt === "number" ? raw.startedAt : undefined,
      });
    } catch {
      // half-written or unknown format: skip
    }
  }
  return out;
}

const INTERRUPTED = "[Request interrupted by user";

/** Claude transcript line -> normalized event. */
export function normalizeClaude(entry: Record<string, unknown>): TurnEvent | null {
  if (entry.isSidechain === true) return null;
  const type = entry.type;
  const message = isObj(entry.message) ? entry.message : undefined;
  if (type === "user") {
    if (entry.isMeta === true || !message) return null;
    const content = message.content;
    if (typeof content === "string") {
      return content.includes(INTERRUPTED) ? { kind: "turnEnd" } : { kind: "user" };
    }
    let sawToolResult = false;
    for (const block of arr(content)) {
      if (!isObj(block)) continue;
      if (block.type === "tool_result") sawToolResult = true;
      if (block.type === "text" && str(block.text)?.includes(INTERRUPTED)) {
        return { kind: "turnEnd" };
      }
    }
    return sawToolResult ? { kind: "toolResult" } : { kind: "user" };
  }
  if (type === "assistant") {
    if (!message) return null;
    let tool: string | undefined;
    for (const block of arr(message.content)) {
      if (isObj(block) && block.type === "tool_use") tool = str(block.name) ?? "unknown";
    }
    if (tool) return { kind: "tool", name: tool };
    const stop = message.stop_reason;
    return {
      kind: "assistant",
      final: stop === "end_turn" || stop === "stop_sequence" || stop === "max_tokens",
    };
  }
  return null; // summary, file-history-snapshot, system, attachment, progress, ...
}

export const CLAUDE_WINDOW = 200_000;
export const CLAUDE_LONG_WINDOW = 1_000_000;

/**
 * Context in use = everything the last main-thread request sent (input + cache reads/writes).
 * The window isn't in the transcript: 200k, or 1M once a session is past 200k or the model id
 * says so ("[1m]").
 */
export function claudeContext(entries: readonly Record<string, unknown>[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type !== "assistant" || e.isSidechain === true || !isObj(e.message)) continue;
    const m = e.message;
    if (m.model === "<synthetic>" || !isObj(m.usage)) continue;
    const n = (k: string) =>
      typeof m.usage === "object" && typeof (m.usage as Record<string, unknown>)[k] === "number"
        ? ((m.usage as Record<string, number>)[k] ?? 0)
        : 0;
    const used =
      n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
    if (used <= 0) continue;
    const long = used > CLAUDE_WINDOW || String(m.model ?? "").includes("[1m]");
    return used / (long ? CLAUDE_LONG_WINDOW : CLAUDE_WINDOW);
  }
  return undefined;
}

/** Count subagent transcripts (`agent-*.jsonl`, up to 3 levels below subagents/) written recently. */
export function countSubagents(subagentsDir: string, now: number): number {
  let count = 0;
  const walk = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 2) walk(p, depth + 1);
      } else if (e.name.startsWith("agent-") && e.name.endsWith(".jsonl")) {
        try {
          if (now - statSync(p).mtimeMs < SUBAGENT_LIVE_MS) count++;
        } catch {
          // vanished
        }
      }
    }
  };
  walk(subagentsDir, 0);
  return count;
}

/** Find Claude session candidates. Never throws. */
export function scanClaude(claudeDir: string, cache: MetaCache = new Map()): Candidate[] {
  const pidFiles = readPidFiles(claudeDir);
  const bySession = new Map<string, PidFile[]>();
  for (const pf of pidFiles) {
    const list = bySession.get(pf.sessionId) ?? [];
    list.push(pf);
    bySession.set(pf.sessionId, list);
  }

  const projectsDir = join(claudeDir, "projects");
  const out = new Map<string, Candidate>();
  let folders: string[] = [];
  try {
    folders = readdirSync(projectsDir);
  } catch {
    // no projects yet
  }
  for (const folder of folders) {
    const folderPath = join(projectsDir, folder);
    let files: string[];
    try {
      files = readdirSync(folderPath);
    } catch {
      continue; // not a directory
    }
    for (const file of files) {
      // older Claude Code versions keep subagent sidechains as agent-*.jsonl next to sessions
      if (!file.endsWith(".jsonl") || file.startsWith("agent-")) continue;
      const path = join(folderPath, file);
      let mtimeMs: number;
      let birthMs: number;
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        mtimeMs = st.mtimeMs;
        birthMs = st.birthtimeMs || st.ctimeMs;
      } catch {
        continue;
      }
      const rawId = file.slice(0, -".jsonl".length);
      const prev = out.get(rawId);
      if (prev && prev.mtimeMs >= mtimeMs) continue;
      const pfs = bySession.get(rawId) ?? [];
      out.set(
        rawId,
        makeCandidate({ rawId, path, folder, folderPath, mtimeMs, birthMs, pidFiles: pfs }, cache),
      );
    }
  }
  // sessions that have a pid file but no transcript yet (fresh, nothing typed)
  for (const [sessionId, pfs] of bySession) {
    if (out.has(sessionId)) continue;
    const pf = pfs[0]!;
    const folder = pf.cwd ? encodeClaudeCwd(pf.cwd) : "";
    out.set(
      sessionId,
      makeCandidate(
        {
          rawId: sessionId,
          path: null,
          folder,
          folderPath: join(projectsDir, folder),
          mtimeMs: 0,
          birthMs: pf.startedAt ?? 0,
          pidFiles: pfs,
        },
        cache,
      ),
    );
  }
  return [...out.values()];
}

function makeCandidate(
  o: {
    rawId: string;
    path: string | null;
    folder: string;
    folderPath: string;
    mtimeMs: number;
    birthMs: number;
    pidFiles: PidFile[];
  },
  cache: MetaCache,
): Candidate {
  let meta: CandidateMeta | undefined;
  return {
    agent: "claude",
    rawId: o.rawId,
    transcript: o.path,
    mtimeMs: o.mtimeMs,
    pids: o.pidFiles.map((p) => p.pid),
    matchesCwd: (cwd) => encodeClaudeCwd(cwd) === o.folder,
    meta() {
      if (meta) return meta;
      const pf = o.pidFiles.find((p) => p.cwd) ?? o.pidFiles[0];
      let cwd = pf?.cwd;
      let startedAt = o.pidFiles.find((p) => p.startedAt)?.startedAt;
      if ((!cwd || !startedAt) && o.path) {
        const cached = cache.get(o.path);
        if (cached) {
          meta = { cwd: cwd ?? cached.cwd, startedAt: startedAt ?? cached.startedAt };
          return meta;
        }
        for (const e of readHead(o.path, 10)) {
          cwd ??= str(e.cwd);
          if (!startedAt) {
            const ts = Date.parse(str(e.timestamp) ?? "");
            if (Number.isFinite(ts)) startedAt = ts;
          }
          if (cwd && startedAt) break;
        }
        if (cwd && startedAt) cache.set(o.path, { cwd, startedAt });
      }
      cwd ??= decodeClaudeFolder(o.folder);
      meta = { cwd, startedAt: startedAt ?? (o.birthMs || undefined) };
      return meta;
    },
    normalize: normalizeClaude,
    context: claudeContext,
    subagents: (now) => countSubagents(join(o.folderPath, o.rawId, "subagents"), now),
  };
}
