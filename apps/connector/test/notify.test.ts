import { describe, expect, test } from "bun:test";
import { NOTIFY_MIN_INTERVAL_MS, Notifier, notificationLines } from "../src/notify.ts";

function setup(enabled = true, platform = "darwin") {
  let now = 0;
  const calls: string[][] = [];
  const logs: string[] = [];
  const n = new Notifier({
    enabled,
    platform,
    log: (l) => logs.push(l),
    now: () => now,
    spawn: (cmd) => {
      calls.push(cmd);
      return { exited: Promise.resolve(0) };
    },
  });
  return { n, calls, logs, advance: (ms: number) => (now += ms) };
}

describe("notifier", () => {
  test("passes text as osascript argv, never inside the script", () => {
    const { n, calls } = setup();
    const evil = 'hi" & do shell script "rm -rf ~" & "';
    expect(n.show({ kind: "message", from: "Martin", text: evil })).toBe(true);
    const [cmd, flag, script, body, subtitle] = calls[0]!;
    expect([cmd, flag]).toEqual(["osascript", "-e"]);
    expect(script).not.toContain("rm -rf");
    expect(body).toBe(evil);
    expect(subtitle).toBe("Martin says");
  });

  test("rate limited, can be turned off, macOS only", () => {
    const a = setup();
    expect(a.n.show({ kind: "wave", text: "x waved" })).toBe(true);
    expect(a.n.show({ kind: "wave", text: "x waved" })).toBe(false);
    a.advance(NOTIFY_MIN_INTERVAL_MS);
    expect(a.n.show({ kind: "wave", text: "x waved" })).toBe(true);
    const off = setup(false);
    expect(off.n.show({ kind: "wave", text: "x" })).toBe(false);
    expect(off.calls).toHaveLength(0);
    const linux = setup(true, "linux");
    expect(linux.n.show({ kind: "wave", text: "x" })).toBe(false);
    expect(linux.calls).toHaveLength(0);
  });

  test("a cat from the office gets its own subtitle", () => {
    const lines = notificationLines({ kind: "cat", from: "Martin", text: "Martin sent a cat" });
    expect(lines).toEqual({ body: "Martin sent a cat", subtitle: "Cat delivery" });
  });

  test("strips control characters", () => {
    expect(notificationLines({ kind: "wave", text: "a\nb\u0007c" }).body).toBe("a b c");
  });
});
