/**
 * Claude Design presence, declared by the person: with `claude_app = "design"` their Claude
 * desktop app counts as Claude Design. While the app runs they have exactly one `design` desk:
 * `thinking` while the app is the frontmost app, `idle` after IDLE_AFTER_MS in the
 * background, gone when the app quits.
 *
 * Why declared instead of detected: Claude Design runs on Anthropic's servers, inside the
 * Claude app's main window. The only local signals (the app's accessibility tree with its
 * claude.ai page addresses, or its web storage) need the app switched into full accessibility
 * mode or depend on its internals (rejected in review of #32). This module changes nothing
 * in the Claude app and needs no permission:
 *  - "the app runs" comes from the `ps` output the connector already reads (proc.ts);
 *  - "the app is in front" comes from `lsappinfo`, which ships with macOS: the frontmost
 *    app's bundle id, nothing about its windows or content.
 * Only `thinking`/`idle` and a start time leave the machine.
 */
import { type Activity, IDLE_AFTER_MS } from "@agent-office/protocol";

export const CLAUDE_BUNDLE_ID = "com.anthropic.claudefordesktop";

/** Ask macOS for the frontmost app this often while the Claude app runs. */
export const FRONT_QUERY_MS = 5_000;
/** Give up on one `lsappinfo` run after this long. */
export const FRONT_TIMEOUT_MS = 2_000;

/** Bundle id of the frontmost app, or null when unknown (lsappinfo failed or said nothing). */
export interface FrontmostSource {
  frontmost(): Promise<string | null>;
}

/** What `agent-office status` shows. */
export type DesignWatchStatus = "watching" | "error";

/** The bundle id in `lsappinfo info -only bundleid <ASN>` output (two spellings seen). */
export function parseBundleId(out: string): string | null {
  const m = out.match(/(?:bundleID|"CFBundleIdentifier")\s*=\s*"([^"]+)"/);
  return m ? m[1]! : null;
}

export type Run = (
  cmd: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; out: string }>;

const runCmd: Run = async (cmd, timeoutMs) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill();
  }, timeoutMs);
  try {
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    return { code: timedOut ? null : code, out };
  } finally {
    clearTimeout(timer);
  }
};

/** The real thing (macOS): `lsappinfo front`, then that app's bundle id. */
export function systemFrontmost(run: Run = runCmd): FrontmostSource {
  return {
    async frontmost() {
      try {
        const front = await run(["lsappinfo", "front"], FRONT_TIMEOUT_MS);
        const asn = front.code === 0 ? front.out.trim() : "";
        if (!/^ASN:[0-9a-fx-]+:?$/i.test(asn)) return null;
        const info = await run(["lsappinfo", "info", "-only", "bundleid", asn], FRONT_TIMEOUT_MS);
        return info.code === 0 ? parseBundleId(info.out) : null;
      } catch {
        return null;
      }
    },
  };
}

/** A fixed or scripted answer, for tests. */
export function fakeFrontmost(answer: string | null | (() => string | null)): FrontmostSource {
  return { frontmost: async () => (typeof answer === "function" ? answer() : answer) };
}

export type DesignPresence = { activity: Activity; startedAt: number };

/** Turns "the Claude app runs" and "it is in front" into a desk. Never `waiting`. */
export class DesignWatcher {
  private since: number | null = null;
  private lastFront = Number.NEGATIVE_INFINITY;
  private nextAt = Number.NEGATIVE_INFINITY;
  private state: DesignWatchStatus = "watching";

  constructor(private readonly source: FrontmostSource) {}

  get status(): DesignWatchStatus {
    return this.state;
  }

  /**
   * `desktopRunning`: the Claude app runs (no query otherwise). Never throws. A failed query
   * changes nothing: the desk stays and only drifts to idle, so a hiccup never starts a new
   * session.
   */
  async poll(now: number, desktopRunning: boolean): Promise<DesignPresence | null> {
    if (!desktopRunning) {
      this.since = null;
      this.lastFront = Number.NEGATIVE_INFINITY;
      this.nextAt = Number.NEGATIVE_INFINITY;
      return null;
    }
    this.since ??= now;
    if (now >= this.nextAt) {
      this.nextAt = now + FRONT_QUERY_MS;
      let front: string | null = null;
      try {
        front = await this.source.frontmost();
      } catch {
        front = null;
      }
      this.state = front === null ? "error" : "watching";
      if (front === CLAUDE_BUNDLE_ID) this.lastFront = now;
    }
    return {
      activity: now - this.lastFront < IDLE_AFTER_MS ? "thinking" : "idle",
      startedAt: this.since,
    };
  }
}
