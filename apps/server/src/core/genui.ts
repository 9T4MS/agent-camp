/**
 * Generative UI, spot 1: name + self-description -> AvatarSpec of catalog ids.
 *
 * Providers:
 *   off        avatarFromSeed (default; no network)
 *   anthropic  Messages API, forced tool use whose input_schema is the catalog
 *   jev        Vercel AI Gateway, OpenAI-compatible chat completions with a JSON schema
 *
 * Rules: called only on join / description change (the Hub decides), hard daily cap
 * counted in the store, token counts logged, any error -> seeded fallback.
 */
import {
  ACCENT_COLORS,
  ACCESSORIES,
  AVATAR_CATALOG,
  AvatarSpec,
  avatarFromSeed,
  coerceAvatar,
  DESK_PROPS,
  FACIAL_HAIR,
  GLASSES,
  HAIR_COLORS,
  HAIR_STYLES,
  HELD_ITEMS,
  hashString,
  MAX_DESK_PROPS,
  OUTFITS,
  SKIN_TONES,
  VEHICLES,
  WRISTWEAR,
} from "@agent-office/protocol";
import type { AvatarJob } from "./hub.ts";
import type { Store } from "./store.ts";

export type AvatarRequest = { personId: string; name: string; selfDescription?: string };
export type ProviderResult = { candidate: unknown; inputTokens?: number; outputTokens?: number };

export interface AvatarProvider {
  readonly id: string;
  generate(req: AvatarRequest): Promise<ProviderResult>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type GenuiEnv = {
  GENUI_PROVIDER?: string;
  GENUI_MODEL?: string;
  GENUI_MAX_CALLS_PER_DAY?: string;
  ANTHROPIC_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
};

// ---- shared prompt + schema -----------------------------------------------------------------

const enumOf = (values: readonly (string | number)[]) => ({ enum: [...values] });

/** JSON schema of AvatarSpec built from the catalog (ids only). */
export const AVATAR_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
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
  ],
  properties: {
    hairStyle: { type: "string", ...enumOf(AVATAR_CATALOG.hairStyles) },
    hairColor: { type: "string", ...enumOf(AVATAR_CATALOG.hairColors) },
    skinTone: { type: "string", ...enumOf(AVATAR_CATALOG.skinTones) },
    glasses: { type: "string", ...enumOf(AVATAR_CATALOG.glasses) },
    facialHair: { type: "string", ...enumOf(AVATAR_CATALOG.facialHair) },
    accessory: { type: "string", ...enumOf(AVATAR_CATALOG.accessories) },
    outfit: { type: "string", ...enumOf(AVATAR_CATALOG.outfits) },
    leftHand: { type: "string", ...enumOf(AVATAR_CATALOG.heldItems) },
    rightHand: { type: "string", ...enumOf(AVATAR_CATALOG.heldItems) },
    wrist: { type: "string", ...enumOf(AVATAR_CATALOG.wrists) },
    accentColor: { type: "string", ...enumOf(AVATAR_CATALOG.accentColors) },
    vehicle: { type: "string", ...enumOf(AVATAR_CATALOG.vehicles) },
    deskProps: {
      type: "array",
      items: { type: "string", ...enumOf(AVATAR_CATALOG.deskProps) },
      maxItems: MAX_DESK_PROPS,
      uniqueItems: true,
    },
    deskMess: { type: "integer", ...enumOf(AVATAR_CATALOG.deskMess) },
  },
} as const;

const list = (entries: readonly { id: string; label: string }[]) =>
  entries.map((e) => `${e.id} (${e.label})`).join(", ");

export const SYSTEM_PROMPT = [
  "You dress up a tiny pixel-art character for a cozy virtual office.",
  "Pick only catalog ids. Follow the person's self-description where the catalog allows;",
  "fill anything unspecified with a tasteful, varied choice. Never refuse; never add fields.",
  `hairStyle: ${list(HAIR_STYLES)}`,
  `hairColor: ${list(HAIR_COLORS)}`,
  `skinTone: ${list(SKIN_TONES)}`,
  `glasses: ${list(GLASSES)}`,
  `facialHair: ${list(FACIAL_HAIR)}`,
  `accessory: ${list(ACCESSORIES)}`,
  `outfit: ${list(OUTFITS)}`,
  `leftHand, rightHand: ${list(HELD_ITEMS)}`,
  `wrist: ${list(WRISTWEAR)}`,
  `accentColor: ${list(ACCENT_COLORS)}`,
  `vehicle: ${list(VEHICLES)}`,
  "Use cat-ears, fox-ears, bunny-ears, devil-horns, halo, crown, wizard-hat, party-hat or antenna only when the person's self-description explicitly requests them; otherwise choose an ordinary accessory (none, headphones, beanie, cap, cap-mint, bow or earring).",
  "Use no bracelets, cyan accent and no vehicle unless the description requests them.",
  "Use jacket and empty hands unless the description asks for another outfit or held items.",
  `deskProps (0-${MAX_DESK_PROPS}, distinct): ${list(DESK_PROPS)}`,
  "deskMess: 0 (spotless) .. 3 (chaos)",
].join("\n");

export function userPrompt(req: AvatarRequest): string {
  const desc = req.selfDescription?.trim() || "(no description given)";
  return `Name: ${req.name}\nSelf-description: ${desc.slice(0, 200)}`;
}

async function readJson(res: Response): Promise<unknown> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ---- providers ------------------------------------------------------------------------------

export function anthropicProvider(opts: {
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
}): AvatarProvider {
  const f = opts.fetch ?? ((i, init) => fetch(i, init));
  const model = opts.model || "claude-haiku-4-5";
  return {
    id: "anthropic",
    async generate(req) {
      const res = await f("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 400,
          system: SYSTEM_PROMPT,
          tools: [
            {
              name: "set_avatar",
              description: "Set the character's look using catalog ids only.",
              input_schema: AVATAR_JSON_SCHEMA,
            },
          ],
          tool_choice: { type: "tool", name: "set_avatar" },
          messages: [{ role: "user", content: userPrompt(req) }],
        }),
      });
      const body = (await readJson(res)) as {
        content?: { type: string; name?: string; input?: unknown }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const tool = body.content?.find((b) => b.type === "tool_use" && b.name === "set_avatar");
      if (!tool) throw new Error("no set_avatar tool_use in response");
      return {
        candidate: tool.input,
        inputTokens: body.usage?.input_tokens,
        outputTokens: body.usage?.output_tokens,
      };
    },
  };
}

/**
 * "jev" provider: Vercel AI Gateway (OpenAI-compatible chat completions) with a JSON-schema
 * response format. Model ids are gateway ids ("provider/model").
 */
export function jevProvider(opts: {
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
}): AvatarProvider {
  const f = opts.fetch ?? ((i, init) => fetch(i, init));
  const model = opts.model || "openai/gpt-4o-mini";
  return {
    id: "jev",
    async generate(req) {
      const res = await f("https://ai-gateway.vercel.sh/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: 400,
          messages: [
            { role: "system", content: `${SYSTEM_PROMPT}\nReply with the JSON object only.` },
            { role: "user", content: userPrompt(req) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "avatar", strict: true, schema: AVATAR_JSON_SCHEMA },
          },
        }),
      });
      const body = (await readJson(res)) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = body.choices?.[0]?.message?.content;
      if (!text) throw new Error("empty completion");
      const json = text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
      return {
        candidate: JSON.parse(json),
        inputTokens: body.usage?.prompt_tokens,
        outputTokens: body.usage?.completion_tokens,
      };
    },
  };
}

// ---- service --------------------------------------------------------------------------------

export type AvatarResult = { avatar: AvatarSpec; key: string; source: "ai" | "seed" | "fallback" };

export class AvatarService {
  readonly maxCallsPerDay: number;
  constructor(
    private provider: AvatarProvider | null,
    private store: Store,
    opts: { maxCallsPerDay?: number; log?: (line: string) => void; now?: () => number } = {},
  ) {
    this.maxCallsPerDay = opts.maxCallsPerDay ?? 200;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }
  private log: (line: string) => void;
  private now: () => number;

  get providerId(): string {
    return this.provider?.id ?? "off";
  }

  /**
   * Cache key: provider + hash(name + description). Used by the Hub as `avatarKey`, which
   * passes the personId as `name` (rows from before that used the display name).
   */
  cacheKey = (name: string, selfDescription: string | undefined): string =>
    `${this.providerId}:${hashString(`${name}\n${selfDescription ?? ""}`).toString(36)}`;

  callsToday(): number {
    return Number(this.store.kvGet(this.dayKey()) ?? 0);
  }

  private dayKey(): string {
    return `genui.calls.${new Date(this.now()).toISOString().slice(0, 10)}`;
  }

  /**
   * Resolve a look for a Hub avatar job. On failure the returned key is marked so the next
   * join retries (still bounded by the daily cap).
   */
  async resolve(job: AvatarJob | (AvatarRequest & { key?: string })): Promise<AvatarResult> {
    const key = job.key ?? this.cacheKey(job.name, job.selfDescription);
    const seeded = avatarFromSeed(job.personId);
    if (!this.provider) return { avatar: seeded, key, source: "seed" };
    const used = this.callsToday();
    if (used >= this.maxCallsPerDay) {
      this.log(
        `genui ${this.providerId} daily cap reached (${used}), seeded look for ${job.personId}`,
      );
      return { avatar: seeded, key: `${key}:fallback`, source: "fallback" };
    }
    this.store.kvPut(this.dayKey(), String(used + 1));
    try {
      const r = await this.provider.generate(job);
      this.log(
        `genui ${this.providerId} ${job.personId} tokens in=${r.inputTokens ?? "?"} out=${r.outputTokens ?? "?"} (call ${used + 1}/${this.maxCallsPerDay} today)`,
      );
      const parsed = AvatarSpec.safeParse(r.candidate);
      if (parsed.success) return { avatar: parsed.data, key, source: "ai" };
      this.log(`genui ${this.providerId} invalid avatar for ${job.personId}, seeded fallback`);
      return {
        avatar: coerceAvatar(r.candidate, job.personId),
        key: `${key}:fallback`,
        source: "fallback",
      };
    } catch (err) {
      this.log(`genui ${this.providerId} error for ${job.personId}: ${(err as Error).message}`);
      return { avatar: seeded, key: `${key}:fallback`, source: "fallback" };
    }
  }
}

/** Build the configured service from Worker vars / env. Unknown or key-less providers -> off. */
export function createAvatarService(
  env: GenuiEnv,
  store: Store,
  opts: { fetch?: FetchLike; log?: (line: string) => void; now?: () => number } = {},
): AvatarService {
  const log = opts.log ?? (() => {});
  const wanted = (env.GENUI_PROVIDER ?? "off").trim().toLowerCase();
  let provider: AvatarProvider | null = null;
  const common = {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(env.GENUI_MODEL ? { model: env.GENUI_MODEL } : {}),
  };
  if (wanted === "anthropic") {
    if (env.ANTHROPIC_API_KEY)
      provider = anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, ...common });
    else log("genui: GENUI_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing; using off");
  } else if (wanted === "jev") {
    if (env.AI_GATEWAY_API_KEY)
      provider = jevProvider({ apiKey: env.AI_GATEWAY_API_KEY, ...common });
    else log("genui: GENUI_PROVIDER=jev but AI_GATEWAY_API_KEY is missing; using off");
  } else if (wanted !== "off" && wanted !== "") {
    log(`genui: unknown GENUI_PROVIDER=${wanted}; using off`);
  }
  const max = Number.parseInt(env.GENUI_MAX_CALLS_PER_DAY ?? "200", 10);
  return new AvatarService(provider, store, {
    maxCallsPerDay: Number.isFinite(max) && max >= 0 ? max : 200,
    log,
    ...(opts.now ? { now: opts.now } : {}),
  });
}
