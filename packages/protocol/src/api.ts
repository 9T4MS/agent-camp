/**
 * HTTP API shapes served by the Worker (not WebSocket messages):
 *   GET  /api/stats            -> StatsResponse
 *   GET  /api/snapshots        -> SnapshotList
 *   POST /api/history/backfill <- HistoryRow[]   (Bearer CONNECTOR_PASSWORD)
 */
import { z } from "zod";
import { AgentKind } from "./messages.ts";

/** One stored history row (one per viewer event, except activity changes). No content. */
export const HistoryRow = z.object({
  ts: z.number().int().nonnegative(),
  type: z.string().min(1).max(40),
  /** personId */
  person: z.string().min(1).max(64),
  agent: AgentKind.nullable().optional(),
  project: z.string().max(80).nullable().optional(),
  subagents: z.number().int().nonnegative().nullable().optional(),
});
export type HistoryRow = z.infer<typeof HistoryRow>;

export const LeaderboardEntry = z.object({ key: z.string(), value: z.number() });
export type LeaderboardEntry = z.infer<typeof LeaderboardEntry>;

export const StatsResponse = z.object({
  generatedAt: z.number(),
  timezone: z.string(),
  /** first/last history row timestamps, null when there is no history */
  range: z.object({ from: z.number(), to: z.number() }).nullable(),
  totalSessions: z.number(),
  totalSubagents: z.number(),
  /** heatmap[weekday][hour] of session.started; weekday 0 = Monday, hours in `timezone` */
  heatmap: z.array(z.array(z.number())),
  weekdays: z.array(z.string()),
  /** sessions started per agent kind */
  agentSplit: z.record(z.string(), z.number()),
  leaderboards: z.object({
    /** key = personId */
    mostSessions: z.array(LeaderboardEntry),
    mostParallel: z.array(LeaderboardEntry),
    mostSubagents: z.array(LeaderboardEntry),
    /** key = project basename */
    busiestProjects: z.array(LeaderboardEntry),
  }),
  /** personId -> latest display name seen (best effort) */
  names: z.record(z.string(), z.string()),
});
export type StatsResponse = z.infer<typeof StatsResponse>;

export const SnapshotMeta = z.object({
  id: z.number(),
  ts: z.number(),
  size: z.number(),
  /** relative URL of the PNG */
  url: z.string(),
});
export type SnapshotMeta = z.infer<typeof SnapshotMeta>;
export const SnapshotList = z.object({ snapshots: z.array(SnapshotMeta) });
export type SnapshotList = z.infer<typeof SnapshotList>;
