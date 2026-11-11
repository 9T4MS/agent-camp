/**
 * Viewer WebSocket: connects to /ws/viewer (passing through ?key=), validates every
 * message with parseViewerMessage, reconnects with exponential backoff + jitter and
 * sends a "ping" text every 25 s (the server auto-responds "pong").
 */
import {
  backoffDelay,
  parseViewerMessage,
  type ServerToViewer,
  WS_VIEWER_PATH,
} from "@agent-office/protocol";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

export type ViewerConnection = {
  close(): void;
  readonly status: ConnectionStatus;
};

const PING_MS = 25_000;

/** If the session cookie is gone (expired, password changed), go to the login page. */
export async function loginIfLoggedOut(): Promise<void> {
  try {
    const r = await fetch("/api/me", { headers: { accept: "application/json" } });
    if (r.status === 401) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    }
  } catch {
    // offline: keep reconnecting
  }
}

export function connectViewer(opts: {
  key?: string | null;
  onMessage: (msg: ServerToViewer) => void;
  onStatus?: (status: ConnectionStatus) => void;
  url?: string;
}): ViewerConnection {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let closed = false;
  let status: ConnectionStatus = "connecting";
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (s: ConnectionStatus) => {
    if (s === status) return;
    status = s;
    opts.onStatus?.(s);
  };

  const url = () => {
    if (opts.url) return opts.url;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const q = opts.key ? `?key=${encodeURIComponent(opts.key)}` : "";
    return `${proto}//${location.host}${WS_VIEWER_PATH}${q}`;
  };

  const open = () => {
    if (closed) return;
    try {
      ws = new WebSocket(url());
    } catch {
      scheduleRetry();
      return;
    }
    ws.onopen = () => {
      attempt = 0;
      setStatus("open");
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
      }, PING_MS);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      const r = parseViewerMessage(ev.data);
      if (r.ok) opts.onMessage(r.msg);
      else console.warn("[viewer] dropped invalid message:", r.error);
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      ws = null;
      scheduleRetry();
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here
    };
  };

  const scheduleRetry = () => {
    if (closed) return;
    // browsers hide the 401 of a refused upgrade; ask over HTTP after a couple of failures
    if (attempt === 2 && !opts.url) void loginIfLoggedOut();
    setStatus("reconnecting");
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, backoffDelay(attempt++));
  };

  open();
  return {
    close() {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      ws?.close();
    },
    get status() {
      return status;
    },
  };
}
