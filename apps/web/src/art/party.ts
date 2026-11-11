/** Composable pixel costumes. Coordinates match the 16×24 office paper doll. */
import { avatarFromSeed, type PartyLook } from "@agent-office/protocol";
import { characterSheet, lookFor } from "./characters.ts";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";

export const PARTY_COLORS = {
  cyan: C.cyan,
  pink: C.pink,
  lime: C.neon,
  gold: C.lemon,
  purple: C.berry,
  red: C.red,
} as const;

/** Transparent overlay; anchor at (32, 48), the character's feet. */
export function partyPixels(look: PartyLook): PixelCanvas {
  const p = new PixelCanvas(64, 64).at(24, 24);
  const color = PARTY_COLORS[look.color];
  // Vehicles sit below the body, leaving the agent-colored jacket readable.
  if (look.vehicle === "car") {
    p.round(-8, 19, 32, 8, C.night);
    p.round(-7, 18, 30, 7, color);
    p.rect(-1, 14, 17, 6, color);
    p.rect(1, 15, 6, 4, C.cyan);
    p.rect(9, 15, 5, 4, C.navy);
    p.rect(-4, 24, 5, 5, C.ink);
    p.rect(16, 24, 5, 5, C.ink);
    p.rect(-3, 25, 3, 2, C.silver);
    p.rect(17, 25, 3, 2, C.silver);
    p.rect(21, 20, 2, 2, C.lemon);
  } else if (look.vehicle === "skateboard") {
    p.round(-4, 24, 25, 3, color);
    p.rect(-1, 27, 3, 3, C.ink);
    p.rect(15, 27, 3, 3, C.ink);
    p.hline(-1, 24, 19, C.white);
  } else if (look.vehicle === "hoverboard") {
    p.round(-4, 24, 25, 4, C.navy);
    p.hline(-3, 24, 23, color);
    p.rect(-1, 29, 5, 1, C.cyan);
    p.rect(12, 29, 5, 1, C.pink);
  } else if (look.vehicle === "spaceship") {
    p.ellipse(-8, 17, 32, 10, C.slate);
    p.ellipse(-3, 14, 22, 9, C.cyan);
    p.hline(-5, 24, 27, color);
    for (let x = -3; x < 23; x += 6) p.rect(x, 25, 2, 2, C.lemon);
    p.rect(3, 28, 3, 3, C.orange);
    p.rect(11, 28, 3, 3, C.orange);
  }
  // Costumes replace torso only; facial traits and agent status stay intact.
  switch (look.outfit) {
    case "cat":
      p.round(3, 12, 10, 9, C.slate);
      p.ellipse(5, 13, 6, 7, C.silver);
      p.vline(14, 16, 7, C.slate);
      p.hline(14, 21, 5, C.slate);
      p.vline(18, 18, 4, C.slate);
      p.set(7, 9, C.pink);
      p.hline(1, 8, 4, C.white);
      p.hline(11, 8, 4, C.white);
      p.hline(1, 10, 4, C.white);
      p.hline(11, 10, 4, C.white);
      break;
    case "robot":
      p.rect(3, 12, 10, 9, C.silver);
      p.rect(4, 13, 8, 6, C.slate);
      p.rect(5, 14, 6, 2, color);
      p.rect(5, 17, 2, 1, C.lemon);
      p.rect(9, 17, 2, 1, C.red);
      break;
    case "astronaut":
      p.round(2, 12, 12, 9, C.white);
      p.rect(5, 14, 6, 4, C.navy);
      p.rect(6, 15, 4, 1, color);
      p.rect(1, 14, 2, 6, C.silver);
      p.rect(13, 14, 2, 6, C.silver);
      break;
    case "pirate":
      p.rect(3, 12, 10, 8, C.wine);
      for (let y = 13; y < 20; y += 2) p.hline(5, y, 6, C.white);
      p.hline(3, 19, 10, C.ink);
      p.rect(7, 18, 3, 3, C.amber);
      p.rect(5, 7, 3, 2, C.ink);
      break;
    case "vampire":
      p.rect(2, 11, 12, 10, C.wine);
      p.rect(4, 12, 8, 8, C.night);
      p.rect(6, 12, 4, 6, C.white);
      p.rect(7, 13, 2, 3, C.red);
      p.set(6, 10, C.white);
      p.set(9, 10, C.white);
      break;
    case "disco":
      p.rect(3, 12, 10, 8, color);
      p.rect(6, 12, 4, 7, C.white);
      p.set(4, 14, C.white);
      p.set(11, 17, C.lemon);
      p.hline(2, 21, 5, color);
      p.hline(9, 21, 5, color);
      break;
  }
  // Large ears and silhouettes are readable at normal office zoom, including back-facing seats.
  const ear = (x: number, tall: number, fur: string) => {
    p.rect(x, -tall, 2, tall + 3, C.night);
    p.rect(x - 1, 1 - tall, 4, tall + 1, fur);
    p.rect(x, 2 - tall, 2, tall - 1, C.pink);
  };
  switch (look.headwear) {
    case "cat-ears":
      ear(3, 4, C.slate);
      ear(11, 4, C.slate);
      break;
    case "fox-ears":
      ear(2, 5, C.orange);
      ear(12, 5, C.orange);
      break;
    case "bunny-ears":
      ear(4, 8, C.white);
      ear(10, 8, C.white);
      break;
    case "devil-horns":
      ear(2, 4, C.red);
      ear(12, 4, C.red);
      break;
    case "halo":
      p.ellipse(2, -5, 12, 3, C.lemon);
      p.hline(5, -4, 6, C.white);
      p.set(0, -4, C.amber);
      p.set(15, -4, C.amber);
      break;
    case "crown":
      p.rect(2, -1, 12, 4, C.amber);
      for (const x of [2, 7, 12]) p.rect(x, -4, 2, 5, C.lemon);
      p.set(7, 1, C.red);
      p.set(3, 1, C.sky);
      p.set(12, 1, C.sky);
      break;
    case "wizard-hat":
      for (let y = -7; y < 2; y++) p.hline(7 - Math.floor((y + 7) / 2), y, y + 8, C.berry);
      p.rect(0, 1, 16, 2, C.plum);
      p.set(7, -3, C.lemon);
      p.set(5, -1, C.lemon);
      break;
    case "party-hat":
      for (let y = -7; y < 2; y++) p.hline(7 - Math.floor((y + 7) / 2), y, y + 8, color);
      p.rect(6, -9, 3, 3, C.lemon);
      p.set(7, -3, C.white);
      p.set(4, 0, C.pink);
      p.set(10, 0, C.white);
      break;
    case "antenna":
      p.hline(2, 1, 12, C.slate);
      p.vline(7, -5, 6, C.silver);
      p.rect(6, -7, 3, 3, color);
      break;
  }
  const wrist = look.wrist;
  if (wrist !== "none") {
    const neon =
      wrist === "rainbow"
        ? C.lemon
        : wrist === "neon-pink"
          ? C.pink
          : wrist === "neon-lime"
            ? C.neon
            : C.cyan;
    p.rect(0, 17, 3, 2, neon);
    p.rect(13, 17, 3, 2, neon);
    p.hline(0, 17, 3, C.white);
    p.hline(13, 17, 3, wrist === "rainbow" ? C.pink : C.white);
  }
  switch (look.item) {
    case "lightsaber":
      p.rect(16, 11, 2, 7, C.silver);
      p.rect(15, -4, 4, 16, color);
      p.rect(16, -3, 2, 15, C.white);
      break;
    case "confetti":
      p.rect(14, 12, 8, 5, C.berry);
      p.rect(19, 10, 4, 7, color);
      p.rect(13, 15, 3, 5, C.ink);
      p.set(20, 11, C.white);
      break;
    case "beer":
      p.rect(14, 12, 6, 8, C.amber);
      p.rect(19, 14, 3, 5, C.cream);
      p.rect(20, 15, 1, 3, C.night);
      p.round(13, 10, 8, 4, C.white);
      p.vline(15, 15, 4, C.lemon);
      break;
    case "cigarette":
      p.rect(13, 15, 8, 2, C.white);
      p.rect(13, 15, 2, 2, C.wood);
      p.rect(20, 15, 2, 2, C.orange);
      break;
    case "bubble-wand":
      p.vline(16, 12, 8, C.pink);
      p.ellipse(13, 7, 7, 7, C.cyan);
      p.ellipse(14, 8, 5, 5, C.navy);
      p.set(15, 8, C.white);
      break;
    case "disco-ball":
      p.vline(17, 0, 4, C.silver);
      p.ellipse(12, 3, 11, 11, C.slate);
      for (let y = 4; y < 13; y += 3)
        for (let x = 14; x < 22; x += 3) p.rect(x, y, 2, 2, (x + y) % 2 ? C.cyan : C.white);
      break;
    case "magic-wand":
      p.rect(15, 8, 2, 12, C.plum);
      p.rect(13, 5, 6, 4, C.lemon);
      p.rect(15, 3, 2, 8, C.lemon);
      p.set(15, 6, C.white);
      break;
    case "balloon":
      p.vline(19, 2, 18, C.white);
      p.ellipse(13, -12, 13, 15, color);
      p.rect(16, -10, 2, 4, C.white);
      p.rect(18, 2, 3, 2, color);
      break;
    case "water-pistol":
      p.rect(13, 12, 12, 4, C.sky);
      p.rect(14, 15, 3, 5, C.orange);
      p.rect(16, 9, 6, 4, color);
      p.rect(24, 12, 3, 3, C.cyan);
      break;
    case "maracas":
      p.rect(-2, 14, 2, 6, C.wood);
      p.ellipse(-4, 9, 6, 7, C.red);
      p.hline(-3, 12, 4, C.lemon);
      p.rect(16, 14, 2, 6, C.wood);
      p.ellipse(14, 9, 6, 7, C.neon);
      p.hline(15, 12, 4, C.lemon);
      break;
    case "umbrella":
      p.vline(18, 0, 19, C.silver);
      p.hline(16, 19, 3, C.silver);
      p.ellipse(6, -6, 25, 12, color);
      p.rect(6, 1, 25, 6, "#000000", 0);
      for (const x of [7, 14, 21, 28]) p.vline(x, 0, 2, C.white);
      break;
  }
  return p;
}

export function partyCanvas(look: PartyLook): HTMLCanvasElement {
  return partyPixels(look).toCanvas();
}

/** Standalone dressing-room preview, using the same assets as the world overlay. */
export function partyPortrait(look: PartyLook): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const frame = characterSheet(lookFor(avatarFromSeed("party-preview"), "codex", null)).frames[0]!;
  const source = frame.source.resource as HTMLCanvasElement;
  ctx.drawImage(source, frame.frame.x, frame.frame.y, 16, 24, 24, 24, 16, 24);
  ctx.drawImage(partyCanvas(look), 0, 0);
  return canvas;
}
