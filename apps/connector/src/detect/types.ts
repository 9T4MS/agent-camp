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
  /** Claude only: count live subagent transcripts */
  subagents?(now: number): number;
};

/** Transcript path -> header metadata, so headers are read once per file. */
export type MetaCache = Map<string, CandidateMeta>;
