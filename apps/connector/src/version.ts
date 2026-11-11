/**
 * Connector version, injected at build time:
 *   bun build --compile --define AGENT_OFFICE_VERSION='"0.1.42"' ...
 * Running from source (or an un-versioned build) reports "0.0.0-dev", which never self-updates.
 */
declare const AGENT_OFFICE_VERSION: string | undefined;

export const DEV_VERSION = "0.0.0-dev";

export const VERSION: string =
  typeof AGENT_OFFICE_VERSION === "string" && AGENT_OFFICE_VERSION.length > 0
    ? AGENT_OFFICE_VERSION
    : DEV_VERSION;

/** "darwin-arm64", "linux-x64", ... (the release asset suffix). */
export function platformId(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}
