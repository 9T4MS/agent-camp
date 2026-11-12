/** Fresh-browser overlay assertions against the real local office and message endpoints. */
import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";

export async function checkChatOverlay(
  browser: Browser,
  http: string,
  password: string,
  shoot: (page: Page, name: string) => Promise<void>,
) {
  let checks = 0;
  const check = (value: unknown, reason: string) => {
    assert.ok(value, reason);
    checks++;
  };
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
    extraHTTPHeaders: { authorization: `Bearer ${password}` },
  });
  const errors: string[] = [];
  let serial = 0;
  const post = async (text: string) => {
    const response = await ctx.request.post(`${http}/api/messages`, {
      headers: { "cf-connecting-ip": `chat-overlay-${++serial}` },
      data: { audience: { kind: "everyone" }, text, from: "Anna Longname", notifyDesktop: false },
    });
    assert.equal(response.status(), 201);
  };
  try {
    for (let i = 0; i < 16; i++) await post(`Build ${i + 1} is ready :shipit: ☕`);
    await post("Coffee by the campfire? :coffee: :campfire: :wave: :party: :thinking: 👩🏽‍💻 שלום");
    const page = await ctx.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${http}/?hour=14`);
    await page.waitForFunction(() => window.__office?.ready);
    const panel = page.locator(".messages-panel");
    const text = page.getByRole("textbox", { name: "Office message", exact: true });
    await page.locator(".messages-log article").last().waitFor();
    check(await panel.isVisible(), "fresh browser sees overlay without clicking");
    check(
      await panel.evaluate((el) => el.classList.contains("messages-resting")),
      "starts passive",
    );
    check(await text.isHidden(), "resting overlay hides composer");
    check(
      await panel.evaluate(
        (el) =>
          getComputedStyle(el).backgroundColor === "rgba(0, 0, 0, 0)" ||
          getComputedStyle(el).backgroundColor.endsWith("/ 0)"),
      ),
      "unused panel space is transparent",
    );
    check((await page.locator(".messages-log img").count()) >= 6, "six local emotes render inline");
    check(
      await page
        .locator(".messages-log img")
        .evaluateAll((images) =>
          images.every(
            (im) => (im as HTMLImageElement).complete && (im as HTMLImageElement).naturalWidth > 0,
          ),
        ),
      "emote assets load",
    );
    check(
      await panel.evaluate((el) => !el.contains(document.activeElement)),
      "boot does not steal focus",
    );
    await shoot(page, "18-chat-clear-bright");
    await panel.press("Escape");
    check(await panel.isVisible(), "idle Escape does not hide persistent feed");
    await page.locator(".messages-log").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(100);
    const firstId = await page
      .locator(".messages-log article")
      .first()
      .getAttribute("data-message-id");
    await post("A live arrival while reading older rows");
    await page.waitForFunction(() =>
      document.querySelector(".messages-log")?.textContent?.includes("A live arrival"),
    );
    check(
      await page.locator(".messages-log").evaluate((el) => el.scrollTop < 20),
      "new arrivals preserve scrolled-up reader",
    );
    check(await page.locator(".messages-jump").isVisible(), "new arrivals expose explicit jump");
    check(
      (await page.locator(".messages-log article").first().getAttribute("data-message-id")) ===
        firstId,
      "keyed row retained",
    );
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    await page.getByLabel("Width", { exact: true }).selectOption("440");
    await page.getByLabel("Display", { exact: true }).selectOption("popup");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(100);
    check(
      await page.locator(".messages-log").evaluate((el) => el.scrollTop < 20),
      "settings/mode change preserves the scrolled-up anchor",
    );
    check(
      (await page.locator(".messages-launch").textContent())?.includes("· 1"),
      "mode/height changes do not consume unseen newer messages",
    );
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    await page.getByLabel("Display", { exact: true }).selectOption("overlay");
    await page.getByLabel("Width", { exact: true }).selectOption("380");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.locator(".messages-jump").click();
    // Headless Chromium reports every tab focused; exercise the browser attention gate explicitly.
    await page.evaluate(() =>
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false }),
    );
    await post("Unread while the office document is unfocused");
    await page.waitForFunction(() =>
      document.querySelector(".messages-launch")?.textContent?.includes("· 1"),
    );
    check(
      (await page.locator(".messages-launch").textContent())?.includes("· 1"),
      "unfocused visible overlay does not consume unread",
    );
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "hasFocus");
      window.dispatchEvent(new Event("focus"));
    });
    await panel.focus();
    await page.waitForFunction(
      () => document.querySelector(".messages-launch")?.textContent === "Messages",
    );
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    await page.getByLabel("Text size", { exact: true }).selectOption("20");
    await page.getByLabel("Overlay background", { exact: true }).selectOption("20");
    await shoot(page, "18-chat-settings");
    for (const fill of ["0", "20", "85", "100"]) {
      await page.getByLabel("Overlay background", { exact: true }).selectOption(fill);
      check(
        await panel.evaluate((el) => getComputedStyle(el).opacity === "1"),
        `background ${fill}% never fades text`,
      );
    }
    for (const size of ["16", "18", "20"]) {
      await page.getByLabel("Text size", { exact: true }).selectOption(size);
      check(
        await page
          .locator(".messages-sample")
          .evaluate((el, size) => getComputedStyle(el).fontSize === `${size}px`, size),
        `live text-size sample ${size}px`,
      );
    }
    await page.getByLabel("Overlay background", { exact: true }).selectOption("0");
    await page.getByLabel("Text size", { exact: true }).selectOption("16");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    check(
      await page
        .getByRole("button", { name: "Chat settings", exact: true })
        .evaluate((el) => el === document.activeElement),
      "settings restores trigger focus",
    );
    await page.getByRole("button", { name: "Write a message…", exact: true }).click();
    await text.fill("Hello world");
    await text.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(6, 11));
    await page.getByRole("button", { name: "Emoji & office emotes", exact: true }).click();
    await page.getByRole("button", { name: "Office", exact: true }).click();
    await page.getByRole("button", { name: "Coffee break :coffee:", exact: true }).click();
    check((await text.inputValue()) === "Hello :coffee:", "picker inserts at saved selection");
    check(
      await text.evaluate(
        (el) => el === document.activeElement && (el as HTMLTextAreaElement).selectionStart === 14,
      ),
      "insertion restores caret and focus",
    );
    await text.fill("x".repeat(199));
    await page.getByRole("button", { name: "Emoji & office emotes", exact: true }).click();
    await page.getByRole("button", { name: "Coffee break :coffee:", exact: true }).click();
    check((await text.inputValue()) === "x".repeat(199), "over-limit insertion rejected as whole");
    check(
      (await page.locator(".messages-send-status").textContent())?.includes("200 UTF-16"),
      "insertion limit explained",
    );
    await page.keyboard.press("Escape");
    check(
      await page.locator(".messages-emoji-picker").isHidden(),
      "Escape closes innermost picker",
    );
    check(await text.isVisible(), "picker Escape retains composer");
    await text.fill("Lunch? :coffee: 👩🏽‍💻");
    const id = await page.evaluate(() => [...window.__office.model.people.keys()][0]!);
    await page.evaluate((person) => window.__office.openPerson(person), id);
    await page.locator(".poke-message").click();
    check(
      (await text.inputValue()) === "Lunch? :coffee: 👩🏽‍💻",
      "person-card composition retains draft",
    );
    check(
      (await page.getByLabel("Notification recipients", { exact: true }).inputValue()) ===
        "selected",
      "selected audience preserved",
    );
    await page.getByRole("button", { name: "Emoji & office emotes", exact: true }).click();
    await shoot(page, "18-chat-selected-emotes");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    await page.getByLabel("Display", { exact: true }).selectOption("popup");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    check((await text.inputValue()) === "Lunch? :coffee: 👩🏽‍💻", "mode switch preserves draft");
    check(
      !(await panel.evaluate((el) => el.classList.contains("messages-overlay"))),
      "popup mode selected",
    );
    await shoot(page, "18-chat-popup");
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    await page.getByLabel("Display", { exact: true }).selectOption("overlay");
    await page.getByLabel("Office emotes", { exact: true }).selectOption("false");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    check(
      (await page.locator(".messages-log img").count()) === 0,
      "text emotes option removes images",
    );
    await text.press("Escape");
    check(await panel.isVisible(), "composer Escape returns to persistent reading");
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    check(await panel.isHidden(), "explicit Hide works");
    await page.reload();
    await page.waitForFunction(() => window.__office?.ready);
    check(await panel.isHidden(), "hidden state survives reload");
    await page.locator(".messages-launch").click();
    check(await panel.isVisible(), "launcher restores feed");
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    await page.getByLabel("Office emotes", { exact: true }).selectOption("true");
    await page.getByLabel("Position", { exact: true }).selectOption("right");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.evaluate((person) => window.__office.openPerson(person), id);
    await page.waitForTimeout(200);
    check(
      (await panel.getAttribute("data-position")) === "left",
      "right-side card temporarily docks right preference left",
    );
    await shoot(page, "18-chat-coexistence");
    await page.locator(".hud-panel .close").click();
    await page.waitForFunction(
      () => document.querySelector(".messages-panel")?.getAttribute("data-position") === "right",
    );
    check(
      (await panel.getAttribute("data-position")) === "right",
      "saved position restored after conflict",
    );
    await page.locator(".party-launch").click();
    check(await panel.isVisible(), "office games does not hide persistent chat");
    await shoot(page, "18-chat-games");
    await page.locator(".party-panel").getByRole("button", { name: "Close", exact: true }).click();
    // Exercise the complete viewport matrix, long/RTL text and 200% CSS zoom.
    for (const viewport of [
      { width: 1180, height: 820 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
      { width: 320, height: 568 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(200);
      const box = await panel.boundingBox();
      check(
        box &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= viewport.width &&
          box.y + box.height <= viewport.height,
        `panel fits ${viewport.width}x${viewport.height}`,
      );
      check(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        "no horizontal page overflow",
      );
      if (viewport.width === 390) await shoot(page, "18-chat-phone");
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate((person) => window.__office.openPerson(person), id);
    await page.waitForTimeout(150);
    const cardBox = await page.locator(".hud-panel").boundingBox();
    const stripBox = await panel.boundingBox();
    check(
      cardBox && stripBox && cardBox.y + cardBox.height <= stripBox.y,
      `phone card leaves chat strip and controls unobstructed: ${JSON.stringify({ cardBox, stripBox })}`,
    );
    await page.locator(".poke-message").click();
    await page.waitForTimeout(150);
    check(
      (await text.isVisible()) && (await page.locator(".hud-panel").isHidden()),
      "phone selected-recipient composer yields card without collapsing itself",
    );
    check(
      (await page.getByLabel("Notification recipients", { exact: true }).inputValue()) ===
        "selected",
      "phone selected audience retained",
    );
    await text.fill("Phone draft :wave:");
    await shoot(page, "18-chat-phone-composer");
    await page.setViewportSize({ width: 390, height: 420 });
    await page.locator(".messages-keyboard").waitFor();
    const keyboardBox = await panel.boundingBox();
    check(
      keyboardBox && keyboardBox.y >= 0 && keyboardBox.y + keyboardBox.height <= 420,
      "entire keyboard sheet fits viewport",
    );
    const sendBox = await page.locator(".messages-send-row").boundingBox();
    check(
      sendBox && sendBox.y >= 0 && sendBox.y + sendBox.height <= 420,
      "send reachable with simulated software keyboard",
    );
    await shoot(page, "18-chat-phone-keyboard");
    await page.setViewportSize({ width: 1440, height: 900 });
    await text.press("Escape");
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "200% zoom does not overflow page",
    );
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
    });
    await page.goto(`${http}/?hour=23`);
    await page.waitForFunction(() => window.__office?.ready);
    await page.locator(".messages-log article").last().waitFor();
    await shoot(page, "18-chat-clear-dark");
    await page.route("**/emotes/office/coffee.svg", (route) => route.abort());
    await page.reload();
    await page.waitForFunction(() => window.__office?.ready);
    await page.waitForFunction(() =>
      document.querySelector(".messages-log")?.textContent?.includes(":coffee:"),
    );
    check(
      (await page.locator(".messages-log").textContent())?.includes(":coffee:"),
      "failed emote image falls back to literal token",
    );
    check(errors.length === 0, `no browser exceptions: ${errors.join(", ")}`);
    const blocked = await browser.newContext({
      extraHTTPHeaders: { authorization: `Bearer ${password}` },
      serviceWorkers: "block",
    });
    try {
      await blocked.addInitScript(() => {
        const get = Storage.prototype.getItem;
        const set = Storage.prototype.setItem;
        Storage.prototype.getItem = function (key) {
          if (key.startsWith("agent-office.messages")) throw new Error("Storage unavailable");
          return get.call(this, key);
        };
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith("agent-office.messages")) throw new Error("Storage unavailable");
          return set.call(this, key, value);
        };
      });
      const denied = await blocked.newPage();
      await denied.goto(http);
      await denied.waitForFunction(() => window.__office?.ready);
      check(
        await denied.locator(".messages-overlay").isVisible(),
        "unavailable storage uses in-memory default overlay",
      );
      await denied.getByRole("button", { name: "Chat settings", exact: true }).click();
      await denied.getByLabel("Text size", { exact: true }).selectOption("18");
      await denied.getByRole("button", { name: "Done", exact: true }).click();
      check(
        await denied
          .locator(".messages-log")
          .evaluate((el) => getComputedStyle(el).fontSize === "18px"),
        "settings still work with unavailable storage",
      );
    } finally {
      await blocked.close();
    }
    console.log(`[shots] chat overlay: ${checks} assertions passed`);
  } finally {
    await ctx.close();
  }
}
