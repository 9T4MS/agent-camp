/**
 * Detailed character looks ("paper doll" v1).
 *
 * A `CharacterLook` describes one character for the HD (32×48 texel) renderer: free hex
 * colour ramps, many garment/part types, small detail layers (patterns, piping, buttons,
 * embroidery), facial expression and a standing pose. GenUI providers fill it from a free-text
 * description; catalog-only avatars get one from `lookFromCatalog` (avatarLook.ts).
 *
 * Every field is required so strict structured-output schemas can be derived from it.
 * Colours are free `#rrggbb` (characters are the one exception to the Endesga-only palette).
 *
 * Must not import catalog.ts (catalog.ts imports this file).
 */
import { z } from "zod";

export const LOOK_VERSION = 1 as const;

export const Hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .describe("#rrggbb");
export const OptHex = z
  .union([Hex, z.literal("none")])
  .describe('#rrggbb, or "none" = feature absent / same colour as the garment');
export const Ramp = z
  .object({
    base: Hex,
    shadow: Hex.describe("#rrggbb, ~20-30% darker than base, slightly hue-shifted"),
    light: Hex.describe("#rrggbb, ~15-20% lighter than base"),
  })
  .describe("3-step colour ramp");
export type Ramp = z.infer<typeof Ramp>;

export const PATTERN_KINDS = [
  "none",
  "dots",
  "pinstripe",
  "stripes",
  "check",
  "plaid",
  "damask",
  "floral",
  "heather",
  "worn",
  "camo",
] as const;
export const Pattern = z
  .object({
    kind: z
      .enum(PATTERN_KINDS)
      .describe(
        'fabric pattern; "worn" = blotchy patina (a = lighter patches, b = darker patches)',
      ),
    a: Hex.describe("#rrggbb main motif colour"),
    b: OptHex.describe('#rrggbb second motif colour, or "none"'),
  })
  .describe("pattern drawn over the garment ramp");
export type Pattern = z.infer<typeof Pattern>;

export const BUTTON_SIZES = ["small", "large"] as const;
export const MAX_BUTTONS = 8;
export const Buttons = z
  .object({
    count: z.number().int().min(0).max(MAX_BUTTONS).describe("number of visible buttons, 0-8"),
    color: Hex,
    rim: OptHex.describe('#rrggbb rim/edge colour of each button, or "none"'),
    size: z.enum(BUTTON_SIZES),
  })
  .describe("button row");
export type Buttons = z.infer<typeof Buttons>;

/** torso width -1/0/+1 texel per side */
export const BUILDS = ["slim", "average", "broad"] as const;
export const FACE_SHAPES = ["round", "oval", "narrow", "square"] as const;
export const EARS = ["hidden", "small", "visible"] as const;
/** happy = ^^ closed */
export const EYES = ["dot", "round", "narrow", "happy"] as const;
/** colour = hair.ramp.shadow */
export const BROWS = ["none", "thin", "thick"] as const;
/** grin = wide open smile showing upper teeth */
export const EXPRESSIONS = [
  "neutral",
  "smile",
  "big-smile",
  "grin",
  "smirk",
  "serious",
  "surprised",
] as const;
export const CHEEKS = ["none", "blush", "freckles"] as const;
export const HAIR_CUTS = [
  "bald",
  "buzz",
  "short",
  "slicked-back",
  "side-part",
  "curly",
  "afro",
  "bob",
  "long",
  "ponytail",
  "bun",
  "mohawk",
] as const;
export const FACIAL_HAIR_STYLES = ["none", "stubble", "mustache", "goatee", "beard"] as const;
export const EYEWEAR_STYLES = [
  "none",
  "round",
  "panto",
  "square",
  "rectangle",
  "aviator",
  "cat-eye",
] as const;
/** tortoiseshell = speckles of frameAccent */
export const FRAME_PATTERNS = ["solid", "tortoiseshell"] as const;
/** light = eyes faintly visible through lens colour; dark = opaque */
export const LENS_TINTS = ["clear", "light", "dark"] as const;
export const HEADWEAR_STYLES = [
  "none",
  "beanie",
  "cap",
  "cap-backwards",
  "bucket-hat",
  "felt-hat",
  "headband",
  "bow",
  "headphones",
  // novelty headwear (catalog accessories of the same name, look editor / party)
  "cat-ears",
  "fox-ears",
  "bunny-ears",
  "devil-horns",
  "halo",
  "crown",
  "wizard-hat",
  "party-hat",
  "antenna",
] as const;
export const EARRING_STYLES = ["none", "stud", "hoop"] as const;
export const SHIRT_KINDS = [
  "tshirt",
  "longsleeve",
  "shirt",
  "trachten-shirt",
  "polo",
  "hoodie",
  "sweater",
  "turtleneck",
  "blouse",
  "tank",
] as const;
export const COLLARS = [
  "none",
  "crew",
  "v-neck",
  "shirt",
  "stand-up",
  "polo",
  "hood",
  "turtleneck",
  "lapel",
  "shawl",
] as const;
export const NECKWEAR = ["none", "tie", "bow-tie", "scarf", "bandana"] as const;
export const SLEEVES = ["short", "long", "rolled"] as const;
export const VEST_KINDS = [
  "none",
  "waistcoat",
  "trachten-vest",
  "sweater-vest",
  "puffer-vest",
] as const;
export const OUTER_KINDS = [
  "none",
  "jacket",
  "blazer",
  "janker",
  "cardigan",
  "zip-hoodie",
  "hoodie",
  "denim-jacket",
  "leather-jacket",
  "bomber",
  "coat",
  "lab-coat",
] as const;
export const OUTER_LENGTHS = ["cropped", "waist", "hip", "thigh"] as const;
export const POCKETS = ["none", "flap", "patch", "welt", "kangaroo"] as const;
export const BOTTOM_KINDS = [
  "trousers",
  "jeans",
  "chinos",
  "joggers",
  "shorts",
  "lederhosen",
  "kneebund-lederhosen",
  "skirt",
  "dress",
  "overalls",
] as const;
export const EMBROIDERY_MOTIFS = ["none", "vine", "oak-leaf", "edelweiss", "geometric"] as const;
export const SUSPENDERS = ["none", "plain", "h-bridge"] as const;
export const HEMS = ["plain", "cuffed", "rolled", "lacing", "frayed", "flared"] as const;
/** none = bare legs (skin) */
export const LEGWEAR_KINDS = [
  "none",
  "ankle-socks",
  "crew-socks",
  "knee-socks",
  "loferl",
  "tights",
] as const;
export const SHOE_KINDS = [
  "sneakers",
  "high-tops",
  "boots",
  "loafers",
  "haferl",
  "sandals",
  "heels",
  "slippers",
] as const;
/** hand-in-pocket = viewer's-left arm (the character's right) */
export const HAND_POSES = [
  "relaxed",
  "hand-in-pocket",
  "hands-in-pockets",
  "hands-on-hips",
  "arms-crossed",
] as const;
export const STANCES = ["neutral", "wide"] as const;

// ---- extras: things from the look editor catalog (same ids as catalog.ts) ------------------
/** Something held in a hand (catalog `HELD_ITEMS`). */
export const HELD_KINDS = [
  "none",
  "beer",
  "joint",
  "phone",
  "coffee",
  "lightsaber",
  "confetti",
  "cigarette",
  "bubble-wand",
  "disco-ball",
  "magic-wand",
  "balloon",
  "water-pistol",
  "maracas",
  "umbrella",
] as const;
/** Costume details drawn over the clothes (catalog outfits that are costumes). */
export const COSTUME_KINDS = [
  "none",
  "cat",
  "robot",
  "astronaut",
  "pirate",
  "vampire",
  "disco",
] as const;
/** Bracelets (catalog `WRISTWEAR`). */
export const WRIST_KINDS = ["none", "neon-cyan", "neon-pink", "neon-lime", "rainbow"] as const;

export const Extras = z
  .object({
    leftHand: z
      .enum(HELD_KINDS)
      .describe("held in the hand on the viewer's left in the front view; none = empty"),
    rightHand: z.enum(HELD_KINDS).describe("held in the other hand; none = empty"),
    costume: z.enum(COSTUME_KINDS).describe("costume details over the clothes; none = no costume"),
    wrist: z.enum(WRIST_KINDS).describe("bracelets on both wrists; none = no bracelets"),
    accent: Hex.describe(
      "#rrggbb accent colour of coloured held items (lightsaber, balloon, umbrella), the party hat and costume lights",
    ),
  })
  .describe("held items, costume details, bracelets: none unless the description asks for them");
export type Extras = z.infer<typeof Extras>;

export const CharacterLook = z.object({
  v: z.literal(LOOK_VERSION),
  build: z.enum(BUILDS).describe("body width: slim / average / broad"),
  skin: Ramp,
  face: z.object({
    shape: z.enum(FACE_SHAPES),
    ears: z.enum(EARS),
    eyes: z.enum(EYES).describe('eye shape; "happy" = closed ^^ eyes'),
    eyeColor: Hex,
    brows: z.enum(BROWS).describe("eyebrows, drawn in hair.ramp.shadow"),
    expression: z
      .enum(EXPRESSIONS)
      .describe('mouth; "grin" = wide open smile showing the upper teeth'),
    cheeks: z.enum(CHEEKS),
  }),
  hair: z.object({
    cut: z.enum(HAIR_CUTS),
    ramp: Ramp,
    sheen: z.boolean().describe("small light highlight streak in the hair"),
  }),
  facialHair: z.object({ style: z.enum(FACIAL_HAIR_STYLES), color: Hex }),
  eyewear: z.object({
    style: z.enum(EYEWEAR_STYLES),
    frame: Hex,
    frameAccent: Hex.describe("#rrggbb speckle colour for tortoiseshell frames"),
    framePattern: z
      .enum(FRAME_PATTERNS)
      .describe("tortoiseshell = frame speckled with frameAccent"),
    lens: Hex,
    tint: z
      .enum(LENS_TINTS)
      .describe(
        "clear = plain glasses; light = tinted, eyes faintly visible through the lens colour; dark = opaque sunglasses",
      ),
  }),
  headwear: z.object({
    style: z.enum(HEADWEAR_STYLES),
    ramp: Ramp,
    accent: Hex.describe(
      "#rrggbb secondary colour: beanie pompom, cap brim, hat band, headband stripe, bow knot, headphones band",
    ),
    /** added later: missing in stored looks; a bad value is dropped, not the whole look */
    logo: OptHex.optional()
      .catch(undefined)
      .describe('#rrggbb small logo on the front of a cap, or "none"'),
  }),
  earrings: z.object({ style: z.enum(EARRING_STYLES), color: Hex }),
  shirt: z.object({
    kind: z.enum(SHIRT_KINDS),
    ramp: Ramp,
    pattern: Pattern,
    collar: z.enum(COLLARS),
    collarColor: OptHex,
    neckwear: z.enum(NECKWEAR),
    neckwearColor: Hex,
    sleeves: z.enum(SLEEVES),
    buttons: Buttons,
    peeksAtWaist: z
      .boolean()
      .describe("a strip of the shirt shows below the vest/jacket at the waist"),
  }),
  vest: z.object({
    kind: z.enum(VEST_KINDS),
    ramp: Ramp,
    pattern: Pattern,
    collar: z.enum(COLLARS),
    piping: OptHex.describe('#rrggbb trim along the vest edges, or "none"'),
    buttons: Buttons,
  }),
  outer: z.object({
    kind: z.enum(OUTER_KINDS),
    agentColored: z
      .boolean()
      .describe(
        "true = draw this garment in the coding agent's colour (use when no outer-garment colour is stated); false = keep ramp and show the agent colour as an armband/badge",
      ),
    ramp: Ramp,
    pattern: Pattern,
    open: z.boolean().describe("worn open (the layers underneath show down the front)"),
    length: z.enum(OUTER_LENGTHS),
    collar: z.enum(COLLARS),
    collarColor: OptHex,
    collarPiping: OptHex.describe('#rrggbb thin trim along the collar edge, or "none"'),
    piping: OptHex.describe('#rrggbb trim along the front edges/hem, or "none"'),
    buttons: Buttons,
    pockets: z.enum(POCKETS),
    pocketPiping: OptHex,
    yoke: z.boolean().describe("yoke seam across the shoulders (visible from behind)"),
  }),
  bottoms: z.object({
    kind: z.enum(BOTTOM_KINDS),
    ramp: Ramp,
    pattern: Pattern,
    flap: z.boolean().describe("drop-front flap (lederhosen Hosentürl)"),
    embroidery: z.object({
      motif: z.enum(EMBROIDERY_MOTIFS),
      color: Hex,
      stitching: OptHex.describe('#rrggbb decorative outline stitching, or "none"'),
    }),
    buttons: Buttons,
    suspenders: z.enum(SUSPENDERS),
    suspendersColor: Hex,
    belt: OptHex.describe('#rrggbb belt colour, or "none" = no belt'),
    hem: z.enum(HEMS),
  }),
  legwear: z.object({
    kind: z.enum(LEGWEAR_KINDS).describe('"none" = bare legs (skin)'),
    color: Hex,
    accent: OptHex.describe('#rrggbb stripe/cuff colour, or "none"'),
  }),
  shoes: z.object({
    kind: z.enum(SHOE_KINDS),
    ramp: Ramp,
    sole: Hex,
    accent: OptHex.describe('#rrggbb heel tab / collar / logo colour, or "none"'),
    laces: OptHex,
  }),
  pose: z.object({
    hands: z
      .enum(HAND_POSES)
      .describe(
        "standing pose of the arms; hand-in-pocket = the character's right hand (viewer's left) in the trouser pocket",
      ),
    stance: z.enum(STANCES).describe("wide = feet shoulder-width apart, toes out"),
    headTilt: z.boolean().describe("head tilted very slightly"),
  }),
  /**
   * Added later (look editor items): missing in stored looks. Without it the renderer takes
   * them from the avatar's catalog fields (`resolveLook`). A bad value drops only this section.
   */
  extras: Extras.optional().catch(undefined),
});
export type CharacterLook = z.infer<typeof CharacterLook>;

/** Top-level sections of a look ("v", "build", "skin", "face", …), in schema order. */
export const LOOK_SECTIONS = Object.keys(CharacterLook.shape) as (keyof CharacterLook)[];
