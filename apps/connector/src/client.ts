/**
 * WebSocket client for /ws/connector: hello -> welcomed/rejected, reconnect with exponential
 * backoff + jitter, every outgoing message validated against the protocol schema.
 */
import {
  backoffDelay,
  CLOSE_BAD_PASSWORD,
  CLOSE_TOO_OLD,
  ConnectorToServer,
  envelope,
  type MessageData,
  type MessageOf,
  parseServerToConnector,
  type SessionInfo,
  WS_CONNECTOR_PATH,
} from "@agent-office/protocol";
import type { Logger } from "./log.ts";

export type Welcomed = MessageData<"connector.welcomed">;
export type Poked = MessageData<"connector.poked">;
export type LookRequested = MessageData<"connector.lookRequested">;

export type ClientOptions = {
  /** server base URL (http(s)/ws(s), with or without the /ws/connector path) */
  server: string;
  hello: () => MessageData<"connector.hello">;
  log: Logger;
  onWelcomed?: (data: Welcomed) => void;
  /** someone in the office waved at / messaged this person */
  onPoked?: (data: Poked) => void;
  /** the office asks this Mac to draw the person's look with its local AI tool */
  onLookRequested?: (data: LookRequested) => void;
  /** connection state changes (for the status file) */
  onState?: (state: { connected: boolean; welcomed: boolean; error?: string }) => void;
  /** the server closed with 4002 (too old) */
  onTooOld?: () => void;
  rand?: () => number;
  /** wait this long after a bad-password rejection (don't hammer) */
  badPasswordDelayMs?: number;
  /** close and retry if the handshake takes longer than this */
  handshakeTimeoutMs?: number;
  WebSocketImpl?: typeof WebSocket;
};

export const BAD_PASSWORD_DELAY_MS = 5 * 60_000;

/** "office.example.com" / "https://x" / "ws://localhost:8787" -> full ws(s) connector URL. */
export function connectorUrl(server: string): string {
  let s = server.trim();
  if (!/^[a-z]+:\/\//i.test(s)) {
    s = /^(localhost|127\.|\[::1\])/.test(s) ? `ws://${s}` : `wss://${s}`;
  }
  const u = new URL(s);
  if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol === "https:") u.protocol = "wss:";
  if (u.pathname === "" || u.pathname === "/") u.pathname = WS_CONNECTOR_PATH;
  return u.toString();
}

export class ConnectorClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private _welcomed: Welcomed | null = null;
  private lastCloseInfo = "";
  readonly url: string;

  constructor(private readonly opts: ClientOptions) {
    this.url = connectorUrl(opts.server);
  }

  get welcomed(): Welcomed | null {
    return this._welcomed;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new WS(this.url);
    } catch (e) {
      this.opts.log(`connect error: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this._welcomed = null;
    this.handshakeTimer = setTimeout(() => {
      if (this.ws === ws && !this._welcomed) {
        this.opts.log("handshake timed out");
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    }, this.opts.handshakeTimeoutMs ?? 15_000);

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.opts.onState?.({ connected: true, welcomed: false });
      const sent = this.send(envelope("connector.hello", this.opts.hello()));
      if (!sent) ws.close(1000, "invalid hello");
    });
    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws) return;
      const data = typeof ev.data === "string" ? ev.data : "";
      const r = parseServerToConnector(data);
      if (!r.ok) return; // pongs, unknown or future messages: ignore
      const msg = r.msg;
      switch (msg.type) {
        case "connector.welcomed": {
          this._welcomed = msg.data;
          this.attempt = 0;
          this.clearHandshake();
          this.opts.log(
            `connected to ${this.url} as ${msg.data.personId} (server ${msg.data.serverVersion})`,
          );
          this.opts.onState?.({ connected: true, welcomed: true });
          this.opts.onWelcomed?.(msg.data);
          break;
        }
        case "connector.poked":
          if (this._welcomed) this.opts.onPoked?.(msg.data);
          break;
        case "connector.lookRequested":
          if (this._welcomed) this.opts.onLookRequested?.(msg.data);
          break;
        case "connector.rejected":
          this.lastCloseInfo = `${msg.data.reason}${msg.data.message ? `: ${msg.data.message}` : ""}`;
          this.opts.log(`rejected by server: ${this.lastCloseInfo}`);
          break;
      }
    });
    ws.addEventListener("error", () => {
      // a close event always follows; it handles reconnecting
    });
    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._welcomed = null;
      this.clearHandshake();
      const code = ev.code;
      const why = this.lastCloseInfo || ev.reason || `code ${code}`;
      this.lastCloseInfo = "";
      this.opts.onState?.({ connected: false, welcomed: false, error: why });
      if (this.stopped) return;
      if (code === CLOSE_BAD_PASSWORD) {
        const delay = this.opts.badPasswordDelayMs ?? BAD_PASSWORD_DELAY_MS;
        this.opts.log(
          `bad password; check ~/.config/agent-office/config.toml. retrying in ${Math.round(delay / 1000)}s`,
        );
        this.scheduleReconnect(delay);
        return;
      }
      if (code === CLOSE_TOO_OLD) {
        this.opts.log("server says this connector is too old; updating");
        this.opts.onTooOld?.();
      }
      this.scheduleReconnect();
    });
  }

  private clearHandshake(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private scheduleReconnect(delay?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    const d = delay ?? backoffDelay(this.attempt++, this.opts.rand);
    if (delay === undefined && this.attempt > 1) {
      this.opts.log(`disconnected; reconnecting in ${(d / 1000).toFixed(1)}s`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, d);
  }

  /** Validate and send. Returns false if invalid or not connected. */
  send(msg: MessageOf<ConnectorToServer["type"]>): boolean {
    const r = ConnectorToServer.safeParse(msg);
    if (!r.success) {
      this.opts.log(`refusing to send invalid ${msg.type}: ${r.error.issues[0]?.message ?? "?"}`);
      return false;
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(r.data));
      return true;
    } catch {
      return false;
    }
  }

  /** Send a presence snapshot (only after welcomed). */
  sendSnapshot(sessions: SessionInfo[]): boolean {
    if (!this._welcomed) return false;
    return this.send(envelope("presence.snapshot", { sessions }));
  }

  /** Stop reconnecting; send connector.bye if connected. */
  async stop(bye = true): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHandshake();
    const ws = this.ws;
    if (!ws) return;
    if (bye) this.send(envelope("connector.bye", {}));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 500);
      ws.addEventListener("close", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        ws.close(1000, "bye");
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    this.ws = null;
  }
}
