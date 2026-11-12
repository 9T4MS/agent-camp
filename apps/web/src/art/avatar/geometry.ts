/**
 * Frame table and body geometry of the HD characters.
 *
 * Frames are 32×48 texels (2× density) and shown at 16×24 world px. Texel rows, standing:
 *   head 6-23 (hair may rise to ~2), torso 24-35, waistband 31, legs split at 38,
 *   feet on row 43, outline rows 44-45 (world row 22, as in the 1× sheet).
 * Seated frames move head + torso 6 texels down (3 world px, as before).
 */
export const FW = 32;
export const FH = 48;

export type View = "down" | "up" | "left";
export type Seat = "none" | "back" | "front";
export type Arms =
  | "down"
  | "type0"
  | "type1"
  | "book0"
  | "book1"
  | "raise0"
  | "raise1"
  | "wave0"
  | "wave1"
  | "rest";
export type FrameSpec = {
  view: View;
  seat: Seat;
  /** walk phase 0..3 */
  phase: number;
  arms: Arms;
  /** breathing bob in texels (head + torso move down) */
  bob: number;
  /** standing idle front frame: the look's pose (hands, stance, head tilt) applies */
  posed?: boolean;
  /** frame index this one mirrors (walk/idle right) */
  mirror?: number;
  /** bowing: the head drops this many texels more than the torso */
  bow?: number;
};

const F = (view: View, seat: Seat, phase: number, arms: Arms, bob = 0): FrameSpec => ({
  view,
  seat,
  phase,
  arms,
  bob,
});

export const SPECS: FrameSpec[] = [
  /* 0 */ { ...F("down", "none", 0, "down"), posed: true },
  /* 1 */ { ...F("down", "none", 0, "down", 1), posed: true },
  /* 2-5 walk down */ F("down", "none", 0, "down"),
  F("down", "none", 1, "down"),
  F("down", "none", 2, "down"),
  F("down", "none", 3, "down"),
  /* 6-9 walk up */ F("up", "none", 0, "down"),
  F("up", "none", 1, "down"),
  F("up", "none", 2, "down"),
  F("up", "none", 3, "down"),
  /* 10-13 walk left */ F("left", "none", 0, "down"),
  F("left", "none", 1, "down"),
  F("left", "none", 2, "down"),
  F("left", "none", 3, "down"),
  /* 14-17 walk right (mirrors) */ { ...F("left", "none", 0, "down"), mirror: 10 },
  { ...F("left", "none", 1, "down"), mirror: 11 },
  { ...F("left", "none", 2, "down"), mirror: 12 },
  { ...F("left", "none", 3, "down"), mirror: 13 },
  /* 18-19 sit typing */ F("up", "back", 0, "type0"),
  F("up", "back", 0, "type1"),
  /* 20-21 sit reading */ F("up", "back", 0, "book0"),
  F("up", "back", 0, "book1"),
  /* 22-23 sit idle */ F("up", "back", 0, "down"),
  F("up", "back", 0, "down", 1),
  /* 24-25 raise hand */ F("down", "front", 0, "raise0"),
  F("down", "front", 0, "raise1"),
  /* 26-27 wave */ F("down", "none", 0, "wave0"),
  F("down", "none", 0, "wave1"),
  /* 28-29 sit front */ F("down", "front", 0, "rest"),
  F("down", "front", 0, "rest", 1),
  /* 30 idle up */ F("up", "none", 0, "down"),
  /* 31 idle left */ F("left", "none", 0, "down"),
  /* 32 idle right */ { ...F("left", "none", 0, "down"), mirror: 31 },
  /* 33-34 busy standing (arcade, whiteboard) */ F("up", "none", 0, "type0"),
  F("up", "none", 0, "type1"),
  /* 35 bowing, seen from behind */ { ...F("up", "none", 0, "down", 2), bow: 4 },
];

export const ANIM = {
  idleDown: [0, 1],
  walkDown: [2, 3, 4, 5],
  walkUp: [6, 7, 8, 9],
  walkLeft: [10, 11, 12, 13],
  walkRight: [14, 15, 16, 17],
  sitType: [18, 19],
  sitRead: [20, 21],
  sitIdle: [22, 23],
  raiseHand: [24, 25],
  wave: [26, 27],
  sitFront: [28, 29],
  idleUp: [30],
  idleLeft: [31],
  idleRight: [32],
  play: [33, 34],
  bow: [35],
} as const;
export type AnimName = keyof typeof ANIM;

/** Seated frames: head and torso sit this many texels lower. */
export const SEAT_DROP = 6;

/** Standing rows (texels). */
export const ROW = {
  headTop: 6,
  chin: 23,
  torsoTop: 24,
  waist: 31,
  hip: 35,
  split: 38,
  feet: 43,
} as const;
