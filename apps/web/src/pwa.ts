/**
 * Installed-app (PWA) helpers: service worker registration, the install prompt (Chrome /
 * Edge / Android hand us `beforeinstallprompt`; iOS and iPadOS only offer Share → Add to
 * Home Screen), and "are we running as the installed app" checks.
 */

type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of listeners) l();
};

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we show our own "Install app" entry instead of the mini-infobar
    deferred = e as InstallPromptEvent;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    changed();
  });
}

/** Register /sw.js (production builds only; the dev server has no hashed assets). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // private mode, blocked storage, plain http: the app works without it
    });
  });
}

/** Running from the home screen / app launcher rather than a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPhone / iPad (iPadOS reports itself as a Mac, but with touch). */
export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export type InstallMode = "prompt" | "ios" | null;

/** How this browser can install the app right now: our own prompt, iOS instructions, or not at all. */
export function installMode(): InstallMode {
  if (isStandalone()) return null;
  if (deferred) return "prompt";
  return isIos() ? "ios" : null;
}

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Show the browser's install dialog; true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  changed();
  await e.prompt();
  return (await e.userChoice).outcome === "accepted";
}
