/**
 * Client-side office model: applies `office.snapshot` + viewer events and returns small
 * semantic changes the renderer animates. Pure (no DOM, no Pixi), clock injectable.
 *
 * Also owns stable seating: each person gets the lowest free pod, each session the
 * lowest free desk in that pod (desk >= DESKS_PER_POD means "no desk, roams").
 */
import {
  type Activity,
  type AgentKind,
  type AvatarSpec,
  avatarFromSeed,
  type PersonView,
  type ServerToViewer,
  type SessionView,
} from "@agent-office/protocol";

export type PersonState = {
  personId: string;
  name: string;
  avatar: AvatarSpec;
  joinedAt: number;
  pod: number;
};

export type SessionState = {
  sessionId: string;
  personId: string;
  agent: AgentKind;
  project: string | undefined;
  activity: Activity;
  subagents: number;
  startedAt: number;
  desk: number;
  /** when the activity last changed (client clock) */
  activitySince: number;
};

export type ModelChange =
  | { kind: "officeRenamed"; name: string }
  | { kind: "personAdded"; personId: string; instant: boolean }
  | { kind: "personRemoved"; personId: string; instant: boolean }
  | { kind: "avatarChanged"; personId: string }
  | { kind: "sessionAdded"; personId: string; sessionId: string; instant: boolean }
  | { kind: "sessionRemoved"; personId: string; sessionId: string; instant: boolean }
  | {
      kind: "activityChanged";
      personId: string;
      sessionId: string;
      activity: Activity;
      previous: Activity;
    }
  | {
      kind: "subagentsChanged";
      personId: string;
      sessionId: string;
      count: number;
      previous: number;
    };

export type OfficeStats = {
  people: number;
  sessions: number;
  subagents: number;
  /** most sessions at once today (local day) */
  peakToday: number;
  /** sessions started today (seen by this viewer, snapshot counts started-today) */
  startedToday: number;
  byAgent: Record<AgentKind, number>;
};

/** sessions beyond this many desks roam (renderer: `MAX_DESKS` in world/map.ts) */
const DESKS_PER_POD = 6;

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export class OfficeModel {
  officeName = "Agent Office";
  timezone: string | undefined;
  /** server clock minus local clock, from the last snapshot */
  clockSkew = 0;
  readonly people = new Map<string, PersonState>();
  readonly sessions = new Map<string, SessionState>();
  private peak = 0;
  private started = 0;
  private day = "";
  private startedIds = new Set<string>();
  hasSnapshot = false;

  constructor(private readonly now: () => number = Date.now) {}

  // ---- queries --------------------------------------------------------------------------
  sessionsOf(personId: string): SessionState[] {
    const out: SessionState[] = [];
    for (const s of this.sessions.values()) if (s.personId === personId) out.push(s);
    return out.sort((a, b) => a.desk - b.desk);
  }

  /** Highest pod index in use + 1 (renderer grows the map from this). */
  podCount(): number {
    let n = 0;
    for (const p of this.people.values()) n = Math.max(n, p.pod + 1);
    return n;
  }

  stats(): OfficeStats {
    this.rollDay();
    const byAgent: Record<AgentKind, number> = { claude: 0, codex: 0, pi: 0, unknown: 0 };
    let subagents = 0;
    for (const s of this.sessions.values()) {
      byAgent[s.agent]++;
      subagents += s.subagents;
    }
    return {
      people: this.people.size,
      sessions: this.sessions.size,
      subagents,
      peakToday: this.peak,
      startedToday: this.started,
      byAgent,
    };
  }

  // ---- apply ----------------------------------------------------------------------------
  apply(msg: ServerToViewer): ModelChange[] {
    const out: ModelChange[] = [];
    switch (msg.type) {
      case "office.snapshot": {
        const d = msg.data;
        this.timezone = d.timezone;
        this.clockSkew = d.serverTime - this.now();
        if (d.officeName && d.officeName !== this.officeName) {
          this.officeName = d.officeName;
          out.push({ kind: "officeRenamed", name: d.officeName });
        }
        const seen = new Set(d.people.map((p) => p.personId));
        for (const p of [...this.people.values()]) {
          if (!seen.has(p.personId)) this.removePerson(p.personId, true, out);
        }
        for (const pv of d.people) this.upsertPerson(pv, true, out);
        this.hasSnapshot = true;
        break;
      }
      case "person.joined":
        this.upsertPerson(msg.data.person, false, out);
        break;
      case "person.left":
        this.removePerson(msg.data.personId, false, out);
        break;
      case "session.started": {
        const { personId, session } = msg.data;
        if (!this.people.has(personId)) {
          this.addPerson(
            {
              personId,
              name: personId,
              avatar: avatarFromSeed(personId),
              sessions: [],
              joinedAt: msg.ts,
            },
            false,
            out,
          );
        }
        this.upsertSession(personId, session, false, out);
        break;
      }
      case "session.ended":
        this.removeSession(msg.data.sessionId, false, out);
        break;
      case "session.activityChanged": {
        const s = this.sessions.get(msg.data.sessionId);
        if (s && s.activity !== msg.data.activity) {
          const previous = s.activity;
          s.activity = msg.data.activity;
          s.activitySince = this.now();
          out.push({
            kind: "activityChanged",
            personId: s.personId,
            sessionId: s.sessionId,
            activity: s.activity,
            previous,
          });
        }
        break;
      }
      case "subagent.spawned":
      case "subagent.finished": {
        const s = this.sessions.get(msg.data.sessionId);
        if (s && s.subagents !== msg.data.count) {
          const previous = s.subagents;
          s.subagents = msg.data.count;
          out.push({
            kind: "subagentsChanged",
            personId: s.personId,
            sessionId: s.sessionId,
            count: s.subagents,
            previous,
          });
        }
        break;
      }
      case "avatar.updated": {
        const p = this.people.get(msg.data.personId);
        if (p) {
          p.avatar = msg.data.avatar;
          out.push({ kind: "avatarChanged", personId: p.personId });
        }
        break;
      }
    }
    this.trackPeak();
    return out;
  }

  // ---- internals ------------------------------------------------------------------------
  private rollDay() {
    const k = dayKey(this.now());
    if (k !== this.day) {
      this.day = k;
      this.peak = this.sessions.size;
      this.started = 0;
      this.startedIds.clear();
      const dayStart = new Date(this.now());
      dayStart.setHours(0, 0, 0, 0);
      for (const s of this.sessions.values()) this.countStart(s.sessionId, s.startedAt, dayStart);
    }
  }

  private countStart(sessionId: string, startedAt: number, dayStart?: Date) {
    const start = dayStart ?? new Date(this.now());
    if (!dayStart) start.setHours(0, 0, 0, 0);
    if (startedAt - this.clockSkew >= start.getTime() && !this.startedIds.has(sessionId)) {
      this.startedIds.add(sessionId);
      this.started++;
    }
  }

  private trackPeak() {
    this.rollDay();
    this.peak = Math.max(this.peak, this.sessions.size);
  }

  private freePod(): number {
    const used = new Set([...this.people.values()].map((p) => p.pod));
    let i = 0;
    while (used.has(i)) i++;
    return i;
  }

  private freeDesk(personId: string): number {
    const used = new Set(this.sessionsOf(personId).map((s) => s.desk));
    let i = 0;
    while (used.has(i)) i++;
    return i;
  }

  private addPerson(pv: PersonView, instant: boolean, out: ModelChange[]) {
    this.people.set(pv.personId, {
      personId: pv.personId,
      name: pv.name,
      avatar: pv.avatar,
      joinedAt: pv.joinedAt,
      pod: this.freePod(),
    });
    out.push({ kind: "personAdded", personId: pv.personId, instant });
  }

  private upsertPerson(pv: PersonView, instant: boolean, out: ModelChange[]) {
    const existing = this.people.get(pv.personId);
    if (!existing) {
      this.addPerson(pv, instant, out);
    } else {
      existing.name = pv.name;
      if (JSON.stringify(existing.avatar) !== JSON.stringify(pv.avatar)) {
        existing.avatar = pv.avatar;
        out.push({ kind: "avatarChanged", personId: pv.personId });
      }
    }
    const keep = new Set(pv.sessions.map((s) => s.sessionId));
    for (const s of this.sessionsOf(pv.personId)) {
      if (!keep.has(s.sessionId)) this.removeSession(s.sessionId, instant, out);
    }
    for (const s of pv.sessions) this.upsertSession(pv.personId, s, instant, out);
  }

  private upsertSession(personId: string, sv: SessionView, instant: boolean, out: ModelChange[]) {
    const s = this.sessions.get(sv.sessionId);
    if (!s) {
      const state: SessionState = {
        sessionId: sv.sessionId,
        personId,
        agent: sv.agent,
        project: sv.project,
        activity: sv.activity,
        subagents: sv.subagents,
        startedAt: sv.startedAt,
        desk: this.freeDesk(personId),
        activitySince: this.now(),
      };
      this.sessions.set(sv.sessionId, state);
      this.rollDay();
      this.countStart(sv.sessionId, sv.startedAt);
      out.push({ kind: "sessionAdded", personId, sessionId: sv.sessionId, instant });
      return;
    }
    s.agent = sv.agent;
    s.project = sv.project;
    if (s.activity !== sv.activity) {
      const previous = s.activity;
      s.activity = sv.activity;
      s.activitySince = this.now();
      out.push({
        kind: "activityChanged",
        personId,
        sessionId: s.sessionId,
        activity: s.activity,
        previous,
      });
    }
    if (s.subagents !== sv.subagents) {
      const previous = s.subagents;
      s.subagents = sv.subagents;
      out.push({
        kind: "subagentsChanged",
        personId,
        sessionId: s.sessionId,
        count: s.subagents,
        previous,
      });
    }
  }

  private removeSession(sessionId: string, instant: boolean, out: ModelChange[]) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    out.push({ kind: "sessionRemoved", personId: s.personId, sessionId, instant });
  }

  private removePerson(personId: string, instant: boolean, out: ModelChange[]) {
    if (!this.people.has(personId)) return;
    for (const s of this.sessionsOf(personId)) this.removeSession(s.sessionId, instant, out);
    this.people.delete(personId);
    out.push({ kind: "personRemoved", personId, instant });
  }
}

export { DESKS_PER_POD };
