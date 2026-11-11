import { describe, expect, test } from "bun:test";
import { cycleOption } from "../src/ui/carousel.ts";

const opts = ["none", "beer", "joint", "phone"].map((id) => ({ id }));

describe("look studio carousel", () => {
  test("steps forward and back, wrapping around", () => {
    expect(cycleOption(opts, "none", 1)).toBe("beer");
    expect(cycleOption(opts, "phone", 1)).toBe("none");
    expect(cycleOption(opts, "none", -1)).toBe("phone");
  });
  test("skips taken choices (desk props on other slots)", () => {
    expect(cycleOption(opts, "none", 1, new Set(["beer", "joint"]))).toBe("phone");
    expect(cycleOption(opts, "phone", -1, new Set(["joint", "beer"]))).toBe("none");
  });
  test("unknown current value starts from the first option; all skipped stays put", () => {
    expect(cycleOption(opts, "space-suit", 1)).toBe("beer");
    expect(cycleOption(opts, "beer", 1, new Set(["none", "joint", "phone", "beer"]))).toBe("beer");
  });
});
