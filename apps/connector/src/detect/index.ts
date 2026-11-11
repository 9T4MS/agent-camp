/**
 * Session detection: scan transcripts, decide liveness from processes + mtimes, derive the
 * activity, and produce privacy-safe `SessionInfo[]` (hashed keys, project basename only).
 *
 * A candidate is live when:
 *   1. a Claude pid file ties it to a running claude process (stays live as `idle`), or
 *   2. it is the newest transcript whose folder/cwd matches a running agent process's cwd
 *      (stays live as `idle`), or
 *   3. its transcript was written < TRANSCRIPT_LIVE_MS ago and some process of that agent runs.
 * With `assumeProcesses` every agent counts as running and every pid in a pid file as alive.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  type AgentKind,
  IDLE_AFTER_MS,
  type SessionInfo,
  TRANSCRIPT_LIVE_MS,
} from "@agent-office/protocol";
import type { AgentDirs } from "../paths.ts";
import type { ProcessSource, ProcInfo } from "../proc.ts";
import { deriveActivity } from "./activity.ts";
import { scanClaude } from "./claude.ts";
import { scanCodex } from "./codex.ts";
import { scanPi } from "./pi.ts";
import { TailReader } from "./tail.ts";
import type { Candidate, MetaCache } from "./types.ts";

export type DetectorOptions = {
  dirs: AgentDirs;
  /** per-install salt for session keys */
  clientId: string;
  shareProjectNames: boolean;
  processes: ProcessSource;
  /** treat every agent as running (fixtures / Linux CI) */
  assumeProcesses?: boolean;
  now?: () => number;
};

/** Hashed, salted session key: sha256(clientId + ":" + agent + ":" + raw id), 16 hex chars. */
export function sessionKeyFor(clientId: string, agent: AgentKind, rawId: string): string {
  return createHash("sha256").update(`${clientId}:${agent}:${rawId}`).digest("hex").slice(0, 16);
}

/** Project folder basename, trimmed to the protocol limit; undefined if unknown. */
export function projectName(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const name = basename(cwd.replace(/[/\\]+$/, ""));
  return name.length > 0 ? name.slice(0, 80) : undefined;
}

const MAX_SESSIONS = 200;

export class Detector {
  private tail = new TailReader();
  private metaCache: MetaCache = new Map();
  private readonly now: () => number;

  constructor(private readonly opts: DetectorOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** One poll. Never throws (filesystem / process errors just yield fewer sessions). */
  async poll(): Promise<SessionInfo[]> {
    const now = this.now();
    const { dirs, assumeProcesses } = this.opts;
    let procs: ProcInfo[] = [];
    if (!assumeProcesses) {
      try {
        procs = await this.opts.processes.list();
      } catch {
        procs = [];
      }
    }
    const candidates = [
      ...safe(() => scanClaude(dirs.claude, this.metaCache)),
      ...safe(() => scanCodex(dirs.codex, this.metaCache)),
      ...safe(() => scanPi(dirs.pi, this.metaCache)),
    ];

    const running = (agent: AgentKind) => assumeProcesses || procs.some((p) => p.agent === agent);
    const live = new Set<Candidate>();

    // 1. pid files
    const tiedPids = new Set<number>();
    for (const c of candidates) {
      for (const pid of c.pids) {
        const alive = assumeProcesses || procs.some((p) => p.pid === pid && p.agent === c.agent);
        if (alive) {
          live.add(c);
          tiedPids.add(pid);
        }
      }
    }
    // 2. process cwd -> newest matching transcript
    const untied = procs.filter((p) => !tiedPids.has(p.pid));
    if (untied.length > 0) {
      let cwds = new Map<number, string>();
      try {
        cwds = await this.opts.processes.cwds(untied.map((p) => p.pid));
      } catch {
        // unknown cwds: rely on mtimes only
      }
      for (const p of untied) {
        const cwd = cwds.get(p.pid);
        if (!cwd) continue;
        let best: Candidate | undefined;
        for (const c of candidates) {
          if (c.agent !== p.agent || !c.transcript || live.has(c)) continue;
          if (best && best.mtimeMs >= c.mtimeMs) continue;
          if (safe(() => c.matchesCwd(cwd), false)) best = c;
        }
        if (best) live.add(best);
      }
    }
    // 3. recently written transcripts
    for (const c of candidates) {
      if (c.transcript && now - c.mtimeMs < TRANSCRIPT_LIVE_MS && running(c.agent)) live.add(c);
    }

    const sessions: SessionInfo[] = [];
    const keep = new Set<string>();
    for (const c of live) {
      try {
        sessions.push(this.describe(c, now));
        if (c.transcript) keep.add(c.transcript);
      } catch {
        // skip a session we can't describe rather than crash
      }
    }
    this.tail.retain(keep);
    if (this.metaCache.size > 2000) this.metaCache.clear();
    sessions.sort((a, b) => a.startedAt - b.startedAt || a.sessionKey.localeCompare(b.sessionKey));
    return sessions.slice(0, MAX_SESSIONS);
  }

  private describe(c: Candidate, now: number): SessionInfo {
    const meta = c.meta();
    let activity: SessionInfo["activity"];
    let context: number | undefined;
    if (c.transcript) {
      const entries = this.tail.read(c.transcript);
      const events = entries.map((e) => safe(() => c.normalize(e), null));
      activity = deriveActivity(events, c.mtimeMs, now);
      context = roundContext(safe(() => c.context?.(entries), undefined));
    } else {
      // pid file but nothing typed yet
      activity = now - (meta.startedAt ?? now) >= IDLE_AFTER_MS ? "idle" : "waiting";
    }
    const startedAt = Math.max(0, Math.min(now, Math.floor(meta.startedAt ?? c.mtimeMs ?? now)));
    const subagents = activity === "idle" ? 0 : safe(() => c.subagents?.(now) ?? 0, 0);
    const info: SessionInfo = {
      sessionKey: sessionKeyFor(this.opts.clientId, c.agent, c.rawId),
      agent: c.agent,
      activity,
      subagents,
      startedAt,
    };
    if (context !== undefined) info.context = context;
    if (this.opts.shareProjectNames) {
      const project = projectName(meta.cwd);
      if (project) info.project = project;
    }
    return info;
  }
}

function safe<T>(fn: () => T, fallback?: T): T {
  try {
    return fn();
  } catch {
    return (fallback ?? []) as T;
  }
}

/** 5% steps, so a growing context sends a snapshot every few turns, not every turn. */
export function roundContext(share: number | undefined): number | undefined {
  if (share === undefined || !Number.isFinite(share) || share < 0) return undefined;
  return Math.min(1, Math.round(share * 20) / 20);
}

/** Stable comparison key for "did the snapshot change?". */
export function snapshotKey(sessions: readonly SessionInfo[]): string {
  return JSON.stringify(
    sessions.map((s) => [
      s.sessionKey,
      s.agent,
      s.project ?? "",
      s.activity,
      s.subagents,
      s.context ?? -1,
    ]),
  );
}
