/**
 * Session detection: scan transcripts, decide liveness from processes + mtimes, derive the
 * activity, and produce privacy-safe `SessionInfo[]` (hashed keys, project basename only).
 *
 * A candidate is live when:
 *   1. a Claude pid file ties it to a running claude process (stays live as `idle`), or
 *   2. it is the newest transcript whose folder/cwd matches a running agent process's cwd
 *      (stays live as `idle`), or
 *   3. its transcript was written < TRANSCRIPT_LIVE_MS ago and some process of that agent runs.
 *   4. opt-in (`cowork`): it is a Cowork session of the Claude desktop app (`Candidate.desktop`),
 *      the app runs and the transcript was written < COWORK_LIVE_MS ago (no process on this
 *      machine owns it).
 * With `assumeProcesses` every agent counts as running, every pid in a pid file as alive, and
 * the Claude desktop app as running.
 *
 * Claude Design is not a transcript at all: with `design` set (the person declared that their
 * Claude app is Claude Design), the running Claude app adds one `design` session (presence
 * only, see ../desktop.ts).
 *
 * An agent process running inside another agent (`ProcInfo.hostPid`, e.g. the Claude Agent SDK
 * binary that Pi's Claude bridge spawns as its model backend) is not a session of its own: it
 * never counts as running, and a session its pid file ties it to is hidden for good, so the
 * host's session is the only desk. Hosted agents that are not model backends (e.g. purrness
 * subagent workers, `pi` under `pi`) are the host session's helpers (robots), and any live
 * hosted process keeps the host session from going idle while its transcript is quiet, for at
 * most HOSTED_BUSY_MAX_MS. A hidden session shows again once a top-level pid owns it.
 *
 * A daemon (`ProcInfo.daemon`: the Codex app's `codex app-server`) counts as "the agent runs"
 * for rule 3, so the Codex app's sessions show while their transcripts are fresh, but it owns no
 * session by rule 1 or 2: in the cwd it was started in it would otherwise keep the newest
 * transcript there on a desk forever ("idle, started 9d ago"). It owns nothing, so agents hosted
 * below it are helpers of no session and keep none busy.
 *
 * A live session turns `idle` after IDLE_AFTER_MS without conversation (see
 * `Detector.conversationAt`: bookkeeping lines written after a turn do not count), unless it is
 * evidently still working (see `Detector.describe`): its live Claude process says "busy" (until
 * BUSY_HOLD_MS of transcript + subagent silence), or (reporting no status) a tool call is still
 * pending (until PENDING_TOOL_HOLD_MS, see `Detector.hold`); or it has live subagents (see
 * `countSubagents`).
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  type AgentKind,
  IDLE_AFTER_MS,
  type SessionInfo,
  TRANSCRIPT_LIVE_MS,
} from "@agent-office/protocol";
import type { DesignWatcher, DesignWatchStatus } from "../desktop.ts";
import type { AgentDirs } from "../paths.ts";
import type { ProcessSource, ProcInfo } from "../proc.ts";
import { type ActivityHold, deriveActivity, type TurnEvent } from "./activity.ts";
import { newSubagentCache, scanClaude } from "./claude.ts";
import { scanCodex } from "./codex.ts";
import { COWORK_LIVE_MS, CoworkScanner } from "./cowork.ts";
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
  /** show Cowork sessions of the Claude desktop app (opt-in: often not coding work) */
  cowork?: boolean;
  /** the Claude app counts as Claude Design: one `design` desk while it runs (opt-in) */
  design?: DesignWatcher;
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

/** Raw id of the one Claude Design session per machine (hashed like every session key). */
export const DESIGN_RAW_ID = "claude-app";

/** Hosted processes keep a quiet desk busy for at most this much transcript silence. */
export const HOSTED_BUSY_MAX_MS = 10 * 60_000;

/**
 * An idle session whose last walk found no live subagents has its subagents folder walked again
 * only this often: the folder may hold thousands of finished transcripts (a readdir + a stat
 * each), and long-idle sessions are the common case. A session that is not idle, or had live
 * subagents last time, is walked every poll.
 */
export const IDLE_SUBAGENT_RESCAN_MS = 60_000;

export class Detector {
  private tail = new TailReader();
  private cowork = new CoworkScanner();
  private metaCache: MetaCache = new Map();
  /** `agent:rawId` of sessions owned by an agent hosted inside another agent */
  private hostedIds = new Set<string>();
  /** pids from pid files whose process is alive in the current poll (rule 1) */
  private alivePids: ReadonlySet<number> = new Set();
  private subagentCache = newSubagentCache();
  /** `agent:rawId` of idle sessions -> when a walk last found no live subagents for them */
  private idleWalkedAt = new Map<string, number>();
  /** transcript -> its newest conversation entry, and when that entry was first seen */
  private moved = new Map<string, { entry: object | null; atMs: number }>();
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
    let desktop = assumeProcesses === true;
    if (!desktop) {
      try {
        desktop = (await this.opts.processes.claudeDesktop?.()) === true;
      } catch {
        desktop = false;
      }
    }
    const cowork = desktop && this.opts.cowork === true;
    if (!cowork) this.cowork.reset();
    const scanned = [
      ...safe(() => scanClaude(dirs.claude, this.metaCache, this.subagentCache)),
      ...safe(() => scanCodex(dirs.codex, this.metaCache)),
      ...safe(() => scanPi(dirs.pi, this.metaCache)),
      ...(cowork
        ? safe(() => this.cowork.scan(dirs.claudeDesktop, now, this.metaCache, this.subagentCache))
        : []),
    ];

    // 0. agents hosted inside another agent: their sessions belong to the host's desk
    const allProcs = procs;
    const hosted = allProcs.filter((p) => p.hostPid !== undefined);
    const hostedPids = new Set(hosted.map((p) => p.pid));
    procs = allProcs.filter((p) => p.hostPid === undefined);
    const idOf = (c: Candidate) => `${c.agent}:${c.rawId}`;
    for (const c of scanned) {
      const topLevel = c.pids.some((pid) =>
        procs.some((p) => p.pid === pid && p.agent === c.agent),
      );
      // a top-level pid owning it (e.g. `claude --resume <id>`) makes the session visible again
      if (topLevel) this.hostedIds.delete(idOf(c));
      else if (c.pids.some((pid) => hostedPids.has(pid))) this.hostedIds.add(idOf(c));
    }
    // remembered after the hosted process exits: its transcript stays fresh for a while
    const present = new Set(scanned.map(idOf));
    for (const id of this.hostedIds) if (!present.has(id)) this.hostedIds.delete(id);
    const candidates = scanned.filter((c) => !this.hostedIds.has(idOf(c)));

    const running = (agent: AgentKind) => assumeProcesses || procs.some((p) => p.agent === agent);
    const live = new Set<Candidate>();
    /** top-level agent pid -> the session it owns (rules 1 and 2) */
    const owner = new Map<number, Candidate>();

    // 1. pid files
    const tiedPids = new Set<number>();
    for (const c of candidates) {
      for (const pid of c.pids) {
        const alive =
          assumeProcesses || procs.some((p) => p.pid === pid && p.agent === c.agent && !p.daemon);
        if (alive) {
          live.add(c);
          tiedPids.add(pid);
          if (!assumeProcesses) owner.set(pid, c);
        }
      }
    }
    this.alivePids = tiedPids;
    // 2. process cwd -> newest matching transcript
    const untied = procs.filter((p) => !tiedPids.has(p.pid) && !p.daemon);
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
        if (best) {
          live.add(best);
          owner.set(p.pid, best);
        }
      }
    }
    // 3. recently written transcripts
    for (const c of candidates) {
      if (c.desktop) continue;
      if (c.transcript && now - c.mtimeMs < TRANSCRIPT_LIVE_MS && running(c.agent)) live.add(c);
    }
    // 4. Cowork sessions of the running Claude desktop app
    for (const c of candidates) {
      if (c.desktop && desktop && c.transcript && now - c.mtimeMs < COWORK_LIVE_MS) live.add(c);
    }

    // hosted processes -> helpers / busy flag of the session their top-level host owns
    const byPid = new Map(allProcs.map((p) => [p.pid, p]));
    const helpers = new Map<Candidate, number>();
    const busy = new Set<Candidate>();
    for (const h of hosted) {
      let top: ProcInfo | undefined = h;
      const seen = new Set<number>();
      while (top?.hostPid !== undefined && !seen.has(top.pid)) {
        seen.add(top.pid);
        top = byPid.get(top.hostPid);
      }
      const c = top && top.hostPid === undefined && !top.daemon ? owner.get(top.pid) : undefined;
      if (!c) continue;
      if (now - c.mtimeMs < HOSTED_BUSY_MAX_MS) busy.add(c);
      if (!h.backend) helpers.set(c, (helpers.get(c) ?? 0) + 1);
    }

    const sessions: SessionInfo[] = [];
    const keep = new Set<string>();
    const liveIds = new Set([...live].map(idOf));
    for (const id of this.idleWalkedAt.keys()) if (!liveIds.has(id)) this.idleWalkedAt.delete(id);
    for (const c of live) {
      try {
        sessions.push(this.describe(c, now, busy.has(c), helpers.get(c) ?? 0));
        if (c.transcript) keep.add(c.transcript);
      } catch {
        // skip a session we can't describe rather than crash
      }
    }
    this.tail.retain(keep);
    for (const p of this.moved.keys()) if (!keep.has(p)) this.moved.delete(p);
    if (this.metaCache.size > 2000) this.metaCache.clear();
    const design = await this.designSession(now, desktop);
    if (design) sessions.push(design);
    sessions.sort((a, b) => a.startedAt - b.startedAt || a.sessionKey.localeCompare(b.sessionKey));
    return sessions.slice(0, MAX_SESSIONS);
  }

  /** The Claude Design watch state for `agent-office status`; undefined when not watching. */
  get designStatus(): DesignWatchStatus | undefined {
    return this.opts.design?.status;
  }

  /** One `design` session while the Claude app runs. */
  private async designSession(now: number, desktop: boolean): Promise<SessionInfo | null> {
    const watcher = this.opts.design;
    if (!watcher) return null;
    try {
      const p = await watcher.poll(now, desktop);
      if (!p) return null;
      return {
        sessionKey: sessionKeyFor(this.opts.clientId, "design", DESIGN_RAW_ID),
        agent: "design",
        activity: p.activity,
        subagents: 0,
        startedAt: Math.max(0, Math.min(now, Math.floor(p.startedAt))),
      };
    } catch {
      return null;
    }
  }

  /**
   * A quiet session is idle after IDLE_AFTER_MS without conversation (`conversationAt`: the
   * transcript write that brought its newest event, not later bookkeeping), unless any of these
   * says it is still working:
   *   - its live Claude process reports status "busy" (within BUSY_HOLD_MS of silence),
   *   - it reports no status and a tool call is still pending (within PENDING_TOOL_HOLD_MS;
   *     not a Codex call that asks for approval: it may sit at the prompt),
   *   - a hosted process still runs (`busy`, within HOSTED_BUSY_MAX_MS), or
   *   - it has live subagents (`countSubagents`: by their lifecycle, at most
   *     SUBAGENT_SILENT_MAX_MS of silence each).
   * An open question to the human (AskUserQuestion, plan approval) is never held: it waits.
   * And a turn that ended while the process has said "idle" for IDLE_AFTER_MS stays idle.
   * `helpers`: hosted helper processes, added to the transcript-based subagent count.
   */
  private describe(c: Candidate, now: number, busy = false, helpers = 0): SessionInfo {
    const meta = c.meta();
    const entries = c.transcript ? this.tail.read(c.transcript) : [];
    let activity: SessionInfo["activity"];
    let context: number | undefined;
    if (c.transcript) {
      const events = entries.map((e) => safe(() => c.normalize(e), null));
      const at = this.conversationAt(c.transcript, entries, events, c.mtimeMs);
      // a live hosted process counts as a write just now (capped by HOSTED_BUSY_MAX_MS); a busy
      // status or a pending tool call holds a quiet session off idle (see `hold`)
      activity = deriveActivity(events, busy ? now : at, now, this.hold(c, busy));
      context = roundContext(safe(() => c.context?.(entries), undefined));
    } else {
      // pid file but nothing typed yet
      activity = now - (meta.startedAt ?? now) >= IDLE_AFTER_MS ? "idle" : "waiting";
    }
    const startedAt = Math.max(0, Math.min(now, Math.floor(meta.startedAt ?? c.mtimeMs ?? now)));
    // Live subagents (counted by their own lifecycle, see countSubagents) mean the session is
    // working even while its own transcript is quiet and nothing above held it: never idle then.
    const subagents = this.subagentsOf(c, now, entries, activity === "idle");
    if (activity === "idle" && subagents > 0) activity = "thinking";
    const info: SessionInfo = {
      sessionKey: sessionKeyFor(this.opts.clientId, c.agent, c.rawId),
      agent: c.agent,
      activity,
      // hosted helpers only count while not idle: a long-lived hosted process (e.g. `claude mcp
      // serve`) must not keep robots at a desk past HOSTED_BUSY_MAX_MS
      subagents: subagents + (activity === "idle" ? 0 : helpers),
      startedAt,
    };
    if (context !== undefined) info.context = context;
    if (this.opts.shareProjectNames) {
      const project = c.project ?? projectName(meta.cwd);
      if (project) info.project = project;
    }
    return info;
  }

  /**
   * Live subagents of `c`. An idle session whose last walk found none is walked again only after
   * IDLE_SUBAGENT_RESCAN_MS (0 in between): a subagent spawned by a turn writes the parent's
   * transcript, so the parent is not idle then and is walked at once.
   */
  private subagentsOf(
    c: Candidate,
    now: number,
    entries: readonly Record<string, unknown>[],
    idle: boolean,
  ): number {
    if (!c.subagents) return 0;
    const id = `${c.agent}:${c.rawId}`;
    const walkedAt = this.idleWalkedAt.get(id);
    if (
      idle &&
      walkedAt !== undefined &&
      now >= walkedAt &&
      now - walkedAt < IDLE_SUBAGENT_RESCAN_MS
    ) {
      return 0;
    }
    const n = safe(() => c.subagents?.(now, entries) ?? 0, 0);
    if (idle && n === 0) this.idleWalkedAt.set(id, now);
    else this.idleWalkedAt.delete(id);
    return n;
  }

  /**
   * When the conversation in `path` last moved: the transcript mtime at the poll that first saw
   * its newest normalized event (capped by the current mtime, which never really goes back).
   *
   * The raw mtime is no measure of that. Claude Code appends a `system`/`away_summary` line about
   * 182 s after a turn ends (past IDLE_AFTER_MS), and the Claude desktop app appends titles,
   * `queue-operation` and `artifact-autoreact-ledger` lines to sessions idle for hours. All of
   * them normalize to null, so with the mtime an idle session would come back from the bar as
   * "waiting" for another 2 min, and win a desk from an idle holder meanwhile. Entry timestamps
   * would serve too, but not every line has one, so the time a new event was first seen is used
   * instead. The first sighting (connector start) can only use the mtime; the pid-file status
   * covers that case for Claude (`ActivityHold.idleSinceMs`).
   */
  private conversationAt(
    path: string,
    entries: readonly object[],
    events: readonly (TurnEvent | null)[],
    mtimeMs: number,
  ): number {
    let entry: object | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]) {
        entry = entries[i] ?? null;
        break;
      }
    }
    const prev = this.moved.get(path);
    // same newest event (or it scrolled out of the tail behind bookkeeping lines): no news
    if (prev && (entry === null || prev.entry === entry)) {
      prev.atMs = Math.min(prev.atMs, mtimeMs);
      return prev.atMs;
    }
    this.moved.set(path, { entry, atMs: mtimeMs });
    return mtimeMs;
  }

  /**
   * What keeps a quiet live session off "idle" (see `ActivityHold`): the agent's own status,
   * read only from pid files whose process is alive (a dead process's last word is stale).
   * Without such a status, a pending tool call is the fallback evidence. `hostedBusy`: a hosted
   * process runs, so a settled "idle" status must not send the session to the bar.
   */
  private hold(c: Candidate, hostedBusy = false): ActivityHold {
    const reported = (c.pidStatus ?? []).filter((s) => this.alivePids.has(s.pid));
    const idle = reported.length > 0 && reported.every((s) => s.status === "idle");
    const since = reported.map((s) => s.sinceMs);
    return {
      busy: reported.length > 0 ? reported.some((s) => s.status === "busy") : undefined,
      idleSinceMs:
        idle && !hostedBusy && since.every((t) => t !== undefined)
          ? Math.max(...(since as number[]))
          : undefined,
      lastWriteMs: () =>
        Math.max(
          c.mtimeMs,
          safe(() => c.lastSubagentWriteMs?.() ?? 0, 0),
        ),
    };
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
