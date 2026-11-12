/**
 * Runtime-agnostic hub: owns connectors, people and liveness, turns connector
 * messages into viewer events via `diff()`. No timers, no sockets, no Workers APIs:
 * callers pass `now`, call `tick(now)` at `nextDeadline()`, and deliver replies/events.
 */
import {
  type Activity,
  type AvatarSpec,
  avatarFromSeed,
  CLOSE_BAD_MESSAGE,
  CLOSE_BAD_PASSWORD,
  CLOSE_TOO_OLD,
  CONNECTOR_STALE_MS,
  CONNECTOR_TIMEOUT_MS,
  catalogAvatar,
  compareVersions,
  envelope,
  type HelperSkin,
  hashString,
  type LookGenerator,
  type LookMacState,
  type MessageData,
  type MessageOf,
  PERSON_GRACE_MS,
  type PersonView,
  parseConnectorMessage,
  personIdFromName,
  type RejectReason,
  repairAvatar,
  type ServerToConnector,
  type SessionInfo,
  type SessionView,
  SHORT_SELF_DESCRIPTION,
  sessionIdOf,
  type ViewerEvent,
} from "@agent-office/protocol";
import { diff, EMPTY_STATE, type OfficeState } from "./diff.ts";
import { historyRow, logLine, lookupIn } from "./events.ts";
import { ShameTracker } from "./shame.ts";
import type { Store } from "./store.ts";

export type HubConfig = {
  /** shared connector password; empty/undefined rejects every connector */
  password: string | undefined;
  minConnectorVersion: string;
  latestConnectorVersion: string;
  serverVersion: string;
  officeName: string;
  timezone: string;
  /**
   * Cache key for a person's look; a change triggers an avatar job (GenUI). The Hub calls it
   * with the personId (stable across spellings) and the person-level description.
   */
  avatarKey?: (name: string, selfDescription: string | undefined) => string;
};

/** What a socket learned from `connector.hello` (kept in the socket attachment in the DO). */
export type Binding = {
  clientId: string;
  name: string;
  personId: string;
  selfDescription?: string;
  connectorVersion: string;
  /** user-chosen machine label, copied into every SessionView of this connector */
  machine?: string;
  /**
   * Giphy id from this connector's hello; "" = remove, undefined = leave as is. Only applied
   * when it differs from what this clientId sent before for this person (see `Hub.helloGifs`).
   */
  gif?: string;
  /** opt-in "MM-DD" */
  birthday?: string;
  /** local AI tools this connector can draw its person's look with (their own subscription) */
  lookGenerators?: LookGenerator[];
  /** opt-in: this person's subagents are kittens (omitted = robots) */
  helpers?: HelperSkin;
};

/** A connector as the hub tracks and persists it (its description lives on the person). */
type ConnectorRec = Omit<Binding, "selfDescription"> & {
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
  /**
   * Person-level look description ("" = none). Changes only when a connector sends a
   * description that is new for that connector (see ensurePerson); a hello without one never
   * changes it. Not persisted in hub.state (the avatars row keeps it); undefined after restore.
   */
  selfDescription?: string;
  /** avatar key of the look stored or already requested (not persisted) */
  lookKey?: string;
};

export type AvatarJob = {
  personId: string;
  name: string;
  selfDescription?: string;
  key: string;
  /** the stored look, kept when there is no description or generation fails */
  previous?: AvatarSpec;
};

export type HubResult = {
  reply?: ServerToConnector;
  close?: { code: number; reason: string };
  events: ViewerEvent[];
  /** run GenUI for this person, then call `setAvatar` */
  avatarJob?: AvatarJob;
  /** new binding for this socket (persist it with the socket) */
  binding?: Binding;
  /** a connector answered a look request on `socketId` (checked and applied by the app) */
  lookGenerated?: MessageData<"connector.lookGenerated"> & { personId: string; socketId: string };
};

/** `helloGifs` key: one entry per connector and person (client ids never contain "/"). */
const helloKey = (clientId: string, personId: string) => `${clientId}/${personId}`;

type Persisted = {
  v: 1;
  connectors: ConnectorRec[];
  /** `gif` only in state written before `gifs` existed */
  people: (PersonRec & { gif?: string })[];
  /** personId -> Giphy id (missing in old state) */
  gifs?: Record<string, string>;
  /** "clientId/personId" -> last gif that connector sent for that person (missing in old state) */
  helloGifs?: Record<string, string>;
};

/** How long the in-memory activity log of a live session reaches back. */
export const RECENT_ACTIVITY_MS = 30 * 60_000;

const STATE_KEY = "hub.state";
const NAMES_KEY = "hub.names";
/** clientId -> hash of the last non-empty description that connector sent */
const CLIENT_DESCS_KEY = "hub.clientDescs";

export const defaultAvatarKey = (name: string, desc: string | undefined) =>
  `seed:${hashString(`${name}\n${desc ?? ""}`).toString(36)}`;

/** Descriptions can be ~8000 chars: fingerprint them instead of copying them into every signature. */
const descSig = (desc: string | undefined) => (desc ? hashString(desc).toString(36) : "");

/**
 * The binding as stored in the socket attachment (Workers cap it at 2 KiB). A long description
 * is left out: the person record and the avatars row keep it, and a binding without one never
 * changes the person's description.
 */
const withoutDescription = (b: Binding): Omit<Binding, "selfDescription"> => {
  const { selfDescription: _d, ...rest } = b;
  return rest;
};

/** Persisted people: no description text, no detailed look (the avatars row has both). */
const persistable = (p: PersonRec): PersonRec => {
  const { lookKey: _k, selfDescription: _d, ...rest } = p;
  const { look: _l, ...catalog } = p.avatar;
  return { ...rest, avatar: catalog };
};

const attachable = (b: Binding): Binding => {
  if ((b.selfDescription?.length ?? 0) <= SHORT_SELF_DESCRIPTION) return b;
  const { selfDescription: _d, ...rest } = b;
  return rest;
};

/** Trim and collapse whitespace ("  Martin  K " -> "Martin K"). */
export const cleanName = (name: string) => name.trim().replace(/\s+/g, " ");

/** "YYYY-MM-DD" of `ts` in an IANA zone (bad zone -> UTC). */
export function dayKeyIn(timeZone: string, ts: number): string {
  const o = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    return new Intl.DateTimeFormat("en-CA", { ...o, timeZone }).format(ts);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { ...o, timeZone: "UTC" }).format(ts);
  }
}

/** "MM-DD" of `now` in an IANA zone (bad zone -> UTC). */
export function monthDayIn(timeZone: string, now: number): string {
  const o = { month: "2-digit", day: "2-digit" } as const;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { ...o, timeZone }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { ...o, timeZone: "UTC" }).formatToParts(now);
  }
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${v("month")}-${v("day")}`;
}

export function safeEqual(a: string, b: string): boolean {
  let diffBits = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diffBits |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diffBits === 0;
}

export class Hub {
  private connectors = new Map<string, ConnectorRec>();
  private people = new Map<string, PersonRec>();
  /**
   * personId -> Giphy id of the GIF over the head. Kept (and persisted) while the person is
   * away, so the GIF is back when they return, however it was chosen (CLI or web UI).
   */
  private gifs = new Map<string, string>();
  /**
   * `helloKey(clientId, personId)` -> the last `gif` that connector sent in a hello for that
   * person. A hello only changes the person's GIF when its value differs from this (the user
   * ran `agent-office gif` again), so a reconnect never overwrites a GIF chosen in the web UI.
   * Keyed per person too, so renaming and renaming back doesn't re-apply an old value.
   * Outlives connector records (they expire when a laptop stays offline) and is persisted.
   */
  private helloGifs = new Map<string, string>();
  /** socketId -> binding (only sockets that said hello) */
  private sockets = new Map<string, Binding>();
  private current: OfficeState = EMPTY_STATE;
  /** `now` of the last derive(); offline flags in `current` are as of then */
  private derivedAt = 0;
  private persistedSig = "";
  private names: Record<string, string> = {};
  private clientDescs: Record<string, string> = {};
  /** sessionId -> recent activity changes (memory only; the agent card's timeline) */
  private recent = new Map<string, { activity: Activity; at: number }[]>();
  /** sink for readable event lines */
  log: (line: string) => void = () => {};
  readonly shame: ShameTracker;

  constructor(
    private cfg: HubConfig,
    private store: Store,
  ) {
    this.shame = new ShameTracker(store, (ts) => dayKeyIn(cfg.timezone, ts));
    try {
      this.names = JSON.parse(store.kvGet(NAMES_KEY) ?? "{}");
    } catch {
      this.names = {};
    }
    try {
      this.clientDescs = JSON.parse(store.kvGet(CLIENT_DESCS_KEY) ?? "{}");
    } catch {
      this.clientDescs = {};
    }
  }

  // ---- public API -------------------------------------------------------------------------

  /** Version announced in later `connector.welcomed` replies (auto-detected from GitHub). */
  setLatestConnectorVersion(v: string): void {
    this.cfg.latestConnectorVersion = v;
  }

  /** Restore after a DO restart / hibernation wake. Emits nothing. */
  restore(now: number, sockets: { socketId: string; binding: Binding | null }[] = []): void {
    const raw = this.store.kvGet(STATE_KEY);
    if (raw) {
      try {
        const p = JSON.parse(raw) as Persisted;
        for (const c of (p.connectors ?? []) as (ConnectorRec & { selfDescription?: string })[]) {
          // state from before descriptions moved out: remember what this connector sent
          if (c.selfDescription && this.clientDescs[c.clientId] === undefined)
            this.rememberClientDesc(c.clientId, c.selfDescription);
          const { selfDescription: _d, ...rec } = c;
          // fresh liveness window: live connectors heartbeat again within 30 s
          this.connectors.set(c.clientId, { ...rec, lastSeen: Math.max(c.lastSeen, now) });
        }
        for (const person of p.people ?? []) {
          // the avatars table is the source of truth (setAvatar does not re-persist the state,
          // and the persisted copy has no detailed look)
          const stored = this.storedAvatar(person.personId);
          person.avatar = stored?.avatar ?? repairAvatar(person.avatar, person.personId).avatar;
          // the custom look is the source of truth, even if the state was written before it
          const custom = this.customAvatar(person.personId);
          if (custom) person.avatar = custom;
          this.people.set(person.personId, person);
        }
        // state from before `gifs`: the GIF lived on the person record
        for (const person of p.people ?? []) {
          if (person.gif && !p.gifs) this.gifs.set(person.personId, person.gif);
          delete person.gif;
        }
        for (const [id, gif] of Object.entries(p.gifs ?? {})) this.gifs.set(id, gif);
        if (p.helloGifs) {
          for (const [id, h] of Object.entries(p.helloGifs)) this.helloGifs.set(id, h);
        } else {
          // state from before `helloGifs`: what each connector last sent is on its record, so
          // the first reconnect after the deploy doesn't re-apply an unchanged config value
          for (const c of p.connectors ?? [])
            if (c.gif !== undefined) this.helloGifs.set(helloKey(c.clientId, c.personId), c.gif);
        }
      } catch {
        // corrupt state: start empty
      }
    }
    for (const s of sockets) if (s.binding) this.sockets.set(s.socketId, s.binding);
    this.current = this.derive(now);
    // the activity log is memory only: after a restart it starts now
    for (const p of this.current.people)
      for (const x of p.sessions) this.recent.set(x.sessionId, [{ activity: x.activity, at: now }]);
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
      case "connector.lookGenerated": {
        const b = this.sockets.get(socketId);
        if (!b) return this.reject("bad_message", CLOSE_BAD_MESSAGE, "send connector.hello first");
        // the person comes from the socket's own hello, never from the message
        return { events: [], lookGenerated: { ...msg.data, personId: b.personId, socketId } };
      }
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

  /** Mark silent connectors offline, expire them and people past their grace period. */
  tick(now: number): ViewerEvent[] {
    return this.commit(now);
  }

  /** Earliest time `tick` would change something, or null when nothing is pending. */
  nextDeadline(): number | null {
    let min = Number.POSITIVE_INFINITY;
    for (const c of this.connectors.values()) {
      const at = this.isStale(c, this.derivedAt) ? CONNECTOR_TIMEOUT_MS : CONNECTOR_STALE_MS;
      min = Math.min(min, c.lastSeen + at + 1);
    }
    for (const p of this.people.values()) {
      if (p.goneSince !== null) min = Math.min(min, p.goneSince + PERSON_GRACE_MS);
    }
    return Number.isFinite(min) ? min : null;
  }

  /** Whether a look made for this key is still wanted (else `setAvatar` drops it). */
  isCurrentLookKey(personId: string, key: string): boolean {
    const p = this.people.get(personId);
    return !p?.lookKey || key.replace(/:fallback$/, "") === p.lookKey;
  }

  /**
   * Store a (generated) avatar and emit avatar.updated if the person is present. A result for
   * an older job (the description changed again meanwhile) is dropped.
   */
  setAvatar(
    personId: string,
    avatar: AvatarSpec,
    key: string,
    now: number,
    selfDescription?: string,
  ): ViewerEvent[] {
    const p = this.people.get(personId);
    if (!this.isCurrentLookKey(personId, key)) return [];
    this.store.putAvatar(personId, avatar, key, selfDescription ?? p?.selfDescription ?? "");
    // a custom look stays on; the automatic one waits in its row for "Automatic"
    if (this.customAvatar(personId)) return [];
    if (p) p.avatar = avatar;
    return this.commit(now);
  }

  /**
   * Set (`gif` = Giphy id) or remove (undefined) a person's head GIF, e.g. from the web UI.
   * Returns null when the person is not in the office, else the events (`[]` if unchanged).
   * Leaves `helloGifs` alone, so the connector's next reconnect does not undo it.
   */
  setGif(personId: string, gif: string | undefined, now: number): ViewerEvent[] | null {
    if (!this.people.has(personId)) return null;
    this.applyGif(personId, gif || undefined);
    return this.commit(now);
  }

  /**
   * Look editor: pin a custom look (catalog ids, already validated) or, with `null`, drop it
   * and go back to the automatic look. The automatic look is kept in its own row, so going
   * back is free; an avatar job is returned only when that row is missing or was made for an
   * older description. Only for people in the office; returns null otherwise.
   */
  setCustomAvatar(
    personId: string,
    avatar: AvatarSpec | null,
    now: number,
  ): { events: ViewerEvent[]; avatarJob?: AvatarJob; avatar: AvatarSpec } | null {
    const p = this.people.get(personId);
    if (!p) return null;
    const stored = this.storedAvatar(personId);
    if (p.selfDescription === undefined) p.selfDescription = stored?.selfDescription ?? "";
    if (avatar) {
      // catalog ids only: the look comes from them, never from a GenUI answer
      const custom = catalogAvatar(avatar);
      this.store.putCustomAvatar(personId, custom);
      p.avatar = custom;
      this.log(`look ${personId} custom`);
      return { events: this.commit(now), avatar: custom };
    }
    this.store.putCustomAvatar(personId, null);
    const keyFn = this.cfg.avatarKey ?? defaultAvatarKey;
    const want = keyFn(personId, p.selfDescription || undefined);
    p.lookKey = want;
    p.avatar = stored?.avatar ?? avatarFromSeed(personId);
    const events = this.commit(now);
    this.log(`look ${personId} back to automatic`);
    if (stored && stored.key.replace(/:fallback$/, "") === want)
      return { events, avatar: p.avatar };
    return {
      events,
      avatar: p.avatar,
      avatarJob: {
        personId,
        name: p.name,
        key: want,
        ...(p.selfDescription ? { selfDescription: p.selfDescription } : {}),
        ...(stored ? { previous: stored.avatar } : {}),
      },
    };
  }

  /** Whether a person's look was picked in the look editor. */
  isCustomLook(personId: string): boolean {
    return this.customAvatar(personId) !== null;
  }

  /** The person-level look description ("" = none). Never part of the office state. */
  descriptionOf(personId: string): string {
    const p = this.people.get(personId);
    return p?.selfDescription ?? this.storedAvatar(personId)?.selfDescription ?? "";
  }

  /**
   * Look studio: the owner describes their look in the browser. The text becomes the
   * person-level description, exactly as if a connector had sent a new one (a connector that
   * keeps sending its old, unchanged description does not flip it back, see `ensurePerson`).
   * Always returns an avatar job, even for the same text: "Generate" means "try again". A
   * custom look stays pinned until the caller drops it (only once the AI made a new look, so
   * a failed attempt never costs the person their look). Null when not in the office.
   */
  describeLook(personId: string, description: string): AvatarJob | null {
    const p = this.people.get(personId);
    if (!p) return null;
    const stored = this.storedAvatar(personId);
    p.selfDescription = description;
    // keep the text with the automatic look right away, so it survives a restart even if
    // the AI call fails (the `:fallback` key then retries it on the next join). Skipped when
    // the row already holds this text (no row reads back as ""), so repeated Generates with
    // the AI off or the cap reached write nothing.
    const kept = stored ? stored.selfDescription : "";
    if (kept !== description)
      this.store.putAvatar(
        personId,
        stored?.avatar ?? avatarFromSeed(personId),
        stored?.key ?? "",
        description,
      );
    const keyFn = this.cfg.avatarKey ?? defaultAvatarKey;
    const key = keyFn(personId, description);
    p.lookKey = key;
    this.log(`look ${personId} described in the look studio`);
    return {
      personId,
      name: p.name,
      key,
      selfDescription: description,
      ...(stored ? { previous: stored.avatar } : {}),
    };
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

  /** Recent activity of a person's live sessions (sessionId -> oldest first). */
  recentActivity(
    personId: string,
    now: number,
  ): Record<string, { activity: Activity; at: number }[]> {
    const out: Record<string, { activity: Activity; at: number }[]> = {};
    const p = this.current.people.find((x) => x.personId === personId);
    for (const s of p?.sessions ?? []) {
      const log = this.recent.get(s.sessionId) ?? [{ activity: s.activity, at: now }];
      out[s.sessionId] = log.map((e) => ({ ...e }));
    }
    return out;
  }

  /** personId -> last display name seen. */
  knownNames(): Record<string, string> {
    return { ...this.names };
  }

  bindingOf(socketId: string): Binding | undefined {
    return this.sockets.get(socketId);
  }

  /**
   * The local AI tools of one socket (the Mac a browser proved it can read, see
   * OfficeApp.requestLocalLook), when it is the live socket of one of this person's connectors;
   * else []. Never any other socket of the person: a connector's person is only a claimed name.
   */
  lookGeneratorsOf(personId: string, socketId: string | undefined, now: number): LookGenerator[] {
    if (!socketId) return [];
    const b = this.sockets.get(socketId);
    const c = b && this.connectors.get(b.clientId);
    if (!c || c.socketId !== socketId || c.personId !== personId || this.isStale(c, now)) return [];
    return [...(c.lookGenerators ?? [])];
  }

  /**
   * Whether a Generate from a browser that proved `socketId` can go to the person's Mac, and
   * if not, what would fix it (see LookMacState). Only says which kind of Mac is live; it never
   * hands out another socket (lookGeneratorsOf stays the only door to one).
   */
  macLookState(personId: string, socketId: string | undefined, now: number): LookMacState {
    if (this.lookGeneratorsOf(personId, socketId, now).length > 0) return "ready";
    let live = false;
    for (const c of this.connectors.values()) {
      if (c.personId !== personId || !c.socketId || this.isStale(c, now)) continue;
      if (c.lookGenerators?.length) return "reconfirm";
      live = true;
    }
    return live ? "enable" : "offline";
  }

  /** Open sockets of a person's connectors that are still heartbeating. */
  liveSocketsOf(personId: string, now: number): string[] {
    const out: string[] = [];
    for (const c of this.connectors.values()) {
      if (c.personId === personId && c.socketId && !this.isStale(c, now)) out.push(c.socketId);
    }
    return out;
  }

  private isStale(c: ConnectorRec, now: number): boolean {
    return now - c.lastSeen > CONNECTOR_STALE_MS;
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

    const name = cleanName(d.name);
    // the full description (up to MAX_SELF_DESCRIPTION) when the connector sent one
    const desc = d.lookDescription?.trim() || d.selfDescription?.trim();
    const machine = d.machine?.trim();
    const binding: Binding = {
      clientId: d.clientId,
      name,
      personId: personIdFromName(name),
      connectorVersion: d.connectorVersion,
      ...(desc ? { selfDescription: desc } : {}),
      ...(machine ? { machine } : {}),
      ...(d.gif !== undefined ? { gif: d.gif } : {}),
      ...(d.birthday ? { birthday: d.birthday } : {}),
      ...(d.lookGenerators?.length ? { lookGenerators: [...new Set(d.lookGenerators)] } : {}),
      ...(d.helpers === "cats" ? { helpers: d.helpers } : {}),
    };
    // a hello on a socket that was bound to another clientId: drop the old binding
    this.sockets.set(socketId, binding);
    // head GIF: only a value this connector did not send before counts (see `helloGifs`)
    let gif: string | undefined;
    if (d.gif !== undefined) {
      const key = helloKey(d.clientId, binding.personId);
      if (this.helloGifs.get(key) !== d.gif) gif = d.gif;
      this.helloGifs.set(key, d.gif);
    }
    const existing = this.connectors.get(d.clientId);
    this.connectors.set(d.clientId, {
      ...withoutDescription(binding),
      socketId,
      lastSeen: now,
      // same laptop reconnecting keeps its sessions until the next snapshot arrives
      sessions: existing && existing.personId === binding.personId ? existing.sessions : [],
    });
    const avatarJob = this.ensurePerson(binding, now);
    if (gif !== undefined) this.applyGif(binding.personId, gif || undefined);
    const reply = envelope("connector.welcomed", {
      personId: binding.personId,
      serverVersion: this.cfg.serverVersion,
      latestConnectorVersion: this.cfg.latestConnectorVersion,
      minConnectorVersion: this.cfg.minConnectorVersion,
    });
    const res: HubResult = { reply, events: this.commit(now), binding: attachable(binding) };
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
      rec = { ...withoutDescription(binding), socketId, lastSeen: now, sessions: [] };
      this.connectors.set(binding.clientId, rec);
      this.ensurePerson(binding, now);
    }
    rec.socketId = socketId;
    rec.lastSeen = now;
    const seen = new Set<string>();
    rec.sessions = sessions.filter((s) => !seen.has(s.sessionKey) && seen.add(s.sessionKey));
    return { events: this.commit(now) };
  }

  /**
   * Create or revive the person record; returns an avatar job when the look needs
   * (re)generation. The look belongs to the person, not to a laptop: it is keyed on the
   * personId + the person-level description, so two machines with different (or missing)
   * descriptions never make it flip-flop.
   */
  private ensurePerson(b: Binding, now: number): AvatarJob | undefined {
    let p = this.people.get(b.personId);
    const stored = this.storedAvatar(b.personId);
    const custom = this.customAvatar(b.personId);
    if (!p) {
      p = {
        personId: b.personId,
        name: b.name,
        joinedAt: now,
        goneSince: null,
        avatar: custom ?? stored?.avatar ?? avatarFromSeed(b.personId),
      };
      this.people.set(b.personId, p);
    }
    p.goneSince = null;
    p.name = this.displayName(b.personId, b.name, p.name);
    if (this.names[b.personId] !== p.name) {
      this.names[b.personId] = p.name;
      this.store.kvPut(NAMES_KEY, JSON.stringify(this.names));
    }

    // Person-level description. It changes only when this connector's own description is new
    // (first hello from it, or its user set another one) or the person has none yet. Two
    // machines that keep sending different descriptions (an old truncated config, say) then
    // never flip it back and forth on reconnects. Empty never changes it.
    if (p.selfDescription === undefined) p.selfDescription = stored?.selfDescription ?? "";
    const desc = b.selfDescription ?? "";
    if (desc) {
      const changedHere = this.clientDescs[b.clientId] !== descSig(desc);
      this.rememberClientDesc(b.clientId, desc);
      if (desc !== p.selfDescription && (changedHere || !p.selfDescription)) {
        p.selfDescription = desc;
        // keep it with the stored look right away (hub.state does not carry descriptions)
        // (never the custom look: it has its own row)
        if (!stored || stored.selfDescription !== undefined)
          this.store.putAvatar(
            b.personId,
            stored?.avatar ?? (custom ? avatarFromSeed(b.personId) : p.avatar),
            stored?.key ?? "",
            desc,
          );
      }
    }

    // a look picked in the look editor wins over any description: no job while it is on (a
    // new description is remembered in the automatic row, whose key then no longer matches,
    // so "Automatic" regenerates for it)
    if (custom) {
      p.avatar = custom;
      if (!stored || stored.selfDescription !== p.selfDescription)
        this.store.putAvatar(
          b.personId,
          stored?.avatar ?? avatarFromSeed(b.personId),
          stored?.key ?? "",
          p.selfDescription,
        );
      return undefined;
    }
    const keyFn = this.cfg.avatarKey ?? defaultAvatarKey;
    const want = keyFn(b.personId, p.selfDescription || undefined);
    if (p.lookKey === want) return undefined;
    if (stored?.key === want) {
      p.lookKey = want;
      return undefined;
    }
    if (stored && stored.selfDescription === undefined) {
      // row from before descriptions were stored, keyed on (name, description) of a hello
      if (stored.key === keyFn(b.name, desc || undefined)) {
        this.store.putAvatar(b.personId, stored.avatar, want, p.selfDescription);
        p.lookKey = want;
        return undefined;
      }
      if (!desc) {
        // no description to go on: keep the look (a later described hello may still match)
        p.lookKey = want;
        return undefined;
      }
    }
    p.lookKey = want;
    return {
      personId: b.personId,
      name: p.name,
      key: want,
      ...(p.selfDescription ? { selfDescription: p.selfDescription } : {}),
      ...(stored ? { previous: stored.avatar } : {}),
    };
  }

  private applyGif(personId: string, gif: string | undefined): void {
    if (gif) this.gifs.set(personId, gif);
    else this.gifs.delete(personId);
  }

  private rememberClientDesc(clientId: string, desc: string): void {
    const sig = descSig(desc);
    if (this.clientDescs[clientId] === sig) return;
    this.clientDescs[clientId] = sig;
    this.store.kvPut(CLIENT_DESCS_KEY, JSON.stringify(this.clientDescs));
  }

  /**
   * The look picked in the look editor, if any. It is catalog ids only: a detailed `look` (say
   * one copied from the GenUI avatar it was edited from, or a row stored before this rule) is
   * dropped, so the look is derived from the picked ids (`lookFromCatalog`) and no GenUI
   * answer can show through.
   */
  private customAvatar(personId: string): AvatarSpec | null {
    const custom = this.store.getCustomAvatar(personId);
    return custom ? catalogAvatar(custom) : null;
  }

  /** Stored avatar row with its look repaired (rows are not validated when written/read). */
  private storedAvatar(personId: string): ReturnType<Store["getAvatar"]> {
    const stored = this.store.getAvatar(personId);
    if (!stored) return null;
    return { ...stored, avatar: repairAvatar(stored.avatar, personId).avatar };
  }

  /**
   * Most recent spelling wins, except that a difference in case only (" martin" vs
   * "Martin") never flips the name: the spelling already shown (or last stored) stays.
   */
  private displayName(personId: string, incoming: string, current: string): string {
    const same = (a: string | undefined) =>
      a !== undefined && a.toLocaleLowerCase() === incoming.toLocaleLowerCase();
    if (same(current) && current !== incoming) return current;
    const known = this.names[personId];
    if (current === incoming && same(known) && known !== incoming) return known!;
    return incoming;
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
    const next = this.derive(now);
    const events = diff(prev, next, now);
    this.current = next;
    this.trackActivity(events, now);
    this.shame.record(events, prev, now);
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

  private trackActivity(events: ViewerEvent[], now: number) {
    for (const e of events) {
      if (e.type === "session.started") {
        this.recent.set(e.data.session.sessionId, [{ activity: e.data.session.activity, at: now }]);
      } else if (e.type === "session.ended") {
        this.recent.delete(e.data.sessionId);
      } else if (e.type === "session.activityChanged") {
        const log = this.recent.get(e.data.sessionId) ?? [];
        log.push({ activity: e.data.activity, at: now });
        // keep the entry that was current at the window start
        while (log.length > 1 && log[1]!.at < now - RECENT_ACTIVITY_MS) log.shift();
        this.recent.set(e.data.sessionId, log);
      }
    }
  }

  private derive(now: number): OfficeState {
    this.derivedAt = now;
    const people: PersonView[] = [];
    const today = monthDayIn(this.cfg.timezone, now);
    const sorted = [...this.people.values()].sort(
      (a, b) => a.joinedAt - b.joinedAt || a.personId.localeCompare(b.personId),
    );
    for (const p of sorted) {
      const gif = this.gifs.get(p.personId);
      const sessions: SessionView[] = [];
      for (const c of this.connectors.values()) {
        if (c.personId !== p.personId) continue;
        const offline = this.isStale(c, now);
        for (const s of c.sessions) {
          sessions.push({
            sessionId: sessionIdOf(c.clientId, s.sessionKey),
            agent: s.agent,
            ...(s.project !== undefined ? { project: s.project } : {}),
            activity: s.activity,
            subagents: s.subagents,
            startedAt: s.startedAt,
            ...(c.machine ? { machine: c.machine } : {}),
            ...(offline ? { offline } : {}),
            ...(s.context !== undefined ? { context: s.context } : {}),
          });
        }
      }
      sessions.sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId));
      let birthday = false;
      let cats = false;
      for (const c of this.connectors.values()) {
        if (c.personId !== p.personId) continue;
        if (c.birthday === today) birthday = true;
        if (c.helpers === "cats") cats = true;
      }
      people.push({
        personId: p.personId,
        name: p.name,
        avatar: p.avatar,
        sessions,
        joinedAt: p.joinedAt,
        ...(gif ? { gif } : {}),
        ...(birthday ? { birthday } : {}),
        ...(cats ? { helpers: "cats" as const } : {}),
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
      c.machine ?? "",
      c.gif ?? "-",
      c.helpers ?? "",
      c.socketId ?? "",
      c.sessions.map((s) => s.sessionKey).join(","),
    ]);
    // the persisted (catalog) avatar is part of it, so a custom look survives hibernation
    const ps = [...this.people.values()].map((p) => {
      const { look: _l, ...catalog } = p.avatar;
      return [p.personId, p.name, JSON.stringify(catalog), p.goneSince, p.joinedAt];
    });
    return JSON.stringify([cs, ps, [...this.gifs], [...this.helloGifs]]);
  }

  private persist(): void {
    const sig = this.signature();
    if (sig === this.persistedSig) return;
    this.persistedSig = sig;
    const state: Persisted = {
      v: 1,
      connectors: [...this.connectors.values()],
      people: [...this.people.values()].map(persistable),
      gifs: Object.fromEntries(this.gifs),
      helloGifs: Object.fromEntries(this.helloGifs),
    };
    this.store.kvPut(STATE_KEY, JSON.stringify(state));
  }
}
