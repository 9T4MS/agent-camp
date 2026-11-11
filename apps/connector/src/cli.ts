/**
 * `agent-office <command>`: run | configure | gif | status | logs | install-service |
 * uninstall | version | help.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  envelope,
  giphyPageUrl,
  MAX_SELF_DESCRIPTION,
  type MessageData,
  PresenceSnapshot,
  parseGiphyId,
  SHORT_SELF_DESCRIPTION,
} from "@agent-office/protocol";
import {
  CONFIG_KEYS,
  type Config,
  loadConfig,
  lookGeneratorSetting,
  machineName,
  newClientId,
  saveConfig,
  validBirthday,
  validHelpers,
} from "./config.ts";
import { Daemon, type StatusFile } from "./daemon.ts";
import { Detector } from "./detect/index.ts";
import { log } from "./log.ts";
import { bunSpawn, describeGenerators, detectGenerators, LookGenerators } from "./lookgen.ts";
import { Notifier } from "./notify.ts";
import {
  agentDirs,
  configDir,
  configPath,
  LAUNCHD_LABEL,
  logPath,
  plistPath,
  statusPath,
  userHome,
} from "./paths.ts";
import { systemProcesses } from "./proc.ts";
import { canSelfUpdate, DEFAULT_UPDATE_BASE, Updater } from "./update.ts";
import { platformId, VERSION } from "./version.ts";

const BOOL_FLAGS = new Set(["assume-processes", "once", "yes", "help", "y"]);

export type Args = { command: string; flags: Record<string, string | boolean>; rest: string[] };

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOL_FLAGS.has(key) || next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else if (a === "-y" || a === "-h") {
      flags[a === "-y" ? "yes" : "help"] = true;
    } else if (!command) command = a;
    else rest.push(a);
  }
  return { command: command || "help", flags, rest };
}

const flagStr = (f: Args["flags"], k: string): string | undefined =>
  typeof f[k] === "string" ? (f[k] as string) : undefined;

const HELP = `agent-office ${VERSION} — reports your coding-agent sessions to the Agent Office

Usage: agent-office <command> [flags]

Commands:
  run               run the connector in the foreground (launchd runs this)
      --server URL --password PW --name NAME --description TEXT   override config
      --machine-name LABEL  this machine's label on the agent card (default: short hostname)
      --home DIR          scan DIR instead of ~ for .claude/.codex/.pi (also AGENT_OFFICE_HOME)
      --assume-processes  treat every agent as running (tests; also AGENT_OFFICE_ASSUME_PROCESSES=1)
      --once              print one presence.snapshot JSON to stdout and exit
  configure         write ~/.config/agent-office/config.toml
      --server URL --password PW --name NAME
      --description TEXT  how you look, a few words or a detailed paragraph (up to 8000 chars)
      --description-file PATH|-  read the description from a file or stdin (wins over --description)
      --machine-name LABEL  (default: short hostname; "" resets to it)
      --gif GIPHY-LINK|off  GIF over your head (see \`gif\`)
      --share-project-names true|false     --get KEY (print one value)
      --notifications true|false   show waves/messages from the office (default true)
      --look-generator off|auto|claude   opt-in: draw your look with your own Claude Code
                           subscription when the office asks (default off; restart the
                           service after changing)
      --birthday MM-DD     opt-in: the office brings you a cake that day ("" removes it)
      --helpers robots|cats   what your subagents look like in the office (default robots)
      --cowork true|false  opt-in: show Cowork sessions of the Claude desktop app
  gif [GIPHY-LINK|off]
                    show any GIF from giphy.com over your head (paste the page or media
                    link, or the id); "off" removes it; no argument prints the current one.
                    Restarts the background connector so the office updates right away.
  status            connection state and live sessions
  logs              follow the daemon log
  install-service   register the launchd agent (macOS) so it runs at login
  uninstall [--yes] stop the service and remove binary, config and logs
  version           print the version
  help              this text

Long look descriptions are easiest kept in a file:
  agent-office configure --description-file ~/look.md
then restart the service so the office redraws you:
  launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}

Only status metadata is sent: agent kind, hashed session id, project folder name
(disable with share_project_names = false), activity, subagent count, context use %, start time,
the machine label you chose (machine_name), your look description and the Giphy id of your
head GIF (gif).`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.help && args.command === "help") {
    console.log(HELP);
    return 0;
  }
  switch (args.command) {
    case "run":
      return cmdRun(args);
    case "configure":
      return await cmdConfigure(args);
    case "gif":
      return cmdGif(args);
    case "status":
      return cmdStatus();
    case "logs":
      return cmdLogs();
    case "install-service":
      return cmdInstallService(args);
    case "uninstall":
      return cmdUninstall(args);
    case "version":
    case "--version":
      console.log(VERSION);
      return 0;
    case "help":
      console.log(HELP);
      return 0;
    default:
      console.error(`unknown command: ${args.command}\n`);
      console.error(HELP);
      return 2;
  }
}

// ---- run ----------------------------------------------------------------------------------
/**
 * Look description fields for connector.hello: every server accepts the 200-char head
 * (`selfDescription`); newer servers use the full text (`lookDescription`, only when longer).
 */
export function helloDescription(
  description: string | undefined,
): Pick<MessageData<"connector.hello">, "selfDescription" | "lookDescription"> {
  const d = description?.trim();
  if (!d) return {};
  const out: Pick<MessageData<"connector.hello">, "selfDescription" | "lookDescription"> = {
    selfDescription: d.slice(0, SHORT_SELF_DESCRIPTION),
  };
  if (d.length > SHORT_SELF_DESCRIPTION) out.lookDescription = d.slice(0, MAX_SELF_DESCRIPTION);
  return out;
}

async function cmdRun(args: Args): Promise<number> {
  const { flags } = args;
  const env = process.env;
  const { config, existed } = loadConfig(configPath());
  const server = flagStr(flags, "server") ?? config.server;
  const password = flagStr(flags, "password") ?? config.password ?? "";
  const name = (flagStr(flags, "name") ?? config.name ?? "").trim();
  const description = flagStr(flags, "description") ?? config.self_description;
  const machine = machineName({
    machine_name: flagStr(flags, "machine-name") ?? config.machine_name,
  });
  const gifFlag = flagStr(flags, "gif");
  const gif = gifFlag !== undefined ? gifSetting(gifFlag) : config.gif;
  if (gif === null) {
    console.error(`--gif: not a Giphy link or id: ${gifFlag}`);
    return 2;
  }
  const home = flagStr(flags, "home");
  const assumeProcesses =
    flags["assume-processes"] === true || env.AGENT_OFFICE_ASSUME_PROCESSES === "1";
  // keep the client id stable: persist it the first time a configured connector runs
  if (existed && !readFileSync(configPath(), "utf8").includes("client_id")) {
    saveConfig(configPath(), config);
  }
  const clientId = existed ? config.client_id : (env.AGENT_OFFICE_CLIENT_ID ?? newClientId());

  const detector = new Detector({
    dirs: agentDirs(env, home),
    clientId,
    shareProjectNames: config.share_project_names,
    processes: systemProcesses(),
    assumeProcesses,
    cowork: config.cowork,
  });

  if (flags.once) {
    const sessions = await detector.poll();
    const msg = envelope("presence.snapshot", { sessions });
    const r = PresenceSnapshot.safeParse(msg);
    if (!r.success) {
      console.error(`invalid snapshot: ${r.error.message}`);
      return 1;
    }
    console.log(JSON.stringify(r.data, null, 2));
    return 0;
  }

  if (!server || !name) {
    console.error(
      "agent-office is not configured. Run the installer again, or:\n" +
        "  agent-office configure --server https://<office> --password <pw> --name <your name>",
    );
    return 1;
  }

  // Draw the look with Claude Code on this person's own subscription, only if they opted in
  // (look_generator, default off). Test runs on a fixture home (--home / AGENT_OFFICE_HOME)
  // never touch the real CLIs unless asked to.
  const testHome = !!home || !!env.AGENT_OFFICE_HOME;
  const lookSetting =
    lookGeneratorSetting(env.AGENT_OFFICE_LOOK_GENERATOR) ??
    (testHome ? "off" : config.look_generator);
  const lookTools = await detectGenerators(lookSetting, bunSpawn);
  const looks = new LookGenerators({ tools: lookTools, log });
  const looksLabel =
    lookSetting === "off"
      ? "off (opt in: agent-office configure --look-generator auto)"
      : lookTools.size
        ? describeGenerators(lookTools)
        : `none found (look_generator = ${lookSetting})`;

  const hello = (): MessageData<"connector.hello"> => {
    const h: MessageData<"connector.hello"> = {
      name: name.slice(0, 40),
      password,
      clientId,
      connectorVersion: VERSION,
      platform: platformId(),
    };
    Object.assign(h, helloDescription(description));
    if (machine) h.machine = machine;
    // a stored id that no longer parses (hand-edited config) is simply not sent
    if (gif === "") h.gif = "";
    else if (gif) {
      const id = parseGiphyId(gif);
      if (id) h.gif = id;
    }
    if (config.birthday) h.birthday = config.birthday;
    if (looks.available.length) h.lookGenerators = looks.available;
    if (config.helpers === "cats") h.helpers = "cats";
    return h;
  };

  const updater = new Updater({
    enabled: env.AGENT_OFFICE_NO_UPDATE !== "1",
    fetch: (input, init) => fetch(input, init),
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    currentVersion: VERSION,
    base: env.AGENT_OFFICE_UPDATE_BASE || DEFAULT_UPDATE_BASE,
    log,
  });

  const notifier = new Notifier({ enabled: config.notifications, log });
  const daemon = new Daemon({
    server,
    hello,
    detector,
    updater,
    log,
    version: VERSION,
    statusFile: statusPath(),
    onPoked: (p) => void notifier.show(p),
    looks,
    looksLabel,
  });

  log(
    `agent-office ${VERSION} (${platformId()}) starting; server ${daemon.client.url}; ` +
      `self-update ${updater.enabled ? "on" : "off"}; local looks ${looksLabel}` +
      `${assumeProcesses ? "; assuming processes" : ""}`,
  );
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: saying bye`);
    void daemon.stop(true).then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  await daemon.start();
  await new Promise<never>(() => {}); // run until a signal
  return 0;
}

// ---- configure ----------------------------------------------------------------------------
/** `--description-file PATH|-`: the file's (or stdin's) text, or an error message. */
async function readDescriptionFile(path: string): Promise<{ text: string } | { error: string }> {
  try {
    const text = path === "-" ? await Bun.stdin.text() : readFileSync(path, "utf8");
    return { text };
  } catch (e) {
    return { error: `cannot read description file ${path}: ${(e as Error).message}` };
  }
}

async function cmdConfigure(args: Args): Promise<number> {
  const { flags } = args;
  const path = configPath();
  const { config } = loadConfig(path);
  const get = flagStr(flags, "get");
  if (get !== undefined) {
    if (!(CONFIG_KEYS as readonly string[]).includes(get)) {
      console.error(`unknown key: ${get}`);
      return 2;
    }
    const v = config[get as keyof Config];
    if (v !== undefined) console.log(String(v));
    return 0;
  }
  const next: Config = { ...config };
  const set = (
    flag: string,
    key: "server" | "password" | "name" | "self_description" | "machine_name",
  ) => {
    const v = flagStr(flags, flag);
    if (v !== undefined) next[key] = v.trim() === "" && key !== "password" ? undefined : v;
  };
  set("server", "server");
  set("password", "password");
  set("name", "name");
  set("description", "self_description");
  set("machine-name", "machine_name");
  const descFile = flagStr(flags, "description-file");
  if (descFile !== undefined) {
    const r = await readDescriptionFile(descFile);
    if ("error" in r) {
      console.error(r.error);
      return 1;
    }
    const text = r.text.trim();
    next.self_description = text === "" ? undefined : text;
  }
  const share = flags["share-project-names"];
  if (share !== undefined) next.share_project_names = !(share === "false" || share === "0");
  const bday = flagStr(flags, "birthday");
  if (bday !== undefined) {
    if (bday.trim() && !validBirthday(bday)) {
      console.error("birthday must look like MM-DD, e.g. 03-14");
      return 2;
    }
    next.birthday = validBirthday(bday);
  }
  const helpers = flagStr(flags, "helpers");
  if (helpers !== undefined) {
    const skin = helpers.trim() === "" ? "robots" : validHelpers(helpers);
    if (!skin) {
      console.error("helpers must be robots or cats");
      return 2;
    }
    next.helpers = skin;
  }
  const notify = flags.notifications;
  if (notify !== undefined) next.notifications = !(notify === "false" || notify === "0");
  const lookGen = flagStr(flags, "look-generator");
  if (lookGen !== undefined) {
    const v = lookGeneratorSetting(lookGen);
    if (!v) {
      console.error("look-generator must be auto, claude or off");
      return 2;
    }
    next.look_generator = v;
  }
  const cowork = flags.cowork;
  if (cowork !== undefined) next.cowork = !(cowork === "false" || cowork === "0");
  if (next.name && next.name.trim().length > 40) {
    console.error("name must be at most 40 characters");
    return 2;
  }
  if (next.machine_name && next.machine_name.trim().length > 40) {
    console.error("machine name must be at most 40 characters");
    return 2;
  }
  if (next.self_description && next.self_description.length > MAX_SELF_DESCRIPTION) {
    console.error(
      `note: description is ${next.self_description.length} characters; ` +
        `keeping the first ${MAX_SELF_DESCRIPTION}`,
    );
    next.self_description = next.self_description.slice(0, MAX_SELF_DESCRIPTION);
  }
  const gifFlag = flagStr(flags, "gif");
  if (gifFlag !== undefined) {
    const gif = gifSetting(gifFlag);
    if (gif === null) {
      console.error(`not a Giphy link or id: ${gifFlag}`);
      return 2;
    }
    next.gif = gif;
  }
  saveConfig(path, next);
  console.log(
    `saved ${path} (server: ${next.server ?? "-"}, name: ${next.name ?? "-"}, ` +
      `password: ${next.password ? "set" : "not set"})`,
  );
  if (cowork !== undefined && next.cowork) {
    console.log(`Cowork sessions are on. Restart the connector to apply: ${RESTART_HINT}`);
  }
  return 0;
}

const RESTART_HINT = `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`;

// ---- gif ----------------------------------------------------------------------------------
const GIF_OFF = new Set(["off", "none", "no", "clear", "remove", "-"]);

/** Config value for what the user typed: a Giphy id, "" for off, null when unrecognized. */
export function gifSetting(input: string): string | null {
  const v = input.trim();
  if (v === "" || GIF_OFF.has(v.toLowerCase())) return "";
  return parseGiphyId(v);
}

async function cmdGif(args: Args): Promise<number> {
  const path = configPath();
  const { config, existed } = loadConfig(path);
  const input = args.rest.length > 0 ? args.rest.join(" ") : flagStr(args.flags, "gif");
  if (input === undefined) {
    console.log(config.gif ? giphyPageUrl(config.gif) : "no GIF set");
    return 0;
  }
  const gif = gifSetting(input);
  if (gif === null) {
    console.error(
      `not a Giphy link or id: ${input}\n` +
        "Open a GIF on https://giphy.com and copy its link, e.g.\n" +
        "  agent-office gif https://giphy.com/gifs/cat-typing-JIX9t2j0ZTN9S",
    );
    return 2;
  }
  if (!existed) {
    console.error("agent-office is not configured yet. Run the installer first.");
    return 1;
  }
  if ((config.gif ?? "") === gif) {
    // the office only takes a value this connector did not send before (DECISIONS F13)
    console.log(
      `${gif ? `GIF already set to ${giphyPageUrl(gif)}` : "GIF already off"} on this machine.\n` +
        "If someone changed it on the office page since, change it there (click your nameplate)\n" +
        "or pick a different GIF here.",
    );
    return 0;
  }
  saveConfig(path, { ...config, gif });
  console.log(gif ? `GIF set: ${giphyPageUrl(gif)}` : "GIF removed");
  if (await restartService()) console.log("connector restarted; the office updates in a moment");
  else console.log("restart the connector (`agent-office run`) to apply it");
  return 0;
}

/**
 * Restart the launchd agent so a new hello goes out; false when it isn't installed. A custom
 * AGENT_OFFICE_CONFIG_DIR is not the config the service reads, so it is left alone then.
 */
async function restartService(): Promise<boolean> {
  if (process.platform !== "darwin" || process.env.AGENT_OFFICE_CONFIG_DIR) return false;
  if (!existsSync(plistPath())) return false;
  const r = await sh(["launchctl", "kickstart", "-k", `gui/${uid()}/${LAUNCHD_LABEL}`]);
  return r.code === 0;
}

// ---- status -------------------------------------------------------------------------------
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172_800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** Show paths under $HOME as ~/... */
function tilde(p: string): string {
  const home = userHome();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function launchdState(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const p = Bun.spawn(["launchctl", "list"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const line = out.split("\n").find((l) => l.includes(LAUNCHD_LABEL));
    if (!line) return "not loaded (run: agent-office install-service)";
    const [pid, status] = line.trim().split(/\s+/);
    return pid && pid !== "-"
      ? `loaded, running (pid ${pid})`
      : `loaded, not running (last exit ${status})`;
  } catch {
    return "unknown (launchctl failed)";
  }
}

export function formatSessions(sessions: StatusFile["sessions"], now = Date.now()): string[] {
  return sessions.map((s) => {
    const sub = s.subagents ? `${s.subagents} subagent${s.subagents === 1 ? "" : "s"}` : "";
    return `    ${s.agent.padEnd(7)}${(s.project ?? "(hidden)").padEnd(22)}${s.activity.padEnd(10)}${sub.padEnd(14)}started ${ago(now - s.startedAt)}`;
  });
}

async function cmdStatus(): Promise<number> {
  const { config, existed } = loadConfig(configPath());
  const lines: string[] = [`agent-office ${VERSION} (${platformId()})`];
  lines.push(
    existed
      ? `  config    ${tilde(configPath())}  (name: ${config.name ?? "-"}, server: ${config.server ?? "-"})`
      : `  config    missing — run: agent-office configure --server ... --password ... --name ...`,
  );
  let status: StatusFile | null = null;
  try {
    status = JSON.parse(readFileSync(statusPath(), "utf8")) as StatusFile;
  } catch {
    status = null;
  }
  const now = Date.now();
  if (!status) {
    lines.push("  daemon    not running (no status file yet)");
  } else {
    const fresh = now - status.updatedAt < 10_000 && pidAlive(status.pid);
    lines.push(
      fresh
        ? `  daemon    running (pid ${status.pid}, version ${status.version}, updated ${ago(now - status.updatedAt)})`
        : `  daemon    not running (last seen ${ago(now - status.updatedAt)}, version ${status.version})`,
    );
    if (fresh) {
      lines.push(
        status.welcomed
          ? `  server    connected to ${status.server} as ${status.personId ?? status.name}`
          : `  server    not connected to ${status.server}${status.lastError ? ` (${status.lastError})` : ""}`,
      );
      if (status.looks) lines.push(`  looks     ${status.looks}`);
      lines.push(`  sessions  ${status.sessions.length} live`);
      lines.push(...formatSessions(status.sessions, now));
    }
  }
  const ld = await launchdState();
  if (ld) lines.push(`  launchd   ${ld}`);
  lines.push(`  logs      ${tilde(logPath())}`);
  console.log(lines.join("\n"));
  return 0;
}

// ---- logs ---------------------------------------------------------------------------------
async function cmdLogs(): Promise<number> {
  const path = logPath();
  if (!existsSync(path)) {
    console.error(
      `no log file at ${path} yet${process.platform === "darwin" ? "" : " (on Linux, `run` logs to stdout)"}`,
    );
    return 1;
  }
  const p = Bun.spawn(["tail", "-n", "50", "-f", path], { stdout: "inherit", stderr: "inherit" });
  return await p.exited;
}

// ---- launchd ------------------------------------------------------------------------------
const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPlist(bin: string, log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(bin)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { code: await p.exited, out: (out + err).trim() };
  } catch (e) {
    return { code: 127, out: (e as Error).message };
  }
}

const uid = () => process.getuid?.() ?? 501;

async function cmdInstallService(args: Args): Promise<number> {
  if (process.platform !== "darwin") {
    console.log(
      "install-service is macOS-only (launchd). On Linux run `agent-office run` yourself (e.g. a systemd user unit).",
    );
    return 0;
  }
  const bin = flagStr(args.flags, "bin") ?? process.execPath;
  if (!canSelfUpdate("x", bin)) {
    console.error(`refusing to register ${bin}: install the compiled agent-office binary first`);
    return 1;
  }
  const plist = plistPath();
  const logFile = logPath();
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true });
  writeFileSync(plist, launchdPlist(bin, logFile));
  const domain = `gui/${uid()}`;
  await sh(["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]); // ignore "not loaded"
  const r = await sh(["launchctl", "bootstrap", domain, plist]);
  if (r.code !== 0) {
    console.error(`launchctl bootstrap failed (${r.code}): ${r.out}`);
    return 1;
  }
  console.log(`launchd agent ${LAUNCHD_LABEL} registered (runs at login, restarts on exit)`);
  console.log(`  plist ${plist}\n  log   ${logFile}`);
  return 0;
}

async function cmdUninstall(args: Args): Promise<number> {
  const bin = process.execPath;
  const removeBin = canSelfUpdate("x", bin);
  const targets = [
    process.platform === "darwin" ? plistPath() : null,
    removeBin ? bin : null,
    configDir(),
    logPath(),
  ].filter((x): x is string => !!x);
  console.log("This stops the connector and removes:");
  for (const t of targets) console.log(`  ${t}`);
  if (!args.flags.yes) {
    if (!process.stdin.isTTY) {
      console.error("not a terminal; re-run with --yes to confirm");
      return 1;
    }
    const answer = prompt("Continue? [y/N]");
    if (!answer || !/^y(es)?$/i.test(answer.trim())) {
      console.log("aborted");
      return 1;
    }
  }
  if (process.platform === "darwin") {
    await sh(["launchctl", "bootout", `gui/${uid()}/${LAUNCHD_LABEL}`]);
  }
  for (const t of targets) rmSync(t, { recursive: true, force: true });
  console.log("agent-office uninstalled. Bye!");
  return 0;
}
