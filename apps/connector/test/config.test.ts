import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import {
  defaultMachineName,
  loadConfig,
  machineName,
  parseToml,
  saveConfig,
  stringifyToml,
  tomlString,
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
      saveConfig(path, { share_project_names: true, client_id: "c_abc", name: "Zoe" });
      const text = readFileSync(path, "utf8");
      expect(text).toContain('name = "Zoe"');
      expect(text).toContain("share_project_names = true");
      expect(text).toContain('client_id = "c_abc"');
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
