/**
 * `bun run dev`: the whole thing with hot reload, one terminal.
 *   server  wrangler dev on :8787 (Worker + Durable Object, password devpass, reloads on save)
 *   web     vite on :5173 (HMR; proxies /ws, /api, /healthz, /install.sh to :8787)
 * Open http://localhost:5173, then fill it: bun run sim -- --scenario busy
 * Ctrl-C stops both.
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const COLORS = { server: "\x1b[33m", web: "\x1b[36m" } as const;
const RESET = "\x1b[0m";

type Name = keyof typeof COLORS;
const procs: Bun.Subprocess[] = [];
let stopping = false;

async function pipe(name: Name, stream: ReadableStream<Uint8Array>) {
  const prefix = `${COLORS[name]}${name.padEnd(6)}|${RESET} `;
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) process.stdout.write(`${prefix}${l}\n`);
  }
  if (buf) process.stdout.write(`${prefix}${buf}\n`);
}

function start(name: Name, cwd: string, cmd: string[]) {
  const p = Bun.spawn(cmd, {
    cwd: join(ROOT, cwd),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  procs.push(p);
  void pipe(name, p.stdout);
  void pipe(name, p.stderr);
  void p.exited.then((code) => {
    if (stopping) return;
    console.log(`${COLORS[name]}${name}${RESET} exited with ${code}; stopping everything`);
    stop(code || 1);
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1500).unref();
  void Promise.all(procs.map((p) => p.exited)).then(() => process.exit(code));
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

// Spawn the tools themselves (not `bun run …`: its live TTY view garbles prefixes and it does
// not forward SIGTERM, which would orphan wrangler/vite on Ctrl-C).
const ensureVars = Bun.spawnSync(["bun", "run", "scripts/ensure-dev-vars.ts"], {
  cwd: join(ROOT, "apps/server"),
  stdout: "inherit",
  stderr: "inherit",
});
if (ensureVars.exitCode !== 0) process.exit(ensureVars.exitCode ?? 1);
start("server", "apps/server", ["node_modules/.bin/wrangler", "dev", "--port", "8787"]);
start("web", "apps/web", ["node_modules/.bin/vite"]);
console.log(
  "\n  Agent Office dev: open http://localhost:5173  (API/WebSocket proxied to wrangler on :8787)\n" +
    "  Fill the office:  bun run sim -- --scenario busy\n",
);
