/**
 * Pure state diff: turns two office states into the named viewer events of PLAN
 * "Server -> viewers". No I/O, no clocks (the timestamp is passed in).
 *
 * Ordering guarantees (per call):
 *   1. session.ended        (sessions that disappeared, incl. those of leaving people)
 *   2. person.left          (after all of that person's session.ended)
 *   3. person.joined        (person carries `sessions: []`; sessions follow as session.started)
 *   4. avatar.updated       (people present in both states whose look changed)
 *   5. session.started
 *   6. session.activityChanged, session.connectionChanged
 *   7. subagent.spawned / subagent.finished (one event per unit, with the running count)
 */
import {
  envelope,
  type PersonView,
  type SessionView,
  type ViewerEvent,
} from "@agent-office/protocol";

export type OfficeState = { people: PersonView[] };

export const EMPTY_STATE: OfficeState = { people: [] };

const byId = <T, K>(items: readonly T[], key: (t: T) => K) =>
  new Map(items.map((i) => [key(i), i]));

function sameAvatar(a: PersonView["avatar"], b: PersonView["avatar"]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diff(prev: OfficeState, next: OfficeState, ts: number = Date.now()): ViewerEvent[] {
  const prevPeople = byId(prev.people, (p) => p.personId);
  const nextPeople = byId(next.people, (p) => p.personId);

  const ended: ViewerEvent[] = [];
  const left: ViewerEvent[] = [];
  const joined: ViewerEvent[] = [];
  const avatars: ViewerEvent[] = [];
  const started: ViewerEvent[] = [];
  const activity: ViewerEvent[] = [];
  const subagents: ViewerEvent[] = [];

  for (const p of prev.people) {
    const n = nextPeople.get(p.personId);
    const nextSessions = byId(n?.sessions ?? [], (s) => s.sessionId);
    for (const s of p.sessions) {
      if (!nextSessions.has(s.sessionId)) {
        ended.push(
          envelope("session.ended", { personId: p.personId, sessionId: s.sessionId }, { ts }),
        );
      }
    }
    if (!n) left.push(envelope("person.left", { personId: p.personId }, { ts }));
  }

  for (const n of next.people) {
    const p = prevPeople.get(n.personId);
    if (!p) {
      joined.push(envelope("person.joined", { person: { ...n, sessions: [] } }, { ts }));
    } else if (!sameAvatar(p.avatar, n.avatar)) {
      avatars.push(envelope("avatar.updated", { personId: n.personId, avatar: n.avatar }, { ts }));
    }
    const prevSessions = byId<SessionView, string>(p?.sessions ?? [], (s) => s.sessionId);
    for (const s of n.sessions) {
      const old = prevSessions.get(s.sessionId);
      if (!old) {
        started.push(envelope("session.started", { personId: n.personId, session: s }, { ts }));
        continue;
      }
      if (old.activity !== s.activity) {
        activity.push(
          envelope(
            "session.activityChanged",
            {
              personId: n.personId,
              sessionId: s.sessionId,
              activity: s.activity,
              previous: old.activity,
            },
            { ts },
          ),
        );
      }
      if (!!old.offline !== !!s.offline) {
        activity.push(
          envelope(
            "session.connectionChanged",
            { personId: n.personId, sessionId: s.sessionId, offline: !!s.offline },
            { ts },
          ),
        );
      }
      const base = { personId: n.personId, sessionId: s.sessionId };
      for (let c = old.subagents + 1; c <= s.subagents; c++) {
        subagents.push(envelope("subagent.spawned", { ...base, count: c }, { ts }));
      }
      for (let c = old.subagents - 1; c >= s.subagents; c--) {
        subagents.push(envelope("subagent.finished", { ...base, count: c }, { ts }));
      }
    }
  }

  return [...ended, ...left, ...joined, ...avatars, ...started, ...activity, ...subagents];
}

/**
 * Apply events to a state (the viewer-side reducer). Used by tests to prove
 * `apply(prev, diff(prev, next)) == next`, and handy for any consumer.
 */
export function applyEvents(state: OfficeState, events: readonly ViewerEvent[]): OfficeState {
  const people = new Map(
    state.people.map((p) => [p.personId, { ...p, sessions: [...p.sessions] }]),
  );
  const withSession = (personId: string, sessionId: string, f: (s: SessionView) => SessionView) => {
    const p = people.get(personId);
    if (!p) return;
    p.sessions = p.sessions.map((s) => (s.sessionId === sessionId ? f(s) : s));
  };
  for (const e of events) {
    switch (e.type) {
      case "person.joined":
        people.set(e.data.person.personId, {
          ...e.data.person,
          sessions: [...e.data.person.sessions],
        });
        break;
      case "person.left":
        people.delete(e.data.personId);
        break;
      case "avatar.updated": {
        const p = people.get(e.data.personId);
        if (p) p.avatar = e.data.avatar;
        break;
      }
      case "session.started": {
        const p = people.get(e.data.personId);
        if (p) p.sessions.push(e.data.session);
        break;
      }
      case "session.ended": {
        const p = people.get(e.data.personId);
        if (p) p.sessions = p.sessions.filter((s) => s.sessionId !== e.data.sessionId);
        break;
      }
      case "session.activityChanged":
        withSession(e.data.personId, e.data.sessionId, (s) => ({
          ...s,
          activity: e.data.activity,
        }));
        break;
      case "subagent.spawned":
      case "subagent.finished":
        withSession(e.data.personId, e.data.sessionId, (s) => ({ ...s, subagents: e.data.count }));
        break;
      case "session.connectionChanged":
        withSession(e.data.personId, e.data.sessionId, ({ offline: _o, ...s }) =>
          e.data.offline ? { ...s, offline: true } : s,
        );
        break;
    }
  }
  return { people: [...people.values()] };
}
