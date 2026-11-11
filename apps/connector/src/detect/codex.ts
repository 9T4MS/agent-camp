/**
 * Codex CLI detector.
 *   <codexDir>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * Line 1 is `{type:"session_meta", payload:{id, cwd, timestamp, ...}}`; then `response_item`
 * and `event_msg` lines. Only the two newest day folders are scanned (cheap, date-agnostic).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isObj, str, type TurnEvent } from "./activity.ts";
import { readHead } from "./tail.ts";
import type { Candidate, CandidateMeta, MetaCache } from "./types.ts";

/** How many of the newest YYYY/MM/DD folders to look at. */
const DAY_DIRS = 2;

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Newest-first list of day directories (sessions/YYYY/MM/DD), at most `limit`. */
export function newestDayDirs(sessionsDir: string, limit = DAY_DIRS): string[] {
  const out: string[] = [];
  for (const y of listDirs(sessionsDir).reverse()) {
    for (const m of listDirs(join(sessionsDir, y)).reverse()) {
      for (const d of listDirs(join(sessionsDir, y, m)).reverse()) {
        out.push(join(sessionsDir, y, m, d));
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Codex rollout line -> normalized event. */
export function normalizeCodex(entry: Record<string, unknown>): TurnEvent | null {
  const payload = isObj(entry.payload) ? entry.payload : undefined;
  if (!payload) return null;
  const ptype = str(payload.type);
  if (entry.type === "response_item") {
    switch (ptype) {
      case "function_call":
      case "custom_tool_call":
        return { kind: "tool", name: str(payload.name) ?? "unknown" };
      case "local_shell_call":
        return { kind: "tool", name: "shell" };
      case "web_search_call":
        return { kind: "tool", name: "web_search" };
      case "function_call_output":
      case "custom_tool_call_output":
      case "local_shell_call_output":
        return { kind: "toolResult" };
      case "reasoning":
        return { kind: "assistant", final: false };
      case "message":
        if (payload.role === "user") return { kind: "user" };
        if (payload.role === "assistant") return { kind: "assistant", final: false };
        return null;
      default:
        return null;
    }
  }
  if (entry.type === "event_msg") {
    switch (ptype) {
      case "task_complete":
      case "turn_complete":
      case "turn_aborted":
        return { kind: "turnEnd" };
      case "user_message":
        return { kind: "user" };
      default:
        return null; // token_count, agent_reasoning, agent_message, ... (duplicates)
    }
  }
  return null;
}

/** Find Codex session candidates. Never throws. */
export function scanCodex(codexDir: string, cache: MetaCache = new Map()): Candidate[] {
  const out: Candidate[] = [];
  for (const dayDir of newestDayDirs(join(codexDir, "sessions"))) {
    let files: string[];
    try {
      files = readdirSync(dayDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
      const path = join(dayDir, file);
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
      const rawId = file.match(UUID_RE)?.[0] ?? file;
      const meta = (): CandidateMeta => {
        const cached = cache.get(path);
        if (cached) return cached;
        const head = readHead(path, 3).find((e) => e.type === "session_meta");
        const payload = head && isObj(head.payload) ? head.payload : undefined;
        if (!payload) return { startedAt: birthMs || undefined };
        const ts = Date.parse(str(payload.timestamp) ?? str(head?.timestamp) ?? "");
        const m = { cwd: str(payload.cwd), startedAt: Number.isFinite(ts) ? ts : birthMs };
        cache.set(path, m);
        return m;
      };
      out.push({
        agent: "codex",
        rawId,
        transcript: path,
        mtimeMs,
        pids: [],
        matchesCwd: (cwd) => meta().cwd === cwd,
        meta,
        normalize: normalizeCodex,
      });
    }
  }
  return out;
}
