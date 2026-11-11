#!/usr/bin/env bun
/** `bun run sim -- [flags]` — see `--help`. */
import { HELP, parseArgs } from "./args.ts";
import { generateWeek, postBackfill } from "./backfill.ts";
import { connectorCommand, spawnConnector, startFixtureWriter } from "./fixture-writer.ts";
import { uploadSnapshots } from "./png.ts";
import { runScenario, serverUrls } from "./runner.ts";

async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const log = args.quiet ? () => {} : (l: string) => console.log(l);
  const urls = serverUrls(args.server);

  if (args.backfillWeek || args.snapshots > 0) {
    if (args.backfillWeek) {
      const rows = generateWeek({ seed: args.seed, people: Math.max(args.people, 8) });
      const inserted = await postBackfill(urls.http, args.password, rows);
      const started = rows.filter((r) => r.type === "session.started").length;
      console.log(`backfill  ${inserted} rows (${started} sessions over 7 days) -> ${urls.http}`);
    }
    if (args.snapshots > 0) {
      const ids = await uploadSnapshots(urls.http, args.password, args.snapshots, args.seed, log);
      console.log(`snapshots ${ids.length} frames uploaded -> ${urls.http}/api/snapshots`);
    }
    return 0;
  }

  const stopSignals = (stop: () => Promise<void> | void) => {
    let n = 0;
    const handler = () => {
      if (n++ > 0) process.exit(130);
      console.log("stopping (Ctrl-C again to force)...");
      Promise.resolve(stop()).then(() => process.exit(0));
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  };

  if (args.fixtureWriter) {
    const writer = startFixtureWriter({ seed: args.seed, speed: args.speed, log });
    const cmd = connectorCommand(writer.home, args.server, args.password, args.name);
    console.log(`fixture home: ${writer.home}`);
    const shell = cmd.map((a) => (/[^\w@%+=:,./-]/.test(a) ? `'${a}'` : a)).join(" ");
    console.log(`run the real connector against it:\n  ${shell}`);
    const child = args.spawnConnector
      ? spawnConnector(writer.home, args.server, args.password, args.name, log)
      : null;
    const stop = () => {
      writer.stop();
      child?.kill("SIGTERM");
    };
    stopSignals(stop);
    if (args.durationMs > 0) {
      await new Promise((r) => setTimeout(r, args.durationMs));
      stop();
      return 0;
    }
    await new Promise(() => {});
    return 0;
  }

  const sim = runScenario({
    scenario: args.scenario,
    server: args.server,
    password: args.password,
    people: args.people,
    sessionsPerPerson: args.sessionsPerPerson,
    chaos: args.chaos,
    speed: args.speed,
    seed: args.seed,
    durationMs: args.durationMs,
    log,
  });
  stopSignals(() => sim.stop());
  await sim.done;
  console.log(`done      ${args.scenario}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
