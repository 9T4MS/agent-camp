/** Command-line flags for `bun run sim -- [flags]`. */
import { SCENARIOS, type ScenarioName } from "./scenarios.ts";

export type CliArgs = {
  server: string;
  password: string;
  people: number;
  sessionsPerPerson: [number, number];
  chaos: boolean;
  speed: number;
  durationMs: number;
  seed: number;
  scenario: ScenarioName;
  backfillWeek: boolean;
  snapshots: number;
  fixtureWriter: boolean;
  spawnConnector: boolean;
  name: string;
  quiet: boolean;
  help: boolean;
};

export const HELP = `agent-office simulator

  bun run sim -- [flags]

  --server URL               ws://localhost:8787 (http(s):// also accepted)
  --password PW              devpass
  --scenario NAME            ${SCENARIOS.join(" | ")} (default live)
  --people N                 people for the live scenario (default 6)
  --sessions-per-person A-B  sessions per person (default 1-4)
  --chaos                    random disconnects, reconnects, quits and rapid changes
  --speed X                  time multiplier for the script (default 1)
  --duration D               run time: 60s, 5m, 1h, 500ms; 0 = forever (default)
  --seed N                   PRNG seed (default 42)
  --backfill-week            POST a fake week of history to /api/history/backfill, then exit
  --snapshots N              upload N generated PNG frames to /api/snapshots, then exit
  --fixture-writer           write fake agent transcripts to a temp home for the real connector
  --spawn-connector          with --fixture-writer: also run the real connector against it
  --name NAME                connector name for --spawn-connector (default "Fixture Fred")
  --quiet                    no per-action log lines
`;

/** "60s" | "5m" | "1h" | "500ms" | "90" (seconds) -> ms. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const mult = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(n * mult);
}

/** "1-4" | "3" -> [min, max] */
export function parseRange(s: string): [number, number] {
  const m = /^(\d+)(?:-(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`bad range: ${s}`);
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return [Math.min(a, b), Math.max(a, b)];
}

const BOOL = new Set([
  "chaos",
  "backfill-week",
  "fixture-writer",
  "spawn-connector",
  "quiet",
  "help",
  "h",
]);

export function parseArgs(argv: string[]): CliArgs {
  const raw: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (!a.startsWith("-")) throw new Error(`unexpected argument: ${a}`);
    const body = a.replace(/^-+/, "");
    const eq = body.indexOf("=");
    if (eq >= 0) {
      raw[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (BOOL.has(body)) {
      raw[body] = true;
    } else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${body} needs a value`);
      raw[body] = v;
    }
  }
  const str = (k: string): string | undefined => (typeof raw[k] === "string" ? raw[k] : undefined);
  const num = (k: string, d: number): number => {
    const v = str(k);
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${k} expects a number, got ${v}`);
    return n;
  };
  const scenario = (str("scenario") ?? "live") as ScenarioName;
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario: ${scenario}`);
  const known = new Set([
    ...BOOL,
    "server",
    "password",
    "people",
    "sessions-per-person",
    "speed",
    "duration",
    "seed",
    "scenario",
    "snapshots",
    "name",
  ]);
  for (const k of Object.keys(raw)) if (!known.has(k)) throw new Error(`unknown flag: --${k}`);
  return {
    server: str("server") ?? "ws://localhost:8787",
    password: str("password") ?? "devpass",
    people: Math.max(0, Math.floor(num("people", 6))),
    sessionsPerPerson: parseRange(str("sessions-per-person") ?? "1-4"),
    chaos: raw.chaos === true,
    speed: num("speed", 1),
    durationMs: parseDuration(str("duration") ?? "0"),
    seed: Math.floor(num("seed", 42)),
    scenario,
    backfillWeek: raw["backfill-week"] === true,
    snapshots: Math.max(0, Math.floor(num("snapshots", 0))),
    fixtureWriter: raw["fixture-writer"] === true,
    spawnConnector: raw["spawn-connector"] === true,
    name: str("name") ?? "Fixture Fred",
    quiet: raw.quiet === true,
    help: raw.help === true || raw.h === true,
  };
}
