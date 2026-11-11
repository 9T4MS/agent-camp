/**
 * Kiosk helpers: keep the screen awake (Screen Wake Lock, re-acquired on return), and reload
 * when a deploy has replaced the web build this page is running.
 */
type WakeLockSentinelLike = { release(): Promise<void> };

export function keepAwake() {
  let lock: WakeLockSentinelLike | null = null;
  const request = async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
      };
      if (nav.wakeLock && document.visibilityState === "visible") {
        lock = await nav.wakeLock.request("screen");
      }
    } catch {
      // not supported / not allowed: fine
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void request();
  });
  // Safari only grants it after a user gesture
  document.addEventListener("pointerdown", () => void request(), { once: true });
  void request();
  return () => void lock?.release();
}

const BUILD_CHECK_MS = 10 * 60_000;
const RELOADED_FOR = "ao-reloaded-for";

/** The entry module of a built page (`<script type="module" src="./assets/index-<hash>.js">`). */
export function moduleScriptSrc(html: string): string | null {
  return /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(html)?.[1] ?? null;
}

/**
 * Reload once the server serves a different entry module than the one running here. Checks
 * every 10 minutes and whenever the returned function is called (after a reconnect).
 */
export function reloadOnNewBuild(): () => void {
  const running = document.querySelector('script[type="module"][src]')?.getAttribute("src");
  let busy = false;
  const check = async () => {
    if (!running || busy) return;
    busy = true;
    try {
      const r = await fetch(location.href, { cache: "no-store", headers: { accept: "text/html" } });
      if (!r.ok || r.redirected) return;
      const served = moduleScriptSrc(await r.text());
      if (!served || served === running) return;
      // a reload that still runs the old build (stale cache) must not loop
      const move = `${running} -> ${served}`;
      if (sessionStorage.getItem(RELOADED_FOR) === move) return;
      sessionStorage.setItem(RELOADED_FOR, move);
      location.reload();
    } catch {
      // offline or storage blocked: try again later
    } finally {
      busy = false;
    }
  };
  setInterval(() => void check(), BUILD_CHECK_MS);
  return () => void check();
}
