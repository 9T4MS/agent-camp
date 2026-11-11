/**
 * Arms and hands for every view, the standing poses (front idle + the free arm while waving),
 * raised/waving hands, the reading book and the mug.
 */
import type { Ramp } from "@agent-office/protocol";
import { C } from "../palette.ts";
import type { Ctx } from "./ctx.ts";
import { heldFront } from "./extras.ts";
import type { Arms } from "./geometry.ts";
import type { TorsoBox } from "./torso.ts";

/** Rightmost texel column a part may use so the 2-texel outline still fits in the frame. */
const MAX_X = 29;

/** Sleeve colour of row `k` below the shoulder; null = bare skin. */
function sleeveAt(c: Ctx, k: number): Ramp | null {
  const L = c.L;
  if (L.outer.kind !== "none") return c.sleeve;
  const s = L.shirt;
  if (s.kind === "tank") return null;
  if (s.sleeves === "short") return k < 4 ? c.sleeve : null;
  if (s.sleeves === "rolled") return k < 7 ? c.sleeve : null;
  return c.sleeve;
}

/** Cuff row: rolled sleeves (light band) or knitted cuffs of long sleeves. */
function isCuff(c: Ctx, k: number): boolean {
  const s = c.L.shirt;
  if (c.L.outer.kind !== "none") return c.L.outer.kind === "bomber" && k === 9;
  if (s.sleeves === "rolled") return k === 6;
  return (
    s.sleeves === "long" &&
    k === 9 &&
    (s.kind === "longsleeve" || s.kind === "sweater" || s.kind === "hoodie")
  );
}

/** A straight 2-texel arm column from row y0 for `len` rows, hand below. */
function armColumn(c: Ctx, x: number, y0: number, len: number, dark: boolean, hand = true) {
  const skin = c.L.skin;
  for (let k = 0; k < len; k++) {
    const sl = sleeveAt(c, k);
    const y = y0 + k;
    if (!sl) {
      c.pc.set(x, y, dark ? skin.shadow : skin.base);
      c.pc.set(x + 1, y, skin.shadow);
      continue;
    }
    const col = isCuff(c, k) ? sl.light : dark ? sl.shadow : sl.base;
    c.pc.set(x, y, col);
    c.pc.set(x + 1, y, dark ? sl.shadow : k < 2 ? sl.base : sl.shadow);
  }
  if (hand) {
    c.pc.rect(x, y0 + len, 2, 2, skin.base);
    c.pc.set(x + 1, y0 + len + 1, skin.shadow);
  }
}

/** Front-view arm on the viewer's left (`side` -1) or right (+1) in the look's pose. */
function posedArm(c: Ctx, b: TorsoBox, side: -1 | 1, dark: boolean) {
  const pose = c.L.pose.hands;
  const T = b.T;
  const x = side < 0 ? c.tl - 2 : c.tr + 1;
  // a hand that holds something hangs relaxed (extras.ts draws the item at its hand)
  if (heldFront(c.L, side) !== "none") {
    armColumn(c, x, T, 10, dark);
    return;
  }
  const inPocket = pose === "hands-in-pockets" || (pose === "hand-in-pocket" && side < 0);
  if (inPocket) {
    // upper arm hangs, elbow slightly out, forearm angles in, only knuckles show
    armColumn(c, x, T, 6, dark, false);
    const sl = sleeveAt(c, 7) ?? c.L.skin;
    const inward = -side; // toward the body
    const col = dark ? sl.shadow : sl.base;
    c.pc.set(x, T + 6, col);
    c.pc.set(x + 1, T + 6, sl.shadow);
    c.pc.set(x + (inward > 0 ? 1 : 0), T + 7, col);
    c.pc.set(x + (inward > 0 ? 2 : -1), T + 7, sl.shadow);
    const kx = side < 0 ? c.tl : c.tr - 1;
    c.pc.set(kx, T + 8, sl.shadow);
    c.pc.set(kx + inward, T + 8, col);
    // knuckles at the pocket opening
    const sk = c.L.skin;
    c.pc.set(kx + inward, T + 9, sk.base);
    c.pc.set(kx + 2 * inward, T + 9, sk.shadow);
    c.pc.set(kx + 2 * inward, T + 8, sk.base);
    return;
  }
  if (pose === "hands-on-hips") {
    const out = side;
    const sl = c.sleeve;
    armColumn(c, x, T, 3, dark, false);
    for (let k = 3; k < 6; k++) {
      const ox = x + out * (k - 2);
      c.pc.set(ox, T + k, dark ? sl.shadow : sl.base);
      c.pc.set(ox + 1, T + k, sl.shadow);
    }
    for (let k = 6; k < 8; k++) {
      const ox = x + out * (8 - k);
      c.pc.set(ox, T + k, dark ? sl.shadow : sl.base);
      c.pc.set(ox + 1, T + k, sl.shadow);
    }
    const hx = side < 0 ? c.tl - 1 : c.tr;
    c.pc.rect(hx, T + 7, 2, 2, c.L.skin.base);
    return;
  }
  if (pose === "arms-crossed") {
    armColumn(c, x, T, 5, dark, false);
    const sl = c.sleeve;
    const y = T + 5 + (side < 0 ? 0 : 1);
    const a = side < 0 ? c.tl - 2 : 15;
    const z = side < 0 ? 16 : c.tr + 2;
    for (let xx = a; xx <= z; xx++) {
      c.pc.set(xx, y, dark ? sl.shadow : sl.base);
      c.pc.set(xx, y + 1, sl.shadow);
    }
    const hx = side < 0 ? z - 1 : a;
    c.pc.rect(hx, y, 2, 2, c.L.skin.base);
    return;
  }
  armColumn(c, x, T, 10, dark);
}

export function drawArmsFront(c: Ctx, b: TorsoBox, arms: Arms, phase: number) {
  const T = b.T;
  const posed = c.posed;
  const waving = arms === "wave0" || arms === "wave1";
  // viewer's left arm
  if (posed || waving) posedArm(c, b, -1, false);
  else armColumn(c, c.tl - 2, T, phase === 1 ? 8 : 10, false);
  // viewer's right arm
  const rx = c.tr + 1;
  if (arms === "raise0" || arms === "raise1" || waving) {
    armColumn(c, rx, T, 3, true, false);
    if (!waving) return;
    const sl = c.sleeve;
    const sk = c.L.skin;
    if (arms === "wave0") {
      c.pc.rect(rx + 2, T - 13, 2, 16, sl.shadow);
      c.pc.vline(rx + 2, T - 13, 14, sl.base);
      c.pc.rect(rx + 1, T - 18, 4, 5, sk.base);
      c.pc.set(rx, T - 16, sk.base);
      c.pc.vline(rx + 4, T - 17, 4, sk.shadow);
    } else {
      // hand swung outward; keep it (and its 2-texel outline) inside the frame
      const hx = rx - Math.max(0, rx + 7 - MAX_X);
      c.pc.rect(rx + 2, T - 9, 2, 11, sl.shadow);
      c.pc.vline(rx + 2, T - 9, 9, sl.base);
      c.pc.rect(hx + 4, T - 12, 2, 4, sl.shadow);
      c.pc.rect(hx + 4, T - 17, 4, 5, sk.base);
      c.pc.set(hx + 3, T - 15, sk.base);
      c.pc.vline(hx + 7, T - 16, 4, sk.shadow);
    }
    return;
  }
  if (posed && c.L.pose.hands !== "relaxed" && c.L.pose.hands !== "hand-in-pocket") {
    posedArm(c, b, 1, true);
    return;
  }
  armColumn(c, rx, T, phase === 3 ? 8 : 10, true);
}

/** Raised hand drawn over the head's edge so it reads at a glance ("waiting for you!"). */
export function drawRaisedHand(c: Ctx, b: TorsoBox, arms: Arms) {
  if (arms !== "raise0" && arms !== "raise1") return;
  const sl = c.sleeve;
  const sk = c.L.skin;
  const lift = arms === "raise0" ? 0 : 2;
  const x = Math.min(c.tr + 3, MAX_X - 3); // old x13 -> 26 for an average torso
  const T = b.T;
  c.pc.rect(x, T - 6 + lift, 2, 8 - lift, sl.shadow);
  c.pc.rect(x + 2, T - 14 + lift, 2, 12, sl.base);
  c.pc.vline(x + 3, T - 14 + lift, 12, sl.shadow);
  c.pc.rect(x, T - 20 + lift, 4, 6, sk.base);
  c.pc.vline(x + 3, T - 19 + lift, 5, sk.shadow);
  c.pc.rect(x - 2, T - 18 + lift, 2, 2, sk.base); // thumb
}

export function drawArmsBack(c: Ctx, b: TorsoBox, arms: Arms, phase: number) {
  const T = b.T;
  let lenL = phase === 3 ? 8 : 10;
  let lenR = phase === 1 ? 8 : 10;
  if (arms === "type0") {
    lenL = 6;
    lenR = 8;
  } else if (arms === "type1") {
    lenL = 8;
    lenR = 6;
  }
  const lx = c.tl - 2;
  const rx = c.tr + 1;
  armColumn(c, lx, T, lenL, true, arms === "down");
  if (arms === "book0" || arms === "book1") {
    const sk = c.L.skin;
    armColumn(c, rx, T, 3, true, false);
    c.pc.rect(rx - 2, T - 2, 4, 2, sk.base);
    const bx = rx - 2;
    const by = T - 12;
    c.pc.rect(bx, by, 8, 8, C.wine);
    c.pc.rect(bx, by, 2, 8, C.red);
    c.pc.hline(bx, by - 2, 8, C.cream);
    c.pc.hline(bx, by - 1, 8, C.cream);
    if (arms === "book1") {
      c.pc.rect(bx + 4, by - 4, 2, 2, C.cream);
      c.pc.rect(bx + 6, by - 6, 2, 4, C.white);
    }
    return;
  }
  armColumn(c, rx, T, lenR, true, arms === "down");
}

export function drawArmSide(c: Ctx, b: TorsoBox, phase: number) {
  const ax = phase === 1 ? -1 : phase === 3 ? 1 : 0;
  const T = b.T;
  const x = 14;
  const sk = c.L.skin;
  for (let k = 0; k < 10; k++) {
    const off = k < 4 ? 0 : k < 8 ? ax * 2 : ax * 4;
    const sl = sleeveAt(c, k);
    const xx = x + off;
    if (!sl) {
      c.pc.hline(xx, T + k, 3, sk.base);
      c.pc.set(xx + 3, T + k, sk.shadow);
      continue;
    }
    const base = isCuff(c, k) ? sl.light : sl.base;
    c.pc.set(xx, T + k, k < 3 ? sl.light : base);
    c.pc.hline(xx + 1, T + k, 2, base);
    c.pc.set(xx + 3, T + k, sl.shadow);
  }
  c.pc.rect(x + ax * 4, T + 10, 4, 2, sk.base);
  c.pc.set(x + ax * 4 + 3, T + 11, sk.shadow);
  if (c.r.accent) {
    const a = c.r.agentRamp;
    c.pc.hline(x, T + 4, 4, a.base);
    c.pc.hline(x, T + 5, 3, a.base);
    c.pc.set(x + 3, T + 5, a.shadow);
  }
}

export function drawMug(c: Ctx, x: number, y: number) {
  c.pc.rect(x, y + 1, 4, 5, C.white);
  c.pc.hline(x, y, 4, C.silver);
  c.pc.vline(x + 3, y + 1, 5, C.silver);
  c.pc.vline(x + 4, y + 2, 2, C.white);
  c.pc.hline(x + 1, y + 1, 2, C.cocoa);
}
