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
  type InteractionKind,
  type PartyState,
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
  /** it's their birthday today (opt-in on their connector) */
  birthday: boolean;
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
  /** machine label from the connector, if it sent one */
  machine: string | undefined;
  /** its connector stopped heartbeating (laptop asleep / offline) */
  offline: boolean;
  /** share of the context window in use (0..1), when the connector knows it */
  context: number | undefined;
  /** most subagents seen at once for this session (since this viewer saw it) */
  peakSubagents: number;
  /** activity changes seen by this viewer (client clock), oldest first, pruned to ~1 h */
  activityLog: { activity: Activity; at: number }[];
};

/** One colored piece of the agent card's activity strip. */
export type TimelineSegment = { activity: Activity; from: number; to: number };

/** How much activity history the model keeps per session. */
const ACTIVITY_LOG_MS = 60 * 60_000;

export type ModelChange =
  | { kind: "partyChanged" }
  | { kind: "officeRenamed"; name: string }
  | { kind: "personAdded"; personId: string; instant: boolean }
  | { kind: "personRemoved"; personId: string; instant: boolean }
  | { kind: "avatarChanged"; personId: string }
  | { kind: "birthdayChanged"; personId: string; birthday: boolean }
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
    }
  | { kind: "connectionChanged"; personId: string; sessionId: string; offline: boolean }
  | { kind: "contextChanged"; personId: string; sessionId: string; context: number | undefined }
  | {
      kind: "interaction";
      interaction: InteractionKind;
      personId: string | undefined;
      from: string | undefined;
      text: string | undefined;
      delivered: number | undefined;
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
  party: PartyState = { events: [], scores: {} };
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
  /** deployed version from the server */
  version: string | undefined;
  /** sessions running every 5 min over the last 40 min, from the server's history */
  recentSessions: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  // ---- queries --------------------------------------------------------------------------
  /**
   * The session's activity over the last `windowMs` (client clock) as segments, clipped to the
   * window. Time before this viewer first saw the session has no segment.
   */
  timeline(sessionId: string, windowMs = 30 * 60_000, now = this.now()): TimelineSegment[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    const from = now - windowMs;
    const out: TimelineSegment[] = [];
    s.activityLog.forEach((e, i) => {
      const end = s.activityLog[i + 1]?.at ?? now;
      if (end <= from) return;
      const seg = { activity: e.activity, from: Math.max(from, e.at), to: Math.min(now, end) };
      if (seg.to <= seg.from) return;
      const last = out.at(-1);
      if (last && last.activity === seg.activity && last.to === seg.from) last.to = seg.to;
      else out.push(seg);
    });
    return out;
  }

  /**
   * Prepend the server's recent activity log (server clock) to a session's client-side log, so
   * the agent card's timeline also covers the time before this page was opened.
   */
  mergeActivityHistory(sessionId: string, entries: readonly { activity: Activity; at: number }[]) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const first = s.activityLog[0]?.at ?? this.now();
    const older = entries
      .map((e) => ({ activity: e.activity, at: e.at - this.clockSkew }))
      .filter((e) => e.at < first);
    if (older.length > 0) s.activityLog = [...older, ...s.activityLog];
  }

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
        this.party = d.party ?? { events: [], scores: {} };
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
        this.version = d.version;
        if (d.today) {
          // the server's history knows the whole day; a reload must not reset the whiteboard
          this.rollDay();
          this.started = Math.max(this.started, d.today.started);
          for (const id of this.sessions.keys()) this.startedIds.add(id);
          this.peak = Math.max(this.peak, d.today.peak);
          this.recentSessions = [...d.today.recent];
        }
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
          this.logActivity(s);
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
          s.peakSubagents = Math.max(s.peakSubagents, s.subagents);
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
      case "session.connectionChanged": {
        const s = this.sessions.get(msg.data.sessionId);
        if (s) this.setOffline(s, msg.data.offline, out);
        break;
      }
      case "person.birthdayChanged": {
        const p = this.people.get(msg.data.personId);
        if (p && p.birthday !== msg.data.birthday) {
          p.birthday = msg.data.birthday;
          out.push({ kind: "birthdayChanged", personId: p.personId, birthday: p.birthday });
        }
        break;
      }
      case "session.contextChanged": {
        const s = this.sessions.get(msg.data.sessionId);
        if (s) this.setContext(s, msg.data.context ?? undefined, out);
        break;
      }
      case "message.sent":
        // Authored content is owned by MessageModel, never world/statistics state.
        break;
      case "interaction.happened": {
        const d = msg.data;
        if (d.kind === "message" && d.messageId) break;
        out.push({
          kind: "interaction",
          interaction: d.kind,
          personId: d.personId,
          from: d.from,
          text: d.text,
          delivered: d.delivered,
        });
        break;
      }
      case "party.updated":
        this.party = msg.data.party;
        out.push({ kind: "partyChanged" });
        break;
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
  private setContext(s: SessionState, context: number | undefined, out: ModelChange[]) {
    if (s.context === context) return;
    s.context = context;
    out.push({ kind: "contextChanged", personId: s.personId, sessionId: s.sessionId, context });
  }

  private setOffline(s: SessionState, offline: boolean, out: ModelChange[]) {
    if (s.offline === offline) return;
    s.offline = offline;
    out.push({ kind: "connectionChanged", personId: s.personId, sessionId: s.sessionId, offline });
  }

  private logActivity(s: SessionState) {
    const now = this.now();
    s.activityLog.push({ activity: s.activity, at: now });
    // keep the entry that was current at the window start
    while (s.activityLog.length > 1 && s.activityLog[1]!.at < now - ACTIVITY_LOG_MS)
      s.activityLog.shift();
  }

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

  moveDesk(sessionId: string, desk: number) {
    const s = this.sessions.get(sessionId);
    if (s) s.desk = desk;
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
      birthday: !!pv.birthday,
    });
    out.push({ kind: "personAdded", personId: pv.personId, instant });
  }

  private upsertPerson(pv: PersonView, instant: boolean, out: ModelChange[]) {
    const existing = this.people.get(pv.personId);
    if (!existing) {
      this.addPerson(pv, instant, out);
    } else {
      existing.name = pv.name;
      if (existing.birthday !== !!pv.birthday) {
        existing.birthday = !!pv.birthday;
        out.push({ kind: "birthdayChanged", personId: pv.personId, birthday: existing.birthday });
      }
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
        machine: sv.machine,
        offline: !!sv.offline,
        context: sv.context,
        peakSubagents: sv.subagents,
        activityLog: [{ activity: sv.activity, at: this.now() }],
      };
      this.sessions.set(sv.sessionId, state);
      this.rollDay();
      this.countStart(sv.sessionId, sv.startedAt);
      out.push({ kind: "sessionAdded", personId, sessionId: sv.sessionId, instant });
      return;
    }
    s.agent = sv.agent;
    s.project = sv.project;
    s.machine = sv.machine;
    this.setOffline(s, !!sv.offline, out);
    this.setContext(s, sv.context, out);
    if (s.activity !== sv.activity) {
      const previous = s.activity;
      s.activity = sv.activity;
      s.activitySince = this.now();
      this.logActivity(s);
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
      s.peakSubagents = Math.max(s.peakSubagents, s.subagents);
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
