/**
 * Upper body, inside out: shirt -> suspenders/bib -> neckwear -> vest -> outer garment.
 * Front, back and side views. Each layer leaves its neck opening (and, when worn
 * open, its front) unpainted so the layers below show through.
 */
import type { Buttons, CharacterLook, Ramp } from "@agent-office/protocol";
import { luma, mix, NIGHT, opt, optOrNull, WHITE } from "./color.ts";
import type { Ctx } from "./ctx.ts";
import { type Fabric, fabricAt } from "./patterns.ts";

/** Torso rows for the current frame. */
export type TorsoBox = {
  /** first torso row (shoulders) */
  T: number;
  /** waistband row of the bottoms */
  W: number;
  /** last row of a hip-length garment */
  end: number;
  seated: boolean;
};

export function torsoBox(c: Ctx): TorsoBox {
  const T = 24 + c.dy;
  const seated = c.f.seat !== "none";
  return seated ? { T, W: T + 6, end: T + 9, seated } : { T, W: T + 7, end: T + 11, seated };
}

/**
 * One-texel trim (piping, small buttons) vanishes at zoom 2 when it is dark: lift dark trim a
 * little toward white, keeping its hue.
 */
function lift(hex: string, t = 0.16): string {
  return luma(hex) < 0.5 ? mix(hex, "#ffffff", t) : hex;
}

const CX0 = 15; // the two centre columns
const CX1 = 16;

export function outerEnd(c: Ctx, b: TorsoBox): number {
  switch (c.L.outer.length) {
    case "cropped":
      return b.W - 1;
    case "waist":
      return b.W + 1;
    case "hip":
      return b.end;
    case "thigh":
      return b.seated ? b.end : b.end + 3;
  }
}

/** Shirts that hang over the waistband instead of being tucked in. */
const UNTUCKED = new Set(["hoodie", "sweater", "tshirt", "longsleeve", "polo", "tank"]);

export function shirtEnd(c: Ctx, b: TorsoBox): number {
  if (c.L.bottoms.kind === "dress") return b.W - 1;
  return UNTUCKED.has(c.L.shirt.kind) ? b.W + 1 : b.W - 1;
}

export function vestEnd(c: Ctx, b: TorsoBox): number {
  return c.L.shirt.peeksAtWaist ? b.W - 2 : b.W - 1 + (c.L.vest.kind === "sweater-vest" ? 1 : 0);
}

const fab = (ramp: Ramp, pattern: CharacterLook["shirt"]["pattern"], salt = 0): Fabric => ({
  ramp,
  pattern,
  salt,
});

/** Paint one garment span on a row with its fabric, shading the right edge. */
function span(c: Ctx, f: Fabric, y: number, a: number, z: number, oy: number, shadeRight = true) {
  for (let x = a; x <= z; x++) {
    let col = fabricAt(f, x, y - oy);
    if (shadeRight && x >= z - 1 && x === z) col = f.ramp.shadow;
    c.pc.set(x, y, col);
  }
}

/** Half-width of the neck opening below the collar line (front), per collar style and row k. */
function neckHole(collar: string, k: number, kind: string): number {
  switch (collar) {
    case "v-neck":
      return [3, 2, 2, 1, 1, 0][k] ?? 0;
    case "lapel":
      return [3, 3, 2, 2, 1, 1, 0][k] ?? 0;
    case "shawl":
      return [3, 3, 2, 2, 2, 1, 1, 0][k] ?? 0;
    case "shirt":
      return kind === "outer" ? ([2, 2, 1, 1][k] ?? 0) : 0;
    case "none":
      return kind === "outer" ? ([2, 2, 2, 2, 2, 2, 1, 1][k] ?? 0) : 0;
    default:
      return 0;
  }
}

/** Buttons down a column. Large = 2 wide (light + rim/shadow below). */
function buttonColumn(
  c: Ctx,
  btn: Buttons,
  x: number,
  y0: number,
  y1: number,
  fallbackRim: string,
) {
  if (btn.count <= 0) return;
  const rows = y1 - y0 + 1;
  const n = Math.min(btn.count, Math.ceil(rows / 2));
  if (n <= 0) return;
  // spread the buttons over the column, at least one row of cloth between two buttons
  const step = Math.max(2, rows / n);
  const rim = opt(btn.rim, fallbackRim);
  for (let i = 0; i < n; i++) {
    const y = y0 + Math.floor(i * step);
    if (btn.size === "large") {
      c.pc.set(x, y, btn.color);
      c.pc.set(x + 1, y, rim);
    } else {
      c.pc.set(x, y, btn.color);
    }
  }
}

// ---- collars ----------------------------------------------------------------------------------
/** A collar band around the neck (front view), spanning columns a..z on rows y0..y1. */
function collarFront(
  c: Ctx,
  style: string,
  color: string,
  shade: string,
  piping: string | null,
  T: number,
  outer: boolean,
  open: boolean,
) {
  const pc = c.pc;
  switch (style) {
    case "crew":
      pc.hline(13, T, 6, shade);
      break;
    case "turtleneck":
      pc.rect(12, T - 1, 8, 3, color);
      for (let x = 12; x < 20; x += 2) pc.vline(x, T - 1, 3, shade);
      break;
    case "stand-up": {
      if (outer && open) {
        // two collar blocks standing up beside the jaw, piped on top and along the front
        // a band standing up beside the jaw: light top edge, a rolled mid-tone, piped front edge
        const hi = mix(color, "#ffffff", 0.35);
        const mid = mix(color, "#ffffff", 0.15);
        const pipe = piping ? lift(piping) : null;
        for (const [x0, dir] of [
          [c.tl, 1],
          [c.tr, -1],
        ] as const) {
          for (let i = 0; i < 4; i++) {
            const y = T - 1 + i;
            for (let k = 0; k < 4; k++) {
              const x = x0 + dir * k;
              let col = i === 0 ? hi : k === 2 ? mid : color;
              if (k === 0 && dir < 0 && i > 0) col = shade;
              if (k === 3 && pipe) col = pipe;
              pc.set(x, y, col);
            }
          }
          if (pipe) for (let k = 1; k < 4; k++) pc.set(x0 + dir * k, T - 2, pipe);
        }
        break;
      }
      // closed stand-up collar: band hugging the neck, piped on top
      const a = outer ? 11 : 12;
      const z = outer ? 20 : 19;
      pc.rect(a, T - 1, z - a + 1, 2, color);
      pc.set(z, T - 1, shade);
      pc.set(z, T, shade);
      if (piping) pc.hline(a, T - 2, z - a + 1, piping);
      // small front opening
      pc.set(CX0, T, shade);
      pc.set(CX1, T, shade);
      break;
    }
    case "shirt":
    case "polo": {
      // two collar points
      const pts: [number, number][] = [
        [12, T - 1],
        [13, T - 1],
        [12, T],
        [13, T],
        [14, T],
        [13, T + 1],
        [14, T + 1],
        [18, T - 1],
        [19, T - 1],
        [17, T],
        [18, T],
        [19, T],
        [17, T + 1],
        [18, T + 1],
      ];
      for (const [x, y] of pts) pc.set(x, y, x > 16 ? shade : color);
      if (style === "polo") {
        pc.vline(CX0, T + 1, 3, shade);
        pc.set(CX1, T + 2, shade);
      }
      break;
    }
    case "hood": {
      // hood bunched behind the neck
      pc.rect(9, T - 3, 14, 3, color);
      pc.hline(9, T - 1, 14, shade);
      pc.set(14, T + 1, WHITE);
      pc.set(14, T + 2, WHITE);
      pc.set(17, T + 1, WHITE);
      pc.set(17, T + 2, WHITE);
      break;
    }
    case "lapel":
    case "shawl": {
      // lapel triangles along the V
      for (let k = 0; k < 7; k++) {
        const hw = neckHole(style, k, "outer");
        if (hw <= 0) break;
        pc.set(CX0 - hw, T + k, color);
        pc.set(CX0 - hw - 1, T + k, style === "shawl" ? color : shade);
        pc.set(CX1 + hw, T + k, shade);
        pc.set(CX1 + hw + 1, T + k, style === "shawl" ? shade : color);
      }
      if (style === "lapel") {
        pc.set(CX0 - 4, T + 1, NIGHT);
        pc.set(CX1 + 4, T + 1, NIGHT);
      }
      break;
    }
    default:
  }
}

// ---- layers -----------------------------------------------------------------------------------
function drawShirtFront(c: Ctx, b: TorsoBox) {
  const s = c.L.shirt;
  const dress = c.L.bottoms.kind === "dress";
  const body = dress ? c.L.bottoms : s;
  const f = fab(body.ramp, body.pattern, 1);
  const end = shirtEnd(c, b);
  for (let y = b.T; y <= end; y++) span(c, f, y, c.tl, c.tr, b.T);
  if (s.kind === "tank") {
    // bare shoulders
    c.pc.rect(c.tl, b.T, 3, 2, c.L.skin.base);
    c.pc.rect(c.tr - 2, b.T, 3, 2, c.L.skin.shadow);
    c.pc.hline(c.tl + 3, b.T, c.tr - c.tl - 5, c.L.skin.base);
  }
  if (s.kind === "sweater" || s.kind === "hoodie") {
    for (let x = c.tl; x <= c.tr; x += 2) c.pc.set(x, end, s.ramp.shadow); // ribbed hem
  }
  if (s.kind === "hoodie") {
    // kangaroo pocket
    c.pc.hline(c.tl + 3, b.W - 2, c.tr - c.tl - 5, s.ramp.shadow);
    c.pc.vline(c.tl + 3, b.W - 2, 3, s.ramp.shadow);
    c.pc.vline(c.tr - 3, b.W - 2, 3, s.ramp.shadow);
  }
  const collarC = opt(s.collarColor, s.ramp.light);
  if (s.kind === "trachten-shirt") {
    // pin-tuck pleats either side of the placket
    c.pc.vline(13, b.T + 1, end - b.T - 1, s.ramp.light);
    c.pc.vline(18, b.T + 1, end - b.T - 1, s.ramp.shadow);
  }
  if (s.kind === "polo") {
    c.pc.vline(CX0, b.T + 1, 3, s.ramp.shadow);
    c.pc.set(CX1, b.T + 1, s.buttons.color);
    c.pc.set(CX1, b.T + 3, s.buttons.color);
  }
  if (s.collar === "v-neck") {
    for (let k = 0; k < 4; k++) {
      const hw = [3, 2, 1, 0][k]!;
      for (let x = CX0 - hw; x <= CX1 + hw; x++)
        c.pc.set(x, b.T + k, x === CX0 - hw || x === CX1 + hw ? s.ramp.shadow : c.L.skin.base);
    }
  }
  if (s.kind === "shirt" || s.kind === "trachten-shirt" || s.kind === "blouse") {
    // placket + buttons
    c.pc.vline(CX1, b.T + 1, end - b.T, s.ramp.shadow);
    buttonColumn(c, s.buttons, CX0, b.T + 2, end - 1, s.ramp.shadow);
  }
  if (s.kind === "blouse") {
    // soft rounded collar
    c.pc.hline(12, b.T, 3, collarC);
    c.pc.hline(17, b.T, 3, collarC);
    c.pc.set(12, b.T + 1, collarC);
    c.pc.set(19, b.T + 1, collarC);
  } else {
    collarFront(c, s.collar, collarC, s.ramp.shadow, null, b.T, false, false);
  }
  // neckwear
  const nw = s.neckwearColor;
  switch (s.neckwear) {
    case "tie":
      c.pc.rect(CX0, b.T, 2, 1, mix(nw, NIGHT, 0.2));
      c.pc.rect(CX0, b.T + 1, 2, 4, nw);
      c.pc.set(CX1, b.T + 2, mix(nw, NIGHT, 0.3));
      c.pc.rect(CX0, b.T + 5, 2, 1, mix(nw, NIGHT, 0.3));
      break;
    case "bow-tie":
      c.pc.hline(13, b.T, 6, nw);
      c.pc.hline(13, b.T + 1, 2, nw);
      c.pc.hline(17, b.T + 1, 2, nw);
      c.pc.set(CX0, b.T, mix(nw, NIGHT, 0.3));
      c.pc.set(CX1, b.T, mix(nw, NIGHT, 0.3));
      break;
    case "scarf":
      c.pc.rect(11, b.T - 1, 10, 2, nw);
      c.pc.hline(11, b.T, 10, mix(nw, NIGHT, 0.25));
      c.pc.rect(17, b.T + 1, 2, 5, nw);
      c.pc.set(18, b.T + 5, mix(nw, NIGHT, 0.25));
      break;
    case "bandana":
      c.pc.hline(12, b.T, 8, nw);
      c.pc.hline(13, b.T + 1, 6, nw);
      c.pc.hline(14, b.T + 2, 4, nw);
      c.pc.hline(15, b.T + 3, 2, mix(nw, NIGHT, 0.25));
      c.pc.set(14, b.T + 1, WHITE);
      break;
    default:
  }
}

function drawSuspendersFront(c: Ctx, b: TorsoBox) {
  const bt = c.L.bottoms;
  if (bt.kind === "overalls") {
    const f = fab(bt.ramp, bt.pattern, 3);
    for (let y = b.T + 3; y < b.W; y++) span(c, f, y, c.tl + 3, c.tr - 3, b.T, false);
    c.pc.hline(c.tl + 3, b.T + 3, c.tr - c.tl - 5, bt.ramp.light);
    c.pc.rect(13, b.T + 5, 6, 2, bt.ramp.shadow); // bib pocket
    c.pc.vline(c.tl + 3, b.T, 3, bt.ramp.base);
    c.pc.vline(c.tr - 3, b.T, 3, bt.ramp.shadow);
    c.pc.set(c.tl + 3, b.T + 3, opt(bt.buttons.color, WHITE));
    c.pc.set(c.tr - 3, b.T + 3, opt(bt.buttons.color, WHITE));
    return;
  }
  if (bt.suspenders === "none") return;
  const col = bt.suspendersColor;
  const dk = mix(col, NIGHT, 0.3);
  c.pc.vline(c.tl + 3, b.T, b.W - b.T, col);
  c.pc.vline(c.tr - 3, b.T, b.W - b.T, dk);
  if (bt.suspenders === "h-bridge") {
    c.pc.hline(c.tl + 3, b.T + 4, c.tr - c.tl - 5, col);
    c.pc.hline(c.tl + 3, b.T + 5, c.tr - c.tl - 5, dk);
    c.pc.set(CX0, b.T + 4, bt.embroidery.color);
    c.pc.set(CX1, b.T + 4, bt.embroidery.color);
  }
}

function drawVestFront(c: Ctx, b: TorsoBox) {
  const v = c.L.vest;
  if (v.kind === "none") return;
  const f = fab(v.ramp, v.pattern, 5);
  const end = vestEnd(c, b);
  const piping = v.piping === "none" ? null : lift(v.piping);
  for (let y = b.T; y <= end; y++) {
    const hw = neckHole(v.collar === "stand-up" ? "none-vest" : v.collar, y - b.T, "vest");
    if (hw > 0) {
      span(c, f, y, c.tl, CX0 - hw, b.T, false);
      span(c, f, y, CX1 + hw, c.tr, b.T);
      if (piping) {
        c.pc.set(CX0 - hw, y, piping);
        c.pc.set(CX1 + hw, y, piping);
      }
    } else span(c, f, y, c.tl, c.tr, b.T);
  }
  // shading under the arms
  c.pc.vline(c.tr, b.T, end - b.T + 1, v.ramp.shadow);
  if (v.kind === "puffer-vest") {
    for (let y = b.T + 2; y <= end; y += 3) c.pc.hline(c.tl, y, c.tr - c.tl + 1, v.ramp.shadow);
    c.pc.vline(CX0, b.T + 1, end - b.T, v.ramp.light);
  }
  if (v.kind === "sweater-vest") {
    for (let x = c.tl; x <= c.tr; x += 2) c.pc.set(x, end, v.ramp.shadow);
  }
  if (v.kind === "waistcoat") {
    // welt pockets + pointed hem
    c.pc.hline(c.tl + 1, end - 3, 3, v.ramp.shadow);
    c.pc.hline(c.tr - 3, end - 3, 3, v.ramp.shadow);
    c.pc.set(CX0, end + 1, v.ramp.base);
    c.pc.set(CX1, end + 1, v.ramp.shadow);
  }
  if (piping) {
    c.pc.hline(c.tl, end, c.tr - c.tl + 1, piping);
  }
  // front closure: placket line + button column
  if (v.kind !== "sweater-vest") {
    const top = b.T + (v.collar === "v-neck" ? 5 : 2);
    if (v.buttons.count === 0) c.pc.vline(CX1, top, end - top, piping ?? v.ramp.shadow);
    buttonColumn(
      c,
      { ...v.buttons, color: lift(v.buttons.color, 0.28) },
      CX0,
      top,
      end - 1,
      v.ramp.shadow,
    );
  }
  if (v.collar === "stand-up") {
    collarFront(c, "stand-up", v.ramp.base, v.ramp.shadow, piping, b.T, false, false);
    // let the shirt's own collar show inside the vest collar
    const s = c.L.shirt;
    if (s.collar === "stand-up" || s.collar === "shirt") {
      const col = opt(s.collarColor, s.ramp.base);
      c.pc.hline(13, b.T - 1, 6, col);
      c.pc.hline(14, b.T, 4, col);
      c.pc.set(18, b.T - 1, s.ramp.shadow);
    }
  } else if (v.collar !== "v-neck" && v.collar !== "none") {
    collarFront(c, v.collar, v.ramp.light, v.ramp.shadow, piping, b.T, false, false);
  }
}

/** Open outer garment: left/right front panels (inclusive columns). */
export function panels(c: Ctx): { lz: number; ra: number } {
  const w = c.tr - c.tl + 1;
  const pw = w >= 16 ? 5 : 4;
  return { lz: c.tl + pw - 1, ra: c.tr - pw + 1 };
}

/** Two rows of buttons either side of the closed front (double-breasted). */
function drawDoubleRows(c: Ctx, b: TorsoBox, collar: string, end: number) {
  const o = c.L.outer;
  // looks stored before `layout` existed keep their coat exactly as it was
  const legacyCoat = o.kind === "coat" && o.buttons.layout === undefined;
  const perRow = legacyCoat ? Math.max(o.buttons.count, 3) : Math.ceil(o.buttons.count / 2);
  if (perRow <= 0) return;
  // start below the collar opening so the rows sit on cloth
  let top = b.T + 7;
  if (!legacyCoat) {
    let k = 0;
    while (k < 8 && neckHole(collar, k, "outer") >= 2) k++;
    top = b.T + k + 1;
  }
  const btn: Buttons = legacyCoat
    ? { ...o.buttons, count: perRow, size: "small" }
    : { ...o.buttons, count: perRow };
  const y1 = legacyCoat ? end - 1 : Math.min(end - 1, top + perRow * 2 - 2);
  buttonColumn(c, btn, CX0 - 2, top, y1, o.ramp.shadow);
  buttonColumn(c, btn, CX1 + 2, top, y1, o.ramp.shadow);
}

function drawOuterFront(c: Ctx, b: TorsoBox) {
  const o = c.L.outer;
  if (o.kind === "none") return;
  const f = fab(o.ramp, o.pattern, 7);
  const end = outerEnd(c, b);
  const open = o.open;
  const { lz, ra } = panels(c);
  const collar = o.kind === "jacket" && o.collar === "none" && !open ? "none" : o.collar;
  for (let y = b.T; y <= end; y++) {
    const k = y - b.T;
    if (open) {
      const flare = y >= end - 1 ? 1 : 0;
      span(c, f, y, c.tl, lz - flare, b.T, false);
      span(c, f, y, ra + flare, c.tr, b.T);
      continue;
    }
    const hw = neckHole(collar, k, "outer");
    if (hw > 0) {
      span(c, f, y, c.tl, CX0 - hw, b.T, false);
      span(c, f, y, CX1 + hw, c.tr, b.T);
    } else span(c, f, y, c.tl, c.tr, b.T);
  }
  const pc = c.pc;
  // classic shading: light shoulders, darker hem
  pc.hline(c.tl, b.T, 2, o.ramp.light);
  if (!open && (collar === "none" || collar === "crew")) {
    pc.set(CX0 - 3, b.T, o.ramp.light);
    pc.set(CX1 + 3, b.T, o.ramp.light);
  }
  pc.vline(c.tr - 1, b.T + 1, end - b.T, o.ramp.shadow);
  pc.hline(c.tl, end, open ? lz - c.tl : c.tr - c.tl + 1, o.ramp.shadow);
  if (open) pc.hline(ra + 1, end, c.tr - ra, o.ramp.shadow);
  // kind details
  const piping = optOrNull(o.piping);
  switch (o.kind) {
    case "jacket":
      if (!open) pc.vline(CX1, b.T + 8, end - b.T - 8, o.ramp.shadow);
      break;
    case "blazer":
    case "coat":
      if (!open) pc.vline(CX1, b.T + 7, end - b.T - 7, o.ramp.shadow);
      break;
    case "cardigan":
      for (let x = c.tl; x <= c.tr; x += 2) pc.set(x, end, o.ramp.light);
      break;
    case "zip-hoodie":
      if (!open) pc.vline(CX0, b.T + 1, end - b.T, "#c0cbdc");
      pc.hline(c.tl + 2, end - 3, 4, o.ramp.shadow);
      pc.hline(c.tr - 5, end - 3, 4, o.ramp.shadow);
      break;
    case "hoodie":
      // pullover: no zip, two white drawstrings under the hood
      pc.vline(CX0 - 2, b.T + 1, 3, WHITE);
      pc.vline(CX1 + 2, b.T + 1, 3, WHITE);
      break;
    case "denim-jacket": {
      const st = o.ramp.light;
      pc.hline(c.tl, b.T + 3, c.tr - c.tl + 1, st);
      pc.rect(c.tl + 2, b.T + 4, 3, 2, o.ramp.shadow);
      pc.rect(c.tr - 4, b.T + 4, 3, 2, o.ramp.shadow);
      pc.hline(c.tl, end - 1, c.tr - c.tl + 1, st);
      if (!open) pc.vline(CX1, b.T + 1, end - b.T, st);
      break;
    }
    case "leather-jacket":
      if (!open) {
        for (let k = 0; k < end - b.T; k++)
          pc.set(Math.max(c.tl + 2, CX1 + 3 - Math.floor(k / 2)), b.T + 1 + k, "#c0cbdc");
      }
      pc.vline(c.tl + 1, b.T + 2, 3, o.ramp.light);
      pc.hline(c.tl + 2, end - 2, 3, o.ramp.light);
      break;
    case "bomber":
      pc.hline(c.tl, end, c.tr - c.tl + 1, o.ramp.shadow);
      for (let x = c.tl; x <= c.tr; x += 2) pc.set(x, end - 1, o.ramp.shadow);
      if (!open) pc.vline(CX0, b.T + 1, end - b.T - 1, "#c0cbdc");
      pc.rect(c.tl + 1, b.T + 2, 2, 1, opt(o.collarColor, o.ramp.light));
      break;
    case "lab-coat":
      pc.rect(c.tr - 4, b.T + 3, 3, 1, o.ramp.shadow);
      pc.set(c.tr - 3, b.T + 2, "#0099db"); // pen
      break;
    case "janker":
      break;
  }
  // double-breasted: two rows of buttons on a closed garment (a coat without a stated layout
  // is double-breasted, as before). Painted here, before piping and pockets, where the coat's
  // rows always were, so stored coats stay pixel-identical.
  const layout = o.buttons.layout ?? (o.kind === "coat" ? "double" : "single");
  if (!open && layout === "double") drawDoubleRows(c, b, collar, end);
  // the vest's piped edges show inside an open jacket
  const vp = optOrNull(c.L.vest.piping);
  if (open && vp && c.L.vest.kind !== "none") {
    const ve = vestEnd(c, b);
    pc.hline(lz + 1, ve, ra - lz - 1, lift(vp));
    pc.hline(lz + 1, b.T + 1, ra - lz - 1, lift(vp));
  }
  // front edge piping
  if (piping) {
    if (open) {
      pc.vline(lz, b.T, end - b.T + 1, piping);
      pc.vline(ra, b.T, end - b.T + 1, piping);
    }
    pc.hline(c.tl, end, c.tr - c.tl + 1, piping);
  }
  // pockets
  if (o.pockets !== "none") {
    const pp = opt(o.pocketPiping, o.ramp.shadow);
    const py = end - 3;
    const lA = c.tl + 1;
    const rZ = c.tr - 1;
    const pwid = open ? 2 : 4;
    switch (o.pockets) {
      case "flap":
        if (!(open && o.buttons.count > 0)) {
          pc.hline(lA, py, pwid + 1, pp);
          pc.hline(lA, py + 1, pwid, o.ramp.shadow);
        }
        pc.hline(rZ - pwid, py, pwid + 1, pp);
        pc.hline(rZ - pwid + 1, py + 1, pwid, o.ramp.shadow);
        break;
      case "patch":
        pc.rect(lA, py - 1, pwid, 3, pp);
        pc.rect(lA, py, pwid, 2, o.ramp.base);
        pc.rect(rZ - pwid + 1, py - 1, pwid, 3, pp);
        pc.rect(rZ - pwid + 1, py, pwid, 2, o.ramp.base);
        break;
      case "welt":
        pc.hline(lA, py, pwid, pp);
        pc.hline(rZ - pwid + 1, py, pwid, pp);
        break;
      case "kangaroo":
        if (!open) {
          pc.hline(c.tl + 3, py - 1, c.tr - c.tl - 5, pp);
          pc.vline(c.tl + 3, py - 1, 3, pp);
          pc.vline(c.tr - 3, py - 1, 3, pp);
        }
        break;
    }
  }
  // single row: along the wearer's right front edge (viewer's left) when open, down the centre
  // when closed (a coat without a stated layout has no single row, as before)
  if (
    (open || layout === "single") &&
    o.buttons.count > 0 &&
    (o.kind !== "coat" || o.buttons.layout !== undefined)
  ) {
    const bx = open ? lz - 2 : CX0;
    const top = open && collar === "stand-up" ? b.T + 2 : b.T + 1;
    buttonColumn(
      c,
      o.buttons,
      bx,
      top,
      Math.min(end - 1, top + o.buttons.count * 2 - 2),
      o.ramp.shadow,
    );
  }
  // collar
  const cc = opt(o.collarColor, o.ramp.light);
  const cs = o.collarColor === "none" ? o.ramp.shadow : mix(o.collarColor, NIGHT, 0.3);
  if (collar !== "none") {
    collarFront(c, collar, cc, cs, optOrNull(o.collarPiping), b.T, true, open);
  }
}

/**
 * The agent mark on clothes that are not agent coloured, as on main's 1× renderer: a 4×4
 * badge (2×2 at 1×) on the chest — centred on the shirt when the outer layer is open or
 * missing and no vest is in the way, else on the wearer's left chest (viewer's right) — a 2×2
 * dot at the front edge from the side, and
 * from behind (how seated people are mostly seen) a wide patch across the shoulders.
 */
function drawAgentBadge(c: Ctx, b: TorsoBox) {
  if (!c.r.accent) return;
  const a = c.r.agentRamp;
  const o = c.L.outer;
  const centre = (o.kind === "none" || o.open) && c.L.vest.kind === "none";
  // off-centre: against the side seam, high on the chest, clear of buttons on short torsos
  const x = centre ? CX0 - 1 : c.tr - 4;
  const y = b.T + (centre ? 3 : 2);
  c.pc.rect(x, y, 4, 4, a.base);
  c.pc.rect(x, y, 2, 2, a.light);
}

function drawAgentPatch(c: Ctx, b: TorsoBox) {
  if (!c.r.accent) return;
  const a = c.r.agentRamp;
  const w = c.tr - c.tl - 3;
  c.pc.rect(c.tl + 2, b.T + 2, w, 4, a.base);
  c.pc.hline(c.tl + 2, b.T + 2, w, a.light);
}

function drawAgentDot(c: Ctx, b: TorsoBox) {
  if (!c.r.accent) return;
  c.pc.rect(c.tl, b.T + 2, 2, 2, c.r.agentRamp.base);
}

export function drawTorsoFront(c: Ctx, b: TorsoBox) {
  drawShirtFront(c, b);
  drawSuspendersFront(c, b);
  drawVestFront(c, b);
  drawOuterFront(c, b);
  drawAgentBadge(c, b);
}

// ---- back view --------------------------------------------------------------------------------
export function drawTorsoBack(c: Ctx, b: TorsoBox) {
  const L = c.L;
  const pc = c.pc;
  const sEnd = shirtEnd(c, b);
  const s = L.bottoms.kind === "dress" ? L.bottoms : L.shirt;
  const sf = fab(s.ramp, s.pattern, 1);
  for (let y = b.T; y <= sEnd; y++) span(c, sf, y, c.tl, c.tr, b.T);
  if (L.shirt.collar === "hood" || L.shirt.kind === "hoodie") {
    pc.rect(11, b.T - 2, 10, 5, L.shirt.ramp.base);
    pc.hline(11, b.T + 2, 10, L.shirt.ramp.shadow);
  } else if (L.shirt.collar !== "none") {
    pc.hline(12, b.T, 8, opt(L.shirt.collarColor, L.shirt.ramp.light));
  }
  const bt = L.bottoms;
  if (bt.suspenders !== "none" || bt.kind === "overalls") {
    const col = bt.kind === "overalls" ? bt.ramp.base : bt.suspendersColor;
    for (let y = b.T; y < b.W; y++) {
      const t = y - b.T;
      const k = Math.min(t, 4);
      pc.set(c.tl + 3 + k, y, col);
      pc.set(c.tr - 3 - k, y, col);
    }
  }
  const v = L.vest;
  if (v.kind !== "none") {
    const vEnd = vestEnd(c, b);
    const vf = fab(v.ramp, v.pattern, 5);
    for (let y = b.T; y <= vEnd; y++) span(c, vf, y, c.tl, c.tr, b.T);
    if (v.collar === "stand-up") {
      pc.rect(12, b.T - 1, 8, 2, v.ramp.base);
      if (v.piping !== "none") pc.hline(12, b.T - 2, 8, v.piping);
    }
    if (v.kind === "waistcoat") pc.hline(c.tl + 3, b.T + 3, c.tr - c.tl - 5, v.ramp.shadow); // strap
  }
  const o = L.outer;
  if (o.kind !== "none") {
    const end = outerEnd(c, b);
    const of = fab(o.ramp, o.pattern, 7);
    for (let y = b.T; y <= end; y++) span(c, of, y, c.tl, c.tr, b.T);
    pc.vline(c.tr - 1, b.T, end - b.T + 1, o.ramp.shadow);
    pc.hline(c.tl, end, c.tr - c.tl + 1, o.ramp.shadow);
    pc.vline(CX0, b.T + 1, end - b.T - 1, o.ramp.shadow); // back seam
    if (o.yoke) {
      // yoke seam across the shoulders, dipping in the middle
      for (let x = c.tl; x <= c.tr; x++) {
        const d = Math.abs(x - 15.5) < 4 ? 1 : 0;
        pc.set(x, b.T + 3 + d, o.ramp.shadow);
        pc.set(x, b.T + 2 + d, o.ramp.light);
      }
    }
    if (o.piping !== "none") pc.hline(c.tl, end, c.tr - c.tl + 1, o.piping);
    if (o.kind === "bomber" || o.kind === "cardigan") {
      for (let x = c.tl; x <= c.tr; x += 2) pc.set(x, end - 1, o.ramp.shadow);
    }
    if (o.kind === "zip-hoodie" || o.kind === "hoodie" || o.collar === "hood") {
      pc.rect(11, b.T - 2, 10, 6, o.ramp.base);
      pc.hline(11, b.T + 3, 10, o.ramp.shadow);
      pc.vline(20, b.T - 2, 6, o.ramp.shadow);
    }
    if (o.kind === "denim-jacket") pc.hline(c.tl, b.T + 4, c.tr - c.tl + 1, o.ramp.light);
    // collar band from behind (the head covers everything above the shoulders)
    if (o.collar !== "none" && o.collar !== "hood" && o.collar !== "crew") {
      const cc = opt(o.collarColor, o.ramp.light);
      const tall = o.collar === "stand-up" || o.collar === "turtleneck";
      const h = tall ? 2 : 1;
      pc.rect(c.tl + 2, b.T, c.tr - c.tl - 3, h, cc);
      pc.hline(c.tl + 2, b.T, c.tr - c.tl - 3, mix(cc, "#ffffff", 0.35));
      pc.vline(c.tr - 2, b.T, h, mix(cc, NIGHT, 0.3));
    }
  }
  if (L.shirt.collar === "turtleneck" && o.kind === "none")
    pc.rect(12, b.T - 2, 8, 2, L.shirt.ramp.base);
  drawAgentPatch(c, b);
}

// ---- side view (facing left) ------------------------------------------------------------------
export function drawTorsoSide(c: Ctx, b: TorsoBox) {
  const L = c.L;
  const pc = c.pc;
  const s = L.bottoms.kind === "dress" ? L.bottoms : L.shirt;
  const sEnd = shirtEnd(c, b);
  const sf = fab(s.ramp, s.pattern, 1);
  for (let y = b.T; y <= sEnd; y++) span(c, sf, y, c.tl, c.tr, b.T);
  if (L.shirt.collar !== "none")
    pc.hline(c.tl + 1, b.T, 4, opt(L.shirt.collarColor, L.shirt.ramp.light));
  const v = L.vest;
  if (v.kind !== "none") {
    const vEnd = vestEnd(c, b);
    const vf = fab(v.ramp, v.pattern, 5);
    for (let y = b.T; y <= vEnd; y++) span(c, vf, y, c.tl, c.tr, b.T);
    if (v.piping !== "none") pc.hline(c.tl, vEnd, c.tr - c.tl + 1, v.piping);
    if (v.buttons.count > 0)
      for (let y = b.T + 2; y < vEnd; y += 2) pc.set(c.tl, y, v.buttons.color);
  }
  const bt = L.bottoms;
  if (bt.suspenders !== "none" || bt.kind === "overalls") {
    const col = bt.kind === "overalls" ? bt.ramp.base : bt.suspendersColor;
    pc.vline(c.tl + 3, b.T, b.W - b.T, col);
  }
  const o = L.outer;
  if (o.kind !== "none") {
    const end = outerEnd(c, b);
    const of = fab(o.ramp, o.pattern, 7);
    const front = o.open ? c.tl + 2 : c.tl;
    for (let y = b.T; y <= end; y++) span(c, of, y, front, c.tr, b.T);
    pc.vline(c.tr - 1, b.T + 1, end - b.T, o.ramp.shadow);
    pc.hline(front, end, c.tr - front + 1, o.ramp.shadow);
    if (o.piping !== "none") pc.vline(front, b.T, end - b.T + 1, o.piping);
    // buttons along the front edge
    if (o.buttons.count > 0) {
      const n = Math.min(o.buttons.count, 5);
      for (let i = 0; i < n; i++) {
        const y = b.T + 1 + i * 2;
        if (y >= end) break;
        pc.set(front, y, o.buttons.color);
        pc.set(front + 1, y, o.buttons.color);
        if (o.buttons.size === "large") pc.set(front + 1, y + 1, opt(o.buttons.rim, o.ramp.shadow));
      }
    }
    if (o.pockets !== "none" && o.pockets !== "kangaroo") {
      const pp = opt(o.pocketPiping, o.ramp.shadow);
      pc.hline(front + 3, end - 3, 4, pp);
      if (o.pockets === "flap") pc.hline(front + 3, end - 2, 4, o.ramp.shadow);
    }
    if (o.kind === "zip-hoodie" || o.kind === "hoodie" || o.collar === "hood")
      pc.rect(c.tl + 5, b.T - 2, 6, 4, o.ramp.base);
    if (o.collar !== "none" && o.collar !== "crew" && o.collar !== "hood") {
      const cc = opt(o.collarColor, o.ramp.light);
      const tall = o.collar === "stand-up" || o.collar === "turtleneck";
      const y0 = b.T - 1;
      const h = tall ? 4 : 2;
      pc.rect(front, y0, 9, h, cc);
      pc.hline(front, y0, 9, mix(cc, "#ffffff", 0.35));
      pc.vline(front + 8, y0, h, mix(cc, NIGHT, 0.3));
      if (o.collarPiping !== "none") pc.vline(front, y0, h, o.collarPiping);
    }
  } else if (L.shirt.collar === "stand-up" || L.shirt.collar === "turtleneck") {
    pc.rect(c.tl + 1, b.T - 2, 7, 2, opt(L.shirt.collarColor, L.shirt.ramp.base));
  }
  drawAgentDot(c, b);
}
