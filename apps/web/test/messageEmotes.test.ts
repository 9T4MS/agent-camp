import { expect, test } from "bun:test";
import { insertMessageText, messageFragments, officeEmotes } from "../src/ui/messageEmotes.ts";

test("only exact lowercase office tokens get a same-origin asset", () => {
  const parts = messageFragments(
    "<img src=x onerror=alert(1)> :coffee::coffee: :Coffee: :unknown: שלום",
  );
  expect(parts.filter((p) => p.emote).map((p) => p.text)).toEqual([":coffee:", ":coffee:"]);
  expect(parts.map((p) => p.text).join("")).toBe(
    "<img src=x onerror=alert(1)> :coffee::coffee: :Coffee: :unknown: שלום",
  );
  expect(officeEmotes).toHaveLength(6);
  for (const emote of officeEmotes) expect(emote.url).toMatch(/^\/emotes\/office\/[a-z]+\.svg$/);
});
test("insertion replaces selection and returns caret, not truncated tokens", () => {
  expect(insertMessageText("abc def", 4, 7, ":coffee:")).toEqual({
    text: "abc :coffee:",
    caret: 12,
  });
  expect(insertMessageText("x".repeat(199), 199, 199, "👩🏽‍💻")).toBeNull();
  expect(insertMessageText("x".repeat(195), 195, 195, ":wave:")).toBeNull();
  expect(insertMessageText("x".repeat(200), 190, 200, "👩🏽‍💻")?.text.length).toBe(197);
});
