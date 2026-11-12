/**
 * Cowork detector: the Claude desktop app's local agent sessions.
 *   <desktopDir>/local-agent-mode-sessions/<account>/<org>/local_<id>/.claude/projects/<folder>/<session-id>.jsonl
 *   <desktopDir>/local-agent-mode-sessions/<account>/<org>/agent/local_<id>/.claude/projects/…
 * The transcripts are Claude Code transcripts, so the Claude normalizer reads them.
 *
 * Differences from Claude Code:
 *  - A session may run inside the app's VM, so no process on this machine owns it and the pid
 *    files in those folders hold VM pids. They are ignored: the detector counts a session as
 *    live while the desktop app runs and the transcript was written within COWORK_LIVE_MS.
 *  - The working directory is `…/local_<id>/outputs` or `/sessions/<random-name>`, so the
 *    project is the fixed label "Cowork". Session titles are content and never read.
 *
 * Finished sessions pile up, so the folders are walked only every RESCAN_MS; in between, only
 * the transcripts that were recent at the last walk are looked at again.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { str } from "./activity.ts";
import {
  claudeContext,
  countSubagents,
  newSubagentCache,
  normalizeClaude,
  type SubagentCache,
} from "./claude.ts";
import { readHead } from "./tail.ts";
import type { Candidate, CandidateMeta, MetaCache } from "./types.ts";

/** A quiet Cowork session keeps its desk this long after its last transcript write. */
export const COWORK_LIVE_MS = 30 * 60_000;
/** Walk the session folders at most this often. */
export const RESCAN_MS = 30_000;
export const COWORK_PROJECT = "Cowork";

type Found = { path: string; folderPath: string; rawId: string };

function dirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function fileTimes(path: string): { mtimeMs: number; birthMs: number } | null {
  try {
    const st = statSync(path);
    return st.isFile() ? { mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs || st.ctimeMs } : null;
  } catch {
    return null;
  }
}

/** Every Cowork transcript under `desktopDir` written within COWORK_LIVE_MS of `now`. */
export function findCoworkTranscripts(desktopDir: string, now: number): Found[] {
  const root = join(desktopDir, "local-agent-mode-sessions");
  const out: Found[] = [];
  const session = (dir: string) => {
    const projects = join(dir, ".claude", "projects");
    for (const folder of dirs(projects)) {
      const folderPath = join(projects, folder);
      let files: string[];
      try {
        files = readdirSync(folderPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl") || file.startsWith("agent-")) continue;
        const path = join(folderPath, file);
        const t = fileTimes(path);
        if (!t || now - t.mtimeMs >= COWORK_LIVE_MS) continue;
        out.push({ path, folderPath, rawId: file.slice(0, -".jsonl".length) });
      }
    }
  };
  for (const account of dirs(root)) {
    for (const org of dirs(join(root, account))) {
      const orgDir = join(root, account, org);
      for (const name of dirs(orgDir)) {
        if (name.startsWith("local_")) session(join(orgDir, name));
        else if (name === "agent") {
          for (const sub of dirs(join(orgDir, name))) {
            if (sub.startsWith("local_")) session(join(orgDir, name, sub));
          }
        }
      }
    }
  }
  return out;
}

export class CoworkScanner {
  private found: Found[] = [];
  private scannedAt = Number.NEGATIVE_INFINITY;

  /** Forget the last walk (the desktop app stopped; the next scan walks again). */
  reset(): void {
    this.found = [];
    this.scannedAt = Number.NEGATIVE_INFINITY;
  }

  /** Find Cowork session candidates. Never throws. */
  scan(
    desktopDir: string,
    now: number,
    cache: MetaCache = new Map(),
    subCache: SubagentCache = newSubagentCache(),
  ): Candidate[] {
    if (now - this.scannedAt >= RESCAN_MS || now < this.scannedAt) {
      this.found = findCoworkTranscripts(desktopDir, now);
      this.scannedAt = now;
    }
    const out = new Map<string, Candidate>();
    for (const f of this.found) {
      const t = fileTimes(f.path);
      if (!t) continue;
      const prev = out.get(f.rawId);
      if (prev && prev.mtimeMs >= t.mtimeMs) continue;
      out.set(f.rawId, makeCandidate(f, t.mtimeMs, t.birthMs, cache, subCache));
    }
    return [...out.values()];
  }
}

function makeCandidate(
  f: Found,
  mtimeMs: number,
  birthMs: number,
  cache: MetaCache,
  subCache: SubagentCache,
): Candidate {
  let meta: CandidateMeta | undefined;
  return {
    agent: "claude",
    rawId: f.rawId,
    transcript: f.path,
    mtimeMs,
    pids: [],
    desktop: true,
    project: COWORK_PROJECT,
    matchesCwd: () => false,
    meta() {
      if (meta) return meta;
      const cached = cache.get(f.path);
      if (cached) {
        meta = cached;
        return meta;
      }
      let startedAt: number | undefined;
      for (const e of readHead(f.path, 10)) {
        const ts = Date.parse(str(e.timestamp) ?? "");
        if (Number.isFinite(ts)) {
          startedAt = ts;
          break;
        }
      }
      meta = { startedAt: startedAt ?? (birthMs || undefined) };
      if (startedAt) cache.set(f.path, meta);
      return meta;
    },
    normalize: normalizeClaude,
    context: claudeContext,
    subagents: (now, entries) =>
      countSubagents(join(f.folderPath, f.rawId, "subagents"), now, entries, subCache),
  };
}
