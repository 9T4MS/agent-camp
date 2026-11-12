/** Claude desktop app: Cowork sessions (transcripts) and the declared Claude Design desk. */
import { afterEach, describe, expect, test } from "bun:test";
import { IDLE_AFTER_MS, type SessionInfo } from "@agent-office/protocol";
import {
  CLAUDE_BUNDLE_ID,
  DesignWatcher,
  FRONT_QUERY_MS,
  fakeFrontmost,
  parseBundleId,
  systemFrontmost,
} from "../src/desktop.ts";
import { toolActivity } from "../src/detect/activity.ts";
import { COWORK_LIVE_MS, findCoworkTranscripts, RESCAN_MS } from "../src/detect/cowork.ts";
import { DESIGN_RAW_ID, Detector, sessionKeyFor } from "../src/detect/index.ts";
import { agentDirs } from "../src/paths.ts";
import { claudeDesktopInPs, fakeProcesses, isClaudeDesktopArgs, parsePs } from "../src/proc.ts";
import { addCowork, COWORK_ID, type FakeHome, makeHome, P, psOut } from "./helpers.ts";

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
  design?: DesignWatcher;
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
    ...(opts.design ? { design: opts.design } : {}),
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
    const cli: [number, number, string, string] = [
      900,
      800,
      "/Users/a/.local/bin/claude",
      "2.1.322",
    ];
    const ps = psOut(
      [501, 1, "/Applications/Claude.app/Contents/MacOS/Claude"],
      [
        502,
        501,
        "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process",
        "Claude Helper",
      ],
      cli,
    );
    expect(claudeDesktopInPs(ps)).toBe(true);
    expect(claudeDesktopInPs(psOut(cli))).toBe(false);
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

describe("Claude Design: which app is in front", () => {
  test("the bundle id is read from lsappinfo's answer", () => {
    expect(
      parseBundleId('[ NULL ]  ASN:0x0-0x2a82a8: (in front)\n    bundleID="com.google.Chrome"\n'),
    ).toBe("com.google.Chrome");
    expect(parseBundleId('"CFBundleIdentifier"="com.anthropic.claudefordesktop"\n')).toBe(
      CLAUDE_BUNDLE_ID,
    );
    expect(parseBundleId("")).toBeNull();
    expect(parseBundleId("bundleID=[ NULL ]")).toBeNull();
  });

  test("asks lsappinfo for the front app, then its bundle id; failures give null", async () => {
    const calls: string[][] = [];
    const ok = systemFrontmost(async (cmd) => {
      calls.push(cmd);
      return cmd[1] === "front"
        ? { code: 0, out: "ASN:0x0-0x2d62d6:\n" }
        : { code: 0, out: `bundleID="${CLAUDE_BUNDLE_ID}"\n` };
    });
    expect(await ok.frontmost()).toBe(CLAUDE_BUNDLE_ID);
    expect(calls).toEqual([
      ["lsappinfo", "front"],
      ["lsappinfo", "info", "-only", "bundleid", "ASN:0x0-0x2d62d6:"],
    ]);
    const q = (front: { code: number | null; out: string }) =>
      systemFrontmost(async (cmd) =>
        cmd[1] === "front" ? front : { code: 0, out: "" },
      ).frontmost();
    expect(await q({ code: 1, out: "" })).toBeNull();
    expect(await q({ code: null, out: "" })).toBeNull(); // timed out
    expect(await q({ code: 0, out: "something; rm -rf /" })).toBeNull(); // not an ASN: not passed on
    const broken = systemFrontmost(async () => {
      throw new Error("spawn failed");
    });
    expect(await broken.frontmost()).toBeNull();
  });
});

describe("Claude Design: the desk", () => {
  /** A watcher whose frontmost answer and query count the test controls. */
  function scripted(first: string | null) {
    const s = { front: first, queries: 0 };
    const watcher = new DesignWatcher(
      fakeFrontmost(() => {
        s.queries++;
        return s.front;
      }),
    );
    return { s, watcher };
  }
  const CLAUDE = CLAUDE_BUNDLE_ID;
  const OTHER = "com.google.Chrome";

  test("one desk while the app runs: thinking in front, idle after IDLE_AFTER_MS, gone when it quits", async () => {
    const { s, watcher } = scripted(CLAUDE);
    expect(await watcher.poll(T0, true)).toEqual({ activity: "thinking", startedAt: T0 });
    s.front = OTHER;
    let now = T0 + FRONT_QUERY_MS;
    expect(await watcher.poll(now, true)).toEqual({ activity: "thinking", startedAt: T0 });
    now = T0 + IDLE_AFTER_MS + FRONT_QUERY_MS;
    expect(await watcher.poll(now, true)).toEqual({ activity: "idle", startedAt: T0 });
    s.front = CLAUDE;
    now += FRONT_QUERY_MS;
    expect(await watcher.poll(now, true)).toEqual({ activity: "thinking", startedAt: T0 });
    // the app quits: gone at once; started again: a new session
    expect(await watcher.poll(now + 1_000, false)).toBeNull();
    expect(await watcher.poll(now + 2_000, true)).toEqual({
      activity: "thinking",
      startedAt: now + 2_000,
    });
    expect(watcher.status).toBe("watching");
  });

  test("the app running in the background is an idle desk, never waiting", async () => {
    const { watcher } = scripted(OTHER);
    expect(await watcher.poll(T0, true)).toEqual({ activity: "idle", startedAt: T0 });
  });

  test("macOS is asked at most every FRONT_QUERY_MS, and not at all without the app", async () => {
    const { s, watcher } = scripted(CLAUDE);
    expect(await watcher.poll(T0, false)).toBeNull();
    expect(s.queries).toBe(0);
    await watcher.poll(T0, true);
    await watcher.poll(T0 + 2_000, true);
    await watcher.poll(T0 + 4_000, true);
    expect(s.queries).toBe(1);
    await watcher.poll(T0 + FRONT_QUERY_MS, true);
    expect(s.queries).toBe(2);
  });

  test("a failed query keeps the same session; it only drifts to idle", async () => {
    const { s, watcher } = scripted(CLAUDE);
    await watcher.poll(T0, true);
    s.front = null;
    expect(await watcher.poll(T0 + FRONT_QUERY_MS, true)).toEqual({
      activity: "thinking",
      startedAt: T0,
    });
    expect(watcher.status).toBe("error");
    expect(await watcher.poll(T0 + IDLE_AFTER_MS + 1, true)).toEqual({
      activity: "idle",
      startedAt: T0,
    });
    s.front = CLAUDE;
    expect(await watcher.poll(T0 + IDLE_AFTER_MS + 1 + FRONT_QUERY_MS, true)).toEqual({
      activity: "thinking",
      startedAt: T0,
    });
    expect(watcher.status).toBe("watching");
  });

  test("the detector adds one design session with nothing but presence", async () => {
    h = quietHome();
    const { watcher } = scripted(CLAUDE);
    const d = detector({ design: watcher });
    const sessions: SessionInfo[] = await d.poll();
    expect(sessions).toEqual([
      {
        sessionKey: sessionKeyFor("c_test", "design", DESIGN_RAW_ID),
        agent: "design",
        activity: "thinking",
        subagents: 0,
        startedAt: T0,
      },
    ]);
    expect(d.designStatus).toBe("watching");
    const off = detector({});
    expect(await off.poll()).toEqual([]);
    expect(off.designStatus).toBeUndefined();
  });

  test("no design session while the Claude app is closed", async () => {
    h = quietHome();
    const { s, watcher } = scripted(CLAUDE);
    expect(await detector({ design: watcher, desktop: false }).poll()).toEqual([]);
    expect(s.queries).toBe(0);
  });
});
