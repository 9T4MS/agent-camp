/**
 * Glasses. Front: one frame ring per eye (eyes at x12-13 / x18-19, rows 14-16) plus temples
 * to the ears; side: lens in front of the eye and a temple arm to the ear.
 * Tints: clear = eyes untouched + a glint; light = lens colour with the eyes mixed through;
 * dark = opaque lens.
 */
import type { CharacterLook } from "@agent-office/protocol";
import { type PixelCanvas, packColor } from "../pixel.ts";
import { hash2, lighten, mix } from "./color.ts";
import type { View } from "./geometry.ts";
import { EYE_X, faceSides } from "./head.ts";

type Eyewear = CharacterLook["eyewear"];

function frameColor(e: Eyewear, x: number, y: number): string {
  if (e.framePattern !== "tortoiseshell") return e.frame;
  const h = hash2(x, y, 23) % 4;
  return h === 0 ? e.frameAccent : h === 3 ? mix(e.frame, "#d77643", 0.4) : e.frame;
}

/** Ring texels relative to the lens box (lens box = 4×4 at ex-1.., rows 13..16). */
function ringFor(
  style: Eyewear["style"],
  left: boolean,
): { ring: [number, number][]; lens: [number, number][] } {
  const ring: [number, number][] = [];
  const lens: [number, number][] = [];
  // default lens box: x -1..2 (relative to eye x), rows 13..16
  let x0 = -1;
  let x1 = 2;
  let y0 = 13;
  let y1 = 16;
  if (style === "rectangle") {
    x0 = -2;
    x1 = 3;
    y0 = 14;
    y1 = 16;
  } else if (style === "square") {
    y1 = 16;
    y0 = 13;
  }
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) lens.push([x, y]);
  // ring around the lens box
  for (let x = x0 - 1; x <= x1 + 1; x++) {
    ring.push([x, y0 - 1]);
    ring.push([x, y1 + 1]);
  }
  for (let y = y0; y <= y1; y++) {
    ring.push([x0 - 1, y]);
    ring.push([x1 + 1, y]);
  }
  const drop = (pts: [number, number][], x: number, y: number) => {
    const i = pts.findIndex(([a, b]) => a === x && b === y);
    if (i >= 0) pts.splice(i, 1);
  };
  const outer = left ? x0 - 1 : x1 + 1;
  const inner = left ? x1 + 1 : x0 - 1;
  switch (style) {
    case "round":
      for (const [x, y] of [
        [x0 - 1, y0 - 1],
        [x1 + 1, y0 - 1],
        [x0 - 1, y1 + 1],
        [x1 + 1, y1 + 1],
      ] as const)
        drop(ring, x, y);
      break;
    case "panto":
      // flat top, round bottom (keyhole-ish bridge from the flat tops)
      drop(ring, x0 - 1, y1 + 1);
      drop(ring, x1 + 1, y1 + 1);
      drop(lens, x0, y1);
      drop(lens, x1, y1);
      ring.push([x0, y1]);
      ring.push([x1, y1]);
      drop(ring, x0, y1 + 1);
      drop(ring, x1, y1 + 1);
      break;
    case "aviator":
      // straight top, teardrop bottom toward the nose
      drop(ring, outer, y1 + 1);
      drop(ring, outer, y1);
      drop(lens, left ? x0 : x1, y1);
      ring.push([left ? x0 : x1, y1]);
      drop(ring, left ? x0 : x1, y1 + 1);
      ring.push([inner, y0 - 2 + 1]);
      break;
    case "cat-eye":
      drop(ring, x0 - 1, y1 + 1);
      drop(ring, x1 + 1, y1 + 1);
      ring.push([outer, y0 - 2]);
      ring.push([outer + (left ? -1 : 1), y0 - 2]);
      ring.push([outer + (left ? -1 : 1), y0 - 1]);
      break;
    default:
  }
  return { ring, lens };
}

export function drawEyewear(pc: PixelCanvas, L: CharacterLook, view: View, hy: number) {
  const e = L.eyewear;
  if (e.style === "none" || view === "up") return;
  if (view === "left") {
    drawSide(pc, L, hy);
    return;
  }
  const eyePacked = packColor(L.face.eyeColor);
  for (const ex of EYE_X) {
    const left = ex === EYE_X[0];
    const { ring, lens } = ringFor(e.style, left);
    for (const [dx, y] of lens) {
      const x = ex + dx;
      const yy = y + hy;
      const isEye = pc.get(x, yy) === eyePacked;
      if (e.tint === "dark") pc.set(x, yy, e.lens);
      else if (e.tint === "light")
        pc.set(x, yy, isEye ? mix(e.lens, L.face.eyeColor, 0.35) : e.lens);
    }
    // glint, top-left of each lens
    const [gx, gy] = lens[0]!;
    pc.set(
      ex + gx,
      gy + hy,
      e.tint === "clear" ? e.lens : lighten(e.lens, e.tint === "dark" ? 0.3 : 0.6),
    );
    for (const [dx, y] of ring) pc.set(ex + dx, y + hy, frameColor(e, ex + dx, y));
  }
  // temples to the ears
  const [l, r] = faceSides(L.face.shape);
  const ty = (e.style === "rectangle" ? 13 : 12) + hy + 1;
  for (let x = l; x <= EYE_X[0] - 3; x++) pc.set(x, ty, frameColor(e, x, ty));
  for (let x = EYE_X[1] + 4; x <= r; x++) pc.set(x, ty, frameColor(e, x, ty));
}

function drawSide(pc: PixelCanvas, L: CharacterLook, hy: number) {
  const e = L.eyewear;
  const eyePacked = packColor(L.face.eyeColor);
  const y0 = e.style === "rectangle" ? 14 : 13;
  const y1 = 16;
  // lens seen from the side: x9..11 in front of the eye (x10-11)
  for (let y = y0; y <= y1; y++) {
    for (let x = 9; x <= 11; x++) {
      const isEye = pc.get(x, y + hy) === eyePacked;
      if (e.tint === "dark") pc.set(x, y + hy, e.lens);
      else if (e.tint === "light")
        pc.set(x, y + hy, isEye ? mix(e.lens, L.face.eyeColor, 0.35) : e.lens);
    }
  }
  // front rim + top/bottom
  for (let y = y0 - 1; y <= y1 + 1; y++) pc.set(8, y + hy, frameColor(e, 8, y));
  const round = e.style === "round" || e.style === "panto" || e.style === "cat-eye";
  for (let x = round ? 9 : 8; x <= 12; x++) {
    pc.set(x, y0 - 1 + hy, frameColor(e, x, y0 - 1));
    if (!(round && x === 12) && e.style !== "aviator")
      pc.set(x, y1 + 1 + hy, frameColor(e, x, y1 + 1));
  }
  if (e.style === "aviator") pc.hline(9, y1 + 1 + hy, 2, frameColor(e, 9, y1 + 1));
  pc.vline(12, y0 + hy, y1 - y0 + 1, frameColor(e, 12, y0));
  if (e.style === "cat-eye") pc.set(13, y0 - 2 + hy, e.frame);
  // temple arm to the ear
  for (let x = 13; x <= 16; x++) pc.set(x, y0 + hy, frameColor(e, x, y0));
}
