/** iPad kiosk helpers: keep the screen awake (Screen Wake Lock), re-acquire on return. */
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
