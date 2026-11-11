import { cpSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
