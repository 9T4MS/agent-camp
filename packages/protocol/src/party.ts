/** Explicit, combinable wardrobe slots; independent of AI-generated base avatars. */
import { z } from "zod";
import { PersonId } from "./messages.ts";

export const PARTY_HEADWEAR = [
  { id: "none", label: "None" },
  { id: "cat-ears", label: "Cat ears" },
  { id: "fox-ears", label: "Fox ears" },
  { id: "bunny-ears", label: "Bunny ears" },
  { id: "devil-horns", label: "Devil horns" },
  { id: "halo", label: "Halo" },
  { id: "crown", label: "Crown" },
  { id: "wizard-hat", label: "Wizard hat" },
  { id: "party-hat", label: "Party hat" },
  { id: "antenna", label: "Antenna" },
] as const;
export const PARTY_WRISTS = [
  { id: "none", label: "None" },
  { id: "neon-cyan", label: "Neon cyan" },
  { id: "neon-pink", label: "Neon pink" },
  { id: "neon-lime", label: "Neon lime" },
  { id: "rainbow", label: "Rainbow" },
] as const;
export const PARTY_OUTFITS = [
  { id: "classic", label: "Classic" },
  { id: "cat", label: "Cat" },
  { id: "robot", label: "Robot" },
  { id: "astronaut", label: "Astronaut" },
  { id: "pirate", label: "Pirate" },
  { id: "vampire", label: "Vampire" },
  { id: "disco", label: "Disco" },
] as const;
export const PARTY_COLORS = [
  { id: "cyan", label: "Cyan" },
  { id: "pink", label: "Pink" },
  { id: "lime", label: "Lime" },
  { id: "gold", label: "Gold" },
  { id: "purple", label: "Purple" },
  { id: "red", label: "Red" },
] as const;
export const PARTY_ITEMS = [
  { id: "none", label: "None" },
  { id: "lightsaber", label: "Lightsaber" },
  { id: "confetti", label: "Confetti cannon" },
  { id: "beer", label: "Beer" },
  { id: "cigarette", label: "Cigarette" },
  { id: "bubble-wand", label: "Bubble wand" },
  { id: "disco-ball", label: "Disco ball" },
  { id: "magic-wand", label: "Magic wand" },
  { id: "balloon", label: "Balloon" },
  { id: "water-pistol", label: "Water pistol" },
  { id: "maracas", label: "Maracas" },
  { id: "umbrella", label: "Umbrella" },
] as const;
export const PARTY_VEHICLES = [
  { id: "none", label: "None" },
  { id: "car", label: "Car" },
  { id: "skateboard", label: "Skateboard" },
  { id: "hoverboard", label: "Hoverboard" },
  { id: "spaceship", label: "Spaceship" },
] as const;

export const PartyLook = z.strictObject({
  headwear: z.enum(PARTY_HEADWEAR.map((e) => e.id)),
  wrist: z.enum(PARTY_WRISTS.map((e) => e.id)),
  outfit: z.enum(PARTY_OUTFITS.map((e) => e.id)),
  color: z.enum(PARTY_COLORS.map((e) => e.id)),
  item: z.enum(PARTY_ITEMS.map((e) => e.id)),
  vehicle: z.enum(PARTY_VEHICLES.map((e) => e.id)),
});
export type PartyLook = z.infer<typeof PartyLook>;
export const DEFAULT_PARTY_LOOK: PartyLook = {
  headwear: "none",
  wrist: "none",
  outfit: "classic",
  color: "cyan",
  item: "none",
  vehicle: "none",
};
export const PartyAction = z.enum(["use", "dance", "wave", "high-five", "race", "tag"]);
export type PartyAction = z.infer<typeof PartyAction>;
export const PartyEvent = z.strictObject({
  id: z.string().min(1).max(64),
  personId: PersonId,
  targetId: PersonId.optional(),
  action: PartyAction,
  item: PartyLook.shape.item,
  at: z.number().int().nonnegative(),
  roll: z.number().int().min(1).max(6).optional(),
});
export type PartyEvent = z.infer<typeof PartyEvent>;
export const PartyState = z.strictObject({
  profiles: z.record(z.string(), PartyLook),
  events: z.array(PartyEvent).max(32),
  scores: z.record(z.string(), z.number().int().nonnegative()),
});
export type PartyState = z.infer<typeof PartyState>;
export const PartyMutation = z
  .strictObject({
    personId: PersonId,
    look: PartyLook.optional(),
    action: PartyAction.optional(),
    targetId: PersonId.optional(),
  })
  .refine(
    (value) => value.look !== undefined || value.action !== undefined,
    "Choose a look or action",
  );
export type PartyMutation = z.infer<typeof PartyMutation>;
