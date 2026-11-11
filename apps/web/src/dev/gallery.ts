/** ?gallery=1: every character frame for a set of avatars + furniture, for art review. */
import { AGENTS, avatarFromSeed, sessionVariation } from "@agent-office/protocol";
import { type Application, Container, Sprite } from "pixi.js";
import { characterSheet, lookFor } from "../art/characters.ts";
import { chairTexture, deskTexture, monitorTextures, propTexture } from "../art/desk.ts";
import { ART, furnitureFrames } from "../art/furniture.ts";
import { alertTextures, botTextures, bubbleTexture, catTextures, dotsTextures } from "../art/fx.ts";
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

export function showGallery(app: Application) {
  const root = new Container();
  root.scale.set(Number(new URLSearchParams(location.search).get("gscale")) || 3);
  app.stage.addChild(root);
  NAMES.forEach((n, row) => {
    const agent = AGENTS[row % AGENTS.length]!;
    const sheet = characterSheet(
      lookFor(avatarFromSeed(n), agent, row % 3 === 2 ? sessionVariation(n) : null),
    );
    sheet.frames.forEach((f, i) => {
      const s = new Sprite(f);
      s.position.set(4 + i * 17, 4 + row * 26);
      root.addChild(s);
    });
  });
  let x = 4;
  const y = 4 + NAMES.length * 26 + 4;
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
