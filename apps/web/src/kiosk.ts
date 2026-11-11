/**
 * Keep the kiosk screen awake (Screen Wake Lock, re-acquired on return), and notice when a
 * deploy has replaced the web build this page is running.
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

const BUILD_CHECK_MS = 30 * 60_000;
const VISIBLE_CHECK_MIN_MS = 10 * 60_000;
const RELOADED_FOR = "ao-reloaded-for";

/** The entry module of a built page (`<script type="module" src="./assets/index-<hash>.js">`). */
export function moduleScriptSrc(html: string): string | null {
  return /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(html)?.[1] ?? null;
}

const runningSrc = () =>
  document.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null;

/**
 * Call `onNewBuild` once the server serves a different entry module than the one running here.
 * Checks whenever the returned function is called (after a reconnect, which every deploy
 * causes), every 30 minutes while visible, and when the tab comes back into view. Each check is
 * a billed Worker request, so it stays rare.
 */
export function watchForNewBuild(onNewBuild: (served: string) => void): () => void {
  const running = runningSrc();
  let busy = false;
  let last = 0;
  const check = async () => {
    if (!running || busy) return;
    busy = true;
    last = Date.now();
    try {
      const r = await fetch(location.href, { cache: "no-store", headers: { accept: "text/html" } });
      if (!r.ok || r.redirected) return;
      const served = moduleScriptSrc(await r.text());
      if (served && served !== running) onNewBuild(served);
    } catch {
      // offline: try again later
    } finally {
      busy = false;
    }
  };
  setInterval(() => {
    if (document.visibilityState === "visible") void check();
  }, BUILD_CHECK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - last >= VISIBLE_CHECK_MIN_MS)
      void check();
  });
  return () => void check();
}

/** Reload into `served`; false if a reload already tried and still ran the old build (stale cache). */
export function reloadInto(served: string): boolean {
  const move = `${runningSrc()} -> ${served}`;
  try {
    if (sessionStorage.getItem(RELOADED_FOR) === move) return false;
    sessionStorage.setItem(RELOADED_FOR, move);
  } catch {
    // storage blocked: reload anyway, the next check decides again
  }
  location.reload();
  return true;
}
