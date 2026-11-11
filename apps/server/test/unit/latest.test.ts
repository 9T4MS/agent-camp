import { describe, expect, test } from "bun:test";
import { envelope } from "@agent-office/protocol";
import { OfficeApp, serverVersion } from "../../src/core/app.ts";
import {
  cleanTag,
  isAutoVersion,
  LATEST_TTL_MS,
  LatestVersion,
  UNKNOWN_VERSION,
} from "../../src/core/latest.ts";
import { MemoryStore } from "../../src/core/store.ts";

type Call = { url: string; init: RequestInit };

/** Fake GitHub: `tag` (or a thrower) per call, records what was asked. */
function fakeGithub(answer: () => string | Error | number) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answer();
    if (a instanceof Error) throw a;
    if (url.startsWith("https://api.github.com/")) {
      if (typeof a === "number") return new Response("rate limited", { status: a });
      return Response.json({ tag_name: a });
    }
    // redirect fallback
    if (typeof a === "number") return new Response(null, { status: 404 });
    return new Response(null, {
      status: 302,
      headers: { location: `https://github.com/o/r/releases/tag/${a}` },
    });
  };
  return { calls, fetch };
}

const hello = (clientId: string) =>
  JSON.stringify(
    envelope("connector.hello", {
      name: "Anna",
      password: "pw",
      clientId,
      connectorVersion: "0.1.1",
    }),
  );

describe("latest connector version", () => {
  test("auto values and tag cleaning", () => {
    for (const v of [undefined, "", " auto ", "auto", "0.0.0-dev"])
      expect(isAutoVersion(v)).toBe(true);
    expect(isAutoVersion("0.1.7")).toBe(false);
    expect(cleanTag("v0.1.42")).toBe("0.1.42");
    expect(cleanTag("0.2.0")).toBe("0.2.0");
    expect(cleanTag("nightly")).toBeNull();
    expect(cleanTag(7)).toBeNull();
  });

  test("a fixed version never touches the network", () => {
    const gh = fakeGithub(() => "v9.9.9");
    const l = new LatestVersion("0.1.7", { store: new MemoryStore(), fetch: gh.fetch });
    expect(l.current).toBe("0.1.7");
    expect(l.refreshIfStale()).toBeNull();
    expect(gh.calls).toHaveLength(0);
  });

  test("fetches, strips v, sends a User-Agent, caches 5 min in memory and storage", async () => {
    let now = 1_000_000;
    let tag = "v0.1.5";
    const gh = fakeGithub(() => tag);
    const store = new MemoryStore();
    const l = new LatestVersion("auto", {
      store,
      fetch: gh.fetch,
      now: () => now,
      repo: "o/r",
    });
    expect(l.current).toBe(UNKNOWN_VERSION);
    expect(await l.refreshIfStale()).toBe("0.1.5");
    expect(l.current).toBe("0.1.5");
    expect(gh.calls[0]?.url).toBe("https://api.github.com/repos/o/r/releases/latest");
    expect((gh.calls[0]?.init.headers as Record<string, string>)["user-agent"]).toBe(
      "agent-office-server",
    );

    tag = "v0.1.6";
    now += LATEST_TTL_MS - 1;
    expect(l.refreshIfStale()).toBeNull(); // still fresh
    now += 1;
    expect(await l.refreshIfStale()).toBe("0.1.6");
    expect(gh.calls).toHaveLength(2);

    // a restarted object starts from storage, and it is still fresh there
    const again = new LatestVersion("auto", { store, fetch: gh.fetch, now: () => now });
    expect(again.current).toBe("0.1.6");
    expect(again.refreshIfStale()).toBeNull();
  });

  test("one lookup at a time", async () => {
    const gh = fakeGithub(() => "v1.2.3");
    const l = new LatestVersion(undefined, { store: new MemoryStore(), fetch: gh.fetch });
    const p = l.refreshIfStale();
    expect(p).not.toBeNull();
    expect(l.refreshIfStale()).toBeNull();
    await p;
    expect(gh.calls).toHaveLength(1);
  });

  test("API rate limited -> /releases/latest redirect", async () => {
    let first = true;
    const gh = fakeGithub(() => {
      if (first) {
        first = false;
        return 403;
      }
      return "v0.3.1";
    });
    const l = new LatestVersion("auto", { store: new MemoryStore(), fetch: gh.fetch });
    expect(await l.refreshIfStale()).toBe("0.3.1");
    expect(gh.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/MrGatzi/agent-camp/releases/latest",
      "https://github.com/MrGatzi/agent-camp/releases/latest",
    ]);
  });

  test("failures keep the last known value and are throttled too", async () => {
    let now = 0;
    let answer: string | Error = "v0.1.9";
    const gh = fakeGithub(() => answer);
    const store = new MemoryStore();
    const l = new LatestVersion("auto", { store, fetch: gh.fetch, now: () => now });
    await l.refreshIfStale();
    answer = new Error("network down");
    now += LATEST_TTL_MS;
    expect(await l.refreshIfStale()).toBe("0.1.9");
    expect(l.current).toBe("0.1.9");
    const calls = gh.calls.length;
    now += 1000;
    expect(l.refreshIfStale()).toBeNull(); // no hammering after a failure
    expect(gh.calls).toHaveLength(calls);
  });

  test("corrupt storage starts unknown", () => {
    const store = new MemoryStore();
    store.kvPut("latest.connector", "{nope");
    expect(new LatestVersion("auto", { store }).current).toBe(UNKNOWN_VERSION);
  });

  test("OfficeApp: hello triggers the lookup, later welcomes announce it", async () => {
    const gh = fakeGithub(() => "v0.1.40");
    const pending: Promise<unknown>[] = [];
    const app = new OfficeApp(
      { CONNECTOR_PASSWORD: "pw", LATEST_CONNECTOR_VERSION: "auto", GITHUB_REPO: "o/r" },
      new MemoryStore(),
      { broadcast: () => {}, scheduleAlarm: () => {}, waitUntil: (p) => pending.push(p) },
      { log: () => {}, fetch: gh.fetch },
    );
    const first = app.connectorMessage("s1", hello("c1"));
    // the first welcome is never delayed: it carries the last known value
    expect(first.reply?.type).toBe("connector.welcomed");
    expect((first.reply?.data as { latestConnectorVersion: string }).latestConnectorVersion).toBe(
      UNKNOWN_VERSION,
    );
    await Promise.all(pending);
    const second = app.connectorMessage("s2", hello("c2"));
    expect((second.reply?.data as { latestConnectorVersion: string }).latestConnectorVersion).toBe(
      "0.1.40",
    );
    expect(gh.calls.filter((c) => c.url.includes("/o/r/"))).toHaveLength(1); // cached
  });

  test("OfficeApp: GitHub down never breaks a welcome", async () => {
    const pending: Promise<unknown>[] = [];
    const app = new OfficeApp(
      { CONNECTOR_PASSWORD: "pw" },
      new MemoryStore(),
      { broadcast: () => {}, scheduleAlarm: () => {}, waitUntil: (p) => pending.push(p) },
      {
        log: () => {},
        fetch: async () => {
          throw new Error("offline");
        },
      },
    );
    expect(app.connectorMessage("s1", hello("c1")).reply?.type).toBe("connector.welcomed");
    await Promise.all(pending);
    expect(app.connectorMessage("s2", hello("c2")).reply?.type).toBe("connector.welcomed");
  });

  test("DEV_MODE never looks anything up", async () => {
    let called = false;
    const pending: Promise<unknown>[] = [];
    const app = new OfficeApp(
      { DEV_MODE: "1" },
      new MemoryStore(),
      { broadcast: () => {}, scheduleAlarm: () => {}, waitUntil: (p) => pending.push(p) },
      {
        log: () => {},
        fetch: async () => {
          called = true;
          return new Response("{}");
        },
      },
    );
    app.connectorMessage(
      "s1",
      JSON.stringify(
        envelope("connector.hello", {
          name: "A",
          password: "devpass",
          clientId: "c",
          connectorVersion: "1.0.0",
        }),
      ),
    );
    await Promise.all(pending); // only the avatar job
    expect(called).toBe(false);
  });

  test("serverVersion", () => {
    expect(serverVersion({ SERVER_VERSION: "0.1.3" })).toBe("0.1.3");
    expect(serverVersion({ LATEST_CONNECTOR_VERSION: "0.1.2" })).toBe("0.1.2");
    expect(serverVersion({ LATEST_CONNECTOR_VERSION: "auto" })).toBe("dev");
    expect(serverVersion({})).toBe("dev");
  });
});
