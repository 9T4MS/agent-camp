import { describe, expect, test } from "bun:test";
import {
  gate,
  isAuthorized,
  makeSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  safeNext,
  verifySessionToken,
} from "../../src/core/auth.ts";

const ENV = { CONNECTOR_PASSWORD: "pw" };
const NOW = 1_800_000_000_000;
const html = { accept: "text/html,application/xhtml+xml" };
const req = (path: string, init?: RequestInit) => new Request(`https://office.test${path}`, init);

async function login(password: string, next = "/stats") {
  const body = new URLSearchParams({ password, next });
  return gate(req("/api/login", { method: "POST", body }), ENV, NOW);
}

describe("viewer gate", () => {
  test("pages redirect to the login page, API and viewer socket get 401", async () => {
    const page = await gate(req("/stats?days=7", { headers: html }), ENV, NOW);
    expect(page?.status).toBe(303);
    expect(page?.headers.get("location")).toBe("/login?next=%2Fstats%3Fdays%3D7");
    for (const path of ["/api/state", "/api/history.csv", "/ws/viewer", "/assets/index.js"]) {
      expect((await gate(req(path), ENV, NOW))?.status).toBe(401);
    }
  });

  test("connector socket, health, installer, login assets stay public", async () => {
    for (const path of [
      "/ws/connector",
      "/healthz",
      "/install.sh",
      "/fonts/a.woff2",
      "/icons/x.png",
    ])
      expect(await gate(req(path), ENV, NOW)).toBeNull();
    const page = await gate(req("/login"), ENV, NOW);
    expect(page?.status).toBe(200);
    expect(await page!.text()).toContain('name="password"');
  });

  test("right password sets a cookie that opens everything", async () => {
    const res = await login("pw");
    expect(res?.status).toBe(303);
    expect(res?.headers.get("location")).toBe("/stats");
    const cookie = res!.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    const value = cookie.split(";")[0]!;
    const headers = { cookie: `other=1; ${value}` };
    expect(await gate(req("/api/state", { headers }), ENV, NOW)).toBeNull();
    expect(await gate(req("/", { headers: { ...headers, ...html } }), ENV, NOW)).toBeNull();
  });

  test("wrong password goes back to the login page with an error", async () => {
    const res = await login("nope");
    expect(res?.headers.get("location")).toBe("/login?error=1&next=%2Fstats");
    expect(res?.headers.get("set-cookie")).toBeNull();
  });

  test("tokens expire, and changing the password invalidates them", async () => {
    const token = await makeSessionToken("pw", NOW);
    expect(await verifySessionToken("pw", token, NOW + SESSION_TTL_MS - 1)).toBe(true);
    expect(await verifySessionToken("pw", token, NOW + SESSION_TTL_MS)).toBe(false);
    expect(await verifySessionToken("new", token, NOW)).toBe(false);
    expect(await verifySessionToken("pw", `${NOW + 1e9}.${token.split(".")[1]}`, NOW)).toBe(false);
  });

  test("bearer password and legacy VIEWER_KEY also work", async () => {
    const env = { ...ENV, VIEWER_KEY: "k" };
    const bearer = req("/api/state", { headers: { authorization: "Bearer pw" } });
    expect(await isAuthorized(bearer, env, NOW)).toBe(true);
    expect(await isAuthorized(req("/ws/viewer?key=k"), env, NOW)).toBe(true);
    expect(await isAuthorized(req("/ws/viewer?key=x"), env, NOW)).toBe(false);
    expect(await isAuthorized(req("/ws/viewer?key=k"), ENV, NOW)).toBe(false);
  });

  test("no password configured: nobody gets in", async () => {
    expect(
      await isAuthorized(req("/api/state", { headers: { authorization: "Bearer " } }), {}, NOW),
    ).toBe(false);
    const page = await gate(req("/login"), {}, NOW);
    expect(await page!.text()).toContain("no CONNECTOR_PASSWORD");
  });

  test("logout clears the cookie", async () => {
    const res = await gate(req("/api/logout", { method: "POST" }), ENV, NOW);
    expect(res?.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=;`);
    expect(res?.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("next only allows same-site paths", () => {
    expect(safeNext("/stats?days=7")).toBe("/stats?days=7");
    expect(safeNext("//evil.test")).toBe("/");
    expect(safeNext("https://evil.test")).toBe("/");
    expect(safeNext("/\\evil.test")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
});
