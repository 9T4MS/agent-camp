import { afterEach, describe, expect, test } from "bun:test";
import {
  CLOSE_BAD_PASSWORD,
  CLOSE_TOO_OLD,
  envelope,
  parseConnectorMessage,
  type SessionInfo,
} from "@agent-office/protocol";
import { ConnectorClient, connectorUrl } from "../src/client.ts";
import { Daemon, describeChanges } from "../src/daemon.ts";
import { silent } from "../src/log.ts";
import { Updater } from "../src/update.ts";
import { type FakeServer, fakeServer, waitFor } from "./fake-server.ts";

let srv: FakeServer;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  srv?.stop();
});

const hello = () => ({
  name: "Tester",
  password: "pw",
  clientId: "c_test",
  connectorVersion: "0.1.0",
  platform: "linux-x64",
});

const session = (activity: SessionInfo["activity"], subagents = 0): SessionInfo => ({
  sessionKey: "0123456789abcdef",
  agent: "claude",
  project: "demo",
  activity,
  subagents,
  startedAt: 1_700_000_000_000,
});

function daemonWith(
  sessionsRef: { current: SessionInfo[] },
  extra: Partial<ConstructorParameters<typeof Daemon>[0]> = {},
) {
  const d = new Daemon({
    server: srv.url,
    hello,
    detector: { poll: async () => sessionsRef.current },
    log: silent,
    version: "0.1.0",
    pollMs: 30,
    debounceMs: 20,
    heartbeatMs: 60_000,
    client: { rand: () => 0 },
    ...extra,
  });
  cleanups.push(() => d.stop(false));
  return d;
}

describe("connectorUrl", () => {
  test("normalizes", () => {
    expect(connectorUrl("https://office.example.com")).toBe(
      "wss://office.example.com/ws/connector",
    );
    expect(connectorUrl("http://localhost:8787/")).toBe("ws://localhost:8787/ws/connector");
    expect(connectorUrl("office.example.com")).toBe("wss://office.example.com/ws/connector");
    expect(connectorUrl("localhost:8787")).toBe("ws://localhost:8787/ws/connector");
    expect(connectorUrl("ws://x:1/custom")).toBe("ws://x:1/custom");
  });
});

describe("client + daemon against a fake server", () => {
  test("hello, snapshot after welcomed, changes, reconnect, bye", async () => {
    srv = fakeServer();
    const ref = { current: [session("typing")] };
    const d = daemonWith(ref);
    await d.start();

    await waitFor(() => srv.of("presence.snapshot").length >= 1, 3000, "first snapshot");
    const hellos = srv.of("connector.hello");
    expect(hellos).toHaveLength(1);
    expect(hellos[0]!.data).toMatchObject({
      name: "Tester",
      clientId: "c_test",
      connectorVersion: "0.1.0",
      platform: "linux-x64",
    });
    // hello comes first, then the snapshot
    expect(JSON.parse(srv.received[0]!).type).toBe("connector.hello");
    expect(srv.of("presence.snapshot")[0]!.data).toEqual({ sessions: [session("typing")] });
    for (const raw of srv.received) expect(parseConnectorMessage(raw).ok).toBe(true);

    // a change is sent (debounced)
    ref.current = [session("waiting", 2)];
    await waitFor(
      () =>
        srv
          .of("presence.snapshot")
          .some((m) => (m.data.sessions as SessionInfo[])[0]?.activity === "waiting"),
      3000,
      "changed snapshot",
    );
    // unchanged polls don't resend
    const count = srv.of("presence.snapshot").length;
    await Bun.sleep(150);
    expect(srv.of("presence.snapshot").length).toBe(count);

    // server restarts -> client reconnects (backoff with rand=0 is ~500 ms)
    srv.closeAll(1012, "restart");
    await waitFor(() => srv.of("connector.hello").length === 2, 4000, "second hello");
    await waitFor(
      () => srv.of("presence.snapshot").length > count,
      3000,
      "snapshot after reconnect",
    );

    await d.stop(true);
    await waitFor(() => srv.of("connector.bye").length === 1, 2000, "bye");
  });

  test("4001 bad password: no hammering", async () => {
    srv = fakeServer({
      onHello: (ws) => {
        ws.send(JSON.stringify(envelope("connector.rejected", { reason: "bad_password" })));
        ws.close(CLOSE_BAD_PASSWORD, "bad password");
      },
    });
    const states: (string | undefined)[] = [];
    const c = new ConnectorClient({
      server: srv.url,
      hello,
      log: silent,
      rand: () => 0,
      badPasswordDelayMs: 60_000,
      onState: (s) => states.push(s.error),
    });
    cleanups.push(() => c.stop(false));
    c.start();
    await waitFor(() => states.includes("bad_password"), 3000, "rejection");
    await Bun.sleep(1200);
    expect(srv.of("connector.hello")).toHaveLength(1);
  });

  test("4002 too old triggers the updater", async () => {
    srv = fakeServer({
      onHello: (ws) => {
        ws.send(JSON.stringify(envelope("connector.rejected", { reason: "too_old" })));
        ws.close(CLOSE_TOO_OLD, "too old");
      },
    });
    let tooOld = 0;
    const c = new ConnectorClient({
      server: srv.url,
      hello,
      log: silent,
      rand: () => 0,
      onTooOld: () => tooOld++,
    });
    cleanups.push(() => c.stop(false));
    c.start();
    await waitFor(() => tooOld >= 1, 3000, "onTooOld");
  });

  test("below minConnectorVersion: update first, no snapshots", async () => {
    srv = fakeServer({
      welcome: { minConnectorVersion: "0.2.0", latestConnectorVersion: "0.2.1" },
    });
    const fetched: string[] = [];
    const updater = new Updater({
      enabled: true,
      fetch: async (url) => {
        fetched.push(url);
        return new Response("", { status: 404 });
      },
      execPath: "/tmp/does-not-matter/agent-office",
      platform: "linux",
      arch: "x64",
      currentVersion: "0.1.0",
      base: "http://dl.test",
      log: silent,
      onUpdated: () => {},
    });
    const d = daemonWith({ current: [session("typing")] }, { updater });
    await d.start();
    await waitFor(() => fetched.length === 1, 3000, "update download");
    expect(fetched[0]).toBe("http://dl.test/agent-office-linux-x64");
    await Bun.sleep(150);
    expect(srv.of("presence.snapshot")).toHaveLength(0);
  });

  test("invalid outgoing messages are refused", async () => {
    srv = fakeServer();
    const c = new ConnectorClient({ server: srv.url, hello, log: silent });
    cleanups.push(() => c.stop(false));
    c.start();
    await waitFor(() => c.welcomed !== null, 3000, "welcomed");
    const bad = envelope("presence.snapshot", {
      sessions: [{ ...session("typing"), sessionKey: "short" }],
    });
    expect(c.send(bad)).toBe(false);
    expect(c.sendSnapshot([session("reading")])).toBe(true);
    await waitFor(() => srv.of("presence.snapshot").length === 1, 2000, "snapshot");
  });
});

describe("describeChanges", () => {
  test("one line per change", () => {
    const a = session("typing");
    expect(describeChanges([], [a])).toEqual(["session+ claude demo typing"]);
    expect(describeChanges([a], [session("waiting", 1)])).toEqual([
      "claude demo typing -> waiting",
      "claude demo subagents 0 -> 1",
    ]);
    expect(describeChanges([a], [])).toEqual(["session- claude demo"]);
  });
});
