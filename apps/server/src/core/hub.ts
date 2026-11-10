/**
 * Runtime-agnostic hub: owns connectors, people and liveness, turns connector
 * messages into viewer events via `diff()`. No timers, no sockets, no Workers APIs:
 * callers pass `now`, call `tick(now)` at `nextDeadline()`, and deliver replies/events.
 */
import {
  type AvatarSpec,
  avatarFromSeed,
  CLOSE_BAD_MESSAGE,
  CLOSE_BAD_PASSWORD,
  CLOSE_TOO_OLD,
  CONNECTOR_TIMEOUT_MS,
  compareVersions,
  envelope,
  hashString,
  type MessageOf,
  PERSON_GRACE_MS,
  type PersonView,
  parseConnectorMessage,
  personIdFromName,
  type RejectReason,
  type ServerToConnector,
  type SessionInfo,
  type SessionView,
  sessionIdOf,
  type ViewerEvent,
} from "@agent-office/protocol";
import { diff, EMPTY_STATE, type OfficeState } from "./diff.ts";
import { historyRow, logLine, lookupIn } from "./events.ts";
import type { Store } from "./store.ts";

export type HubConfig = {
  /** shared connector password; empty/undefined rejects every connector */
  password: string | undefined;
  minConnectorVersion: string;
  latestConnectorVersion: string;
  serverVersion: string;
  officeName: string;
  timezone: string;
  /** cache key for a person's look; a change triggers an avatar job (GenUI) */
  avatarKey?: (name: string, selfDescription: string | undefined) => string;
};

/** What a socket learned from `connector.hello` (kept in the socket attachment in the DO). */
export type Binding = {
  clientId: string;
  name: string;
  personId: string;
  selfDescription?: string;
  connectorVersion: string;
};

type ConnectorRec = Binding & {
  socketId: string | null;
  lastSeen: number;
  sessions: SessionInfo[];
};

type PersonRec = {
  personId: string;
  name: string;
  joinedAt: number;
  /** when the person's last connector went away; null while one is live */
  goneSince: number | null;
  avatar: AvatarSpec;
};

export type AvatarJob = { personId: string; name: string; selfDescription?: string; key: string };

export type HubResult = {
  reply?: ServerToConnector;
  close?: { code: number; reason: string };
  events: ViewerEvent[];
  /** run GenUI for this person, then call `setAvatar` */
  avatarJob?: AvatarJob;
  /** new binding for this socket (persist it with the socket) */
  binding?: Binding;
};

type Persisted = { v: 1; connectors: ConnectorRec[]; people: PersonRec[] };

const STATE_KEY = "hub.state";
const NAMES_KEY = "hub.names";

export const defaultAvatarKey = (name: string, desc: string | undefined) =>
  `seed:${hashString(`${name}\n${desc ?? ""}`).toString(36)}`;

function safeEqual(a: string, b: string): boolean {
  let diffBits = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diffBits |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diffBits === 0;
}

export class Hub {
  private connectors = new Map<string, ConnectorRec>();
  private people = new Map<string, PersonRec>();
  /** socketId -> binding (only sockets that said hello) */
  private sockets = new Map<string, Binding>();
  private current: OfficeState = EMPTY_STATE;
  private persistedSig = "";
  private names: Record<string, string> = {};
  /** sink for readable event lines */
  log: (line: string) => void = () => {};

  constructor(
    private cfg: HubConfig,
    private store: Store,
  ) {
    try {
      this.names = JSON.parse(store.kvGet(NAMES_KEY) ?? "{}");
    } catch {
      this.names = {};
    }
  }

  // ---- public API -------------------------------------------------------------------------

  /** Restore after a DO restart / hibernation wake. Emits nothing. */
  restore(now: number, sockets: { socketId: string; binding: Binding | null }[] = []): void {
    const raw = this.store.kvGet(STATE_KEY);
    if (raw) {
      try {
        const p = JSON.parse(raw) as Persisted;
        for (const c of p.connectors ?? []) {
          // fresh liveness window: live connectors heartbeat again within 30 s
          this.connectors.set(c.clientId, { ...c, lastSeen: Math.max(c.lastSeen, now) });
        }
        for (const person of p.people ?? []) this.people.set(person.personId, person);
      } catch {
        // corrupt state: start empty
      }
    }
    for (const s of sockets) if (s.binding) this.sockets.set(s.socketId, s.binding);
    this.current = this.derive();
    this.persistedSig = this.signature();
  }

  onConnectorMessage(socketId: string, raw: unknown, now: number): HubResult {
    const parsed = parseConnectorMessage(raw);
    if (!parsed.ok)
      return this.reject("bad_message", CLOSE_BAD_MESSAGE, parsed.error.slice(0, 400));
    const msg = parsed.msg;
    switch (msg.type) {
      case "connector.hello":
        return this.onHello(socketId, msg, now);
      case "presence.snapshot":
        return this.onSnapshot(socketId, msg.data.sessions, now);
      case "connector.bye": {
        const b = this.sockets.get(socketId);
        this.sockets.delete(socketId);
        const rec = b && this.connectors.get(b.clientId);
        if (rec && rec.socketId === socketId) this.connectors.delete(b.clientId);
        return { events: this.commit(now) };
      }
    }
  }

  /** Socket closed without bye: keep the connector until its liveness timeout. */
  onConnectorClosed(socketId: string, now: number): HubResult {
    const b = this.sockets.get(socketId);
    this.sockets.delete(socketId);
    const rec = b && this.connectors.get(b.clientId);
    if (rec && rec.socketId === socketId) rec.socketId = null;
    return { events: this.commit(now) };
  }

  /** Expire silent connectors and people past their grace period. */
  tick(now: number): ViewerEvent[] {
    return this.commit(now);
  }

  /** Earliest time `tick` would change something, or null when nothing is pending. */
  nextDeadline(): number | null {
    let min = Number.POSITIVE_INFINITY;
    for (const c of this.connectors.values())
      min = Math.min(min, c.lastSeen + CONNECTOR_TIMEOUT_MS + 1);
    for (const p of this.people.values()) {
      if (p.goneSince !== null) min = Math.min(min, p.goneSince + PERSON_GRACE_MS);
    }
    return Number.isFinite(min) ? min : null;
  }

  /** Store a (generated) avatar and emit avatar.updated if the person is present. */
  setAvatar(personId: string, avatar: AvatarSpec, key: string, now: number): ViewerEvent[] {
    this.store.putAvatar(personId, avatar, key);
    const p = this.people.get(personId);
    if (p) p.avatar = avatar;
    return this.commit(now);
  }

  state(): OfficeState {
    return this.current;
  }

  snapshot(now: number): MessageOf<"office.snapshot"> {
    return envelope(
      "office.snapshot",
      {
        officeName: this.cfg.officeName,
        serverTime: now,
        people: this.current.people,
        timezone: this.cfg.timezone,
      },
      { ts: now },
    );
  }

  /** personId -> last display name seen. */
  knownNames(): Record<string, string> {
    return { ...this.names };
  }

  bindingOf(socketId: string): Binding | undefined {
    return this.sockets.get(socketId);
  }

  // ---- message handlers -------------------------------------------------------------------

  private reject(reason: RejectReason, code: number, message?: string): HubResult {
    return {
      reply: envelope("connector.rejected", message ? { reason, message } : { reason }),
      close: { code, reason },
      events: [],
    };
  }

  private onHello(socketId: string, msg: MessageOf<"connector.hello">, now: number): HubResult {
    const d = msg.data;
    const pw = this.cfg.password;
    if (!pw)
      return this.reject(
        "bad_password",
        CLOSE_BAD_PASSWORD,
        "server has no CONNECTOR_PASSWORD set",
      );
    if (!safeEqual(d.password, pw)) return this.reject("bad_password", CLOSE_BAD_PASSWORD);
    if (compareVersions(d.connectorVersion, this.cfg.minConnectorVersion) < 0) {
      return this.reject(
        "too_old",
        CLOSE_TOO_OLD,
        `connector ${d.connectorVersion} < minimum ${this.cfg.minConnectorVersion}`,
      );
    }

    const binding: Binding = {
      clientId: d.clientId,
      name: d.name,
      personId: personIdFromName(d.name),
      connectorVersion: d.connectorVersion,
      ...(d.selfDescription ? { selfDescription: d.selfDescription } : {}),
    };
    // a hello on a socket that was bound to another clientId: drop the old binding
    this.sockets.set(socketId, binding);
    const existing = this.connectors.get(d.clientId);
    this.connectors.set(d.clientId, {
      ...binding,
      socketId,
      lastSeen: now,
      // same laptop reconnecting keeps its sessions until the next snapshot arrives
      sessions: existing && existing.personId === binding.personId ? existing.sessions : [],
    });
    const avatarJob = this.ensurePerson(binding, now);
    const reply = envelope("connector.welcomed", {
      personId: binding.personId,
      serverVersion: this.cfg.serverVersion,
      latestConnectorVersion: this.cfg.latestConnectorVersion,
      minConnectorVersion: this.cfg.minConnectorVersion,
    });
    const res: HubResult = { reply, events: this.commit(now), binding };
    if (avatarJob) res.avatarJob = avatarJob;
    return res;
  }

  private onSnapshot(socketId: string, sessions: SessionInfo[], now: number): HubResult {
    const binding = this.sockets.get(socketId);
    if (!binding)
      return this.reject("bad_message", CLOSE_BAD_MESSAGE, "send connector.hello first");
    let rec = this.connectors.get(binding.clientId);
    if (rec && rec.socketId !== socketId && rec.socketId !== null) {
      // another socket took over this clientId; this one is stale
      this.sockets.delete(socketId);
      return { close: { code: 1000, reason: "superseded" }, events: [] };
    }
    if (!rec) {
      // connector timed out but the socket is still alive: revive it
      rec = { ...binding, socketId, lastSeen: now, sessions: [] };
      this.connectors.set(binding.clientId, rec);
      this.ensurePerson(binding, now);
    }
    rec.socketId = socketId;
    rec.lastSeen = now;
    const seen = new Set<string>();
    rec.sessions = sessions.filter((s) => !seen.has(s.sessionKey) && seen.add(s.sessionKey));
    return { events: this.commit(now) };
  }

  /** Create or revive the person record; returns an avatar job when the look needs (re)generation. */
  private ensurePerson(b: Binding, now: number): AvatarJob | undefined {
    let p = this.people.get(b.personId);
    const stored = this.store.getAvatar(b.personId);
    if (!p) {
      p = {
        personId: b.personId,
        name: b.name,
        joinedAt: now,
        goneSince: null,
        avatar: stored?.avatar ?? avatarFromSeed(b.personId),
      };
      this.people.set(b.personId, p);
    }
    p.goneSince = null;
    p.name = b.name;
    if (this.names[b.personId] !== b.name) {
      this.names[b.personId] = b.name;
      this.store.kvPut(NAMES_KEY, JSON.stringify(this.names));
    }
    const key = (this.cfg.avatarKey ?? defaultAvatarKey)(b.name, b.selfDescription);
    if (stored?.key === key) return undefined;
    return {
      personId: b.personId,
      name: b.name,
      key,
      ...(b.selfDescription ? { selfDescription: b.selfDescription } : {}),
    };
  }

  // ---- derivation -------------------------------------------------------------------------

  /** Apply liveness rules at `now`, derive the new state, diff, log, persist. */
  private commit(now: number): ViewerEvent[] {
    for (const [id, c] of this.connectors) {
      if (now - c.lastSeen > CONNECTOR_TIMEOUT_MS) this.connectors.delete(id);
    }
    const livePeople = new Set([...this.connectors.values()].map((c) => c.personId));
    for (const [id, p] of this.people) {
      if (livePeople.has(id)) {
        p.goneSince = null;
        continue;
      }
      if (p.goneSince === null) p.goneSince = now;
      if (now - p.goneSince >= PERSON_GRACE_MS) this.people.delete(id);
    }

    const prev = this.current;
    const next = this.derive();
    const events = diff(prev, next, now);
    this.current = next;
    if (events.length > 0) {
      const lookup = lookupIn(next, prev);
      const prevLookup = lookupIn(prev, next);
      const rows = [];
      for (const e of events) {
        const l = e.type === "session.ended" ? prevLookup : lookup;
        this.log(logLine(e, l));
        const row = historyRow(e, l);
        if (row) rows.push(row);
      }
      if (rows.length > 0) this.store.appendHistory(rows);
    }
    this.persist();
    return events;
  }

  private derive(): OfficeState {
    const people: PersonView[] = [];
    const sorted = [...this.people.values()].sort(
      (a, b) => a.joinedAt - b.joinedAt || a.personId.localeCompare(b.personId),
    );
    for (const p of sorted) {
      const sessions: SessionView[] = [];
      for (const c of this.connectors.values()) {
        if (c.personId !== p.personId) continue;
        for (const s of c.sessions) {
          sessions.push({
            sessionId: sessionIdOf(c.clientId, s.sessionKey),
            agent: s.agent,
            ...(s.project !== undefined ? { project: s.project } : {}),
            activity: s.activity,
            subagents: s.subagents,
            startedAt: s.startedAt,
          });
        }
      }
      sessions.sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId));
      people.push({
        personId: p.personId,
        name: p.name,
        avatar: p.avatar,
        sessions,
        joinedAt: p.joinedAt,
      });
    }
    return { people };
  }

  /** Structural fingerprint: persisted only when it changes (not on heartbeats/activity). */
  private signature(): string {
    const cs = [...this.connectors.values()].map((c) => [
      c.clientId,
      c.personId,
      c.name,
      c.selfDescription ?? "",
      c.socketId ?? "",
      c.sessions.map((s) => s.sessionKey).join(","),
    ]);
    const ps = [...this.people.values()].map((p) => [p.personId, p.name, p.goneSince, p.joinedAt]);
    return JSON.stringify([cs, ps]);
  }

  private persist(): void {
    const sig = this.signature();
    if (sig === this.persistedSig) return;
    this.persistedSig = sig;
    const state: Persisted = {
      v: 1,
      connectors: [...this.connectors.values()],
      people: [...this.people.values()],
    };
    this.store.kvPut(STATE_KEY, JSON.stringify(state));
  }
}
