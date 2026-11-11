/**
 * PRIVACY: run the real pipeline (detectors on fixtures/home -> daemon -> WebSocket) and make
 * sure nothing but status metadata leaves the machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseConnectorMessage } from "@agent-office/protocol";
import { Daemon } from "../src/daemon.ts";
import { Detector } from "../src/detect/index.ts";
import { silent } from "../src/log.ts";
import { agentDirs } from "../src/paths.ts";
import { fakeProcesses } from "../src/proc.ts";
import { type FakeServer, fakeServer, waitFor } from "./fake-server.ts";
import { type FakeHome, makeHome, RAW_IDS, SECRET } from "./helpers.ts";

let h: FakeHome;
let srv: FakeServer;
afterEach(() => {
  srv?.stop();
  h?.cleanup();
});

/** Things that must never appear in anything we send. */
function forbidden(home: string): string[] {
  return [
    SECRET,
    ...RAW_IDS,
    ...RAW_IDS.map((id) => id.split("-")[0]!),
    "/Users/anna",
    "Users-anna",
    "anna",
    home,
    "flaky diff test", // prompt text
    "loadConfig", // tool output
    "cargo test", // tool input
    "toolu_",
  ];
}

function assertClean(texts: string[], home: string) {
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) {
    for (const bad of forbidden(home)) expect(text).not.toContain(bad);
  }
}

describe("privacy", () => {
  test("hello + snapshots over the wire contain only status metadata", async () => {
    h = makeHome();
    srv = fakeServer();
    const detector = new Detector({
      dirs: agentDirs({}, h.home),
      clientId: "c_privacy",
      shareProjectNames: true,
      processes: fakeProcesses([]),
      assumeProcesses: true,
    });
    const d = new Daemon({
      server: srv.url,
      hello: () => ({
        name: "Privacy Tester",
        password: "pw",
        clientId: "c_privacy",
        connectorVersion: "0.1.0",
        platform: "linux-x64",
        selfDescription: "round glasses",
      }),
      detector,
      log: silent,
      version: "0.1.0",
      pollMs: 30,
      debounceMs: 10,
      client: { rand: () => 0 },
    });
    await d.start();
    await waitFor(() => srv.of("presence.snapshot").length >= 1, 3000, "snapshot");
    await d.stop(true);
    await waitFor(() => srv.of("connector.bye").length === 1, 2000, "bye");

    const snap = srv.of("presence.snapshot")[0]!;
    expect((snap.data.sessions as unknown[]).length).toBe(4);
    for (const raw of srv.received) expect(parseConnectorMessage(raw).ok).toBe(true);
    assertClean(srv.received, h.home);
    // the only per-session fields are the allowed ones
    for (const s of snap.data.sessions as Record<string, unknown>[]) {
      expect(Object.keys(s).sort()).toEqual(
        ["activity", "agent", "project", "sessionKey", "startedAt", "subagents"].sort(),
      );
    }
  });

  test("`run --once` output is clean too", async () => {
    h = makeHome();
    const main = join(import.meta.dir, "..", "src", "main.ts");
    const p = Bun.spawn(
      [process.execPath, main, "run", "--once", "--home", h.home, "--assume-processes"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, AGENT_OFFICE_CONFIG_DIR: join(h.home, "cfg") },
      },
    );
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    const msg = parseConnectorMessage(out);
    expect(msg.ok).toBe(true);
    if (msg.ok && msg.msg.type === "presence.snapshot") {
      expect(msg.msg.data.sessions).toHaveLength(4);
    }
    assertClean([out], h.home);
  });
});
