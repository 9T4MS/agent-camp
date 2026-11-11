/**
 * What the painter draws: a CharacterLook (avatar.look, or derived from the catalog fields)
 * with the per-session variation applied, plus the agent colour and how to show it.
 */
import {
  AGENT_PALETTES,
  type AgentKind,
  type AvatarSpec,
  type CharacterLook,
  type Ramp,
  resolveLook,
  type SessionVariation,
} from "@agent-office/protocol";
import { luma, mix, NIGHT } from "./color.ts";

const HAT_OK = new Set<CharacterLook["headwear"]["style"]>(["none", "headphones", "bow"]);

export type RenderLook = {
  /** the look with the session variation applied */
  look: CharacterLook;
  agent: AgentKind;
  /** the agent's colour ramp (AGENT_PALETTES) */
  agentRamp: Ramp;
  /** draw the agent colour as chest badge + back patch (outer garment keeps its own colour) */
  accent: boolean;
  /** sibling session: little hat */
  hat: boolean;
  /** sibling session: carries a mug */
  mug: boolean;
};

export function agentRampOf(agent: AgentKind): Ramp {
  const p = AGENT_PALETTES[agent];
  return { base: p.main, shadow: p.shade, light: p.light };
}

/** Does this look wear the agent colour on its outer garment? Otherwise: badge + back patch. */
export const agentOnOuter = (l: CharacterLook) => l.outer.kind !== "none" && l.outer.agentColored;

export function lookFor(
  avatar: AvatarSpec,
  agent: AgentKind,
  variation: SessionVariation | null,
): RenderLook {
  const base = resolveLook(avatar);
  const agentRamp = agentRampOf(agent);
  let look = base;
  const h = base.hair.ramp;
  if (variation?.hairShade === 1) {
    look = {
      ...look,
      hair: { ...look.hair, ramp: { base: h.light, shadow: h.base, light: h.light } },
    };
  } else if (variation?.hairShade === -1 && luma(h.shadow) > 0.12) {
    // one step darker; never down to the outline colour (black hair stays black)
    look = {
      ...look,
      hair: {
        ...look.hair,
        ramp: { base: h.shadow, shadow: mix(h.shadow, NIGHT, 0.4), light: h.base },
      },
    };
  }
  if (agentOnOuter(look)) look = { ...look, outer: { ...look.outer, ramp: agentRamp } };
  return {
    look,
    agent,
    agentRamp,
    accent: !agentOnOuter(look),
    // as before: the little hat replaces headphones and sits next to a bow; other headwear wins
    hat: !!variation?.hat && HAT_OK.has(look.headwear.style),
    // hands already full: no session mug
    mug:
      !!variation?.mug &&
      (look.extras?.leftHand ?? "none") === "none" &&
      (look.extras?.rightHand ?? "none") === "none",
  };
}

/** Sheet cache key. */
export const renderKey = (r: RenderLook) => JSON.stringify(r);
