/**
 * PRIVACY: run the real pipeline (detectors on fixtures/home -> daemon -> WebSocket) and make
 * sure nothing but status metadata leaves the machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConnectorMessage } from "@agent-office/protocol";
import { helloDescription } from "../src/cli.ts";
import { Daemon } from "../src/daemon.ts";
import { CLAUDE_BUNDLE_ID, DesignWatcher, fakeFrontmost } from "../src/desktop.ts";
import { Detector } from "../src/detect/index.ts";
import { silent } from "../src/log.ts";
import { agentDirs } from "../src/paths.ts";
import { fakeProcesses } from "../src/proc.ts";
import { type FakeServer, fakeServer, waitFor } from "./fake-server.ts";
import { addCowork, COWORK_PRIVATE, type FakeHome, makeHome, RAW_IDS, SECRET } from "./helpers.ts";

/** A detailed (>200 chars) look description, as typed by the user. */
const LOOK =
  "Slim, slicked-back medium brown hair, round tortoiseshell panto glasses with light " +
  "blue-lilac lenses, open charcoal Janker with a forest-green stand-up collar, tan " +
  "lederhosen with green vine embroidery, white sneakers with navy heel tabs.";

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
    ...COWORK_PRIVATE,
    "pricing page", // Cowork prompt text
    "outputs",
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
    addCowork(h, { lastTool: "ClaudeDesign" });
    srv = fakeServer();
    const detector = new Detector({
      dirs: agentDirs({}, h.home),
      clientId: "c_privacy",
      shareProjectNames: true,
      processes: fakeProcesses([]),
      assumeProcesses: true,
      cowork: true,
      design: new DesignWatcher(fakeFrontmost(CLAUDE_BUNDLE_ID)),
    });
    const d = new Daemon({
      server: srv.url,
      hello: () => ({
        name: "Privacy Tester",
        password: "pw",
        clientId: "c_privacy",
        connectorVersion: "0.1.0",
        platform: "linux-x64",
        ...helloDescription(LOOK),
        machine: "devbox",
      }),
      detector,
      log: silent,
      version: "0.1.0",
      statusFile: join(h.home, "cfg", "status.json"),
      pollMs: 30,
      debounceMs: 10,
      client: { rand: () => 0 },
    });
    await d.start();
    await waitFor(() => srv.of("presence.snapshot").length >= 1, 3000, "snapshot");
    await d.stop(true);
    await waitFor(() => srv.of("connector.bye").length === 1, 2000, "bye");
    // `agent-office status` reads the Claude Design watch state from the status file
    const status = JSON.parse(readFileSync(join(h.home, "cfg", "status.json"), "utf8"));
    expect(status.designWindow).toBe("watching");

    // hello carries only what the user typed in (name, description, machine label) + versions
    const helloMsg = srv.of("connector.hello")[0]!;
    expect(Object.keys(helloMsg.data).sort()).toEqual(
      [
        "clientId",
        "connectorVersion",
        "machine",
        "name",
        "password",
        "platform",
        "selfDescription",
        "lookDescription",
      ].sort(),
    );
    expect(helloMsg.data.lookDescription).toBe(LOOK);
    expect((helloMsg.data.selfDescription as string).length).toBe(200);
    expect(helloMsg.data.machine).toBe("devbox");
    const snap = srv.of("presence.snapshot")[0]!;
    // 4 from fixtures/home + the Cowork session + the Claude Design desk
    const sent = snap.data.sessions as Record<string, unknown>[];
    expect(sent.length).toBe(6);
    expect(sent.find((s) => s.project === "Cowork")).toMatchObject({ agent: "claude" });
    const design = sent.find((s) => s.agent === "design")!;
    expect(Object.keys(design).sort()).toEqual(
      ["activity", "agent", "sessionKey", "startedAt", "subagents"].sort(),
    );
    for (const raw of srv.received) expect(parseConnectorMessage(raw).ok).toBe(true);
    assertClean(srv.received, h.home);
    // the only per-session fields are the allowed ones (context: a 0..1 number, when known)
    const allowed = ["activity", "agent", "project", "sessionKey", "startedAt", "subagents"];
    for (const s of sent) {
      if (s.agent === "design") continue; // checked above: it has no project
      const keys = Object.keys(s).filter((k) => k !== "context");
      expect(keys.sort()).toEqual(allowed.sort());
      if ("context" in s) expect(typeof s.context).toBe("number");
    }
  });

  test("`run --once` output is clean too", async () => {
    h = makeHome();
    addCowork(h);
    // Cowork is opt-in: turn it on so its session is part of the privacy check
    mkdirSync(join(h.home, "cfg"), { recursive: true });
    writeFileSync(join(h.home, "cfg", "config.toml"), "cowork = true\n");
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
      expect(msg.msg.data.sessions).toHaveLength(5);
    }
    assertClean([out], h.home);
  });
});
