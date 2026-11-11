import { envelope, type MessageData } from "@agent-office/protocol";
import type { ServerWebSocket } from "bun";

export type FakeServer = {
  url: string;
  received: string[];
  /** parsed messages of a type */
  of(type: string): { type: string; data: Record<string, unknown> }[];
  sockets: Set<ServerWebSocket<unknown>>;
  closeAll(code?: number, reason?: string): void;
  stop(): void;
};

export type FakeServerOptions = {
  /** what to do on hello; default: welcome */
  onHello?: (ws: ServerWebSocket<unknown>) => void;
  welcome?: Partial<MessageData<"connector.welcomed">>;
};

export function fakeServer(opts: FakeServerOptions = {}): FakeServer {
  const received: string[] = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  const welcome = (ws: ServerWebSocket<unknown>) =>
    ws.send(
      JSON.stringify(
        envelope("connector.welcomed", {
          personId: "tester",
          serverVersion: "0.1.99",
          latestConnectorVersion: "0.1.0",
          minConnectorVersion: "0.1.0",
          ...opts.welcome,
        }),
      ),
    );
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws/connector" && srv.upgrade(req)) return undefined;
      return new Response("nope", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      message(ws, m) {
        const text = typeof m === "string" ? m : new TextDecoder().decode(m);
        received.push(text);
        try {
          if (JSON.parse(text).type === "connector.hello") (opts.onHello ?? welcome)(ws);
        } catch {
          // ignore
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    received,
    of: (type) => received.map((r) => JSON.parse(r)).filter((m) => m.type === type),
    sockets,
    closeAll(code = 1011, reason = "restart") {
      for (const ws of sockets) ws.close(code, reason);
    },
    stop: () => server.stop(true),
  };
}

export async function waitFor(pred: () => boolean, timeoutMs = 3000, what = "condition") {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}
