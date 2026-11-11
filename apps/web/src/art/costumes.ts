/**
 * Costume details, novelty headwear and accent colours, painted at 1× (16×24 frame
 * coordinates). The HD painter doubles them onto its 32×48 frames (art/avatar/extras.ts); the
 * 1× queen head uses them as they are.
 */
import type { AvatarSpec } from "@agent-office/protocol";
import { C } from "./palette.ts";
import type { PixelCanvas } from "./pixel.ts";

type View = "down" | "up" | "left";
const ACCENTS = {
  cyan: C.cyan,
  pink: C.pink,
  lime: C.leaf,
  gold: C.lemon,
  purple: C.berry,
  red: C.red,
} as const;
export const accentHex = (color: AvatarSpec["accentColor"]) => ACCENTS[color];

/** What the costume painters read: the catalog ids plus the accent colour as hex. */
export type CostumeLook = {
  outfit: AvatarSpec["outfit"];
  accessory: AvatarSpec["accessory"];
  accent: string;
};

export function costumeHead(p: PixelCanvas, look: CostumeLook, view: View, dy: number): void {
  if (look.outfit === "cat" && view !== "up") {
    if (view === "down") {
      p.set(7, 9 + dy, C.pink);
      p.hline(2, 9 + dy, 3, C.white);
      p.hline(11, 9 + dy, 3, C.white);
      p.set(3, 10 + dy, C.silver);
      p.set(12, 10 + dy, C.silver);
    } else {
      p.set(3, 9 + dy, C.pink);
      p.hline(2, 10 + dy, 4, C.white);
    }
  }
  if (look.outfit === "pirate" && view !== "up")
    p.hline(view === "down" ? 5 : 4, 7 + dy, 3, C.night);
  if (look.outfit === "vampire" && view !== "up") {
    p.set(6, 10 + dy, C.white);
    if (view === "down") p.set(9, 10 + dy, C.white);
  }
}

export function costumeAccessory(p: PixelCanvas, look: CostumeLook, view: View, dy: number): void {
  const color = look.accent;
  const a = look.accessory;
  const ear = (x: number, height: number, fur: string) => {
    p.vline(x, dy, height, fur);
    p.rect(x - 1, dy + 1, 3, height - 1, fur);
    if (view !== "up") p.vline(x, dy + 2, height - 2, C.pink);
    else p.set(x, dy + height - 1, C.ink);
  };
  switch (a) {
    case "cat-ears":
      ear(view === "left" ? 6 : 3, 5, C.slate);
      ear(view === "left" ? 11 : 12, 5, C.slate);
      break;
    case "fox-ears":
      ear(view === "left" ? 6 : 2, 6, C.orange);
      ear(view === "left" ? 11 : 13, 6, C.orange);
      break;
    case "bunny-ears":
      ear(view === "left" ? 7 : 4, 7, C.white);
      ear(view === "left" ? 10 : 11, 7, C.white);
      break;
    case "devil-horns":
      ear(view === "left" ? 6 : 2, 4, C.red);
      ear(view === "left" ? 11 : 13, 4, C.red);
      break;
    case "halo":
      p.ellipse(3, dy, 10, 3, C.lemon);
      p.hline(5, dy + 1, 6, C.white);
      break;
    case "crown":
      p.rect(3, dy + 2, 10, 3, C.amber);
      for (const x of [3, 7, 11]) p.vline(x, dy, 4, C.lemon);
      p.set(7, dy + 3, view === "up" ? C.lemon : C.red);
      break;
    case "wizard-hat":
      for (let y = 0; y < 5; y++) p.hline(7 - Math.floor(y / 2), dy + y, 1 + y, C.berry);
      p.hline(2, dy + 5, 12, C.plum);
      p.set(7, dy + 3, C.lemon);
      break;
    case "party-hat":
      for (let y = 0; y < 5; y++) p.hline(7 - Math.floor(y / 2), dy + y, 1 + y, color);
      p.set(7, dy, C.lemon);
      p.set(6, dy + 3, C.white);
      p.set(9, dy + 4, C.pink);
      break;
    case "antenna":
      p.hline(3, dy + 4, 10, C.slate);
      p.vline(7, dy + 1, 4, C.silver);
      p.rect(6, dy, 3, 2, color);
      break;
  }
}

export function costumeTorso(
  p: PixelCanvas,
  look: CostumeLook,
  view: View,
  top: number,
  rows: number,
): void {
  const color = look.accent;
  const side = view === "left";
  const x = side ? 5 : 4,
    w = side ? 6 : 8;
  switch (look.outfit) {
    case "cat":
      if (view === "down") p.rect(6, top + 1, 4, Math.max(1, rows - 2), C.silver);
      if (view !== "down") {
        p.vline(12, top + 2, rows + 1, C.slate);
        p.hline(12, top + rows + 2, 3, C.slate);
        p.set(14, top + rows + 1, C.silver);
      }
      break;
    case "robot":
      p.hline(x, top, w, C.white);
      p.hline(x, top + rows - 1, w, C.slate);
      if (view !== "up") {
        p.rect(x + 1, top + 1, 3, 2, color);
        p.set(x + 1, top + rows - 2, C.red);
      } else {
        p.vline(5, top, rows, C.grey);
        p.vline(10, top, rows, C.grey);
      }
      break;
    case "astronaut":
      p.vline(x, top, rows, C.silver);
      p.vline(x + w - 1, top, rows, C.silver);
      if (view === "up") p.rect(6, top, 4, rows - 1, C.slate);
      else {
        p.rect(x + 1, top + 1, 3, 2, C.navy);
        p.hline(x + 1, top + 1, 3, color);
      }
      break;
    case "pirate":
      for (let y = 1; y < rows - 1; y += 2) p.hline(x, top + y, w, C.white);
      p.hline(x, top + rows - 1, w, C.night);
      p.set(x + 2, top + rows - 1, C.amber);
      break;
    case "vampire":
      p.vline(x, top, rows, C.wine);
      p.vline(x + w - 1, top, rows, C.red);
      if (view !== "up") {
        p.rect(x + 2, top, 2, rows - 1, C.white);
        p.set(x + 2, top + 1, C.red);
      }
      break;
    case "disco":
      p.rect(x, top, w, rows - 1, color);
      p.set(x + 1, top + 1, C.white);
      p.set(x + w - 2, top + 3, C.lemon);
      if (view === "down") p.vline(7, top, rows - 1, C.white);
      break;
  }
}
