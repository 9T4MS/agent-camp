/**
 * Draw the person's look on this Mac with a local AI tool, on the person's own subscription:
 * Claude Code (`claude -p` with a JSON schema). The office server sends the prompt and the
 * schema (`connector.lookRequested`); only the description goes to the person's own AI and
 * only the finished look goes back to the server.
 *
 * It runs headless with no tools at all (the description is text a teammate can set), no MCP
 * servers, no hooks, without saving a session (so the detector never sees a phantom session)
 * and in an empty scratch directory (no project files, no CLAUDE.md). Codex is not offered:
 * `codex exec` keeps a shell / apply_patch / MCP tools even with a read-only sandbox.
 */
import { accessSync, constants, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LOOK_GENERATORS, type LookGenerator, type MessageData } from "@agent-office/protocol";
import type { Logger } from "./log.ts";

export type LookRequest = MessageData<"connector.lookRequested">;
export type LookAnswer = MessageData<"connector.lookGenerated">;

/** `look_generator` in config.toml: auto / claude = Claude Code when installed, off = none. */
export const LOOK_GENERATOR_SETTINGS = ["auto", "claude", "off"] as const;
export type LookGeneratorSetting = (typeof LOOK_GENERATOR_SETTINGS)[number];

/** A local AI that is slower than this is stopped (the server then tries its own provider). */
export const LOOK_TIMEOUT_MS = 4 * 60_000;

export type SpawnResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean };
export type LookSpawn = (
  cmd: string[],
  opts: { cwd: string; stdin: string; env: Record<string, string>; timeoutMs: number },
) => Promise<SpawnResult>;

/** Where installers put the CLIs; launchd gives the connector a bare PATH, so look here first. */
export function candidatePaths(tool: LookGenerator, home = homedir()): string[] {
  const dirs = [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".asdf", "shims"),
  ];
  return dirs.map((d) => join(d, tool));
}

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Ask the person's interactive login shell (their PATH lives in .zshrc), with a timeout. */
async function fromLoginShell(tool: LookGenerator, spawn: LookSpawn): Promise<string | null> {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const r = await spawn([shell, "-ilc", `printf '@@%s@@' "$(command -v ${tool})"`], {
      cwd: homedir(),
      stdin: "",
      env: { HOME: homedir(), TERM: "dumb" },
      timeoutMs: 8_000,
    });
    const m = /@@(\/[^@\n]+)@@/.exec(r.stdout);
    return m?.[1] && isExecutable(m[1]) ? m[1] : null;
  } catch {
    return null;
  }
}

export async function findTool(
  tool: LookGenerator,
  spawn: LookSpawn,
  home = homedir(),
): Promise<string | null> {
  for (const p of candidatePaths(tool, home)) if (isExecutable(p)) return p;
  return fromLoginShell(tool, spawn);
}

/** The local AI tools to offer, preferred first, per the `look_generator` setting. */
export async function detectGenerators(
  setting: LookGeneratorSetting,
  spawn: LookSpawn,
  home = homedir(),
): Promise<Map<LookGenerator, string>> {
  const out = new Map<LookGenerator, string>();
  if (setting === "off") return out;
  const tools = setting === "auto" ? LOOK_GENERATORS : [setting];
  for (const tool of tools) {
    const path = await findTool(tool, spawn, home);
    if (path) out.set(tool, path);
  }
  return out;
}

export const bunSpawn: LookSpawn = async (cmd, opts) => {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill();
  }, opts.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
};

/** Env for the child: the connector's own plus the tool's folder and the usual bin dirs. */
function childEnv(toolPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const extra = [dirname(toolPath), "/opt/homebrew/bin", "/usr/local/bin"];
  env.PATH = [...extra, env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"].join(":");
  return env;
}

/** A CLI's error in one line: claude -p puts it in its JSON `result`, others on stderr. */
function errorLine(r: SpawnResult): string {
  try {
    const j = JSON.parse(r.stdout) as { result?: unknown };
    if (typeof j.result === "string" && j.result.trim()) return firstLine(j.result);
  } catch {
    // not JSON
  }
  return firstLine(r.stderr) || firstLine(r.stdout) || "no output";
}

const firstLine = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 200) ?? "";

export class LookGenerators {
  private busy = false;

  constructor(
    private readonly opts: {
      tools: Map<LookGenerator, string>;
      log: Logger;
      spawn?: LookSpawn;
      /** scratch folder (default: a fresh one under the system temp dir per request) */
      scratch?: string;
      timeoutMs?: number;
    },
  ) {}

  /** Offered in connector.hello, preferred first. */
  get available(): LookGenerator[] {
    return [...this.opts.tools.keys()];
  }

  /** Draw a look for a server request; never throws. */
  async generate(req: LookRequest): Promise<LookAnswer> {
    const [generator, path] = [...this.opts.tools.entries()][0] ?? [];
    if (!generator || !path)
      return { requestId: req.requestId, generator: "claude", error: "no local AI tool" };
    if (this.busy)
      return { requestId: req.requestId, generator, error: "busy drawing another look" };
    this.busy = true;
    const scratch =
      this.opts.scratch ?? join(tmpdir(), `agent-office-look-${process.pid}-${Date.now()}`);
    const started = Date.now();
    this.opts.log(`look: drawing you with ${generator} (requested from the office)`);
    try {
      mkdirSync(scratch, { recursive: true });
      const avatar = await this.runClaude(path, req, scratch);
      this.opts.log(`look: ${generator} done in ${Math.round((Date.now() - started) / 1000)} s`);
      return { requestId: req.requestId, generator, avatar };
    } catch (e) {
      const error = (e as Error).message.slice(0, 300);
      this.opts.log(`look: ${generator} failed: ${error}`);
      return { requestId: req.requestId, generator, error };
    } finally {
      this.busy = false;
      if (!this.opts.scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }

  private async run(path: string, args: string[], stdin: string, cwd: string) {
    const r = await (this.opts.spawn ?? bunSpawn)([path, ...args], {
      cwd,
      stdin,
      env: childEnv(path),
      timeoutMs: this.opts.timeoutMs ?? LOOK_TIMEOUT_MS,
    });
    if (r.timedOut)
      throw new Error(
        `timed out after ${Math.round((this.opts.timeoutMs ?? LOOK_TIMEOUT_MS) / 1000)} s`,
      );
    if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${errorLine(r)}`);
    return r;
  }

  /** `claude -p`: JSON result with `structured_output` (the schema-checked answer). */
  private async runClaude(path: string, req: LookRequest, cwd: string): Promise<unknown> {
    const r = await this.run(
      path,
      [
        "-p",
        "--no-session-persistence",
        "--tools",
        "",
        "--strict-mcp-config",
        // the person's hooks and plugins are for their coding sessions, not for this
        "--settings",
        JSON.stringify({ disableAllHooks: true }),
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(req.schema),
        "--system-prompt",
        req.system,
      ],
      req.prompt,
      cwd,
    );
    let out: { is_error?: boolean; result?: unknown; structured_output?: unknown };
    try {
      out = JSON.parse(r.stdout);
    } catch {
      throw new Error("claude did not answer with JSON");
    }
    if (out.is_error) throw new Error(`claude: ${String(out.result ?? "error").slice(0, 200)}`);
    if (out.structured_output !== undefined) return out.structured_output;
    if (typeof out.result === "string") return JSON.parse(out.result);
    throw new Error("claude gave no look");
  }
}

/** For logs and status output. */
export function describeGenerators(tools: Map<LookGenerator, string>): string {
  return tools.size === 0 ? "off" : [...tools.entries()].map(([t, p]) => `${t} (${p})`).join(", ");
}
