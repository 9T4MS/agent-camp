/**
 * OfficeApp: everything the Durable Object and the Bun dev server share. Wraps the Hub,
 * the store, GenUI and the /api/* routes. Uses only web-standard Request/Response;
 * sockets are abstracted behind `Transport` and identified by string ids.
 */
import { HistoryRow, type ServerToConnector, type ViewerEvent } from "@agent-office/protocol";
import { z } from "zod";
import { type AvatarService, createAvatarService, type FetchLike, type GenuiEnv } from "./genui.ts";
import { type Binding, Hub, type HubResult } from "./hub.ts";
import { computeStats, historyToCsv } from "./stats.ts";
import type { Store } from "./store.ts";

export type AppEnv = GenuiEnv & {
  CONNECTOR_PASSWORD?: string;
  VIEWER_KEY?: string;
  LATEST_CONNECTOR_VERSION?: string;
  MIN_CONNECTOR_VERSION?: string;
  SERVER_VERSION?: string;
  OFFICE_NAME?: string;
  OFFICE_TIMEZONE?: string;
  /** "1" = local dev: CONNECTOR_PASSWORD defaults to "devpass" */
  DEV_MODE?: string;
};

export interface Transport {
  /** send to every connected viewer */
  broadcast(json: string): void;
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
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

export function connectorPassword(env: AppEnv): string | undefined {
  return env.CONNECTOR_PASSWORD || (env.DEV_MODE === "1" ? "devpass" : undefined);
}

/** Optional VIEWER_KEY gate for /ws/viewer (query param `key`). */
export function viewerAllowed(url: URL, env: AppEnv): boolean {
  return !env.VIEWER_KEY || url.searchParams.get("key") === env.VIEWER_KEY;
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
  readonly timezone: string;

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
    const latest = env.LATEST_CONNECTOR_VERSION || "0.0.0-dev";
    this.hub = new Hub(
      {
        password: connectorPassword(env),
        minConnectorVersion: env.MIN_CONNECTOR_VERSION || "0.0.0",
        latestConnectorVersion: latest,
        serverVersion: env.SERVER_VERSION || latest,
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
    return this.handle(this.hub.onConnectorMessage(socketId, raw, this.now()));
  }

  connectorClosed(socketId: string): void {
    this.handle(this.hub.onConnectorClosed(socketId, this.now()));
  }

  /** JSON of the office.snapshot a new viewer gets. */
  viewerSnapshot(): string {
    return JSON.stringify(this.hub.snapshot(this.now()));
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
          this.publish(this.hub.setAvatar(job.personId, res.avatar, res.key, this.now())),
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

    if (path === "/api/state" && method === "GET") return json(this.hub.snapshot(this.now()));

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

  private async uploadSnapshot(req: Request): Promise<Response> {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > SNAPSHOT_MAX_BYTES) return json({ error: "too large" }, { status: 413 });
    const png = new Uint8Array(await req.arrayBuffer());
    if (png.byteLength > SNAPSHOT_MAX_BYTES) return json({ error: "too large" }, { status: 413 });
    if (png.byteLength < 8 || PNG_MAGIC.some((b, i) => png[i] !== b)) {
      return json({ error: "expected a PNG body" }, { status: 415 });
    }
    const now = this.now();
    // the kiosk recorder posts every 15 min; Bearer CONNECTOR_PASSWORD bypasses (simulator, tests)
    if (!bearerOk(req, this.env)) {
      const last = Number(this.store.kvGet("snapshots.last") ?? 0);
      if (now - last < SNAPSHOT_MIN_INTERVAL_MS) {
        const retry = Math.ceil((last + SNAPSHOT_MIN_INTERVAL_MS - now) / 1000);
        return json(
          { error: "rate limited" },
          { status: 429, headers: { "retry-after": String(retry) } },
        );
      }
    }
    this.store.kvPut("snapshots.last", String(now));
    const id = this.store.addSnapshot(now, png);
    return json({ id, ts: now, url: `/api/snapshots/${id}.png` }, { status: 201 });
  }
}
