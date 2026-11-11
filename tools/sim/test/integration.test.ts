/** Starts the Bun server harness on a random port and runs scenario `one` against it. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { OfficeSnapshot } from "@agent-office/protocol";
import type { Subprocess } from "bun";
import { runScenario } from "../src/runner.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PORT = 20_000 + Math.floor(Math.random() * 20_000);
const HTTP = `http://localhost:${PORT}`;
const AUTH = { headers: { authorization: "Bearer devpass" } };
let server: Subprocess;

beforeAll(async () => {
  server = Bun.spawn([process.execPath, "run", "apps/server/src/dev/bun-server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB: ":memory:", CONNECTOR_PASSWORD: "devpass" },
    stdout: "ignore",
    stderr: "inherit",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${HTTP}/healthz`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
});

afterAll(() => {
  server?.kill();
});

test("scenario one shows 1 person with 1 claude session in /api/state", async () => {
  const sim = runScenario({ scenario: "one", server: `ws://localhost:${PORT}`, log: false });
  try {
    await sim.settled;
    const state = OfficeSnapshot.parse(await (await fetch(`${HTTP}/api/state`, AUTH)).json());
    expect(state.data.people).toHaveLength(1);
    const [anna] = state.data.people;
    expect(anna?.name).toBe("Anna");
    expect(anna?.sessions).toHaveLength(1);
    expect(anna?.sessions[0]?.agent).toBe("claude");
    expect(anna?.sessions[0]?.activity).toBe("typing");
  } finally {
    await sim.stop();
  }
  // bye ends the session immediately
  const after = OfficeSnapshot.parse(await (await fetch(`${HTTP}/api/state`, AUTH)).json());
  expect(after.data.people.flatMap((p) => p.sessions)).toHaveLength(0);
}, 20_000);
