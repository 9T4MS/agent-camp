/**
 * Build single-file connector binaries into apps/connector/dist/.
 *   bun scripts/build.ts all | local | darwin-arm64 | darwin-x64 | linux-x64 ...
 * Version comes from $AGENT_OFFICE_VERSION (default "0.0.0-dev", which never self-updates).
 * install.sh is copied next to the binaries so dist/ can be served as a release base.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const TARGETS = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
} as const;
type Name = keyof typeof TARGETS;

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const version = process.env.AGENT_OFFICE_VERSION || "0.0.0-dev";
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`bad AGENT_OFFICE_VERSION: ${version}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const want = args.length === 0 ? ["all"] : args;
const names = new Set<Name>();
for (const a of want) {
  if (a === "all") for (const n of Object.keys(TARGETS) as Name[]) names.add(n);
  else if (a === "local") {
    const n = `${process.platform}-${process.arch}`;
    if (!(n in TARGETS)) {
      console.error(`no target for this machine (${n})`);
      process.exit(2);
    }
    names.add(n as Name);
  } else if (a in TARGETS) names.add(a as Name);
  else {
    console.error(`unknown target ${a}; use all | local | ${Object.keys(TARGETS).join(" | ")}`);
    process.exit(2);
  }
}

mkdirSync(dist, { recursive: true });
let failed = 0;
for (const name of names) {
  const out = join(dist, `agent-office-${name}`);
  const cmd = [
    process.execPath,
    "build",
    "--compile",
    "--minify",
    `--target=${TARGETS[name]}`,
    "--define",
    `AGENT_OFFICE_VERSION=${JSON.stringify(version)}`,
    join(root, "src", "main.ts"),
    "--outfile",
    out,
  ];
  const t0 = Date.now();
  const p = Bun.spawn(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code === 0) {
    console.log(`built ${out} (${version}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    failed++;
    console.error(`FAILED ${name} (exit ${code})\n${o}${e}`);
  }
}
copyFileSync(join(root, "install.sh"), join(dist, "install.sh"));
process.exit(failed ? 1 : 0);
