/**
 * Where things live. Two separate notions of "home":
 *  - the *user* home (config, status, logs, launchd plist) = $HOME
 *  - the *agent* home the detectors scan = AGENT_OFFICE_HOME / --home, else $HOME
 */
import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

export function userHome(env: Env = process.env): string {
  return env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
}

/** ~/.config/agent-office (override with AGENT_OFFICE_CONFIG_DIR, e.g. in tests). */
export function configDir(env: Env = process.env): string {
  return env.AGENT_OFFICE_CONFIG_DIR || join(userHome(env), ".config", "agent-office");
}

export const configPath = (env: Env = process.env) => join(configDir(env), "config.toml");
export const statusPath = (env: Env = process.env) => join(configDir(env), "status.json");

export const LAUNCHD_LABEL = "dev.agentoffice.connector";

export function plistPath(env: Env = process.env): string {
  return join(userHome(env), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** Daemon log: ~/Library/Logs/agent-office.log on macOS, the config dir elsewhere. */
export function logPath(env: Env = process.env, platform: string = process.platform): string {
  return platform === "darwin"
    ? join(userHome(env), "Library", "Logs", "agent-office.log")
    : join(configDir(env), "agent-office.log");
}

/**
 * Directories the detectors scan. `claudeDesktop` is the Claude desktop app's data folder
 * (macOS: ~/Library/Application Support/Claude), where Cowork sessions keep their transcripts.
 */
export type AgentDirs = { claude: string; codex: string; pi: string; claudeDesktop: string };

const desktopDir = (home: string) => join(home, "Library", "Application Support", "Claude");

/**
 * Resolve agent data directories. If an agent home override is given (AGENT_OFFICE_HOME or
 * --home) it replaces ~ and the per-agent env vars are ignored, so a fixture run can never
 * pick up the real ~/.claude via a stray CLAUDE_CONFIG_DIR. Otherwise CLAUDE_CONFIG_DIR,
 * CODEX_HOME and PI_CODING_AGENT_DIR are respected.
 */
export function agentDirs(env: Env = process.env, homeOverride?: string): AgentDirs {
  const override = homeOverride || env.AGENT_OFFICE_HOME;
  if (override) {
    return {
      claude: join(override, ".claude"),
      codex: join(override, ".codex"),
      pi: join(override, ".pi", "agent"),
      claudeDesktop: desktopDir(override),
    };
  }
  const home = userHome(env);
  return {
    claude: env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    codex: env.CODEX_HOME || join(home, ".codex"),
    pi: env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"),
    claudeDesktop: desktopDir(home),
  };
}
