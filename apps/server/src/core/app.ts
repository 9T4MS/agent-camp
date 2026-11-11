/**
 * OfficeApp: everything the Durable Object and the Bun dev server share. Wraps the Hub,
 * the store, GenUI and the /api/* routes. Uses only web-standard Request/Response;
 * sockets are abstracted behind `Transport` and identified by string ids.
 */
import {
  AvatarEditRequest,
  type AvatarEditResponse,
  envelope,
  HistoryRow,
  InteractRequest,
  type InteractResponse,
  type MessageOf,
  MessageQuery,
  PartyState,
  SendMessageRequest,
  type ServerToConnector,
  type ViewerEvent,
} from "@agent-office/protocol";
import { z } from "zod";
import { isAuthorized, ME_TTL_MS, makeMeToken, meCookie, meFromRequest } from "./auth.ts";
import { type AvatarService, createAvatarService, type FetchLike, type GenuiEnv } from "./genui.ts";
import { type Binding, Hub, type HubResult } from "./hub.ts";
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

const POKE_TEXT = {
  wave: "waved at you 👋",
  coffee: "wants to grab a coffee ☕",
  cheer: "cheers you on 🎉",
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
  return !!pw && req.headers.get("authorization") === `Bearer ${pw}`;
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

export class OfficeApp {
  readonly hub: Hub;
  readonly genui: AvatarService;
  readonly latest: LatestVersion;
  readonly timezone: string;
  private lastInteract = new Map<string, number>();
  private lastPoke = new Map<string, number>();
  readonly messages: OfficeMessages;
  readonly party: Party;
  private lastLook = new Map<string, number>();
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
      data: { ...snap.data, today, party: this.party.state(now), ...(version ? { version } : {}) },
    };
  }

  alarm(): void {
    this.publish(this.hub.tick(this.now()));
    this.messages.prune(this.now());
    this.scheduleAlarm();
  }

  private handle(r: HubResult): SocketAction {
    this.publish(r.events);
    this.scheduleAlarm();
    if (r.avatarJob) {
      const job = r.avatarJob;
      const p = this.genui
        .resolve(job)
        .then((res) =>
          this.publish(
            this.hub.setAvatar(
              job.personId,
              res.avatar,
              res.key,
              this.now(),
              job.selfDescription ?? "",
            ),
          ),
        )
        .catch((err) => console.error("avatar job failed", err));
      this.transport.waitUntil?.(p);
    }
    const action: SocketAction = {};
    if (r.reply) action.reply = r.reply;
    if (r.close) action.close = r.close;
    if (r.binding) action.binding = r.binding;
    return action;
  }

  private scheduleAlarm(): void {
    const deadlines = [this.hub.nextDeadline(), this.messages.nextDeadline()].filter(
      (n): n is number => n !== null,
    );
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
      if (!parsed.success)
        return json({ error: "invalid message, audience or request ID" }, { status: 400 });
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
        return json({
          ok: true,
          avatar: p.avatar,
          custom: this.hub.isCustomLook(personId),
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

    if (path.startsWith("/api/")) return json({ error: "not found" }, { status: 404 });
    return null;
  }

  /**
   * "This is me": send a one-time code as a notification to the person's live Macs (the
   * poke channel, so every connector shows it). Whoever can read it there may edit the look.
   * A courtesy lock, not identity: a connector's person is just the name it reports with the
   * shared password, so a colleague could start one under someone else's name.
   */
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
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(
      6,
      "0",
    );
    this.store.kvPut(
      `claim.${personId}`,
      JSON.stringify({ code, exp: now + CLAIM_CODE_TTL_MS, tries: 0 }),
    );
    const poke = JSON.stringify(
      envelope("connector.poked", {
        kind: "message",
        from: "Agent Office",
        text: `Your code to edit your look: ${code} (5 min). Not you? Just ignore this.`,
      }),
    );
    let delivered = 0;
    for (const socketId of sockets)
      if (this.transport.sendToConnector?.(socketId, poke)) delivered++;
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
    let pending: { code: string; exp: number; tries: number } | null = null;
    try {
      pending = JSON.parse(this.store.kvGet(key) ?? "null");
    } catch {
      pending = null;
    }
    if (!pending || pending.exp < now || pending.tries >= CLAIM_MAX_TRIES)
      return json({ error: "no valid code, send a new one" }, { status: 410 });
    if (code !== pending.code) {
      pending.tries++;
      this.store.kvPut(key, JSON.stringify(pending));
      return json({ error: "wrong code" }, { status: 403 });
    }
    this.store.kvPut(key, "null");
    const pw = connectorPassword(this.env);
    if (!pw) return json({ error: "office has no password" }, { status: 500 });
    const token = await makeMeToken(pw, personId, now);
    this.hub.log(`look ${personId} claimed by a browser`);
    return json(
      { ok: true, personId },
      { headers: { "set-cookie": meCookie(req, token, ME_TTL_MS / 1000) } },
    );
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
    this.hub.log(`look ${personId} edited by ${parsed.data.from || "someone"}`);
    this.publish(r.events);
    let avatar = r.avatar;
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
    const pokes = kind === "wave" || kind === "coffee" || kind === "cheer" || kind === "message";
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
