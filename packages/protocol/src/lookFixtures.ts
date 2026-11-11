/**
 * Hand-authored looks for the deterministic (non-AI) path: mocked-provider tests, the web
 * `?look=` parameter, the dev gallery and screenshots.
 *
 * tracht: "Tracht meets streetwear", the acceptance character; its free-text description
 * is fixtures/looks/tracht.description.md.
 */
import tracht from "../fixtures/looks/tracht.json";
import { AvatarSpec } from "./catalog.ts";
import { CharacterLook } from "./look.ts";

/** Strict on purpose: a broken fixture look must fail loudly, not be caught to undefined. */
const WithLook = AvatarSpec.extend({ look: CharacterLook });

export const LOOK_FIXTURES = {
  tracht: WithLook.parse(tracht),
} as const;
export type LookFixtureName = keyof typeof LOOK_FIXTURES;
