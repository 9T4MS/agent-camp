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
      if (!file.endsWith(".jsonl")) continue;
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
    subagents: (now) => countSubagents(join(o.folderPath, o.rawId, "subagents"), now),
  };
}
