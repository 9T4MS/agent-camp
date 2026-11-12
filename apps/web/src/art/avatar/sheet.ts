/**
 * The HD paper-doll painter: one 36-frame sheet (32×48 texels per frame) for a RenderLook.
 * Pure PixelCanvas (no Pixi, no DOM), so tests and preview scripts can run it headless.
 */
import { PixelCanvas } from "../pixel.ts";
import { drawArmSide, drawArmsBack, drawArmsFront, drawMug, drawRaisedHand } from "./arms.ts";
import { type Ctx, torsoCols } from "./ctx.ts";
import { drawCostumeHead, drawCostumeTorso, drawExtras } from "./extras.ts";
import { drawEyewear } from "./eyewear.ts";
import { FH, type FrameSpec, FW, SEAT_DROP, SPECS, type View } from "./geometry.ts";
import { drawHair } from "./hair.ts";
import { drawHeadSkin } from "./head.ts";
import { drawEarrings, drawHeadwear } from "./headwear.ts";
import { drawLegsSeatedFront, drawLegsSide, drawLegsStanding, drawSeatBackHip } from "./legs.ts";
import type { RenderLook } from "./renderLook.ts";
import { drawTorsoBack, drawTorsoFront, drawTorsoSide, type TorsoBox, torsoBox } from "./torso.ts";

function makeCtx(pc: PixelCanvas, r: RenderLook, f: FrameSpec, after: (() => void)[]): Ctx {
  const L = r.look;
  const view: View = f.seat === "back" ? "up" : f.view;
  const [tl, tr] = torsoCols(L.build, view);
  return {
    pc,
    r,
    L,
    f,
    view,
    dy: f.bob + (f.seat === "none" ? 0 : SEAT_DROP),
    tl,
    tr,
    posed: !!f.posed,
    sleeve: L.outer.kind !== "none" ? L.outer.ramp : L.shirt.ramp,
    after,
  };
}

const scratch = new PixelCanvas(FW, FH);

/** Head with hair, glasses, headwear. Tilted heads are painted aside and sheared. */
function drawHead(c: Ctx, view: View, hy: number) {
  const tilt = c.posed && c.L.pose.headTilt && view === "down";
  const pc = tilt ? scratch : c.pc;
  if (tilt) scratch.data.fill(0);
  const L = c.L;
  drawHeadSkin(pc, L, view, hy);
  drawEarrings(pc, L, view, hy);
  drawHair(pc, L, view, hy);
  drawCostumeHead(pc, L, view, hy);
  drawEyewear(pc, L, view, hy);
  drawHeadwear(pc, L, view, hy, c.r.hat);
  if (!tilt) return;
  // slight tilt: everything above the eyes (hair, hat, brows) leans one texel to the
  // viewer's right; face and chin stay put
  for (let y = 0; y < FH; y++) {
    const shift = y < 12 + hy ? 1 : 0;
    for (let x = 0; x < FW; x++) {
      const v = scratch.data[y * FW + x]!;
      if (v >>> 24 !== 0) c.pc.put(x + shift, y, v);
    }
  }
}

function paintFrame(pc: PixelCanvas, r: RenderLook, f: FrameSpec, after: (() => void)[]) {
  const c = makeCtx(pc, r, f, after);
  const b: TorsoBox = torsoBox(c);
  if (f.seat === "none") {
    if (c.view === "left") {
      drawLegsSide(c, b, f.phase);
      drawTorsoSide(c, b);
      drawCostumeTorso(c, b);
      drawArmSide(c, b, f.phase);
      drawExtras(c, b, f.arms, f.phase);
      if (r.mug && f.phase === 0) drawMug(c, 9, b.T + 6);
    } else if (c.view === "down") {
      drawLegsStanding(c, b, false, f.phase);
      drawTorsoFront(c, b);
      drawCostumeTorso(c, b);
      drawArmsFront(c, b, f.arms, f.phase);
      drawExtras(c, b, f.arms, f.phase);
      if (
        r.mug &&
        f.arms === "down" &&
        !(c.posed && c.L.pose.hands !== "relaxed" && c.L.pose.hands !== "hand-in-pocket")
      )
        drawMug(c, c.tr + 1, b.T + 8);
      if (r.mug && (f.arms === "wave0" || f.arms === "wave1") && c.L.pose.hands === "relaxed")
        drawMug(c, c.tl - 4, b.T + 8);
    } else {
      drawLegsStanding(c, b, true, f.phase);
      drawTorsoBack(c, b);
      drawCostumeTorso(c, b);
      drawArmsBack(c, b, f.arms, f.phase);
      drawExtras(c, b, f.arms, f.phase);
    }
    drawHead(c, c.view, c.dy + (f.bow ?? 0));
    if (c.view === "down") drawRaisedHand(c, b, f.arms);
    return;
  }
  if (f.seat === "back") {
    drawSeatBackHip(c, b);
    drawTorsoBack(c, b);
    drawCostumeTorso(c, b);
    drawArmsBack(c, b, f.arms, 0);
    drawExtras(c, b, f.arms, 0);
    drawHead(c, "up", c.dy);
    return;
  }
  // seated, facing the camera
  drawLegsSeatedFront(c, b);
  drawTorsoFront(c, b);
  drawCostumeTorso(c, b);
  drawArmsFront(c, b, f.arms === "rest" ? "down" : f.arms, 0);
  drawExtras(c, b, f.arms === "rest" ? "down" : f.arms, 0);
  if (r.mug && f.arms === "rest") drawMug(c, c.tr - 1, b.T + 4);
  drawHead(c, "down", c.dy);
  drawRaisedHand(c, b, f.arms);
}

/** Paint all frames side by side (32×48 each), 2-texel outline, mirrored right frames. */
export function paintSheet(r: RenderLook): PixelCanvas {
  const pc = new PixelCanvas(FW * SPECS.length, FH);
  SPECS.forEach((spec, i) => {
    if (spec.mirror !== undefined) return;
    const after: (() => void)[] = [];
    const clip = { x0: i * FW, y0: 0, x1: (i + 1) * FW, y1: FH };
    pc.at(i * FW, 0);
    pc.clip = clip;
    paintFrame(pc, r, spec, after);
    pc.clip = null;
    pc.at(0, 0);
    pc.outline(i * FW, 0, FW, FH);
    pc.outline(i * FW, 0, FW, FH);
    // thin things stay thin: painted over the outline
    if (after.length) {
      pc.at(i * FW, 0);
      pc.clip = clip;
      for (const paint of after) paint();
      pc.clip = null;
      pc.at(0, 0);
    }
  });
  SPECS.forEach((spec, i) => {
    if (spec.mirror !== undefined) pc.mirrorFrom(spec.mirror * FW, 0, FW, FH, i * FW, 0);
  });
  return pc;
}
