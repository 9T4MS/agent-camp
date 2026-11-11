/**
 * Self-update: download the release binary for this platform, sanity-run it, atomically
 * swap it over our own executable and exit(0) so launchd (KeepAlive) restarts the new one.
 *
 * Triggers: `connector.welcomed` with a newer latestConnectorVersion, a 4002 "too old" close,
 * and a 5-minute poll of the latest GitHub release. Everything is injectable for tests.
 */
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { compareVersions } from "@agent-office/protocol";
import type { Logger } from "./log.ts";
import { DEV_VERSION } from "./version.ts";

export const GITHUB_REPO = "MrGatzi/agent-camp";
export const DEFAULT_UPDATE_BASE = `https://github.com/${GITHUB_REPO}/releases/latest/download`;
export const UPDATE_POLL_MS = 5 * 60_000;
/** Don't retry a failed update to the same version more often than this. */
export const RETRY_FAILED_MS = 10 * 60_000;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type UpdateDeps = {
  fetch: FetchFn;
  /** the running binary to replace */
  execPath: string;
  platform: string;
  arch: string;
  currentVersion: string;
  /** release download base, e.g. https://github.com/<repo>/releases/latest/download */
  base: string;
  log: Logger;
  /** run `<path> version` and return its trimmed stdout (throws on failure) */
  runVersion?: (path: string) => Promise<string>;
};

export type UpdateResult = { ok: true; version: string } | { ok: false; reason: string };

/** Release asset name for a platform/arch, or null if we don't ship one. */
export function assetName(platform: string, arch: string): string | null {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  return os && cpu ? `agent-office-${os}-${cpu}` : null;
}

/** True if `candidate` is strictly newer than `current` (dev builds never update). */
export function isNewer(candidate: string | undefined | null, current: string): boolean {
  if (!candidate || current === DEV_VERSION) return false;
  return compareVersions(candidate, current) > 0;
}

/** Only a compiled, versioned binary may replace itself (never `bun src/main.ts`). */
export function canSelfUpdate(version: string, execPath: string): boolean {
  if (version === DEV_VERSION) return false;
  const name = basename(execPath);
  return !/^(bun|node)(\.exe)?$/.test(name);
}

export async function defaultRunVersion(path: string): Promise<string> {
  const p = Bun.spawn([path, "version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), 15_000);
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  clearTimeout(timer);
  if (code !== 0) throw new Error(`exit code ${code}`);
  return out.trim();
}

/**
 * Download the asset, verify it runs and reports a newer version, then rename it over
 * `execPath`. Never throws; the old binary stays in place on any failure.
 */
export async function downloadAndSwap(deps: UpdateDeps): Promise<UpdateResult> {
  const asset = assetName(deps.platform, deps.arch);
  if (!asset) return { ok: false, reason: `no release asset for ${deps.platform}-${deps.arch}` };
  const url = `${deps.base.replace(/\/+$/, "")}/${asset}`;
  const tmp = join(
    dirname(deps.execPath),
    `.agent-office.update-${process.pid}-${Date.now().toString(36)}`,
  );
  try {
    const res = await deps.fetch(url, { redirect: "follow" });
    if (!res.ok) return { ok: false, reason: `download ${url} failed: HTTP ${res.status}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) return { ok: false, reason: "downloaded file is empty" };
    writeFileSync(tmp, bytes, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    let reported: string;
    try {
      reported = (await (deps.runVersion ?? defaultRunVersion)(tmp)).split(/\s+/)[0] ?? "";
    } catch (e) {
      rmSync(tmp, { force: true });
      return { ok: false, reason: `new binary failed to run: ${(e as Error).message}` };
    }
    if (!/^v?\d+\.\d+\.\d+/.test(reported)) {
      rmSync(tmp, { force: true });
      return { ok: false, reason: `new binary reported a bad version: ${reported.slice(0, 40)}` };
    }
    if (!isNewer(reported, deps.currentVersion)) {
      rmSync(tmp, { force: true });
      return { ok: false, reason: `downloaded ${reported}, not newer than ${deps.currentVersion}` };
    }
    renameSync(tmp, deps.execPath);
    return { ok: true, version: reported };
  } catch (e) {
    rmSync(tmp, { force: true });
    return { ok: false, reason: `update failed: ${(e as Error).message}` };
  }
}

/**
 * Latest release version from GitHub (without the "v"), or null. Tries the REST API first and
 * falls back to the /releases/latest redirect, which is not subject to the 60 req/h API limit.
 */
export async function latestReleaseVersion(
  fetchFn: FetchFn,
  repo: string = GITHUB_REPO,
): Promise<string | null> {
  const clean = (t: unknown) =>
    typeof t === "string" && /^v?\d+\.\d+\.\d+/.test(t) ? t.replace(/^v/, "") : null;
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "agent-office-connector" },
    });
    if (res.ok) {
      const json = (await res.json()) as { tag_name?: unknown };
      const v = clean(json.tag_name);
      if (v) return v;
    }
  } catch {
    // fall through
  }
  try {
    const res = await fetchFn(`https://github.com/${repo}/releases/latest`, {
      redirect: "manual",
      headers: { "user-agent": "agent-office-connector" },
    });
    const loc = res.headers.get("location") ?? "";
    return clean(loc.match(/\/tag\/(v?\d+\.\d+\.\d+[^/?#]*)/)?.[1]);
  } catch {
    return null;
  }
}

/**
 * Coordinates updates: one at a time, no retry storms, exit after a successful swap.
 */
export class Updater {
  private inFlight: Promise<UpdateResult> | null = null;
  private failed = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: UpdateDeps & {
      enabled: boolean;
      /** called after a successful swap; default exits the process with 0 */
      onUpdated?: (version: string) => void;
      now?: () => number;
    },
  ) {}

  get enabled(): boolean {
    return this.deps.enabled && canSelfUpdate(this.deps.currentVersion, this.deps.execPath);
  }

  /** True if the server says we are below its minimum version. */
  isTooOld(minVersion: string | undefined): boolean {
    return (
      !!minVersion &&
      this.deps.currentVersion !== DEV_VERSION &&
      compareVersions(minVersion, this.deps.currentVersion) > 0
    );
  }

  /**
   * Update if `target` (or, when undefined, whatever the download base serves) is newer.
   * Resolves with the result; on success `onUpdated` has been called.
   */
  async maybeUpdate(target: string | undefined, why: string): Promise<UpdateResult> {
    if (!this.enabled) return { ok: false, reason: "self-update disabled for this build" };
    if (target !== undefined && !isNewer(target, this.deps.currentVersion)) {
      return { ok: false, reason: "already up to date" };
    }
    const key = target ?? "latest";
    const now = (this.deps.now ?? Date.now)();
    const failedAt = this.failed.get(key);
    if (failedAt !== undefined && now - failedAt < RETRY_FAILED_MS) {
      return { ok: false, reason: "recently failed; waiting before retrying" };
    }
    if (this.inFlight) return this.inFlight;
    this.deps.log(`update ${this.deps.currentVersion} -> ${target ?? "latest"} (${why})`);
    this.inFlight = downloadAndSwap(this.deps).then((r) => {
      this.inFlight = null;
      if (r.ok) {
        this.deps.log(`updated to ${r.version}; restarting`);
        (this.deps.onUpdated ?? (() => process.exit(0)))(r.version);
      } else {
        this.failed.set(key, now);
        this.deps.log(`update skipped: ${r.reason}`);
      }
      return r;
    });
    return this.inFlight;
  }

  /** Fallback: poll the latest GitHub release every UPDATE_POLL_MS. */
  startPolling(intervalMs: number = UPDATE_POLL_MS): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void latestReleaseVersion(this.deps.fetch).then((v) => {
        if (v && isNewer(v, this.deps.currentVersion)) void this.maybeUpdate(v, "github poll");
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
