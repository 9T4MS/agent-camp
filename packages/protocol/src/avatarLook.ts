/**
 * Bridges the catalog avatar and the detailed `CharacterLook`:
 *   lookFromCatalog  catalog fields -> a look that reproduces today's low-res characters
 *   resolveLook      the look the renderer draws (avatar.look ?? lookFromCatalog)
 *   repairLook / repairAvatar  "repair, not reject" for untrusted model output and stored JSON
 */
import { z } from "zod";
import {
  AccentColor,
  Accessory,
  type AvatarCatalogSpec,
  AvatarSpec,
  avatarFromSeed,
  DeskMess,
  DeskProp,
  FacialHair,
  Glasses,
  HairColor,
  HairStyle,
  HeldItem,
  hairColorHex,
  MAX_DESK_PROPS,
  Outfit,
  SkinTone,
  skinToneHex,
  Vehicle,
  Wristwear,
} from "./catalog.ts";
import {
  CharacterLook,
  type Extras,
  LOOK_SECTIONS,
  LOOK_VERSION,
  MAX_BUTTONS,
  type Ramp,
} from "./look.ts";

// Endesga 32 colours today's renderer uses for the fixed parts (apps/web/src/art/palette.ts).
const NIGHT = "#181425";
const COCOA = "#3e2731";
const BARK = "#733e39";
const WHITE = "#ffffff";
const SILVER = "#c0cbdc";
const GREY = "#8b9bb4";
const SLATE = "#5a6988";
const DUSK = "#3a4466";
const INK = "#262b44";
const CREAM = "#ead4aa";
const PEACH = "#e8b796";
const AMBER = "#feae34";
const FOREST = "#265c42";
const MOSS = "#3e8948";
const PINE = "#193c3e";
const PLUM = "#68386c";
const BERRY = "#b55088";
const PINK = "#f6757a";
const RED = "#e43b44";
const WINE = "#a22633";
const SKY = "#0099db";
const CYAN = "#2ce8f5";
const LEMON = "#fee761";
const LEAF = "#63c74d";

const ramp = (base: string, shadow: string, light: string): Ramp => ({ base, shadow, light });
const NO_PATTERN = (a: string) => ({ kind: "none" as const, a, b: "none" as const });
const NO_BUTTONS = (color: string) => ({
  count: 0,
  color,
  rim: "none" as const,
  size: "small" as const,
});

/** Catalog accent colours (look editor), as the 1× renderer drew them. */
export const ACCENT_HEX: Record<AvatarCatalogSpec["accentColor"], string> = {
  cyan: CYAN,
  pink: PINK,
  lime: LEAF,
  gold: LEMON,
  purple: BERRY,
  red: RED,
};

/** Accessories drawn as novelty headwear of the same name. */
const NOVELTY_HEADWEAR = [
  "cat-ears",
  "fox-ears",
  "bunny-ears",
  "devil-horns",
  "halo",
  "crown",
  "wizard-hat",
  "party-hat",
  "antenna",
] as const satisfies readonly AvatarCatalogSpec["accessory"][] &
  readonly CharacterLook["headwear"]["style"][];
const isNoveltyHeadwear = (
  acc: AvatarCatalogSpec["accessory"],
): acc is (typeof NOVELTY_HEADWEAR)[number] =>
  (NOVELTY_HEADWEAR as readonly string[]).includes(acc);

/** Headwear for catalog accessories, in today's colours. */
function catalogHeadwear(acc: AvatarCatalogSpec["accessory"]): CharacterLook["headwear"] {
  if (isNoveltyHeadwear(acc))
    // drawn in their own fixed colours (the party hat in the accent colour)
    return { style: acc, ramp: ramp(DUSK, INK, SLATE), accent: WHITE };
  switch (acc) {
    case "beanie": // plum knit, berry cuff, cream pompom
      return { style: "beanie", ramp: ramp(PLUM, COCOA, BERRY), accent: CREAM };
    case "cap": // forest crown with a moss highlight, pine brim
      return { style: "cap", ramp: ramp(FOREST, PINE, MOSS), accent: PINE };
    case "cap-mint": // mint/aqua crown with a white highlight, sky brim, white logo
      return { style: "cap", ramp: ramp(CYAN, SKY, WHITE), accent: SKY, logo: WHITE };
    case "bow": // pink ribbon, berry knot
      return { style: "bow", ramp: ramp(PINK, BERRY, PEACH), accent: BERRY };
    case "headphones": // berry cups, pink cushions, ink band
      return { style: "headphones", ramp: ramp(BERRY, PLUM, PINK), accent: INK };
    default:
      return { style: "none", ramp: ramp(DUSK, INK, SLATE), accent: WHITE };
  }
}

function catalogEyewear(g: AvatarCatalogSpec["glasses"]): CharacterLook["eyewear"] {
  const base = { frameAccent: INK, framePattern: "solid" as const };
  switch (g) {
    case "round":
      return { ...base, style: "round", frame: SLATE, lens: SILVER, tint: "clear" };
    case "square":
      return { ...base, style: "square", frame: SLATE, lens: SILVER, tint: "clear" };
    case "sunglasses":
      return { ...base, style: "rectangle", frame: NIGHT, lens: NIGHT, tint: "dark" };
    default:
      return { ...base, style: "none", frame: SLATE, lens: SILVER, tint: "clear" };
  }
}

type OutfitId = AvatarCatalogSpec["outfit"];
type Layers = Pick<CharacterLook, "shirt" | "outer">;

/** Garment colours of the outfits that are not agent coloured (as the 1× renderer drew them). */
const OUTFIT_RAMPS: Record<Exclude<OutfitId, "jacket" | "hoodie">, Ramp> = {
  flannel: ramp(GREY, SLATE, SILVER),
  "flannel-red": ramp(RED, WINE, PINK),
  tee: ramp(DUSK, INK, SLATE),
  cat: ramp(SLATE, INK, SILVER),
  robot: ramp(SILVER, SLATE, WHITE),
  astronaut: ramp(WHITE, SILVER, CYAN),
  pirate: ramp(WINE, NIGHT, RED),
  vampire: ramp(NIGHT, WINE, RED),
  disco: ramp(BERRY, PLUM, PINK),
};

/** Outfits that are costumes: a closed garment in the costume colours plus costume details. */
export const COSTUME_OUTFITS = new Set<OutfitId>([
  "cat",
  "robot",
  "astronaut",
  "pirate",
  "vampire",
  "disco",
]);

const tee = (r: Ramp, sleeves: CharacterLook["shirt"]["sleeves"]): CharacterLook["shirt"] => ({
  kind: "tshirt",
  ramp: r,
  pattern: NO_PATTERN(r.base),
  collar: "crew",
  collarColor: "none",
  neckwear: "none",
  neckwearColor: WHITE,
  sleeves,
  buttons: NO_BUTTONS(r.base),
  peeksAtWaist: false,
});

const NO_OUTER: CharacterLook["outer"] = {
  kind: "none",
  agentColored: false,
  ramp: ramp(GREY, SLATE, SILVER),
  pattern: NO_PATTERN(GREY),
  open: false,
  length: "hip",
  collar: "none",
  collarColor: "none",
  collarPiping: "none",
  piping: "none",
  buttons: NO_BUTTONS(SLATE),
  pockets: "none",
  pocketPiping: "none",
  yoke: false,
};

/**
 * Shirt + outer layer of a catalog outfit:
 *   jacket       open jacket in the agent colour over a white tee (the original look)
 *   hoodie       pullover hoodie (no zip) with hood, drawstrings and kangaroo pocket in the
 *                agent colour
 *   flannel      open grey plaid flannel (white threads, dusk bands) over a navy tee
 *   flannel-red  open red lumberjack plaid (pink threads, night bands) over a navy tee
 *   tee          plain dusk-navy t-shirt with short sleeves, no outer layer
 *   costumes     closed garment in the costume colours (details: `extras.costume`)
 * Everything but jacket/hoodie keeps its colours and shows the agent as the 1× renderer did:
 * a chest badge, and a patch across the shoulders from behind.
 */
function outfitLayers(outfit: OutfitId): Layers {
  const whiteTee = tee(ramp(WHITE, SILVER, WHITE), "long");
  const agent = ramp(GREY, SLATE, SILVER); // placeholder: agentColored -> AGENT_PALETTES
  switch (outfit) {
    case "jacket":
      return {
        shirt: whiteTee,
        outer: { ...NO_OUTER, kind: "jacket", agentColored: true, ramp: agent, open: true },
      };
    case "hoodie":
      return {
        shirt: whiteTee,
        outer: {
          ...NO_OUTER,
          kind: "hoodie",
          agentColored: true,
          ramp: agent,
          collar: "hood",
          pockets: "kangaroo",
        },
      };
    case "flannel":
    case "flannel-red": {
      const red = outfit === "flannel-red";
      const r = OUTFIT_RAMPS[outfit];
      return {
        shirt: tee(ramp(INK, NIGHT, DUSK), "long"),
        outer: {
          ...NO_OUTER,
          kind: "jacket",
          ramp: r,
          // plaid: light threads down (a), dark bands across (b)
          pattern: { kind: "plaid", a: red ? PINK : WHITE, b: red ? NIGHT : DUSK },
          open: true,
          collar: "shirt",
          pockets: "flap",
        },
      };
    }
    case "tee":
      return { shirt: tee(OUTFIT_RAMPS.tee, "short"), outer: NO_OUTER };
    default: {
      const r = OUTFIT_RAMPS[outfit];
      return {
        shirt: whiteTee,
        outer: { ...NO_OUTER, kind: "jacket", ramp: r, pattern: NO_PATTERN(r.base) },
      };
    }
  }
}

/** The look-editor items of a catalog avatar (held items, costume, bracelets, accent). */
export function extrasFromCatalog(a: AvatarCatalogSpec): Extras {
  return {
    leftHand: a.leftHand,
    rightHand: a.rightHand,
    costume: COSTUME_OUTFITS.has(a.outfit) ? (a.outfit as Extras["costume"]) : "none",
    wrist: a.wrist,
    accent: ACCENT_HEX[a.accentColor],
  };
}

/**
 * The look of a catalog-only avatar: reproduces today's characters (skin + hair from the
 * avatar, white tee at the neck, jacket in the agent colour, dusk trousers, cocoa shoes).
 * Pure and deterministic.
 */
export function lookFromCatalog(a: AvatarCatalogSpec): CharacterLook {
  const sk = skinToneHex(a.skinTone);
  const hc = hairColorHex(a.hairColor);
  const skin = ramp(sk.hex, sk.shade, sk.light);
  const hair = ramp(hc.hex, hc.shade, hc.light);
  const { shirt, outer } = outfitLayers(a.outfit);
  return {
    v: LOOK_VERSION,
    build: "average",
    skin,
    face: {
      shape: "round",
      ears: "small",
      eyes: "dot",
      eyeColor: NIGHT,
      brows: "none",
      expression: "neutral",
      cheeks: a.skinTone === "deep" ? "none" : "blush",
    },
    hair: { cut: a.hairStyle, ramp: hair, sheen: a.hairStyle !== "buzz" },
    facialHair: {
      style: a.facialHair,
      // today's stubble is dotted in the skin shade, beards/mustaches in the hair colour
      color: a.facialHair === "stubble" ? sk.shade : hc.hex,
    },
    eyewear: catalogEyewear(a.glasses),
    headwear: catalogHeadwear(a.accessory),
    earrings: { style: a.accessory === "earring" ? "stud" : "none", color: AMBER },
    shirt,
    vest: {
      kind: "none",
      ramp: ramp(WHITE, SILVER, WHITE),
      pattern: NO_PATTERN(WHITE),
      collar: "none",
      piping: "none",
      buttons: NO_BUTTONS(WHITE),
    },
    outer,
    bottoms: {
      kind: "trousers",
      ramp: ramp(DUSK, INK, SLATE),
      pattern: NO_PATTERN(DUSK),
      flap: false,
      embroidery: { motif: "none", color: DUSK, stitching: "none" },
      buttons: NO_BUTTONS(DUSK),
      suspenders: "none",
      suspendersColor: INK,
      belt: "none",
      hem: "plain",
    },
    legwear: { kind: "crew-socks", color: INK, accent: "none" },
    shoes: {
      kind: "loafers",
      ramp: ramp(COCOA, NIGHT, BARK),
      sole: NIGHT,
      accent: "none",
      laces: "none",
    },
    pose: { hands: "relaxed", stance: "neutral", headTilt: false },
    extras: extrasFromCatalog(a),
  };
}

/**
 * The look the renderer draws for an avatar. A detailed look without `extras` (stored before
 * they existed, or a model answer without them) takes them from the catalog fields.
 */
export function resolveLook(a: AvatarSpec): CharacterLook {
  if (!a.look) return lookFromCatalog(a);
  return a.look.extras ? a.look : { ...a.look, extras: extrasFromCatalog(a) };
}

/**
 * The avatar with catalog ids only (no detailed `look`): what a look picked in the look editor
 * is stored and shown as, so its look always comes from the picked ids (`lookFromCatalog`)
 * and never from a GenUI answer it was edited from.
 */
export function catalogAvatar(a: AvatarSpec): AvatarSpec {
  const { look: _l, ...catalog } = a;
  return { ...catalog, deskProps: [...catalog.deskProps] };
}

// ---- repair -------------------------------------------------------------------------------
/** "#ABC" / "abc" / "AABBCC" / " #aAbBcC " -> "#aabbcc"; anything else -> null. */
export function normalizeHex(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return null;
  let h = m[1]!.toLowerCase();
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return `#${h}`;
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** Normalize hex-ish strings, lowercase "None", clamp button counts — recursively. */
function tidy(x: unknown, key?: string): unknown {
  if (key === "count" && (typeof x === "number" || typeof x === "string")) {
    const n = Number(x);
    if (!Number.isFinite(n)) return x;
    return Math.min(MAX_BUTTONS, Math.max(0, Math.round(n)));
  }
  if (typeof x === "string") {
    if (x.trim().toLowerCase() === "none") return "none";
    return normalizeHex(x) ?? x;
  }
  if (isObject(x)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) out[k] = tidy(v, k);
    return out;
  }
  return x;
}

/** Number of leaf fields (strings, numbers, booleans) a schema describes. */
function leafCount(schema: z.ZodType): number {
  if (!(schema instanceof z.ZodObject)) return 1;
  let n = 0;
  for (const f of Object.values(schema.shape as Record<string, z.ZodType>)) n += leafCount(f);
  return n;
}

/**
 * Repair one object section field by field: keep every candidate field that validates (after
 * tidying), take the rest from `base`. Nested objects (ramps, patterns, buttons) recurse.
 * Returns the merged value, how many leaf fields came from the candidate and how many there are.
 */
function mergeSection(
  schema: z.ZodType,
  candidate: unknown,
  base: unknown,
): { value: unknown; used: number; total: number } {
  const total = leafCount(schema);
  const direct = schema.safeParse(candidate);
  if (direct.success) return { value: direct.data, used: total, total };
  if (schema instanceof z.ZodObject && isObject(candidate) && isObject(base)) {
    const shape = schema.shape as Record<string, z.ZodType>;
    const out: Record<string, unknown> = {};
    let used = 0;
    for (const [k, fieldSchema] of Object.entries(shape)) {
      if (k in candidate) {
        const r = mergeSection(fieldSchema, candidate[k], base[k]);
        out[k] = r.value;
        used += r.used;
      } else out[k] = base[k];
    }
    const whole = schema.safeParse(out);
    if (whole.success) return { value: whole.data, used, total };
  }
  return { value: base, used: 0, total };
}

/**
 * Like `repairLook`, plus `score`: the share (0..1) of the look's leaf fields that came from
 * the candidate (1 = valid as is, 0 = nothing usable). Callers that must tell a real answer
 * from a mostly-defaulted one (GenUI) set a threshold on it.
 */
export function repairLookScored(
  candidate: unknown,
  base: CharacterLook,
): { look: CharacterLook | undefined; score: number } {
  const strict = CharacterLook.safeParse(candidate);
  if (strict.success) return { look: strict.data, score: 1 };
  if (!isObject(candidate)) return { look: undefined, score: 0 };
  const fixed = tidy(candidate) as Record<string, unknown>;
  const out: Record<string, unknown> = { v: LOOK_VERSION };
  let used = 0;
  let total = 0;
  for (const section of LOOK_SECTIONS) {
    if (section === "v") continue;
    const schema = CharacterLook.shape[section] as z.ZodType;
    const r =
      section in fixed
        ? mergeSection(schema, fixed[section], base[section])
        : { value: base[section], used: 0, total: leafCount(schema) };
    out[section] = r.value;
    used += r.used;
    total += r.total;
  }
  if (used === 0) return { look: undefined, score: 0 };
  const r = CharacterLook.safeParse(out);
  return r.success ? { look: r.data, score: used / total } : { look: undefined, score: 0 };
}

/**
 * Validate an untrusted look section by section. Unusable fields/sections fall back to the
 * matching part of `base` (normally `lookFromCatalog` of the same avatar). Returns undefined
 * when nothing in the candidate was usable.
 */
export function repairLook(candidate: unknown, base: CharacterLook): CharacterLook | undefined {
  return repairLookScored(candidate, base).look;
}

const CATALOG_FIELDS = {
  hairStyle: HairStyle,
  hairColor: HairColor,
  skinTone: SkinTone,
  glasses: Glasses,
  facialHair: FacialHair,
  accessory: Accessory,
  outfit: Outfit,
  leftHand: HeldItem,
  rightHand: HeldItem,
  wrist: Wristwear,
  accentColor: AccentColor,
  vehicle: Vehicle,
  deskMess: DeskMess,
} as const;

/** Strict avatar: like AvatarSpec but a bad look is an error (used to detect repairs). */
const StrictAvatar = AvatarSpec.extend({ look: CharacterLook.optional() });

/**
 * Repair an untrusted avatar (model output, stored JSON). Catalog fields are kept one by one
 * when valid, else taken from `previous` (if given) or the seeded avatar; the look is repaired
 * with `repairLook` against the look of the repaired catalog fields. `repaired` is true when
 * anything had to be changed or dropped. Never throws.
 */
export function repairAvatar(
  candidate: unknown,
  seed: string,
  previous?: AvatarSpec,
): { avatar: AvatarSpec; repaired: boolean } {
  const strict = StrictAvatar.safeParse(candidate);
  if (strict.success) return { avatar: strict.data, repaired: false };
  const fallback = previous ?? avatarFromSeed(seed);
  if (!isObject(candidate)) return { avatar: fallback, repaired: true };

  let used = 0;
  const pickField = <K extends keyof typeof CATALOG_FIELDS>(k: K): AvatarSpec[K] => {
    const r = CATALOG_FIELDS[k].safeParse(candidate[k]);
    if (r.success) used++;
    return (r.success ? r.data : fallback[k]) as AvatarSpec[K];
  };
  const catalog: AvatarCatalogSpec = {
    hairStyle: pickField("hairStyle"),
    hairColor: pickField("hairColor"),
    skinTone: pickField("skinTone"),
    glasses: pickField("glasses"),
    facialHair: pickField("facialHair"),
    accessory: pickField("accessory"),
    outfit: pickField("outfit"),
    leftHand: pickField("leftHand"),
    rightHand: pickField("rightHand"),
    wrist: pickField("wrist"),
    accentColor: pickField("accentColor"),
    vehicle: pickField("vehicle"),
    deskProps: fallback.deskProps,
    deskMess: pickField("deskMess"),
  };
  if (Array.isArray(candidate.deskProps)) {
    const props: AvatarSpec["deskProps"] = [];
    for (const p of candidate.deskProps) {
      const r = DeskProp.safeParse(p);
      if (r.success && !props.includes(r.data) && props.length < MAX_DESK_PROPS) props.push(r.data);
    }
    catalog.deskProps = props;
    used++;
  }
  const look =
    candidate.look === undefined ? undefined : repairLook(candidate.look, lookFromCatalog(catalog));
  if (used === 0 && !look) return { avatar: fallback, repaired: true };
  const avatar: AvatarSpec = look ? { ...catalog, look } : catalog;
  return { avatar: AvatarSpec.parse(avatar), repaired: true };
}
