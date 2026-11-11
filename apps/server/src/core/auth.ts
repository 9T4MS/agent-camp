/**
 * Viewer password gate, shared by the Worker entry and the Bun dev server. The office, its
 * pages and every /api route need a session cookie (or `Authorization: Bearer <password>`);
 * the connector socket, /healthz, /install.sh and the login page itself stay open.
 * The password is CONNECTOR_PASSWORD. Runtime-agnostic (Web Crypto only).
 */
import { type AppEnv, connectorPassword } from "./app.ts";

export const SESSION_COOKIE = "ao_session";
/** "This browser is <personId>": proven with a code sent to that person's Macs. */
export const ME_COOKIE = "ao_me";
export const ME_TTL_MS = 365 * 86_400_000;
export const SESSION_TTL_MS = 30 * 86_400_000;
export const LOGIN_PATH = "/login";

const PUBLIC_EXACT = new Set([
  "/ws/connector",
  "/healthz",
  "/install.sh",
  LOGIN_PATH,
  "/api/login",
  "/api/logout",
  "/manifest.webmanifest",
  "/manifest-kiosk.webmanifest",
  // the installed app's service worker; it holds no office data, and its update check must
  // not bounce to the login page once a session has expired
  "/sw.js",
  "/favicon.ico",
]);
const PUBLIC_PREFIX = ["/fonts/", "/icons/"];

export function isPublicPath(path: string): boolean {
  return PUBLIC_EXACT.has(path) || PUBLIC_PREFIX.some((p) => path.startsWith(p));
}

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a: string, b: string): boolean {
  let bits = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    bits |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return bits === 0;
}

// the password is the HMAC key, so changing it logs everyone out
async function sign(password: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`agent-office-viewer:${password}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}

export async function makeSessionToken(password: string, now: number): Promise<string> {
  const exp = String(now + SESSION_TTL_MS);
  return `${exp}.${await sign(password, exp)}`;
}

export async function verifySessionToken(
  password: string,
  token: string,
  now: number,
): Promise<boolean> {
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !(Number(exp) > now)) return false;
  return safeEqual(sig, await sign(password, exp));
}

/** Signed `<personId>.<exp>.<sig>` for the ME_COOKIE. */
export async function makeMeToken(password: string, personId: string, now: number) {
  const exp = String(now + ME_TTL_MS);
  return `${personId}.${exp}.${await sign(password, `me:${personId}:${exp}`)}`;
}

/** The person this browser proved to be (ME_COOKIE), or null. */
export async function meFromRequest(
  req: Request,
  env: AppEnv,
  now = Date.now(),
): Promise<string | null> {
  const pw = connectorPassword(env);
  const token = cookieValue(req, ME_COOKIE);
  if (!pw || !token) return null;
  const [personId, exp, sig] = token.split(".");
  if (!personId || !exp || !sig || !(Number(exp) > now)) return null;
  return safeEqual(sig, await sign(pw, `me:${personId}:${exp}`)) ? personId : null;
}

/** Set-Cookie for ME_COOKIE (empty value + 0 = forget). */
export function meCookie(req: Request, value: string, maxAgeS: number): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${ME_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`;
}

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function isAuthorized(req: Request, env: AppEnv, now = Date.now()): Promise<boolean> {
  const pw = connectorPassword(env);
  if (!pw) return false;
  const auth = req.headers.get("authorization");
  if (auth && safeEqual(auth, `Bearer ${pw}`)) return true;
  const key = new URL(req.url).searchParams.get("key");
  if (env.VIEWER_KEY && key && safeEqual(key, env.VIEWER_KEY)) return true;
  const token = cookieValue(req, SESSION_COOKIE);
  return !!token && (await verifySessionToken(pw, token, now));
}

/** A session cookie with less than this left is renewed on the next page load. */
export const SESSION_RENEW_BELOW_MS = 15 * 86_400_000;

/**
 * Sliding session: when a page is loaded with a valid cookie that runs out within 15 days,
 * returns a fresh Set-Cookie header, so an installed app that is opened now and then never
 * lands on the login page. Null otherwise (no cookie, bearer/key auth, plenty of time left).
 */
export async function renewedSessionCookie(
  req: Request,
  env: AppEnv,
  now = Date.now(),
): Promise<string | null> {
  const pw = connectorPassword(env);
  if (!pw || req.method.toUpperCase() !== "GET") return null;
  if (!(req.headers.get("accept") ?? "").includes("text/html")) return null;
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token || !(await verifySessionToken(pw, token, now))) return null;
  if (Number(token.split(".")[0]) - now >= SESSION_RENEW_BELOW_MS) return null;
  return sessionCookie(req, await makeSessionToken(pw, now), SESSION_TTL_MS / 1000);
}

/** Adds a renewed session cookie (see renewedSessionCookie) to a page response. */
export async function withRenewedSession(
  req: Request,
  env: AppEnv,
  res: Response,
  now = Date.now(),
): Promise<Response> {
  const cookie = await renewedSessionCookie(req, env, now);
  if (!cookie) return res;
  const out = new Response(res.body, res);
  out.headers.append("set-cookie", cookie);
  return out;
}

/** Only same-site relative paths, so `next` can't bounce the user elsewhere. */
export function safeNext(next: string | null): string {
  return next?.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

function sessionCookie(req: Request, value: string, maxAgeS: number): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`;
}

const redirect = (to: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location: to, ...headers } });

/**
 * Returns the response to send instead of the requested resource (login page, login/logout
 * result, 401, redirect), or null when the request may go through.
 */
export async function gate(req: Request, env: AppEnv, now = Date.now()): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();
  const pw = connectorPassword(env);

  if (path === "/api/login" && method === "POST") {
    let password = "";
    let next = "/";
    try {
      const form = await req.formData();
      password = String(form.get("password") ?? "");
      next = safeNext(String(form.get("next") ?? "/"));
    } catch {
      // empty or malformed body: treated as a wrong password
    }
    if (!pw || !safeEqual(password, pw)) {
      // slows down guessing a little; Workers have no shared memory for a real limiter
      await new Promise((r) => setTimeout(r, 400));
      return redirect(`${LOGIN_PATH}?error=1&next=${encodeURIComponent(next)}`);
    }
    const token = await makeSessionToken(pw, now);
    return redirect(next, { "set-cookie": sessionCookie(req, token, SESSION_TTL_MS / 1000) });
  }

  if (path === "/api/logout" && method === "POST") {
    const out = redirect(LOGIN_PATH, { "set-cookie": sessionCookie(req, "", 0) });
    // a shared device that logs out also forgets who it was
    out.headers.append("set-cookie", meCookie(req, "", 0));
    return out;
  }

  if (path === LOGIN_PATH && method === "GET") {
    if (await isAuthorized(req, env, now)) return redirect(safeNext(url.searchParams.get("next")));
    return loginPage(url.searchParams.has("error"), safeNext(url.searchParams.get("next")), !pw);
  }

  if (isPublicPath(path) || (await isAuthorized(req, env, now))) return null;

  const wantsPage =
    method === "GET" &&
    !path.startsWith("/api/") &&
    !path.startsWith("/ws/") &&
    (req.headers.get("accept") ?? "").includes("text/html");
  if (wantsPage) return redirect(`${LOGIN_PATH}?next=${encodeURIComponent(path + url.search)}`);
  return new Response(JSON.stringify({ error: "login required" }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const escAttr = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(error: boolean, next: string, unconfigured: boolean): Response {
  const msg = unconfigured
    ? "This server has no CONNECTOR_PASSWORD set yet."
    : error
      ? "Wrong password, try again."
      : "Ask whoever runs the office for the password.";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#181425">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Agent Office">
<title>Agent Office</title>
<link rel="icon" href="/icons/icon-192.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<style>
@font-face{font-family:"Silkscreen";src:url("/fonts/silkscreen-latin.woff2") format("woff2");font-display:swap}
@font-face{font-family:"Pixelify Sans";src:url("/fonts/pixelify-sans-latin.woff2") format("woff2");font-weight:400 700;font-display:swap}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:#193c3e;color:#ead4aa;font:16px/1.4 "Pixelify Sans",system-ui,sans-serif;display:grid;place-items:center;padding:16px;
background-image:linear-gradient(45deg,#1d4446 25%,transparent 25%,transparent 75%,#1d4446 75%),linear-gradient(45deg,#1d4446 25%,transparent 25%,transparent 75%,#1d4446 75%);
background-size:32px 32px;background-position:0 0,16px 16px}
.box{width:100%;max-width:340px;background:#262b44;border:4px solid #181425;box-shadow:inset 0 0 0 2px #3a4466,6px 6px 0 #181425;padding:24px;text-align:center}
img{image-rendering:pixelated;display:block;margin:0 auto 12px}
h1{font:400 20px "Silkscreen",monospace;margin:0 0 6px;color:#fee761;letter-spacing:1px}
p{margin:0 0 18px;color:${error ? "#f6757a" : "#c0cbdc"};font-size:15px}
input,button{width:100%;font:inherit;padding:10px 12px;border:3px solid #181425}
input{background:#ead4aa;color:#181425;margin-bottom:12px;outline:none}
input:focus{box-shadow:0 0 0 3px #feae34}
button{background:#be4a2f;color:#fff;cursor:pointer;font-family:"Silkscreen",monospace;box-shadow:inset -3px -3px 0 #733e39}
button:hover{background:#d77643}
button:active{box-shadow:inset 3px 3px 0 #733e39}
</style>
</head>
<body>
<form class="box" method="post" action="/api/login">
<img src="/icons/icon-192.png" alt="" width="64" height="64">
<h1>Agent Office</h1>
<p>${msg}</p>
<input type="hidden" name="next" value="${escAttr(next)}">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required autofocus>
<button type="submit">Come in</button>
</form>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
