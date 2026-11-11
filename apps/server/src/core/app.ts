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
  type ServerToConnector,
  type ViewerEvent,
} from "@agent-office/protocol";
import { z } from "zod";
import { type AvatarService, createAvatarService, type FetchLike, type GenuiEnv } from "./genui.ts";
import { type Binding, Hub, type HubResult } from "./hub.ts";
import { isAutoVersion, LatestVersion } from "./latest.ts";
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
  private lastLook = new Map<string, number>();

  constructor(
    private env: AppEnv,
    readonly store: Store,
    private transport: Transport,
    private opts: { now?: () => number; fetch?: FetchLike; log?: (line: string) => void } = {},
  ) {
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
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Rebuild state after a restart / hibernation wake. */
  restore(sockets: { socketId: string; binding: Binding | null }[]): void {
    this.hub.restore(this.now(), sockets);
    this.transport.scheduleAlarm(this.hub.nextDeadline());
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
    return { ...snap, data: { ...snap.data, today, ...(version ? { version } : {}) } };
  }

  alarm(): void {
    this.publish(this.hub.tick(this.now()));
    this.transport.scheduleAlarm(this.hub.nextDeadline());
  }

  private handle(r: HubResult): SocketAction {
    this.publish(r.events);
    this.transport.scheduleAlarm(this.hub.nextDeadline());
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

    if (path === "/api/me" && method === "GET") return json({ ok: true });

    if (path === "/api/interact" && method === "POST") return this.interact(req);

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
      if (method === "PUT") return this.editLook(req, personId);
    }

    if (path === "/api/stats" && method === "GET") {
      const days = Number(url.searchParams.get("days") ?? 0);
      const since = days > 0 ? this.now() - days * 86_400_000 : 0;
      return json(
        computeStats(this.store.history(since), {
          timezone: this.timezone,
          now: this.now(),
          names: this.hub.knownNames(),
        }),
      );
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
    this.transport.scheduleAlarm(this.hub.nextDeadline());
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
    if (now - (this.lastInteract.get(who) ?? 0) < INTERACT_MIN_INTERVAL_MS)
      return json({ error: "slow down" }, { status: 429 });
    this.lastInteract.set(who, now);
    if (this.lastInteract.size > 500) this.lastInteract.clear();

    if (r.personId && !this.hub.state().people.some((p) => p.personId === r.personId))
      return json({ error: "not in the office" }, { status: 404 });

    let delivered = 0;
    if (r.personId && r.kind !== "paper" && r.kind !== "pet") {
      if (now - (this.lastPoke.get(r.personId) ?? 0) < POKE_PER_PERSON_MS)
        return json({ error: "they were just poked, give them a moment" }, { status: 429 });
      this.lastPoke.set(r.personId, now);
      const from = r.from || undefined;
      const text = r.kind === "message" ? r.text! : `${from ?? "Someone"} ${POKE_TEXT[r.kind]}`;
      const poke = JSON.stringify(
        envelope("connector.poked", { kind: r.kind, text, ...(from ? { from } : {}) }),
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
      ...(r.personId && r.kind !== "paper" ? { delivered } : {}),
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
