/** Privacy boundary for `status --json`: project names and all other free text stay local. */
import { ACTIVITIES, AGENTS, type SessionInfo } from "@agent-office/protocol";

export type SessionStatus = Pick<
  SessionInfo,
  "agent" | "activity" | "subagents" | "startedAt" | "context"
>;

export type StatusSnapshot = {
  schemaVersion: 1;
  connectorVersion: string;
  daemonRunning: boolean;
  connected: boolean;
  updatedAt: number | null;
  sessions: SessionStatus[];
};

type StatusOptions = {
  connectorVersion: string;
  now: number;
  pidAlive: (pid: number) => boolean;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function sessionStatus(value: unknown): SessionStatus | null {
  if (!record(value)) return null;
  const agent = AGENTS.find((agent) => agent === value.agent);
  const activity = ACTIVITIES.find((activity) => activity === value.activity);
  if (
    !agent ||
    !activity ||
    !nonnegativeInteger(value.subagents) ||
    !nonnegativeInteger(value.startedAt)
  ) {
    return null;
  }
  const session: SessionStatus = {
    agent,
    activity,
    subagents: value.subagents,
    startedAt: value.startedAt,
  };
  if (
    typeof value.context === "number" &&
    Number.isFinite(value.context) &&
    value.context >= 0 &&
    value.context <= 1
  ) {
    session.context = value.context;
  }
  return session;
}

/** No IO, config, or raw object spreading: the disk file is untrusted, even when valid JSON. */
export function statusSnapshot(raw: string | null, options: StatusOptions): StatusSnapshot {
  let status: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (record(parsed)) status = parsed;
  } catch {
    // Missing/corrupt status has the same health as a daemon that has never run.
  }
  const updatedAt = nonnegativeInteger(status.updatedAt) ? status.updatedAt : null;
  const daemonRunning =
    updatedAt !== null &&
    options.now >= updatedAt &&
    options.now - updatedAt < 10_000 &&
    nonnegativeInteger(status.pid) &&
    status.pid > 0 &&
    options.pidAlive(status.pid);
  const sessions: SessionStatus[] = [];
  if (daemonRunning && Array.isArray(status.sessions)) {
    for (const value of status.sessions) {
      const session = sessionStatus(value);
      if (session) sessions.push(session);
    }
  }
  return {
    schemaVersion: 1,
    connectorVersion: options.connectorVersion,
    daemonRunning,
    connected: daemonRunning && status.connected === true && status.welcomed === true,
    updatedAt,
    sessions,
  };
}
