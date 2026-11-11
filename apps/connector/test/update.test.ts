import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silent } from "../src/log.ts";
import {
  assetName,
  canSelfUpdate,
  downloadAndSwap,
  type FetchFn,
  isNewer,
  latestReleaseVersion,
  type UpdateDeps,
  Updater,
} from "../src/update.ts";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A fake "binary": a shell script that prints a version. */
const script = (version: string) => `#!/bin/sh\necho ${version}\n`;

function setup(served: Record<string, { status?: number; body?: string }>) {
  dir = mkdtempSync(join(tmpdir(), "ao-upd-"));
  const execPath = join(dir, "agent-office");
  writeFileSync(execPath, script("0.1.10"), { mode: 0o755 });
  const calls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    calls.push(url);
    const r = served[url];
    if (!r) return new Response("not found", { status: 404 });
    return new Response(r.body ?? "", { status: r.status ?? 200 });
  };
  const deps: UpdateDeps = {
    fetch: fetchFn,
    execPath,
    platform: "linux",
    arch: "x64",
    currentVersion: "0.1.10",
    base: "http://dl.test/base/",
    log: silent,
  };
  return { deps, execPath, calls };
}

const URL_LINUX = "http://dl.test/base/agent-office-linux-x64";

describe("version helpers", () => {
  test("assetName / isNewer / canSelfUpdate", () => {
    expect(assetName("darwin", "arm64")).toBe("agent-office-darwin-arm64");
    expect(assetName("darwin", "x64")).toBe("agent-office-darwin-x64");
    expect(assetName("linux", "x64")).toBe("agent-office-linux-x64");
    expect(assetName("win32", "x64")).toBeNull();
    expect(isNewer("0.1.43", "0.1.42")).toBe(true);
    expect(isNewer("v0.1.43", "0.1.42")).toBe(true);
    expect(isNewer("0.1.42", "0.1.42")).toBe(false);
    expect(isNewer("0.1.9", "0.1.42")).toBe(false);
    expect(isNewer("9.9.9", "0.0.0-dev")).toBe(false);
    expect(canSelfUpdate("0.0.0-dev", "/x/agent-office")).toBe(false);
    expect(canSelfUpdate("0.1.1", "/usr/local/bin/bun")).toBe(false);
    expect(canSelfUpdate("0.1.1", "/Users/a/.local/bin/agent-office")).toBe(true);
  });
});

describe("downloadAndSwap", () => {
  test("downloads, sanity-runs (real spawn) and swaps the binary", async () => {
    const { deps, execPath, calls } = setup({ [URL_LINUX]: { body: script("0.1.11") } });
    const r = await downloadAndSwap(deps);
    expect(r).toEqual({ ok: true, version: "0.1.11" });
    expect(calls).toEqual([URL_LINUX]);
    expect(readFileSync(execPath, "utf8")).toBe(script("0.1.11"));
    expect(statSync(execPath).mode & 0o111).toBeTruthy();
    expect(readdirSync(dir)).toEqual(["agent-office"]); // no temp files left
  });

  test("HTTP error leaves the old binary", async () => {
    const { deps, execPath } = setup({});
    const r = await downloadAndSwap(deps);
    expect(r.ok).toBe(false);
    expect(readFileSync(execPath, "utf8")).toBe(script("0.1.10"));
  });

  test("binary that is not newer is rejected", async () => {
    const { deps, execPath } = setup({ [URL_LINUX]: { body: script("0.1.10") } });
    const r = await downloadAndSwap(deps);
    expect(r).toMatchObject({ ok: false });
    expect(readFileSync(execPath, "utf8")).toBe(script("0.1.10"));
    expect(readdirSync(dir)).toEqual(["agent-office"]);
  });

  test("binary that fails to run is rejected", async () => {
    const { deps, execPath } = setup({ [URL_LINUX]: { body: "#!/bin/sh\nexit 3\n" } });
    expect((await downloadAndSwap(deps)).ok).toBe(false);
    const garbage = setup({ [URL_LINUX]: { body: "\u007fELF garbage" } });
    expect((await downloadAndSwap(garbage.deps)).ok).toBe(false);
    expect(readFileSync(execPath, "utf8")).toBe(script("0.1.10"));
  });

  test("injected runVersion is used and bad output rejected", async () => {
    const { deps } = setup({ [URL_LINUX]: { body: "whatever" } });
    const r = await downloadAndSwap({ ...deps, runVersion: async () => "not-a-version" });
    expect(r.ok).toBe(false);
    const ok = await downloadAndSwap({ ...deps, runVersion: async () => "0.2.0\n" });
    expect(ok).toEqual({ ok: true, version: "0.2.0" });
  });
});

describe("Updater", () => {
  test("updates once to a newer version and calls onUpdated", async () => {
    const { deps, calls } = setup({ [URL_LINUX]: { body: script("0.1.12") } });
    const updated: string[] = [];
    const u = new Updater({ ...deps, enabled: true, onUpdated: (v) => updated.push(v) });
    expect(u.isTooOld("0.1.11")).toBe(true);
    expect(u.isTooOld("0.1.10")).toBe(false);
    expect((await u.maybeUpdate("0.1.10", "same")).ok).toBe(false);
    expect(calls).toEqual([]);
    const [a, b] = await Promise.all([u.maybeUpdate("0.1.12", "x"), u.maybeUpdate("0.1.12", "y")]);
    expect(a).toEqual({ ok: true, version: "0.1.12" });
    expect(b).toBe(a);
    expect(calls).toHaveLength(1);
    expect(updated).toEqual(["0.1.12"]);
  });

  test("failed updates are not retried immediately", async () => {
    const { deps, calls } = setup({});
    let now = 1_000_000;
    const u = new Updater({ ...deps, enabled: true, onUpdated: () => {}, now: () => now });
    expect((await u.maybeUpdate("0.1.12", "x")).ok).toBe(false);
    expect((await u.maybeUpdate("0.1.12", "x")).ok).toBe(false);
    expect(calls).toHaveLength(1);
    now += 11 * 60_000;
    await u.maybeUpdate("0.1.12", "x");
    expect(calls).toHaveLength(2);
  });

  test("disabled for dev builds", async () => {
    const { deps, calls } = setup({ [URL_LINUX]: { body: script("0.1.12") } });
    const u = new Updater({ ...deps, currentVersion: "0.0.0-dev", enabled: true });
    expect(u.enabled).toBe(false);
    expect(u.isTooOld("9.0.0")).toBe(false);
    expect((await u.maybeUpdate("0.1.12", "x")).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("latestReleaseVersion", () => {
  test("API tag_name, then redirect fallback", async () => {
    const api: FetchFn = async (url) =>
      url.startsWith("https://api.github.com/repos/o/r/releases/latest")
        ? Response.json({ tag_name: "v0.1.77" })
        : new Response("", { status: 500 });
    expect(await latestReleaseVersion(api, "o/r")).toBe("0.1.77");

    const limited: FetchFn = async (url) =>
      url.startsWith("https://api.github.com")
        ? new Response("rate limited", { status: 403 })
        : new Response(null, {
            status: 302,
            headers: { location: "https://github.com/o/r/releases/tag/v0.1.78" },
          });
    expect(await latestReleaseVersion(limited, "o/r")).toBe("0.1.78");

    const down: FetchFn = async () => {
      throw new Error("offline");
    };
    expect(await latestReleaseVersion(down, "o/r")).toBeNull();
  });
});
