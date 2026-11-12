import { describe, expect, test } from "bun:test";
import * as E from "@agent-office/protocol";
import {
  AGENT_PALETTES,
  AGENTS,
  type AvatarSpec,
  avatarFromSeed,
  type CharacterLook,
  lookFromCatalog,
  sessionVariation,
} from "@agent-office/protocol";
import { LOOK_FIXTURES } from "@agent-office/protocol/fixtures";
import { mix } from "../src/art/avatar/color.ts";
import { ANIM, FH, FW, SPECS } from "../src/art/avatar/geometry.ts";
import { RefCache } from "../src/art/avatar/refCache.ts";
import { lookFor } from "../src/art/avatar/renderLook.ts";
import { paintSheet } from "../src/art/avatar/sheet.ts";
import { PixelCanvas } from "../src/art/pixel.ts";

const hex = (v: number) =>
  `#${[v & 255, (v >> 8) & 255, (v >> 16) & 255].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

/** Colour counts of one frame, optionally limited to rows y0..y1. */
function colours(pc: PixelCanvas, frame: number, y0 = 0, y1 = FH - 1): Map<string, number> {
  const m = new Map<string, number>();
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < FW; x++) {
      const v = pc.data[y * pc.width + frame * FW + x]!;
      if (v >>> 24 === 0) continue;
      const h = hex(v);
      m.set(h, (m.get(h) ?? 0) + 1);
    }
  }
  return m;
}

const frameBytes = (pc: PixelCanvas, frame: number) => {
  const out: number[] = [];
  for (let y = 0; y < FH; y++)
    for (let x = 0; x < FW; x++) out.push(pc.data[y * pc.width + frame * FW + x]!);
  return out.join(",");
};

describe("HD character painter", () => {
  const tracht = LOOK_FIXTURES.tracht;
  const sheet = paintSheet(lookFor(tracht, "claude", null));
  const front = colours(sheet, 0);

  test("sheet is 36 frames of 32×48 texels", () => {
    expect(SPECS.length).toBe(36);
    expect(sheet.width).toBe(36 * 32);
    expect(sheet.height).toBe(48);
  });

  test("tracht front frame shows the look's key colours", () => {
    const L = tracht.look!;
    expect(front.get(L.outer.collarColor)).toBeGreaterThan(0); // forest-green stand-up collar
    expect(front.get(L.shoes.accent)).toBeGreaterThan(0); // navy heel tab / collar
    expect(front.get(L.bottoms.embroidery.color)).toBeGreaterThan(0); // green embroidery
    expect(front.get(L.outer.buttons.color) ?? 0).toBeGreaterThanOrEqual(5); // horn buttons
    expect(front.get(L.outer.buttons.rim as string)).toBeGreaterThan(0);
    // lenses: the lens colour itself or the lens/eye mix
    const lensish = [...front.keys()].filter((h) => h === L.eyewear.lens || h.startsWith("#8"));
    expect(front.get(L.eyewear.lens)).toBeGreaterThan(0);
    expect(lensish.length).toBeGreaterThan(0);
    expect(front.get(L.eyewear.frame)).toBeGreaterThan(0);
    expect(front.get(L.eyewear.frameAccent)).toBeGreaterThan(0); // tortoiseshell speckles
    expect(front.get(L.bottoms.embroidery.stitching as string)).toBeGreaterThan(0);
    expect(front.get("#ffffff")).toBeGreaterThan(0); // teeth / sneaker soles
    // olive piping/buttons (dark trim is lifted a touch toward white, same hue)
    const piping = L.vest.piping as string;
    const lifted = mix(piping, "#ffffff", 0.16);
    expect((front.get(piping) ?? 0) + (front.get(lifted) ?? 0)).toBeGreaterThan(4);
    expect(front.get(mix(L.vest.buttons.color, "#ffffff", 0.28))).toBeGreaterThanOrEqual(2);
    expect(front.get(L.hair.ramp.light)).toBeGreaterThan(0); // sheen
  });

  test("bare legs: skin texels in the leg rows", () => {
    const legs = colours(sheet, 0, 38, 41);
    const skin = tracht.look!.skin;
    expect((legs.get(skin.base) ?? 0) + (legs.get(skin.shadow) ?? 0)).toBeGreaterThan(3);
  });

  test("agent shows as chest badge + back patch when the jacket keeps its own colour", () => {
    const p = AGENT_PALETTES.codex;
    const sheet = paintSheet(lookFor(tracht, "codex", null));
    const c = colours(sheet, 0);
    expect(c.get(p.main)).toBe(12); // 4×4 badge, light 2×2 corner
    expect(c.get(p.light)).toBe(4);
    // from behind: the wide patch across the shoulders (what you see at the desk)
    const back = colours(sheet, ANIM.sitType[0]!);
    expect((back.get(p.main) ?? 0) + (back.get(p.light) ?? 0)).toBeGreaterThan(30);
    // not on the jacket itself
    expect(c.get(tracht.look!.outer.ramp.base)).toBeGreaterThan(20);
  });

  test("catalog looks (agentColored) wear the agent palette on the jacket", () => {
    for (const agent of AGENTS) {
      const p = AGENT_PALETTES[agent];
      const c = colours(paintSheet(lookFor(avatarFromSeed("anna"), agent, null)), 0, 24, 35);
      expect(c.get(p.main)).toBeGreaterThan(30);
      expect(c.get(p.shade)).toBeGreaterThan(5);
    }
  });

  test("deterministic", () => {
    const a = paintSheet(lookFor(tracht, "claude", sessionVariation("s1")));
    const b = paintSheet(lookFor(tracht, "claude", sessionVariation("s1")));
    expect(Buffer.from(a.data.buffer).equals(Buffer.from(b.data.buffer))).toBe(true);
  });

  test("2-texel #181425 outline around the silhouette", () => {
    // left of the first opaque texel on a torso row there are two outline texels
    const y = 30;
    let x = 0;
    while (x < FW && sheet.data[y * sheet.width + x]! >>> 24 === 0) x++;
    expect(hex(sheet.data[y * sheet.width + x]!)).toBe("#181425");
    expect(hex(sheet.data[y * sheet.width + x + 1]!)).toBe("#181425");
  });

  test("right-facing frames mirror the left-facing ones", () => {
    for (const [i, s] of SPECS.entries()) {
      if (s.mirror === undefined) continue;
      for (let y = 0; y < FH; y++)
        for (let x = 0; x < FW; x++)
          expect(sheet.data[y * sheet.width + i * FW + x]).toBe(
            sheet.data[y * sheet.width + s.mirror * FW + (FW - 1 - x)]!,
          );
    }
  });

  test("every enum value paints without throwing and changes the look", () => {
    // a plain probe: short hair, no glasses or hat, so face details aren't covered
    const cat = lookFromCatalog(avatarFromSeed("probe"));
    const base: CharacterLook = {
      ...cat,
      hair: { ...cat.hair, cut: "buzz" },
      eyewear: { ...cat.eyewear, style: "none" },
      headwear: { ...cat.headwear, style: "none" },
      facialHair: { ...cat.facialHair, style: "none" },
      // closed, so the closed-front details of every outer kind / pocket are visible
      outer: { ...cat.outer, open: false },
    };
    const baseSpec: AvatarSpec = { ...avatarFromSeed("probe"), look: base };
    const baseFrames = [0, 10, 30]
      .map((f) => frameBytes(paintSheet(lookFor(baseSpec, "pi", null)), f))
      .join("|");
    const variants: [string, (l: CharacterLook, v: string) => CharacterLook, readonly string[]][] =
      [
        ["build", (l, v) => ({ ...l, build: v as never }), E.BUILDS],
        ["face.shape", (l, v) => ({ ...l, face: { ...l.face, shape: v as never } }), E.FACE_SHAPES],
        ["face.ears", (l, v) => ({ ...l, face: { ...l.face, ears: v as never } }), E.EARS],
        ["face.eyes", (l, v) => ({ ...l, face: { ...l.face, eyes: v as never } }), E.EYES],
        ["face.brows", (l, v) => ({ ...l, face: { ...l.face, brows: v as never } }), E.BROWS],
        [
          "face.expression",
          (l, v) => ({ ...l, face: { ...l.face, expression: v as never } }),
          E.EXPRESSIONS,
        ],
        ["face.cheeks", (l, v) => ({ ...l, face: { ...l.face, cheeks: v as never } }), E.CHEEKS],
        ["hair.cut", (l, v) => ({ ...l, hair: { ...l.hair, cut: v as never } }), E.HAIR_CUTS],
        [
          "facialHair",
          (l, v) => ({ ...l, facialHair: { ...l.facialHair, style: v as never } }),
          E.FACIAL_HAIR_STYLES,
        ],
        [
          "eyewear",
          (l, v) => ({ ...l, eyewear: { ...l.eyewear, style: v as never } }),
          E.EYEWEAR_STYLES,
        ],
        [
          "headwear",
          (l, v) => ({ ...l, headwear: { ...l.headwear, style: v as never } }),
          E.HEADWEAR_STYLES,
        ],
        [
          "earrings",
          (l, v) => ({ ...l, earrings: { ...l.earrings, style: v as never } }),
          E.EARRING_STYLES,
        ],
        [
          "shirt.kind",
          (l, v) => ({
            ...l,
            outer: { ...l.outer, kind: "none" },
            shirt: { ...l.shirt, kind: v as never },
          }),
          E.SHIRT_KINDS,
        ],
        [
          "shirt.collar",
          (l, v) => ({
            ...l,
            outer: { ...l.outer, kind: "none" },
            shirt: { ...l.shirt, collar: v as never },
          }),
          E.COLLARS,
        ],
        [
          "shirt.neckwear",
          (l, v) => ({
            ...l,
            outer: { ...l.outer, kind: "none" },
            shirt: { ...l.shirt, neckwear: v as never, neckwearColor: "#e43b44" },
          }),
          E.NECKWEAR,
        ],
        [
          "shirt.sleeves",
          (l, v) => ({
            ...l,
            outer: { ...l.outer, kind: "none" },
            shirt: { ...l.shirt, sleeves: v as never },
          }),
          E.SLEEVES,
        ],
        [
          "vest.kind",
          (l, v) => ({
            ...l,
            outer: { ...l.outer, kind: "none" },
            vest: {
              ...l.vest,
              kind: v as never,
              ramp: { base: "#5a6988", shadow: "#3a4466", light: "#8b9bb4" },
            },
          }),
          E.VEST_KINDS,
        ],
        [
          "outer.kind",
          (l, v) => ({ ...l, outer: { ...l.outer, kind: v as never } }),
          E.OUTER_KINDS,
        ],
        [
          "outer.length",
          (l, v) => ({ ...l, outer: { ...l.outer, length: v as never } }),
          E.OUTER_LENGTHS,
        ],
        [
          "outer.pockets",
          (l, v) => ({ ...l, outer: { ...l.outer, pockets: v as never } }),
          E.POCKETS,
        ],
        [
          "outer.collar",
          (l, v) => ({ ...l, outer: { ...l.outer, collar: v as never, collarColor: "#e43b44" } }),
          E.COLLARS,
        ],
        [
          "bottoms.kind",
          (l, v) => ({ ...l, bottoms: { ...l.bottoms, kind: v as never } }),
          E.BOTTOM_KINDS,
        ],
        ["bottoms.hem", (l, v) => ({ ...l, bottoms: { ...l.bottoms, hem: v as never } }), E.HEMS],
        [
          "bottoms.suspenders",
          (l, v) => ({
            ...l,
            outer: { ...l.outer, kind: "none" },
            bottoms: { ...l.bottoms, suspenders: v as never, suspendersColor: "#e43b44" },
          }),
          E.SUSPENDERS,
        ],
        [
          "bottoms.embroidery",
          (l, v) => ({
            ...l,
            bottoms: {
              ...l.bottoms,
              kind: "lederhosen",
              embroidery: { motif: v as never, color: "#e43b44", stitching: "none" },
            },
          }),
          E.EMBROIDERY_MOTIFS,
        ],
        [
          "legwear",
          (l, v) => ({
            ...l,
            bottoms: { ...l.bottoms, kind: "shorts" },
            legwear: { ...l.legwear, kind: v as never, color: "#e43b44" },
          }),
          E.LEGWEAR_KINDS,
        ],
        ["shoes", (l, v) => ({ ...l, shoes: { ...l.shoes, kind: v as never } }), E.SHOE_KINDS],
        ["pose.hands", (l, v) => ({ ...l, pose: { ...l.pose, hands: v as never } }), E.HAND_POSES],
        [
          "pattern",
          (l, v) => ({
            ...l,
            outer: { ...l.outer, kind: "none" },
            shirt: { ...l.shirt, pattern: { kind: v as never, a: "#e43b44", b: "#0099db" } },
          }),
          E.PATTERN_KINDS,
        ],
      ];
    const same: string[] = [];
    for (const [name, apply, values] of variants) {
      const seen = new Map<string, string>();
      for (const v of values) {
        const spec: AvatarSpec = { ...baseSpec, look: apply(base, v) };
        const pc = paintSheet(lookFor(spec, "pi", null));
        const key = [0, 10, 30].map((f) => frameBytes(pc, f)).join("|");
        const prev = seen.get(key);
        if (prev !== undefined) same.push(`${name}: ${prev} = ${v}`);
        else seen.set(key, v);
      }
    }
    // every value of an enum draws a different character
    expect(same).toEqual([]);
    expect(baseFrames.length).toBeGreaterThan(0);
  });
});

// ---- random valid looks -------------------------------------------------------------------------
function randomLook(rnd: () => number): CharacterLook {
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
  const hx = () =>
    `#${Math.floor(rnd() * 0xffffff)
      .toString(16)
      .padStart(6, "0")}`;
  const opt = () => (rnd() < 0.3 ? ("none" as const) : hx());
  const ramp = () => ({ base: hx(), shadow: hx(), light: hx() });
  const pattern = () => ({ kind: pick(E.PATTERN_KINDS), a: hx(), b: opt() });
  const buttons = () => ({
    count: Math.floor(rnd() * 9),
    color: hx(),
    rim: opt(),
    size: pick(E.BUTTON_SIZES),
    layout: pick(E.BUTTON_LAYOUTS),
  });
  const bool = () => rnd() < 0.5;
  return E.CharacterLook.parse({
    v: 1,
    build: pick(E.BUILDS),
    skin: ramp(),
    face: {
      shape: pick(E.FACE_SHAPES),
      ears: pick(E.EARS),
      eyes: pick(E.EYES),
      eyeColor: hx(),
      brows: pick(E.BROWS),
      expression: pick(E.EXPRESSIONS),
      cheeks: pick(E.CHEEKS),
    },
    hair: { cut: pick(E.HAIR_CUTS), ramp: ramp(), sheen: bool() },
    facialHair: { style: pick(E.FACIAL_HAIR_STYLES), color: hx() },
    eyewear: {
      style: pick(E.EYEWEAR_STYLES),
      frame: hx(),
      frameAccent: hx(),
      framePattern: pick(E.FRAME_PATTERNS),
      lens: hx(),
      tint: pick(E.LENS_TINTS),
    },
    headwear: { style: pick(E.HEADWEAR_STYLES), ramp: ramp(), accent: hx() },
    earrings: { style: pick(E.EARRING_STYLES), color: hx() },
    shirt: {
      kind: pick(E.SHIRT_KINDS),
      ramp: ramp(),
      pattern: pattern(),
      collar: pick(E.COLLARS),
      collarColor: opt(),
      neckwear: pick(E.NECKWEAR),
      neckwearColor: hx(),
      sleeves: pick(E.SLEEVES),
      buttons: buttons(),
      peeksAtWaist: bool(),
    },
    vest: {
      kind: pick(E.VEST_KINDS),
      ramp: ramp(),
      pattern: pattern(),
      collar: pick(E.COLLARS),
      piping: opt(),
      buttons: buttons(),
    },
    outer: {
      kind: pick(E.OUTER_KINDS),
      agentColored: bool(),
      ramp: ramp(),
      pattern: pattern(),
      open: bool(),
      length: pick(E.OUTER_LENGTHS),
      collar: pick(E.COLLARS),
      collarColor: opt(),
      collarPiping: opt(),
      piping: opt(),
      buttons: buttons(),
      pockets: pick(E.POCKETS),
      pocketPiping: opt(),
      yoke: bool(),
    },
    bottoms: {
      kind: pick(E.BOTTOM_KINDS),
      ramp: ramp(),
      pattern: pattern(),
      flap: bool(),
      embroidery: { motif: pick(E.EMBROIDERY_MOTIFS), color: hx(), stitching: opt() },
      buttons: buttons(),
      suspenders: pick(E.SUSPENDERS),
      suspendersColor: hx(),
      belt: opt(),
      hem: pick(E.HEMS),
    },
    legwear: { kind: pick(E.LEGWEAR_KINDS), color: hx(), accent: opt() },
    shoes: { kind: pick(E.SHOE_KINDS), ramp: ramp(), sole: hx(), accent: opt(), laces: opt() },
    pose: { hands: pick(E.HAND_POSES), stance: pick(E.STANCES), headTilt: bool() },
  });
}

describe("painter robustness", () => {
  test("random valid looks never paint outside their frame", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const proto = PixelCanvas.prototype;
    const origSet = proto.set;
    const origPut = proto.put;
    const bad = new Map<string, number>();
    const check = (pc: PixelCanvas, x: number, y: number) => {
      const c = pc.clip;
      if (!c) return; // the head scratch canvas is frame-sized
      const px = x + pc.ox;
      const py = y + pc.oy;
      if (px < c.x0 || px >= c.x1 || py < c.y0 || py >= c.y1) {
        const k = `frame ${pc.ox / FW}: x=${x} y=${y}`;
        bad.set(k, (bad.get(k) ?? 0) + 1);
      }
    };
    proto.set = function (this: PixelCanvas, x, y, h, a) {
      check(this, x, y);
      origSet.call(this, x, y, h, a);
    };
    proto.put = function (this: PixelCanvas, x, y, v) {
      check(this, x, y);
      origPut.call(this, x, y, v);
    };
    try {
      for (let i = 0; i < 300; i++) {
        const avatar: AvatarSpec = { ...avatarFromSeed(`fz${i}`), look: randomLook(rnd) };
        const agent = AGENTS[Math.floor(rnd() * AGENTS.length)]!;
        paintSheet(lookFor(avatar, agent, rnd() < 0.5 ? sessionVariation(`s${i}`) : null));
      }
    } finally {
      proto.set = origSet;
      proto.put = origPut;
    }
    expect([...bad.keys()].slice(0, 10)).toEqual([]);
  });

  test("the clip keeps a frame's paint out of its neighbours", () => {
    const pc = new PixelCanvas(64, 4);
    pc.at(32, 0);
    pc.clip = { x0: 32, y0: 0, x1: 64, y1: 4 };
    pc.rect(-4, 0, 40, 4, "#ff0000");
    expect(pc.data.slice(0, 32).every((v) => v === 0)).toBe(true);
    expect(pc.get(0, 0)).not.toBe(0);
  });
});

describe("period costume details", () => {
  const BTN = "#ff00ff";
  const cat = lookFromCatalog(avatarFromSeed("probe"));
  const coat = (layout?: "single" | "double"): AvatarSpec => ({
    ...avatarFromSeed("probe"),
    look: {
      ...cat,
      vest: { ...cat.vest, kind: "none" },
      outer: {
        ...cat.outer,
        kind: "coat",
        open: false,
        collar: "none",
        agentColored: false,
        buttons: { count: 4, color: BTN, rim: "none", size: "small", layout },
      },
    },
  });
  /** x columns that hold a button texel in the front frame */
  const buttonColumns = (spec: AvatarSpec) => {
    const pc = paintSheet(lookFor(spec, "claude", null));
    const xs = new Set<number>();
    for (let y = 0; y < FH; y++)
      for (let x = 0; x < FW; x++) if (hex(pc.data[y * pc.width + x]!) === BTN) xs.add(x);
    return [...xs].sort((a, b) => a - b);
  };

  test("a coat without a layout stays double-breasted, as stored looks expect", () => {
    expect(buttonColumns(coat())).toEqual([13, 18]);
  });

  test("a closed pocketed coat without a layout is pixel-identical to before layout existed", () => {
    // checksums of the whole sheet, taken with the renderer on main before `buttons.layout`
    // (the coat's two rows paint before the pockets; the kangaroo pocket overlaps them)
    const pinned = {
      flap: "18220713474339190478",
      patch: "13129392932855950928",
      welt: "17037330845477448801",
      kangaroo: "5311935334456398411",
    } as const;
    for (const [pockets, sum] of Object.entries(pinned)) {
      const spec = coat();
      spec.look = {
        ...spec.look!,
        outer: {
          ...spec.look!.outer,
          collar: cat.outer.collar,
          pockets: pockets as never,
          pocketPiping: BTN,
          buttons: { count: 4, color: "#e8b53a", rim: "none", size: "small" },
        },
      };
      const s = paintSheet(lookFor(spec, "claude", null));
      const bytes = new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.byteLength);
      expect(`${pockets} ${Bun.hash(bytes)}`).toBe(`${pockets} ${sum}`);
    }
  });

  test("layout single puts one row of buttons down the centre", () => {
    expect(buttonColumns(coat("single"))).toEqual([15]);
  });

  test("layout double gives two rows on a closed jacket too", () => {
    const spec = coat("double");
    spec.look = { ...spec.look!, outer: { ...spec.look!.outer, kind: "jacket" } };
    expect(buttonColumns(spec)).toEqual([13, 18]);
  });

  test("the skull is a held item that paints bone white", () => {
    const extras = { leftHand: "none", rightHand: "none", costume: "none", wrist: "none" } as const;
    const spec = (hand: "none" | "skull"): AvatarSpec => ({
      ...avatarFromSeed("probe"),
      look: { ...cat, extras: { ...extras, leftHand: hand, accent: "#2ce8f5" } },
    });
    const without = colours(paintSheet(lookFor(spec("none"), "claude", null)), 0);
    const withSkull = colours(paintSheet(lookFor(spec("skull"), "claude", null)), 0);
    const cream = E.PALETTE[2];
    expect(withSkull.get(cream) ?? 0).toBeGreaterThan(without.get(cream) ?? 0);
  });

  test("the flip cut parts in the middle and flips out past the bob", () => {
    const spec = (cut: "bob" | "flip"): AvatarSpec => ({
      ...avatarFromSeed("probe"),
      look: { ...cat, headwear: { ...cat.headwear, style: "none" }, hair: { ...cat.hair, cut } },
    });
    const width = (s: AvatarSpec) => {
      const pc = paintSheet(lookFor(s, "claude", null));
      let lo = FW;
      let hi = -1;
      for (let y = 0; y < 26; y++)
        for (let x = 0; x < FW; x++)
          if (pc.data[y * pc.width + x]! >>> 24 !== 0) {
            lo = Math.min(lo, x);
            hi = Math.max(hi, x);
          }
      return hi - lo;
    };
    expect(width(spec("flip"))).toBeGreaterThan(width(spec("bob")));
  });
});

describe("sheet reference counting", () => {
  test("shared while held, disposed at zero", () => {
    const made: string[] = [];
    const gone: string[] = [];
    const cache = new RefCache<{ k: string }>(
      (k) => {
        made.push(k);
        return { k };
      },
      (v) => gone.push(v.k),
    );
    const a1 = cache.acquire("a");
    const a2 = cache.acquire("a");
    const b = cache.acquire("b");
    expect(a1).toBe(a2);
    expect(made).toEqual(["a", "b"]);
    expect(cache.refs("a")).toBe(2);
    cache.release(a1);
    expect(gone).toEqual([]);
    cache.release(a2);
    expect(gone).toEqual(["a"]);
    cache.release(a2); // double release of a dead value is ignored
    cache.release(b);
    expect(gone).toEqual(["a", "b"]);
    expect(cache.size).toBe(0);
    // a fresh acquire after disposal builds again
    expect(cache.acquire("a")).not.toBe(a1);
  });
});
