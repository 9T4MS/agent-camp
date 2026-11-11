/**
 * Viewer WebSocket: connects to /ws/viewer (passing through ?key=), validates every
 * message with parseViewerMessage, reconnects with exponential backoff + jitter and
 * sends a "ping" text every 25 s (the server auto-responds "pong"). Phones freeze background
 * tabs and drop their sockets: when the page becomes visible again or the network comes
 * back, it reconnects at once instead of waiting out the backoff, and a socket that looks
 * open but stays silent after a ping (on wake, or for a whole ping interval) is replaced.
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
/** after waking up, a socket that answers nothing within this long is considered dead */
const WAKE_PONG_MS = 4_000;

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
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastHeard = 0;
  let pingSent = 0;

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
      pingSent = 0;
      pingTimer = setInterval(() => {
        const current = ws;
        if (current?.readyState !== WebSocket.OPEN) return;
        // a socket that stays open but silent (deploy, NAT timeout) never fires onclose
        if (pingSent > lastHeard) {
          replace(current);
          return;
        }
        pingSent = performance.now();
        current.send("ping");
      }, PING_MS);
    };
    ws.onmessage = (ev) => {
      lastHeard = performance.now();
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

  const replace = (current: WebSocket) => {
    current.onclose = null;
    current.onmessage = null;
    current.close();
    clearInterval(pingTimer);
    ws = null;
    attempt = 0;
    setStatus("reconnecting");
    open();
  };

  const wake = () => {
    if (closed || document.visibilityState !== "visible") return;
    if (ws?.readyState === WebSocket.OPEN) {
      // may be a zombie after the phone slept: ping it, replace it if it stays silent
      const sent = performance.now();
      ws.send("ping");
      clearTimeout(wakeTimer);
      const current = ws;
      wakeTimer = setTimeout(() => {
        if (ws !== current || lastHeard >= sent) return;
        // a dead socket can take a minute to report its close: drop it and open a new one
        replace(current);
      }, WAKE_PONG_MS);
    } else if (!ws) {
      // waiting out a backoff: try right now
      clearTimeout(retryTimer);
      attempt = 0;
      open();
    }
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", wake);

  open();
  return {
    close() {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      clearTimeout(wakeTimer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
      ws?.close();
    },
    get status() {
      return status;
    },
  };
}
