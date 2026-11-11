import { describe, expect, test } from "bun:test";
import {
  type AvatarSpec,
  avatarFromSeed,
  lookFromCatalog,
  MAX_SELF_DESCRIPTION,
} from "@agent-office/protocol";
import { LOOK_FIXTURES } from "@agent-office/protocol/fixtures";
import {
  AI_AVATAR_SCHEMA,
  createAvatarService,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MAX_CALLS_PER_DAY,
  FALLBACK_BETA,
  type FetchLike,
  GENUI_MAX_TOKENS,
  GENUI_MAX_TOKENS_NO_THINKING,
  MAX_CONCURRENT,
  SYSTEM_PROMPT,
  sanitizeSchema,
} from "../../src/core/genui.ts";
import { MemoryStore } from "../../src/core/store.ts";

const TRACHT = LOOK_FIXTURES.tracht;
const PREVIOUS: AvatarSpec = avatarFromSeed("someone-else");
const job = {
  personId: "anna",
  name: "Anna",
  selfDescription: "slicked-back brown hair, tortoiseshell glasses, Janker and lederhosen",
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

/** Structured-outputs reply as Opus 5.5 sends it: (empty) thinking block, then the JSON as text. */
const anthropicOk = (obj: unknown, extra: Record<string, unknown> = {}) =>
  Response.json({
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "", signature: "x" },
      { type: "text", text: JSON.stringify(obj) },
    ],
    usage: { input_tokens: 4096, output_tokens: 2048 },
    ...extra,
  });
const gatewayOk = (obj: unknown) =>
  Response.json({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(obj) } }],
    usage: { prompt_tokens: 3000, completion_tokens: 1500 },
  });

const anthropic = (env: Record<string, string> = {}) => ({
  GENUI_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "sk-test",
  ...env,
});

/** Tiny validator for the sanitized schema subset (type/enum/properties/required/items). */
function conforms(schema: Record<string, unknown>, v: unknown, path = "$"): string[] {
  const errs: string[] = [];
  const t = schema.type;
  if (Array.isArray(schema.enum) && !schema.enum.includes(v)) errs.push(`${path}: not in enum`);
  if (t === "object") {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return [`${path}: not object`];
    const props = schema.properties as Record<string, Record<string, unknown>>;
    for (const k of schema.required as string[]) if (!(k in v)) errs.push(`${path}.${k}: missing`);
    for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
      if (!props[k]) errs.push(`${path}.${k}: extra`);
      else errs.push(...conforms(props[k], sub, `${path}.${k}`));
    }
  } else if (t === "array") {
    if (!Array.isArray(v)) return [`${path}: not array`];
    v.forEach((x, i) => {
      errs.push(...conforms(schema.items as Record<string, unknown>, x, `${path}[${i}]`));
    });
  } else if (t === "string" && typeof v !== "string") errs.push(`${path}: not string`);
  else if ((t === "number" || t === "integer") && typeof v !== "number")
    errs.push(`${path}: not number`);
  else if (t === "boolean" && typeof v !== "boolean") errs.push(`${path}: not boolean`);
  return errs;
}

/** Every schema node (not property-name maps), with its path. */
function schemaNodes(s: Record<string, unknown>, path = "$"): [string, Record<string, unknown>][] {
  const out: [string, Record<string, unknown>][] = [[path, s]];
  for (const [k, sub] of Object.entries((s.properties ?? {}) as Record<string, never>))
    out.push(...schemaNodes(sub, `${path}.${k}`));
  if (s.items) out.push(...schemaNodes(s.items as Record<string, unknown>, `${path}[]`));
  for (const b of (s.anyOf ?? []) as Record<string, unknown>[]) out.push(...schemaNodes(b, path));
  return out;
}

describe("genui: schema", () => {
  test("sanitized for structured outputs / strict mode", () => {
    const nodes = schemaNodes(AI_AVATAR_SCHEMA);
    expect(nodes.length).toBeGreaterThan(100);
    const banned = [
      "$schema",
      "pattern",
      "format",
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "uniqueItems",
      "const",
      "anyOf",
      "oneOf",
    ];
    for (const [path, n] of nodes) {
      for (const k of banned) if (k in n) throw new Error(`${path} has ${k}`);
      expect(typeof n.type).toBe("string");
      if (n.type === "object") {
        expect(n.additionalProperties).toBe(false);
        expect(n.required).toEqual(Object.keys(n.properties as object));
      }
    }
    // fields named like keywords survive; describe() hints flow through
    // biome-ignore lint/suspicious/noExplicitAny: walking a plain JSON schema
    const look = (AI_AVATAR_SCHEMA as any).properties.look;
    expect(Object.keys(look.properties.shirt.properties)).toContain("pattern");
    expect(JSON.stringify(look)).toContain("agent");
    expect(AI_AVATAR_SCHEMA.required).toEqual([
      "hairStyle",
      "hairColor",
      "skinTone",
      "glasses",
      "facialHair",
      "accessory",
      "outfit",
      "leftHand",
      "rightHand",
      "wrist",
      "accentColor",
      "vehicle",
      "deskProps",
      "deskMess",
      "look",
    ]);
  });

  test("the hand-authored fixture fits the schema exactly", () => {
    expect(conforms(AI_AVATAR_SCHEMA, TRACHT)).toEqual([]);
    expect(conforms(AI_AVATAR_SCHEMA, { ...TRACHT, extra: 1 })).toEqual(["$.extra: extra"]);
  });

  test("unions collapse: literal unions -> enum, hex-or-none -> string", () => {
    expect(
      sanitizeSchema({
        anyOf: [
          { type: "number", const: 0 },
          { type: "number", const: 1 },
        ],
      }),
    ).toEqual({ type: "number", enum: [0, 1] });
    expect(
      sanitizeSchema({
        description: "hex or none",
        anyOf: [
          { type: "string", pattern: "^#" },
          { type: "string", const: "none" },
        ],
      }),
    ).toEqual({ type: "string", description: "hex or none" });
  });
});

describe("genui: anthropic", () => {
  test("structured outputs request on the default Haiku 4.5; the fixture is the stored look", async () => {
    const { f, calls } = mockFetch(() => anthropicOk(TRACHT));
    const lines: string[] = [];
    const store = new MemoryStore();
    const svc = createAvatarService(anthropic(), store, { fetch: f, log: (l) => lines.push(l) });
    const r = await svc.resolve(job);
    expect(r).toEqual({ avatar: TRACHT, key: "k1", source: "ai" });
    const c = calls[0]!;
    expect(c.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = c.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    // Haiku 4.5: no server-side fallbacks, no effort, no thinking -> a smaller max_tokens
    expect(headers).not.toHaveProperty("anthropic-beta");
    expect(c.init.signal).toBeInstanceOf(AbortSignal);
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-haiku-4-5");
    expect(c.body.model).toBe("claude-haiku-4-5");
    expect(c.body.max_tokens).toBe(GENUI_MAX_TOKENS_NO_THINKING);
    expect(c.body).not.toHaveProperty("fallbacks");
    expect(c.body.output_config).toEqual({
      format: { type: "json_schema", schema: JSON.parse(JSON.stringify(AI_AVATAR_SCHEMA)) },
    });
    // the large, identical system prompt carries the cache breakpoint
    expect(c.body.system).toEqual([
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ]);
    for (const k of ["tool_choice", "tools", "thinking", "temperature"])
      expect(c.body).not.toHaveProperty(k);
    expect(JSON.stringify(c.body.messages)).toContain("tortoiseshell glasses");
    expect(SYSTEM_PROMPT).toContain("devil-horns");
    expect(SYSTEM_PROMPT).toContain(
      "only when the person's self-description explicitly requests them",
    );
    expect(SYSTEM_PROMPT).toContain("otherwise choose an ordinary accessory");
    expect(lines.some((l) => l.includes("tokens in=4096 out=2048"))).toBe(true);
    expect(svc.callsToday()).toBe(1);
  });

  test("GENUI_MODEL=claude-opus-5-5 is the explicit choice: effort, fallbacks, 16k", async () => {
    const { f, calls } = mockFetch(() => anthropicOk(TRACHT));
    const svc = createAvatarService(
      anthropic({ GENUI_MODEL: "claude-opus-5-5" }),
      new MemoryStore(),
      {
        fetch: f,
      },
    );
    expect((await svc.resolve(job)).source).toBe("ai");
    const c = calls[0]!;
    expect((c.init.headers as Record<string, string>)["anthropic-beta"]).toBe(FALLBACK_BETA);
    expect(c.body.model).toBe("claude-opus-5-5");
    expect(c.body.max_tokens).toBe(GENUI_MAX_TOKENS);
    expect(c.body.fallbacks).toBe("default");
    expect(c.body.output_config).toEqual({
      format: { type: "json_schema", schema: JSON.parse(JSON.stringify(AI_AVATAR_SCHEMA)) },
      effort: "low",
    });
    for (const k of ["tool_choice", "tools", "thinking", "temperature"])
      expect(c.body).not.toHaveProperty(k);
  });

  test("GENUI_MODEL: older/smaller models get no fallbacks, pre-effort models no effort", async () => {
    for (const [model, effort, fallbacks] of [
      ["claude-haiku-5-5", true, false],
      ["claude-haiku-4-5", false, false],
      ["claude-sonnet-4-5", false, false],
      ["claude-opus-5-5", true, true],
      ["claude-sonnet-5-5", true, true],
      ["claude-fable-5-2", true, true],
    ] as const) {
      const { f, calls } = mockFetch(() => anthropicOk(TRACHT));
      const svc = createAvatarService(anthropic({ GENUI_MODEL: model }), new MemoryStore(), {
        fetch: f,
      });
      expect((await svc.resolve(job)).source).toBe("ai");
      const c = calls[0]!;
      expect(c.body.model).toBe(model);
      expect("effort" in (c.body.output_config as object)).toBe(effort);
      // no effort = no thinking unless asked, so the JSON alone needs less room
      expect(c.body.max_tokens).toBe(effort ? GENUI_MAX_TOKENS : GENUI_MAX_TOKENS_NO_THINKING);
      expect("fallbacks" in c.body).toBe(fallbacks);
      expect("anthropic-beta" in (c.init.headers as object)).toBe(fallbacks);
    }
  });

  test("a broken section is repaired from the catalog look, bad hex normalized", async () => {
    const broken = {
      ...TRACHT,
      look: {
        ...TRACHT.look,
        vest: "a lovely vest",
        shirt: { ...TRACHT.look.shirt, ramp: { ...TRACHT.look.shirt.ramp, base: "ABC" } },
      },
    };
    const { f } = mockFetch(() => anthropicOk(broken));
    const lines: string[] = [];
    const svc = createAvatarService(anthropic(), new MemoryStore(), {
      fetch: f,
      log: (l) => lines.push(l),
    });
    const r = await svc.resolve(job);
    expect(r.source).toBe("ai");
    expect(r.key).toBe("k1");
    expect(r.avatar.look?.vest).toEqual(lookFromCatalog(TRACHT).vest);
    expect(r.avatar.look?.shirt.ramp.base).toBe("#aabbcc");
    expect(r.avatar.look?.outer).toEqual(TRACHT.look.outer);
    expect(lines.some((l) => l.includes("repaired"))).toBe(true);
  });

  test("unusable output keeps the previous look under a retry key", async () => {
    for (const out of [
      { hairStyle: "afro-unicorn" },
      "nope",
      { ...TRACHT, look: undefined },
      // a look with only `v`/`build` usable is mostly defaults: not an answer
      { ...TRACHT, look: { v: 1, build: "slim", shoes: "white sneakers", hair: "brown" } },
    ]) {
      const { f } = mockFetch(() => anthropicOk(out));
      const svc = createAvatarService(anthropic(), new MemoryStore(), { fetch: f });
      expect(await svc.resolve({ ...job, previous: PREVIOUS })).toEqual({
        avatar: PREVIOUS,
        key: "k1:fallback",
        source: "fallback",
      });
    }
  });

  test("refusal / max_tokens / HTTP / network / no text -> previous ?? seeded, retry key", async () => {
    for (const respond of [
      () =>
        anthropicOk(TRACHT, {
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber" },
        }),
      () => anthropicOk(TRACHT, { stop_reason: "max_tokens" }),
      () => new Response("overloaded", { status: 529 }),
      () => {
        throw new Error("ECONNRESET");
      },
      () => Response.json({ stop_reason: "end_turn", content: [{ type: "thinking" }] }),
      () => Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "{" }] }),
    ]) {
      const { f } = mockFetch(respond);
      const lines: string[] = [];
      const svc = createAvatarService(anthropic(), new MemoryStore(), {
        fetch: f,
        log: (l) => lines.push(l),
      });
      expect(await svc.resolve({ ...job, previous: PREVIOUS })).toEqual({
        avatar: PREVIOUS,
        key: "k1:fallback",
        source: "fallback",
      });
      const r = await svc.resolve(job);
      expect(r).toEqual({ avatar: avatarFromSeed("anna"), key: "k1:fallback", source: "fallback" });
      expect(lines.some((l) => l.includes("error for anna"))).toBe(true);
    }
  });

  test("a server-side fallback answer is used and noted in the log", async () => {
    const { f } = mockFetch(() =>
      anthropicOk(TRACHT, {
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          iterations: [{ type: "message" }, { type: "fallback_message" }],
        },
      }),
    );
    const lines: string[] = [];
    const svc = createAvatarService(
      anthropic({ GENUI_MODEL: "claude-opus-5-5" }),
      new MemoryStore(),
      {
        fetch: f,
        log: (l) => lines.push(l),
      },
    );
    expect((await svc.resolve(job)).source).toBe("ai");
    expect(lines.some((l) => l.includes("served by claude-opus-4-8"))).toBe(true);
  });

  test("an 8000-char description reaches the prompt in full", async () => {
    const long = `${"Tracht from head to toe. ".repeat(400)}`.slice(0, MAX_SELF_DESCRIPTION - 3);
    const desc = `${long}END`;
    expect(desc).toHaveLength(MAX_SELF_DESCRIPTION);
    const { f, calls } = mockFetch(() => anthropicOk(TRACHT));
    const svc = createAvatarService(anthropic(), new MemoryStore(), { fetch: f });
    await svc.resolve({ ...job, selfDescription: `${desc}TOO-LONG` });
    const content = (calls[0]!.body.messages as { content: string }[])[0]!.content;
    expect(content).toContain(desc);
    expect(content).not.toContain("TOO-LONG");
  });

  test("no description: keeps the previous look, no call, no cap usage", async () => {
    const { f, calls } = mockFetch(() => anthropicOk(TRACHT));
    const svc = createAvatarService(anthropic(), new MemoryStore(), { fetch: f });
    const { selfDescription: _d, ...bare } = job;
    expect(await svc.resolve({ ...bare, previous: PREVIOUS })).toEqual({
      avatar: PREVIOUS,
      key: "k1",
      source: "seed",
    });
    expect(await svc.resolve({ ...job, selfDescription: "   " })).toEqual({
      avatar: avatarFromSeed("anna"),
      key: "k1",
      source: "seed",
    });
    expect(calls).toHaveLength(0);
    expect(svc.callsToday()).toBe(0);
  });

  test("daily cap enforced (previous look kept) and resets the next day", async () => {
    const { f, calls } = mockFetch(() => anthropicOk(TRACHT));
    let now = Date.UTC(2026, 10, 10, 12);
    const svc = createAvatarService(
      anthropic({ GENUI_MAX_CALLS_PER_DAY: "2" }),
      new MemoryStore(),
      { fetch: f, now: () => now },
    );
    expect((await svc.resolve(job)).source).toBe("ai");
    expect((await svc.resolve(job)).source).toBe("ai");
    expect(await svc.resolve({ ...job, previous: PREVIOUS })).toEqual({
      avatar: PREVIOUS,
      key: "k1:fallback",
      source: "fallback",
    });
    expect(calls).toHaveLength(2);
    now += 24 * 3_600_000;
    expect((await svc.resolve(job)).source).toBe("ai");
  });
});

describe("genui: service", () => {
  test("off (or API key missing): previous look kept, no fetch, retried once a provider is on", async () => {
    const { f, calls } = mockFetch(() => anthropicOk(TRACHT));
    for (const env of [{}, { GENUI_PROVIDER: "anthropic" }]) {
      const svc = createAvatarService(env, new MemoryStore(), { fetch: f });
      expect(svc.providerId).toBe("off");
      expect(await svc.resolve({ ...job, previous: TRACHT })).toEqual({
        avatar: TRACHT,
        key: "k1:fallback",
        source: "seed",
      });
      expect(await svc.resolve(job)).toEqual({
        avatar: avatarFromSeed("anna"),
        key: "k1:fallback",
        source: "seed",
      });
      const { selfDescription: _d, ...bare } = job;
      expect(await svc.resolve(bare)).toEqual({
        avatar: avatarFromSeed("anna"),
        key: "k1",
        source: "seed",
      });
      expect(svc.callsToday()).toBe(0);
    }
    expect(calls).toHaveLength(0);
  });

  test("cache keys: look revision + hash, the same for every provider", () => {
    const store = new MemoryStore();
    const off = createAvatarService({}, store);
    const on = createAvatarService(anthropic(), store);
    const jev = createAvatarService({ GENUI_PROVIDER: "jev", AI_GATEWAY_API_KEY: "g" }, store);
    expect(on.cacheKey("anna", "x")).toMatch(/^L1:[0-9a-z]+$/);
    expect(off.cacheKey("anna", "x")).toBe(on.cacheKey("anna", "x"));
    expect(jev.cacheKey("anna", "x")).toBe(on.cacheKey("anna", "x"));
    expect(on.cacheKey("anna", "x")).not.toBe(on.cacheKey("anna", "y"));
    expect(on.cacheKey("anna", undefined)).toBe(on.cacheKey("anna", ""));
  });

  test("GENUI_EFFORT (with an effort model) and the call cap default", async () => {
    const effortOf = async (env: Record<string, string>) => {
      const { f, calls } = mockFetch(() => anthropicOk(TRACHT));
      const lines: string[] = [];
      const svc = createAvatarService(
        anthropic({ GENUI_MODEL: "claude-opus-5-5", ...env }),
        new MemoryStore(),
        {
          fetch: f,
          log: (l) => lines.push(l),
        },
      );
      await svc.resolve(job);
      return { effort: (calls[0]!.body.output_config as { effort?: string }).effort, lines, svc };
    };
    expect((await effortOf({})).effort).toBe("low");
    expect((await effortOf({ GENUI_EFFORT: "High" })).effort).toBe("high");
    const bad = await effortOf({ GENUI_EFFORT: "turbo" });
    expect(bad.effort).toBe("low");
    expect(bad.lines.some((l) => l.includes("unknown GENUI_EFFORT"))).toBe(true);
    expect(bad.svc.maxCallsPerDay).toBe(DEFAULT_MAX_CALLS_PER_DAY);
    expect(DEFAULT_MAX_CALLS_PER_DAY).toBe(50);
  });

  test("at most MAX_CONCURRENT calls in flight; the rest wait their turn", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const f: FetchLike = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => releases.push(r));
      inFlight--;
      return anthropicOk(TRACHT);
    };
    const svc = createAvatarService(anthropic(), new MemoryStore(), { fetch: f });
    const all = Promise.all(
      ["a", "b", "c", "d", "e"].map((id) => svc.resolve({ ...job, personId: id, key: id })),
    );
    for (let i = 0; i < 5; i++) {
      while (releases.length === 0) await Bun.sleep(1);
      expect(inFlight).toBeLessThanOrEqual(MAX_CONCURRENT);
      releases.shift()!();
    }
    const results = await all;
    expect(results.map((r) => r.source)).toEqual(["ai", "ai", "ai", "ai", "ai"]);
    expect(peak).toBe(MAX_CONCURRENT);
    expect(svc.callsToday()).toBe(5);
  });

  test("missing key or unknown provider -> off", () => {
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
});

describe("genui: jev", () => {
  const jev = { GENUI_PROVIDER: "jev", AI_GATEWAY_API_KEY: "gw" };

  test("Vercel AI Gateway chat completions with the same strict json_schema", async () => {
    const { f, calls } = mockFetch(() => gatewayOk(TRACHT));
    const svc = createAvatarService(jev, new MemoryStore(), { fetch: f });
    const r = await svc.resolve(job);
    expect(r).toEqual({ avatar: TRACHT, key: "k1", source: "ai" });
    const c = calls[0]!;
    expect(c.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect((c.init.headers as Record<string, string>).authorization).toBe("Bearer gw");
    expect(c.body.model).toBe("openai/gpt-4o-mini");
    expect(c.body.max_tokens).toBe(GENUI_MAX_TOKENS);
    expect(c.body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "avatar",
        strict: true,
        schema: JSON.parse(JSON.stringify(AI_AVATAR_SCHEMA)),
      },
    });
  });

  test("fenced JSON is tolerated; non-JSON, refusal and truncation fall back", async () => {
    const fenced = mockFetch(() =>
      Response.json({
        choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(TRACHT)}\n\`\`\`` } }],
      }),
    );
    const svc1 = createAvatarService(jev, new MemoryStore(), { fetch: fenced.f });
    expect((await svc1.resolve(job)).source).toBe("ai");
    for (const choice of [
      { message: { content: "sure! here you go" } },
      { message: { content: null, refusal: "I can't help with that" } },
      { finish_reason: "length", message: { content: JSON.stringify(TRACHT) } },
    ]) {
      const m = mockFetch(() => Response.json({ choices: [choice] }));
      const svc = createAvatarService(jev, new MemoryStore(), { fetch: m.f });
      expect(await svc.resolve({ ...job, previous: PREVIOUS })).toEqual({
        avatar: PREVIOUS,
        key: "k1:fallback",
        source: "fallback",
      });
    }
  });
});
