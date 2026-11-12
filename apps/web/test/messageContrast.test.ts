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
test("opaque chat text on the default full-card fill meets contrast over worst-case white scenery", () => {
  // messages.css: #181425 at 85% on the entire card, with no row/text backings.
  const support = [24, 20, 37].map((v) => v * 0.85 + 255 * 0.15);
  expect(contrast([255, 245, 214], support)).toBeGreaterThanOrEqual(4.5);
  const metadata = [228, 166, 114]; // theme.css --sand, used by sender names and timestamps.
  expect(contrast(metadata, support)).toBeGreaterThanOrEqual(4.5);
  console.log(
    `Chat contrast: body ${contrast([255, 245, 214], support).toFixed(2)}:1; metadata ${contrast(metadata, support).toFixed(2)}:1 (white scene)`,
  );
});
