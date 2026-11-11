/**
 * The office's version: `<major>.<minor>` from the root package.json, then the number of
 * commits on the checked-out branch. The web build and the release workflow both run this on
 * the same commit of main, so the page, the GitHub release and the connectors agree.
 *
 * Prints the version (`bun scripts/version.ts`), or nothing when the history isn't available.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const git = (args: string[], timeout = 10_000) =>
  execFileSync("git", args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "ignore"],
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
    .toString()
    .trim();

export function versionBase(): string {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    version?: string;
  };
  const m = /^(\d+)\.(\d+)/.exec(pkg.version ?? "");
  if (!m) throw new Error(`package.json version "${pkg.version}" is not <major>.<minor>.x`);
  return `${m[1]}.${m[2]}`;
}

/** null when git or the full history is missing: better no version than a wrong one. */
export function releaseVersion(): string | null {
  try {
    const shallow = () => git(["rev-parse", "--is-shallow-repository"]) === "true";
    if (shallow()) {
      // CI checkouts (Cloudflare Workers Builds, actions/checkout) are often shallow
      try {
        git(["fetch", "--unshallow", "--quiet"], 60_000);
      } catch {
        // no remote or offline: checked below
      }
      if (shallow()) return null;
    }
    return `${versionBase()}.${git(["rev-list", "--count", "HEAD"])}`;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const v = releaseVersion();
  if (v) console.log(v);
}
