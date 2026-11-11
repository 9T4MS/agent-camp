/** Per-frame painting context shared by the part painters. */
import type { CharacterLook, Ramp } from "@agent-office/protocol";
import type { PixelCanvas } from "../pixel.ts";
import type { FrameSpec, View } from "./geometry.ts";
import type { RenderLook } from "./renderLook.ts";

export type Ctx = {
  pc: PixelCanvas;
  r: RenderLook;
  L: CharacterLook;
  f: FrameSpec;
  view: View;
  /** head + torso vertical offset (bob + seat drop) */
  dy: number;
  /** torso columns (inclusive) for the current view */
  tl: number;
  tr: number;
  /** the look's pose applies (standing idle front) */
  posed: boolean;
  /** sleeve colours: outer garment if any, else shirt */
  sleeve: Ramp;
  /** painters that run after the outline (thin held items and their smoke) */
  after: (() => void)[];
};

/** Torso columns per build and view. */
export function torsoCols(build: CharacterLook["build"], view: View): [number, number] {
  if (view === "left") {
    if (build === "slim") return [11, 20];
    if (build === "broad") return [10, 22];
    return [10, 21];
  }
  if (build === "slim") return [9, 22];
  if (build === "broad") return [7, 24];
  return [8, 23];
}
