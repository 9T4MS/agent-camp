import { expect, test } from "bun:test";

const luminance = (rgb: number[]) =>
  rgb
    .map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: number[], b: number[]) => {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
};
test("opaque chat text on minimal local support meets contrast over worst-case white scenery", () => {
  // messages.css: #181425e6 text-only backing. Full-panel fill remains zero.
  const support = [24, 20, 37].map((v) => v * (230 / 255) + 255 * (25 / 255));
  expect(contrast([255, 245, 214], support)).toBeGreaterThanOrEqual(4.5);
  expect(contrast([196, 181, 163], support)).toBeGreaterThanOrEqual(4.5);
  console.log(
    `Chat contrast: body ${contrast([255, 245, 214], support).toFixed(2)}:1; metadata ${contrast([196, 181, 163], support).toFixed(2)}:1 (white scene)`,
  );
});
