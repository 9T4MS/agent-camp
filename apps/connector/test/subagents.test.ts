/**
 * Claude subagent lifecycle: a helper counts while it runs (meta.json `finished`, the parent's
 * tool_result, its own pending tool call), not just while its file was written in the last 60 s.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBAGENT_LIVE_MS } from "@agent-office/protocol";
import {
  countSubagents,
  newSubagentCache,
  parseSubagentMeta,
  SUBAGENT_SILENT_MAX_MS,
  toolCalls,
} from "../src/detect/claude.ts";
import { Detector, IDLE_SUBAGENT_RESCAN_MS } from "../src/detect/index.ts";
import { agentDirs } from "../src/paths.ts";
import { fakeProcesses } from "../src/proc.ts";
import { addCowork, type FakeHome, makeHome, P } from "./helpers.ts";

const NOW = Date.now();
const MIN = 60_000;
const line = (o: object) => `${JSON.stringify(o)}\n`;

const toolUse = (id: string, name = "Bash") => ({
  type: "assistant",
  isSidechain: true,
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
});
const toolResult = (id: string) => ({
  type: "user",
  isSidechain: true,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});
const finalText = {
  type: "assistant",
  isSidechain: true,
  message: {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stop_reason: "end_turn",
  },
};

let root: string;
let home: FakeHome | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  home?.cleanup();
  home = undefined;
});

function subDir(): string {
  root = mkdtempSync(join(tmpdir(), "ao-sub-"));
  const dir = join(root, "subagents");
  mkdirSync(join(dir, "workflows", "wf1"), { recursive: true });
  return dir;
}

function setAge(path: string, agoMs: number) {
  const t = (NOW - agoMs) / 1000;
  utimesSync(path, t, t);
}

/** Write agent-<id>.jsonl (+ meta.json unless `meta` is null), aged `agoMs`. */
function agent(
  dir: string,
  id: string,
  agoMs: number,
  meta: Record<string, unknown> | null,
  lines: object[] = [toolUse(`toolu_own_${id}`)],
) {
  const jsonl = join(dir, `agent-${id}.jsonl`);
  writeFileSync(jsonl, lines.map(line).join(""));
  setAge(jsonl, agoMs);
  if (meta) {
    const metaPath = join(dir, `agent-${id}.meta.json`);
    writeFileSync(metaPath, JSON.stringify(meta));
    setAge(metaPath, agoMs);
  }
  return jsonl;
}

const bg = (extra: Record<string, unknown> = {}) => ({
  agentType: "general-purpose",
  description: "SECRET_TASK_DESCRIPTION",
  toolUseId: "toolu_bg",
  spawnDepth: 1,
  requestShape: "background",
  ...extra,
});
const fg = (toolUseId: string | undefined, extra: Record<string, unknown> = {}) => ({
  agentType: "general-purpose",
  description: "SECRET_TASK_DESCRIPTION",
  ...(toolUseId ? { toolUseId } : {}),
  spawnDepth: 1,
  requestShape: "foreground",
  ...extra,
});

describe("subagent meta", () => {
  test("only lifecycle fields are kept", () => {
    const m = parseSubagentMeta(bg({ finished: true }));
    expect(m).toEqual({ shape: "background", done: true, toolUseId: "toolu_bg" });
    expect(JSON.stringify(m)).not.toContain("SECRET");
    expect(parseSubagentMeta(bg({ stoppedByUser: true }))?.done).toBe(true);
    expect(parseSubagentMeta({ requestShape: "weird" })).toEqual({
      shape: undefined,
      done: false,
      toolUseId: undefined,
    });
    expect(parseSubagentMeta([1])).toBeNull();
    expect(parseSubagentMeta(null)).toBeNull();
  });

  test("tool calls from raw entries", () => {
    const calls = toolCalls([toolUse("a"), toolUse("b"), toolResult("a"), { type: "x" }]);
    expect([...calls.started]).toEqual(["a", "b"]);
    expect([...calls.returned]).toEqual(["a"]);
  });

  test("tool calls ignore api-request-blob copies of old requests", () => {
    const blob = { type: "api-request-blob", message: toolUse("old").message };
    const calls = toolCalls([blob, toolUse("b")]);
    expect([...calls.started]).toEqual(["b"]);
  });
});

describe("countSubagents lifecycle", () => {
  test("no meta.json: the old 60 s recency rule", () => {
    const dir = subDir();
    agent(dir, "fresh", 5_000, null);
    agent(dir, "stale", SUBAGENT_LIVE_MS + 1_000, null);
    expect(countSubagents(dir, NOW)).toBe(1);
  });

  test("background: live until finished, even when quiet for minutes", () => {
    const dir = subDir();
    agent(dir, "running", 5 * MIN, bg());
    agent(dir, "finished", 5 * MIN, bg({ finished: true }));
    agent(dir, "finishedFresh", 1_000, bg({ finished: true }));
    agent(dir, "stopped", 2 * MIN, bg({ stoppedByUser: true }));
    // the parent's immediate "launched" tool_result does not end a background agent
    const parent = [toolUse("toolu_bg"), toolResult("toolu_bg")];
    expect(countSubagents(dir, NOW, parent)).toBe(1);
  });

  test("silent past the cap never counts, whatever the meta says", () => {
    const dir = subDir();
    agent(dir, "bgOld", SUBAGENT_SILENT_MAX_MS + 1_000, bg());
    agent(dir, "fgOld", SUBAGENT_SILENT_MAX_MS + 1_000, fg("toolu_fg"));
    expect(countSubagents(dir, NOW, [toolUse("toolu_fg")])).toBe(0);
    agent(dir, "bgOk", SUBAGENT_SILENT_MAX_MS - 10_000, bg());
    expect(countSubagents(dir, NOW, [toolUse("toolu_fg")])).toBe(1);
  });

  test("foreground: live while the parent waits on its tool_use, done at its tool_result", () => {
    const dir = subDir();
    // quiet subagent whose own transcript does not show a pending call: the parent decides
    agent(dir, "fg", 5 * MIN, fg("toolu_fg"), [toolUse("toolu_x"), toolResult("toolu_x")]);
    expect(countSubagents(dir, NOW, [toolUse("toolu_fg")])).toBe(1);
    expect(countSubagents(dir, NOW, [toolUse("toolu_fg"), toolResult("toolu_fg")])).toBe(0);
    // a returned call ends it even when the file was written a moment ago
    agent(dir, "fg", 1_000, fg("toolu_fg"), [finalText]);
    expect(countSubagents(dir, NOW, [toolUse("toolu_fg"), toolResult("toolu_fg")])).toBe(0);
    expect(countSubagents(dir, NOW, [])).toBe(1); // fresh, parent unknown
  });

  test("foreground without a parent signal: its own tool call in flight keeps it live", () => {
    const dir = subDir();
    const wf = join(dir, "workflows", "wf1");
    // workflow agents have no toolUseId; this one waits on a long Bash run
    agent(wf, "busy", 4 * MIN, fg(undefined), [
      toolUse("toolu_a"),
      toolResult("toolu_a"),
      toolUse("toolu_b"),
    ]);
    // finished ones end with a tool_result (StructuredOutput) or final text
    agent(wf, "doneA", 2 * MIN, fg(undefined), [toolUse("toolu_c"), toolResult("toolu_c")]);
    agent(wf, "doneB", 2 * MIN, fg(undefined), [finalText]);
    // parent tool_use out of the tail: same fallback
    agent(dir, "lost", 3 * MIN, fg("toolu_gone"), [toolUse("toolu_d")]);
    expect(countSubagents(dir, NOW, [])).toBe(2);
    agent(wf, "fgFinished", 3 * MIN, fg(undefined, { finished: true }), [toolUse("toolu_e")]);
    expect(countSubagents(dir, NOW, [])).toBe(2);
  });

  test("older metas without requestShape: finished is honoured, otherwise recency", () => {
    const dir = subDir();
    agent(dir, "a", 5_000, { agentType: "x", description: "d", toolUseId: "toolu_1" });
    agent(dir, "b", 3 * MIN, { agentType: "x", description: "d", toolUseId: "toolu_2" });
    agent(dir, "c", 5_000, { toolUseId: "toolu_3", finished: true });
    expect(countSubagents(dir, NOW, [toolUse("toolu_2")])).toBe(1);
  });

  test("meta.json is cached by mtime", () => {
    const dir = subDir();
    agent(dir, "x", 5 * MIN, bg());
    const cache = newSubagentCache();
    expect(countSubagents(dir, NOW, [], cache)).toBe(1);
    // rewritten with the same mtime: the cached parse is reused (not re-read)
    const metaPath = join(dir, "agent-x.meta.json");
    writeFileSync(metaPath, JSON.stringify(bg({ finished: true })));
    setAge(metaPath, 5 * MIN);
    expect(countSubagents(dir, NOW, [], cache)).toBe(1);
    expect(cache.meta.size).toBe(1);
    // a new mtime (Claude Code writing `finished`) is picked up
    setAge(metaPath, 1_000);
    expect(countSubagents(dir, NOW, [], cache)).toBe(0);
    // garbage and missing metas never throw
    writeFileSync(metaPath, "{half");
    setAge(metaPath, 500);
    expect(countSubagents(dir, NOW, [], cache)).toBe(0);
    rmSync(metaPath);
    expect(countSubagents(dir, NOW, [], cache)).toBe(0); // 5 min old, no meta: stale
    expect(cache.meta.size).toBe(0);
  });
});

describe("detector", () => {
  const sub = (name: string) =>
    `.claude/projects/-Users-anna-code-agent-office/3f6c2a1e-8b7d-4c59-9e21-5a0d4b7c8e91/subagents/${name}`;

  function detector(h: FakeHome) {
    return new Detector({
      dirs: agentDirs({}, h.home),
      clientId: "c_test",
      shareProjectNames: true,
      processes: fakeProcesses([{ pid: 12345, agent: "claude" }]),
      now: () => NOW,
    });
  }

  test("a quiet session with a running background subagent is not idle", async () => {
    home = makeHome(NOW);
    const h = home;
    // finish the fixture's pending Edit: only the subagent may keep the session off idle
    appendFileSync(
      h.path(P.claudeActive),
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
      }),
    );
    h.age(P.claudeActive, 3 * MIN);
    h.age(P.claudeWaiting, 3 * MIN);
    h.age(P.sub1, 3 * MIN);
    h.age(P.sub2, 3 * MIN);
    writeFileSync(h.path(sub("agent-abc.meta.json")), JSON.stringify(bg()));
    h.age(sub("agent-abc.meta.json"), 3 * MIN);
    const sessions = await detector(h).poll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      project: "agent-office",
      activity: "thinking",
      subagents: 1,
    });
    const json = JSON.stringify(sessions);
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("general-purpose");
    expect(json).not.toContain("toolu_");

    // once Claude Code marks it finished, the session goes idle with no helpers
    writeFileSync(h.path(sub("agent-abc.meta.json")), JSON.stringify(bg({ finished: true })));
    const after = await detector(h).poll();
    expect(after[0]).toMatchObject({ activity: "idle", subagents: 0 });
  });

  test("an idle session without subagents is walked again only after IDLE_SUBAGENT_RESCAN_MS", async () => {
    home = makeHome(NOW);
    const h = home;
    appendFileSync(
      h.path(P.claudeActive),
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
      }),
    );
    for (const p of [P.claudeActive, P.claudeWaiting, P.sub1, P.sub2]) h.age(p, 3 * MIN);
    let now = NOW;
    const d = new Detector({
      dirs: agentDirs({}, h.home),
      clientId: "c_test",
      shareProjectNames: true,
      processes: fakeProcesses([{ pid: 12345, agent: "claude" }]),
      now: () => now,
    });
    const office = async () => (await d.poll()).find((s) => s.project === "agent-office");
    expect(await office()).toMatchObject({ activity: "idle", subagents: 0 });
    // a background subagent appears with no parent write: not seen until the rescan is due
    writeFileSync(h.path(sub("agent-abc.meta.json")), JSON.stringify(bg()));
    h.age(P.sub1, 1_000, NOW);
    now = NOW + 2_000;
    expect(await office()).toMatchObject({ activity: "idle", subagents: 0 });
    now = NOW + IDLE_SUBAGENT_RESCAN_MS;
    expect(await office()).toMatchObject({ activity: "thinking", subagents: 1 });
    // with live subagents it is walked every poll: their end shows at once
    writeFileSync(h.path(sub("agent-abc.meta.json")), JSON.stringify(bg({ finished: true })));
    now += 2_000;
    expect(await office()).toMatchObject({ activity: "idle", subagents: 0 });
  });

  test("a non-idle activity is kept as is when subagents run", async () => {
    home = makeHome(NOW);
    const h = home;
    writeFileSync(h.path(sub("agent-abc.meta.json")), JSON.stringify(bg()));
    const sessions = await detector(h).poll();
    const s = sessions.find((x) => x.project === "agent-office");
    expect(s).toMatchObject({ activity: "typing", subagents: 2 });
  });
  /** The parent's Agent call that spawned a foreground subagent, and its answer. */
  const parentCall = (id: string) => ({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Agent", input: {} }],
      stop_reason: "tool_use",
    },
  });
  const parentResult = (id: string) => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  });

  test("foreground: the detector passes the parent's tail, so its tool_use/tool_result decide", async () => {
    home = makeHome(NOW);
    const h = home;
    appendFileSync(h.path(P.claudeActive), line(parentCall("toolu_fg")));
    h.age(P.claudeActive, 3 * MIN);
    h.age(P.sub2, 3 * MIN); // no meta: stale after 60 s
    // a quiet subagent whose own tail shows no call in flight: only the parent keeps it live
    writeFileSync(h.path(P.sub1), [toolUse("toolu_x"), toolResult("toolu_x")].map(line).join(""));
    h.age(P.sub1, 5 * MIN);
    writeFileSync(h.path(sub("agent-abc.meta.json")), JSON.stringify(fg("toolu_fg")));
    h.age(sub("agent-abc.meta.json"), 5 * MIN);
    const office = async () => (await detector(h).poll()).find((s) => s.project === "agent-office");
    expect(await office()).toMatchObject({ activity: "thinking", subagents: 1 });

    // the parent got the agent's answer: done, even though its file was written just now
    appendFileSync(h.path(P.claudeActive), line(parentResult("toolu_fg")));
    h.age(P.claudeActive, 2_000);
    h.age(P.sub1, 1_000);
    expect(await office()).toMatchObject({ subagents: 0 });
  });

  test("foreground in a Cowork session: the parent's tail decides there too", async () => {
    home = makeHome(NOW);
    const h = home;
    const rel = addCowork(h, { lastTool: "Agent", agoMs: 3 * MIN }); // tool_use toolu_cw1
    const dir = h.path(join(rel.slice(0, -".jsonl".length), "subagents"));
    mkdirSync(dir, { recursive: true });
    agent(dir, "cw", 5 * MIN, fg("toolu_cw1"), [toolUse("toolu_y"), toolResult("toolu_y")]);
    const cowork = async () => {
      const d = new Detector({
        dirs: agentDirs({}, h.home),
        clientId: "c_test",
        shareProjectNames: true,
        processes: fakeProcesses([]),
        assumeProcesses: true,
        cowork: true,
        now: () => NOW,
      });
      return (await d.poll()).find((s) => s.project === "Cowork");
    };
    expect(await cowork()).toMatchObject({ subagents: 1 });
    appendFileSync(h.path(rel), line(parentResult("toolu_cw1")));
    h.age(rel, 2_000, NOW);
    setAge(join(dir, "agent-cw.jsonl"), 1_000);
    expect(await cowork()).toMatchObject({ subagents: 0 });
  });
});
