/**
 * The portal characters, drawn like the cartoon rather than like the office's pixel dolls: smooth
 * bezier shapes, an even dark outline and flat colors, painted with Canvas 2D at RES times
 * the world resolution and sampled linearly (with mipmaps), so they stay crisp at any zoom.
 * Coordinates below are world pixels; frames are W x H with the feet on the ground line G.
 *
 * Also the portal (a swirling green disc) and the portal-gun shot.
 */
import { CanvasSource, Rectangle, Texture } from "pixi.js";

/** canvas pixels per world pixel */
export const RES = 8;

const INK = "#1f1d22";
const LW = 0.42;
const SHADOW = "rgba(10, 12, 20, 0.22)";

const LEAD_COL = {
  skin: "#f1d6bf",
  hair: "#b8e1ee",
  shirt: "#9fd3e3",
  coat: "#f2f6f7",
  coatShade: "#c9d6db",
  pants: "#8a6748",
  shoes: "#3a2a22",
};
const SIDEKICK_COL = {
  skin: "#f7dcc4",
  hair: "#6d4223",
  shirt: "#f5dc4f",
  pants: "#3d6cb3",
  shoes: "#f4f4f2",
};
const GUN = { body: "#c4ccd0", dark: "#8f9aa0", glow: "#9cf05c", core: "#e9ffc4" };

export type ToonView = "down" | "up" | "left";
type Pose = "walk" | "blink" | "aim" | "panic";
type Spec = { view: ToonView; phase: number; pose: Pose; moving: boolean };

const SPECS: Spec[] = [
  /* 0 idle front */ { view: "down", phase: 0, pose: "walk", moving: false },
  /* 1 blink */ { view: "down", phase: 0, pose: "blink", moving: false },
  /* 2-5 walk down */ ...[0, 1, 2, 3].map((phase) => ({
    view: "down" as const,
    phase,
    pose: "walk" as const,
    moving: true,
  })),
  /* 6-9 walk up */ ...[0, 1, 2, 3].map((phase) => ({
    view: "up" as const,
    phase,
    pose: "walk" as const,
    moving: true,
  })),
  /* 10-13 walk left (right = mirrored) */ ...[0, 1, 2, 3].map((phase) => ({
    view: "left" as const,
    phase,
    pose: "walk" as const,
    moving: true,
  })),
  /* 14 lead: portal gun aimed left / sidekick: arms up, panicking */ {
    view: "left",
    phase: 0,
    pose: "aim",
    moving: false,
  },
  /* 15 standing, side */ { view: "left", phase: 0, pose: "walk", moving: false },
  /* 16 sidekick panic, front */ { view: "down", phase: 0, pose: "panic", moving: false },
];

export const TOON = {
  idle: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  walkDown: [2, 3, 4, 5],
  walkUp: [6, 7, 8, 9],
  walkSide: [10, 11, 12, 13],
  aim: [14],
  standSide: [15],
  panic: [16],
} as const;

export type ToonSheet = { frames: Texture[]; w: number; h: number; ground: number };

// ---- drawing helpers ------------------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;

function ink(ctx: Ctx, fill: string, path: () => void, lw = LW) {
  ctx.beginPath();
  path();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

function ellipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, fill: string, lw = LW) {
  ink(ctx, fill, () => ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2), lw);
}

function line(ctx: Ctx, pts: [number, number][], lw = LW, color = INK) {
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.lineWidth = lw;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function curve(ctx: Ctx, x0: number, y0: number, cx: number, cy: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(cx, cy, x1, y1);
  ctx.lineWidth = LW * 0.85;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

/** A limb (sleeve, leg) as a thick outlined stroke through the points. */
function limb(ctx: Ctx, pts: [number, number][], width: number, fill: string) {
  for (const [w, c] of [
    [width + LW * 2, INK],
    [width, fill],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
    ctx.lineWidth = w;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = c;
    ctx.stroke();
  }
  ctx.lineCap = "butt";
}

/** Spiky starburst (the lead's hair): alternating tip/valley radii over an angle range. */
function spikes(
  ctx: Ctx,
  cx: number,
  cy: number,
  from: number,
  to: number,
  n: number,
  tip: number,
  valley: number,
  fill: string,
  squash = 1,
) {
  // closed with a chord (not through the center), so a back view gets a clean nape line
  ink(ctx, fill, () => {
    for (let i = 0; i <= n * 2; i++) {
      const a = from + ((to - from) * i) / (n * 2);
      const r = i % 2 ? valley : tip * (0.9 + 0.1 * Math.sin(i * 2.3));
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r * squash);
    }
    ctx.closePath();
  });
}

function shadow(ctx: Ctx, x: number, g: number, rx: number) {
  ctx.beginPath();
  ctx.ellipse(x, g - 0.3, rx, rx * 0.32, 0, 0, Math.PI * 2);
  ctx.fillStyle = SHADOW;
  ctx.fill();
}

/** Round cartoon eye with a dot pupil (or a closed lid). */
function eye(ctx: Ctx, x: number, y: number, r: number, px: number, py: number, closed: boolean) {
  if (closed) {
    curve(ctx, x - r, y, x, y + r * 0.6, x + r, y);
    return;
  }
  ellipse(ctx, x, y, r, r * 1.05, "#ffffff", LW * 0.8);
  ctx.beginPath();
  ctx.arc(x + px, y + py, r * 0.27, 0, Math.PI * 2);
  ctx.fillStyle = INK;
  ctx.fill();
}

/** walk cycle: leg swing -1..1 and a little bob at the wide stance */
function gait(spec: Spec) {
  if (!spec.moving) return { s: 0, bob: 0 };
  const s = [1, 0, -1, 0][spec.phase]!;
  return { s, bob: s === 0 ? -0.35 : 0.15 };
}

// ---- lead ----------------------------------------------------------------------------------

const LEAD_W = 32;
const LEAD_H = 40;
const LEAD_G = 39;

function portalGun(ctx: Ctx, hx: number, hy: number) {
  // grip under the hand, body pointing left, green tube on top, emitter at the muzzle
  ink(ctx, GUN.dark, () => ctx.roundRect(hx - 0.6, hy - 0.4, 1.6, 2.6, 0.5));
  ink(ctx, GUN.body, () => ctx.roundRect(hx - 6.2, hy - 1.8, 7.4, 2.6, 1));
  ink(ctx, GUN.glow, () => ctx.roundRect(hx - 4.6, hy - 3.3, 4.2, 1.6, 0.8));
  ctx.beginPath();
  ctx.ellipse(hx - 2.5, hy - 2.6, 1.3, 0.35, 0, 0, Math.PI * 2);
  ctx.fillStyle = GUN.core;
  ctx.fill();
  ink(ctx, GUN.dark, () => ctx.roundRect(hx - 7.6, hy - 1.4, 1.8, 1.8, 0.5));
  ctx.beginPath();
  ctx.arc(hx - 7.9, hy - 0.5, 0.75, 0, Math.PI * 2);
  ctx.fillStyle = GUN.glow;
  ctx.fill();
}

function leadLegsFront(ctx: Ctx, cx: number, s: number) {
  const C = LEAD_COL;
  const hip = 27;
  for (const side of [-1, 1]) {
    const lift = (side === -1 ? s > 0 : s < 0) ? 1 : 0;
    const x = cx + side * 1.55;
    limb(
      ctx,
      [
        [x, hip],
        [x + side * 0.15, LEAD_G - 1.6 - lift],
      ],
      2.3,
      C.pants,
    );
    ellipse(ctx, x + side * 0.35, LEAD_G - 1 - lift, 1.75, 0.95, C.shoes);
  }
}

function leadLegsSide(ctx: Ctx, cx: number, s: number) {
  const C = LEAD_COL;
  const hip = 27;
  // far leg first, a touch darker
  for (const [k, shade] of [
    [-1, true],
    [1, false],
  ] as const) {
    const ax = cx + k * s * 2.8;
    const lift = s === 0 && k === 1 ? 0.9 : 0;
    limb(
      ctx,
      [
        [cx, hip],
        [ax + 0.3, LEAD_G - 1.6 - lift],
      ],
      2.3,
      shade ? "#76573c" : C.pants,
    );
    ellipse(ctx, ax - 0.6, LEAD_G - 1 - lift, 2.1, 0.95, C.shoes);
  }
}

function leadHeadFront(ctx: Ctx, cx: number, top: number, blink: boolean) {
  const C = LEAD_COL;
  const cy = top + 4.6;
  // spiky hair behind the head: up and out to the sides
  spikes(ctx, cx, cy - 0.6, Math.PI * 0.78, Math.PI * 2.22, 10, 8.2, 4.7, C.hair);
  ellipse(ctx, cx - 3.75, cy + 1.2, 0.8, 1.1, C.skin);
  ellipse(ctx, cx + 3.75, cy + 1.2, 0.8, 1.1, C.skin);
  // long face, narrower chin
  ink(ctx, C.skin, () => {
    ctx.moveTo(cx, top);
    ctx.bezierCurveTo(cx + 4.3, top, cx + 4.1, cy + 3.2, cx + 2.6, cy + 4.7);
    ctx.quadraticCurveTo(cx + 1.4, cy + 5.6, cx, cy + 5.6);
    ctx.quadraticCurveTo(cx - 1.4, cy + 5.6, cx - 2.6, cy + 4.7);
    ctx.bezierCurveTo(cx - 4.1, cy + 3.2, cx - 4.3, top, cx, top);
  });
  // unibrow: a wavy light-blue band with an outline
  const by = cy - 1.55;
  ctx.beginPath();
  ctx.moveTo(cx - 2.8, by + 0.5);
  ctx.quadraticCurveTo(cx - 1.6, by - 0.7, cx, by + 0.35);
  ctx.quadraticCurveTo(cx + 1.6, by - 0.7, cx + 2.8, by + 0.5);
  ctx.lineCap = "round";
  ctx.lineWidth = 0.95;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.lineWidth = 0.4;
  ctx.strokeStyle = C.hair;
  ctx.stroke();
  ctx.lineCap = "butt";
  // eyes close together, tiny mismatched pupils
  eye(ctx, cx - 1.5, cy, 1.3, -0.1, 0.05, blink);
  eye(ctx, cx + 1.5, cy, 1.3, 0.15, -0.05, blink);
  // bags under the eyes, nose, wide grumpy mouth, chin crease
  curve(ctx, cx - 2.5, cy + 1.25, cx - 1.5, cy + 1.95, cx - 0.6, cy + 1.3);
  curve(ctx, cx + 2.5, cy + 1.25, cx + 1.5, cy + 1.95, cx + 0.6, cy + 1.3);
  curve(ctx, cx + 0.1, cy + 1.2, cx + 0.9, cy + 2.4, cx + 0.1, cy + 2.6);
  ctx.beginPath();
  ctx.moveTo(cx - 2.3, cy + 3.6);
  ctx.quadraticCurveTo(cx, cy + 3.1, cx + 2.3, cy + 3.7);
  ctx.lineWidth = LW;
  ctx.strokeStyle = INK;
  ctx.stroke();
  curve(ctx, cx - 0.8, cy + 4.6, cx, cy + 4.9, cx + 0.8, cy + 4.6);
  // a string of drool from the corner of the mouth
  ctx.beginPath();
  ctx.moveTo(cx + 1.9, cy + 3.7);
  ctx.quadraticCurveTo(cx + 2.2, cy + 4.6, cx + 1.9, cy + 5.1);
  ctx.lineWidth = 0.35;
  ctx.strokeStyle = "#a9d8e6";
  ctx.stroke();
}

function leadHeadBack(ctx: Ctx, cx: number, top: number) {
  const C = LEAD_COL;
  const cy = top + 4.6;
  ellipse(ctx, cx - 3.7, cy + 1.2, 0.8, 1.1, C.skin);
  ellipse(ctx, cx + 3.7, cy + 1.2, 0.8, 1.1, C.skin);
  ink(ctx, C.skin, () => ctx.ellipse(cx, cy + 1.2, 3.5, 4.2, 0, 0, Math.PI * 2));
  // from behind the shock of hair covers almost the whole skull, down to the nape
  spikes(ctx, cx, cy + 0.4, Math.PI * 0.62, Math.PI * 2.38, 12, 8.2, 4.9, C.hair);
}

function leadHeadSide(ctx: Ctx, cx: number, top: number, blink: boolean) {
  const C = LEAD_COL;
  const cy = top + 4.6;
  // hair sweeps up and back (to the right)
  spikes(ctx, cx + 1.4, cy - 0.4, -Math.PI * 0.9, Math.PI * 0.45, 9, 8.2, 4.6, C.hair);
  ink(ctx, C.skin, () => {
    ctx.moveTo(cx + 0.4, top);
    ctx.quadraticCurveTo(cx - 3.1, top + 0.2, cx - 3.3, cy - 1.6); // forehead
    ctx.lineTo(cx - 3.6, cy - 0.8); // brow ridge
    ctx.lineTo(cx - 3.3, cy + 0.2);
    ctx.lineTo(cx - 4.9, cy + 1.6); // nose
    ctx.quadraticCurveTo(cx - 4.4, cy + 2.2, cx - 3.4, cy + 2.1);
    ctx.lineTo(cx - 3.8, cy + 3.2); // upper lip
    ctx.lineTo(cx - 3.2, cy + 3.6); // mouth corner
    ctx.lineTo(cx - 3.9, cy + 4.5); // jutting chin
    ctx.quadraticCurveTo(cx - 3.6, cy + 5.6, cx - 2.2, cy + 5.6);
    ctx.quadraticCurveTo(cx + 0.6, cy + 5.3, cx + 1.6, cy + 3.6); // jaw
    ctx.quadraticCurveTo(cx + 3.4, cy + 2.2, cx + 3.2, cy - 0.5);
    ctx.quadraticCurveTo(cx + 3, top, cx + 0.4, top);
  });
  ellipse(ctx, cx + 1.2, cy + 1.2, 0.8, 1.15, C.skin);
  // brow, eye, bag, mouth line
  ctx.beginPath();
  ctx.moveTo(cx - 3.5, cy - 1.4);
  ctx.quadraticCurveTo(cx - 2.2, cy - 2.2, cx - 0.6, cy - 1.4);
  ctx.lineCap = "round";
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = C.hair;
  ctx.stroke();
  ctx.lineCap = "butt";
  eye(ctx, cx - 2.1, cy, 1.25, -0.45, 0, blink);
  curve(ctx, cx - 3, cy + 1.25, cx - 2.1, cy + 1.9, cx - 1.1, cy + 1.25);
  curve(ctx, cx - 3.3, cy + 3.5, cx - 2.6, cy + 3.8, cx - 1.8, cy + 3.5);
}

function leadTorsoFront(ctx: Ctx, cx: number, top: number, back: boolean) {
  const C = LEAD_COL;
  const hem = top + 14;
  // shirt
  ink(ctx, C.shirt, () => {
    ctx.moveTo(cx - 3.4, top + 0.4);
    ctx.lineTo(cx + 3.4, top + 0.4);
    ctx.lineTo(cx + 3, top + 10.4);
    ctx.lineTo(cx - 3, top + 10.4);
    ctx.closePath();
  });
  if (back) {
    // the coat's back covers everything; a vent up the middle
    ink(ctx, C.coat, () => {
      ctx.moveTo(cx - 4, top);
      ctx.lineTo(cx + 4, top);
      ctx.quadraticCurveTo(cx + 5.4, top + 1.2, cx + 5.4, top + 3);
      ctx.lineTo(cx + 5.9, hem);
      ctx.lineTo(cx - 5.9, hem);
      ctx.lineTo(cx - 5.4, top + 3);
      ctx.quadraticCurveTo(cx - 5.4, top + 1.2, cx - 4, top);
    });
    line(ctx, [
      [cx, top + 8.5],
      [cx, hem],
    ]);
    line(ctx, [
      [cx - 3.6, top + 1],
      [cx + 3.6, top + 1],
    ]);
    return;
  }
  for (const side of [-1, 1]) {
    ink(ctx, C.coat, () => {
      ctx.moveTo(cx + side * 1.4, top);
      ctx.lineTo(cx + side * 4, top);
      ctx.quadraticCurveTo(cx + side * 5.4, top + 1.2, cx + side * 5.4, top + 3);
      ctx.lineTo(cx + side * 5.9, hem);
      ctx.lineTo(cx + side * 2.5, hem);
      ctx.lineTo(cx + side * 1.7, top + 4.6); // lapel
      ctx.lineTo(cx + side * 0.9, top + 2.2);
      ctx.closePath();
    });
    // pocket
    line(ctx, [
      [cx + side * 3.1, top + 9.6],
      [cx + side * 5, top + 9.6],
    ]);
  }
  // the shirt collar's V
  line(ctx, [
    [cx - 1, top + 0.4],
    [cx, top + 1.7],
    [cx + 1, top + 0.4],
  ]);
}

function leadArmsFront(ctx: Ctx, cx: number, top: number, s: number, back: boolean) {
  const C = LEAD_COL;
  for (const side of [-1, 1]) {
    const swing = side * s * 0.6;
    const hx = cx + side * 6 + (back ? 0 : 0);
    const hy = top + 11 + swing;
    limb(
      ctx,
      [
        [cx + side * 4.6, top + 1.4],
        [hx, hy - 1],
      ],
      2.2,
      C.coat,
    );
    ellipse(ctx, hx + side * 0.05, hy + 0.2, 0.95, 1.05, C.skin);
  }
}

function leadTorsoSide(ctx: Ctx, cx: number, top: number) {
  const C = LEAD_COL;
  const hem = top + 14;
  // shirt sliver at the front, the coat behind it flaring at the back
  ink(ctx, C.shirt, () => {
    ctx.moveTo(cx - 2.1, top + 0.6);
    ctx.lineTo(cx + 1, top + 0.4);
    ctx.lineTo(cx + 1, top + 10.4);
    ctx.lineTo(cx - 2.4, top + 10.4);
    ctx.closePath();
  });
  ink(ctx, C.coat, () => {
    ctx.moveTo(cx - 0.9, top);
    ctx.lineTo(cx + 2.4, top);
    ctx.quadraticCurveTo(cx + 3.6, top + 0.8, cx + 3.6, top + 3);
    ctx.lineTo(cx + 4.8, hem);
    ctx.lineTo(cx - 0.5, hem);
    ctx.lineTo(cx - 1, top + 6);
    ctx.lineTo(cx - 1.6, top + 2.4);
    ctx.closePath();
  });
  // the front coat flap swinging at the hem
  ink(ctx, C.coatShade, () => {
    ctx.moveTo(cx - 1.8, top + 9);
    ctx.lineTo(cx - 3.1, hem);
    ctx.lineTo(cx - 0.5, hem);
    ctx.lineTo(cx - 1, top + 6);
    ctx.closePath();
  });
}

function paintLead(ctx: Ctx, spec: Spec) {
  const C = LEAD_COL;
  const { s, bob } = gait(spec);
  const cx = LEAD_W / 2 + (spec.view === "left" ? 1.5 : 0);
  shadow(ctx, cx, LEAD_G, 5.2);
  const top = 17 + bob; // shoulders
  const head = 5.4 + bob; // top of the skull
  if (spec.view === "left") {
    leadLegsSide(ctx, cx, s);
    // the far arm, behind the body
    if (spec.pose !== "aim") {
      limb(
        ctx,
        [
          [cx + 0.6, top + 1.6],
          [cx + 0.6 + s * 2, top + 10],
        ],
        2.1,
        C.coatShade,
      );
    }
    leadTorsoSide(ctx, cx, top);
    limb(
      ctx,
      [
        [cx - 0.2, top - 0.8],
        [cx - 0.8, top + 0.6],
      ],
      1.6,
      C.skin,
    ); // neck, leaning forward
    leadHeadSide(ctx, cx, head, false);
    if (spec.pose === "aim") {
      limb(
        ctx,
        [
          [cx + 0.4, top + 1.6],
          [cx - 3.4, top + 2.6],
          [cx - 6.8, top + 2.4],
        ],
        2.1,
        C.coat,
      );
      ellipse(ctx, cx - 7.8, top + 2.5, 0.95, 1, C.skin);
      portalGun(ctx, cx - 7.8, top + 2.4);
    } else {
      const hx = cx + 0.4 - s * 2.4;
      limb(
        ctx,
        [
          [cx + 0.4, top + 1.6],
          [hx, top + 10],
        ],
        2.2,
        C.coat,
      );
      ellipse(ctx, hx, top + 11, 0.95, 1.05, C.skin);
    }
    return;
  }
  const back = spec.view === "up";
  leadLegsFront(ctx, cx, s);
  leadTorsoFront(ctx, cx, top, back);
  leadArmsFront(ctx, cx, top, s, back);
  if (!back) {
    limb(
      ctx,
      [
        [cx, top - 2],
        [cx, top + 0.2],
      ],
      1.7,
      C.skin,
    );
    leadHeadFront(ctx, cx, head, spec.pose === "blink");
  } else leadHeadBack(ctx, cx, head);
}

// ---- sidekick ------------------------------------------------------------------------------

const SIDEKICK_W = 24;
const SIDEKICK_H = 31;
const SIDEKICK_G = 30;

function sidekickLegs(ctx: Ctx, cx: number, s: number, side: boolean) {
  const C = SIDEKICK_COL;
  const hip = 21.5;
  if (side) {
    for (const [k, shade] of [
      [-1, true],
      [1, false],
    ] as const) {
      const ax = cx + k * s * 2.2;
      const lift = s === 0 && k === 1 ? 0.8 : 0;
      limb(
        ctx,
        [
          [cx, hip],
          [ax + 0.2, SIDEKICK_G - 1.7 - lift],
        ],
        2.6,
        shade ? "#335c99" : C.pants,
      );
      ellipse(ctx, ax - 0.5, SIDEKICK_G - 1.1 - lift, 1.95, 1.05, C.shoes);
    }
    return;
  }
  for (const k of [-1, 1]) {
    const lift = (k === -1 ? s > 0 : s < 0) ? 0.9 : 0;
    const x = cx + k * 1.6;
    limb(
      ctx,
      [
        [x, hip],
        [x, SIDEKICK_G - 1.7 - lift],
      ],
      2.6,
      C.pants,
    );
    ellipse(ctx, x + k * 0.3, SIDEKICK_G - 1.1 - lift, 1.75, 1.05, C.shoes);
  }
}

function sidekickShirt(ctx: Ctx, cx: number, top: number, side: boolean) {
  const C = SIDEKICK_COL;
  const w = side ? 2.9 : 3.7;
  ink(ctx, C.shirt, () => {
    ctx.moveTo(cx - w + 0.9, top);
    ctx.lineTo(cx + w - 0.9, top);
    ctx.quadraticCurveTo(cx + w, top + 0.2, cx + w, top + 1.6);
    ctx.lineTo(cx + w - 0.3, top + 8.2);
    ctx.lineTo(cx - w + 0.3, top + 8.2);
    ctx.lineTo(cx - w, top + 1.6);
    ctx.quadraticCurveTo(cx - w, top + 0.2, cx - w + 0.9, top);
  });
}

/** Short yellow sleeve, then a bare forearm to the hand at (hx, hy). */
function sidekickArm(ctx: Ctx, sx: number, sy: number, hx: number, hy: number) {
  const C = SIDEKICK_COL;
  const ex = sx + (hx - sx) * 0.42;
  const ey = sy + (hy - sy) * 0.42;
  limb(
    ctx,
    [
      [ex, ey],
      [hx, hy],
    ],
    1.6,
    C.skin,
  );
  limb(
    ctx,
    [
      [sx, sy],
      [ex, ey],
    ],
    2.4,
    C.shirt,
  );
  ellipse(ctx, hx, hy, 0.95, 1, C.skin);
}

function sidekickHeadFront(ctx: Ctx, cx: number, top: number, blink: boolean, panic: boolean) {
  const C = SIDEKICK_COL;
  const cy = top + 5;
  ellipse(ctx, cx - 4.9, cy + 0.6, 0.8, 1.1, C.skin);
  ellipse(ctx, cx + 4.9, cy + 0.6, 0.8, 1.1, C.skin);
  // wide round head, a little flatter at the chin
  ink(ctx, C.skin, () => {
    ctx.moveTo(cx, top);
    ctx.bezierCurveTo(cx + 5.4, top, cx + 5.4, cy + 4.6, cx, cy + 4.6);
    ctx.bezierCurveTo(cx - 5.4, cy + 4.6, cx - 5.4, top, cx, top);
  });
  // brown hair cap with a soft fringe
  ink(ctx, C.hair, () => {
    ctx.moveTo(cx - 4.7, cy - 0.6);
    ctx.bezierCurveTo(cx - 5.1, top - 0.9, cx + 5.1, top - 0.9, cx + 4.7, cy - 0.6);
    ctx.quadraticCurveTo(cx + 3.6, cy - 2.6, cx + 1.4, cy - 2.6);
    ctx.quadraticCurveTo(cx + 0.4, cy - 2.2, cx, cy - 2.8);
    ctx.quadraticCurveTo(cx - 0.6, cy - 2.3, cx - 1.6, cy - 2.6);
    ctx.quadraticCurveTo(cx - 3.8, cy - 2.6, cx - 4.7, cy - 0.6);
  });
  // big eyes, spaced apart, tiny pupils
  eye(ctx, cx - 2.1, cy, 1.75, 0, 0, blink);
  eye(ctx, cx + 2.1, cy, 1.75, 0, 0, blink);
  curve(ctx, cx - 0.2, cy + 1.5, cx + 0.5, cy + 2.1, cx - 0.1, cy + 2.4);
  if (panic) {
    ink(ctx, "#7a2f2f", () => ctx.ellipse(cx, cy + 3.3, 1.5, 0.85, 0, 0, Math.PI * 2), LW * 0.85);
  } else {
    // the nervous wavy mouth
    ctx.beginPath();
    ctx.moveTo(cx - 1.5, cy + 3.3);
    ctx.quadraticCurveTo(cx - 0.75, cy + 2.8, cx, cy + 3.25);
    ctx.quadraticCurveTo(cx + 0.75, cy + 3.7, cx + 1.5, cy + 3.15);
    ctx.lineWidth = LW * 0.9;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
}

function sidekickHeadBack(ctx: Ctx, cx: number, top: number) {
  const C = SIDEKICK_COL;
  const cy = top + 5;
  ellipse(ctx, cx - 4.9, cy + 0.6, 0.8, 1.1, C.skin);
  ellipse(ctx, cx + 4.9, cy + 0.6, 0.8, 1.1, C.skin);
  ink(ctx, C.skin, () => {
    ctx.moveTo(cx, top);
    ctx.bezierCurveTo(cx + 5.4, top, cx + 5.4, cy + 4.6, cx, cy + 4.6);
    ctx.bezierCurveTo(cx - 5.4, cy + 4.6, cx - 5.4, top, cx, top);
  });
  ink(ctx, C.hair, () => {
    ctx.moveTo(cx - 4.8, cy + 0.6);
    ctx.bezierCurveTo(cx - 5.6, top - 1.3, cx + 5.6, top - 1.3, cx + 4.8, cy + 0.6);
    ctx.quadraticCurveTo(cx + 3, cy + 3.3, cx, cy + 3.4);
    ctx.quadraticCurveTo(cx - 3, cy + 3.3, cx - 4.8, cy + 0.6);
  });
}

function sidekickHeadSide(ctx: Ctx, cx: number, top: number, blink: boolean) {
  const C = SIDEKICK_COL;
  const cy = top + 5;
  ink(ctx, C.skin, () => {
    ctx.moveTo(cx + 0.3, top);
    ctx.bezierCurveTo(cx - 4.3, top, cx - 4.9, cy - 0.5, cx - 4.6, cy + 0.6);
    ctx.quadraticCurveTo(cx - 5.4, cy + 1.3, cx - 4.6, cy + 1.8); // button nose
    ctx.bezierCurveTo(cx - 4.5, cy + 4.4, cx - 1.6, cy + 4.7, cx + 0.6, cy + 4.5);
    ctx.bezierCurveTo(cx + 4.6, cy + 4.1, cx + 4.6, top, cx + 0.3, top);
  });
  ink(ctx, C.hair, () => {
    ctx.moveTo(cx - 4, cy - 1.6);
    ctx.bezierCurveTo(cx - 3.8, top - 1, cx + 4.6, top - 1.2, cx + 4.3, cy + 1.4);
    ctx.quadraticCurveTo(cx + 3.2, cy + 3, cx + 2, cy + 2.2);
    ctx.quadraticCurveTo(cx + 1.4, cy - 0.6, cx - 0.4, cy - 1.6);
    ctx.quadraticCurveTo(cx - 2.2, cy - 2.4, cx - 4, cy - 1.6);
  });
  ellipse(ctx, cx + 1.1, cy + 1.1, 0.8, 1.1, C.skin);
  eye(ctx, cx - 2.6, cy + 0.1, 1.6, -0.6, 0, blink);
  curve(ctx, cx - 4, cy + 3.3, cx - 3.2, cy + 3.6, cx - 2.4, cy + 3.1);
}

function paintSidekick(ctx: Ctx, spec: Spec) {
  const { s, bob } = gait(spec);
  const cx = SIDEKICK_W / 2;
  shadow(ctx, cx, SIDEKICK_G, 4.6);
  const top = 14.2 + bob;
  const head = 3.6 + bob;
  if (spec.view === "left") {
    sidekickLegs(ctx, cx, s, true);
    if (spec.pose === "aim") {
      // startled: both hands up by the face
      sidekickArm(ctx, cx + 1, top + 1.4, cx + 2.4, top + 6.2);
      sidekickShirt(ctx, cx, top, true);
      sidekickHeadSide(ctx, cx, head, false);
      sidekickArm(ctx, cx - 0.4, top + 1.4, cx - 4.2, top - 1.6);
      return;
    }
    sidekickArm(ctx, cx + 0.4, top + 1.4, cx + 0.4 + s * 1.8, top + 7.4);
    sidekickShirt(ctx, cx, top, true);
    sidekickHeadSide(ctx, cx, head, false);
    sidekickArm(ctx, cx - 0.2, top + 1.4, cx - 0.2 - s * 2.2, top + 7.4);
    return;
  }
  sidekickLegs(ctx, cx, s, false);
  sidekickShirt(ctx, cx, top, false);
  if (spec.pose === "panic") {
    sidekickArm(ctx, cx - 3.4, top + 1.4, cx - 5.6, top - 3.6);
    sidekickArm(ctx, cx + 3.4, top + 1.4, cx + 5.6, top - 3.6);
  } else {
    sidekickArm(ctx, cx - 3.4, top + 1.4, cx - 4.3, top + 7.3 + s * 0.5);
    sidekickArm(ctx, cx + 3.4, top + 1.4, cx + 4.3, top + 7.3 - s * 0.5);
  }
  if (spec.view === "up") sidekickHeadBack(ctx, cx, head);
  else {
    sidekickHeadFront(ctx, cx, head, spec.pose === "blink", spec.pose === "panic");
    if (spec.view === "down" && spec.pose !== "panic") {
      // the collar
      curve(ctx, cx - 1.3, top + 0.1, cx, top + 1.2, cx + 1.3, top + 0.1);
    }
  }
}

// ---- sheets ---------------------------------------------------------------------------------

function linearSource(canvas: HTMLCanvasElement) {
  return new CanvasSource({
    resource: canvas,
    scaleMode: "linear",
    autoGenerateMipmaps: true,
  });
}

function sheet(w: number, h: number, ground: number, paint: (ctx: Ctx, s: Spec) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = w * RES * SPECS.length;
  canvas.height = h * RES;
  const ctx = canvas.getContext("2d")!;
  SPECS.forEach((spec, i) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(i * w * RES, 0, w * RES, h * RES);
    ctx.clip();
    ctx.translate(i * w * RES, 0);
    ctx.scale(RES, RES);
    paint(ctx, spec);
    ctx.restore();
  });
  const source = linearSource(canvas);
  const frames = SPECS.map(
    (_, i) => new Texture({ source, frame: new Rectangle(i * w * RES, 0, w * RES, h * RES) }),
  );
  return { frames, w, h, ground };
}

let lead: ToonSheet | null = null;
let sidekick: ToonSheet | null = null;

export function leadSheet(): ToonSheet {
  lead ??= sheet(LEAD_W, LEAD_H, LEAD_G, paintLead);
  return lead;
}

export function sidekickSheet(): ToonSheet {
  sidekick ??= sheet(SIDEKICK_W, SIDEKICK_H, SIDEKICK_G, paintSidekick);
  return sidekick;
}

// ---- portal ---------------------------------------------------------------------------------

/** radius of the portal disc in world px (before it is squashed into an upright oval) */
export const PORTAL_R = 17;

let portal: Texture | null = null;
let glow: Texture | null = null;
let shot: Texture | null = null;

/** The swirling disc: bright core, green arms spiralling out, a glowing rim. Rotated live. */
export function portalTexture(): Texture {
  if (portal) return portal;
  const R = PORTAL_R;
  const size = (R + 4) * 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size * RES;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(RES, RES);
  const c = size / 2;
  const halo = ctx.createRadialGradient(c, c, R * 0.8, c, c, R + 4);
  halo.addColorStop(0, "rgba(170, 255, 110, 0.55)");
  halo.addColorStop(1, "rgba(170, 255, 110, 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);
  const disc = ctx.createRadialGradient(c, c, 0, c, c, R);
  disc.addColorStop(0, "#f6ffd8");
  disc.addColorStop(0.25, "#cdf77e");
  disc.addColorStop(0.65, "#78d241");
  disc.addColorStop(1, "#3c9a2b");
  ctx.beginPath();
  ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.fillStyle = disc;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.lineCap = "round";
  for (const [color, width, offset] of [
    ["rgba(40, 120, 30, 0.55)", 2.2, 0.5],
    ["rgba(235, 255, 180, 0.8)", 1.2, 0],
  ] as const) {
    for (let arm = 0; arm < 6; arm++) {
      ctx.beginPath();
      for (let r = 1; r <= R; r += 0.4) {
        const a = arm * ((Math.PI * 2) / 6) + offset + r * 0.24;
        const x = c + Math.cos(a) * r;
        const y = c + Math.sin(a) * r;
        if (r === 1) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(c, c, R - 0.6, 0, Math.PI * 2);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "#d9ff8f";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(c, c, R + 0.3, 0, Math.PI * 2);
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = "#2f7d22";
  ctx.stroke();
  portal = new Texture({ source: linearSource(canvas) });
  return portal;
}

/** Green light the portal throws on the floor. */
export function portalGlowTexture(): Texture {
  if (glow) return glow;
  const w = 40;
  const h = 14;
  const canvas = document.createElement("canvas");
  canvas.width = w * RES;
  canvas.height = h * RES;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(RES, RES);
  ctx.translate(w / 2, h / 2);
  ctx.scale(1, h / w);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w / 2);
  g.addColorStop(0, "rgba(190, 255, 120, 0.7)");
  g.addColorStop(0.5, "rgba(120, 220, 70, 0.35)");
  g.addColorStop(1, "rgba(120, 220, 70, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(-w / 2, -w / 2, w, w);
  glow = new Texture({ source: linearSource(canvas) });
  return glow;
}

/** The portal gun's shot: a glowing green blob. */
export function portalShotTexture(): Texture {
  if (shot) return shot;
  const s = 10;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = s * RES;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(RES, RES);
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(250, 255, 220, 1)");
  g.addColorStop(0.3, "rgba(170, 250, 100, 0.95)");
  g.addColorStop(1, "rgba(110, 220, 60, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  shot = new Texture({ source: linearSource(canvas) });
  return shot;
}
