/** Party actions use the person's real avatar equipment; appearance lives only in AvatarSpec. */
import { z } from "zod";
import { HeldItem, Vehicle } from "./catalog.ts";

const PersonRef = z.string().min(1).max(64);
export const PartyAction = z.enum(["use", "dance", "wave", "high-five", "race", "tag"]);
export type PartyAction = z.infer<typeof PartyAction>;
export const PartyEvent = z.strictObject({
  id: z.string().min(1).max(64),
  personId: PersonRef,
  targetId: PersonRef.optional(),
  action: PartyAction,
  item: HeldItem,
  vehicle: Vehicle,
  at: z.number().int().nonnegative(),
  roll: z.number().int().min(1).max(6).optional(),
});
export type PartyEvent = z.infer<typeof PartyEvent>;
export const PartyState = z.strictObject({
  events: z.array(PartyEvent).max(32),
  scores: z.record(z.string(), z.number().int().nonnegative()),
});
export type PartyState = z.infer<typeof PartyState>;
/** A cached viewer can render newer equipment without dropping the entire office message. */
export const ViewerPartyEvent = PartyEvent.extend({
  item: HeldItem.catch("none"),
  vehicle: Vehicle.catch("none"),
});
export const ViewerPartyState = PartyState.extend({
  events: z.array(ViewerPartyEvent).max(32),
});
export type ViewerPartyState = z.infer<typeof ViewerPartyState>;

export const PartyMutation = z.strictObject({
  personId: PersonRef,
  action: PartyAction,
  targetId: PersonRef.optional(),
  hand: z.enum(["left", "right"]).optional(),
});
export type PartyMutation = z.infer<typeof PartyMutation>;
