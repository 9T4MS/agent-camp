/**
 * The `run` loop: poll detectors every DETECT_POLL_MS, send `presence.snapshot` when it changed
 * (debounced) and as a heartbeat, keep the status file fresh, and trigger self-updates.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DETECT_POLL_MS,
  envelope,
  HEARTBEAT_MS,
  type MessageData,
  type SessionInfo,
  SNAPSHOT_DEBOUNCE_MS,
} from "@agent-office/protocol";
import {
  type ClientOptions,
  ConnectorClient,
  type LookRequested,
  type Welcomed,
} from "./client.ts";
import { snapshotKey } from "./detect/index.ts";
import type { Logger } from "./log.ts";
import { isNewer, type Updater } from "./update.ts";

export type Poller = { poll(): Promise<SessionInfo[]> };

export type DaemonOptions = {
  server: string;
  hello: ClientOptions["hello"];
  detector: Poller;
  updater?: Updater;
  log: Logger;
  version: string;
  /** write status.json here every poll (optional) */
  statusFile?: string;
  pollMs?: number;
  debounceMs?: number;
  heartbeatMs?: number;
  onPoked?: ClientOptions["onPoked"];
  /** draws looks with a local AI tool when the office asks (see lookgen.ts) */
  looks?: { generate(req: LookRequested): Promise<MessageData<"connector.lookGenerated">> };
  /** for `agent-office status`: which local AI draws the look ("off" when none) */
  looksLabel?: string;
  client?: Partial<ClientOptions>;
};

export type StatusFile = {
  pid: number;
  version: string;
  server: string;
  name: string;
  connected: boolean;
  welcomed: boolean;
  personId?: string;
  lastError?: string;
  updatedAt: number;
  /** local AI that draws the look, e.g. "claude (/Users/x/.local/bin/claude)" or "off" */
  looks?: string;
  sessions: Omit<SessionInfo, "sessionKey">[];
};

const label = (s: SessionInfo) => `${s.agent} ${s.project ?? "(hidden)"}`;

/** Human-readable change lines between two snapshots. */
export function describeChanges(prev: SessionInfo[], next: SessionInfo[]): string[] {
  const lines: string[] = [];
  const before = new Map(prev.map((s) => [s.sessionKey, s]));
  const after = new Map(next.map((s) => [s.sessionKey, s]));
  for (const s of next) {
    const p = before.get(s.sessionKey);
    if (!p) {
      lines.push(`session+ ${label(s)} ${s.activity}${s.subagents ? ` +${s.subagents} sub` : ""}`);
      continue;
    }
    if (p.activity !== s.activity) lines.push(`${label(s)} ${p.activity} -> ${s.activity}`);
    if (p.subagents !== s.subagents) {
      lines.push(`${label(s)} subagents ${p.subagents} -> ${s.subagents}`);
    }
  }
  for (const p of prev) if (!after.has(p.sessionKey)) lines.push(`session- ${label(p)}`);
  return lines;
}

export class Daemon {
  readonly client: ConnectorClient;
  private sessions: SessionInfo[] = [];
  private lastKey = "";
  private lastSentKey = "";
  private blocked = false;
  private stopped = false;
  /** a drawn look that could not be sent (connection dropped meanwhile): sent on the next welcome */
  private unsentLook: MessageData<"connector.lookGenerated"> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private state: { connected: boolean; welcomed: boolean; error?: string; personId?: string } = {
    connected: false,
    welcomed: false,
  };

  constructor(private readonly opts: DaemonOptions) {
    this.client = new ConnectorClient({
      server: opts.server,
      hello: opts.hello,
      log: opts.log,
      onWelcomed: (w) => this.onWelcomed(w),
      ...(opts.onPoked ? { onPoked: opts.onPoked } : {}),
      ...(opts.looks ? { onLookRequested: (r: LookRequested) => void this.drawLook(r) } : {}),
      onState: (s) => {
        this.state = {
          ...this.state,
          connected: s.connected,
          welcomed: s.welcomed,
          error: s.error ?? (s.welcomed ? undefined : this.state.error),
        };
        if (!s.welcomed) this.lastSentKey = "";
        this.writeStatus();
      },
      onTooOld: () => void opts.updater?.maybeUpdate(undefined, "server says too old"),
      ...opts.client,
    });
  }

  get current(): SessionInfo[] {
    return this.sessions;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.tick(); // know our sessions before the first hello
    this.client.start();
    this.heartbeatTimer = setInterval(
      () => this.sendNow(true),
      this.opts.heartbeatMs ?? HEARTBEAT_MS,
    );
    this.opts.updater?.startPolling();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const next = await this.opts.detector.poll();
      const key = snapshotKey(next);
      if (key !== this.lastKey) {
        for (const line of describeChanges(this.sessions, next)) this.opts.log(line);
        this.sessions = next;
        this.lastKey = key;
        this.scheduleSend();
      } else {
        this.sessions = next;
      }
    } catch (e) {
      this.opts.log(`poll error: ${(e as Error).message}`);
    }
    this.writeStatus();
    if (!this.stopped) {
      this.pollTimer = setTimeout(() => void this.tick(), this.opts.pollMs ?? DETECT_POLL_MS);
    }
  }

  private scheduleSend(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.sendNow(false);
    }, this.opts.debounceMs ?? SNAPSHOT_DEBOUNCE_MS);
  }

  /** Send the current snapshot if welcomed (heartbeat = send even when unchanged). */
  private sendNow(heartbeat: boolean): void {
    if (this.blocked || !this.client.welcomed) return;
    if (!heartbeat && this.lastKey === this.lastSentKey) return;
    if (this.client.sendSnapshot(this.sessions)) this.lastSentKey = this.lastKey;
  }

  /** Draw the look the office asked for and send it back (or keep it for the next welcome). */
  private async drawLook(req: LookRequested): Promise<void> {
    const looks = this.opts.looks;
    if (!looks || this.stopped) return;
    const answer = await looks.generate(req);
    if (this.stopped) return;
    if (!this.client.send(envelope("connector.lookGenerated", answer))) {
      this.opts.log("look: not connected, sending it once the office is back");
      this.unsentLook = answer;
    }
  }

  private onWelcomed(w: Welcomed): void {
    this.state.personId = w.personId;
    const up = this.opts.updater;
    if (up?.isTooOld(w.minConnectorVersion)) {
      this.blocked = true;
      this.opts.log(`below server minimum ${w.minConnectorVersion}; updating before sending`);
      void up.maybeUpdate(
        isNewer(w.latestConnectorVersion, this.opts.version) ? w.latestConnectorVersion : undefined,
        "below minimum",
      );
      return;
    }
    this.blocked = false;
    if (this.unsentLook && this.client.send(envelope("connector.lookGenerated", this.unsentLook)))
      this.unsentLook = null;
    if (up && isNewer(w.latestConnectorVersion, this.opts.version)) {
      void up.maybeUpdate(w.latestConnectorVersion, "server announced");
    }
    this.sendNow(true);
  }

  private writeStatus(): void {
    const file = this.opts.statusFile;
    if (!file) return;
    const status: StatusFile = {
      pid: process.pid,
      version: this.opts.version,
      server: this.client.url,
      name: this.opts.hello().name,
      connected: this.state.connected,
      welcomed: this.state.welcomed,
      personId: this.state.personId,
      lastError: this.state.error,
      updatedAt: Date.now(),
      ...(this.opts.looksLabel ? { looks: this.opts.looksLabel } : {}),
      sessions: this.sessions.map(({ sessionKey: _k, ...rest }) => rest),
    };
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
      renameSync(tmp, file);
    } catch {
      // status is best effort
    }
  }

  async stop(bye = true): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.opts.updater?.stop();
    await this.client.stop(bye);
    this.state = { connected: false, welcomed: false };
    this.writeStatus();
  }
}
