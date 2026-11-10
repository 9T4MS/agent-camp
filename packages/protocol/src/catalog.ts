/**
 * Generative-UI avatar catalog (PLAN "Generative UI", spot 1).
 *
 * The AI never draws: it only picks catalog ids, which are validated by `AvatarSpec`.
 * With AI off (the default) `avatarFromSeed(name)` picks deterministically.
 * Each catalog entry carries display hints (label, hex colors) for the renderer and
 * for prompting a model.
 */
import { z } from "zod";
import { hashString, pick, seededRandom } from "./hash.ts";

type Entry<Id extends string> = { readonly id: Id; readonly label: string };
type ColorEntry<Id extends string> = Entry<Id> & {
  /** base color */
  readonly hex: string;
  /** darker shade for outlines / shading */
  readonly shade: string;
  /** lighter highlight */
  readonly light: string;
};

const ids = <const T extends readonly { id: string }[]>(entries: T) =>
  entries.map((e) => e.id) as unknown as { [K in keyof T]: T[K]["id"] };

// ---- hair ---------------------------------------------------------------------------------
export const HAIR_STYLES = [
  { id: "short", label: "short and neat" },
  { id: "buzz", label: "buzz cut" },
  { id: "long", label: "long, past the shoulders" },
  { id: "bun", label: "top bun" },
  { id: "curly", label: "big curls" },
  { id: "ponytail", label: "ponytail" },
  { id: "mohawk", label: "mohawk" },
  { id: "bald", label: "bald" },
] as const satisfies readonly Entry<string>[];
export const HairStyle = z.enum(ids(HAIR_STYLES));
export type HairStyle = z.infer<typeof HairStyle>;

/** Hair colors; `shade`/`light` give the renderer a 3-step ramp (all Endesga 32). */
export const HAIR_COLORS = [
  { id: "black", label: "black", hex: "#262b44", shade: "#181425", light: "#3a4466" },
  { id: "dark-brown", label: "dark brown", hex: "#3e2731", shade: "#181425", light: "#733e39" },
  { id: "brown", label: "brown", hex: "#733e39", shade: "#3e2731", light: "#b86f50" },
  { id: "auburn", label: "auburn", hex: "#be4a2f", shade: "#733e39", light: "#d77643" },
  { id: "ginger", label: "ginger", hex: "#f77622", shade: "#be4a2f", light: "#feae34" },
  { id: "blonde", label: "blonde", hex: "#feae34", shade: "#e4a672", light: "#fee761" },
  { id: "grey", label: "grey / silver", hex: "#c0cbdc", shade: "#8b9bb4", light: "#ffffff" },
  { id: "pink", label: "dyed pink", hex: "#f6757a", shade: "#b55088", light: "#e8b796" },
  { id: "blue", label: "dyed blue", hex: "#0099db", shade: "#124e89", light: "#2ce8f5" },
] as const satisfies readonly ColorEntry<string>[];
export const HairColor = z.enum(ids(HAIR_COLORS));
export type HairColor = z.infer<typeof HairColor>;

// ---- skin ---------------------------------------------------------------------------------
export const SKIN_TONES = [
  { id: "pale", label: "pale", hex: "#ead4aa", shade: "#e4a672", light: "#ffffff" },
  { id: "light", label: "light", hex: "#e8b796", shade: "#c28569", light: "#ead4aa" },
  { id: "medium", label: "medium", hex: "#e4a672", shade: "#b86f50", light: "#e8b796" },
  { id: "tan", label: "tan", hex: "#c28569", shade: "#b86f50", light: "#e4a672" },
  { id: "brown", label: "brown", hex: "#b86f50", shade: "#733e39", light: "#c28569" },
  { id: "deep", label: "deep brown", hex: "#733e39", shade: "#3e2731", light: "#b86f50" },
] as const satisfies readonly ColorEntry<string>[];
export const SkinTone = z.enum(ids(SKIN_TONES));
export type SkinTone = z.infer<typeof SkinTone>;

// ---- face & accessories ---------------------------------------------------------------------
export const GLASSES = [
  { id: "none", label: "no glasses" },
  { id: "round", label: "round glasses" },
  { id: "square", label: "square glasses" },
  { id: "sunglasses", label: "sunglasses" },
] as const satisfies readonly Entry<string>[];
export const Glasses = z.enum(ids(GLASSES));
export type Glasses = z.infer<typeof Glasses>;

export const FACIAL_HAIR = [
  { id: "none", label: "clean shaven" },
  { id: "stubble", label: "stubble" },
  { id: "beard", label: "full beard" },
  { id: "mustache", label: "mustache" },
] as const satisfies readonly Entry<string>[];
export const FacialHair = z.enum(ids(FACIAL_HAIR));
export type FacialHair = z.infer<typeof FacialHair>;

export const ACCESSORIES = [
  { id: "none", label: "nothing" },
  { id: "headphones", label: "big headphones" },
  { id: "beanie", label: "beanie" },
  { id: "cap", label: "baseball cap" },
  { id: "bow", label: "hair bow" },
  { id: "earring", label: "earring" },
] as const satisfies readonly Entry<string>[];
export const Accessory = z.enum(ids(ACCESSORIES));
export type Accessory = z.infer<typeof Accessory>;

// ---- desk ---------------------------------------------------------------------------------
export const DESK_PROPS = [
  { id: "plant", label: "potted plant" },
  { id: "mug", label: "coffee mug" },
  { id: "rubber-duck", label: "rubber duck" },
  { id: "figurine", label: "small figurine" },
  { id: "lamp", label: "desk lamp" },
  { id: "books", label: "stack of books" },
  { id: "cactus", label: "tiny cactus" },
  { id: "cat-photo", label: "framed cat photo" },
] as const satisfies readonly Entry<string>[];
export const DeskProp = z.enum(ids(DESK_PROPS));
export type DeskProp = z.infer<typeof DeskProp>;

/** 0 = spotless, 3 = chaos (papers, cables, snack wrappers). */
export const DESK_MESS_LEVELS = [0, 1, 2, 3] as const;
export const DeskMess = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type DeskMess = z.infer<typeof DeskMess>;

export const MAX_DESK_PROPS = 3;

// ---- avatar spec --------------------------------------------------------------------------
export const AvatarSpec = z.object({
  hairStyle: HairStyle,
  hairColor: HairColor,
  skinTone: SkinTone,
  glasses: Glasses,
  facialHair: FacialHair,
  accessory: Accessory,
  /** 0..3 distinct props */
  deskProps: z
    .array(DeskProp)
    .max(MAX_DESK_PROPS)
    .refine((a) => new Set(a).size === a.length, "deskProps must be unique"),
  deskMess: DeskMess,
});
export type AvatarSpec = z.infer<typeof AvatarSpec>;

/** Everything a GenUI provider may choose from, as plain id lists (handy for prompts). */
export const AVATAR_CATALOG = {
  hairStyles: HairStyle.options,
  hairColors: HairColor.options,
  skinTones: SkinTone.options,
  glasses: Glasses.options,
  facialHair: FacialHair.options,
  accessories: Accessory.options,
  deskProps: DeskProp.options,
  deskMess: DESK_MESS_LEVELS,
} as const;

/** Lookup helpers for display hints. */
export const hairColorHex = (id: HairColor) => HAIR_COLORS.find((c) => c.id === id)!;
export const skinToneHex = (id: SkinTone) => SKIN_TONES.find((c) => c.id === id)!;

/**
 * Deterministic avatar from any seed (normally the person's display name / personId).
 * Used when GENUI_PROVIDER=off and as the fallback when a provider returns garbage.
 */
export function avatarFromSeed(seed: string): AvatarSpec {
  const rand = seededRandom(`avatar:${seed}`);
  const hairStyle = pick(rand, HairStyle.options);
  // keep accessories/facial hair a bit rarer than "none" so the office isn't a costume party
  const facialHair = rand() < 0.6 ? "none" : pick(rand, FacialHair.options);
  const glasses = rand() < 0.5 ? "none" : pick(rand, Glasses.options);
  const accessory = rand() < 0.45 ? "none" : pick(rand, Accessory.options);
  const propCount = 1 + Math.floor(rand() * MAX_DESK_PROPS);
  const pool: DeskProp[] = [...DeskProp.options];
  const deskProps: DeskProp[] = [];
  for (let i = 0; i < propCount; i++) {
    const idx = Math.floor(rand() * pool.length);
    deskProps.push(pool.splice(idx, 1)[0]!);
  }
  return {
    hairStyle,
    hairColor: pick(rand, HairColor.options),
    skinTone: pick(rand, SkinTone.options),
    glasses,
    facialHair,
    accessory,
    deskProps,
    deskMess: pick(rand, DESK_MESS_LEVELS),
  };
}

/**
 * Validate an untrusted avatar (e.g. model output); fall back to the seeded one if invalid.
 * Never throws.
 */
export function coerceAvatar(candidate: unknown, seed: string): AvatarSpec {
  const r = AvatarSpec.safeParse(candidate);
  return r.success ? r.data : avatarFromSeed(seed);
}

/** Small per-session tweaks so sibling characters read as "another Anna". Never AI. */
export type SessionVariation = {
  /** shift hair color one step darker (-1), unchanged (0) or lighter (+1) on its ramp */
  hairShade: -1 | 0 | 1;
  /** wears a little hat */
  hat: boolean;
  /** carries a mug */
  mug: boolean;
};

export function sessionVariation(sessionKey: string): SessionVariation {
  const h = hashString(`session:${sessionKey}`);
  const shades = [-1, 0, 1] as const;
  return {
    hairShade: shades[h % 3]!,
    hat: ((h >>> 4) & 3) === 0, // ~25%
    mug: ((h >>> 8) & 1) === 1, // ~50%
  };
}
