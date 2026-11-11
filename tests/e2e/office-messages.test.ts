/** Local adapters + real SQLite + fake connectors: never invoke an OS notifier. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  envelope,
  MessagePage,
  SendMessageResponse,
  type ServerToViewer,
} from "../../packages/protocol/src/index.ts";

const ROOT = join(import.meta.dir, "../..");
const AUTH = { authorization: "Bearer messages-test-pass" };
const wait = async (check: () => boolean) => {
  const end = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > end) throw new Error("message e2e timeout");
    await Bun.sleep(10);
  }
};
async function start(db: string) {
  const proc = Bun.spawn(
    [process.execPath, "run", join(ROOT, "apps/server/src/dev/bun-server.ts")],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: "0",
        DB: db,
        CONNECTOR_PASSWORD: "messages-test-pass",
        VIEWER_KEY: "messages-view",
        GENUI_PROVIDER: "off",
        DEV_MODE: "1",
      },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const reader = proc.stdout.getReader();
  let output = "";
  let base = "";
  while (!base) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`server failed: ${output}`);
    output += new TextDecoder().decode(value);
    const match = /on (http:\/\/localhost:\d+)/.exec(output);
    if (match) base = match[1]!;
  }
  void (async () => {
    while (!(await reader.read()).done) {}
  })().catch(() => {});
  return {
    base,
    stop: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}
async function socket(base: string, path: string, hello?: { name: string; clientId: string }) {
  const messages: ServerToViewer[] = [];
  const raw: string[] = [];
  const ws = new WebSocket(base.replace("http:", "ws:") + path, {
    headers: AUTH,
  } as unknown as string[]);
  ws.onmessage = (event) => {
    raw.push(String(event.data));
    messages.push(JSON.parse(String(event.data)));
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket failed"));
  });
  if (hello) {
    ws.send(
      JSON.stringify(
        envelope("connector.hello", {
          ...hello,
          password: "messages-test-pass",
          connectorVersion: "1.0.0",
        }),
      ),
    );
    await wait(() => raw.some((m) => m.includes("connector.welcomed")));
  }
  return { ws, messages, raw };
}

describe.skipIf(process.env.AGENT_OFFICE_E2E !== "1")("Office Messages (local e2e)", () => {
  test("shared history, intended-machine fanout, safe retries, auth and restart recovery", async () => {
    const temp = mkdtempSync(join(tmpdir(), "ao-messages-"));
    let server = await start(join(temp, "office.sqlite"));
    const sockets: WebSocket[] = [];
    try {
      const a = await socket(server.base, "/ws/connector", { name: "Anna", clientId: "anna-1" });
      const a2 = await socket(server.base, "/ws/connector", { name: "Anna", clientId: "anna-2" });
      const b = await socket(server.base, "/ws/connector", { name: "Ben", clientId: "ben-1" });
      const other = await socket(server.base, "/ws/connector", {
        name: "Other",
        clientId: "other-1",
      });
      const first = await socket(server.base, "/ws/viewer");
      const second = await socket(server.base, "/ws/viewer");
      sockets.push(a.ws, a2.ws, b.ws, other.ws, first.ws, second.ws);
      const body = {
        requestId: crypto.randomUUID(),
        text: "Explicitly authored e2e message",
        audience: { kind: "selected", personIds: ["anna", "ben"] },
        notifyDesktop: true,
      };
      const post = (value: unknown, headers: Record<string, string> = AUTH) =>
        fetch(`${server.base}/api/messages`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(value),
        });
      expect((await fetch(`${server.base}/api/messages`)).status).toBe(401);
      expect((await post(body, {})).status).toBe(401);
      expect((await post(body, { ...AUTH, origin: "https://evil.test" })).status).toBe(403);
      const response = await post(body);
      expect(response.status).toBe(201);
      const senderCookie = response.headers.get("set-cookie")!.split(";")[0]!;
      const saved = SendMessageResponse.parse(await response.json()).message;
      expect(saved.delivery.socketSends).toBe(3);
      await wait(() =>
        [first, second].every((v) => v.messages.some((m) => m.type === "message.sent")),
      );
      await wait(() => [a, a2, b].every((c) => c.raw.some((m) => m.includes("connector.poked"))));
      expect(other.raw.some((m) => m.includes("connector.poked"))).toBe(false);
      expect((await post(body)).status).toBe(200);
      for (const viewer of [first, second])
        expect(viewer.messages.filter((m) => m.type === "message.sent")).toHaveLength(1);
      for (const connector of [a, a2, b])
        expect(connector.raw.filter((m) => m.includes("connector.poked"))).toHaveLength(1);
      const login = await fetch(`${server.base}/api/login`, {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({ password: "messages-test-pass", next: "/" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      for (const [query, headers] of [
        ["", { cookie }],
        ["?key=messages-view", {}],
        ["", AUTH],
      ] as const) {
        const history = await fetch(`${server.base}/api/messages${query}`, { headers });
        expect(history.headers.get("cache-control")).toBe("no-store");
        expect(MessagePage.parse(await history.json()).messages).toEqual([saved]);
      }
      const csv = await (await fetch(`${server.base}/api/history.csv`, { headers: AUTH })).text();
      expect(csv).not.toContain(body.text);
      for (const ws of sockets.splice(0)) ws.close();
      await server.stop();
      server = await start(join(temp, "office.sqlite"));
      const recovered = MessagePage.parse(
        await (await fetch(`${server.base}/api/messages?after=0`, { headers: AUTH })).json(),
      );
      expect(recovered.messages).toEqual([saved]);
      expect((await post(body)).status).toBe(200);
      const late = await socket(server.base, "/ws/viewer");
      sockets.push(late.ws);
      await wait(() => late.messages.some((m) => m.type === "office.snapshot"));
      expect(late.messages.filter((m) => m.type === "message.sent")).toEqual([]); // history, not notification replay
      const owned = MessagePage.parse(
        await (
          await fetch(`${server.base}/api/messages`, { headers: { ...AUTH, cookie: senderCookie } })
        ).json(),
      );
      expect(owned.ownedIds).toEqual([saved.id]); // browser ownership survives server restart
      const another = await socket(server.base, "/ws/viewer");
      sockets.push(another.ws);
      const remove = (cookie = "") =>
        fetch(`${server.base}/api/messages/${saved.id}`, {
          method: "DELETE",
          headers: { ...AUTH, cookie, origin: server.base, "content-type": "application/json" },
        });
      expect((await remove()).status).toBe(403);
      expect((await remove(senderCookie)).status).toBe(200);
      await wait(() =>
        [late, another].every((v) =>
          v.messages.some((m) => m.type === "message.deleted" && m.data.messageId === saved.id),
        ),
      );
      expect(
        MessagePage.parse(
          await (await fetch(`${server.base}/api/messages`, { headers: AUTH })).json(),
        ).messages,
      ).toEqual([]);
      expect((await post(body)).status).toBe(410); // deleted request cannot resurrect the body
      const legacy = await fetch(`${server.base}/api/interact`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json", "cf-connecting-ip": "legacy" },
        body: JSON.stringify({ kind: "message", personId: "anna", text: "Legacy saved" }),
      });
      expect(legacy.status).toBe(200);
      expect(await legacy.json()).toEqual({ ok: true, delivered: 0 });
      expect(
        MessagePage.parse(
          await (await fetch(`${server.base}/api/messages?after=1`, { headers: AUTH })).json(),
        ).messages.map((m) => m.text),
      ).toEqual(["Legacy saved"]);
    } finally {
      for (const ws of sockets) ws.close();
      await server.stop();
      rmSync(temp, { recursive: true, force: true });
    }
  }, 30_000);
});
