import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PARTY_LOOK,
  PARTY_HEADWEAR,
  PARTY_ITEMS,
  PARTY_OUTFITS,
  PARTY_VEHICLES,
  PARTY_WRISTS,
  type PartyLook,
} from "@agent-office/protocol";
import { partyPixels } from "../src/art/party.ts";

const signature = (look: PartyLook) => Array.from(partyPixels(look).data).join(",");

describe("party art catalog", () => {
  test("every advertised costume and item produces distinct visible pixels", () => {
    const slots = [
      ["headwear", PARTY_HEADWEAR],
      ["wrist", PARTY_WRISTS],
      ["outfit", PARTY_OUTFITS],
      ["item", PARTY_ITEMS],
      ["vehicle", PARTY_VEHICLES],
    ] as const;
    for (const [slot, entries] of slots) {
      const signatures = new Set(
        entries.map(({ id }) => signature({ ...DEFAULT_PARTY_LOOK, [slot]: id })),
      );
      expect(signatures.size).toBe(entries.length);
    }
  });

  test("cat ears, neon bracelets and a held item remain visible together", () => {
    const cat: PartyLook = {
      ...DEFAULT_PARTY_LOOK,
      headwear: "cat-ears",
      wrist: "neon-cyan",
      outfit: "cat",
      item: "confetti",
    };
    const full = partyPixels(cat).data;
    for (const [slot, value] of [
      ["headwear", "none"],
      ["wrist", "none"],
      ["outfit", "classic"],
      ["item", "none"],
    ] as const) {
      const without = partyPixels({ ...cat, [slot]: value }).data;
      expect(full.some((pixel, index) => pixel !== without[index])).toBe(true);
    }
  });
});
