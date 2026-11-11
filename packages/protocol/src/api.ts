/**
 * HTTP API shapes served by the Worker (not WebSocket messages):
 *   GET  /api/stats            -> StatsResponse
 *   GET  /api/snapshots        -> SnapshotList
 *   GET  /api/people/:personId -> PersonDayResponse
 *   POST /api/history/backfill <- HistoryRow[]   (Bearer CONNECTOR_PASSWORD)
 *   POST /api/interact         <- InteractRequest -> InteractResponse
 */
import { z } from "zod";
import {
  Activity,
  AgentKind,
  InteractionKind,
  InteractionText,
  PersonId,
  ViewerName,
} from "./messages.ts";

/** A viewer pokes a person, throws a paper ball or pets the cat. */
export const InteractRequest = z
  .object({
    kind: InteractionKind,
    personId: PersonId.optional(),
    from: ViewerName.optional(),
    text: InteractionText.optional(),
  })
  .refine((r) => r.kind === "pet" || !!r.personId, { message: "personId required" })
  .refine((r) => r.kind !== "message" || !!r.text, { message: "text required" });
export type InteractRequest = z.infer<typeof InteractRequest>;

export const InteractResponse = z.object({ ok: z.boolean(), delivered: z.number() });
export type InteractResponse = z.infer<typeof InteractResponse>;

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

/** One person's "today" numbers (office time zone), for the agent card. */
export const PersonDayResponse = z.object({
  personId: z.string(),
  /** latest display name seen, null when unknown */
  name: z.string().nullable(),
  timezone: z.string(),
  /** start of "today" in the office time zone (epoch ms) */
  dayStart: z.number(),
  generatedAt: z.number(),
  /** in the office right now */
  online: z.boolean(),
  /** session.started rows today */
  sessionsToday: z.number(),
  /** most sessions running at once today (live sessions count too) */
  peakParallelToday: z.number(),
  /** subagent.spawned rows today + subagents of sessions started today */
  subagentsToday: z.number(),
  /**
   * Recent activity changes of the person's live sessions (server clock, last ~30 min, kept in
   * memory only), sessionId -> oldest first. The first entry is when the server saw it.
   */
  recentActivity: z.record(z.string(), z.array(z.object({ activity: Activity, at: z.number() }))),
});
export type PersonDayResponse = z.infer<typeof PersonDayResponse>;
