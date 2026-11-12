import { describe, expect, test } from "bun:test";
import {
  Battleship,
  type BattleshipShip,
  FourInARow,
  type GameSummary,
} from "@agent-office/protocol";
import {
  battleshipCellLabel,
  battleshipNews,
  deadlineText,
  fourNews,
  gameLine,
  ladder,
  lastSalvoSize,
  myGames,
  recordLine,
  resultLine,
  waitsForMe,
} from "../src/state/gameText.ts";

const game = (over: Partial<GameSummary> = {}): GameSummary => ({
  id: "g1",
  kind: "four-in-a-row",
  players: ["anna", "tom"],
  names: ["Anna", "Tom"],
  status: "playing",
  rated: false,
  awaits: [1],
  createdAt: 1,
  updatedAt: 2,
  since: 2,
  deadline: null,
  turns: 0,
  ...over,
});

describe("game rows", () => {
  test("a row reads from my point of view", () => {
    const invite = game({ status: "invited", rated: true });
    expect(gameLine(invite, "tom")).toBe("Anna wants to play (rated)");
    expect(gameLine(invite, "anna")).toBe("Waiting for Tom to answer");
    expect(gameLine(invite, "lea")).toBe("Anna invited Tom");
    expect(gameLine(invite, null)).toBe("Anna invited Tom");
    expect(gameLine(game(), "tom")).toBe("Your turn");
    expect(gameLine(game(), "anna")).toBe("Tom's turn");
    expect(gameLine(game({ nudgedAt: 5 }), "anna")).toBe("You asked Tom for their move");
    expect(gameLine(game(), "lea")).toBe("Tom's turn");
    const setup = game({ kind: "battleship", status: "setup", awaits: [0] });
    expect(gameLine(setup, "anna")).toBe("Place your fleet");
    expect(gameLine(setup, "tom")).toBe("Waiting for Anna's fleet");
    expect(gameLine(game({ kind: "battleship", status: "setup", awaits: [0, 1] }), "lea")).toBe(
      "placing fleets",
    );
  });

  test("results: won, gave up, no move, draw, and invites that came to nothing", () => {
    const over = (o: Partial<GameSummary>) => game({ status: "over", awaits: [], ...o });
    const won = over({ result: "won", winner: 1 });
    expect(gameLine(won, "tom")).toBe("You won");
    expect(gameLine(won, "anna")).toBe("Tom won");
    expect(resultLine(won)).toBe("Tom beat Anna");
    expect(gameLine(over({ result: "resigned", winner: 1 }), "tom")).toBe("You won (gave up)");
    expect(resultLine(over({ result: "claimed", winner: 0 }))).toBe("Anna beat Tom (no move)");
    expect(gameLine(over({ result: "draw" }), "anna")).toBe("A draw");
    expect(resultLine(over({ result: "draw" }))).toBe("Anna and Tom drew");
    // declining is quiet: no reason, no blame
    expect(gameLine(over({ result: "declined" }), "anna")).toBe("Tom passed this time");
    expect(gameLine(over({ result: "declined" }), "tom")).toBe("You passed");
    expect(gameLine(over({ result: "expired" }), "anna")).toBe("The invite ran out");
    expect(gameLine(over({ result: "void" }), "tom")).toBe("Called off");
    expect(gameLine(over({ result: "cancelled" }), "tom")).toBe("Anna took the invite back");
  });

  test("my games: the ones waiting for me first; finished and other people's are left out", () => {
    const games = [
      game({ id: "theirs", players: ["lea", "max"] }),
      game({ id: "wait", awaits: [1], updatedAt: 9 }),
      game({ id: "mine", awaits: [0], updatedAt: 3 }),
      game({ id: "done", status: "over", awaits: [] }),
      game({
        id: "invite",
        status: "invited",
        awaits: [1],
        players: ["lea", "anna"],
        updatedAt: 5,
      }),
    ];
    expect(myGames(games, "anna").map((g) => g.id)).toEqual(["invite", "mine", "wait"]);
    expect(myGames(games, null)).toEqual([]);
    expect(waitsForMe(games[1]!, "tom")).toBe(true);
    expect(waitsForMe(games[1]!, "anna")).toBe(false);
    expect(waitsForMe(games[1]!, "lea")).toBe(false);
  });

  test("deadline, record and ladder", () => {
    const wed = Date.UTC(2026, 10, 18, 16, 0, 0);
    expect(deadlineText(wed, "Europe/Vienna")).toBe("by Wed 17:00");
    expect(deadlineText(null)).toBe("");
    expect(deadlineText(wed, "Nowhere/Land")).toBe("");
    const s = (wins: number, losses: number, rating = 1000, ratedGames = 0, draws = 0) => ({
      wins,
      losses,
      draws,
      rating,
      ratedGames,
    });
    expect(recordLine(undefined)).toBe("no games yet");
    expect(recordLine(s(7, 3))).toBe("7 W · 3 L");
    expect(recordLine(s(1, 0, 1012.4, 1, 2))).toBe("1 W · 0 L · 2 D · rating 1012?");
    expect(recordLine(s(9, 1, 1100, 5))).toBe("9 W · 1 L · rating 1100");
    const stats = {
      a: s(1, 0, 1050, 2),
      b: s(5, 0),
      c: s(2, 2),
      d: s(0, 0),
      e: s(0, 4, 950, 3),
      f: s(1, 1),
      g: s(3, 0),
    };
    // top 3, plus my own row even when I am further down; d never finished a game
    expect(ladder(stats, "e", 3).map((r) => `${r.place}:${r.personId}`)).toEqual([
      "1:a",
      "2:b",
      "3:g",
      "6:e",
    ]);
    expect(ladder(stats, "a", 3)).toHaveLength(3);
  });
});

describe("announcements", () => {
  const ship = (row: number, length: number): BattleshipShip => ({
    row,
    col: 0,
    length,
    horizontal: true,
  });
  const FLEET = [ship(0, 4), ship(2, 3), ship(4, 3), ship(6, 2)];

  test("the last salvo's size follows from how many shots a side fired", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 8].map((n) => lastSalvoSize(n, true))).toEqual([
      0, 1, 2, 1, 2, 3, 1, 3,
    ]);
    expect([0, 1, 3, 4, 6, 7].map((n) => lastSalvoSize(n, false))).toEqual([0, 1, 3, 1, 3, 1]);
  });

  test("battleship: one sentence per turn, with every shot and what it did", () => {
    let s = Battleship.setup({ first: 0 });
    for (const side of [0, 1] as const) {
      const r = Battleship.apply(s, side, { type: "place", ships: FLEET });
      if (r.ok) s = r.state;
    }
    const placed = Battleship.view(s, 1);
    expect(battleshipNews(null, placed, ["Anna", "Tom"], 1)).toBe("Anna's turn.");
    const fire = (side: 0 | 1, cells: number[]) => {
      const r = Battleship.apply(s, side, { type: "fire", cells });
      if (!r.ok) throw new Error(r.error);
      s = r.state;
    };
    fire(0, [48, 49]);
    const afterAnna = Battleship.view(s, 1);
    expect(battleshipNews(placed, afterAnna, ["Anna", "Tom"], 1)).toBe(
      "Anna fired 2 shots: A7 hit, B7 hit. A ship sunk. Your turn.",
    );
    fire(1, [0, 9, 63]);
    const afterTom = Battleship.view(s, 1);
    expect(battleshipNews(afterAnna, afterTom, ["Anna", "Tom"], 1)).toBe(
      "You fired 3 shots: A1 hit, B2 miss, H8 miss. Anna's turn.",
    );
    // opening the board later tells the latest salvo only
    expect(battleshipNews(null, afterTom, ["Anna", "Tom"], 0)).toBe(
      "Tom fired 3 shots: A1 hit, B2 miss, H8 miss. Your turn.",
    );
    expect(battleshipNews(null, afterTom, ["Anna", "Tom"], null)).toBe(
      "Tom fired 3 shots: A1 hit, B2 miss, H8 miss. Anna's turn.",
    );
    expect(battleshipCellLabel(26, "hit")).toBe("C4, hit");
    expect(battleshipCellLabel(26, "untried", true)).toBe("C4, untried, picked");
    expect(battleshipCellLabel(0, "ship-hit")).toBe("A1, your ship, hit");
  });

  test("four in a row: the drop, then whose turn or who won", () => {
    let s = FourInARow.setup({ first: 1 });
    const start = s;
    const drop = (col: number) => {
      const r = FourInARow.apply(s, s.turn, { type: "drop", col });
      if (!r.ok) throw new Error(r.error);
      const before = s;
      s = r.state;
      return before;
    };
    expect(fourNews(null, start, ["Anna", "Tom"], 0)).toBe("Tom's turn.");
    let before = drop(3);
    expect(fourNews(before, s, ["Anna", "Tom"], 0)).toBe("Tom dropped in column 4. Your turn.");
    expect(fourNews(before, s, ["Anna", "Tom"], 1)).toBe("You dropped in column 4. Anna's turn.");
    for (const col of [0, 3, 0, 3, 0]) drop(col);
    before = drop(3);
    expect(fourNews(before, s, ["Anna", "Tom"], 0)).toBe("Tom dropped in column 4. Tom wins.");
    expect(fourNews(before, s, ["Anna", "Tom"], 1)).toBe("You dropped in column 4. You win!");
  });
});
