import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PS_COLUMNS, UCOMM_WIDTH } from "../src/proc.ts";

export const FIXTURE_HOME = join(import.meta.dir, "..", "..", "..", "fixtures", "home");

export const SECRET = "SECRET_DO_NOT_LEAK_8f3a";
export const RAW_IDS = [
  "3f6c2a1e-8b7d-4c59-9e21-5a0d4b7c8e91",
  "b81e4d07-2c3a-4f6e-a5d9-0e7f1c2b3a46",
  "019a6f2e-7c41-7d20-b3e5-4f8a9c0d1e2b",
  "6d1f3b2a-9e8c-4a7b-8d6e-1f2a3b4c5d6e",
];

export const P = {
  claudeActive:
    ".claude/projects/-Users-anna-code-agent-office/3f6c2a1e-8b7d-4c59-9e21-5a0d4b7c8e91.jsonl",
  claudeWaiting:
    ".claude/projects/-Users-anna-code-website/b81e4d07-2c3a-4f6e-a5d9-0e7f1c2b3a46.jsonl",
  sub1: ".claude/projects/-Users-anna-code-agent-office/3f6c2a1e-8b7d-4c59-9e21-5a0d4b7c8e91/subagents/agent-abc.jsonl",
  sub2: ".claude/projects/-Users-anna-code-agent-office/3f6c2a1e-8b7d-4c59-9e21-5a0d4b7c8e91/subagents/workflows/wf1/agent-def.jsonl",
  codex:
    ".codex/sessions/2026/11/10/rollout-2026-11-10T09-00-00-019a6f2e-7c41-7d20-b3e5-4f8a9c0d1e2b.jsonl",
  pi: ".pi/agent/sessions/--Users-anna-code-pi-proj--/2026-11-10T09-00-00-000Z_6d1f3b2a-9e8c-4a7b-8d6e-1f2a3b4c5d6e.jsonl",
} as const;

export type FakeHome = {
  home: string;
  path(rel: string): string;
  /** set a file's mtime to `agoMs` before `now` */
  age(rel: string, agoMs: number, now?: number): void;
  cleanup(): void;
};

/** Copy fixtures/home to a temp dir; every transcript starts "fresh" (5 s old). */
export function makeHome(now = Date.now()): FakeHome {
  const home = mkdtempSync(join(tmpdir(), "ao-home-"));
  cpSync(FIXTURE_HOME, home, { recursive: true });
  const h: FakeHome = {
    home,
    path: (rel) => join(home, rel),
    age(rel, agoMs, at = now) {
      const t = (at - agoMs) / 1000;
      utimesSync(join(home, rel), t, t);
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
  for (const rel of Object.values(P)) h.age(rel, 5_000);
  return h;
}

/** One `ps -axo` column per field, in the order the connector asks for them (PS_COLUMNS). */
const PS_FIELDS: Record<
  string,
  (row: { pid: number; ppid: number; exe: string; args: string }) => string
> = {
  pid: (r) => String(r.pid).padStart(5),
  ppid: (r) => String(r.ppid).padStart(5),
  ucomm: (r) => r.exe.slice(0, UCOMM_WIDTH).padEnd(UCOMM_WIDTH),
  args: (r) => r.args,
};

/**
 * `ps -axo <PS_COLUMNS>` output as macOS prints it: right-aligned pids, then `ucomm` (the
 * executable's file name) cut and padded to exactly 16 chars, then args. Rows are
 * `[pid, ppid, args, ucomm?]`; ucomm defaults to the file name of the first word of args. Built
 * from PS_COLUMNS itself, so changing the columns the connector asks `ps` for without teaching
 * `psLines` the new layout fails the tests (an unknown column throws here).
 */
export function psOut(...rows: [number, number, string, string?][]): string {
  const columns = PS_COLUMNS.split(",").map((c) => {
    const field = PS_FIELDS[c.replace(/=$/, "")];
    if (!field) throw new Error(`psOut: no fake for ps column ${c}`);
    return field;
  });
  return rows
    .map(([pid, ppid, args, exe = basename(args.split(" ")[0]!)]) =>
      columns.map((col) => col({ pid, ppid, exe, args })).join(" "),
    )
    .join("\n")
    .concat("\n");
}

// ---- Cowork (Claude desktop app) ---------------------------------------------------------------
export const COWORK_ID = "c0c0a5e5-1111-4222-8333-444455556666";
/** names that only exist in Cowork paths; none of them may ever be sent */
export const COWORK_PRIVATE = [COWORK_ID, "local_7d689e67", "dreamy-zealous-wozniak", "acct-1"];

const coworkDir = (session = "local_7d689e67", agent = false) =>
  join(
    "Library/Application Support/Claude/local-agent-mode-sessions/acct-1/org-1",
    ...(agent ? ["agent"] : []),
    session,
    ".claude",
  );

/**
 * Write a Cowork transcript into a fake home (the Claude desktop app keeps them under
 * ~/Library/Application Support/Claude). `lastTool`: the tool the last assistant turn calls;
 * omitted = the turn ended. Returns the transcript path relative to the home.
 */
export function addCowork(
  h: FakeHome,
  opts: { id?: string; session?: string; agent?: boolean; lastTool?: string; agoMs?: number } = {},
): string {
  const id = opts.id ?? COWORK_ID;
  const cwd = "/sessions/dreamy-zealous-wozniak";
  const dir = coworkDir(opts.session, opts.agent);
  const rel = join(dir, "projects", "-sessions-dreamy-zealous-wozniak", `${id}.jsonl`);
  const base = { isSidechain: false, cwd, sessionId: id, entrypoint: "local-agent" };
  const lines: unknown[] = [
    { type: "queue-operation", operation: "enqueue", timestamp: "2026-11-10T10:00:00.000Z" },
    {
      ...base,
      type: "user",
      timestamp: "2026-11-10T10:00:01.000Z",
      message: { role: "user", content: `Design a pricing page. ${SECRET}` },
    },
    {
      ...base,
      type: "assistant",
      timestamp: "2026-11-10T10:00:05.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-5",
        content: opts.lastTool
          ? [{ type: "tool_use", id: "toolu_cw1", name: opts.lastTool, input: { note: SECRET } }]
          : [{ type: "text", text: `Done. ${SECRET}` }],
        stop_reason: opts.lastTool ? "tool_use" : "end_turn",
        usage: { input_tokens: 20_000, cache_read_input_tokens: 0 },
      },
    },
  ];
  mkdirSync(join(h.home, dir, "projects", "-sessions-dreamy-zealous-wozniak"), {
    recursive: true,
  });
  writeFileSync(h.path(rel), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  // a pid file written inside the app's VM: its pid means nothing on this machine
  mkdirSync(join(h.home, dir, "sessions"), { recursive: true });
  writeFileSync(
    join(h.home, dir, "sessions", "777.json"),
    JSON.stringify({ pid: 777, sessionId: id, cwd, startedAt: 1 }),
  );
  h.age(rel, opts.agoMs ?? 5_000);
  return rel;
}
