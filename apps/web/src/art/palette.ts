/**
 * Named Endesga 32 colors. Every pixel the renderer draws comes from this list
 * (plus transparency), which is what keeps the office looking like one piece.
 */
import { PALETTE } from "@agent-office/protocol";

export const C = {
  rust: PALETTE[0],
  clay: PALETTE[1],
  cream: PALETTE[2],
  sand: PALETTE[3],
  wood: PALETTE[4],
  bark: PALETTE[5],
  cocoa: PALETTE[6],
  wine: PALETTE[7],
  red: PALETTE[8],
  orange: PALETTE[9],
  amber: PALETTE[10],
  lemon: PALETTE[11],
  leaf: PALETTE[12],
  moss: PALETTE[13],
  forest: PALETTE[14],
  pine: PALETTE[15],
  navy: PALETTE[16],
  sky: PALETTE[17],
  cyan: PALETTE[18],
  white: PALETTE[19],
  silver: PALETTE[20],
  grey: PALETTE[21],
  slate: PALETTE[22],
  dusk: PALETTE[23],
  ink: PALETTE[24],
  night: PALETTE[25],
  neon: PALETTE[26],
  plum: PALETTE[27],
  berry: PALETTE[28],
  pink: PALETTE[29],
  peach: PALETTE[30],
  tan: PALETTE[31],
} as const;

export type Hex = (typeof PALETTE)[number];

/** Outline color used for every sprite. */
export const OUTLINE = C.night;

/** "#rrggbb" -> 0xrrggbb for Pixi tints. */
export function hexNum(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}
