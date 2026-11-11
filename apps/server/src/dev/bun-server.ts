/**
 * Bun dev harness: the same OfficeApp/Hub as the Durable Object, served by Bun.serve with a
 * bun:sqlite store and static files from apps/web/dist. Fast local runs and e2e without
 * wrangler. Not deployed.
 *
 *   bun run apps/server/src/dev/bun-server.ts          # port 8787, DB in apps/server/.dev-office.sqlite
 *   PORT=9000 DB=:memory: bun run apps/server/src/dev/bun-server.ts
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { CLOSE_BAD_MESSAGE } from "@agent-office/protocol";
import type { ServerWebSocket } from "bun";
import { type AppEnv, OfficeApp, serverVersion, viewerAllowed } from "../core/app.ts";
import { SqlStore } from "../core/store.ts";

type WsData = { role: "connector" | "viewer"; socketId: string };

const ROOT = join(import.meta.dir, "..", "..");
const DIST = join(ROOT, "..", "web", "dist");
const INSTALL_SH = join(ROOT, "..", "connector", "install.sh");

function loadDevVars(): Record<string, string> {
  const file = join(ROOT, ".dev.vars");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const env: AppEnv = {
  OFFICE_NAME: "Agent Office",
  OFFICE_TIMEZONE: "Europe/Vienna",
  GENUI_PROVIDER: "off",
  LATEST_CONNECTOR_VERSION: "0.0.0-dev",
  MIN_CONNECTOR_VERSION: "0.0.0",
  DEV_MODE: "1",
  ...loadDevVars(),
  ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >),
};

const db = new Database(process.env.DB ?? join(ROOT, ".dev-office.sqlite"));
const store = new SqlStore(
  (sql, ...params) => db.query(sql).all(...(params as never[])) as Record<string, unknown>[],
);

const viewers = new Set<ServerWebSocket<WsData>>();
let timer: ReturnType<typeof setTimeout> | null = null;

const app = new OfficeApp(env, store, {
  broadcast: (data) => {
    for (const ws of viewers) ws.send(data);
  },
  scheduleAlarm: (at) => {
    if (timer) clearTimeout(timer);
    timer = at === null ? null : setTimeout(() => app.alarm(), Math.max(0, at - Date.now()));
  },
});
app.restore([]);

function serveStatic(pathname: string): Response {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const candidates = [clean, `${clean}.html`, join(clean, "index.html")];
  for (const c of candidates) {
    const file = join(DIST, c);
    if (!file.startsWith(DIST)) break;
    if (existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
  }
  return new Response("not found", { status: 404 });
}

const server = Bun.serve<WsData>({
  port: Number(process.env.PORT ?? 8787),
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/healthz") return Response.json({ ok: true, version: serverVersion(env) });
    if (path === "/install.sh") {
      const text = existsSync(INSTALL_SH)
        ? readFileSync(INSTALL_SH, "utf8")
        : "#!/bin/sh\necho missing\n";
      return new Response(text.replaceAll("__AGENT_OFFICE_SERVER__", url.origin), {
        headers: { "content-type": "text/x-shellscript; charset=utf-8" },
      });
    }
    if (path === "/ws/connector" || path === "/ws/viewer") {
      if (path === "/ws/viewer" && !viewerAllowed(url, env))
        return new Response("viewer key required", { status: 401 });
      const role = path === "/ws/connector" ? "connector" : "viewer";
      if (srv.upgrade(req, { data: { role, socketId: crypto.randomUUID() } })) return undefined;
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const api = await app.handleHttp(req);
    if (api) return api;
    return serveStatic(path === "/" ? "/index.html" : path);
  },
  websocket: {
    open(ws) {
      if (ws.data.role === "viewer") {
        viewers.add(ws);
        ws.send(app.viewerSnapshot());
      }
    },
    message(ws, message) {
      if (message === "ping") return void ws.send("pong");
      if (ws.data.role !== "connector") return;
      if (typeof message !== "string") return void ws.close(CLOSE_BAD_MESSAGE, "text frames only");
      const action = app.connectorMessage(ws.data.socketId, message);
      if (action.reply) ws.send(JSON.stringify(action.reply));
      if (action.close) ws.close(action.close.code, action.close.reason);
    },
    close(ws) {
      if (ws.data.role === "viewer") viewers.delete(ws);
      else app.connectorClosed(ws.data.socketId);
    },
  },
});

console.log(`agent-office dev server (bun) on http://localhost:${server.port}`);
