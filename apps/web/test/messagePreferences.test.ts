import { describe, expect, test } from "bun:test";
import { defaultPresentation, messagePreferences } from "../src/state/messagePreferences.ts";

describe("message presentation migration", () => {
  test("fresh browsers see clear overlay without a legacy preference", () => {
    expect(messagePreferences(null, null)).toEqual({
      version: 1,
      visible: true,
      appearance: defaultPresentation,
    });
  });
  test.each(["true", "false"])("preserves legacy popup %s", (legacy) => {
    const result = messagePreferences(null, legacy);
    expect(result.appearance.mode).toBe("popup");
    expect(result.visible).toBe(legacy === "true");
  });
  test("valid values round-trip independently of visibility", () => {
    const saved = {
      version: 1,
      visible: false,
      appearance: { ...defaultPresentation, mode: "popup", size: 20, background: 85 },
    } as const;
    expect(messagePreferences(JSON.stringify(saved), null)).toEqual(saved);
  });
  test.each(["{", "null", "[]", '{"version":2}'])("rejects invalid envelope %s", (raw) => {
    expect(messagePreferences(raw, null).appearance).toEqual(defaultPresentation);
  });
  test("validates each property and ignores unrelated storage", () => {
    const result = messagePreferences(
      JSON.stringify({
        version: 1,
        visible: "false",
        appearance: {
          width: 9999,
          height: -1,
          background: 94,
          size: "20",
          icons: false,
          emotes: "yes",
          mode: "html",
        },
        text: "secret",
      }),
      null,
    );
    expect(result).toEqual({
      version: 1,
      visible: true,
      appearance: { ...defaultPresentation, icons: false },
    });
  });
});
