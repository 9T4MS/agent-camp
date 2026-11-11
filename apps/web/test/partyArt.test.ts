import { describe, expect, test } from "bun:test";
import {
  ACCENT_COLORS,
  ACCESSORIES,
  type AvatarSpec as Avatar,
  AvatarSpec,
  avatarFromSeed,
  HELD_ITEMS,
  OUTFITS,
  VEHICLES,
  WRISTWEAR,
} from "@agent-office/protocol";
import { lookFor, lookKey, paintSheet } from "../src/art/characters.ts";
import { vehiclePixels } from "../src/art/party.ts";

const base = {
  ...avatarFromSeed("schobes"),
  accessory: "none" as const,
  leftHand: "none" as const,
  rightHand: "none" as const,
};
const signature = (avatar: Avatar) =>
  Array.from(paintSheet(lookFor(avatar, "codex", null)).data).join(",");
const frame = (avatar: Avatar, index: number) => {
  const sheet = paintSheet(lookFor(avatar, "codex", null));
  const pixels: number[] = [];
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 16; x++) pixels.push(sheet.data[y * sheet.width + index * 16 + x]!);
  return pixels.join(",");
};

describe("integrated avatar costumes", () => {
  test("each catalog option has distinct paper-doll artwork", () => {
    for (const [slot, entries] of [
      ["accessory", ACCESSORIES],
      ["outfit", OUTFITS],
      ["leftHand", HELD_ITEMS],
      ["rightHand", HELD_ITEMS],
      ["wrist", WRISTWEAR],
    ] as const) {
      expect(new Set(entries.map(({ id }) => signature({ ...base, [slot]: id }))).size).toBe(
        entries.length,
      );
    }
    expect(
      new Set(
        ACCENT_COLORS.map(({ id }) =>
          signature({ ...base, leftHand: "lightsaber", accentColor: id }),
        ),
      ).size,
    ).toBe(ACCENT_COLORS.length);
    expect(
      new Set(
        VEHICLES.map(({ id }) =>
          Array.from(vehiclePixels({ ...base, vehicle: id }).data).join(","),
        ),
      ).size,
    ).toBe(VEHICLES.length);
  });

  test("cat ears and neon bands remain visible across front, back, side and seated frames", () => {
    for (const index of [0, 6, 10, 14, 18, 24])
      for (const [slot, value] of [
        ["accessory", "cat-ears"],
        ["wrist", "neon-pink"],
        ["outfit", "cat"],
      ] as const) {
        expect(frame({ ...base, [slot]: value }, index)).not.toBe(frame(base, index));
      }
  });

  test("held items remain visible in either hand while facing away and sitting", () => {
    for (const hand of ["leftHand", "rightHand"] as const)
      for (const item of HELD_ITEMS.filter((e) => e.id !== "none"))
        for (const index of [0, 6, 10, 14, 18]) {
          expect(frame({ ...base, [hand]: item.id }, index)).not.toBe(frame(base, index));
        }
  });

  test("old avatar payloads receive neutral defaults", () => {
    const { wrist: _w, accentColor: _a, vehicle: _v, ...legacy } = avatarFromSeed("anna");
    const parsed = AvatarSpec.parse(legacy);
    expect([parsed.wrist, parsed.accentColor, parsed.vehicle]).toEqual(["none", "cyan", "none"]);
    expect(lookKey(lookFor(parsed, "codex", null))).not.toBe(
      lookKey(lookFor({ ...parsed, wrist: "rainbow" }, "codex", null)),
    );
  });

  test("all 35 frames of existing seeded avatars retain their pixel checksums", () => {
    for (const [seed, expected] of [
      ["anna", 1623323173],
      ["schobes", 4133589489],
      ["martin", 1253257105],
    ] as const) {
      const p = paintSheet(lookFor(avatarFromSeed(seed), "codex", null));
      let hash = 2166136261;
      for (const pixel of p.data) hash = Math.imul(hash ^ pixel, 16777619) >>> 0;
      expect(hash).toBe(expected);
    }
  });
});
