/**
 * OfficeApp: everything the Durable Object and the Bun dev server share. Wraps the Hub,
 * the store, GenUI and the /api/* routes (listed in packages/protocol/src/api.ts). Uses only
 * web-standard Request/Response; sockets are abstracted behind `Transport` and identified by
 * string ids.
 */
import {
  AvatarEditRequest,
  type AvatarEditResponse,
  envelope,
  type GenerateOutcome,
  HistoryRow,
  InteractRequest,
  type InteractResponse,
  LookDescribeRequest,
  type LookDescribeResponse,
  type LookGenerator,
  type MessageOf,
  MessageQuery,
  PartyState,
  parseGiphyId,
  SendMessageRequest,
  type ServerToConnector,
  SetGifRequest,
  type SetGifResponse,
  type ViewerEvent,
} from "@agent-office/protocol";
import { z } from "zod";
import {
  isAuthorized,
  ME_TTL_MS,
  makeMeToken,
  meCookie,
  meFromRequest,
  meProofFromRequest,
} from "./auth.ts";
import { Games } from "./games.ts";
import {
  AI_AVATAR_SCHEMA,
  type AvatarResult,
  type AvatarService,
  createAvatarService,
  type FetchLike,
  type GenuiEnv,
  SYSTEM_PROMPT,
  userPrompt,
} from "./genui.ts";
import { type AvatarJob, type Binding, Hub, type HubResult, safeEqual } from "./hub.ts";
import { isAutoVersion, LatestVersion } from "./latest.ts";
import { messageOwner } from "./message-owner.ts";
import { OfficeMessages } from "./messages.ts";
import { Party, readPartyBody } from "./party.ts";
import { computeOfficeDay, computePersonDay, computeStats, historyToCsv } from "./stats.ts";
import type { Store } from "./store.ts";

export type AppEnv = GenuiEnv & {
  CONNECTOR_PASSWORD?: string;
  VIEWER_KEY?: string;
  LATEST_CONNECTOR_VERSION?: string;
  MIN_CONNECTOR_VERSION?: string;
  /** "owner/repo" whose latest GitHub release is the connector version (LATEST_CONNECTOR_VERSION=auto) */
  GITHUB_REPO?: string;
  SERVER_VERSION?: string;
  OFFICE_NAME?: string;
  OFFICE_TIMEZONE?: string;
  /** "1" = local dev: CONNECTOR_PASSWORD defaults to "devpass" */
  DEV_MODE?: string;
};

export interface Transport {
  /** send to every connected viewer */
  broadcast(json: string): void;
  /** send to one connector socket (pokes); false if it is gone */
  sendToConnector?(socketId: string, json: string): boolean;
  /** ask to be called back (`app.alarm()`) at `at`; null = nothing pending */
  scheduleAlarm(at: number | null): void;
  /** keep the runtime alive for background work (GenUI) */
  waitUntil?(p: Promise<unknown>): void;
}

/** What to do with the socket a connector message arrived on. */
export type SocketAction = {
  reply?: ServerToConnector;
  close?: { code: number; reason: string };
  binding?: Binding;
};

export const SNAPSHOT_MAX_BYTES = 300 * 1024;
export const SNAPSHOT_MIN_INTERVAL_MS = 10 * 60 * 1000;
export const BACKFILL_MAX_ROWS = 50_000;
/** One interaction per viewer (IP) this often, and one notification per person this often. */
export const INTERACT_MIN_INTERVAL_MS = 2_000;
export const POKE_PER_PERSON_MS = 10_000;
/** A "this is me" code: how long it is valid, how often one can be sent, wrong tries allowed. */
export const CLAIM_CODE_TTL_MS = 5 * 60_000;
export const CLAIM_RESEND_MS = 30_000;
export const CLAIM_MAX_TRIES = 5;
/** Codes per person per day (UTC): bounds guessing and notification spam on their Mac. */
export const CLAIM_MAX_PER_DAY = 10;
/** One look change per viewer (IP) this often. */
export const LOOK_MIN_INTERVAL_MS = 1_000;
/** One "generate my look from this description" per person this often (each is an AI call). */
export const LOOK_DESCRIBE_MIN_INTERVAL_MS = 20_000;
/** A look request a Mac never answered is asked again on that person's next hello after this. */
export const LOOK_LOCAL_RETRY_MS = 5 * 60_000;
/**
 * Look studio Generates per person per day (UTC) drawn by the server's provider
 * (GENUI_MAX_CALLS_PER_PERSON overrides), so one person cannot use up the shared
 * GENUI_MAX_CALLS_PER_DAY. Looks drawn on their own Mac (their own subscription) do not count.
 */
export const LOOK_GENERATES_PER_DAY = 5;

/** A look request sent to a person's connector (one per person, kept in the store). */
type PendingLook = {
  requestId: string;
  job: AvatarJob;
  /** the look studio's Generate this answers (see studioKey) */
  studio?: string;
  /** the socket it went to: the Mac the owner's browser proved with its code */
  mac?: string;
  at: number;
  generator: LookGenerator;
};
const pendingLookKey = (personId: string) => `look.pending.${personId}`;
/** "This is me" codes in flight: one per connector socket (`mac`) of the person. */
type ClaimCode = { code: string; mac: string };
type PendingClaim = { codes: ClaimCode[]; exp: number; tries: number };
/**
 * The person's newest look studio Generate (a random token, "" once they pick a look): an AI
 * look replaces a picked look only for that one, so a late answer never undoes a newer choice.
 */
const studioKey = (personId: string) => `look.studio.${personId}`;
/**
 * How a studio Generate that went to the person's Mac ended (`GenerateOutcome` plus the
 * `studio` token it answered): a `look.generated` broadcast tells the studio it is there, so a
 * Mac that failed (not logged in, timed out, ...) is reported at once instead of after a
 * silent five-minute wait.
 */
const outcomeKey = (personId: string) => `look.outcome.${personId}`;
type StoredOutcome = GenerateOutcome & { studio: string };

const POKE_TEXT = {
  wave: "waved at you 👋",
  coffee: "wants to grab a coffee ☕",
  cheer: "cheers you on 🎉",
  cat: "sent a cat to sit on your keyboard 🐈",
} as const;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** SERVER_VERSION, else a fixed LATEST_CONNECTOR_VERSION, else "dev". */
export function serverVersion(env: AppEnv): string {
  if (env.SERVER_VERSION) return env.SERVER_VERSION;
  const latest = env.LATEST_CONNECTOR_VERSION?.trim();
  return latest && !isAutoVersion(latest) ? latest : "dev";
}

export function connectorPassword(env: AppEnv): string | undefined {
  return env.CONNECTOR_PASSWORD || (env.DEV_MODE === "1" ? "devpass" : undefined);
}

export function bearerOk(req: Request, env: AppEnv): boolean {
  const pw = connectorPassword(env);
  return !!pw && safeEqual(req.headers.get("authorization") ?? "", `Bearer ${pw}`);
}

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init.headers,
    },
  });

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class OfficeApp {
  readonly hub: Hub;
  readonly genui: AvatarService;
  readonly latest: LatestVersion;
  readonly timezone: string;
  private lastInteract = new Map<string, number>();
  private lastPoke = new Map<string, number>();
  readonly messages: OfficeMessages;
  readonly party: Party;
  readonly games: Games;
  private lastLook = new Map<string, number>();
  private lastDescribe = new Map<string, number>();
  /** studio Generates the server's provider is drawing: person -> its studio token, start */
  private generating = new Map<string, { studio: string; at: number }>();
  private readonly maxGenerates: number;
  private lastClaim = new Map<string, number>();

  constructor(
    private env: AppEnv,
    readonly store: Store,
    private transport: Transport,
    private opts: { now?: () => number; fetch?: FetchLike; log?: (line: string) => void } = {},
  ) {
    this.party = new Party(store);
    const log = opts.log ?? ((l: string) => console.log(l));
    this.timezone = env.OFFICE_TIMEZONE || "Europe/Vienna";
    const maxGenerates = Number.parseInt(env.GENUI_MAX_CALLS_PER_PERSON ?? "", 10);
    this.maxGenerates =
      Number.isFinite(maxGenerates) && maxGenerates >= 0 ? maxGenerates : LOOK_GENERATES_PER_DAY;
    this.genui = createAvatarService(env, store, {
      log,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    this.latest = new LatestVersion(env.LATEST_CONNECTOR_VERSION, {
      store,
      log,
      offline: env.DEV_MODE === "1",
      ...(env.GITHUB_REPO ? { repo: env.GITHUB_REPO } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    this.hub = new Hub(
      {
        password: connectorPassword(env),
        minConnectorVersion: env.MIN_CONNECTOR_VERSION || "0.0.0",
        latestConnectorVersion: this.latest.current,
        serverVersion: serverVersion(env),
        officeName: env.OFFICE_NAME || "Agent Office",
        timezone: this.timezone,
        avatarKey: this.genui.cacheKey,
      },
      store,
    );
    this.hub.log = log;
    this.messages = new OfficeMessages(
      store,
      this.hub,
      (socket, data) => transport.sendToConnector?.(socket, data) ?? false,
      (data) => transport.broadcast(data),
      (who, now) => this.interactionWait(who, now),
      this.lastPoke,
    );
    this.games = new Games(store, {
      timezone: this.timezone,
      people: () => new Map(this.hub.state().people.map((p) => [p.personId, p.name])),
      notify: (personId, text) => {
        const poke = JSON.stringify(
          envelope("connector.poked", { kind: "message", from: "Office games", text }),
        );
        let delivered = 0;
        for (const socketId of this.hub.liveSocketsOf(personId, this.now()))
          if (transport.sendToConnector?.(socketId, poke)) delivered++;
        return delivered;
      },
      codePending: (personId, now) => {
        try {
          const pending = JSON.parse(store.kvGet(`claim.${personId}`) ?? "null") as {
            exp?: number;
          } | null;
          return !!pending && typeof pending.exp === "number" && pending.exp > now;
        } catch {
          return false;
        }
      },
      broadcast: (data) => transport.broadcast(data),
    });
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Rebuild state after a restart / hibernation wake. */
  restore(sockets: { socketId: string; binding: Binding | null }[]): void {
    this.hub.restore(this.now(), sockets);
    this.scheduleAlarm();
  }

  connectorMessage(socketId: string, raw: unknown): SocketAction {
    const r = this.hub.onConnectorMessage(socketId, raw, this.now());
    // a hello (it returns a binding) is the only thing that refreshes the latest version
    if (r.binding) this.refreshLatest();
    return this.handle(r);
  }

  /** Background GitHub lookup when stale; the welcome that triggered it never waits. */
  private refreshLatest(): void {
    const p = this.latest.refreshIfStale();
    if (!p) return;
    this.transport.waitUntil?.(p.then((v) => this.hub.setLatestConnectorVersion(v)));
  }

  connectorClosed(socketId: string): void {
    this.handle(this.hub.onConnectorClosed(socketId, this.now()));
  }

  /** JSON of the office.snapshot a new viewer gets. */
  viewerSnapshot(): string {
    return JSON.stringify(this.snapshot());
  }

  /** The hub's snapshot plus the deployed version and today's whiteboard numbers. */
  snapshot(): MessageOf<"office.snapshot"> {
    const now = this.now();
    const snap = this.hub.snapshot(now);
    const live = snap.data.people.reduce((n, p) => n + p.sessions.length, 0);
    const today = computeOfficeDay(this.store.history(now - 3 * 86_400_000), {
      timezone: this.timezone,
      now,
      liveSessions: live,
    });
    const v = serverVersion(this.env);
    const version = v !== "dev" ? v : this.latest.current;
    return {
      ...snap,
      data: {
        ...snap.data,
        today,
        party: this.party.state(now),
        games: this.games.state(),
        ...(version ? { version } : {}),
      },
    };
  }

  alarm(): void {
    this.publish(this.hub.tick(this.now()));
    this.messages.prune(this.now());
    this.games.tick(this.now());
    this.scheduleAlarm();
  }

  private handle(r: HubResult): SocketAction {
    this.publish(r.events);
    this.scheduleAlarm();
    if (r.avatarJob) {
      const job = r.avatarJob;
      // a look from a hello (join, a new description): the server's provider, never a Mac. Any
      // connector with the shared password can say hello under any name, so neither its text
      // nor the person's description may go to a Mac on its say-so (see requestLocalLook)
      const p = this.genui
        .resolve(job)
        .then((res) => this.applyLook(job, res))
        .catch((err) => console.error("avatar job failed", err));
      this.transport.waitUntil?.(p);
    } else if (r.binding) this.retryStaleLook(r.binding.personId);
    if (r.lookGenerated) {
      const p = this.onLookGenerated(r.lookGenerated).catch((err) =>
        console.error("local look failed", err),
      );
      this.transport.waitUntil?.(p);
    }
    const action: SocketAction = {};
    if (r.reply) action.reply = r.reply;
    if (r.close) action.close = r.close;
    if (r.binding) action.binding = r.binding;
    return action;
  }

  private scheduleAlarm(): void {
    const deadlines = [
      this.hub.nextDeadline(),
      this.messages.nextDeadline(),
      this.games.nextDeadline(),
    ].filter((n): n is number => n !== null);
    this.transport.scheduleAlarm(deadlines.length ? Math.min(...deadlines) : null);
  }

  private interactionWait(who: string, now: number): number | null {
    const previous = this.lastInteract.get(who);
    if (previous !== undefined && now - previous < INTERACT_MIN_INTERVAL_MS)
      return Math.ceil((previous + INTERACT_MIN_INTERVAL_MS - now) / 1000);
    this.lastInteract.set(who, now);
    if (this.lastInteract.size > 500)
      this.lastInteract.delete(this.lastInteract.keys().next().value!);
    return null;
  }

  private publish(events: ViewerEvent[]): void {
    for (const e of events) this.transport.broadcast(JSON.stringify(e));
  }

  // ---- looks drawn on the person's own Mac --------------------------------------------------

  /**
   * Ask the owner's own Mac to draw a look studio Generate with its local AI tool (Claude Code
   * on their own subscription). Only for a Generate from a browser that proved it is the
   * person (`ao_me`), and only to `mac`: the connector socket whose claim code that browser
   * typed, if it is still connected. Never to another socket of the same name: a connector's
   * person is just the name it says hello with (shared password), so an impostor would get the
   * owner's description, or push its text to the owner's Mac. The request is remembered in the
   * store (one per person, the newest wins), so the answer is accepted only for a request this
   * server made, from that same socket, even across a hibernation (see onLookGenerated).
   * Returns the tool, or null when that Mac cannot (then the server provider takes the job).
   */
  private requestLocalLook(
    job: AvatarJob,
    studio: string,
    mac: string | undefined,
  ): LookGenerator | null {
    if (!job.selfDescription?.trim() || !mac || !this.transport.sendToConnector) return null;
    const now = this.now();
    const [generator] = this.hub.lookGeneratorsOf(job.personId, mac, now);
    if (!generator) return null;
    const requestId = `lr_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const sent = this.transport.sendToConnector(
      mac,
      JSON.stringify(
        envelope("connector.lookRequested", {
          requestId,
          system: SYSTEM_PROMPT,
          prompt: userPrompt(job),
          schema: AI_AVATAR_SCHEMA,
        }),
      ),
    );
    if (!sent) return null;
    const pending: PendingLook = { requestId, job, studio, mac, at: now, generator };
    this.store.kvPut(pendingLookKey(job.personId), JSON.stringify(pending));
    this.hub.log(`look ${job.personId} requested from their Mac (${generator})`);
    return generator;
  }

  private pendingLook(personId: string): PendingLook | null {
    try {
      const raw = this.store.kvGet(pendingLookKey(personId));
      return raw ? (JSON.parse(raw) as PendingLook) : null;
    } catch {
      return null;
    }
  }

  /** A connector's answer to `connector.lookRequested`. Unusable or failed: the server tries. */
  private async onLookGenerated(g: NonNullable<HubResult["lookGenerated"]>): Promise<void> {
    const pending = this.pendingLook(g.personId);
    if (!pending || pending.requestId !== g.requestId) {
      this.hub.log(`look ${g.personId}: ignored an answer to an unknown or older request`);
      return;
    }
    // only the Mac it was asked of may answer; a reconnected Mac resending it is a new, unproven
    // socket (and a request stored before Macs were proven has none): its look is dropped, and
    // once the Mac asked is gone the server's provider draws it now
    const fromMac = g.socketId === pending.mac;
    if (!fromMac) {
      this.hub.log(`look ${g.personId}: dropped an answer from another socket than the Mac asked`);
      if (this.hub.lookGeneratorsOf(g.personId, pending.mac, this.now()).length > 0) return;
    }
    this.store.kvPut(pendingLookKey(g.personId), "");
    const by = `local ${g.generator}`;
    const res =
      fromMac && g.avatar !== undefined ? this.genui.accept(g.avatar, pending.job, by) : null;
    if (res) {
      this.hub.log(`genui ${by} ${g.personId} drew a new look`);
      this.finishMacLook(pending, res);
      return;
    }
    const macError = !fromMac
      ? "your Mac reconnected while drawing"
      : g.error
        ? g.error
        : g.avatar !== undefined
          ? "its look did not fit the catalog"
          : "it gave no look";
    if (fromMac)
      this.hub.log(
        `look ${g.personId}: their Mac could not draw it (${macError}), trying the server`,
      );
    this.finishMacLook(pending, await this.serverLook(pending.job, pending.studio), macError);
  }

  /**
   * Apply the answer to a Generate that went to the person's Mac and remember how it ended for
   * the studio (outcomeKey). `macError` set = the Mac did not draw it, `res` is the server's.
   */
  private finishMacLook(pending: PendingLook, res: AvatarResult, macError?: string): void {
    const shown = this.applyLook(pending.job, res, pending.studio);
    if (!pending.studio) return;
    const outcome: StoredOutcome = {
      studio: pending.studio,
      by: macError === undefined ? "mac" : "server",
      result: this.generateResult(shown, res),
      ...(macError !== undefined ? { macError: macError.slice(0, 300) } : {}),
    };
    this.store.kvPut(outcomeKey(pending.job.personId), JSON.stringify(outcome));
    // the studio waits for this instead of polling; it then GETs the details (macError) once.
    // A Generate already replaced (newer one, saved parts) has nothing to report (lastGenerate)
    if (this.store.kvGet(studioKey(pending.job.personId)) !== pending.studio) return;
    const done: MessageOf<"look.generated"> = envelope("look.generated", {
      personId: pending.job.personId,
      result: outcome.result,
      by: outcome.by,
    });
    this.transport.broadcast(JSON.stringify(done));
  }

  /** The studio's word for how a Generate ended (see LookDescribeResponse.result). */
  private generateResult(shown: boolean, res: AvatarResult): GenerateOutcome["result"] {
    if (shown) return "ai";
    if (res.source === "ai") return "superseded";
    return this.genui.providerId === "off" ? "off" : "failed";
  }

  /** How the newest studio Generate sent to the person's Mac ended; null while still drawing. */
  private lastGenerate(personId: string): GenerateOutcome | null {
    try {
      const o = JSON.parse(
        this.store.kvGet(outcomeKey(personId)) || "null",
      ) as StoredOutcome | null;
      if (!o || o.studio !== this.store.kvGet(studioKey(personId))) return null;
      const { studio: _s, ...outcome } = o;
      return outcome;
    } catch {
      return null;
    }
  }

  /**
   * A Mac that took a look request and never answered (quit, updated, asleep): when one of the
   * person's connectors says hello again after LOOK_LOCAL_RETRY_MS, ask again: the same
   * Generate, and only the same proven Mac (a new socket, even of the same name, is not
   * proven), else the server's provider draws it.
   */
  private retryStaleLook(personId: string): void {
    const pending = this.pendingLook(personId);
    if (!pending || this.now() - pending.at < LOOK_LOCAL_RETRY_MS) return;
    this.store.kvPut(pendingLookKey(personId), "");
    if (pending.studio && this.requestLocalLook(pending.job, pending.studio, pending.mac)) return;
    const p = this.serverLook(pending.job, pending.studio)
      .then((res) => this.finishMacLook(pending, res, "your Mac did not answer"))
      .catch((err) => console.error("avatar job failed", err));
    this.transport.waitUntil?.(p);
  }

  // ---- look studio limits -----------------------------------------------------------------

  private generatesKey(personId: string): string {
    return `look.generates.${personId}.${new Date(this.now()).toISOString().slice(0, 10)}`;
  }

  private generatesToday(personId: string): number {
    return Number(this.store.kvGet(this.generatesKey(personId)) ?? 0);
  }

  /**
   * The server's provider draws a look. For a studio Generate (`studio`, directly or after
   * their Mac failed) it counts against the person's daily limit (at the limit the current
   * look stays, as at the daily cap) and is marked as running, so the studio cannot start
   * another one meanwhile.
   */
  private async serverLook(job: AvatarJob, studio?: string): Promise<AvatarResult> {
    if (!studio) return this.genui.resolve(job);
    const { personId } = job;
    this.generating.set(personId, { studio, at: this.now() });
    try {
      return await this.genui.resolve(job, {
        take: () => {
          const used = this.generatesToday(personId);
          if (used >= this.maxGenerates) return false;
          this.store.kvPut(this.generatesKey(personId), String(used + 1));
          return true;
        },
      });
    } finally {
      if (this.generating.get(personId)?.studio === studio) this.generating.delete(personId);
    }
  }

  /** Why a new studio Generate must wait for the last one (null = it need not). */
  private generateRunning(personId: string, now: number): string | null {
    // both bounded by LOOK_LOCAL_RETRY_MS: a hung call or a gone Mac never locks anyone out
    const g = this.generating.get(personId);
    if (g && now - g.at < LOOK_LOCAL_RETRY_MS)
      return "the AI is still drawing your last look, wait for it first";
    const pending = this.pendingLook(personId);
    // a look picked since then cancelled it (its answer is dropped), so that one is not waited for
    if (
      pending?.studio &&
      pending.studio === this.store.kvGet(studioKey(personId)) &&
      now - pending.at < LOOK_LOCAL_RETRY_MS
    )
      return "your Mac is still drawing your last look, wait for it first";
    return null;
  }

  /**
   * Store a resolved look, unless it is stale: made for an older description, or (`studio`,
   * the studio's Generate it answers) a newer Generate is on its way. True when that Generate
   * is still the newest and its AI look is now the person's look: then it also replaces a
   * picked look, as "Generate" asked, but never one picked after pressing it.
   */
  private applyLook(job: AvatarJob, res: AvatarResult, studio?: string): boolean {
    const { personId } = job;
    const newest = this.store.kvGet(studioKey(personId));
    if (
      (studio && newest && newest !== studio) ||
      !this.hub.isCurrentLookKey(personId, res.key) ||
      // the description changed meanwhile, also while a picked look kept the key as it was
      (job.selfDescription ?? "") !== this.hub.descriptionOf(personId)
    )
      return false;
    this.publish(
      this.hub.setAvatar(personId, res.avatar, res.key, this.now(), job.selfDescription ?? ""),
    );
    if (!studio || newest !== studio || res.source !== "ai") return false;
    if (this.hub.isCustomLook(personId)) {
      const back = this.hub.setCustomAvatar(personId, null, this.now());
      if (back) this.publish(back.events);
    }
    return true;
  }

  // ---- HTTP -------------------------------------------------------------------------------

  /** Handle /api/* (returns null for anything else). */
  async handleHttp(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    if (path === "/api/state" && method === "GET") return json(this.snapshot());

    if (path === "/api/me" && method === "GET")
      return json({ ok: true, personId: await meFromRequest(req, this.env, this.now()) });
    if (path === "/api/me" && method === "DELETE")
      return json({ ok: true }, { headers: { "set-cookie": meCookie(req, "", 0) } });

    const claim = /^\/api\/people\/([^/]{1,64})\/claim(\/verify)?$/.exec(path);
    if (claim && method === "POST") {
      let personId: string;
      try {
        personId = decodeURIComponent(claim[1]!);
      } catch {
        return json({ error: "bad person id" }, { status: 400 });
      }
      return claim[2] ? this.verifyClaim(req, personId) : this.sendClaimCode(req, personId);
    }

    if (path === "/api/messages" || path.startsWith("/api/messages/")) {
      if (!(await isAuthorized(req, this.env, this.now())))
        return json({ error: "unauthorized" }, { status: 401 });
      if (path === "/api/messages/owner" && method === "GET") {
        const owner = await messageOwner(req);
        return json({ ok: true }, { headers: owner.cookie ? { "set-cookie": owner.cookie } : {} });
      }
      const deletion = /^\/api\/messages\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (path !== "/api/messages" && !deletion)
        return json({ error: "not found" }, { status: 404 });
      if (path === "/api/messages" && method === "GET") {
        const parsed = MessageQuery.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success)
          return json({ error: "invalid message cursor or limit" }, { status: 400 });
        const owner = await messageOwner(req);
        const page = this.messages.page(parsed.data, this.now(), owner.hash);
        return json(page, { headers: owner.cookie ? { "set-cookie": owner.cookie } : {} });
      }
      if ((deletion && method !== "DELETE") || (!deletion && method !== "POST"))
        return json({ error: "method not allowed" }, { status: 405 });
      if (
        (req.headers.get("origin") && req.headers.get("origin") !== url.origin) ||
        req.headers.get("sec-fetch-site") === "cross-site"
      )
        return json({ error: "same-origin requests only" }, { status: 403 });
      if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
        return json({ error: "expected application/json" }, { status: 415 });
      if (deletion) {
        const owner = await messageOwner(req, false);
        const result = this.messages.delete(deletion[1]!, owner.hash, this.now());
        return json(result.error ? { error: result.error } : { ok: true }, {
          status: result.status,
        });
      }
      const body = await readPartyBody(req, 16_384);
      if (body.status)
        return json(
          { error: body.status === 413 ? "too large" : "invalid JSON" },
          { status: body.status },
        );
      const parsed = SendMessageRequest.safeParse(body.value);
      if (!parsed.success) return json({ error: "invalid message or audience" }, { status: 400 });
      const who = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "-";
      const owner = await messageOwner(req);
      const result = this.messages.send(parsed.data, who, this.now(), owner.hash!);
      this.scheduleAlarm();
      const headers: Record<string, string> = owner.cookie ? { "set-cookie": owner.cookie } : {};
      return "message" in result
        ? json(
            { ok: true, message: result.message, queued: result.queued },
            { status: result.status, headers },
          )
        : json(
            { error: result.error },
            {
              status: result.status,
              headers: {
                ...headers,
                ...(result.retryAfter ? { "retry-after": String(result.retryAfter) } : {}),
              },
            },
          );
    }
    if (path === "/api/interact" && method === "POST") return this.interact(req);
    if (path === "/api/party") {
      if (method !== "POST") return json({ error: "method not allowed" }, { status: 405 });
      const now = this.now();
      const who = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "-";
      const retryAfter = this.party.requestAllowed(who, now);
      if (retryAfter !== null)
        return json(
          { error: "slow down" },
          { status: 429, headers: { "retry-after": String(retryAfter) } },
        );
      if (!(await isAuthorized(req, this.env, now)))
        return json({ error: "unauthorized" }, { status: 401 });
      const body = await readPartyBody(req);
      if (body.status)
        return json(
          { error: body.status === 413 ? "too large" : "invalid JSON" },
          { status: body.status },
        );
      // you play as yourself: the person this browser is confirmed to be ("It's me")
      const me = await meFromRequest(req, this.env, now);
      const actor = (body.value as { personId?: unknown } | null)?.personId;
      if (typeof actor === "string" && actor !== me)
        return json(
          { error: me ? "you can only play as yourself" : "confirm who you are first" },
          { status: 403 },
        );
      const actionAt = this.now();
      const online = new Map(
        this.hub
          .state()
          .people.filter((p) => this.hub.liveSocketsOf(p.personId, actionAt).length > 0)
          .map((p) => [p.personId, p.avatar] as const),
      );
      const result = this.party.mutate(body.value, online, actionAt);
      if (result.status === 200) {
        const party = PartyState.parse(result.body);
        this.transport.broadcast(
          JSON.stringify(envelope("party.updated", { party }, { ts: actionAt })),
        );
      }
      return json(result.body, {
        status: result.status,
        ...(result.retryAfter ? { headers: { "retry-after": String(result.retryAfter) } } : {}),
      });
    }

    if (path === "/api/games" || path.startsWith("/api/games/")) return this.gamesHttp(req, path);

    const look = /^\/api\/people\/([^/]{1,64})\/avatar$/.exec(path);
    if (look) {
      let personId: string;
      try {
        personId = decodeURIComponent(look[1]!);
      } catch {
        return json({ error: "bad person id" }, { status: 400 });
      }
      if (method === "GET") {
        const p = this.hub.state().people.find((x) => x.personId === personId);
        if (!p) return json({ error: "not in the office" }, { status: 404 });
        // the description is the person's own words: only their own browser gets it back
        const proof = await meProofFromRequest(req, this.env, this.now());
        const mine = proof?.personId === personId;
        // the Mac this browser proved, the only one its Generate goes to
        const localLooks = mine ? this.hub.lookGeneratorsOf(personId, proof.mac, this.now()) : [];
        const lastGenerate = mine ? this.lastGenerate(personId) : null;
        return json({
          ok: true,
          avatar: p.avatar,
          custom: this.hub.isCustomLook(personId),
          aiLooks: this.genui.providerId !== "off" || localLooks.length > 0,
          serverLooks: this.genui.providerId !== "off",
          localLooks,
          ...(mine
            ? {
                description: this.hub.descriptionOf(personId),
                mac: this.hub.macLookState(personId, proof.mac, this.now()),
                ...(lastGenerate ? { lastGenerate } : {}),
              }
            : {}),
        } satisfies AvatarEditResponse);
      }
      if (method === "PUT") {
        // only your own look: the browser must have proven it is this person
        if ((await meFromRequest(req, this.env, this.now())) !== personId)
          return json(
            { error: "you can only change your own look (confirm it is you first)" },
            { status: 403 },
          );
        return this.editLook(req, personId);
      }
    }

    if (path === "/api/stats" && method === "GET") {
      const days = Number(url.searchParams.get("days") ?? 0);
      const since = days > 0 ? this.now() - days * 86_400_000 : 0;
      const sh = this.hub.shame.snapshot(this.now());
      const top = (m: Record<string, number>) =>
        Object.entries(m)
          .filter(([, v]) => v > 0)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 5)
          .map(([key, value]) => ({ key, value }));
      return json({
        ...computeStats(this.store.history(since), {
          timezone: this.timezone,
          now: this.now(),
          names: this.hub.knownNames(),
        }),
        shame: { clears: top(sh.clears), waits: top(sh.longestWaitMs), fires: top(sh.fires) },
      });
    }

    const describe = /^\/api\/people\/([^/]{1,64})\/look$/.exec(path);
    if (describe && method === "POST") {
      let personId: string;
      try {
        personId = decodeURIComponent(describe[1]!);
      } catch {
        return json({ error: "bad person id" }, { status: 400 });
      }
      const proof = await meProofFromRequest(req, this.env, this.now());
      if (proof?.personId !== personId)
        return json(
          { error: "you can only change your own look (confirm it is you first)" },
          { status: 403 },
        );
      return this.describeLook(req, personId, proof.mac);
    }

    const person = /^\/api\/people\/([^/]{1,64})$/.exec(path);
    if (person && method === "GET") {
      let personId: string;
      try {
        personId = decodeURIComponent(person[1]!);
      } catch {
        return json({ error: "bad person id" }, { status: 400 });
      }
      const now = this.now();
      // two extra days so sessions that started before midnight still count as running
      const rows = this.store.history(now - 3 * 86_400_000);
      const live = this.hub.state().people.find((p) => p.personId === personId);
      const name = live?.name ?? this.hub.knownNames()[personId] ?? null;
      if (!live && !name && !rows.some((r) => r.person === personId))
        return json({ error: "not found" }, { status: 404 });
      return json(
        computePersonDay(rows, personId, {
          timezone: this.timezone,
          now,
          name,
          online: !!live,
          liveSessions: live?.sessions.length ?? 0,
          recentActivity: this.hub.recentActivity(personId, now),
        }),
      );
    }

    const personGif = /^\/api\/people\/([^/]{1,64})\/gif$/.exec(path);
    if (personGif && method === "PUT") return this.putGif(req, personGif[1]!);

    if (path === "/api/history.csv" && method === "GET") {
      return new Response(historyToCsv(this.store.history()), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="agent-office-history.csv"',
          "cache-control": "no-store",
        },
      });
    }

    if (path === "/api/history/backfill" && method === "POST") {
      if (!bearerOk(req, this.env)) return json({ error: "unauthorized" }, { status: 401 });
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid JSON" }, { status: 400 });
      }
      const rows = Array.isArray(body) ? body : (body as { rows?: unknown })?.rows;
      const parsed = z.array(HistoryRow).max(BACKFILL_MAX_ROWS).safeParse(rows);
      if (!parsed.success)
        return json({ error: z.prettifyError(parsed.error).slice(0, 1000) }, { status: 400 });
      this.store.appendHistory(parsed.data);
      return json({ inserted: parsed.data.length });
    }

    if (path === "/api/snapshots" && method === "GET") {
      return json({
        snapshots: this.store
          .listSnapshots()
          .map((s) => ({ ...s, url: `/api/snapshots/${s.id}.png` })),
      });
    }

    if (path === "/api/snapshots" && method === "POST") return this.uploadSnapshot(req);

    const m = /^\/api\/snapshots\/(\d+)\.png$/.exec(path);
    if (m && method === "GET") {
      const png = this.store.getSnapshot(Number(m[1]));
      if (!png) return json({ error: "not found" }, { status: 404 });
      return new Response(png, {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (path === "/api/export" && method === "GET") return this.exportData(req, url);

    if (path.startsWith("/api/")) return json({ error: "not found" }, { status: 404 });
    return null;
  }

  /**
   * Full data export for moving to another server (apps/server/scripts/export-postgres.ts).
   * Password only, so kiosk keys and browser sessions cannot dump owner hashes and claims.
   * Without `table`: the tables, their columns and row counts. With `table`: one page of
   * rows after rowid `after`; BLOBs come as {"$base64": ...}.
   */
  private exportData(req: Request, url: URL): Response {
    if (!bearerOk(req, this.env)) return json({ error: "unauthorized" }, { status: 401 });
    const { exportTables, exportRows } = this.store;
    if (!exportTables || !exportRows)
      return json({ error: "store cannot export" }, { status: 501 });
    const table = url.searchParams.get("table");
    if (!table) {
      return json({
        version: serverVersion(this.env),
        exportedAt: this.now(),
        tables: exportTables.call(this.store),
      });
    }
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 500), 1), 1000);
    if (!Number.isFinite(after) || !Number.isFinite(limit))
      return json({ error: "bad after/limit" }, { status: 400 });
    let rows: ReturnType<typeof exportRows>;
    try {
      rows = exportRows.call(this.store, table, after, limit);
    } catch {
      return json({ error: "unknown table" }, { status: 404 });
    }
    return json({
      rows: rows.map((r) => ({
        rowid: r.rowid,
        values: r.values.map((v) => (v instanceof Uint8Array ? { $base64: toBase64(v) } : v)),
      })),
      next: rows.length === limit ? rows.at(-1)!.rowid : null,
    });
  }

  /**
   * "This is me": send a one-time code as a notification to the person's live Macs (the
   * poke channel, so every connector shows it). Whoever can read it there may edit the look.
   * A courtesy lock, not identity: a connector's person is just the name it reports with the
   * shared password, so a colleague could start one under someone else's name. Each socket
   * gets its own code, so the browser is tied to the one Mac it read it on: the only Mac its
   * look studio sends a description to (requestLocalLook).
   */
  /**
   * Turn-based games. Reading a game is for every viewer (a hidden fleet only goes to its
   * owner); doing anything needs the `ao_me` cookie: you play as yourself.
   */
  private async gamesHttp(req: Request, path: string): Promise<Response> {
    const method = req.method.toUpperCase();
    const now = this.now();
    if (!(await isAuthorized(req, this.env, now)))
      return json({ error: "unauthorized" }, { status: 401 });
    const me = await meFromRequest(req, this.env, now);
    if (method === "GET") {
      const id = /^\/api\/games\/([A-Za-z0-9_-]{1,64})$/.exec(path)?.[1];
      if (!id) return json({ error: "not found" }, { status: 404 });
      if (id === "me") {
        if (!me) return json({ error: "confirm who you are first" }, { status: 403 });
        const r = this.games.settings(me);
        return json(r.body, { status: r.status });
      }
      const r = this.games.get(id, me);
      return json(r.body, { status: r.status });
    }
    if (path !== "/api/games" || method !== "POST")
      return json({ error: "method not allowed" }, { status: 405 });
    // per address and claimed person: a whole office shares one address, and two colleagues
    // playing each other must not trip over one limit (the name is not trusted here, it only
    // picks the bucket)
    const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "-";
    const claimed = /(?:^|;\s*)ao_me=([^.;]{1,64})/.exec(req.headers.get("cookie") ?? "")?.[1];
    const who = `${ip}|${claimed ?? ""}`;
    const retryAfter = this.games.requestAllowed(who, now);
    if (retryAfter !== null)
      return json(
        { error: "slow down" },
        { status: 429, headers: { "retry-after": String(retryAfter) } },
      );
    if (!me) return json({ error: "confirm who you are first" }, { status: 403 });
    const body = await readPartyBody(req);
    if (body.status)
      return json(
        { error: body.status === 413 ? "too large" : "invalid JSON" },
        { status: body.status },
      );
    const r = this.games.handle(me, body.value, now);
    this.scheduleAlarm();
    return json(r.body, { status: r.status });
  }

  private async sendClaimCode(req: Request, personId: string): Promise<Response> {
    const now = this.now();
    if (!this.hub.state().people.some((p) => p.personId === personId))
      return json({ error: "not in the office" }, { status: 404 });
    const who = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "-";
    if (now - (this.lastClaim.get(personId) ?? 0) < CLAIM_RESEND_MS)
      return json({ error: "a code was just sent, check the Mac" }, { status: 429 });
    if (now - (this.lastClaim.get(`ip:${who}`) ?? 0) < INTERACT_MIN_INTERVAL_MS)
      return json({ error: "slow down" }, { status: 429 });
    const sockets = this.hub.liveSocketsOf(personId, now);
    if (sockets.length === 0)
      return json({ error: "no Mac of theirs is connected right now" }, { status: 409 });
    // a Mac drops a notification within 5 s of the last one: a code right after a game
    // notification would vanish without anybody noticing
    if (now - this.games.noticedAt(personId) < 5_000)
      return json(
        { error: "a notification just went to that Mac, try again in a few seconds" },
        { status: 429 },
      );
    const dayKey = `claim.day.${personId}.${new Date(now).toISOString().slice(0, 10)}`;
    const today = Number(this.store.kvGet(dayKey) ?? 0);
    if (today >= CLAIM_MAX_PER_DAY)
      return json(
        { error: "too many codes for this person today, try again tomorrow" },
        { status: 429 },
      );
    this.store.kvPut(dayKey, String(today + 1));
    this.lastClaim.set(personId, now);
    this.lastClaim.set(`ip:${who}`, now);
    if (this.lastClaim.size > 500) this.lastClaim.clear();
    const codes: ClaimCode[] = [];
    while (codes.length < sockets.length) {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(
        6,
        "0",
      );
      if (!codes.some((c) => c.code === code)) codes.push({ code, mac: sockets[codes.length]! });
    }
    this.store.kvPut(
      `claim.${personId}`,
      JSON.stringify({ codes, exp: now + CLAIM_CODE_TTL_MS, tries: 0 } satisfies PendingClaim),
    );
    let delivered = 0;
    for (const { code, mac } of codes) {
      const poke = JSON.stringify(
        envelope("connector.poked", {
          kind: "message",
          from: "Agent Office",
          text: `Your Agent Office code: ${code} (5 min). Not you? Just ignore this.`,
        }),
      );
      if (this.transport.sendToConnector?.(mac, poke)) delivered++;
    }
    this.hub.log(`look ${personId} claim code sent to ${delivered} Mac(s)`);
    if (delivered === 0)
      return json({ error: "no Mac of theirs is connected right now" }, { status: 409 });
    return json({ ok: true, delivered });
  }

  /** Check a "this is me" code; on success the browser gets the signed `ao_me` cookie. */
  private async verifyClaim(req: Request, personId: string): Promise<Response> {
    let code = "";
    try {
      code = String(((await req.json()) as { code?: unknown }).code ?? "").replace(/\D/g, "");
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const now = this.now();
    const key = `claim.${personId}`;
    let pending: PendingClaim | null = null;
    try {
      pending = JSON.parse(this.store.kvGet(key) ?? "null");
    } catch {
      pending = null;
    }
    if (
      !pending ||
      !Array.isArray(pending.codes) ||
      pending.exp < now ||
      pending.tries >= CLAIM_MAX_TRIES
    )
      return json({ error: "no valid code, send a new one" }, { status: 410 });
    const match = pending.codes.find((c) => c.code === code);
    if (!match) {
      pending.tries++;
      this.store.kvPut(key, JSON.stringify(pending));
      const left = CLAIM_MAX_TRIES - pending.tries;
      return json(
        {
          error:
            left > 0
              ? `wrong code, ${left} ${left === 1 ? "try" : "tries"} left`
              : "wrong code, that one is used up: send a new one",
        },
        { status: 403 },
      );
    }
    this.store.kvPut(key, "null");
    const pw = connectorPassword(this.env);
    if (!pw) return json({ error: "office has no password" }, { status: 500 });
    const token = await makeMeToken(pw, personId, now, match.mac);
    this.hub.log(`look ${personId} claimed by a browser`);
    return json(
      { ok: true, personId },
      { headers: { "set-cookie": meCookie(req, token, ME_TTL_MS / 1000) } },
    );
  }

  /**
   * PUT /api/people/:personId/gif: set or remove a person's head GIF from the web UI. Own GIF
   * only, like the look (L9): the browser needs that person's signed `ao_me` cookie ("It's
   * me"); a Bearer connector password also works (scripts). Checked before the body or the
   * person lookup. A connector reconnect does not undo it (see `Hub.helloGifs`).
   */
  private async putGif(req: Request, rawId: string): Promise<Response> {
    let personId: string;
    try {
      personId = decodeURIComponent(rawId);
    } catch {
      return json({ error: "bad person id" }, { status: 400 });
    }
    const me = await meFromRequest(req, this.env, this.now());
    if (me !== personId && !bearerOk(req, this.env))
      return json(
        { error: "you can only change your own GIF (confirm it is you first)" },
        { status: 403 },
      );
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const parsed = SetGifRequest.safeParse(body);
    if (!parsed.success)
      return json({ error: z.prettifyError(parsed.error).slice(0, 500) }, { status: 400 });
    const link = parsed.data.link?.trim() ?? "";
    let gif: string | undefined;
    if (link) {
      const id = parseGiphyId(link);
      if (!id)
        return json(
          { error: "not a Giphy GIF link (paste a giphy.com/gifs/... or media.giphy.com link)" },
          { status: 400 },
        );
      gif = id;
    }
    const events = this.hub.setGif(personId, gif, this.now());
    if (!events) return json({ error: "not in the office" }, { status: 404 });
    this.publish(events);
    this.transport.scheduleAlarm(this.hub.nextDeadline());
    return json({ personId, gif: gif ?? null } satisfies SetGifResponse);
  }

  /** Look editor: pin a custom look or go back to the automatic one. */
  private async editLook(req: Request, personId: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const parsed = AvatarEditRequest.safeParse(body);
    if (!parsed.success)
      return json({ error: z.prettifyError(parsed.error).slice(0, 500) }, { status: 400 });
    const now = this.now();
    const who = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "-";
    if (now - (this.lastLook.get(who) ?? 0) < LOOK_MIN_INTERVAL_MS)
      return json({ error: "slow down" }, { status: 429 });
    this.lastLook.set(who, now);
    if (this.lastLook.size > 500) this.lastLook.clear();

    const r = this.hub.setCustomAvatar(personId, parsed.data.avatar, now);
    if (!r) return json({ error: "not in the office" }, { status: 404 });
    // a look picked now wins over a studio Generate still on its way
    if (parsed.data.avatar) this.store.kvPut(studioKey(personId), "");
    this.hub.log(`look ${personId} edited by ${parsed.data.from || "someone"}`);
    this.publish(r.events);
    let avatar = r.avatar;
    // Automatic draws the stored description, which any hello under this name may have set:
    // the server's provider, never a Mac (only a Generate's own text goes to the proven Mac)
    if (r.avatarJob) {
      const job = r.avatarJob;
      const res = await this.genui.resolve(job);
      this.publish(
        this.hub.setAvatar(
          job.personId,
          res.avatar,
          res.key,
          this.now(),
          job.selfDescription ?? "",
        ),
      );
      avatar = res.avatar;
    }
    this.scheduleAlarm();
    return json({
      ok: true,
      avatar,
      custom: parsed.data.avatar !== null,
    } satisfies AvatarEditResponse);
  }

  /**
   * Look studio: the owner describes their look, the Mac this browser proved (`proven`, see
   * requestLocalLook) or the server's GenUI turns it into one. Waits for the server's AI (up to
   * its timeout) so the studio can show the result.
   * The description is saved even when AI looks are off, so it is used as soon as they are
   * turned on. One Generate at a time per person, and LOOK_GENERATES_PER_DAY on the server's AI.
   */
  private async describeLook(
    req: Request,
    personId: string,
    proven: string | undefined,
  ): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const parsed = LookDescribeRequest.safeParse(body);
    if (!parsed.success)
      return json({ error: z.prettifyError(parsed.error).slice(0, 500) }, { status: 400 });
    const now = this.now();
    const running = this.generateRunning(personId, now);
    if (running) return json({ error: running }, { status: 429 });
    const retryIn = (this.lastDescribe.get(personId) ?? 0) + LOOK_DESCRIBE_MIN_INTERVAL_MS - now;
    if (retryIn > 0)
      return json(
        { error: `one new look at a time, try again in ${Math.ceil(retryIn / 1000)} s` },
        { status: 429, headers: { "retry-after": String(Math.ceil(retryIn / 1000)) } },
      );
    // the Mac this browser proved cannot draw it, so the server's AI would: refused up front at
    // their limit
    const mac =
      !!this.transport.sendToConnector &&
      this.hub.lookGeneratorsOf(personId, proven, now).length > 0;
    if (
      !mac &&
      this.genui.providerId !== "off" &&
      this.generatesToday(personId) >= this.maxGenerates
    ) {
      const resetIn = Math.ceil((86_400_000 - (now % 86_400_000)) / 1000);
      return json(
        {
          error: `you used today's ${this.maxGenerates} looks from the office's AI, more after midnight UTC (or confirm it is you with the code on a connected Mac with Claude Code: it draws them on your own subscription)`,
        },
        { status: 429, headers: { "retry-after": String(resetIn) } },
      );
    }
    const job = this.hub.describeLook(personId, parsed.data.description);
    if (!job) return json({ error: "not in the office" }, { status: 404 });
    this.lastDescribe.set(personId, now);
    const current = () =>
      this.hub.state().people.find((p) => p.personId === personId)?.avatar ?? job.previous;

    // the Mac this browser proved draws it (their own AI subscription); the studio waits for
    // avatar.updated
    const studio = crypto.randomUUID();
    this.store.kvPut(studioKey(personId), studio);
    const generator = this.requestLocalLook(job, studio, proven);
    if (generator) {
      const avatar = current();
      if (avatar)
        return json({
          ok: true,
          avatar,
          result: "pending",
          generator,
        } satisfies LookDescribeResponse);
    }

    // why their Mac did not take it, read before the server's AI call (the Mac may come and go)
    const macState = this.hub.macLookState(personId, proven, now);
    const res = await this.serverLook(job, studio);
    // a new AI look replaces a look picked in the editor: that is what "Generate" asked for
    const shown = this.applyLook(job, res, studio);
    const avatar = current() ?? res.avatar;
    const result = this.generateResult(shown, res);
    return json({
      ok: result === "ai",
      avatar,
      result,
      mac: macState,
    } satisfies LookDescribeResponse);
  }

  private async interact(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const parsed = InteractRequest.safeParse(body);
    if (!parsed.success)
      return json({ error: z.prettifyError(parsed.error).slice(0, 500) }, { status: 400 });
    const r = parsed.data;
    const now = this.now();

    const who = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "-";
    const wait = this.interactionWait(who, now);
    if (wait !== null)
      return json(
        { error: "slow down" },
        { status: 429, headers: { "retry-after": String(wait) } },
      );

    if (r.personId && !this.hub.state().people.some((p) => p.personId === r.personId))
      return json({ error: "not in the office" }, { status: 404 });

    let delivered = 0;
    const kind = r.kind;
    const pokes =
      kind === "wave" ||
      kind === "coffee" ||
      kind === "cheer" ||
      kind === "message" ||
      kind === "cat";
    const officeOnly = !pokes;
    if (r.personId && pokes) {
      if (now - (this.lastPoke.get(r.personId) ?? 0) < POKE_PER_PERSON_MS)
        return json({ error: "they were just poked, give them a moment" }, { status: 429 });
      this.lastPoke.set(r.personId, now);
      const from = r.from || undefined;
      const text = kind === "message" ? r.text! : `${from ?? "Someone"} ${POKE_TEXT[kind]}`;
      const poke = JSON.stringify(
        envelope("connector.poked", { kind, text, ...(from ? { from } : {}) }),
      );
      for (const socketId of this.hub.liveSocketsOf(r.personId, now)) {
        if (this.transport.sendToConnector?.(socketId, poke)) delivered++;
      }
    }

    const event: MessageOf<"interaction.happened"> = envelope("interaction.happened", {
      kind: r.kind,
      ...(r.personId ? { personId: r.personId } : {}),
      ...(r.from ? { from: r.from } : {}),
      ...(r.text && r.kind === "message" ? { text: r.text } : {}),
      ...(r.personId && !officeOnly ? { delivered } : {}),
      ...(r.catId !== undefined ? { catId: r.catId } : {}),
      ...(r.x !== undefined && r.y !== undefined ? { x: r.x, y: r.y } : {}),
    });
    this.transport.broadcast(JSON.stringify(event));
    this.hub.log(`interaction ${r.kind} ${r.personId ?? "-"} delivered=${delivered}`);
    return json({ ok: true, delivered } satisfies InteractResponse);
  }

  private async uploadSnapshot(req: Request): Promise<Response> {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > SNAPSHOT_MAX_BYTES) return json({ error: "too large" }, { status: 413 });
    const png = new Uint8Array(await req.arrayBuffer());
    if (png.byteLength > SNAPSHOT_MAX_BYTES) return json({ error: "too large" }, { status: 413 });
    if (png.byteLength < 8 || PNG_MAGIC.some((b, i) => png[i] !== b)) {
      return json({ error: "expected a PNG body" }, { status: 415 });
    }
    const now = this.now();
    const trusted = bearerOk(req, this.env);
    // the kiosk recorder posts every 15 min; Bearer CONNECTOR_PASSWORD bypasses (simulator, tests)
    if (!trusted) {
      const last = Number(this.store.kvGet("snapshots.last") ?? 0);
      if (now - last < SNAPSHOT_MIN_INTERVAL_MS) {
        const retry = Math.ceil((last + SNAPSHOT_MIN_INTERVAL_MS - now) / 1000);
        return json(
          { error: "rate limited" },
          { status: 429, headers: { "retry-after": String(retry) } },
        );
      }
    }
    // Bearer uploads may backdate a frame with ?ts=<ms> (screenshots, imports); never the future
    const asked = trusted ? Number(new URL(req.url).searchParams.get("ts")) : Number.NaN;
    const ts = Number.isFinite(asked) && asked > 0 ? Math.min(Math.round(asked), now) : now;
    if (!trusted) this.store.kvPut("snapshots.last", String(now));
    const id = this.store.addSnapshot(ts, png);
    return json({ id, ts, url: `/api/snapshots/${id}.png` }, { status: 201 });
  }
}
