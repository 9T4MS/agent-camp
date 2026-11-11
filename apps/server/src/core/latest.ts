/**
 * Which connector version the server advertises in `connector.welcomed`.
 *
 * A fixed LATEST_CONNECTOR_VERSION (e.g. stamped by a GitHub Actions deploy) wins. When it is
 * unset, "auto" or "0.0.0-dev", the server asks GitHub for the latest release itself, so a
 * deploy needs no version stamping (and no Cloudflare token in GitHub). Event-driven: a
 * refresh starts only when a connector says hello and the cached value is older than
 * LATEST_TTL_MS. Failures keep the last known value; welcomes never wait for or fail on it.
 */
import type { FetchLike } from "./genui.ts";
import type { Store } from "./store.ts";

export const DEFAULT_GITHUB_REPO = "MrGatzi/agent-camp";
export const LATEST_TTL_MS = 5 * 60_000;
/** What the server advertises before it has ever learned a version ("never update"). */
export const UNKNOWN_VERSION = "0.0.0-dev";
const KV_KEY = "latest.connector";
const USER_AGENT = "agent-office-server";

/** True if LATEST_CONNECTOR_VERSION asks the server to find the version itself. */
export function isAutoVersion(v: string | undefined): boolean {
  const s = v?.trim() ?? "";
  return s === "" || s === "auto" || s === UNKNOWN_VERSION;
}

/** "v0.1.42" -> "0.1.42"; null for anything that isn't a version. */
export function cleanTag(tag: unknown): string | null {
  return typeof tag === "string" && /^v?\d+\.\d+\.\d+/.test(tag) ? tag.replace(/^v/, "") : null;
}

/**
 * Latest release version of `repo` (without "v"), or null. REST API first; if that fails
 * (Workers share egress IPs, so the 60 req/h anonymous limit can bite) the
 * /releases/latest redirect, which is not rate limited the same way.
 */
export async function fetchLatestRelease(f: FetchLike, repo: string): Promise<string | null> {
  try {
    const res = await f(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT },
    });
    if (res.ok) {
      const v = cleanTag(((await res.json()) as { tag_name?: unknown }).tag_name);
      if (v) return v;
    }
  } catch {
    // fall through to the redirect
  }
  try {
    const res = await f(`https://github.com/${repo}/releases/latest`, {
      redirect: "manual",
      headers: { "user-agent": USER_AGENT },
    });
    const loc = res.headers.get("location") ?? "";
    return cleanTag(loc.match(/\/tag\/(v?\d+\.\d+\.\d+[^/?#]*)/)?.[1]);
  } catch {
    return null;
  }
}

type Cached = { v: string; at: number };

export class LatestVersion {
  private value: string;
  /** when `value` was fetched (persisted) */
  private fetchedAt = Number.NEGATIVE_INFINITY;
  /** last attempt, successful or not (memory only; throttles failures too) */
  private triedAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<string> | null = null;
  readonly auto: boolean;

  constructor(
    configured: string | undefined,
    private opts: {
      store: Store;
      repo?: string;
      /** never look anything up (Bun dev harness / e2e: keep "auto" deterministic) */
      offline?: boolean;
      fetch?: FetchLike;
      now?: () => number;
      log?: (line: string) => void;
    },
  ) {
    this.auto = isAutoVersion(configured);
    this.value = this.auto ? UNKNOWN_VERSION : (configured ?? "").trim();
    if (!this.auto) return;
    try {
      const c = JSON.parse(opts.store.kvGet(KV_KEY) ?? "null") as Cached | null;
      if (c && cleanTag(c.v) && typeof c.at === "number") {
        this.value = c.v;
        this.fetchedAt = c.at;
      }
    } catch {
      // corrupt cache: start unknown
    }
  }

  get current(): string {
    return this.value;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * Start a refresh if auto-detecting and the cache is stale; returns the pending promise
   * (resolves with the then-current value, never rejects) or null when nothing was started.
   */
  refreshIfStale(): Promise<string> | null {
    if (!this.auto || this.opts.offline || this.inFlight) return null;
    const now = this.now();
    if (now - Math.max(this.fetchedAt, this.triedAt) < LATEST_TTL_MS) return null;
    this.triedAt = now;
    const f = this.opts.fetch ?? ((i, init) => fetch(i, init));
    const repo = this.opts.repo || DEFAULT_GITHUB_REPO;
    this.inFlight = fetchLatestRelease(f, repo)
      .catch(() => null)
      .then((v) => {
        this.inFlight = null;
        if (!v) {
          this.opts.log?.(`latest connector version: GitHub lookup failed, keeping ${this.value}`);
          return this.value;
        }
        const at = this.now();
        if (v !== this.value) this.opts.log?.(`latest connector version: ${this.value} -> ${v}`);
        this.value = v;
        this.fetchedAt = at;
        try {
          this.opts.store.kvPut(KV_KEY, JSON.stringify({ v, at } satisfies Cached));
        } catch {
          // memory cache still works
        }
        return v;
      });
    return this.inFlight;
  }
}
