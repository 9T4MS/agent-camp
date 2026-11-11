/**
 * ~/.config/agent-office/config.toml — a tiny flat TOML subset: `key = "string"` and
 * `key = true|false`, `#` comments. Written by `agent-office configure` (so install.sh never
 * has to quote TOML itself).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Config = {
  server?: string;
  password?: string;
  name?: string;
  self_description?: string;
  share_project_names: boolean;
  client_id: string;
};

export const CONFIG_KEYS = [
  "server",
  "password",
  "name",
  "self_description",
  "share_project_names",
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

export function newClientId(): string {
  return `c_${randomBytes(9).toString("hex")}`;
}

/** Normalize parsed TOML into a Config (generating a client id if missing). */
export function toConfig(values: Record<string, TomlValue>): Config {
  const s = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : undefined);
  const share = values.share_project_names;
  const clientId = s("client_id");
  return {
    server: s("server"),
    password: s("password"),
    name: s("name"),
    self_description: s("self_description"),
    share_project_names: !(share === false || share === "false"),
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
      share_project_names: config.share_project_names,
      client_id: config.client_id,
    }),
    { mode: 0o600 },
  );
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
