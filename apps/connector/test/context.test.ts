import { describe, expect, test } from "bun:test";
import { claudeContext } from "../src/detect/claude.ts";
import { codexContext } from "../src/detect/codex.ts";
import { roundContext } from "../src/detect/index.ts";

const claude = (usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  message: { model: "claude-opus-5-5", usage, content: [] },
  ...extra,
});

describe("context share", () => {
  test("claude: last main-thread usage over a 200k window", () => {
    const entries = [
      claude({ input_tokens: 10, cache_read_input_tokens: 1_000 }),
      { type: "user", message: { content: "hi" } },
      claude({ input_tokens: 5, cache_creation_input_tokens: 5, cache_read_input_tokens: 99_990 }),
      claude({ input_tokens: 1 }, { isSidechain: true }),
      { type: "assistant", message: { model: "<synthetic>", usage: { input_tokens: 0 } } },
    ];
    expect(claudeContext(entries)).toBe(0.5);
  });

  test("claude: past 200k (or a [1m] model) means the 1M window", () => {
    expect(claudeContext([claude({ cache_read_input_tokens: 300_000 })])).toBe(0.3);
    const oneM = {
      type: "assistant",
      message: { model: "claude-x[1m]", usage: { input_tokens: 100_000 } },
    };
    expect(claudeContext([oneM])).toBe(0.1);
    expect(claudeContext([{ type: "user" }])).toBeUndefined();
  });

  test("codex: token_count carries its own window", () => {
    const tc = (input: number, window: number) => ({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: input }, model_context_window: window },
      },
    });
    expect(codexContext([tc(1, 10), tc(68_000, 272_000)])).toBe(0.25);
    expect(
      codexContext([{ type: "event_msg", payload: { type: "token_count", info: null } }]),
    ).toBeUndefined();
  });

  test("rounded to 5% steps, capped at 100%", () => {
    expect(roundContext(0.281)).toBe(0.3);
    expect(roundContext(0.274)).toBe(0.25);
    expect(roundContext(1.4)).toBe(1);
    expect(roundContext(undefined)).toBeUndefined();
    expect(roundContext(Number.NaN)).toBeUndefined();
  });
});
