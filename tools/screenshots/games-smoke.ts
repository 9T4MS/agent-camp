/**
 * Turn-based games end to end: an isolated real server, three fake Macs and three browsers
 * (Anna on a laptop with the keyboard only, Tom on a phone, a guest watching). Build the web
 * app first: bun tools/screenshots/games-smoke.ts
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  type BattleshipView,
  battleshipCellName,
  battleshipShipCells,
  envelope,
  type GameResponse,
} from "@agent-office/protocol";
import type { Browser, BrowserContext, Page } from "playwright";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");
const out = process.env.GAMES_SHOTS ?? "/private/tmp/agent-office-games-shots";
mkdirSync(out, { recursive: true });
const PASSWORD = "local-games-test";
const server = Bun.spawn([process.execPath, "apps/server/src/dev/bun-server.ts"], {
  cwd: resolve(import.meta.dir, "../.."),
  env: {
    ...process.env,
    PORT: "0",
    DB: ":memory:",
    CONNECTOR_PASSWORD: PASSWORD,
    GENUI_PROVIDER: "off",
  },
  stdout: "pipe",
  stderr: "inherit",
});
let browser: Browser | undefined;
const sockets: WebSocket[] = [];
/** game notifications the fake Macs got */
const macNotices: string[] = [];
/** latest "this is me" code each fake Mac got */
const macCodes = new Map<string, string>();
let heartbeat: ReturnType<typeof setInterval> | undefined;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  const reader = server.stdout.getReader();
  let log = "";
  while (!/localhost:(\d+)/.test(log)) {
    const { value, done } = await reader.read();
    assert(!done, "local server exited before listening");
    log += new TextDecoder().decode(value);
  }
  const base = `http://localhost:${/localhost:(\d+)/.exec(log)![1]}`;
  void (async () => {
    while (!(await reader.read()).done) {
      /* drain */
    }
  })();
  const presence = () =>
    envelope("presence.snapshot", {
      sessions: [
        {
          sessionKey: "games-session-123",
          agent: "claude",
          activity: "idle",
          subagents: 0,
          startedAt: Date.now(),
        },
      ],
    });
  for (const name of ["Anna", "Tom", "Lea"]) {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/connector`);
    sockets.push(ws);
    await new Promise<void>((done, reject) => {
      ws.onopen = () =>
        ws.send(
          JSON.stringify(
            envelope("connector.hello", {
              name,
              password: PASSWORD,
              clientId: name,
              connectorVersion: "99.0.0",
            }),
          ),
        );
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as {
          type: string;
          data?: { text?: string; from?: string };
        };
        if (msg.type === "connector.poked" && msg.data?.from === "Office games")
          macNotices.push(`${name}: ${msg.data.text}`);
        const code = msg.type === "connector.poked" && /\b(\d{6})\b/.exec(msg.data?.text ?? "");
        if (code) macCodes.set(name, code[1]!);
        if (msg.type === "connector.welcomed") {
          ws.send(JSON.stringify(presence()));
          done();
        }
        if (msg.type === "connector.rejected") reject(new Error("connector rejected"));
      };
      ws.onerror = () => reject(new Error("connector failed"));
    });
  }
  heartbeat = setInterval(() => {
    for (const ws of sockets) ws.send(JSON.stringify(presence()));
  }, 5000);

  browser = await chromium.launch({
    headless: true,
    args: [
      "--enable-webgl",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  const errors: string[] = [];
  const cookieOf = (res: Response) => {
    const [name, value] = res.headers.getSetCookie()[0]!.split(";")[0]!.split("=") as [
      string,
      string,
    ];
    return { name, value, url: base };
  };
  const session = cookieOf(
    await fetch(`${base}/api/login`, {
      method: "POST",
      body: new URLSearchParams({ password: PASSWORD }),
      redirect: "manual",
    }),
  );
  /** The "It's me" cookie for a person, the real way: a code to their Mac, typed back. */
  const confirm = async (personId: string) => {
    const name = personId[0]!.toUpperCase() + personId.slice(1);
    const headers = {
      cookie: `${session.name}=${session.value}`,
      "content-type": "application/json",
    };
    // one code request per address every 2 s
    await pause(2100);
    const sent = await fetch(`${base}/api/people/${personId}/claim`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(sent.status, 200, `code for ${personId}`);
    for (let i = 0; i < 50 && !macCodes.has(name); i++) await pause(100);
    const verified = await fetch(`${base}/api/people/${personId}/claim/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ code: macCodes.get(name) }),
    });
    assert.equal(verified.status, 200, `${personId} confirmed`);
    return cookieOf(verified);
  };
  /** A browser that is `me` (confirmed with the "It's me" cookie) or nobody. */
  const open = async (
    me: string | null,
    options: Parameters<Browser["newContext"]>[0],
  ): Promise<{ ctx: BrowserContext; page: Page }> => {
    const ctx = await browser!.newContext({ serviceWorkers: "block", ...options });
    await ctx.addCookies([session, ...(me ? [await confirm(me)] : [])]);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${me ?? "guest"}: ${e.message}`));
    // refused requests are listed with their path (the console only says "429")
    page.on("response", (r) => {
      if (r.status() >= 400)
        errors.push(
          `${me ?? "guest"}: ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
        );
    });
    page.on("console", (e) => {
      if (e.type() === "error" && !e.text().startsWith("Failed to load resource"))
        errors.push(`${me ?? "guest"}: ${e.text()}`);
    });
    await page.goto(`${base}/?zoom=fit`);
    await page.waitForFunction(
      () => window.__office?.ready && window.__office.model.people.size === 3,
    );
    return { ctx, page };
  };
  const { page: anna } = await open("anna", {
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const { page: tom } = await open("tom", {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const { page: guest } = await open(null, { viewport: { width: 1180, height: 820 } });
  await anna.locator(".me-chip.confirmed").waitFor();
  await tom.locator(".me-chip.confirmed").waitFor();

  const status = (page: Page) => page.locator(".game-status").textContent();
  const waitStatus = async (page: Page, text: string) => {
    try {
      await page.waitForFunction(
        (t) => document.querySelector(".game-status")?.textContent === t,
        text,
        { timeout: 10_000 },
      );
    } catch {
      const error = await page
        .locator(".game-error")
        .textContent()
        .catch(() => "");
      throw new Error(`expected status "${text}", got "${await status(page)}" (${error})`);
    }
  };
  /** what the server tells this browser about a game (its own fleet included) */
  const ask = (page: Page, id: string) =>
    page.evaluate(
      async (gameId) => (await (await fetch(`/api/games/${gameId}`)).json()) as unknown,
      id,
    ) as Promise<GameResponse>;
  const gameId = (page: Page) =>
    page.evaluate(() => window.__office.model.games.at(-1)?.id ?? "") as Promise<string>;

  // ---- Four in a Row -----------------------------------------------------------------------
  // a guest cannot challenge: they are asked who they are
  await guest.evaluate(() => window.__office.openPerson("tom"));
  await guest.locator('.challenge [data-key="challenge:four-in-a-row"]').click();
  await guest.locator(".me-menu.show").waitFor();
  assert.match((await guest.locator(".me-menu .me-note").first().textContent())!, /challenge Tom/);
  await guest.keyboard.press("Escape");
  await guest.keyboard.press("Escape");

  // Anna challenges Tom from his nameplate
  await anna.evaluate(() => window.__office.openPerson("tom"));
  await anna.locator('.challenge [data-key="challenge:four-in-a-row"]').click();
  await anna.locator(".game-modal").waitFor();
  assert.equal(await status(anna), "Waiting for Tom to answer.");
  await anna.screenshot({ path: `${out}/games-invite-sent-laptop.png` });

  // Tom's phone: a badge on the chip, the invite in its menu
  await tom.locator(".me-chip .me-badge").waitFor();
  assert.equal(
    await tom.locator(".me-chip").getAttribute("aria-label"),
    "Me: Tom, 1 game is waiting for you",
  );
  await tom.locator(".me-chip").click();
  assert.equal(await tom.locator(".me-menu .me-game-line").textContent(), "Anna wants to play");
  await tom.screenshot({ path: `${out}/games-invite-phone.png` });
  await tom.locator(".me-menu .me-answers button", { hasText: "Play" }).click();
  await tom.locator(".game-modal .four").waitFor();
  assert.equal(await status(tom), "Your turn.");
  assert.equal(await tom.locator(".me-chip .me-badge").count(), 1, "it is his move");

  // the phone: a first tap shows where the disc lands, the second drops it
  const tapColumn = async (col: number) => {
    await tom.locator(".four-col").nth(col).click();
    await tom.locator(".four-col.armed").waitFor();
    await tom.locator(".four-col").nth(col).click();
  };
  // Anna plays with the keyboard only: a digit goes to the column, Enter drops
  const keyColumn = async (col: number) => {
    await anna.locator(".four-col").first().focus();
    await anna.keyboard.press(String(col + 1));
    await anna.keyboard.press("Enter");
  };
  await anna.locator(".game-modal .four").waitFor();
  for (let i = 0; i < 3; i++) {
    await tapColumn(3);
    await waitStatus(anna, "Tom dropped in column 4. Your turn.");
    await pause(300);
    await keyColumn(0);
    await waitStatus(tom, "Anna dropped in column 1. Your turn.");
    await pause(300);
  }
  // the guest watches from the drawer's live games: read-only
  await guest.getByRole("button", { name: "Office games", exact: false }).click();
  await guest.locator(".games-list .game-open").first().click();
  await guest.locator(".game-modal .four").waitFor();
  assert.equal(await guest.locator(".four-col:not([aria-disabled])").count(), 0);
  assert.equal(await guest.locator(".game-foot .game-note").textContent(), "You are watching.");
  assert.equal(
    await anna.locator(".four-col").first().getAttribute("aria-label"),
    "Column 1, 3 of 6 filled, your disc on top",
  );
  const column = await anna.locator(".four-col").first().boundingBox();
  assert(column && column.width >= 44, "a column is a finger wide");
  await anna.screenshot({ path: `${out}/games-four-laptop.png` });
  await tom.screenshot({ path: `${out}/games-four-phone.png` });
  assert.equal(
    await tom.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    "no sideways scrolling on the phone",
  );

  await tapColumn(3);
  await waitStatus(anna, "Tom won.");
  await waitStatus(tom, "You won.");
  await waitStatus(guest, "Tom beat Anna.");
  assert.equal(await anna.locator(".four .disc.win").count(), 4);
  // everybody gets the result as a banner
  await guest.locator(".hud-banner.show").waitFor();
  assert.equal(await guest.locator(".hud-banner .title").textContent(), "Tom wins!");
  await guest.screenshot({ path: `${out}/games-four-result-guest.png` });
  await guest.keyboard.press("Escape");
  assert.equal(await guest.locator(".game-modal").count(), 0);
  assert.match((await guest.locator(".games-list").textContent())!, /Tom beat Anna/);
  assert.match((await guest.locator(".games-ladder").textContent())!, /Tom · 1 W · 0 L/);
  console.log("PASS: Four in a Row: challenge, phone taps, keyboard only, guest watching, result");

  // ---- Battleship --------------------------------------------------------------------------
  // a rematch in the other game, this time rated; Esc gives the focus back to where it was
  await anna.keyboard.press("Escape");
  assert.equal(await anna.locator(".game-modal").count(), 0);
  await anna.locator(".challenge-rated input").check();
  await anna.locator('.challenge [data-key="challenge:battleship"]').click();
  await anna.locator(".game-modal").waitFor();
  const id = await gameId(anna);
  await tom.keyboard.press("Escape");
  await tom.getByRole("button", { name: "Office games", exact: false }).click();
  assert.match((await tom.locator(".game-row.waits .game-line").textContent())!, /\(rated\)/);
  await tom.locator(".game-row.waits .game-answers button", { hasText: "Play" }).click();

  // both place their fleet; Anna without the mouse: shuffle, move a ship, rotate, ready
  await anna.locator(".place-tools").waitFor();
  assert.equal(await anna.locator('.sea [role="columnheader"]').count(), 8);
  assert.equal(await anna.locator('.sea [role="rowheader"]').count(), 8);
  assert.equal(await anna.locator('.sea .cell[tabindex="0"]').count(), 1, "one tab stop");
  await anna.locator('[data-key="shuffle"]').focus();
  await anna.keyboard.press("Enter");
  await anna.screenshot({ path: `${out}/games-battleship-placing-laptop.png` });
  await anna.locator('[data-key="ready"]').focus();
  await anna.keyboard.press("Enter");
  await waitStatus(anna, "Fleets are being placed.");
  await tom.locator(".place-tools").waitFor();
  await tom.screenshot({ path: `${out}/games-battleship-placing-phone.png` });
  await tom.locator('[data-key="ready"]').click();

  // their first Battleship game: the challenged player (Tom) starts, with 2 shots
  await waitStatus(tom, "Your turn.");
  const annaView = (await ask(anna, id)).view as BattleshipView;
  const tomView = (await ask(tom, id)).view as BattleshipView;
  const annaFleet = annaView.waters[0].ships!.flatMap(battleshipShipCells);
  const tomFleet = tomView.waters[1].ships!.flatMap(battleshipShipCells);
  assert.equal(annaView.waters[1].ships, null, "Anna is not told Tom's fleet");
  assert.equal(tomView.waters[0].ships, null, "Tom is not told Anna's fleet");
  const guestView = (await ask(guest, id)).view as BattleshipView;
  assert.deepEqual(
    guestView.waters.map((w) => w.ships),
    [null, null],
    "a guest is told no fleet",
  );
  assert.equal(annaFleet.length, 12);

  /** Anna types coordinates ("C4") and presses Enter for each shot, then Fire */
  const annaFires = async (cells: number[]) => {
    await anna.locator('.sea[data-grid="target"] .cell[tabindex="0"]').focus();
    for (const cell of cells) {
      await anna.keyboard.type(battleshipCellName(cell));
      const name = await anna.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      assert.equal(name?.split(",")[0], battleshipCellName(cell), "the typed cell has the focus");
      await anna.keyboard.press("Enter");
    }
    assert.equal(
      await anna.locator(".salvo-count").textContent(),
      `${cells.length} of ${cells.length} picked`,
    );
    await anna.locator('[data-key="fire"]').focus();
    await anna.keyboard.press("Enter");
  };
  /** Tom taps cells on the phone's target grid, then Fire */
  const tomFires = async (cells: number[]) => {
    for (const cell of cells)
      await tom.locator(`.sea[data-grid="target"] .cell[data-key="target:${cell}"]`).click();
    await tom.locator('[data-key="fire"]').click();
  };
  const tomTargets = tomFleet.slice();
  // Tom only ever shoots water, so he never sinks anything
  const water = Array.from({ length: 64 }, (_, c) => c).filter((c) => !annaFleet.includes(c));
  // the phone shows one grid at a time, with finger-sized cells
  await tom.locator(".sea-tabs").waitFor();
  assert.equal(await tom.locator('[data-key="fire"]').textContent(), "Fire 2");
  assert.equal(await tom.locator(".sea-pane.fleet").isVisible(), false);
  const cellBox = await tom.locator('.sea[data-grid="target"] .cell').first().boundingBox();
  assert(cellBox && cellBox.width >= 32 && cellBox.height >= 32, "phone cells are 32 px or more");
  await tomFires(water.splice(0, 2));
  await anna.waitForFunction(() =>
    document.querySelector(".game-status")?.textContent?.startsWith("Tom fired 2 shots"),
  );
  assert.match((await status(anna))!, /^Tom fired 2 shots: \w\d miss, \w\d miss\. Your turn\.$/);
  assert.equal(await anna.locator('[data-key="fire"]').textContent(), "Fire 3");
  await pause(300);
  await annaFires(tomTargets.splice(0, 3));
  await waitStatus(
    tom,
    `Anna fired 3 shots: ${tomFleet
      .slice(0, 3)
      .map((c) => `${battleshipCellName(c)} hit`)
      .join(", ")}. Your turn.`,
  );
  await tom.locator('[data-key="tab:fleet"]').click();
  assert.equal(await tom.locator(".sea-pane.fleet").isVisible(), true);
  assert.equal(await tom.locator(".sea-pane.target").isVisible(), false);
  assert.equal(await tom.locator(".sea-pane.fleet .cell.ship-hit").count(), 3);
  assert.equal(
    await tom
      .locator(`.sea[data-grid="fleet"] .cell[data-key="fleet:${tomFleet[0]}"]`)
      .getAttribute("aria-label"),
    `${battleshipCellName(tomFleet[0]!)}, your ship, hit`,
  );
  await tom.screenshot({ path: `${out}/games-battleship-fleet-phone.png` });
  await tom.locator('[data-key="tab:target"]').click();
  await tom.screenshot({ path: `${out}/games-battleship-target-phone.png` });
  await pause(300);
  await tomFires(water.splice(0, 3));
  await anna.waitForFunction(() =>
    document.querySelector(".game-status")?.textContent?.startsWith("Tom fired 3 shots"),
  );
  await anna.screenshot({ path: `${out}/games-battleship-laptop.png` });

  // a guest sees shots and sunk ships, never where the others are
  // (the drawer stepped aside for the first board: open it again)
  await guest.getByRole("button", { name: "Office games", exact: false }).click();
  await guest.locator(".games-list .game-open").first().click();
  await guest.locator(".game-modal .sea").first().waitFor();
  assert.equal(await guest.locator(".sea .cell.ship").count(), 0);
  assert.equal(await guest.locator(".sea .cell:not([aria-disabled])").count(), 0);
  await guest.screenshot({ path: `${out}/games-battleship-guest.png` });

  // reduced motion (Anna's browser): nothing on the board is animating
  assert.equal(
    await anna.evaluate(
      () => document.querySelector(".game-modal")!.getAnimations({ subtree: true }).length,
    ),
    0,
  );
  // the focus stays in the window: Tab from the last control wraps to the first
  await anna.locator(".game-modal button").last().focus();
  await anna.keyboard.press("Tab");
  assert.equal(
    await anna.evaluate(() => !!document.activeElement?.closest(".game-modal")),
    true,
    "focus stays in the board window",
  );

  // play it out: Anna hits every time
  while (tomTargets.length > 0) {
    await pause(300);
    const salvo = Number(/\d/.exec((await anna.locator('[data-key="fire"]').textContent())!)![0]);
    const cells = tomTargets.splice(0, salvo);
    // the last salvo is filled up with cells that are still open
    if (cells.length < salvo) {
      const open = await anna
        .locator('.sea[data-grid="target"] .cell.untried:not([aria-disabled])')
        .evaluateAll((els) =>
          els.map((e) => Number((e as HTMLElement).dataset.key!.split(":")[1])),
        );
      for (const c of open) if (cells.length < salvo && !cells.includes(c)) cells.push(c);
    }
    await annaFires(cells);
    if (tomTargets.length === 0) break;
    await tom.waitForFunction(() =>
      document.querySelector(".game-status")?.textContent?.endsWith("Your turn."),
    );
    await pause(300);
    await tomFires(water.splice(0, 3));
    await anna.waitForFunction(() =>
      document.querySelector(".game-status")?.textContent?.endsWith("Your turn."),
    );
  }
  await waitStatus(anna, "You won.");
  await waitStatus(tom, "Anna won.");
  // after the game both fleets are shown, to the guest too
  await guest.waitForFunction(
    () => document.querySelector(".game-status")?.textContent === "Anna beat Tom.",
  );
  assert((await guest.locator(".sea .cell.ship").count()) > 0, "fleets are shown at the end");
  await guest.keyboard.press("Escape");
  await guest.getByRole("button", { name: "Office games", exact: false }).click();
  // the rated game moved the ratings; the friendly one before did not
  assert.match(
    (await guest.locator(".games-ladder").textContent())!,
    /Anna · 1 W · 1 L · rating 1012\?/,
  );
  await guest.screenshot({ path: `${out}/games-drawer-guest.png` });
  await anna.screenshot({ path: `${out}/games-battleship-won-laptop.png` });
  assert.equal(await anna.locator('[data-key="rematch"]').count(), 1);
  console.log(
    "PASS: Battleship: rated invite, placement, typed coordinates, phone tabs, hidden fleets, result",
  );

  // the switch in the Me menu: no "your turn" on my Mac
  await anna.keyboard.press("Escape");
  await anna.locator(".me-chip").click();
  const notices = anna.locator(".me-menu .me-notices");
  assert.equal(await notices.textContent(), '"Your turn" on my Mac: on');
  await notices.click();
  await anna.locator('.me-menu .me-notices[aria-pressed="false"]').waitFor();
  assert.equal(await notices.textContent(), '"Your turn" on my Mac: off');
  assert.equal(
    ((await ask(anna, id)) as { notices?: boolean }).notices,
    false,
    "the server remembers the switch",
  );
  await anna.screenshot({ path: `${out}/games-me-menu-laptop.png` });
  await anna.keyboard.press("Escape");

  // both players had the office open the whole time: nothing went to their Macs
  assert.deepEqual(macNotices, [], "no Mac notification for players who are looking at the office");
  // 403s of the guest's refused challenge would show up here too
  assert.deepEqual(errors, [], "zero browser errors");
  console.log(`PASS: games smoke; 0 browser errors, 0 Mac notices. Screenshots: ${out}`);
} finally {
  clearInterval(heartbeat);
  for (const ws of sockets) ws.close();
  await browser?.close();
  server.kill();
}
