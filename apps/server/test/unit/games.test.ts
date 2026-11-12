import { describe, expect, test } from "bun:test";
import {
  type BattleshipShip,
  type BattleshipView,
  battleshipShipCells,
  envelope,
  type GameResponse,
  type GameSummary,
  type GamesState,
  parseViewerMessage,
} from "@agent-office/protocol";
import { OfficeApp } from "../../src/core/app.ts";
import { ME_COOKIE, makeMeToken } from "../../src/core/auth.ts";
import {
  addWeekdayMs,
  GAME_DEADLINE_MS,
  GAME_NOTICE_DELAY_MS,
  GAME_NOTICE_EVERY_MS,
  GAME_NUDGE_AFTER_MS,
  GAME_STALE_MS,
} from "../../src/core/games.ts";
import { MemoryStore } from "../../src/core/store.ts";

/** Friday 17:00 in Vienna (CET) */
const FRIDAY = Date.UTC(2026, 10, 13, 16, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ship = (row: number, col: number, length: number): BattleshipShip => ({
  row,
  col,
  length,
  horizontal: true,
});
const FLEET = [ship(0, 0, 4), ship(2, 0, 3), ship(4, 0, 3), ship(6, 0, 2)];
const FLEET_CELLS = FLEET.flatMap(battleshipShipCells);

function setup(store = new MemoryStore(), people = ["Anna", "Tom", "Lea", "Max", "Ida"]) {
  let now = FRIDAY;
  let requester = 0;
  const sent: string[] = [];
  const pokes: { socketId: string; text: string; from?: string }[] = [];
  const alarms: (number | null)[] = [];
  const app = new OfficeApp(
    { CONNECTOR_PASSWORD: "pw" },
    store,
    {
      broadcast: (value) => sent.push(value),
      scheduleAlarm: (value) => alarms.push(value),
      sendToConnector: (socketId, data) => {
        const msg = JSON.parse(data) as { type: string; data: { text: string; from?: string } };
        if (msg.type === "connector.poked") pokes.push({ socketId, ...msg.data });
        return true;
      },
    },
    { now: () => now, log: () => {} },
  );
  const hello = (name: string) =>
    app.connectorMessage(
      name,
      envelope("connector.hello", {
        name,
        password: "pw",
        clientId: name,
        connectorVersion: "1.0.0",
      }),
    );
  for (const name of people) hello(name);
  const cookie = async (me: string | null): Promise<Record<string, string>> =>
    me ? { cookie: `${ME_COOKIE}=${await makeMeToken("pw", me, now)}` } : {};
  /** POST /api/games as `me` (null = a browser that is nobody) */
  const act = async (me: string | null, body: unknown) => {
    const res = (await app.handleHttp(
      new Request("http://office/api/games", {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          authorization: "Bearer pw",
          "cf-connecting-ip": `ip-${++requester}`,
          ...(await cookie(me)),
        },
      }),
    ))!;
    return { status: res.status, body: (await res.json()) as GameResponse & { error?: string } };
  };
  const ok = async (me: string, body: unknown) => {
    const r = await act(me, body);
    if (r.status !== 200) throw new Error(`${JSON.stringify(body)} -> ${r.status} ${r.body.error}`);
    return r.body;
  };
  const read = async (me: string | null, id: string) => {
    const res = (await app.handleHttp(
      new Request(`http://office/api/games/${id}`, {
        headers: { authorization: "Bearer pw", ...(await cookie(me)) },
      }),
    ))!;
    return { status: res.status, body: (await res.json()) as GameResponse & { error?: string } };
  };
  const state = () => app.snapshot().data.games as GamesState;
  const game = (id: string) => state().games.find((g) => g.id === id)!;
  return {
    app,
    act,
    ok,
    read,
    state,
    game,
    hello,
    sent,
    pokes,
    alarms,
    store,
    now: () => now,
    /** time passes; the Macs keep reporting in, as running connectors do */
    advance: (ms: number) => {
      now += ms;
      for (const name of people) hello(name);
    },
    /** let the server's alarm run, as the runtime would at the scheduled time */
    alarm: () => app.alarm(),
    challenge: async (a: string, b: string, kind = "four-in-a-row", rated = false) =>
      (await ok(a, { action: "challenge", opponentId: b, kind, rated })).game!,
  };
}

/** Anna (side 0) against Tom (side 1), accepted; Tom moves first. */
async function fourGame(t: ReturnType<typeof setup>, rated = false) {
  const g = await t.challenge("anna", "tom", "four-in-a-row", rated);
  await t.ok("tom", { action: "accept", id: g.id });
  return g.id;
}
const drop = (id: string, col: number) => ({ action: "move", id, move: { type: "drop", col } });
/** Tom drops four in column 0, Anna three in column 1: Tom wins. */
async function tomWins(t: ReturnType<typeof setup>, id: string) {
  for (let i = 0; i < 3; i++) {
    await t.ok("tom", drop(id, 0));
    await t.ok("anna", drop(id, 1));
  }
  return t.ok("tom", drop(id, 0));
}

describe("games: who may do what", () => {
  test("only a confirmed browser plays, and only its own games", async () => {
    const t = setup();
    const nobody = await t.act(null, {
      action: "challenge",
      opponentId: "tom",
      kind: "battleship",
    });
    expect(nobody.status).toBe(403);
    expect(nobody.body.error).toBe("confirm who you are first");
    const g = await t.challenge("anna", "tom");
    expect((await t.act("lea", { action: "accept", id: g.id })).status).toBe(403);
    expect((await t.act("anna", { action: "accept", id: g.id })).body.error).toBe(
      "nothing to accept",
    );
    expect((await t.act("tom", { action: "cancel", id: g.id })).status).toBe(409);
    expect((await t.act("anna", { action: "nope", id: g.id })).status).toBe(400);
    expect((await t.act("anna", { action: "accept", id: "missing" })).status).toBe(404);
    const unauthorized = await t.app.handleHttp(
      new Request("http://office/api/games", { method: "POST", body: "{}" }),
    );
    expect(unauthorized!.status).toBe(401);
  });

  test("a challenge is an invite everybody sees; it can be declined or cancelled", async () => {
    const t = setup();
    const g = await t.challenge("anna", "tom");
    expect(g).toMatchObject({
      kind: "four-in-a-row",
      players: ["anna", "tom"],
      names: ["Anna", "Tom"],
      status: "invited",
      rated: false,
      awaits: [1],
      turns: 0,
    });
    expect(g.view).toBeUndefined();
    const update = parseViewerMessage(t.sent.at(-1)!);
    expect(update.ok && update.msg.type === "game.updated" && update.msg.data.game.id).toBe(g.id);
    expect(t.state().games).toHaveLength(1);

    await t.ok("tom", { action: "decline", id: g.id });
    expect(t.game(g.id)).toMatchObject({ status: "over", result: "declined", awaits: [] });
    expect(t.state().stats).toEqual({});
    const again = await t.challenge("anna", "tom");
    await t.ok("anna", { action: "cancel", id: again.id });
    expect(t.game(again.id).result).toBe("cancelled");
  });

  test("limits: not yourself, not a stranger, one game per pair and kind, 3 open games each", async () => {
    const t = setup();
    const challenge = (a: string, b: string, kind = "four-in-a-row") =>
      t.act(a, { action: "challenge", opponentId: b, kind });
    expect((await challenge("anna", "anna")).body.error).toBe("pick somebody else");
    expect((await challenge("anna", "ghost")).body.error).toBe("they are not in the office");
    expect((await challenge("ghost", "anna")).body.error).toBe(
      "you are not in the office right now",
    );
    expect((await challenge("anna", "tom")).status).toBe(200);
    expect((await challenge("tom", "anna")).body.error).toBe(
      "You already play Vier gewinnt with Anna.",
    );
    // the other game with the same person is fine
    expect((await challenge("anna", "tom", "battleship")).status).toBe(200);
    expect((await challenge("anna", "lea")).status).toBe(200);
    expect((await challenge("anna", "max")).body.error).toBe(
      "You have 3 open games. Finish one first.",
    );
    expect((await challenge("max", "anna")).body.error).toBe("Anna already has 3 open games.");
  });
});

test("a browser may send a short burst (a move plus its 'seen'), not a stream", async () => {
  const t = setup();
  const burst = async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = (await t.app.handleHttp(
        new Request("http://office/api/games", {
          method: "POST",
          body: "{}",
          headers: { authorization: "Bearer pw", "cf-connecting-ip": "one-office" },
        }),
      ))!;
      statuses.push(res.status);
    }
    return statuses;
  };
  // five get through to the "who are you" check, the sixth is told to slow down
  expect(await burst()).toEqual([403, 403, 403, 403, 403, 429]);
  t.advance(1000);
  expect((await burst())[0]).toBe(403);
});

describe("games: playing", () => {
  test("four in a row: turns alternate, the board is public, a win counts for both records", async () => {
    const t = setup();
    const id = await fourGame(t);
    expect(t.game(id)).toMatchObject({ status: "playing", awaits: [1] });
    const wrongTurn = await t.act("anna", drop(id, 0));
    expect(wrongTurn.status).toBe(409);
    expect(wrongTurn.body.error).toBe("not your turn");
    expect(
      (await t.act("tom", { action: "move", id, move: { type: "drop", col: 9 } })).status,
    ).toBe(400);
    const won = await tomWins(t, id);
    expect(won.game).toMatchObject({ status: "over", result: "won", winner: 1, turns: 7 });
    expect(t.state().stats).toEqual({
      anna: { wins: 0, losses: 1, draws: 0, rating: 1000, ratedGames: 0 },
      tom: { wins: 1, losses: 0, draws: 0, rating: 1000, ratedGames: 0 },
    });
    // the result message carries the records, so every page updates its ladder
    const last = parseViewerMessage(t.sent.at(-1)!);
    expect(last.ok && last.msg.type === "game.updated" && last.msg.data.stats?.tom?.wins).toBe(1);
    expect((await t.act("anna", drop(id, 2))).body.error).toBe("the game is over");
  });

  test("a rated game moves the ratings; the loser starts the rematch", async () => {
    const t = setup();
    await tomWins(t, await fourGame(t, true));
    expect(t.state().stats.tom).toMatchObject({ rating: 1012, ratedGames: 1 });
    expect(t.state().stats.anna).toMatchObject({ rating: 988, ratedGames: 1 });
    // Tom challenges this time: he is side 0, but Anna lost and moves first
    const g = await t.challenge("tom", "anna");
    await t.ok("anna", { action: "accept", id: g.id });
    expect(t.game(g.id).awaits).toEqual([1]);
    expect(t.game(g.id).players[1]).toBe("anna");
  });

  test("resigning gives the other side the win", async () => {
    const t = setup();
    const id = await fourGame(t);
    await t.ok("anna", { action: "resign", id });
    expect(t.game(id)).toMatchObject({ status: "over", result: "resigned", winner: 1 });
    expect(t.state().stats.tom!.wins).toBe(1);
  });

  test("battleship: a fleet goes to its owner only, never into a broadcast or the snapshot", async () => {
    const t = setup();
    const g = await t.challenge("anna", "tom", "battleship");
    await t.ok("tom", { action: "accept", id: g.id });
    expect(t.game(g.id)).toMatchObject({ status: "setup", awaits: [0, 1] });
    const place = { action: "move", id: g.id, move: { type: "place", ships: FLEET } };
    const mine = await t.ok("anna", place);
    expect(mine.side).toBe(0);
    expect((mine.view as BattleshipView).waters[0].ships).toEqual(FLEET);
    expect(t.game(g.id)).toMatchObject({ status: "setup", awaits: [1] });
    await t.ok("tom", place);
    expect(t.game(g.id)).toMatchObject({ status: "playing", awaits: [1] });

    // Tom opens with 2 shots (he moves first), Anna answers with 3
    const fire = (cells: number[]) => ({ action: "move", id: g.id, move: { type: "fire", cells } });
    expect((await t.act("tom", fire([0, 1, 2]))).body.error).toBe("fire 2 shots");
    await t.ok("tom", fire([48, 49])); // sinks Anna's 2-ship
    await t.ok("anna", fire([0, 1, 63]));

    const asAnna = (await t.read("anna", g.id)).body;
    const asTom = (await t.read("tom", g.id)).body;
    const asGuest = (await t.read(null, g.id)).body;
    expect((asAnna.view as BattleshipView).waters[0].ships).toEqual(FLEET);
    expect((asAnna.view as BattleshipView).waters[1].ships).toBeNull();
    expect((asTom.view as BattleshipView).waters[0].ships).toBeNull();
    expect(asGuest.side).toBeUndefined();
    expect((asGuest.view as BattleshipView).waters.map((w) => w.ships)).toEqual([null, null]);
    expect((asGuest.view as BattleshipView).waters[0].sunk).toEqual([FLEET[3]!]);

    // nothing sent to all viewers, and no snapshot, ever holds a whole fleet
    const everything = [...t.sent, JSON.stringify(t.app.snapshot())].join("\n");
    expect(everything).not.toContain('"ships":[');
    expect(everything).toContain('"sunk":[{"row":6');

    // Tom sinks the rest: both fleets are shown when it is over
    const rest = FLEET_CELLS.filter((c) => c !== 48 && c !== 49);
    let waste = 60;
    while (t.game(g.id).status === "playing") {
      const cells = rest.splice(0, 3);
      // the last salvo is topped up with water at the right edge of row 2
      for (let c = 15; cells.length < 3; c--) cells.push(c);
      await t.ok("tom", fire(cells));
      if (t.game(g.id).status === "playing") await t.ok("anna", fire([waste--, waste--, waste--]));
    }
    const over = t.game(g.id);
    expect(over).toMatchObject({ status: "over", result: "won", winner: 1 });
    expect((over.view as BattleshipView).waters[0].ships).toEqual(FLEET);
  });

  test("games and records survive a restart", async () => {
    const t = setup();
    await tomWins(t, await fourGame(t));
    const open = await t.challenge("anna", "lea", "battleship");
    const again = setup(t.store);
    expect(
      again
        .state()
        .games.map((g) => g.id)
        .sort(),
    ).toEqual(
      t
        .state()
        .games.map((g) => g.id)
        .sort(),
    );
    expect(again.state().stats.tom!.wins).toBe(1);
    await again.ok("lea", { action: "accept", id: open.id });
    expect(again.game(open.id).status).toBe("setup");
  });
});

describe("games: time", () => {
  test("three days of weekday time: a Friday evening deadline lands on Wednesday", () => {
    expect(new Date(FRIDAY).getUTCDay()).toBe(5);
    expect(addWeekdayMs(FRIDAY, GAME_DEADLINE_MS, "Europe/Vienna")).toBe(
      Date.UTC(2026, 10, 18, 16, 0, 0),
    );
    // Monday morning + 4 h stays on Monday; Saturday noon + 4 h is Monday 04:00 local
    const monday = Date.UTC(2026, 10, 16, 8, 0, 0);
    expect(addWeekdayMs(monday, 4 * HOUR, "Europe/Vienna")).toBe(monday + 4 * HOUR);
    expect(addWeekdayMs(Date.UTC(2026, 10, 14, 11, 0, 0), 4 * HOUR, "Europe/Vienna")).toBe(
      Date.UTC(2026, 10, 16, 3, 0, 0),
    );
    // an unknown time zone falls back to plain time instead of failing
    expect(addWeekdayMs(FRIDAY, HOUR, "Nowhere/Land")).toBe(FRIDAY + HOUR);
  });

  test("an unanswered invite runs out by itself, on the server's alarm", async () => {
    const t = setup();
    const g = await t.challenge("anna", "tom");
    expect(g.deadline).toBe(Date.UTC(2026, 10, 18, 16, 0, 0));
    // the server asked to be woken up for it (here: for the notification, which is earlier)
    expect(t.alarms.at(-1)).not.toBeNull();
    expect(t.alarms.at(-1)!).toBeLessThanOrEqual(g.deadline!);
    t.advance(4 * DAY);
    expect(t.game(g.id).status).toBe("invited");
    t.advance(DAY);
    t.alarm();
    expect(t.game(g.id)).toMatchObject({ status: "over", result: "expired" });
    expect((await t.act("tom", { action: "accept", id: g.id })).body.error).toBe(
      "the game is over",
    );
  });

  test("after the deadline nothing happens by itself: the waiting player takes the win or calls it off", async () => {
    const t = setup();
    const id = await fourGame(t, true);
    await t.ok("tom", drop(id, 0)); // now Anna has to move
    expect((await t.act("tom", { action: "claim", id })).body.error).toBe(
      "they still have time for their move",
    );
    t.advance(6 * DAY);
    t.alarm();
    expect(t.game(id).status).toBe("playing");
    expect((await t.act("anna", { action: "claim", id })).body.error).toBe("it is your move");
    await t.ok("tom", { action: "claim", id });
    expect(t.game(id)).toMatchObject({ status: "over", result: "claimed", winner: 1 });
    expect(t.state().stats.tom).toMatchObject({ wins: 1, rating: 1012 });

    // the rematch starts with Anna (she lost): this time she waits for Tom and calls it off
    const other = await fourGame(t);
    await t.ok("anna", drop(other, 0));
    t.advance(6 * DAY);
    await t.ok("anna", { action: "call-off", id: other });
    expect(t.game(other)).toMatchObject({ status: "over", result: "void" });
    expect(t.state().stats.tom!.wins).toBe(1);
  });

  test("a game nobody touched for 14 days ends without a result", async () => {
    const t = setup();
    const id = await fourGame(t);
    t.advance(GAME_STALE_MS - HOUR);
    t.alarm();
    expect(t.game(id).status).toBe("playing");
    t.advance(HOUR);
    t.alarm();
    expect(t.game(id)).toMatchObject({ status: "over", result: "void" });
    expect(t.state().stats).toEqual({});
  });

  test("a nudge needs a few weekday hours of waiting and works once a day", async () => {
    const t = setup();
    const id = await fourGame(t);
    await t.ok("tom", drop(id, 0));
    expect((await t.act("anna", { action: "nudge", id })).body.error).toBe("it is not their turn");
    expect((await t.act("tom", { action: "nudge", id })).body.error).toBe(
      "give them a few hours first",
    );
    // Friday 17:00 + 4 weekday hours is Friday 21:00: the weekend plays no role yet
    t.advance(GAME_NUDGE_AFTER_MS);
    t.pokes.length = 0;
    const nudged = await t.ok("tom", { action: "nudge", id });
    expect(nudged.game!.nudgedAt).toBe(t.now());
    // a person asked for it: it goes out at once
    expect(t.pokes).toEqual([
      {
        socketId: "Anna",
        kind: "message",
        from: "Office games",
        text: "Tom is waiting for your move (Vier gewinnt)",
      },
    ] as never);
    t.advance(HOUR);
    expect((await t.act("tom", { action: "nudge", id })).body.error).toBe(
      "you already asked today",
    );
    // the move answers the nudge
    await t.ok("anna", drop(id, 1));
    expect(t.game(id).nudgedAt).toBeUndefined();
  });
});

describe("games: notifications on the Mac", () => {
  const texts = (t: ReturnType<typeof setup>) => t.pokes.map((p) => `${p.socketId}: ${p.text}`);

  test("a notification waits a minute and goes only to the player whose turn it is", async () => {
    const t = setup();
    const g = await t.challenge("anna", "tom");
    expect(t.pokes).toEqual([]);
    expect(t.app.games.nextDeadline()).toBe(t.now() + GAME_NOTICE_DELAY_MS);
    expect(t.alarms.at(-1)!).toBeLessThanOrEqual(t.now() + GAME_NOTICE_DELAY_MS);
    t.advance(GAME_NOTICE_DELAY_MS);
    t.alarm();
    expect(texts(t)).toEqual(["Tom: Anna challenges you to Vier gewinnt"]);
    expect(t.pokes[0]!.from).toBe("Office games");
    // no six-digit number that could be mistaken for a "this is me" code
    expect(t.pokes[0]!.text).not.toMatch(/\d{6}/);
    await t.ok("tom", { action: "accept", id: g.id });
    t.advance(GAME_NOTICE_DELAY_MS);
    t.alarm();
    // Tom moves first and is at his page: nothing for Anna yet
    expect(t.pokes).toHaveLength(1);
  });

  test("a player with the office open says 'seen' and gets nothing on the Mac", async () => {
    const t = setup();
    const id = await fourGame(t);
    t.pokes.length = 0;
    await t.ok("tom", drop(id, 3));
    await t.ok("anna", { action: "seen", id });
    t.advance(GAME_NOTICE_DELAY_MS);
    t.alarm();
    expect(t.pokes).toEqual([]);
  });

  test("at most one per 30 minutes per person; several games are bundled", async () => {
    const t = setup();
    const id = await fourGame(t);
    t.advance(GAME_NOTICE_EVERY_MS); // the invite notice is long gone
    t.alarm();
    t.pokes.length = 0;
    await t.ok("tom", drop(id, 3));
    t.advance(GAME_NOTICE_DELAY_MS);
    t.alarm();
    expect(texts(t)).toEqual(["Anna: Tom dropped in column 4. Your turn (Vier gewinnt)"]);
    // two more things for Anna within the half hour: held back, then one bundled notice
    await t.ok("anna", drop(id, 0));
    await t.ok("tom", drop(id, 3));
    await t.challenge("lea", "anna");
    t.advance(GAME_NOTICE_DELAY_MS);
    t.alarm();
    expect(t.pokes).toHaveLength(1);
    expect(t.app.games.nextDeadline()).toBe(t.now() - GAME_NOTICE_DELAY_MS + GAME_NOTICE_EVERY_MS);
    t.advance(GAME_NOTICE_EVERY_MS);
    t.alarm();
    expect(texts(t).at(-1)).toBe("Anna: 2 games are waiting for you");
    expect(t.pokes).toHaveLength(2);
  });

  test("the switch: no game notifications for somebody who turned them off", async () => {
    const t = setup();
    expect((await t.ok("tom", { action: "notices", on: false })).notices).toBe(false);
    const g = await t.challenge("anna", "tom");
    t.advance(GAME_NOTICE_DELAY_MS);
    t.alarm();
    expect(t.pokes).toEqual([]);
    expect((await t.read("tom", g.id)).body.notices).toBe(false);
    expect((await t.ok("tom", { action: "notices", on: true })).notices).toBe(true);
  });

  test("a 'this is me' code is never swallowed by a game notification", async () => {
    const t = setup();
    const claim = (personId: string, ip: string) =>
      t.app.handleHttp(
        new Request(`http://office/api/people/${personId}/claim`, {
          method: "POST",
          body: "{}",
          headers: { authorization: "Bearer pw", "cf-connecting-ip": ip },
        }),
      );
    // a code is on its way to Tom: the game notice waits
    expect((await claim("tom", "a"))!.status).toBe(200);
    t.pokes.length = 0;
    await t.challenge("anna", "tom");
    t.advance(GAME_NOTICE_DELAY_MS);
    t.alarm();
    expect(t.pokes).toEqual([]);
    // the code ran out (5 min): now the notice goes
    t.advance(5 * 60_000);
    t.alarm();
    expect(texts(t)).toEqual(["Tom: Anna challenges you to Vier gewinnt"]);
    // and a code asked for right after it says so instead of vanishing on the Mac
    const tooClose = (await claim("tom", "b"))!;
    expect(tooClose.status).toBe(429);
    expect(((await tooClose.json()) as { error: string }).error).toBe(
      "a notification just went to that Mac, try again in a few seconds",
    );
    t.advance(5_000);
    expect((await claim("tom", "c"))!.status).toBe(200);
  });

  test("the result reaches the player who was not there for the last move", async () => {
    const t = setup();
    const id = await fourGame(t);
    t.advance(GAME_NOTICE_EVERY_MS);
    t.alarm();
    t.pokes.length = 0;
    for (let i = 0; i < 3; i++) {
      await t.ok("tom", drop(id, 0));
      await t.ok("anna", { action: "seen", id });
      await t.ok("anna", drop(id, 1));
      await t.ok("tom", { action: "seen", id });
    }
    await t.ok("tom", drop(id, 0));
    t.advance(GAME_NOTICE_DELAY_MS);
    t.alarm();
    expect(texts(t)).toEqual(["Anna: Tom dropped in column 1. Tom wins (Vier gewinnt)"]);
  });
});

/** every game a viewer was ever told about parses as a public summary */
test("every broadcast is a valid game.updated with a public summary", async () => {
  const t = setup();
  await tomWins(t, await fourGame(t));
  const games: GameSummary[] = [];
  for (const raw of t.sent) {
    const r = parseViewerMessage(raw);
    if (r.ok && r.msg.type === "game.updated") games.push(r.msg.data.game);
  }
  expect(games.length).toBeGreaterThanOrEqual(9);
  expect(games.at(-1)).toMatchObject({ status: "over", winner: 1 });
});
