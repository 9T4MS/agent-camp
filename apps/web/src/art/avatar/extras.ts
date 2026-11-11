/**
 * Look-editor items on the HD doll: held items, bracelets, costume details and novelty
 * headwear (`CharacterLook.extras`, headwear styles like cat-ears). They reuse the 1× art the
 * look editor introduced (legacyDoll.ts drawHeld/drawWrist, costumes.ts): painted at 1× into a
 * scratch canvas and doubled onto the 32×48 frame, so every item keeps the shape and colours
 * it had. Thin things (joint, cigarette, smoke) are queued in `c.after` and painted after the
 * outline, as before.
 */
import type { CharacterLook } from "@agent-office/protocol";
import { type CostumeLook, costumeAccessory, costumeHead, costumeTorso } from "../costumes.ts";
import { type After, drawHeld, drawWrist } from "../legacyDoll.ts";
import { PixelCanvas } from "../pixel.ts";
import type { Ctx } from "./ctx.ts";
import type { Arms, View } from "./geometry.ts";
import type { TorsoBox } from "./torso.ts";

type Held = NonNullable<CharacterLook["extras"]>["leftHand"];

/** Accent colour when a look has no extras (the catalog default, cyan). */
const DEFAULT_ACCENT = "#2ce8f5";

/** 1× scratch with a margin, so items may stick out of the 16×24 frame a little. */
const M = 4;
const scratch = new PixelCanvas(16 + 2 * M, 24 + 2 * M);

/**
 * Paint `paint` at 1× (16×24 frame coordinates) and double it onto `pc`, shifted by (ox, oy)
 * texels. Offset and clip of `pc` apply, so it stays inside the current frame.
 */
export function overlay1x(
  pc: PixelCanvas,
  ox: number,
  oy: number,
  paint: (p: PixelCanvas) => void,
): void {
  scratch.data.fill(0);
  scratch.at(M, M);
  paint(scratch);
  scratch.at(0, 0);
  const W = scratch.width;
  for (let y = 0; y < scratch.height; y++)
    for (let x = 0; x < W; x++) {
      const v = scratch.data[y * W + x]!;
      if (v >>> 24 === 0) continue;
      const tx = 2 * (x - M) + ox;
      const ty = 2 * (y - M) + oy;
      pc.put(tx, ty, v);
      pc.put(tx + 1, ty, v);
      pc.put(tx, ty + 1, v);
      pc.put(tx + 1, ty + 1, v);
    }
}

/** What the 1× costume painters read, from a CharacterLook. */
export function costumeLook(L: CharacterLook): CostumeLook {
  const style = L.headwear.style;
  const novelty =
    style === "cat-ears" ||
    style === "fox-ears" ||
    style === "bunny-ears" ||
    style === "devil-horns" ||
    style === "halo" ||
    style === "crown" ||
    style === "wizard-hat" ||
    style === "party-hat" ||
    style === "antenna";
  const costume = L.extras?.costume ?? "none";
  return {
    outfit: costume === "none" ? "jacket" : costume,
    accessory: novelty ? style : "none",
    accent: L.extras?.accent ?? DEFAULT_ACCENT,
  };
}

/** Costume face details (whiskers, eye patch, fangs), head row `hy`. */
export function drawCostumeHead(pc: PixelCanvas, L: CharacterLook, view: View, hy: number) {
  if ((L.extras?.costume ?? "none") === "none") return;
  overlay1x(pc, 0, hy, (p) => costumeHead(p, costumeLook(L), view, 0));
}

/** Novelty headwear (ears, horns, halo, crown, hats, antenna), head row `hy`. */
export function drawNoveltyHeadwear(pc: PixelCanvas, L: CharacterLook, view: View, hy: number) {
  const look = costumeLook(L);
  if (look.accessory === "none") return;
  overlay1x(pc, 0, hy, (p) => costumeAccessory(p, look, view, 0));
}

/** Costume details on the torso (stripes, panels, sash, tail). */
export function drawCostumeTorso(c: Ctx, b: TorsoBox) {
  if ((c.L.extras?.costume ?? "none") === "none") return;
  const rows = b.seated ? 5 : 6;
  overlay1x(c.pc, 0, b.T, (p) => costumeTorso(p, costumeLook(c.L), c.view, 0, rows));
}

/** The item for the viewer's left (-1) / right (+1) arm of the front view. */
export function heldFront(L: CharacterLook, side: -1 | 1): Held {
  return (side < 0 ? L.extras?.leftHand : L.extras?.rightHand) ?? "none";
}

/**
 * One hand's item and bracelet. (hx, hy) = top-left texel of the 2×2 hand, `dir` = the side
 * the item sticks out to.
 */
function hand(c: Ctx, item: Held, hx: number, hy: number, dir: -1 | 1, wrist = true) {
  const x1 = Math.floor(hx / 2);
  const y1 = Math.floor(hy / 2);
  const ox = hx - 2 * x1;
  const oy = hy - 2 * y1;
  const ex = c.L.extras;
  if (!ex) return;
  const tick = (c.f.bob + c.f.phase) % 2;
  const after: After = [];
  if (wrist && ex.wrist !== "none")
    overlay1x(c.pc, ox, oy, (p) => drawWrist(p, ex.wrist, x1, y1 - 1));
  if (item !== "none")
    overlay1x(c.pc, ox, oy, (p) => drawHeld(p, item, x1, y1, dir, tick, after, ex.accent));
  for (const paint of after) c.after.push(() => overlay1x(c.pc, ox, oy, paint));
}

/**
 * Held items and bracelets for the current frame, at the hands the arm painters drew (arms.ts).
 * As in the 1× sheets: front = left item on the viewer's left; from behind the hands swap
 * sides; the side view shows one item (right hand first); a raised hand holds nothing.
 */
export function drawExtras(c: Ctx, b: TorsoBox, arms: Arms, phase: number) {
  const ex = c.L.extras;
  if (!ex) return;
  if (ex.leftHand === "none" && ex.rightHand === "none" && ex.wrist === "none") return;
  const T = b.T;
  if (c.view === "left") {
    const ax = phase === 1 ? -1 : phase === 3 ? 1 : 0;
    const item = ex.rightHand !== "none" ? ex.rightHand : ex.leftHand;
    hand(c, item, 14 + ax * 4, T + 10, -1);
    return;
  }
  if (c.view === "up") {
    let lenL = phase === 3 ? 8 : 10;
    let lenR = phase === 1 ? 8 : 10;
    if (arms === "type0") {
      lenL = 6;
      lenR = 8;
    } else if (arms === "type1") {
      lenL = 8;
      lenR = 6;
    }
    hand(c, ex.rightHand, c.tl - 2, T + lenL, -1);
    if (arms === "book0" || arms === "book1") hand(c, ex.leftHand, c.tr + 1, T - 2, 1, false);
    else hand(c, ex.leftHand, c.tr + 1, T + lenR, 1);
    return;
  }
  // front (standing or seated)
  const waving = arms === "wave0" || arms === "wave1";
  const raised = waving || arms === "raise0" || arms === "raise1";
  // posed arms (hands in pockets, on hips, crossed) hold nothing and show no bracelet
  const posedL = (c.posed || waving) && c.L.pose.hands !== "relaxed" && ex.leftHand === "none";
  const posedR =
    c.posed &&
    c.L.pose.hands !== "relaxed" &&
    c.L.pose.hands !== "hand-in-pocket" &&
    ex.rightHand === "none";
  const freeL = c.posed || waving;
  if (!posedL) hand(c, ex.leftHand, c.tl - 2, T + (!freeL && phase === 1 ? 8 : 10), -1);
  if (!raised && !posedR) hand(c, ex.rightHand, c.tr + 1, T + (phase === 3 ? 8 : 10), 1);
}
