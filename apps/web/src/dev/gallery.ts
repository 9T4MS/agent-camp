/**
 * ?gallery=1: every character frame for a set of avatars + furniture, for art review.
 * ?gallery=look[&look=tracht|b64:…][&gscale=N]: one detailed look, big hero frames + sheets.
 */
import {
  AGENTS,
  type AgentKind,
  type AvatarSpec,
  avatarFromSeed,
  sessionVariation,
} from "@agent-office/protocol";
import { LOOK_FIXTURES } from "@agent-office/protocol/fixtures";
import { type Application, Container, Sprite, Text } from "pixi.js";
import { ANIM, CHAR_H, CHAR_W, characterSheet, lookFor } from "../art/characters.ts";
import { chairTexture, deskTexture, monitorTextures, propTexture } from "../art/desk.ts";
import { ART, furnitureFrames } from "../art/furniture.ts";
import { alertTextures, botTextures, bubbleTexture, catTextures, dotsTextures } from "../art/fx.ts";
import { C } from "../art/palette.ts";
import { queenTextures } from "../art/queen.ts";
import { parseLookParam } from "../demo/demoFeed.ts";
import type { ObjectKind } from "../world/map.ts";

const NAMES = [
  "anna",
  "martin",
  "lea",
  "jonas",
  "sofia",
  "max",
  "mia",
  "felix",
  "clara",
  "paul",
  "nora",
  "elias",
];

declare global {
  interface Window {
    /** set by ?gallery=look once everything is drawn (screenshots wait for it) */
    __galleryReady?: boolean;
  }
}

const SHOWCASE: [Partial<AvatarSpec>, AgentKind][] = [
  [
    {
      hairStyle: "short",
      hairColor: "dark-brown",
      facialHair: "beard",
      glasses: "round",
      accessory: "cap-mint",
      outfit: "flannel",
      leftHand: "beer",
      rightHand: "joint",
    },
    "claude",
  ],
  [{ outfit: "flannel-red", leftHand: "coffee", rightHand: "phone" }, "codex"],
  [{ outfit: "tee", accessory: "none", rightHand: "beer" }, "pi"],
  [{ outfit: "hoodie", leftHand: "phone" }, "unknown"],
];

export function showGallery(app: Application) {
  const params = new URLSearchParams(location.search);
  if (params.get("gallery") === "look") {
    showLookGallery(
      app,
      parseLookParam(params.get("look"), LOOK_FIXTURES) ?? LOOK_FIXTURES.tracht,
      params,
    );
    return;
  }
  const root = new Container();
  root.scale.set(Number(new URLSearchParams(location.search).get("gscale")) || 3);
  app.stage.addChild(root);
  // seeded looks, then a few editor-only outfits / held items
  const looks = [
    ...NAMES.map((n, row) =>
      lookFor(
        avatarFromSeed(n),
        AGENTS[row % AGENTS.length]!,
        row % 3 === 2 ? sessionVariation(n) : null,
      ),
    ),
    ...SHOWCASE.map(([extra, agent]) =>
      lookFor({ ...avatarFromSeed("tom"), ...extra }, agent, null),
    ),
  ];
  looks.forEach((look, row) => {
    const sheet = characterSheet(look);
    sheet.frames.forEach((f, i) => {
      const s = new Sprite(f);
      s.position.set(4 + i * 17, 4 + row * 26);
      root.addChild(s);
    });
  });
  let x = 4;
  const y = 4 + looks.length * 26 + 4;
  for (const kind of Object.keys(ART) as ObjectKind[]) {
    const frames = furnitureFrames(kind, 0)!;
    const s = new Sprite(frames[0]!);
    s.position.set(x, y);
    root.addChild(s);
    x += s.width + 4;
  }
  let x2 = 4;
  const y2 = y + 60;
  const extra = [
    deskTexture(),
    chairTexture(),
    ...monitorTextures(),
    propTexture("plant"),
    propTexture("mug"),
    propTexture("rubber-duck"),
    propTexture("figurine"),
    propTexture("lamp"),
    propTexture("books"),
    propTexture("cactus"),
    propTexture("cat-photo"),
    ...botTextures("claude"),
    ...botTextures("codex"),
    ...catTextures(),
    ...queenTextures(),
    ...alertTextures(),
    ...dotsTextures(),
    bubbleTexture("typing", "agent-office"),
    bubbleTexture("reading", "docs"),
    bubbleTexture("running", "infra"),
    bubbleTexture("waiting", "web-shop"),
    bubbleTexture("idle", "billing"),
    bubbleTexture("thinking", "ml-pipeline"),
  ];
  for (const t of extra) {
    const s = new Sprite(t);
    s.position.set(x2, y2);
    root.addChild(s);
    x2 += t.width + 3;
  }
}

const label = (text: string, x: number, y: number) => {
  const t = new Text({
    text,
    style: { fontFamily: "monospace", fontSize: 14, fill: C.cream },
  });
  t.position.set(x, y);
  return t;
};

type GalleryRow = [
  string,
  AvatarSpec,
  (typeof AGENTS)[number],
  ReturnType<typeof sessionVariation> | null,
];

/** Detailed-look gallery: hero frames, then whole sheets per agent and variation. */
function showLookGallery(app: Application, avatar: AvatarSpec, params: URLSearchParams) {
  const hero = Number(params.get("gscale")) || 12;
  const small = 3;
  const root = new Container();
  app.stage.addChild(root);
  const pad = 16;
  let y = pad;
  const heroFrames: [string, number][] = [
    ["idle front", ANIM.idleDown[0]],
    ["walk left", ANIM.walkLeft[0]],
    ["sit, typing", ANIM.sitType[0]],
    ["raise hand", ANIM.raiseHand[0]],
    ["sit front", ANIM.sitFront[0]],
  ];
  const heroSheet = characterSheet(lookFor(avatar, "claude", null));
  let x = pad;
  for (const [name, i] of heroFrames) {
    const s = new Sprite(heroSheet.frames[i]!);
    s.scale.set(hero);
    s.position.set(x, y + 20);
    const t = label(name, x, y);
    root.addChild(s, t);
    x += Math.max(CHAR_W * hero, t.width) + pad;
  }
  let width = x;
  y += 20 + CHAR_H * hero + pad * 2;
  const rows: GalleryRow[] = [
    ...AGENTS.map((a): GalleryRow => [`agent: ${a}`, avatar, a, null]),
    ["sibling session (variation 1)", avatar, "claude", sessionVariation("gallery-sib-1")],
    ["sibling session (variation 2)", avatar, "codex", sessionVariation("gallery-sib-3")],
    ["catalog look (comparison)", avatarFromSeed("martin"), "claude", null],
  ];
  for (const [name, av, agent, variation] of rows) {
    const sheet = characterSheet(lookFor(av, agent, variation));
    root.addChild(label(name, pad, y));
    sheet.frames.forEach((f, i) => {
      const s = new Sprite(f);
      s.scale.set(small);
      s.position.set(pad + i * (CHAR_W * small + 2), y + 20);
      root.addChild(s);
    });
    width = Math.max(width, pad + sheet.frames.length * (CHAR_W * small + 2));
    y += 20 + CHAR_H * small + pad;
  }
  // size the page to the content so full-page screenshots get everything
  const host = app.canvas.parentElement;
  if (host) {
    host.style.position = "absolute";
    host.style.width = `${Math.max(width + pad, window.innerWidth)}px`;
    host.style.height = `${Math.max(y, window.innerHeight)}px`;
    document.body.style.overflow = "auto";
    document.documentElement.style.overflow = "auto";
  }
  app.resize();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      window.__galleryReady = true;
    }),
  );
}
