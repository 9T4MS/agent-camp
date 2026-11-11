/** Claude desktop app: Cowork sessions (transcripts). */
import { afterEach, describe, expect, test } from "bun:test";
import { IDLE_AFTER_MS } from "@agent-office/protocol";
import { toolActivity } from "../src/detect/activity.ts";
import { COWORK_LIVE_MS, findCoworkTranscripts, RESCAN_MS } from "../src/detect/cowork.ts";
import { Detector, sessionKeyFor } from "../src/detect/index.ts";
import { agentDirs } from "../src/paths.ts";
import { claudeDesktopInPs, fakeProcesses, isClaudeDesktopArgs, parsePs } from "../src/proc.ts";
import { addCowork, COWORK_ID, type FakeHome, makeHome, P } from "./helpers.ts";

let h: FakeHome;
afterEach(() => h?.cleanup());

const T0 = Date.now();

/** A home with only what the test adds: the stock fixtures are aged out. */
function quietHome(): FakeHome {
  const home = makeHome(T0);
  for (const rel of Object.values(P)) home.age(rel, 24 * 3_600_000, T0);
  return home;
}

function detector(opts: {
  desktop?: boolean;
  now?: () => number;
  share?: boolean;
  cowork?: boolean;
}) {
  return new Detector({
    dirs: agentDirs({}, h.home),
    clientId: "c_test",
    shareProjectNames: opts.share ?? true,
    processes: fakeProcesses([], {}, opts.desktop ?? true),
    now: opts.now ?? (() => T0),
    cowork: opts.cowork ?? true,
  });
}

describe("Claude desktop app process", () => {
  test("the main process counts, its helpers and look-alikes do not", () => {
    expect(isClaudeDesktopArgs("/Applications/Claude.app/Contents/MacOS/Claude")).toBe(true);
    expect(isClaudeDesktopArgs("/Users/a/Applications/Claude.app/Contents/MacOS/Claude --x")).toBe(
      true,
    );
    expect(
      isClaudeDesktopArgs(
        "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer",
      ),
    ).toBe(false);
    expect(isClaudeDesktopArgs("/Users/a/.local/bin/claude --resume")).toBe(false);
    expect(isClaudeDesktopArgs("/Applications/NotClaude.app/Contents/MacOS/Claude")).toBe(false);
  });

  test("found in ps output without becoming an agent process", () => {
    const ps = [
      "  501     1 /Applications/Claude.app/Contents/MacOS/Claude",
      "  502   501 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process",
      "  900   800 /Users/a/.local/bin/claude",
    ].join("\n");
    expect(claudeDesktopInPs(ps)).toBe(true);
    expect(claudeDesktopInPs("  900   800 /Users/a/.local/bin/claude\n")).toBe(false);
    expect(parsePs(ps).map((p) => p.pid)).toEqual([900]);
  });
});

describe("Cowork sessions", () => {
  test("a fresh transcript is a claude session named Cowork while the app runs", async () => {
    h = quietHome();
    addCowork(h, { lastTool: "Read" });
    const sessions = await detector({}).poll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agent: "claude",
      project: "Cowork",
      activity: "reading",
      subagents: 0,
      startedAt: Date.parse("2026-11-10T10:00:00.000Z"),
      context: 0.1,
    });
    expect(sessions[0]!.sessionKey).toBe(sessionKeyFor("c_test", "claude", COWORK_ID));
  });

  test("driving Claude Design shows as typing", async () => {
    expect(toolActivity("ClaudeDesign")).toBe("typing");
    h = quietHome();
    addCowork(h, { lastTool: "ClaudeDesign" });
    expect((await detector({}).poll())[0]).toMatchObject({ activity: "typing" });
  });

  test("Cowork is opt-in: off (the default), a fresh session is not shown", async () => {
    h = quietHome();
    addCowork(h);
    expect(await detector({ cowork: false }).poll()).toEqual([]);
    const d = new Detector({
      dirs: agentDirs({}, h.home),
      clientId: "c_test",
      shareProjectNames: true,
      processes: fakeProcesses([], {}, true),
      now: () => T0,
    });
    expect(await d.poll()).toEqual([]);
  });

  test("the app is not running: no Cowork session, even when fresh", async () => {
    h = quietHome();
    addCowork(h);
    expect(await detector({ desktop: false }).poll()).toEqual([]);
  });

  test("a quiet session keeps its desk (waiting, then idle) until COWORK_LIVE_MS", async () => {
    h = quietHome();
    addCowork(h, { agoMs: 60_000 });
    expect((await detector({}).poll())[0]).toMatchObject({ activity: "waiting" });
    h.cleanup();

    h = quietHome();
    addCowork(h, { agoMs: IDLE_AFTER_MS + 60_000 });
    expect((await detector({}).poll())[0]).toMatchObject({ activity: "idle" });
    h.cleanup();

    h = quietHome();
    addCowork(h, { agoMs: COWORK_LIVE_MS + 1_000 });
    expect(await detector({}).poll()).toEqual([]);
  });

  test("a session that goes quiet while we watch leaves after COWORK_LIVE_MS", async () => {
    h = quietHome();
    addCowork(h);
    let now = T0;
    const d = detector({ now: () => now });
    expect(await d.poll()).toHaveLength(1);
    now = T0 + COWORK_LIVE_MS + 10_000;
    expect(await d.poll()).toEqual([]);
  });

  test("a new session is picked up at the next folder walk", async () => {
    h = quietHome();
    let now = T0;
    const d = detector({ now: () => now });
    expect(await d.poll()).toEqual([]);
    addCowork(h);
    expect(await d.poll()).toEqual([]); // folders were walked a moment ago
    now = T0 + RESCAN_MS;
    h.age(addCowork(h), 1_000, now);
    expect(await d.poll()).toHaveLength(1);
  });

  test("the VM's pid file never ties the session to a process on this machine", async () => {
    h = quietHome();
    addCowork(h); // writes sessions/777.json
    const d = new Detector({
      dirs: agentDirs({}, h.home),
      clientId: "c_test",
      shareProjectNames: true,
      // an unrelated claude process, hosted inside a Pi, happens to have pid 777: a session
      // tied to it by a pid file would be folded into the Pi's desk and hidden
      processes: fakeProcesses(
        [
          { pid: 700, agent: "pi" },
          { pid: 777, agent: "claude", hostPid: 700, backend: true },
        ],
        {},
        true,
      ),
      now: () => T0,
      cowork: true,
    });
    expect(await d.poll()).toMatchObject([{ agent: "claude", project: "Cowork" }]);
  });

  test("sessions under agent/ are found; project names can be hidden", async () => {
    h = quietHome();
    const rel = addCowork(h, { session: "local_ditto_org-1", agent: true });
    expect(rel).toContain("/agent/local_ditto_org-1/");
    expect(findCoworkTranscripts(agentDirs({}, h.home).claudeDesktop, T0)).toHaveLength(1);
    const sessions = await detector({ share: false }).poll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.project).toBeUndefined();
  });

  test("a missing or odd folder is no problem", () => {
    h = quietHome();
    expect(findCoworkTranscripts(agentDirs({}, h.home).claudeDesktop, T0)).toEqual([]);
    expect(findCoworkTranscripts("/nonexistent/claude", T0)).toEqual([]);
  });
});
