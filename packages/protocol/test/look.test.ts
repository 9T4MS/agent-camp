import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCENT_COLORS,
  ACCESSORIES,
  type AvatarCatalogSpec,
  AvatarSpec,
  avatarFromSeed,
  CharacterLook,
  COSTUME_KINDS,
  catalogAvatar,
  envelope,
  HAIR_COLORS,
  HAIR_CUTS,
  HairStyle,
  HELD_ITEMS,
  HELD_KINDS,
  LOOK_SECTIONS,
  lookFromCatalog,
  MAX_SELF_DESCRIPTION,
  normalizeHex,
  OUTFITS,
  Outfit,
  parseConnectorMessage,
  parseViewerMessage,
  repairAvatar,
  repairLook,
  repairLookScored,
  resolveLook,
  SHORT_SELF_DESCRIPTION,
  SKIN_TONES,
  WRIST_KINDS,
  WRISTWEAR,
} from "../src/index.ts";
import { LOOK_FIXTURES } from "../src/lookFixtures.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
const tracht = LOOK_FIXTURES.tracht;
const clone = <T>(x: T): T => structuredClone(x);

describe("lookFromCatalog", () => {
  test("valid and deterministic for 300 seeds", () => {
    for (let i = 0; i < 300; i++) {
      const a = avatarFromSeed(`person-${i}`);
      const look = lookFromCatalog(a);
      expect(CharacterLook.parse(look)).toEqual(look);
      expect(lookFromCatalog(a)).toEqual(look);
    }
  });

  test("reproduces today's catalog colours", () => {
    const a = {
      ...avatarFromSeed("anna"),
      hairColor: "auburn",
      skinTone: "deep",
      glasses: "none",
    } as const;
    const look = lookFromCatalog(a);
    const hc = HAIR_COLORS.find((c) => c.id === "auburn")!;
    const sk = SKIN_TONES.find((c) => c.id === "deep")!;
    expect(look.hair.ramp).toEqual({ base: hc.hex, shadow: hc.shade, light: hc.light });
    expect(look.skin).toEqual({ base: sk.hex, shadow: sk.shade, light: sk.light });
    expect(look.face.cheeks).toBe("none"); // no blush on deep skin, as today
    expect(lookFromCatalog({ ...a, skinTone: "light" }).face.cheeks).toBe("blush");
    expect(look.outer).toMatchObject({ kind: "jacket", agentColored: true, open: true });
    expect(look.shirt.ramp.base).toBe("#ffffff");
    expect(look.bottoms.ramp).toMatchObject({ base: "#3a4466", shadow: "#262b44" });
    expect(look.shoes.ramp.base).toBe("#3e2731");
    expect(look.eyewear.style).toBe("none");
    expect(look.pose).toEqual({ hands: "relaxed", stance: "neutral", headTilt: false });
  });

  test("maps every catalog hair style, glasses and accessory", () => {
    const a = avatarFromSeed("x");
    for (const s of HairStyle.options) {
      expect(HAIR_CUTS).toContain(lookFromCatalog({ ...a, hairStyle: s }).hair.cut);
      expect(lookFromCatalog({ ...a, hairStyle: s }).hair.cut).toBe(s);
    }
    expect(lookFromCatalog({ ...a, glasses: "round" }).eyewear).toMatchObject({
      style: "round",
      frame: "#5a6988",
      tint: "clear",
    });
    expect(lookFromCatalog({ ...a, glasses: "sunglasses" }).eyewear).toMatchObject({
      style: "rectangle",
      lens: "#181425",
      tint: "dark",
    });
    expect(lookFromCatalog({ ...a, accessory: "beanie" }).headwear.ramp.base).toBe("#68386c");
    expect(lookFromCatalog({ ...a, accessory: "cap" }).headwear.ramp.base).toBe("#265c42");
    expect(lookFromCatalog({ ...a, accessory: "bow" }).headwear.style).toBe("bow");
    expect(lookFromCatalog({ ...a, accessory: "headphones" }).headwear.style).toBe("headphones");
    expect(lookFromCatalog({ ...a, accessory: "earring" }).earrings).toEqual({
      style: "stud",
      color: "#feae34",
    });
    expect(lookFromCatalog({ ...a, accessory: "earring" }).headwear.style).toBe("none");
  });

  test("resolveLook prefers avatar.look", () => {
    expect(resolveLook(tracht)).toBe(tracht.look);
    const plain = avatarFromSeed("anna");
    expect(resolveLook(plain)).toEqual(lookFromCatalog(plain));
  });

  test("avatarFromSeed output has no look", () => {
    expect("look" in avatarFromSeed("anna")).toBe(false);
  });
});

describe("lookFromCatalog: look editor items (#11 and later)", () => {
  const a = avatarFromSeed("tom");
  const of = (extra: Partial<AvatarCatalogSpec>) => lookFromCatalog({ ...a, ...extra });

  test("every outfit maps to its own layers and colours", () => {
    const jacket = of({ outfit: "jacket" });
    expect(jacket).toEqual(lookFromCatalog(a)); // the original look
    expect(jacket.outer).toMatchObject({ kind: "jacket", agentColored: true, open: true });
    expect(jacket.shirt).toMatchObject({ kind: "tshirt", sleeves: "long" });
    expect(jacket.shirt.ramp.base).toBe("#ffffff");

    expect(of({ outfit: "hoodie" }).outer).toMatchObject({
      kind: "hoodie", // pullover, no zip (as on main)
      agentColored: true,
      collar: "hood",
      pockets: "kangaroo",
    });

    const flannel = of({ outfit: "flannel" });
    expect(flannel.outer).toMatchObject({
      kind: "jacket",
      agentColored: false, // own colours: the agent shows as badge + back patch
      open: true,
      collar: "shirt",
      ramp: { base: "#8b9bb4", shadow: "#5a6988", light: "#c0cbdc" },
      pattern: { kind: "plaid", a: "#ffffff", b: "#3a4466" },
    });
    expect(flannel.shirt).toMatchObject({ kind: "tshirt", ramp: { base: "#262b44" } }); // navy tee

    const red = of({ outfit: "flannel-red" });
    expect(red.outer).toMatchObject({
      open: true,
      agentColored: false,
      ramp: { base: "#e43b44", shadow: "#a22633" },
      pattern: { kind: "plaid", a: "#f6757a", b: "#181425" },
    });

    const tee = of({ outfit: "tee" });
    expect(tee.outer.kind).toBe("none");
    expect(tee.shirt).toMatchObject({
      kind: "tshirt",
      sleeves: "short",
      ramp: { base: "#3a4466" },
    });

    for (const costume of ["cat", "robot", "astronaut", "pirate", "vampire", "disco"] as const) {
      const l = of({ outfit: costume });
      expect(l.outer).toMatchObject({ kind: "jacket", agentColored: false, open: false });
      expect(l.extras?.costume).toBe(costume);
    }
    // every outfit is a different look, and none is a costume unless it is one
    const looks = OUTFITS.map(({ id }) => JSON.stringify(of({ outfit: id })));
    expect(new Set(looks).size).toBe(OUTFITS.length);
    for (const o of ["jacket", "hoodie", "flannel", "flannel-red", "tee"] as const)
      expect(of({ outfit: o }).extras?.costume).toBe("none");
  });

  test("every held item lands in the matching hand", () => {
    for (const { id } of HELD_ITEMS) {
      expect(of({ leftHand: id }).extras).toMatchObject({ leftHand: id, rightHand: "none" });
      expect(of({ rightHand: id }).extras).toMatchObject({ leftHand: "none", rightHand: id });
    }
    expect(of({}).extras).toEqual({
      leftHand: "none",
      rightHand: "none",
      costume: "none",
      wrist: "none",
      accent: "#2ce8f5",
    });
  });

  test("bracelets and accent colours carry over", () => {
    for (const { id } of WRISTWEAR) expect(of({ wrist: id }).extras?.wrist).toBe(id);
    const accents = ACCENT_COLORS.map(({ id }) => of({ accentColor: id }).extras?.accent);
    expect(new Set(accents).size).toBe(ACCENT_COLORS.length);
    expect(of({ accentColor: "pink" }).extras?.accent).toBe("#f6757a");
  });

  test("cap-mint is a mint cap with a white logo, not the default", () => {
    expect(of({ accessory: "cap-mint" }).headwear).toEqual({
      style: "cap",
      ramp: { base: "#2ce8f5", shadow: "#0099db", light: "#ffffff" },
      accent: "#0099db",
      logo: "#ffffff",
    });
    expect(of({ accessory: "cap-mint" }).headwear).not.toEqual(of({ accessory: "none" }).headwear);
    expect(of({ accessory: "cap" }).headwear.logo).toBeUndefined();
  });

  test("every accessory maps to its own headwear or earring", () => {
    const parts = ACCESSORIES.map(({ id }) => {
      const l = of({ accessory: id });
      return JSON.stringify([l.headwear, l.earrings]);
    });
    expect(new Set(parts).size).toBe(ACCESSORIES.length);
    for (const id of ["cat-ears", "halo", "crown", "party-hat", "antenna"] as const)
      expect(of({ accessory: id }).headwear.style).toBe(id);
  });

  test("flannel + beer (the review case): plaid flannel, beer in hand, mint cap", () => {
    const look = of({
      accessory: "cap-mint",
      outfit: "flannel",
      leftHand: "beer",
      rightHand: "joint",
    });
    expect(CharacterLook.parse(look)).toEqual(look);
    expect(look.outer.pattern.kind).toBe("plaid");
    expect(look.outer.open).toBe(true);
    expect(look.extras).toMatchObject({ leftHand: "beer", rightHand: "joint" });
    expect(look.headwear).toMatchObject({ style: "cap", logo: "#ffffff" });
    // not a plain jacket with empty hands
    expect(look.outer).not.toEqual(lookFromCatalog(a).outer);
  });

  test("look id lists match the catalog", () => {
    expect([...HELD_KINDS]).toEqual(HELD_ITEMS.map((e) => e.id));
    expect([...WRIST_KINDS]).toEqual(WRISTWEAR.map((e) => e.id));
    for (const c of COSTUME_KINDS) if (c !== "none") expect(Outfit.options).toContain(c);
  });

  test("resolveLook fills missing extras from the catalog fields", () => {
    const { extras: _e, ...noExtras } = tracht.look;
    const avatar = { ...tracht, leftHand: "coffee", look: noExtras } as const;
    const parsed = AvatarSpec.parse(avatar);
    expect(parsed.look?.extras).toBeUndefined();
    expect(resolveLook(parsed).extras?.leftHand).toBe("coffee");
    expect(resolveLook(parsed).outer).toEqual(tracht.look.outer);
  });

  test("a bad extras section drops only itself", () => {
    const bad = { ...clone(tracht.look), extras: { leftHand: "sword" } };
    const r = CharacterLook.parse(bad);
    expect(r.extras).toBeUndefined();
    expect(r.outer).toEqual(tracht.look.outer);
  });

  test("catalogAvatar drops the detailed look and keeps every id", () => {
    const edited = { ...tracht, outfit: "flannel", leftHand: "beer" } as const;
    const c = catalogAvatar(edited);
    expect("look" in c).toBe(false);
    expect(c).toMatchObject({ outfit: "flannel", leftHand: "beer", hairStyle: tracht.hairStyle });
    expect(resolveLook(c)).toEqual(lookFromCatalog(c));
  });

  test("repairAvatar keeps outfit, hands, wrist, accent and vehicle", () => {
    const candidate = {
      ...avatarFromSeed("x"),
      outfit: "flannel",
      leftHand: "beer",
      rightHand: "joint",
      wrist: "rainbow",
      accentColor: "gold",
      vehicle: "skateboard",
      hairColor: "plaid", // one bad field forces a repair
    };
    const { avatar, repaired } = repairAvatar(candidate, "x");
    expect(repaired).toBe(true);
    expect(avatar).toMatchObject({
      outfit: "flannel",
      leftHand: "beer",
      rightHand: "joint",
      wrist: "rainbow",
      accentColor: "gold",
      vehicle: "skateboard",
    });
  });
});

describe("tracht fixture", () => {
  test("parses strictly and keeps every section", () => {
    const raw = load("looks/tracht") as { look: unknown };
    expect(CharacterLook.parse(raw.look)).toEqual(tracht.look);
    expect(Object.keys(tracht.look)).toEqual(LOOK_SECTIONS);
    expect(tracht.look.outer.agentColored).toBe(false);
    expect(tracht.look.outer.collarColor).toBe("#1f3d2b");
    expect(tracht.look.shoes.accent).toBe("#1e2a44");
  });

  test("description fixture is long and fits the limit", () => {
    const text = readFileSync(join(FIXTURES, "looks", "tracht.description.md"), "utf8");
    expect(text.length).toBeGreaterThan(SHORT_SELF_DESCRIPTION);
    expect(text.length).toBeLessThanOrEqual(MAX_SELF_DESCRIPTION);
    expect(text).toContain("Janker");
  });

  test("avatar.updated fixture carries the tracht look", () => {
    const r = parseViewerMessage(load("avatar.updated"));
    if (!r.ok) throw new Error(r.error);
    if (r.msg.type !== "avatar.updated") throw new Error("wrong type");
    expect(r.msg.data.avatar.look).toEqual(tracht.look);
  });
});

describe("AvatarSpec.look", () => {
  test("a garbage look parses as undefined instead of failing the message", () => {
    const snap = load("office.snapshot") as {
      data: { people: { avatar: Record<string, unknown> }[] };
    };
    expect(snap.data.people.length).toBeGreaterThan(0);
    const bad = clone(snap);
    bad.data.people[0]!.avatar = { ...bad.data.people[0]!.avatar, look: { v: 1, build: "huge" } };
    const r = parseViewerMessage(bad);
    if (!r.ok) throw new Error(r.error);
    if (r.msg.type !== "office.snapshot") throw new Error("wrong type");
    expect(r.msg.data.people[0]!.avatar.look).toBeUndefined();

    const m = load("avatar.updated") as { data: { avatar: Record<string, unknown> } };
    for (const look of [42, "tracht", null, [], { v: 2 }]) {
      const r2 = parseViewerMessage({
        ...m,
        data: { ...m.data, avatar: { ...m.data.avatar, look } },
      });
      expect(r2.ok).toBe(true);
      if (r2.ok && r2.msg.type === "avatar.updated")
        expect(r2.msg.data.avatar.look).toBeUndefined();
    }
  });

  test("a catalog-only avatar (old servers) still parses", () => {
    const a = avatarFromSeed("anna");
    expect(AvatarSpec.parse(a)).toEqual(a);
  });
});

describe("normalizeHex", () => {
  test("accepts short, missing #, any case; rejects junk", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("abc")).toBe("#aabbcc");
    expect(normalizeHex(" 1F3D2B ")).toBe("#1f3d2b");
    expect(normalizeHex("#1f3d2b")).toBe("#1f3d2b");
    for (const bad of ["", "#12", "#12345", "#gggggg", "red", "none", 0x123456, null, undefined]) {
      expect(normalizeHex(bad)).toBeNull();
    }
  });
});

describe("repairLook", () => {
  const base = lookFromCatalog(tracht);

  test("a valid look comes back unchanged", () => {
    expect(repairLook(tracht.look, base)).toEqual(tracht.look);
  });

  test("fixes hex spelling and clamps button counts", () => {
    const c = clone(tracht.look) as unknown as Record<string, Record<string, unknown>>;
    c.outer!.collarColor = "1F3D2B";
    (c.outer!.buttons as Record<string, unknown>).count = 12;
    (c.vest!.buttons as Record<string, unknown>).count = 7.6;
    (c.skin as Record<string, unknown>).base = "#FC9";
    c.shirt!.collarColor = "None";
    const r = repairLook(c, base)!;
    expect(r.outer.collarColor).toBe("#1f3d2b");
    expect(r.outer.buttons.count).toBe(8);
    expect(r.vest.buttons.count).toBe(8);
    expect(r.skin.base).toBe("#ffcc99");
    expect(r.shirt.collarColor).toBe("none");
    expect(r.outer.kind).toBe("janker");
  });

  test("bad fields/sections fall back to the base look, good ones are kept", () => {
    const c = clone(tracht.look) as unknown as Record<string, unknown>;
    c.shoes = "white sneakers"; // whole section unusable
    (c.bottoms as Record<string, unknown>).kind = "kilt"; // one bad field
    delete (c as Record<string, unknown>).pose; // missing section
    c.build = "huge";
    c.v = 3;
    const r = repairLook(c, base)!;
    expect(CharacterLook.safeParse(r).success).toBe(true);
    expect(r.v).toBe(1);
    expect(r.shoes).toEqual(base.shoes);
    expect(r.pose).toEqual(base.pose);
    expect(r.build).toBe(base.build);
    expect(r.bottoms.kind).toBe(base.bottoms.kind);
    expect(r.bottoms.embroidery).toEqual(tracht.look.bottoms.embroidery);
    expect(r.eyewear).toEqual(tracht.look.eyewear);
  });

  test("nothing usable -> undefined", () => {
    for (const junk of [null, 42, "tracht", [], {}, { v: 1 }, { shoes: 1, hair: "x" }]) {
      expect(repairLook(junk, base)).toBeUndefined();
      expect(repairLookScored(junk, base)).toEqual({ look: undefined, score: 0 });
    }
  });

  test("score = share of leaf fields taken from the candidate", () => {
    expect(repairLookScored(tracht.look, base)).toEqual({ look: tracht.look, score: 1 });
    // only `v` and `build` usable: a look comes back, but it is almost all base
    const thin = repairLookScored({ v: 1, build: "slim", shoes: "white" }, base);
    expect(thin.look?.build).toBe("slim");
    expect(thin.score).toBeGreaterThan(0);
    expect(thin.score).toBeLessThan(0.05);
    // one broken section out of many: still mostly the candidate
    const c = clone(tracht.look) as unknown as Record<string, unknown>;
    c.shoes = "white sneakers";
    const most = repairLookScored(c, base);
    expect(most.look?.shoes).toEqual(base.shoes);
    expect(most.score).toBeGreaterThan(0.8);
    expect(most.score).toBeLessThan(1);
  });
});

describe("repairAvatar", () => {
  test("valid avatars pass through unrepaired", () => {
    expect(repairAvatar(tracht, "anna")).toEqual({ avatar: tracht, repaired: false });
    const a = avatarFromSeed("anna");
    expect(repairAvatar(a, "anna")).toEqual({ avatar: a, repaired: false });
  });

  test("garbage -> previous, else seeded", () => {
    expect(repairAvatar("nope", "anna")).toEqual({
      avatar: avatarFromSeed("anna"),
      repaired: true,
    });
    expect(repairAvatar(null, "anna", tracht)).toEqual({ avatar: tracht, repaired: true });
    expect(repairAvatar({ foo: 1 }, "anna", tracht).avatar).toEqual(tracht);
  });

  test("bad catalog fields are replaced one by one; bad look sections repaired", () => {
    const c = clone(tracht) as unknown as Record<string, unknown>;
    c.hairStyle = "slicked-back"; // not a catalog style
    c.deskProps = ["mug", "mug", "unicorn", "plant", "lamp", "books"];
    c.deskMess = 9;
    (c.look as Record<string, unknown>).hair = { cut: "pompadour" };
    const seeded = avatarFromSeed("anna");
    const { avatar, repaired } = repairAvatar(c, "anna");
    expect(repaired).toBe(true);
    expect(AvatarSpec.safeParse(avatar).success).toBe(true);
    expect(avatar.hairStyle).toBe(seeded.hairStyle);
    expect(avatar.hairColor).toBe("brown");
    expect(avatar.deskProps).toEqual(["mug", "plant", "lamp"]);
    expect(avatar.deskMess).toBe(seeded.deskMess);
    expect(avatar.look?.hair).toEqual(lookFromCatalog(avatar).hair);
    expect(avatar.look?.outer).toEqual(tracht.look.outer);
  });

  test("an unusable look is dropped, the catalog part kept", () => {
    const { avatar, repaired } = repairAvatar({ ...tracht, look: "nice" }, "anna");
    expect(repaired).toBe(true);
    expect(avatar.look).toBeUndefined();
    expect(avatar.hairColor).toBe("brown");
  });
});

describe("connector.hello lookDescription", () => {
  const hello = load("connector.hello") as { data: Record<string, unknown> };
  test("fixture carries a >200-char lookDescription next to the 200-char head", () => {
    const d = hello.data as { selfDescription: string; lookDescription: string };
    expect(d.lookDescription.length).toBeGreaterThan(SHORT_SELF_DESCRIPTION);
    expect(d.selfDescription).toBe(d.lookDescription.slice(0, SHORT_SELF_DESCRIPTION));
  });

  test("optional and at most 8000 chars; selfDescription stays at most 200", () => {
    const base = { ...hello.data };
    delete base.lookDescription;
    const mk = (data: Record<string, unknown>) =>
      parseConnectorMessage(envelope("connector.hello", data as never));
    expect(mk(base).ok).toBe(true);
    expect(mk({ ...base, lookDescription: "x".repeat(MAX_SELF_DESCRIPTION) }).ok).toBe(true);
    expect(mk({ ...base, lookDescription: "x".repeat(MAX_SELF_DESCRIPTION + 1) }).ok).toBe(false);
    expect(mk({ ...base, selfDescription: "x".repeat(SHORT_SELF_DESCRIPTION + 1) }).ok).toBe(false);
  });
});
