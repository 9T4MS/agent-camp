/*
 * Agent Office service worker (installed app). Keeps the app shell and its static files so
 * the office opens instantly and still opens offline; the live data comes over the viewer
 * WebSocket as always.
 *   pages (/, /stats, /timelapse): network first, the cached copy when offline
 *   /assets/* (hashed, immutable): cache first
 *   /fonts/*, /icons/*: cached, refreshed in the background
 *   /api/*, /ws/*, the login and everything else: straight to the network, never cached
 */
const SHELL = "ao-shell-v1";
const STATIC = "ao-static-v1";
const KEEP = [SHELL, STATIC];
const PAGES = new Set([
  "/",
  "/index.html",
  "/stats",
  "/stats.html",
  "/timelapse",
  "/timelapse.html",
]);
const MAX_STATIC = 80;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (!KEEP.includes(name)) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

const pageKey = (url) => {
  const p = url.pathname.replace(/\.html$/, "").replace(/^\/index$/, "/");
  return new URL(p, url.origin).href;
};

async function page(request, url) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    // only real pages: not the login redirect, not an error
    if (res.ok && res.type === "basic" && !res.redirected) {
      await cache.put(pageKey(url), res.clone());
    }
    return res;
  } catch {
    const hit = (await cache.match(pageKey(url))) ?? (await cache.match(new URL("/", url).href));
    return (
      hit ??
      new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Office</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#181425;color:#ead4aa;font:16px system-ui,sans-serif;text-align:center"><div><p style="font-size:40px;margin:0">&#9632;</p><p>The office is offline.<br>It comes back when you have a connection.</p><p><a style="color:#feae34" href="/">Try again</a></p></div>',
        { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
      )
    );
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_STATIC))) await cache.delete(k);
}

async function staticFile(event, request, immutable) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then(async (res) => {
      if (res.ok && res.type === "basic") {
        await cache.put(request, res.clone());
        await trim(cache);
      }
      return res;
    })
    .catch(() => null);
  if (hit) {
    if (!immutable) event.waitUntil(refresh);
    return hit;
  }
  return (await refresh) ?? Response.error();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // the query (?kiosk=1, ?key=…) never changes the HTML, so pages are cached by path only
  if (request.mode === "navigate") {
    if (PAGES.has(url.pathname)) event.respondWith(page(request, url));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(staticFile(event, request, true));
  } else if (url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(staticFile(event, request, false));
  }
});
