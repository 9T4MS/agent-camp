import { describe, expect, test } from "bun:test";
import {
  envelope,
  giphyGifUrl,
  parseConnectorMessage,
  parseGiphyId,
  parseViewerMessage,
} from "../src/index.ts";

const ID = "JIX9t2j0ZTN9S";

describe("parseGiphyId", () => {
  test("accepts every link shape people paste", () => {
    for (const input of [
      ID,
      `  ${ID}  `,
      `https://giphy.com/gifs/cat-funny-typing-${ID}`,
      `https://giphy.com/gifs/${ID}`,
      `https://www.giphy.com/gifs/cat-${ID}?utm_source=x`,
      `giphy.com/gifs/cat-${ID}`,
      `https://giphy.com/stickers/happy-dance-${ID}`,
      `https://giphy.com/embed/${ID}`,
      `https://giphy.com/gifs/${ID}/html5`,
      `https://giphy.com/gifs/someuser/cat-${ID}`,
      `https://media.giphy.com/media/${ID}/giphy.gif`,
      `https://media3.giphy.com/media/${ID}/200w.webp`,
      `https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/${ID}/giphy.gif`,
      `https://i.giphy.com/${ID}.gif`,
      `https://i.giphy.com/${ID}.webp`,
      `https://i.giphy.com/media/${ID}/giphy.webp`,
    ]) {
      expect(parseGiphyId(input)).toBe(ID);
    }
  });

  test("rejects everything else", () => {
    for (const input of [
      "",
      "   ",
      "https://example.com/gifs/cat-JIX9t2j0ZTN9S",
      "https://giphy.com.evil.example/gifs/cat-JIX9t2j0ZTN9S",
      "https://giphy.com/",
      "https://giphy.com/explore/cats",
      "https://giphy.com/clips/some-clip-abc",
      "https://media.giphy.com/media/../giphy.gif",
      "https://gph.is/g/abcdef",
      "not a link at all",
      "javascript:alert(1)",
    ]) {
      expect(parseGiphyId(input)).toBeNull();
    }
  });

  test("viewer URL is built from the id only", () => {
    expect(giphyGifUrl(ID)).toBe(`https://media.giphy.com/media/${ID}/200w.gif`);
    expect(giphyGifUrl(ID, 100)).toBe(`https://media.giphy.com/media/${ID}/100w.gif`);
  });
});

describe("gif on the wire", () => {
  const hello = (gif: unknown) =>
    envelope("connector.hello", {
      name: "Anna",
      password: "pw",
      clientId: "c1",
      connectorVersion: "0.1.0",
      gif: gif as string,
    });

  test("hello: id or empty string; never a URL", () => {
    expect(parseConnectorMessage(hello(ID)).ok).toBe(true);
    expect(parseConnectorMessage(hello("")).ok).toBe(true);
    expect(parseConnectorMessage(hello(`https://i.giphy.com/${ID}.gif`)).ok).toBe(false);
    expect(parseConnectorMessage(hello("a/../b")).ok).toBe(false);
  });

  test("gif.updated: with an id, or without one (removed)", () => {
    expect(parseViewerMessage(envelope("gif.updated", { personId: "anna", gif: ID })).ok).toBe(
      true,
    );
    expect(parseViewerMessage(envelope("gif.updated", { personId: "anna" })).ok).toBe(true);
    expect(
      parseViewerMessage(
        envelope("gif.updated", { personId: "anna", gif: "https://evil.example/x.gif" }),
      ).ok,
    ).toBe(false);
  });
});
