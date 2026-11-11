/**
 * ~/.config/agent-office/config.toml — a tiny flat TOML subset: `key = "string"` and
 * `key = true|false`, `#` comments. Written by `agent-office configure` (so install.sh never
 * has to quote TOML itself).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { HELPER_SKINS, type HelperSkin } from "@agent-office/protocol";
import { LOOK_GENERATOR_SETTINGS, type LookGeneratorSetting } from "./lookgen.ts";

export type Config = {
  server?: string;
  password?: string;
  name?: string;
  self_description?: string;
  /** label of this machine on the agent card; default: the short hostname */
  machine_name?: string;
  /** Giphy id of the GIF over your head; "" = explicitly none (removes it everywhere) */
  gif?: string;
  share_project_names: boolean;
  /** show pokes from the office as macOS notifications */
  notifications: boolean;
  /** opt-in "MM-DD": the office brings a cake that day */
  birthday?: string;
  /**
   * draw the look with Claude Code on your own subscription: off | auto | claude.
   * Opt-in: missing (or unknown) means off, so an update or reconnect never starts spending it.
   */
  look_generator: LookGeneratorSetting;
  /** what your subagents look like in the office: "robots" (default) or "cats" */
  helpers: HelperSkin;
  /**
   * what the Claude desktop app counts as: "off" (default) or "design" = one Claude Design desk
   * while the app runs (macOS)
   */
  claude_app: ClaudeAppSetting;
  /** opt-in: show Cowork sessions of the Claude desktop app (often not coding work) */
  cowork: boolean;
  client_id: string;
};

export const CONFIG_KEYS = [
  "server",
  "password",
  "name",
  "self_description",
  "machine_name",
  "gif",
  "share_project_names",
  "notifications",
  "birthday",
  "look_generator",
  "helpers",
  "claude_app",
  "cowork",
  "client_id",
] as const;

export type TomlValue = string | boolean | number;

function unescapeToml(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => {
    switch (e[0]) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "u":
      case "U":
        return String.fromCodePoint(Number.parseInt(e.slice(1), 16));
      default:
        return e; // \" \\ and anything else
    }
  });
}

/** Parse flat `key = value` TOML. Unknown syntax lines are ignored. */
export function parseToml(text: string): Record<string, TomlValue> {
  const out: Record<string, TomlValue> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const rest = m[2]!;
    let value: TomlValue | undefined;
    const dq = rest.match(/^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/);
    const sq = rest.match(/^'([^']*)'\s*(#.*)?$/);
    if (dq) value = unescapeToml(dq[1]!);
    else if (sq) value = sq[1]!;
    else {
      const bare = rest.replace(/\s+#.*$/, "").trim();
      if (bare === "true") value = true;
      else if (bare === "false") value = false;
      else if (/^-?\d+(\.\d+)?$/.test(bare)) value = Number(bare);
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Quote a string as a TOML basic string. */
export function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

export function stringifyToml(values: Record<string, TomlValue | undefined>): string {
  const lines = ["# Agent Office connector config (written by `agent-office configure`)"];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    lines.push(`${k} = ${typeof v === "string" ? tomlString(v) : String(v)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Short hostname ("martins-mbp.local" -> "martins-mbp"), at most 40 chars; "" if unknown. */
export function defaultMachineName(host: string = safeHostname()): string {
  return (host.split(".")[0] ?? "").trim().slice(0, 40);
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return "";
  }
}

/** The machine label sent in hello: configured value, else the short hostname. */
export function machineName(config: Pick<Config, "machine_name">, host?: string): string {
  const v = (config.machine_name ?? "").trim().slice(0, 40);
  return v || defaultMachineName(host);
}

/** A valid `look_generator` value, or undefined. */
export function lookGeneratorSetting(v: string | undefined): LookGeneratorSetting | undefined {
  const t = v?.trim().toLowerCase();
  return (LOOK_GENERATOR_SETTINGS as readonly string[]).includes(t ?? "")
    ? (t as LookGeneratorSetting)
    : undefined;
}

/** "MM-DD" or undefined. */
export function validBirthday(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(t) ? t : undefined;
}

/** "robots" | "cats" (trimmed, any case) or undefined for anything else. */
export function validHelpers(v: string | undefined): HelperSkin | undefined {
  const t = v?.trim().toLowerCase();
  return (HELPER_SKINS as readonly string[]).includes(t ?? "") ? (t as HelperSkin) : undefined;
}

export const CLAUDE_APP_SETTINGS = ["off", "design"] as const;
export type ClaudeAppSetting = (typeof CLAUDE_APP_SETTINGS)[number];

/** "off" | "design" (trimmed, any case; "" = off) or undefined for anything else. */
export function claudeAppSetting(v: string | undefined): ClaudeAppSetting | undefined {
  const t = v?.trim().toLowerCase();
  if (t === "") return "off";
  return (CLAUDE_APP_SETTINGS as readonly string[]).includes(t ?? "")
    ? (t as ClaudeAppSetting)
    : undefined;
}

export function newClientId(): string {
  return `c_${randomBytes(9).toString("hex")}`;
}

/** Normalize parsed TOML into a Config (generating a client id if missing). */
export function toConfig(values: Record<string, TomlValue>): Config {
  const s = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : undefined);
  const share = values.share_project_names;
  const notify = values.notifications;
  const cowork = values.cowork;
  const clientId = s("client_id");
  return {
    server: s("server"),
    password: s("password"),
    name: s("name"),
    self_description: s("self_description"),
    machine_name: s("machine_name"),
    gif: s("gif"),
    share_project_names: !(share === false || share === "false"),
    notifications: !(notify === false || notify === "false"),
    birthday: validBirthday(s("birthday")),
    look_generator: lookGeneratorSetting(s("look_generator")) ?? "off",
    helpers: validHelpers(s("helpers")) ?? "robots",
    claude_app: claudeAppSetting(s("claude_app")) ?? "off",
    cowork: cowork === true || cowork === "true",
    client_id: clientId && /^[A-Za-z0-9_-]{1,64}$/.test(clientId) ? clientId : newClientId(),
  };
}

/** Read the config; missing/unreadable file -> defaults. `existed` tells whether it was there. */
export function loadConfig(path: string): { config: Config; existed: boolean } {
  try {
    return { config: toConfig(parseToml(readFileSync(path, "utf8"))), existed: true };
  } catch {
    return { config: toConfig({}), existed: false };
  }
}

/** Write atomically with 0600 permissions (it holds the shared password). */
export function saveConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(
    tmp,
    stringifyToml({
      server: config.server,
      password: config.password,
      name: config.name,
      self_description: config.self_description,
      machine_name: config.machine_name,
      gif: config.gif,
      share_project_names: config.share_project_names,
      notifications: config.notifications,
      birthday: config.birthday,
      look_generator: config.look_generator,
      helpers: config.helpers,
      claude_app: config.claude_app,
      cowork: config.cowork,
      client_id: config.client_id,
    }),
    { mode: 0o600 },
  );
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
