import { describe, expect, test } from "bun:test";
import { AvatarSpec, avatarFromSeed } from "@agent-office/protocol";
import { AVATAR_JSON_SCHEMA, createAvatarService, type FetchLike } from "../../src/core/genui.ts";
import { MemoryStore } from "../../src/core/store.ts";

const GOOD = {
  hairStyle: "curly",
  hairColor: "auburn",
  skinTone: "light",
  glasses: "round",
  facialHair: "none",
  accessory: "headphones",
  deskProps: ["plant", "mug"],
  deskMess: 1,
};
const job = {
  personId: "anna",
  name: "Anna",
  selfDescription: "curly red hair, round glasses",
  key: "k1",
};

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };
function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const call = { url, init, body: JSON.parse(String(init.body)) };
    calls.push(call);
    return respond(call);
  };
  return { f, calls };
}

const anthropicOk = (input: unknown) =>
  Response.json({
    content: [{ type: "tool_use", id: "t1", name: "set_avatar", input }],
    usage: { input_tokens: 512, output_tokens: 64 },
  });
const gatewayOk = (obj: unknown) =>
  Response.json({
    choices: [{ message: { content: JSON.stringify(obj) } }],
    usage: { prompt_tokens: 300, completion_tokens: 50 },
  });

describe("genui", () => {
  test("off: seeded look, no fetch, no cap usage", async () => {
    const { f, calls } = mockFetch(() => anthropicOk(GOOD));
    const store = new MemoryStore();
    const svc = createAvatarService({}, store, { fetch: f });
    const r = await svc.resolve(job);
    expect(r).toEqual({ avatar: avatarFromSeed("anna"), key: "k1", source: "seed" });
    expect(calls).toHaveLength(0);
    expect(svc.callsToday()).toBe(0);
    expect(svc.cacheKey("Anna", "x")).toStartWith("off:");
  });

  test("anthropic: forced tool use with catalog schema, parsed and validated", async () => {
    const { f, calls } = mockFetch(() => anthropicOk(GOOD));
    const lines: string[] = [];
    const svc = createAvatarService(
      { GENUI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" },
      new MemoryStore(),
      { fetch: f, log: (l) => lines.push(l) },
    );
    const r = await svc.resolve(job);
    expect(r.source).toBe("ai");
    expect(r.key).toBe("k1");
    expect(r.avatar).toEqual(AvatarSpec.parse(GOOD));
    const c = calls[0]!;
    expect(c.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = c.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(c.body.model).toBe("claude-haiku-4-5");
    expect(c.body.tool_choice).toEqual({ type: "tool", name: "set_avatar" });
    expect((c.body.tools as { input_schema: unknown }[])[0]!.input_schema).toEqual(
      JSON.parse(JSON.stringify(AVATAR_JSON_SCHEMA)),
    );
    expect(JSON.stringify(c.body.messages)).toContain("curly red hair");
    expect(String(c.body.system)).toContain("devil-horns");
    expect(String(c.body.system)).toContain(
      "only when the person's self-description explicitly requests them",
    );
    expect(String(c.body.system)).toContain("otherwise choose an ordinary accessory");
    expect(lines.some((l) => l.includes("tokens in=512 out=64"))).toBe(true);
    expect(svc.callsToday()).toBe(1);
  });

  test("GENUI_MODEL overrides the model", async () => {
    const { f, calls } = mockFetch(() => anthropicOk(GOOD));
    const svc = createAvatarService(
      { GENUI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", GENUI_MODEL: "claude-haiku-5-5" },
      new MemoryStore(),
      { fetch: f },
    );
    await svc.resolve(job);
    expect(calls[0]!.body.model).toBe("claude-haiku-5-5");
  });

  test("invalid model output -> seeded fallback with retry key", async () => {
    const { f } = mockFetch(() => anthropicOk({ ...GOOD, hairStyle: "afro-unicorn" }));
    const svc = createAvatarService(
      { GENUI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" },
      new MemoryStore(),
      {
        fetch: f,
      },
    );
    const r = await svc.resolve(job);
    expect(r).toEqual({ avatar: avatarFromSeed("anna"), key: "k1:fallback", source: "fallback" });
  });

  test("HTTP error / network error / missing tool block -> fallback", async () => {
    for (const respond of [
      () => new Response("overloaded", { status: 529 }),
      () => {
        throw new Error("ECONNRESET");
      },
      () => Response.json({ content: [{ type: "text", text: "hi" }] }),
    ]) {
      const { f } = mockFetch(respond);
      const svc = createAvatarService(
        { GENUI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" },
        new MemoryStore(),
        {
          fetch: f,
        },
      );
      const r = await svc.resolve(job);
      expect(r.source).toBe("fallback");
      expect(r.avatar).toEqual(avatarFromSeed("anna"));
    }
  });

  test("daily cap enforced and resets the next day", async () => {
    const { f, calls } = mockFetch(() => anthropicOk(GOOD));
    let now = Date.UTC(2026, 10, 10, 12);
    const svc = createAvatarService(
      { GENUI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", GENUI_MAX_CALLS_PER_DAY: "2" },
      new MemoryStore(),
      { fetch: f, now: () => now },
    );
    expect((await svc.resolve(job)).source).toBe("ai");
    expect((await svc.resolve(job)).source).toBe("ai");
    expect((await svc.resolve(job)).source).toBe("fallback");
    expect(calls).toHaveLength(2);
    now += 24 * 3_600_000;
    expect((await svc.resolve(job)).source).toBe("ai");
  });

  test("missing key or unknown provider -> off", async () => {
    expect(createAvatarService({ GENUI_PROVIDER: "anthropic" }, new MemoryStore()).providerId).toBe(
      "off",
    );
    expect(createAvatarService({ GENUI_PROVIDER: "jev" }, new MemoryStore()).providerId).toBe(
      "off",
    );
    expect(createAvatarService({ GENUI_PROVIDER: "gpt9" }, new MemoryStore()).providerId).toBe(
      "off",
    );
  });

  test("jev: Vercel AI Gateway chat completions with json_schema", async () => {
    const { f, calls } = mockFetch(() => gatewayOk(GOOD));
    const svc = createAvatarService(
      { GENUI_PROVIDER: "jev", AI_GATEWAY_API_KEY: "gw" },
      new MemoryStore(),
      {
        fetch: f,
      },
    );
    const r = await svc.resolve(job);
    expect(r.source).toBe("ai");
    expect(r.avatar).toEqual(AvatarSpec.parse(GOOD));
    const c = calls[0]!;
    expect(c.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect((c.init.headers as Record<string, string>).authorization).toBe("Bearer gw");
    expect((c.body.response_format as { type: string }).type).toBe("json_schema");
    expect(svc.cacheKey("Anna", "x")).toStartWith("jev:");
  });

  test("jev: fenced JSON is tolerated, non-JSON falls back", async () => {
    const fenced = mockFetch(() =>
      Response.json({
        choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\`` } }],
      }),
    );
    const svc1 = createAvatarService(
      { GENUI_PROVIDER: "jev", AI_GATEWAY_API_KEY: "gw" },
      new MemoryStore(),
      {
        fetch: fenced.f,
      },
    );
    expect((await svc1.resolve(job)).source).toBe("ai");
    const junk = mockFetch(() =>
      Response.json({ choices: [{ message: { content: "sure! here you go" } }] }),
    );
    const svc2 = createAvatarService(
      { GENUI_PROVIDER: "jev", AI_GATEWAY_API_KEY: "gw" },
      new MemoryStore(),
      {
        fetch: junk.f,
      },
    );
    expect((await svc2.resolve(job)).source).toBe("fallback");
  });
});
