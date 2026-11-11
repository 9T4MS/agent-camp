import { describe, expect, test } from "bun:test";
import { moduleScriptSrc } from "../src/kiosk.ts";

describe("moduleScriptSrc", () => {
  test("finds the built entry module, not the inline script before it", () => {
    const html = `<head><script>
      if (/[?&]kiosk=(1|true)(&|$)/.test(location.search)) x();
    </script></head><body><div id="app"></div>
    <script type="module" crossorigin src="./assets/index-T6pACjux.js"></script></body>`;
    expect(moduleScriptSrc(html)).toBe("./assets/index-T6pACjux.js");
  });

  test("null without a module script (login page, error page)", () => {
    expect(moduleScriptSrc("<p>The office is offline.</p>")).toBeNull();
  });
});
