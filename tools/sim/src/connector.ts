/**
 * One fake connector = one laptop, speaking the real protocol over a real WebSocket:
 * hello -> welcomed, debounced presence.snapshot on change, heartbeat every 30 s, bye on clean
 * quit. Every outgoing message is validated against the protocol schema first.
 */
import {
  backoffDelay,
  HEARTBEAT_MS,
  parseServerToConnector,
  type SessionInfo,
  SNAPSHOT_DEBOUNCE_MS,
} from "@agent-office/protocol";
import { byeMessage, helloMessage, type LaptopDef, snapshotMessage } from "./world.ts";

export type FakeConnectorOptions = {
  /** full ws(s)://host/ws/connector URL */
  url: string;
  password: string;
  sessions: () => SessionInfo[];
  log: (line: string) => void;
  /** debounce for change snapshots (ms, real time) */
  debounceMs?: number;
  /** reconnect automatically if the server closes the socket (not after drop/bye) */
  autoReconnect?: boolean;
};

export class FakeConnector {
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** true while we want to be connected */
  private wanted = false;
  welcomed = false;
  personId: string | null = null;
  sent = 0;

  constructor(
    readonly laptop: LaptopDef,
    private opts: FakeConnectorOptions,
  ) {}

  /** Open the socket, say hello, resolve once welcomed (rejects on connector.rejected). */
  connect(timeoutMs = 10_000): Promise<void> {
    this.wanted = true;
    this.clearRetry();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => done(new Error(`${this.tag} hello timed out`)), timeoutMs);
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.opts.url);
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.send(helloMessage(this.laptop, this.opts.password));
      };
      ws.onmessage = (ev) => {
        const parsed = parseServerToConnector(String(ev.data));
        if (!parsed.ok) return;
        const msg = parsed.msg;
        if (msg.type === "connector.welcomed") {
          this.welcomed = true;
          this.attempt = 0;
          this.personId = msg.data.personId;
          this.sendSnapshot();
          this.startHeartbeat();
          done();
        } else if (msg.type === "connector.rejected") {
          done(new Error(`${this.tag} rejected: ${msg.data.reason} ${msg.data.message ?? ""}`));
        }
      };
      ws.onerror = () => done(new Error(`${this.tag} could not connect to ${this.opts.url}`));
      ws.onclose = (ev) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.welcomed = false;
        this.stopTimers();
        done(new Error(`${this.tag} closed ${ev.code} ${ev.reason}`));
        if (this.wanted && this.opts.autoReconnect && ev.code < 4000) {
          const delay = backoffDelay(this.attempt++);
          this.opts.log(`${this.tag} socket closed (${ev.code}), reconnecting in ${delay} ms`);
          this.retry = setTimeout(() => {
            this.connect().catch(() => {});
          }, delay);
        }
      };
    });
  }

  get connected(): boolean {
    return this.welcomed && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Something changed: send a snapshot after the debounce. */
  markDirty(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.sendSnapshot();
    }, this.opts.debounceMs ?? SNAPSHOT_DEBOUNCE_MS);
  }

  /** Send any pending snapshot right now. */
  flush(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
      this.sendSnapshot();
    }
  }

  /** Vanish without a bye: socket closes, heartbeats stop. */
  drop(): void {
    this.wanted = false;
    this.stopTimers();
    this.clearRetry();
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    ws?.close();
  }

  /** Clean quit: bye, then close. */
  async bye(): Promise<void> {
    this.wanted = false;
    this.flush();
    this.stopTimers();
    this.clearRetry();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN && this.welcomed) {
      ws.send(JSON.stringify(byeMessage()));
      this.sent++;
      // give the frame a moment to leave before closing
      await new Promise((r) => setTimeout(r, 20));
    }
    this.welcomed = false;
    ws?.close(1000, "bye");
  }

  private get tag(): string {
    return `${this.laptop.name}/${this.laptop.clientId}`;
  }

  private sendSnapshot(): void {
    if (!this.connected) return;
    this.send(snapshotMessage(this.opts.sessions()));
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
    this.sent++;
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.sendSnapshot(), HEARTBEAT_MS);
  }

  private stopTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.debounce) clearTimeout(this.debounce);
    this.heartbeat = null;
    this.debounce = null;
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }
}
