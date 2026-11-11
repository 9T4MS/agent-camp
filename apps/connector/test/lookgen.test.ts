import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidatePaths,
  detectGenerators,
  LOOK_GENERATOR_SETTINGS,
  LookGenerators,
  type LookRequest,
  type LookSpawn,
} from "../src/lookgen.ts";

const req: LookRequest = {
  requestId: "lr_1",
  system: "You dress up a pixel-art character.",
  prompt: "Name: Tom\n<self_description>\nTracht\n</self_description>",
  schema: { type: "object", properties: { hairColor: { type: "string" } } },
};
const look = { hairColor: "brown", look: { v: 1 } };

/** A fake CLI: records the call, answers like the real one would. */
function fakeSpawn(
  answer: (cmd: string[], cwd: string) => Partial<Awaited<ReturnType<LookSpawn>>>,
  calls: { cmd: string[]; stdin: string; cwd: string; env: Record<string, string> }[] = [],
): LookSpawn {
  return async (cmd, opts) => {
    calls.push({ cmd, stdin: opts.stdin, cwd: opts.cwd, env: opts.env });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...answer(cmd, opts.cwd) };
  };
}
const quiet = () => {};

describe("LookGenerators", () => {
  test("claude: headless, no tools, no MCP, no hooks, no saved session, structured_output", async () => {
    const calls: Parameters<typeof fakeSpawn>[1] = [];
    const gens = new LookGenerators({
      tools: new Map([["claude", "/x/bin/claude"]]),
      log: quiet,
      spawn: fakeSpawn(
        () => ({ stdout: JSON.stringify({ is_error: false, structured_output: look }) }),
        calls,
      ),
    });
    expect(gens.available).toEqual(["claude"]);
    const a = await gens.generate(req);
    expect(a).toEqual({ requestId: "lr_1", generator: "claude", avatar: look });
    const { cmd, stdin, env } = calls[0]!;
    // the exact command: the description is text a teammate can set, so no tool may be offered
    expect(cmd).toEqual([
      "/x/bin/claude",
      "-p",
      "--no-session-persistence",
      "--tools",
      "",
      "--strict-mcp-config",
      "--settings",
      JSON.stringify({ disableAllHooks: true }),
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(req.schema),
      "--system-prompt",
      req.system,
    ]);
    expect(stdin).toBe(req.prompt); // the description travels on stdin, not argv
    expect(env.PATH?.split(":")[0]).toBe("/x/bin");
  });

  test("failures become an error answer, never a throw", async () => {
    const make = (answer: Parameters<typeof fakeSpawn>[0]) =>
      new LookGenerators({
        tools: new Map([["claude", "/x/bin/claude"]]),
        log: quiet,
        spawn: fakeSpawn(answer),
      });
    const notLoggedIn = await make(() => ({
      exitCode: 1,
      stderr: "Invalid API key · Please run /login\n",
    })).generate(req);
    expect(notLoggedIn.error).toBe("exit 1: Invalid API key · Please run /login");
    expect(notLoggedIn.avatar).toBeUndefined();
    expect((await make(() => ({ stdout: "not json" })).generate(req)).error).toContain("JSON");
    expect((await make(() => ({ timedOut: true, exitCode: 143 })).generate(req)).error).toContain(
      "timed out",
    );
    expect(
      (
        await make(() => ({
          stdout: JSON.stringify({ is_error: true, result: "quota" }),
        })).generate(req)
      ).error,
    ).toContain("quota");
    const none = new LookGenerators({ tools: new Map(), log: quiet });
    expect((await none.generate(req)).error).toBe("no local AI tool");
  });

  test("one look at a time", async () => {
    let release = () => {};
    const gens = new LookGenerators({
      tools: new Map([["claude", "/x/bin/claude"]]),
      log: quiet,
      spawn: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              exitCode: 0,
              stdout: JSON.stringify({ structured_output: look }),
              stderr: "",
              timedOut: false,
            });
        }),
    });
    const first = gens.generate(req);
    expect((await gens.generate({ ...req, requestId: "lr_2" })).error).toContain("busy");
    release();
    expect((await first).avatar).toEqual(look);
  });
});

describe("detectGenerators", () => {
  test("finds claude in the usual install folders, honours the setting, never offers codex", async () => {
    const home = mkdtempSync(join(tmpdir(), "ao-look-"));
    try {
      const bin = join(home, ".local", "bin");
      mkdirSync(bin, { recursive: true });
      for (const tool of ["claude", "codex"]) {
        writeFileSync(join(bin, tool), "#!/bin/sh\n");
        chmodSync(join(bin, tool), 0o755);
      }
      const noShell = fakeSpawn(() => ({ stdout: "" }));
      expect(candidatePaths("claude", home)[0]).toBe(join(bin, "claude"));
      expect([...(await detectGenerators("auto", noShell, home)).keys()]).toEqual(["claude"]);
      expect([...(await detectGenerators("claude", noShell, home)).keys()]).toEqual(["claude"]);
      expect((await detectGenerators("off", noShell, home)).size).toBe(0);
      expect(LOOK_GENERATOR_SETTINGS).not.toContain("codex" as never);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("falls back to the login shell's PATH; nothing found = no generators", async () => {
    const home = mkdtempSync(join(tmpdir(), "ao-look-"));
    try {
      const elsewhere = join(home, "elsewhere");
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, "claude"), "#!/bin/sh\n");
      chmodSync(join(elsewhere, "claude"), 0o755);
      const shell = fakeSpawn((cmd) => ({
        stdout: cmd.at(-1)!.includes("claude")
          ? `motd noise\n@@${join(elsewhere, "claude")}@@`
          : "@@@@",
      }));
      const found = await detectGenerators("claude", shell, home);
      expect([...found.entries()]).toEqual([["claude", join(elsewhere, "claude")]]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
