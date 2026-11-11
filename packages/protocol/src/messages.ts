/**
 * Zod schemas + inferred types for every wire message (PLAN "WebSocket protocol").
 *
 * Channels (one discriminated union each, so `switch (msg.type)` is exhaustive):
 *   ConnectorToServer  connector -> server on /ws/connector
 *   ServerToConnector  server -> connector on /ws/connector
 *   ServerToViewer     server -> viewer    on /ws/viewer (viewers act via POST /api/interact)
 *
 * Parsers never throw; they return { ok: true, msg } | { ok: false, error }.
 */
import { z } from "zod";
import { ViewerAvatar } from "./catalog.ts";
import { MAX_SELF_DESCRIPTION, PROTOCOL_VERSION, SHORT_SELF_DESCRIPTION } from "./constants.ts";
import { MessageRecord } from "./officeMessages.ts";
import { ViewerPartyState } from "./party.ts";

// ---- building blocks ----------------------------------------------------------------------
export const AGENTS = ["claude", "codex", "pi", "unknown"] as const;
/**
 * Unknown kinds (from a newer connector or server) degrade to "unknown" instead of failing the
 * whole message, so an old viewer keeps showing the office when a kind is added.
 */
export const AgentKind = z.enum(AGENTS).catch("unknown");
export type AgentKind = z.infer<typeof AgentKind>;

/**
 * typing   edit/write tools
 * reading  read/grep/glob/search
 * running  bash/shell
 * thinking assistant turn, no tool yet (also unknown tools)
 * waiting  turn finished, waiting for the human
 * idle     no transcript writes for 2+ min, process alive
 */
export const ACTIVITIES = ["typing", "reading", "running", "thinking", "waiting", "idle"] as const;
export const Activity = z.enum(ACTIVITIES);
export type Activity = z.infer<typeof Activity>;

const EpochMs = z.number().int().nonnegative();
/** Hashed session id from the connector (never the raw agent session id). */
export const SessionKey = z.string().min(8).max(64);
/** Random per-install id of a connector (one per laptop). */
export const ClientId = z.string().min(1).max(64);
export const PersonId = z.string().min(1).max(64);
/** Stable viewer-side session id: `${clientId}:${sessionKey}`. */
export const SessionId = z.string().min(1).max(130);
export const ProjectName = z.string().max(80);
/** Share of the model's context window in use, 0..1 (rounded; omitted when unknown). */
export const ContextShare = z.number().min(0).max(1);
/** User-chosen label of the machine a connector runs on ("laptop", "devbox"). Optional. */
export const MachineName = z.string().trim().max(40);
/** What a person's subagents look like in the office (connector `helpers`); default robots. */
export const HELPER_SKINS = ["robots", "cats"] as const;
export const HelperSkin = z.enum(HELPER_SKINS);
export type HelperSkin = z.infer<typeof HelperSkin>;

export function sessionIdOf(clientId: string, sessionKey: string): string {
  return `${clientId}:${sessionKey}`;
}

/** One live agent session as reported by a connector. Status metadata only. */
export const SessionInfo = z.object({
  sessionKey: SessionKey,
  agent: AgentKind,
  /** project folder basename; omitted when disabled in connector config */
  project: ProjectName.optional(),
  activity: Activity,
  subagents: z.number().int().nonnegative(),
  startedAt: EpochMs,
  context: ContextShare.optional(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

/** A session as viewers see it. */
export const SessionView = z.object({
  sessionId: SessionId,
  agent: AgentKind,
  project: ProjectName.optional(),
  activity: Activity,
  subagents: z.number().int().nonnegative(),
  startedAt: EpochMs,
  /** label of the machine the session runs on (connector `machine_name`); optional */
  machine: MachineName.optional(),
  /** the session's connector missed its heartbeat (laptop asleep, offline, crashed) */
  offline: z.boolean().optional(),
  context: ContextShare.optional(),
});
export type SessionView = z.infer<typeof SessionView>;

export const PersonView = z.object({
  personId: PersonId,
  name: z.string().min(1).max(40),
  avatar: ViewerAvatar,
  sessions: z.array(SessionView),
  joinedAt: EpochMs,
  /** opt-in (connector `birthday = "MM-DD"`): it is their birthday in the office time zone */
  birthday: z.boolean().optional(),
  /** opt-in (connector `helpers = "cats"`): their subagents are kittens; omitted = robots */
  helpers: HelperSkin.optional(),
});
export type PersonView = z.infer<typeof PersonView>;

// ---- envelope schema factory --------------------------------------------------------------
function msg<const T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    id: z.string().min(1).max(64),
    ts: EpochMs,
    data,
  });
}

// ---- connector -> server ------------------------------------------------------------------
/**
 * Local AI command-line tools a connector can draw its person's look with, on that person's own
 * subscription (Claude Code `claude -p`, run without tools). No shared API key involved.
 */
export const LOOK_GENERATORS = ["claude"] as const;
export const LookGenerator = z.enum(LOOK_GENERATORS);
export type LookGenerator = z.infer<typeof LookGenerator>;

export const ConnectorHello = msg(
  "connector.hello",
  z.object({
    name: z.string().trim().min(1).max(40),
    password: z.string().max(256),
    clientId: ClientId,
    connectorVersion: z.string().min(1).max(32),
    /** free-text look description for GenUI, e.g. "curly hair, round glasses" (first 200 chars) */
    selfDescription: z.string().max(SHORT_SELF_DESCRIPTION).optional(),
    /** full look description when longer than 200 chars; older servers ignore it */
    lookDescription: z.string().max(MAX_SELF_DESCRIPTION).optional(),
    /** e.g. "darwin-arm64" */
    platform: z.string().max(40).optional(),
    /** user-chosen machine label shown on the agent card; older connectors omit it */
    machine: MachineName.optional(),
    /** opt-in "MM-DD"; only "is it today" is ever shown */
    birthday: z
      .string()
      .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
      .optional(),
    /** local AI tools this Mac can draw the look with, preferred first; older ones omit it */
    lookGenerators: z.array(LookGenerator).max(LOOK_GENERATORS.length).optional(),
    /** what this person's subagents look like; older connectors omit it (= robots) */
    helpers: HelperSkin.optional(),
  }),
);
export const PresenceSnapshot = msg(
  "presence.snapshot",
  z.object({ sessions: z.array(SessionInfo).max(200) }),
);
export const ConnectorBye = msg("connector.bye", z.object({}));

/**
 * Answer to `connector.lookRequested`: the look a local AI drew (`avatar`, untrusted: the server
 * repairs and scores it like any AI answer) or why it could not (`error`).
 */
export const ConnectorLookGenerated = msg(
  "connector.lookGenerated",
  z.object({
    requestId: z.string().min(1).max(64),
    generator: LookGenerator,
    avatar: z.unknown().optional(),
    error: z.string().max(300).optional(),
  }),
);

export const ConnectorToServer = z.discriminatedUnion("type", [
  ConnectorHello,
  PresenceSnapshot,
  ConnectorBye,
  ConnectorLookGenerated,
]);
export type ConnectorToServer = z.infer<typeof ConnectorToServer>;

// ---- server -> connector ------------------------------------------------------------------
export const REJECT_REASONS = ["bad_password", "too_old", "bad_message"] as const;
export const RejectReason = z.enum(REJECT_REASONS);
export type RejectReason = z.infer<typeof RejectReason>;

export const ConnectorWelcomed = msg(
  "connector.welcomed",
  z.object({
    personId: PersonId,
    serverVersion: z.string(),
    latestConnectorVersion: z.string(),
    minConnectorVersion: z.string(),
  }),
);
export const ConnectorRejected = msg(
  "connector.rejected",
  z.object({ reason: RejectReason, message: z.string().max(500).optional() }),
);

/** A viewer waved at / messaged this connector's person; show it as a desktop notification. */
export const ConnectorPoked = msg(
  "connector.poked",
  z.object({
    kind: z.enum(["wave", "coffee", "cheer", "message", "cat"]),
    from: z.string().max(40).optional(),
    text: z.string().max(200),
  }),
);

/**
 * Draw this person's look with a local AI tool (the person's own subscription) and answer with
 * `connector.lookGenerated`. The server sends the prompt and the JSON schema, so the catalog
 * can grow without a connector release. Older connectors ignore it.
 */
export const ConnectorLookRequested = msg(
  "connector.lookRequested",
  z.object({
    requestId: z.string().min(1).max(64),
    system: z.string().max(20_000),
    prompt: z.string().max(MAX_SELF_DESCRIPTION + 1_000),
    schema: z.record(z.string(), z.unknown()),
  }),
);

export const ServerToConnector = z.discriminatedUnion("type", [
  ConnectorWelcomed,
  ConnectorRejected,
  ConnectorPoked,
  ConnectorLookRequested,
]);
export type ServerToConnector = z.infer<typeof ServerToConnector>;

// ---- server -> viewer ---------------------------------------------------------------------
export const OfficeSnapshot = msg(
  "office.snapshot",
  z.object({
    officeName: z.string(),
    party: ViewerPartyState.optional().catch(undefined),
    serverTime: EpochMs,
    people: z.array(PersonView),
    /** IANA zone of the office (for day/night lighting), e.g. "Europe/Vienna" */
    timezone: z.string().max(64).optional(),
    /** deployed version (newest connector release, e.g. "0.1.42") */
    version: z.string().max(40).optional(),
    /** today's numbers from the server's history, so a reload doesn't reset the whiteboard */
    today: z
      .object({
        started: z.number().int().nonnegative(),
        peak: z.number().int().nonnegative(),
        /** sessions running every 5 min over the last 40 min, oldest first */
        recent: z.array(z.number().int().nonnegative()).max(12),
      })
      .optional(),
  }),
);
export const PersonJoined = msg("person.joined", z.object({ person: PersonView }));
export const PersonLeft = msg("person.left", z.object({ personId: PersonId }));
export const SessionStarted = msg(
  "session.started",
  z.object({ personId: PersonId, session: SessionView }),
);
export const SessionEnded = msg(
  "session.ended",
  z.object({ personId: PersonId, sessionId: SessionId }),
);
export const SessionActivityChanged = msg(
  "session.activityChanged",
  z.object({ personId: PersonId, sessionId: SessionId, activity: Activity, previous: Activity }),
);
/** `count` = the session's subagent count after this unit change (one event per unit). */
export const SubagentSpawned = msg(
  "subagent.spawned",
  z.object({ personId: PersonId, sessionId: SessionId, count: z.number().int().nonnegative() }),
);
export const SubagentFinished = msg(
  "subagent.finished",
  z.object({ personId: PersonId, sessionId: SessionId, count: z.number().int().nonnegative() }),
);
export const AvatarUpdated = msg(
  "avatar.updated",
  z.object({ personId: PersonId, avatar: ViewerAvatar }),
);
/** Context use moved by at least one 5% step (connectors round to 0.05). */
export const SessionContextChanged = msg(
  "session.contextChanged",
  z.object({ personId: PersonId, sessionId: SessionId, context: ContextShare.nullable() }),
);
export const PersonBirthdayChanged = msg(
  "person.birthdayChanged",
  z.object({ personId: PersonId, birthday: z.boolean() }),
);
/** The person's helper skin changed (robots <-> cats). */
export const PersonHelpersChanged = msg(
  "person.helpersChanged",
  z.object({ personId: PersonId, helpers: HelperSkin }),
);
export const SessionConnectionChanged = msg(
  "session.connectionChanged",
  z.object({ personId: PersonId, sessionId: SessionId, offline: z.boolean() }),
);

/**
 * wave/coffee/cheer/message  poke a person (also a notification on their Macs)
 * paper / tomato             throw a paper ball / a tomato at a person (office only)
 * cat                        send an office cat to sit on a person's desk (also a notification)
 * pet / feed / yarn          pet an office cat, drop a food bowl or a yarn ball next to it
 * laser                      a laser dot on the floor that the cats chase
 */
export const INTERACTIONS = [
  "wave",
  "coffee",
  "cheer",
  "message",
  "paper",
  "tomato",
  "cat",
  "pet",
  "feed",
  "yarn",
  "laser",
] as const;
export const InteractionKind = z.enum(INTERACTIONS);
export type InteractionKind = z.infer<typeof InteractionKind>;
/** Interactions with the office cats themselves (no person involved). */
export const CAT_INTERACTIONS = ["pet", "feed", "yarn", "laser"] as const;
export type CatInteraction = (typeof CAT_INTERACTIONS)[number];
export function isCatInteraction(kind: InteractionKind): kind is CatInteraction {
  return (CAT_INTERACTIONS as readonly string[]).includes(kind);
}
/** Interactions that need a spot on the floor (`x`, `y`). */
export const SPOT_INTERACTIONS = ["feed", "yarn", "laser"] as const;
export function needsSpot(kind: InteractionKind): boolean {
  return (SPOT_INTERACTIONS as readonly string[]).includes(kind);
}
/** At most this many office cats (one more for every two people, see the web client). */
export const MAX_CATS = 10;
/** Which office cat (slot 0 is the original one). */
export const CatId = z
  .number()
  .int()
  .min(0)
  .max(MAX_CATS - 1);
/** A floor spot in world pixels. */
export const WorldCoord = z.number().int().min(0).max(8192);
/** Short name a viewer signs pokes with; viewers are otherwise anonymous. */
export const ViewerName = z.string().trim().max(40);
export const InteractionText = z.string().trim().max(80);

/** Something a viewer did, replayed for every viewer. Not part of the office state. */
export const InteractionHappened = msg(
  "interaction.happened",
  z.object({
    kind: InteractionKind,
    personId: PersonId.optional(),
    from: ViewerName.optional(),
    text: InteractionText.optional(),
    /** how many connector sockets accepted the notification */
    delivered: z.number().int().nonnegative().optional(),
    /** cat interactions and `cat`: which office cat */
    catId: CatId.optional(),
    /** feed / yarn / laser: the floor spot */
    x: WorldCoord.optional(),
    y: WorldCoord.optional(),
  }),
);

export const MessageSent = msg("message.sent", z.object({ message: MessageRecord }));
export const MessageDeleted = msg(
  "message.deleted",
  z.object({ messageId: z.string().min(1).max(64) }),
);

export const PartyUpdated = msg("party.updated", z.object({ party: ViewerPartyState }));

export const ServerToViewer = z.discriminatedUnion("type", [
  OfficeSnapshot,
  MessageSent,
  MessageDeleted,
  PartyUpdated,
  PersonJoined,
  PersonLeft,
  SessionStarted,
  SessionEnded,
  SessionActivityChanged,
  SubagentSpawned,
  SubagentFinished,
  AvatarUpdated,
  SessionConnectionChanged,
  SessionContextChanged,
  PersonBirthdayChanged,
  PersonHelpersChanged,
  InteractionHappened,
]);
export type ServerToViewer = z.infer<typeof ServerToViewer>;

// ---- type helpers -------------------------------------------------------------------------
export type AnyMessage = ConnectorToServer | ServerToConnector | ServerToViewer;
export type MessageType = AnyMessage["type"];
export type MessageOf<T extends MessageType> = Extract<AnyMessage, { type: T }>;
export type MessageData<T extends MessageType> = MessageOf<T>["data"];
/** What the server's diff() emits: everything but snapshots and transient interaction/party updates. */
export type ViewerEvent = Exclude<
  ServerToViewer,
  {
    type:
      | "office.snapshot"
      | "interaction.happened"
      | "party.updated"
      | "message.sent"
      | "message.deleted";
  }
>;

export const CONNECTOR_TO_SERVER_TYPES = ConnectorToServer.options.map((o) => o.shape.type.value);
export const SERVER_TO_CONNECTOR_TYPES = ServerToConnector.options.map((o) => o.shape.type.value);
export const SERVER_TO_VIEWER_TYPES = ServerToViewer.options.map((o) => o.shape.type.value);

// ---- parsers ------------------------------------------------------------------------------
export type ParseResult<T> = { ok: true; msg: T } | { ok: false; error: string };

function parseWith<S extends z.ZodType>(schema: S, input: unknown): ParseResult<z.infer<S>> {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, error: "invalid JSON" };
    }
  }
  if (value === null || typeof value !== "object") return { ok: false, error: "not an object" };
  const v = (value as { v?: unknown }).v;
  if (v !== PROTOCOL_VERSION) return { ok: false, error: `unsupported protocol version: ${v}` };
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, msg: r.data };
  return { ok: false, error: z.prettifyError(r.error) };
}

/**
 * Parse a message received from a connector. Accepts a raw JSON string or an already
 * parsed value. Never throws.
 */
export function parseConnectorMessage(json: unknown): ParseResult<ConnectorToServer> {
  return parseWith(ConnectorToServer, json);
}
/** Parse a message the connector received from the server. Never throws. */
export function parseServerToConnector(json: unknown): ParseResult<ServerToConnector> {
  return parseWith(ServerToConnector, json);
}
/** Parse a message a viewer received from the server. Never throws. */
export function parseViewerMessage(json: unknown): ParseResult<ServerToViewer> {
  return parseWith(ServerToViewer, json);
}

/** For exhaustive switches: `default: assertNever(msg)`. */
export function assertNever(x: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(x)}`);
}
