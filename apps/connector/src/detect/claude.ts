/**
 * Claude Code detector.
 *   <claudeDir>/projects/<encoded-cwd>/<session-id>.jsonl                 transcript
 *   <claudeDir>/projects/<encoded-cwd>/<session-id>/subagents/**\/agent-*.jsonl  subagents
 *     next to each: agent-<id>.meta.json   { requestShape, toolUseId, finished, ... }
 *   <claudeDir>/sessions/<pid>.json                                       { pid, sessionId, cwd, startedAt,
 *                                                                           status, statusUpdatedAt }
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SUBAGENT_LIVE_MS } from "@agent-office/protocol";
import { arr, isObj, str, type TurnEvent } from "./activity.ts";
import { readHead, readTail } from "./tail.ts";
import type { Candidate, CandidateMeta, MetaCache, PidStatus } from "./types.ts";

type PidFile = {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  status?: string;
  statusSince?: number;
};

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

/*
 * Pid file "status" (undocumented; Claude Code 2.1.319 - 2.1.322, CLI and desktop app).
 * Evidence from one Mac, 11 pid files of live processes compared with their transcripts and
 * subagents/agent-*.meta.json:
 *   - Values seen: "busy" (2), "idle" (8), "shell" (1). `statusUpdatedAt` (= `updatedAt`)
 *     moves only when the status changes, so it is no heartbeat: one session had been "busy"
 *     for 50 min while its background subagents wrote every few seconds.
 *   - Both "busy" sessions were really working, yet their main transcript ended with an
 *     `end_turn` a minute earlier: one waited on background subagents, one on a workflow of
 *     subagents. The transcript alone says "waiting", then "idle" after 2 min.
 *   - Every "idle" session had a finished last turn (end_turn or a local slash command) and no
 *     unfinished subagent; when a turn ended, the status flipped to "idle" the same minute.
 *   - "shell" sat on a turn that ended 45 h earlier with nothing visibly running: unknown
 *     meaning, treated as "not busy".
 *   - Earlier, a CLI session stayed "busy" ~40 min after its last turn while a background
 *     shell script it had started kept running: "busy" can outlive any visible work.
 * Trust rules (applied in Detector/deriveActivity): honour "busy" only from a pid file whose
 * process is alive; any other value means "reports a status, not busy"; never let "busy"
 * alone hold a session off idle past BUSY_HOLD_MS of transcript + subagent silence. Conversely,
 * "idle" (exactly) since IDLE_AFTER_MS after a finished turn keeps the session idle whatever is
 * appended to its transcript later (`away_summary`, the desktop app's titles and ledgers).
 */
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
      const since = raw.statusUpdatedAt ?? raw.updatedAt;
      out.push({
        pid,
        sessionId,
        cwd: str(raw.cwd),
        startedAt: typeof raw.startedAt === "number" ? raw.startedAt : undefined,
        status: str(raw.status),
        statusSince: typeof since === "number" && Number.isFinite(since) ? since : undefined,
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

/**
 * Never count a subagent whose transcript has been silent this long, whatever its meta says.
 * A working subagent writes its transcript at least once per tool call, and Claude Code's
 * Bash tool times out after 10 min at most, so 15 min of silence means the agent is stuck,
 * was killed without its meta being updated (crash, closed app), or comes from an older Claude
 * Code that never wrote `finished`. It also bounds how many files we look at per poll.
 */
export const SUBAGENT_SILENT_MAX_MS = 15 * 60_000;
/** Drop the subagent caches when they grow past this many entries (cheap to rebuild). */
const SUBAGENT_CACHE_MAX = 5000;
/** How much of a quiet subagent transcript to read when looking for a tool call in flight. */
const SUBAGENT_TAIL_BYTES = 64 * 1024;

/**
 * The lifecycle fields of a subagent's `agent-<id>.meta.json`. Its `description` and
 * `agentType` are deliberately not kept: they never leave the machine, not even as counts.
 */
export type SubagentMeta = {
  /** `requestShape`; undefined for older Claude Code versions that did not write it */
  shape?: "background" | "foreground";
  /** `finished: true` (written when an agent is done) or `stoppedByUser: true` */
  done: boolean;
  /** the parent's Agent/Task tool_use id that spawned it (local only, used for matching) */
  toolUseId?: string;
};

type Stamped<T> = { mtimeMs: number; value: T };

/**
 * Per-file results keyed by path + mtime, so the 2 s poll does not re-read and re-parse the
 * same files (a session can have hundreds of finished subagents next to the live ones).
 */
export type SubagentCache = {
  /** meta.json path -> parsed lifecycle fields (null = unreadable / not an object) */
  meta: Map<string, Stamped<SubagentMeta | null>>;
  /** agent-*.jsonl path -> "its own transcript ends with a tool call still running" */
  toolPending: Map<string, Stamped<boolean>>;
};

export function newSubagentCache(): SubagentCache {
  return { meta: new Map(), toolPending: new Map() };
}

/** Parse the lifecycle fields of a subagent meta.json (anything else is dropped). */
export function parseSubagentMeta(raw: unknown): SubagentMeta | null {
  if (!isObj(raw)) return null;
  const shape =
    raw.requestShape === "background" || raw.requestShape === "foreground"
      ? raw.requestShape
      : undefined;
  return {
    shape,
    done: raw.finished === true || raw.stoppedByUser === true,
    toolUseId: str(raw.toolUseId),
  };
}

/** Tool calls seen in transcript entries: tool_use ids started and tool_result ids returned. */
export type ToolCalls = { started: Set<string>; returned: Set<string> };

/**
 * Collect tool_use / tool_result ids from the user/assistant entries of a transcript. Other
 * entries are skipped: Claude Code's `api-request-blob` lines copy earlier request content,
 * old tool_use blocks included, whose results may lie before the tail we read, so counting
 * them would keep finished subagents "pending" and inflate the helper count.
 */
export function toolCalls(entries: readonly Record<string, unknown>[]): ToolCalls {
  const started = new Set<string>();
  const returned = new Set<string>();
  for (const e of entries) {
    if (e.type !== "user" && e.type !== "assistant") continue;
    const message = isObj(e.message) ? e.message : undefined;
    if (!message) continue;
    for (const block of arr(message.content)) {
      if (!isObj(block)) continue;
      if (block.type === "tool_use") {
        const id = str(block.id);
        if (id) started.add(id);
      } else if (block.type === "tool_result") {
        const id = str(block.tool_use_id);
        if (id) returned.add(id);
      }
    }
  }
  return { started, returned };
}

function stamped<T>(map: Map<string, Stamped<T>>, path: string, mtimeMs: number, load: () => T): T {
  const hit = map.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  const value = load();
  map.set(path, { mtimeMs, value });
  return value;
}

/** meta.json next to a subagent transcript, cached by mtime; null when missing or unreadable. */
function subagentMeta(metaPath: string, cache: SubagentCache): SubagentMeta | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(metaPath).mtimeMs;
  } catch {
    cache.meta.delete(metaPath);
    return null;
  }
  return stamped(cache.meta, metaPath, mtimeMs, () => {
    try {
      return parseSubagentMeta(JSON.parse(readFileSync(metaPath, "utf8")));
    } catch {
      return null; // half-written: read again once its mtime changes
    }
  });
}

/** True when a subagent's own transcript tail has a tool_use without its tool_result yet. */
function ownToolPending(path: string, mtimeMs: number, cache: SubagentCache): boolean {
  return stamped(cache.toolPending, path, mtimeMs, () => {
    const { started, returned } = toolCalls(readTail(path, SUBAGENT_TAIL_BYTES));
    for (const id of started) if (!returned.has(id)) return true;
    return false;
  });
}

/**
 * Is a subagent with this meta still running? `ageMs` is how long its transcript has been
 * silent, `parent` the tool calls in the tail of the parent session's transcript.
 *   - `finished` / `stoppedByUser` -> done.
 *   - foreground: done once the parent has the tool_result for its `toolUseId` (that result
 *     *is* the agent's answer). Background agents get an immediate "launched" tool_result, so
 *     this signal is foreground-only.
 *   - written within SUBAGENT_LIVE_MS -> live.
 *   - background -> live until `finished` (they keep working while the parent idles).
 *   - foreground -> live while the parent still waits on its tool_use, or (no tool_use id, e.g.
 *     workflow agents, or the call scrolled out of the parent's tail) while its own transcript
 *     ends with a tool call in flight (a long Bash run writes nothing until it returns).
 *   - older metas without `requestShape`: plain recency, as for subagents without a meta.
 * The caller applies SUBAGENT_SILENT_MAX_MS on top.
 */
export function subagentLive(
  meta: SubagentMeta,
  ageMs: number,
  parent: ToolCalls,
  ownPending: () => boolean,
): boolean {
  if (meta.done) return false;
  const id = meta.toolUseId;
  if (meta.shape === "foreground" && id && parent.returned.has(id)) return false;
  if (ageMs < SUBAGENT_LIVE_MS) return true;
  if (meta.shape === "background") return true;
  if (meta.shape === "foreground") {
    return (id !== undefined && parent.started.has(id)) || ownPending();
  }
  return false;
}

/**
 * Count live subagent transcripts (`agent-*.jsonl`, up to 3 levels below subagents/) of one
 * session. Only called for sessions the detector already considers live, so a session whose
 * process is gone never shows helpers. `parentEntries` are the raw tail entries of the
 * session's own transcript. Subagents without a meta.json (older Claude Code) count while
 * written in the last SUBAGENT_LIVE_MS; the others follow `subagentLive`. Nothing silent for
 * SUBAGENT_SILENT_MAX_MS counts at all. Only the number leaves this function.
 */
export function countSubagents(
  subagentsDir: string,
  now: number,
  parentEntries: readonly Record<string, unknown>[] = [],
  cache: SubagentCache = newSubagentCache(),
): number {
  let parent: ToolCalls | undefined;
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
        let mtimeMs: number;
        try {
          mtimeMs = statSync(p).mtimeMs;
        } catch {
          continue; // vanished
        }
        const age = now - mtimeMs;
        // most files are long finished: skip them without touching their meta.json
        if (age >= SUBAGENT_SILENT_MAX_MS) continue;
        const meta = subagentMeta(`${p.slice(0, -".jsonl".length)}.meta.json`, cache);
        if (!meta) {
          if (age < SUBAGENT_LIVE_MS) count++;
          continue;
        }
        parent ??= toolCalls(parentEntries);
        if (subagentLive(meta, age, parent, () => ownToolPending(p, mtimeMs, cache))) count++;
      }
    }
  };
  walk(subagentsDir, 0);
  return count;
}

/**
 * Newest mtime of any subagent transcript (same layout as `countSubagents`), 0 if none.
 * Only consulted once a quiet session's busy hold is about to expire, so the walk is rare.
 */
export function latestSubagentWrite(subagentsDir: string): number {
  let newest = 0;
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
          newest = Math.max(newest, statSync(p).mtimeMs);
        } catch {
          // vanished
        }
      }
    }
  };
  walk(subagentsDir, 0);
  return newest;
}

/** Find Claude session candidates. Never throws. */
export function scanClaude(
  claudeDir: string,
  cache: MetaCache = new Map(),
  subCache: SubagentCache = newSubagentCache(),
): Candidate[] {
  if (subCache.meta.size + subCache.toolPending.size > SUBAGENT_CACHE_MAX) {
    subCache.meta.clear();
    subCache.toolPending.clear();
  }
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
        makeCandidate(
          { rawId, path, folder, folderPath, mtimeMs, birthMs, pidFiles: pfs },
          cache,
          subCache,
        ),
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
        subCache,
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
  subCache: SubagentCache,
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
    subagents: (now, entries) =>
      countSubagents(join(o.folderPath, o.rawId, "subagents"), now, entries, subCache),
    pidStatus: o.pidFiles.flatMap((p): PidStatus[] =>
      p.status ? [{ pid: p.pid, status: p.status, sinceMs: p.statusSince }] : [],
    ),
    lastSubagentWriteMs: () => latestSubagentWrite(join(o.folderPath, o.rawId, "subagents")),
  };
}
