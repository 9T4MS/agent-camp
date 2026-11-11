import type { AgentKind } from "@agent-office/protocol";
import type { TurnEvent } from "./activity.ts";

/** Lazily resolved transcript metadata (from a pid file or the transcript's first lines). */
export type CandidateMeta = {
  /** absolute working directory; only its basename ever leaves the machine */
  cwd?: string;
  startedAt?: number;
};

/**
 * A possible session found on disk. Whether it is live is decided by the detector from
 * process liveness + transcript mtime. Contains raw ids and paths: NEVER sent anywhere.
 */
export type Candidate = {
  agent: AgentKind;
  /** raw agent session id (hashed before it leaves the detector) */
  rawId: string;
  /** transcript path, or null when only a pid file says the session exists */
  transcript: string | null;
  /** transcript mtime (epoch ms); 0 when there is no transcript */
  mtimeMs: number;
  /** pids that a pid file ties to this session (Claude `sessions/<pid>.json`) */
  pids: number[];
  /** true if a process with working directory `cwd` could own this session */
  matchesCwd(cwd: string): boolean;
  meta(): CandidateMeta;
  /** raw JSONL entry -> normalized event (null = irrelevant line) */
  normalize(entry: Record<string, unknown>): TurnEvent | null;
  /** share of the context window in use, from the transcript's latest usage numbers */
  context?(entries: readonly Record<string, unknown>[]): number | undefined;
  /** Claude only: count live subagent transcripts */
  subagents?(now: number): number;
  /**
   * A session of the Claude desktop app (Cowork). It may run inside the app's VM, so no
   * process on this machine owns it: it is live while the app runs and its transcript was
   * written recently (COWORK_LIVE_MS).
   */
  desktop?: boolean;
  /** fixed project label, used instead of the cwd's folder name */
  project?: string;
};

/** Transcript path -> header metadata, so headers are read once per file. */
export type MetaCache = Map<string, CandidateMeta>;
