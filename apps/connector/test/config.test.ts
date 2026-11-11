import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SELF_DESCRIPTION, SHORT_SELF_DESCRIPTION } from "@agent-office/protocol";
import { helloDescription, parseArgs } from "../src/cli.ts";
import {
  defaultMachineName,
  loadConfig,
  machineName,
  parseToml,
  saveConfig,
  stringifyToml,
  toConfig,
  tomlString,
  validHelpers,
} from "../src/config.ts";

describe("config.toml", () => {
  test("round-trips tricky strings and bools", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cfg-"));
    try {
      const path = join(dir, "sub", "config.toml");
      const { config, existed } = loadConfig(path);
      expect(existed).toBe(false);
      expect(config.share_project_names).toBe(true);
      expect(config.client_id).toMatch(/^c_[0-9a-f]{18}$/);
      const written = {
        ...config,
        server: "https://office.example.com",
        password: `p"a\\ss # not a comment\nline2\ttab 'single' \u0001`,
        name: "Anna Müller 🐙",
        self_description: 'curly hair, "round" glasses',
        machine_name: "devbox",
        share_project_names: false,
        helpers: "cats" as const,
      };
      saveConfig(path, written);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const back = loadConfig(path);
      expect(back.existed).toBe(true);
      expect(back.config).toEqual(written);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parser tolerates comments, single quotes, junk", () => {
    const t = parseToml(
      [
        "# comment",
        "[section]",
        'server = "wss://x" # trailing',
        "name = 'Bob'",
        "share_project_names = false",
        "count = 3",
        "garbage line",
        'broken = "unterminated',
      ].join("\n"),
    );
    expect(t).toEqual({ server: "wss://x", name: "Bob", share_project_names: false, count: 3 });
    expect(parseToml(stringifyToml({ a: "x", b: true, c: undefined }))).toEqual({
      a: "x",
      b: true,
    });
    expect(tomlString('a"b')).toBe('"a\\"b"');
  });

  test("written file is plain flat TOML", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cfg-"));
    try {
      const path = join(dir, "config.toml");
      saveConfig(path, {
        share_project_names: true,
        notifications: true,
        helpers: "robots",
        client_id: "c_abc",
        name: "Zoe",
      });
      const text = readFileSync(path, "utf8");
      expect(text).toContain('name = "Zoe"');
      expect(text).toContain("share_project_names = true");
      expect(text).toContain('client_id = "c_abc"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("helpers", () => {
  test("robots by default; cats when set; junk falls back to robots", () => {
    expect(toConfig({}).helpers).toBe("robots");
    expect(toConfig({ helpers: "cats" }).helpers).toBe("cats");
    expect(toConfig({ helpers: " Cats " }).helpers).toBe("cats");
    expect(toConfig({ helpers: "dogs" }).helpers).toBe("robots");
    expect(toConfig({ helpers: true }).helpers).toBe("robots");
    expect(validHelpers("robots")).toBe("robots");
    expect(validHelpers("")).toBeUndefined();
  });

  test("configure --helpers writes it; --get reads it back; bad values exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cfg-"));
    try {
      const main = join(import.meta.dir, "..", "src", "main.ts");
      const env = { ...process.env, AGENT_OFFICE_CONFIG_DIR: dir };
      const run = async (...args: string[]) => {
        const p = Bun.spawn([process.execPath, main, ...args], {
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(p.stdout).text();
        return { code: await p.exited, out: out.trim() };
      };
      expect((await run("configure", "--get", "helpers")).out).toBe("robots");
      expect((await run("configure", "--helpers", "cats")).code).toBe(0);
      expect((await run("configure", "--get", "helpers")).out).toBe("cats");
      expect((await run("configure", "--helpers", "dogs")).code).toBe(2);
      expect((await run("configure", "--get", "helpers")).out).toBe("cats");
      expect((await run("configure", "--helpers", "robots")).code).toBe(0);
      expect((await run("configure", "--get", "helpers")).out).toBe("robots");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("machine name", () => {
  test("defaults to the short hostname, config wins, max 40 chars", () => {
    expect(defaultMachineName("martins-mbp.local")).toBe("martins-mbp");
    expect(defaultMachineName("devbox")).toBe("devbox");
    expect(defaultMachineName("")).toBe("");
    expect(defaultMachineName("x".repeat(60))).toHaveLength(40);
    expect(machineName({}, "laptop.example.com")).toBe("laptop");
    expect(machineName({ machine_name: "  " }, "laptop.lan")).toBe("laptop");
    expect(machineName({ machine_name: " MacBook " }, "laptop.lan")).toBe("MacBook");
    expect(defaultMachineName().length).toBeLessThanOrEqual(40);
  });

  test("configure --machine-name writes it; --get reads it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cfg-"));
    try {
      const main = join(import.meta.dir, "..", "src", "main.ts");
      const env = { ...process.env, AGENT_OFFICE_CONFIG_DIR: dir };
      const run = async (...args: string[]) => {
        const p = Bun.spawn([process.execPath, main, ...args], { env, stdout: "pipe" });
        const out = await new Response(p.stdout).text();
        return { code: await p.exited, out: out.trim() };
      };
      expect((await run("configure", "--machine-name", "devbox")).code).toBe(0);
      expect((await run("configure", "--get", "machine_name")).out).toBe("devbox");
      expect((await run("configure", "--machine-name", "x".repeat(41))).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cli args", () => {
  test("flags", () => {
    expect(
      parseArgs(["run", "--server", "ws://x", "--once", "--home=/h", "--assume-processes", "-y"]),
    ).toEqual({
      command: "run",
      flags: { server: "ws://x", once: true, home: "/h", "assume-processes": true, yes: true },
      rest: [],
    });
    expect(parseArgs([]).command).toBe("help");
    expect(parseArgs(["configure", "--description", ""]).flags.description).toBe("");
  });
});

describe("look description", () => {
  const LONG = "Slim, slicked-back brown hair, tortoiseshell panto glasses. ".repeat(20).trim();

  test("hello sends the 200-char head, plus the full text when longer", () => {
    expect(helloDescription(undefined)).toEqual({});
    expect(helloDescription("   ")).toEqual({});
    expect(helloDescription(" round glasses ")).toEqual({ selfDescription: "round glasses" });
    const exact = "x".repeat(SHORT_SELF_DESCRIPTION);
    expect(helloDescription(exact)).toEqual({ selfDescription: exact });
    expect(LONG.length).toBeGreaterThan(SHORT_SELF_DESCRIPTION);
    expect(helloDescription(LONG)).toEqual({
      selfDescription: LONG.slice(0, SHORT_SELF_DESCRIPTION),
      lookDescription: LONG,
    });
    const huge = "y".repeat(MAX_SELF_DESCRIPTION + 50);
    expect(helloDescription(huge).lookDescription).toHaveLength(MAX_SELF_DESCRIPTION);
  });

  test("configure --description / --description-file (file and stdin), 8000-char cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cfg-"));
    try {
      const main = join(import.meta.dir, "..", "src", "main.ts");
      const env = { ...process.env, AGENT_OFFICE_CONFIG_DIR: dir };
      const run = async (args: string[], stdin?: string) => {
        const p = Bun.spawn([process.execPath, main, ...args], {
          env,
          stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
        ]);
        return { code: await p.exited, out, err };
      };
      const stored = () => loadConfig(join(dir, "config.toml")).config.self_description;

      // a long single-line description is no longer cut at 200
      expect((await run(["configure", "--description", LONG])).code).toBe(0);
      expect(stored()).toBe(LONG);

      // multi-paragraph file; the file wins over --description
      const file = join(dir, "look.md");
      const text = `# My look\n\nSlicked-back hair.\n\n- white sneakers with navy heels\n${LONG}\n`;
      writeFileSync(file, text);
      const r = await run(["configure", "--description", "ignored", "--description-file", file]);
      expect(r.code).toBe(0);
      expect(stored()).toBe(text.trim());
      expect((await run(["configure", "--get", "self_description"])).out.trim()).toBe(text.trim());

      // stdin
      expect((await run(["configure", "--description-file", "-"], "  from stdin\n")).code).toBe(0);
      expect(stored()).toBe("from stdin");

      // over the cap: truncated with a note on stderr
      const huge = "z".repeat(MAX_SELF_DESCRIPTION + 10);
      writeFileSync(file, huge);
      const big = await run(["configure", "--description-file", file]);
      expect(big.code).toBe(0);
      expect(big.err).toContain(String(MAX_SELF_DESCRIPTION));
      expect(stored()).toHaveLength(MAX_SELF_DESCRIPTION);

      // missing file: error, config untouched
      const missing = await run(["configure", "--description-file", join(dir, "nope.md")]);
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("nope.md");
      expect(stored()).toHaveLength(MAX_SELF_DESCRIPTION);

      // empty clears it
      expect((await run(["configure", "--description", ""])).code).toBe(0);
      expect(stored()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
