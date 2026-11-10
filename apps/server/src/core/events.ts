/** Event -> readable log line and event -> history row. Pure. */
import type { HistoryRow, SessionView, ViewerEvent } from "@agent-office/protocol";
import type { OfficeState } from "./diff.ts";

export type SessionLookup = (personId: string, sessionId: string) => SessionView | undefined;

export function lookupIn(...states: OfficeState[]): SessionLookup {
  return (personId, sessionId) => {
    for (const st of states) {
      const s = st.people
        .find((p) => p.personId === personId)
        ?.sessions.find((x) => x.sessionId === sessionId);
      if (s) return s;
    }
    return undefined;
  };
}

function personOf(e: ViewerEvent): string {
  return e.type === "person.joined" ? e.data.person.personId : e.data.personId;
}

/** e.g. `session.started martin claude agent-office` */
export function logLine(e: ViewerEvent, lookup: SessionLookup): string {
  const person = personOf(e);
  switch (e.type) {
    case "person.joined":
      return `person.joined ${person} (${e.data.person.name})`;
    case "person.left":
    case "avatar.updated":
      return `${e.type} ${person}`;
    case "session.started":
      return `session.started ${person} ${e.data.session.agent} ${e.data.session.project ?? "-"}`;
    case "session.ended": {
      const s = lookup(person, e.data.sessionId);
      return `session.ended ${person} ${s?.agent ?? "?"} ${s?.project ?? "-"}`;
    }
    case "session.activityChanged": {
      const s = lookup(person, e.data.sessionId);
      return `session.activityChanged ${person} ${s?.agent ?? "?"} ${s?.project ?? "-"} ${e.data.previous}->${e.data.activity}`;
    }
    case "subagent.spawned":
    case "subagent.finished": {
      const s = lookup(person, e.data.sessionId);
      return `${e.type} ${person} ${s?.agent ?? "?"} ${s?.project ?? "-"} count=${e.data.count}`;
    }
  }
}

/** Event types not written to history (high volume, useless for stats). */
export const HISTORY_SKIP = new Set<ViewerEvent["type"]>(["session.activityChanged"]);

export function historyRow(e: ViewerEvent, lookup: SessionLookup): HistoryRow | null {
  if (HISTORY_SKIP.has(e.type)) return null;
  const person = personOf(e);
  const base: HistoryRow = {
    ts: e.ts,
    type: e.type,
    person,
    agent: null,
    project: null,
    subagents: null,
  };
  switch (e.type) {
    case "session.started":
      return {
        ...base,
        agent: e.data.session.agent,
        project: e.data.session.project ?? null,
        subagents: e.data.session.subagents,
      };
    case "session.ended": {
      const s = lookup(person, e.data.sessionId);
      return {
        ...base,
        agent: s?.agent ?? null,
        project: s?.project ?? null,
        subagents: s?.subagents ?? null,
      };
    }
    case "subagent.spawned":
    case "subagent.finished": {
      const s = lookup(person, e.data.sessionId);
      return {
        ...base,
        agent: s?.agent ?? null,
        project: s?.project ?? null,
        subagents: e.data.count,
      };
    }
    default:
      return base;
  }
}
