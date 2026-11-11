/**
 * Worker entry: routes /ws/* and /api/* to the single "office" Durable Object, serves
 * /healthz and /install.sh itself, and everything else from static assets (apps/web/dist).
 */
import installScript from "../../connector/install.sh";
import { serverVersion, viewerAllowed } from "./core/app.ts";
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

    if (path.startsWith("/ws/") || path.startsWith("/api/")) {
      if (path === "/ws/viewer" && !viewerAllowed(url, env)) {
        return new Response("viewer key required", { status: 401 });
      }
      const stub = env.OFFICE.get(env.OFFICE.idFromName("office"));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
