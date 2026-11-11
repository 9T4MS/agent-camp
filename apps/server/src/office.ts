/**
 * The one Durable Object ("office"): WebSocket Hibernation API + SQLite storage around
 * the runtime-agnostic OfficeApp/Hub. Thin adapter, no business logic here.
 */

import { DurableObject } from "cloudflare:workers";
import { CLOSE_BAD_MESSAGE } from "@agent-office/protocol";
import { type AppEnv, OfficeApp } from "./core/app.ts";
import type { Binding } from "./core/hub.ts";
import { SqlStore } from "./core/store.ts";

export type Env = AppEnv & {
  OFFICE: DurableObjectNamespace<Office>;
  ASSETS: Fetcher;
};

type Attachment = { role: "connector" | "viewer"; socketId: string; binding?: Binding };

const CONNECTOR = "connector";
const VIEWER = "viewer";

export class Office extends DurableObject<Env> {
  private app: OfficeApp;
  private alarmAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    const store = new SqlStore((query, ...params) => {
      const bound = params.map((p) => (p instanceof Uint8Array ? p.slice().buffer : p)) as (
        | ArrayBuffer
        | string
        | number
        | null
      )[];
      return sql.exec(query, ...bound).toArray() as Record<string, unknown>[];
    });
    this.app = new OfficeApp(env, store, {
      broadcast: (data) => {
        for (const ws of ctx.getWebSockets(VIEWER)) {
          try {
            ws.send(data);
          } catch {
            // socket already closing
          }
        }
      },
      sendToConnector: (socketId, data) => {
        for (const ws of ctx.getWebSockets(CONNECTOR)) {
          const a = ws.deserializeAttachment() as Attachment | null;
          if (a?.socketId !== socketId) continue;
          try {
            ws.send(data);
            return true;
          } catch {
            return false;
          }
        }
        return false;
      },
      scheduleAlarm: (at) => this.scheduleAlarm(at),
      waitUntil: (p) => ctx.waitUntil(p),
    });
    // free ping/pong that never wakes the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.alarmAt = await ctx.storage.getAlarm();
      const sockets = ctx.getWebSockets(CONNECTOR).map((ws) => {
        const a = ws.deserializeAttachment() as Attachment | null;
        return { socketId: a?.socketId ?? "", binding: a?.binding ?? null };
      });
      this.app.restore(sockets.filter((s) => s.socketId));
    });
  }

  private scheduleAlarm(at: number | null): void {
    if (at === null) return;
    // only move the alarm earlier; a too-early alarm just ticks and re-arms
    if (this.alarmAt !== null && this.alarmAt <= at && this.alarmAt > Date.now() - 5_000) return;
    this.alarmAt = at;
    void this.ctx.storage.setAlarm(at);
  }

  override async alarm(): Promise<void> {
    this.alarmAt = null;
    this.app.alarm();
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role =
      url.pathname === "/ws/connector" ? CONNECTOR : url.pathname === "/ws/viewer" ? VIEWER : null;
    if (role) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, [role]);
      const att: Attachment = { role, socketId: crypto.randomUUID() };
      server.serializeAttachment(att);
      if (role === VIEWER) server.send(this.app.viewerSnapshot());
      return new Response(null, { status: 101, webSocket: client });
    }
    return (await this.app.handleHttp(request)) ?? new Response("not found", { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || att.role !== CONNECTOR) return; // viewers are read-only
    if (typeof message !== "string") {
      ws.close(CLOSE_BAD_MESSAGE, "text frames only");
      return;
    }
    const action = this.app.connectorMessage(att.socketId, message);
    if (action.binding)
      ws.serializeAttachment({ ...att, binding: action.binding } satisfies Attachment);
    if (action.reply) ws.send(JSON.stringify(action.reply));
    if (action.close) ws.close(action.close.code, action.close.reason);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.onGone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.onGone(ws);
  }

  private onGone(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role === CONNECTOR) this.app.connectorClosed(att.socketId);
  }
}
