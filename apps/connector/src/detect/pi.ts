/**
 * Pi coding agent detector.
 *   <piDir>/sessions/--<cwd with / as ->--/<iso-ts>_<uuid>.jsonl   (piDir = PI_CODING_AGENT_DIR or ~/.pi/agent)
 * Line 1 is `{type:"session", id, cwd, timestamp}`; then `model_change` and `message` lines.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { arr, isObj, str, type TurnEvent } from "./activity.ts";
import { readHead } from "./tail.ts";
import type { Candidate, CandidateMeta, MetaCache } from "./types.ts";

/** Pi's session folder encoding. */
export function encodePiCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Pi transcript line -> normalized event. */
export function normalizePi(entry: Record<string, unknown>): TurnEvent | null {
  if (entry.type !== "message" || !isObj(entry.message)) return null;
  const m = entry.message;
  switch (m.role) {
    case "user":
      return { kind: "user" };
    case "toolResult":
      return { kind: "toolResult" };
    case "assistant": {
      let tool: string | undefined;
      for (const block of arr(m.content)) {
        if (isObj(block) && block.type === "toolCall") tool = str(block.name) ?? "unknown";
      }
      if (tool) return { kind: "tool", name: tool };
      const stop = str(m.stopReason);
      if (stop === "aborted" || stop === "error") return { kind: "turnEnd" };
      return { kind: "assistant", final: stop === "stop" || stop === "length" };
    }
    default:
      return null;
  }
}

/** Find Pi session candidates. Never throws. */
export function scanPi(piDir: string, cache: MetaCache = new Map()): Candidate[] {
  const sessionsDir = join(piDir, "sessions");
  const out: Candidate[] = [];
  let folders: string[] = [];
  try {
    folders = readdirSync(sessionsDir);
  } catch {
    return out;
  }
  for (const folder of folders) {
    let files: string[];
    try {
      files = readdirSync(join(sessionsDir, folder));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(sessionsDir, folder, file);
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
      const base = file.slice(0, -".jsonl".length);
      const rawId = base.includes("_") ? base.slice(base.lastIndexOf("_") + 1) : base;
      const meta = (): CandidateMeta => {
        const cached = cache.get(path);
        if (cached) return cached;
        const head = readHead(path, 2).find((e) => e.type === "session");
        const ts = Date.parse(str(head?.timestamp) ?? "");
        const cwd = str(head?.cwd) ?? `/${folder.replace(/^--|--$/g, "").replace(/-/g, "/")}`; // lossy
        const m = { cwd, startedAt: Number.isFinite(ts) ? ts : birthMs || undefined };
        if (head) cache.set(path, m);
        return m;
      };
      out.push({
        agent: "pi",
        rawId,
        transcript: path,
        mtimeMs,
        pids: [],
        matchesCwd: (cwd) => encodePiCwd(cwd) === folder,
        meta,
        normalize: normalizePi,
      });
    }
  }
  return out;
}
