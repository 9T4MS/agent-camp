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
import { CharacterLook } from "./look.ts";

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
  { id: "cap-mint", label: "mint / aqua baseball cap with a white logo" },
  { id: "bow", label: "hair bow" },
  { id: "earring", label: "earring" },
  { id: "cat-ears", label: "large cat ears" },
  { id: "fox-ears", label: "fox ears" },
  { id: "bunny-ears", label: "bunny ears" },
  { id: "devil-horns", label: "devil horns" },
  { id: "halo", label: "halo" },
  { id: "crown", label: "crown" },
  { id: "wizard-hat", label: "wizard hat" },
  { id: "party-hat", label: "party hat" },
  { id: "antenna", label: "antenna" },
] as const satisfies readonly Entry<string>[];
export const Accessory = z.enum(ids(ACCESSORIES));
export type Accessory = z.infer<typeof Accessory>;

/**
 * What the character wears on top. `jacket` and `hoodie` come in the agent color; the
 * others have their own colors and show the agent kind as a small badge on the tee (and a
 * patch on the back, the side you see at the desk).
 */
export const OUTFITS = [
  { id: "jacket", label: "open jacket over a white shirt (agent color)" },
  { id: "hoodie", label: "hoodie (agent color)" },
  { id: "flannel", label: "grey/teal plaid flannel over a navy tee" },
  { id: "flannel-red", label: "red lumberjack flannel over a navy tee" },
  { id: "tee", label: "plain navy t-shirt" },
  { id: "cat", label: "cat costume with whiskers and tail" },
  { id: "robot", label: "robot costume" },
  { id: "astronaut", label: "astronaut suit" },
  { id: "pirate", label: "pirate costume" },
  { id: "vampire", label: "vampire cape" },
  { id: "disco", label: "sparkling disco outfit" },
] as const satisfies readonly Entry<string>[];
export const Outfit = z.enum(ids(OUTFITS));
export type Outfit = z.infer<typeof Outfit>;
/** Outfits drawn in the agent color (no badge needed). */
export const AGENT_COLORED_OUTFITS: readonly Outfit[] = ["jacket", "hoodie"];

/** Something the character holds. Hands are seen from the front: left = viewer's left. */
export const HELD_ITEMS = [
  { id: "none", label: "empty hand" },
  { id: "beer", label: "glass of beer" },
  { id: "joint", label: "joint" },
  { id: "phone", label: "phone" },
  { id: "coffee", label: "coffee cup" },
  { id: "lightsaber", label: "lightsaber" },
  { id: "confetti", label: "confetti cannon" },
  { id: "cigarette", label: "cigarette" },
  { id: "bubble-wand", label: "bubble wand" },
  { id: "disco-ball", label: "disco ball" },
  { id: "magic-wand", label: "magic wand" },
  { id: "balloon", label: "balloon" },
  { id: "water-pistol", label: "water pistol" },
  { id: "maracas", label: "maracas" },
  { id: "umbrella", label: "umbrella" },
] as const satisfies readonly Entry<string>[];
export const HeldItem = z.enum(ids(HELD_ITEMS));
export type HeldItem = z.infer<typeof HeldItem>;

/** Optional personal accents; defaults keep existing stored and seeded looks unchanged. */
export const WRISTWEAR = [
  { id: "none", label: "none" },
  { id: "neon-cyan", label: "neon cyan bracelets" },
  { id: "neon-pink", label: "neon pink bracelets" },
  { id: "neon-lime", label: "neon lime bracelets" },
  { id: "rainbow", label: "rainbow bracelets" },
] as const;
export const Wristwear = z.enum(ids(WRISTWEAR));
export type Wristwear = z.infer<typeof Wristwear>;
export const ACCENT_COLORS = [
  { id: "cyan", label: "cyan" },
  { id: "pink", label: "pink" },
  { id: "lime", label: "lime" },
  { id: "gold", label: "gold" },
  { id: "purple", label: "purple" },
  { id: "red", label: "red" },
] as const;
export const AccentColor = z.enum(ids(ACCENT_COLORS));
export type AccentColor = z.infer<typeof AccentColor>;
export const VEHICLES = [
  { id: "none", label: "on foot" },
  { id: "car", label: "car" },
  { id: "skateboard", label: "skateboard" },
  { id: "hoverboard", label: "hoverboard" },
  { id: "spaceship", label: "spaceship" },
] as const;
export const Vehicle = z.enum(ids(VEHICLES));
export type Vehicle = z.infer<typeof Vehicle>;

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
/** The catalog part of an avatar (always present; what the low-res office and old clients use). */
export const AvatarCatalogSpec = z.object({
  hairStyle: HairStyle,
  hairColor: HairColor,
  skinTone: SkinTone,
  glasses: Glasses,
  facialHair: FacialHair,
  accessory: Accessory,
  /** added later: missing in stored looks and older payloads, so they default */
  outfit: Outfit.default("jacket"),
  leftHand: HeldItem.default("none"),
  rightHand: HeldItem.default("none"),
  wrist: Wristwear.default("none"),
  accentColor: AccentColor.default("cyan"),
  vehicle: Vehicle.default("none"),
  /** 0..3 distinct props */
  deskProps: z
    .array(DeskProp)
    .max(MAX_DESK_PROPS)
    .refine((a) => new Set(a).size === a.length, "deskProps must be unique"),
  deskMess: DeskMess,
});
export type AvatarCatalogSpec = z.infer<typeof AvatarCatalogSpec>;

export const AvatarSpec = AvatarCatalogSpec.extend({
  /**
   * Optional detailed look (look.ts). Without it the renderer derives one from the catalog
   * fields (`lookFromCatalog`). An invalid look parses as `undefined` instead of failing the
   * whole message, so one bad avatar never drops an office.snapshot.
   */
  look: CharacterLook.optional().catch(undefined),
});
export type AvatarSpec = z.infer<typeof AvatarSpec>;

/**
 * The avatar as viewers read it: an id this bundle does not know yet (a newer server added it
 * to the catalog) falls back to a default instead of rejecting the whole snapshot. Servers
 * and GenUI keep validating with the strict `AvatarSpec`.
 */
export const ViewerAvatar = z.object({
  hairStyle: HairStyle.catch("short"),
  hairColor: HairColor.catch("brown"),
  skinTone: SkinTone.catch("medium"),
  glasses: Glasses.catch("none"),
  facialHair: FacialHair.catch("none"),
  accessory: Accessory.catch("none"),
  outfit: Outfit.catch("jacket"),
  leftHand: HeldItem.catch("none"),
  rightHand: HeldItem.catch("none"),
  wrist: Wristwear.catch("none"),
  accentColor: AccentColor.catch("cyan"),
  vehicle: Vehicle.catch("none"),
  deskProps: z
    .array(z.unknown())
    .catch([])
    .transform((a) =>
      [...new Set(a.filter((x): x is DeskProp => DeskProp.safeParse(x).success))].slice(
        0,
        MAX_DESK_PROPS,
      ),
    ),
  deskMess: DeskMess.catch(0),
  look: CharacterLook.optional().catch(undefined),
});
export type ViewerAvatar = z.infer<typeof ViewerAvatar>;

/** Everything a GenUI provider may choose from, as plain id lists (handy for prompts). */
export const AVATAR_CATALOG = {
  hairStyles: HairStyle.options,
  hairColors: HairColor.options,
  skinTones: SkinTone.options,
  glasses: Glasses.options,
  facialHair: FacialHair.options,
  accessories: Accessory.options,
  outfits: Outfit.options,
  heldItems: HeldItem.options,
  wrists: Wristwear.options,
  accentColors: AccentColor.options,
  vehicles: Vehicle.options,
  deskProps: DeskProp.options,
  deskMess: DESK_MESS_LEVELS,
} as const;

/** Lookup helpers for display hints. */
export const hairColorHex = (id: HairColor) => HAIR_COLORS.find((c) => c.id === id)!;
export const skinToneHex = (id: SkinTone) => SKIN_TONES.find((c) => c.id === id)!;

/** Accessories the seed picks from: the original list, so seeded looks never shift. */
const SEEDED_ACCESSORIES: readonly Accessory[] = [
  "none",
  "headphones",
  "beanie",
  "cap",
  "bow",
  "earring",
];

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
  const accessory = rand() < 0.45 ? "none" : pick(rand, SEEDED_ACCESSORIES);
  // outfit / held items are not drawn from `rand`: the seeded look of everyone already in the
  // office stays exactly as it was. They are picked by AI or in the look editor.
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
    outfit: "jacket",
    leftHand: "none",
    rightHand: "none",
    wrist: "none",
    accentColor: "cyan",
    vehicle: "none",
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
