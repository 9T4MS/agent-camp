/**
 * HTTP API shapes served by the Worker (not WebSocket messages):
 *   GET  /api/stats            -> StatsResponse
 *   GET  /api/snapshots        -> SnapshotList
 *   GET  /api/people/:personId -> PersonDayResponse
 *   POST /api/history/backfill <- HistoryRow[]   (Bearer CONNECTOR_PASSWORD)
 *   POST /api/interact         <- InteractRequest -> InteractResponse
 *   PUT  /api/people/:personId/avatar <- AvatarEditRequest -> AvatarEditResponse
 *   POST /api/people/:personId/look   <- LookDescribeRequest -> LookDescribeResponse
 *   PUT  /api/people/:personId/gif    <- SetGifRequest -> SetGifResponse
 * Errors are `ApiError` bodies.
 */
import { z } from "zod";
import { AvatarSpec } from "./catalog.ts";
import { MAX_SELF_DESCRIPTION } from "./constants.ts";
import { GiphyId } from "./giphy.ts";
import {
  Activity,
  AgentKind,
  CatId,
  InteractionKind,
  InteractionText,
  isCatInteraction,
  LookGenerator,
  needsSpot,
  PersonId,
  ViewerName,
  WorldCoord,
} from "./messages.ts";

/** A viewer pokes a person, throws a paper ball, or plays with the office cats. */
export const InteractRequest = z
  .object({
    kind: InteractionKind,
    personId: PersonId.optional(),
    from: ViewerName.optional(),
    text: InteractionText.optional(),
    catId: CatId.optional(),
    x: WorldCoord.optional(),
    y: WorldCoord.optional(),
  })
  .refine((r) => isCatInteraction(r.kind) || !!r.personId, { message: "personId required" })
  .refine((r) => r.kind !== "message" || !!r.text, { message: "text required" })
  .refine((r) => !needsSpot(r.kind) || (r.x !== undefined && r.y !== undefined), {
    message: "x and y required",
  });
export type InteractRequest = z.infer<typeof InteractRequest>;

export const InteractResponse = z.object({ ok: z.boolean(), delivered: z.number() });
export type InteractResponse = z.infer<typeof InteractResponse>;

/**
 * A viewer picks a person's look in the look editor (catalog ids only). `avatar: null` drops
 * the custom look and goes back to the automatic one (description / seed).
 */
export const AvatarEditRequest = z.object({
  avatar: AvatarSpec.nullable(),
  from: ViewerName.optional(),
});
export type AvatarEditRequest = z.infer<typeof AvatarEditRequest>;

export const AvatarEditResponse = z.object({
  ok: z.boolean(),
  /** the look now shown (for a reset: the current one until the new automatic look lands) */
  avatar: AvatarSpec,
  custom: z.boolean(),
  /** whether a description can become a look (a local AI on their Mac or GENUI_PROVIDER) */
  aiLooks: z.boolean().optional(),
  /** local AI tools on this person's live Macs that draw looks on their own subscription */
  localLooks: z.array(LookGenerator).optional(),
  /** the person's look description; only sent to that person's own browser */
  description: z.string().optional(),
});
export type AvatarEditResponse = z.infer<typeof AvatarEditResponse>;

/**
 * The owner describes their look in the look studio (same text a connector sends as its look
 * description). It becomes the person's description and the server's GenUI makes a new look.
 * Refused with 429 `{error}` (nothing changes) while their last Generate is still being drawn,
 * within 20 s of it, or once they used their daily Generates on the server's AI (5 by default;
 * looks drawn on their own Mac do not count).
 */
export const LookDescribeRequest = z.object({
  description: z.string().trim().min(1).max(MAX_SELF_DESCRIPTION),
});
export type LookDescribeRequest = z.infer<typeof LookDescribeRequest>;

export const LookDescribeResponse = z.object({
  ok: z.boolean(),
  /** the look now shown */
  avatar: AvatarSpec,
  /**
   * ai = a new look from the description; off = this server has no AI looks (the description
   * is saved and used once they are turned on); failed = error, refusal, unusable answer,
   * daily cap or the person's daily limit (the previous look stays, the next join retries);
   * pending = the person's own Mac is drawing it (`generator`), the new look arrives as
   * avatar.updated; superseded = the AI drew it, but the look changed meanwhile (a newer
   * Generate, a new description or a look picked in the editor), so that one stays
   */
  result: z.enum(["ai", "off", "failed", "pending", "superseded"]),
  generator: LookGenerator.optional(),
});
export type LookDescribeResponse = z.infer<typeof LookDescribeResponse>;

/** Error body of a failed API request. */
export const ApiError = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiError>;

/**
 * Set or remove the GIF over a person's head from the web UI. `link` is anything
 * `parseGiphyId` accepts (Giphy page/media link or bare id); null or "" removes the GIF.
 */
export const SetGifRequest = z.object({ link: z.string().max(2000).nullable() });
export type SetGifRequest = z.infer<typeof SetGifRequest>;

/** The person's GIF after the change; null = none. */
export const SetGifResponse = z.object({ personId: z.string(), gif: GiphyId.nullable() });
export type SetGifResponse = z.infer<typeof SetGifResponse>;

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
  /** wall of shame, today in the office time zone (top 5 each; waits in ms) */
  shame: z
    .object({
      clears: z.array(LeaderboardEntry),
      waits: z.array(LeaderboardEntry),
      fires: z.array(LeaderboardEntry),
    })
    .optional(),
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
