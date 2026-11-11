import { describe, expect, test } from "bun:test";
import {
  HINT_INVALID,
  HINT_SAME,
  MSG_LOGGED_OUT,
  MSG_NETWORK,
  MSG_NOT_FOUND,
  MSG_NOT_YOU,
  saveOutcome,
  validateGifInput,
} from "../src/ui/customize.ts";

const GIF = "JIX9t2j0ZTN9S";
const OTHER = "l0MYt5jPR6QX5pnqM";

describe("validateGifInput", () => {
  test("empty / whitespace: nothing to save, no hint", () => {
    expect(validateGifInput("", undefined)).toEqual({ state: "empty" });
    expect(validateGifInput("   \n", GIF)).toEqual({ state: "empty" });
  });

  test("not a Giphy GIF link", () => {
    for (const s of [
      "https://example.com/cat.gif",
      "hello there",
      "https://giphy.com/clips/foo-abc123",
      "https://gph.is/abc",
    ])
      expect(validateGifInput(s, undefined)).toEqual({ state: "invalid", hint: HINT_INVALID });
  });

  test("valid page links, media links and bare ids", () => {
    for (const s of [
      `https://giphy.com/gifs/cat-typing-${GIF}`,
      `  https://media.giphy.com/media/${GIF}/giphy.gif  `,
      `https://i.giphy.com/${GIF}.webp`,
      GIF,
    ])
      expect(validateGifInput(s, OTHER)).toEqual({ state: "valid", id: GIF });
  });

  test("same as the current GIF", () => {
    expect(validateGifInput(`https://giphy.com/gifs/cat-${GIF}`, GIF)).toEqual({
      state: "same",
      id: GIF,
      hint: HINT_SAME,
    });
  });

  test("no current GIF: any valid link is new", () => {
    expect(validateGifInput(GIF, null).state).toBe("valid");
    expect(validateGifInput(GIF, undefined).state).toBe("valid");
  });
});

describe("saveOutcome", () => {
  test("200 saved (response not used for the display)", () => {
    expect(saveOutcome({ status: 200, body: { personId: "p", gif: GIF } })).toEqual({
      kind: "saved",
    });
    expect(saveOutcome({ status: 200, body: null })).toEqual({ kind: "saved" });
  });

  test("401 logged out, 403 not confirmed as this person", () => {
    expect(saveOutcome({ status: 401, body: { error: "unauthorized" } })).toEqual({
      kind: "error",
      message: MSG_LOGGED_OUT,
    });
    expect(
      saveOutcome({ status: 403, body: { error: "you can only change your own GIF" } }),
    ).toEqual({
      kind: "error",
      message: MSG_NOT_YOU,
    });
  });

  test("400 shows the server's message", () => {
    expect(saveOutcome({ status: 400, body: { error: "not a Giphy GIF link" } })).toEqual({
      kind: "error",
      message: "not a Giphy GIF link",
    });
    // no readable message: generic text, never the raw body
    expect(saveOutcome({ status: 400, body: "<html>" })).toEqual({
      kind: "error",
      message: "That didn't work",
    });
    expect(saveOutcome({ status: 400, body: { error: "  " } }).kind).toBe("error");
  });

  test("400 caps very long server messages", () => {
    const out = saveOutcome({ status: 400, body: { error: "x".repeat(5000) } });
    expect(out.kind === "error" && out.message.length).toBe(200);
  });

  test("404 not in the office", () => {
    expect(saveOutcome({ status: 404, body: { error: "not found" } })).toEqual({
      kind: "error",
      message: MSG_NOT_FOUND,
    });
  });

  test("network error", () => {
    expect(saveOutcome({ status: 0, body: null })).toEqual({ kind: "error", message: MSG_NETWORK });
  });

  test("other statuses", () => {
    expect(saveOutcome({ status: 503, body: null })).toEqual({
      kind: "error",
      message: "Something went wrong (HTTP 503). Try again.",
    });
    expect(saveOutcome({ status: 429, body: { error: "slow down" } })).toEqual({
      kind: "error",
      message: "slow down",
    });
  });
});
