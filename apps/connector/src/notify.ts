/**
 * Desktop notifications for pokes from the office (`connector.poked`). macOS only, via
 * `osascript`; the text travels as argv, never spliced into the AppleScript source.
 */
import type { MessageData } from "@agent-office/protocol";
import type { Logger } from "./log.ts";

export type Poke = MessageData<"connector.poked">;

/** At most one notification this often, whatever the server sends. */
export const NOTIFY_MIN_INTERVAL_MS = 5_000;

const SCRIPT = `on run argv
display notification (item 1 of argv) with title "Agent Office" subtitle (item 2 of argv) sound name "Pop"
end run`;

export type Spawn = (cmd: string[]) => { exited: Promise<number> };

/** Visible lines: control characters stripped, length capped. */
export function notificationLines(p: Poke): { body: string; subtitle: string } {
  const clean = (s: string, max: number) =>
    Array.from(s, (ch) => {
      const c = ch.codePointAt(0)!;
      return c < 0x20 || c === 0x7f ? " " : ch;
    })
      .join("")
      .trim()
      .slice(0, max);
  const from = clean(p.from ?? "", 40);
  return {
    body: clean(p.text, 200),
    subtitle:
      p.kind === "message" ? `${from || "Someone"} says` : p.kind === "cat" ? "Cat delivery" : "",
  };
}

export class Notifier {
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly opts: {
      enabled: boolean;
      log: Logger;
      platform?: string;
      now?: () => number;
      spawn?: Spawn;
    },
  ) {}

  /** Returns true if a notification was shown (or handed to osascript). */
  show(p: Poke): boolean {
    if (!this.opts.enabled) {
      this.opts.log(`poke (${p.kind}) ignored: notifications are off`);
      return false;
    }
    if ((this.opts.platform ?? process.platform) !== "darwin") {
      this.opts.log(`poke (${p.kind}): ${p.text}`);
      return false;
    }
    const now = (this.opts.now ?? Date.now)();
    if (now - this.last < NOTIFY_MIN_INTERVAL_MS) return false;
    this.last = now;
    const { body, subtitle } = notificationLines(p);
    const spawn: Spawn =
      this.opts.spawn ?? ((cmd) => Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }));
    try {
      spawn(["osascript", "-e", SCRIPT, body, subtitle]).exited.then((code) => {
        if (code !== 0) this.opts.log(`notification failed (osascript exit ${code})`);
      });
    } catch (e) {
      this.opts.log(`notification failed: ${(e as Error).message}`);
      return false;
    }
    this.opts.log(`poke (${p.kind}) shown`);
    return true;
  }
}
