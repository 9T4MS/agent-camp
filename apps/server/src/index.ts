/**
 * Worker entry: routes /ws/* and /api/* to the single "office" Durable Object, serves
 * /healthz and /install.sh itself, and everything else from static assets (apps/web/dist).
 * Everything except the connector socket goes through the viewer password gate (auth.ts).
 */
import installScript from "../../connector/install.sh";
import { serverVersion } from "./core/app.ts";
import { gate } from "./core/auth.ts";
import type { Env } from "./office.ts";

export { Office } from "./office.ts";

/** Placeholder in install.sh that is replaced with this server's origin. */
const SERVER_PLACEHOLDER = "__AGENT_OFFICE_SERVER__";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/healthz") {
      return Response.json({
        ok: true,
        version: serverVersion(env),
      });
    }

    if (path === "/install.sh") {
      return new Response(installScript.replaceAll(SERVER_PLACEHOLDER, url.origin), {
        headers: {
          "content-type": "text/x-shellscript; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    }

    const blocked = await gate(request, env);
    if (blocked) return blocked;

    if (path.startsWith("/ws/") || path.startsWith("/api/")) {
      const stub = env.OFFICE.get(env.OFFICE.idFromName("office"));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
