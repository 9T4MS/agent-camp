import { describe, expect, test } from "bun:test";
import {
  BATTLESHIP_FLEET,
  BATTLESHIP_SIZE,
  Battleship,
  BattleshipMove,
  type BattleshipShip,
  type BattleshipState,
  battleshipAutoPlace,
  battleshipCell,
  battleshipCellName,
  battleshipFleetError,
  battleshipSalvoSize,
  battleshipShipCells,
  battleshipTargets,
  FOUR_COLS,
  FOUR_ROWS,
  FourInARow,
  FourMove,
  type FourState,
  fourLandingRow,
  fourOpenColumns,
  GameKind,
  mulberry32,
  otherSide,
  type Side,
} from "../src/index.ts";

const ship = (row: number, col: number, length: number, horizontal = true): BattleshipShip => ({
  row,
  col,
  length,
  horizontal,
});
/** rows 0, 2, 4 and 6: 4 at A1, 3 at A3, 3 at A5, 2 at A7 */
const FLEET = [ship(0, 0, 4), ship(2, 0, 3), ship(4, 0, 3), ship(6, 0, 2)];
const FLEET_CELLS = FLEET.flatMap(battleshipShipCells);

function mustApply<S, M, E>(
  game: { apply(s: S, side: Side, m: M): { ok: boolean; state?: S; events?: E[]; error?: string } },
  state: S,
  side: Side,
  move: M,
): { state: S; events: E[] } {
  const r = game.apply(state, side, move);
  if (!r.ok) throw new Error(`move rejected: ${r.error}`);
  return { state: r.state!, events: r.events! };
}

function placedBoth(first: Side = 0): BattleshipState {
  let s = Battleship.setup({ first });
  s = mustApply(Battleship, s, 0, { type: "place", ships: FLEET }).state;
  return mustApply(Battleship, s, 1, { type: "place", ships: FLEET }).state;
}

describe("battleship: placing the fleet", () => {
  test("the fixture fleet is valid, and cell names read like a board", () => {
    expect(battleshipFleetError(FLEET)).toBeNull();
    expect(battleshipCellName(battleshipCell(3, 2))).toBe("C4");
    expect(battleshipCellName(0)).toBe("A1");
    expect(battleshipCellName(63)).toBe("H8");
  });

  test("wrong ships, off the board, overlapping and touching fleets are refused", () => {
    expect(battleshipFleetError([ship(0, 0, 4), ship(2, 0, 3), ship(4, 0, 3), ship(6, 0, 3)])).toBe(
      "the fleet is 4, 3, 3, 2",
    );
    expect(battleshipFleetError(FLEET.slice(0, 3))).toBe("the fleet is 4, 3, 3, 2");
    expect(battleshipFleetError([ship(0, 5, 4), ...FLEET.slice(1)])).toBe(
      "a ship is off the board",
    );
    expect(battleshipFleetError([ship(6, 7, 2, false), ...FLEET.slice(0, 3)])).toBeNull();
    expect(battleshipFleetError([ship(7, 7, 2, false), ...FLEET.slice(0, 3)])).toBe(
      "a ship is off the board",
    );
    expect(battleshipFleetError([ship(0, 0, 4), ship(0, 2, 3, false), ...FLEET.slice(2)])).toBe(
      "ships overlap at C1",
    );
    // side by side
    expect(battleshipFleetError([ship(0, 0, 4), ship(1, 0, 3), ...FLEET.slice(2)])).toBe(
      "ships touch at A2",
    );
    // corner to corner counts as touching too
    expect(battleshipFleetError([ship(0, 0, 4), ship(1, 4, 3), ...FLEET.slice(2)])).toBe(
      "ships touch at E2",
    );
  });

  test("10,000 seeded auto-placements are all valid, and a seed is reproducible", () => {
    for (let seed = 0; seed < 10_000; seed++) {
      const fleet = battleshipAutoPlace(seed);
      const error = battleshipFleetError(fleet);
      if (error) throw new Error(`seed ${seed}: ${error}`);
    }
    expect(battleshipAutoPlace(42)).toEqual(battleshipAutoPlace(42));
    expect(battleshipAutoPlace(42)).not.toEqual(battleshipAutoPlace(43));
  });

  test("both sides place in any order; play starts when both have", () => {
    let s = Battleship.setup({ first: 1 });
    expect(Battleship.phase(s)).toBe("setup");
    expect(Battleship.turn(s)).toBeNull();
    expect(Battleship.awaits(s, 0) && Battleship.awaits(s, 1)).toBe(true);
    expect(Battleship.apply(s, 0, { type: "fire", cells: [0, 1] })).toEqual({
      ok: false,
      error: "both fleets must be placed first",
    });
    const placed = mustApply(Battleship, s, 1, { type: "place", ships: FLEET });
    s = placed.state;
    expect(placed.events).toEqual([{ type: "placed", side: 1 }]);
    expect(Battleship.awaits(s, 1)).toBe(false);
    expect(Battleship.awaits(s, 0)).toBe(true);
    expect(Battleship.apply(s, 1, { type: "place", ships: FLEET })).toEqual({
      ok: false,
      error: "your fleet is already placed",
    });
    expect(Battleship.apply(s, 0, { type: "place", ships: FLEET.slice(1) }).ok).toBe(false);
    s = mustApply(Battleship, s, 0, { type: "place", ships: FLEET }).state;
    expect(Battleship.phase(s)).toBe("playing");
    expect(Battleship.turn(s)).toBe(1);
  });
});

describe("battleship: salvos", () => {
  test("the first mover opens with 2 shots, every later turn has 3, and a hit gives no extra shot", () => {
    let s = placedBoth(0);
    expect(battleshipSalvoSize(s, 0)).toBe(2);
    expect(Battleship.view(s, 0).salvo).toBe(2);
    expect(Battleship.apply(s, 0, { type: "fire", cells: [0, 1, 2] })).toEqual({
      ok: false,
      error: "fire 2 shots",
    });
    expect(Battleship.apply(s, 1, { type: "fire", cells: [0, 1, 2] })).toEqual({
      ok: false,
      error: "not your turn",
    });
    const opening = mustApply(Battleship, s, 0, { type: "fire", cells: [0, 63] });
    s = opening.state;
    // A1 is a hit, H8 is water; results come back together and the turn passes anyway
    expect(opening.events).toEqual([
      {
        type: "salvo",
        side: 0,
        shots: [
          { cell: 0, hit: true },
          { cell: 63, hit: false },
        ],
        sunk: [],
      },
    ]);
    expect(Battleship.turn(s)).toBe(1);
    expect(battleshipSalvoSize(s, 1)).toBe(3);
    s = mustApply(Battleship, s, 1, { type: "fire", cells: [60, 61, 62] }).state;
    expect(battleshipSalvoSize(s, 0)).toBe(3);
    expect(s.turns).toBe(2);
  });

  test("repeated cells, cells already fired at and known water are refused", () => {
    let s = placedBoth(0);
    expect(Battleship.apply(s, 0, { type: "fire", cells: [5, 5] })).toEqual({
      ok: false,
      error: "each shot needs its own cell",
    });
    s = mustApply(Battleship, s, 0, { type: "fire", cells: [48, 49] }).state; // sinks the 2
    s = mustApply(Battleship, s, 1, { type: "fire", cells: [61, 62, 63] }).state;
    expect(Battleship.apply(s, 0, { type: "fire", cells: [48, 1, 2] })).toEqual({
      ok: false,
      error: "A7 is already known",
    });
    // C7 is next to the sunk ship: ships may not touch, so it is water and not a target
    expect(Battleship.apply(s, 0, { type: "fire", cells: [50, 1, 2] })).toEqual({
      ok: false,
      error: "C7 is already known",
    });
    expect(battleshipTargets(s, 0)).not.toContain(50);
    expect(battleshipTargets(s, 0)).toContain(51);
  });

  test("a ship is sunk by its last hit, and the salvo that sinks the last ship wins", () => {
    let s = placedBoth(0);
    const sink = mustApply(Battleship, s, 0, { type: "fire", cells: [48, 49] });
    expect(sink.events[0]).toMatchObject({ type: "salvo", sunk: [FLEET[3]] });
    s = sink.state;
    const targets = FLEET_CELLS.filter((c) => c !== 48 && c !== 49);
    let waste = 63;
    while (Battleship.phase(s) === "playing") {
      if (s.turn === 1) {
        // the other side keeps missing in the empty bottom row
        s = mustApply(Battleship, s, 1, { type: "fire", cells: [waste--, waste--, waste--] }).state;
        continue;
      }
      const size = battleshipSalvoSize(s, 0);
      const cells = targets.splice(0, size);
      // top up with water when fewer ship cells are left than shots
      for (let c = 15; cells.length < size; c--)
        if (battleshipTargets(s, 0).includes(c) && !cells.includes(c)) cells.push(c);
      const r = mustApply(Battleship, s, 0, { type: "fire", cells });
      s = r.state;
      if (Battleship.phase(s) === "over") expect(r.events.at(-1)).toEqual({ type: "won", side: 0 });
    }
    expect(Battleship.outcome(s)).toEqual({ winner: 0 });
    expect(Battleship.turn(s)).toBeNull();
    expect(Battleship.awaits(s, 0) || Battleship.awaits(s, 1)).toBe(false);
    expect(Battleship.apply(s, 1, { type: "fire", cells: [1, 2, 3] })).toEqual({
      ok: false,
      error: "the game is over",
    });
  });

  test("the last salvo shrinks to the cells that are left", () => {
    const s = placedBoth(0);
    // everything except two cells was fired at already
    const fired = Array.from({ length: 62 }, (_, cell) => ({ cell, hit: false }));
    const late: BattleshipState = { ...s, shots: [fired, s.shots[1]], turn: 0 };
    expect(battleshipTargets(late, 0)).toEqual([62, 63]);
    expect(battleshipSalvoSize(late, 0)).toBe(2);
  });

  test("apply never changes the state it was given", () => {
    const s = placedBoth(0);
    const before = JSON.stringify(s);
    mustApply(Battleship, s, 0, { type: "fire", cells: [0, 1] });
    Battleship.apply(s, 0, { type: "fire", cells: [0, 0] });
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("battleship: what a viewer may know", () => {
  /** every ship-shaped object anywhere in a view */
  const shipsIn = (value: unknown, out: BattleshipShip[] = []): BattleshipShip[] => {
    if (Array.isArray(value)) for (const v of value) shipsIn(v, out);
    else if (value && typeof value === "object") {
      if ("horizontal" in value) out.push(value as BattleshipShip);
      else for (const v of Object.values(value)) shipsIn(v, out);
    }
    return out;
  };

  test("a fleet is shown to its owner only; sunk ships and the water around them to everybody", () => {
    let s = Battleship.setup({ first: 0 });
    const fleet1 = battleshipAutoPlace(7);
    s = mustApply(Battleship, s, 0, { type: "place", ships: FLEET }).state;
    // while one side is still placing, the other fleet is not shown either
    expect(shipsIn(Battleship.view(s, 1))).toEqual([]);
    expect(Battleship.view(s, 1).waters[0].placed).toBe(true);
    s = mustApply(Battleship, s, 1, { type: "place", ships: fleet1 }).state;

    expect(shipsIn(Battleship.view(s, "spectator"))).toEqual([]);
    expect(shipsIn(Battleship.view(s, 0))).toEqual(FLEET);
    expect(shipsIn(Battleship.view(s, 1))).toEqual(fleet1);

    // side 1 sinks the 2-ship at A7/B7
    s = mustApply(Battleship, s, 0, { type: "fire", cells: [62, 63] }).state;
    s = mustApply(Battleship, s, 1, { type: "fire", cells: [48, 49, 63] }).state;
    for (const viewer of ["spectator", 1] as const) {
      const view = Battleship.view(s, viewer);
      expect(view.waters[0].sunk).toEqual([FLEET[3]!]);
      expect(view.waters[0].ships).toBeNull();
      // the ring around A7/B7: row 6 and row 8, plus C7
      expect(view.waters[0].water).toEqual([40, 41, 42, 50, 56, 57, 58]);
      expect(view.waters[0].shots).toEqual([
        { cell: 48, hit: true },
        { cell: 49, hit: true },
        { cell: 63, hit: false },
      ]);
    }
    // a spectator never learns where the unsunk ships are
    expect(shipsIn(Battleship.view(s, "spectator"))).toEqual([FLEET[3]!]);
  });

  test("no view of a running game contains an unsunk ship of the other side (500 random games)", () => {
    for (let seed = 0; seed < 500; seed++) {
      const random = mulberry32(seed);
      let s = Battleship.setup({ first: seed % 2 === 0 ? 0 : 1 });
      const fleets = [battleshipAutoPlace(seed * 2), battleshipAutoPlace(seed * 2 + 1)] as const;
      s = mustApply(Battleship, s, 0, { type: "place", ships: fleets[0] }).state;
      s = mustApply(Battleship, s, 1, { type: "place", ships: fleets[1] }).state;
      let turns = 0;
      while (Battleship.phase(s) === "playing") {
        const side = s.turn;
        const targets = battleshipTargets(s, side);
        const cells: number[] = [];
        while (cells.length < battleshipSalvoSize(s, side))
          cells.push(...targets.splice(Math.floor(random() * targets.length), 1));
        s = mustApply(Battleship, s, side, { type: "fire", cells }).state;
        if (Battleship.phase(s) !== "playing") break;
        for (const viewer of [0, 1, "spectator"] as const) {
          const view = Battleship.view(s, viewer);
          for (const side of [0, 1] as const) {
            const w = view.waters[side];
            expect(w.ships === null).toBe(viewer !== side);
            for (const sunk of w.sunk)
              for (const cell of battleshipShipCells(sunk))
                expect(w.shots).toContainEqual({ cell, hit: true });
          }
        }
        if (++turns > 64) throw new Error(`seed ${seed}: game does not end`);
      }
      // random shooting always ends with a winner, and then both fleets are shown
      const winner = s.winner!;
      expect(Battleship.outcome(s)).toEqual({ winner });
      const over = Battleship.view(s, "spectator");
      expect(over.waters[0].ships).toEqual(fleets[0]);
      expect(over.waters[1].ships).toEqual(fleets[1]);
      expect(over.waters[otherSide(winner)].sunk).toHaveLength(BATTLESHIP_FLEET.length);
    }
  });

  test("moves from a browser are parsed strictly", () => {
    expect(BattleshipMove.safeParse({ type: "fire", cells: [0, 1, 2] }).success).toBe(true);
    expect(BattleshipMove.safeParse({ type: "fire", cells: [0, 1, 2, 3] }).success).toBe(false);
    expect(BattleshipMove.safeParse({ type: "fire", cells: [64] }).success).toBe(false);
    expect(BattleshipMove.safeParse({ type: "fire", cells: [] }).success).toBe(false);
    expect(BattleshipMove.safeParse({ type: "fire", cells: [1], extra: 1 }).success).toBe(false);
    expect(BattleshipMove.safeParse({ type: "place", ships: FLEET }).success).toBe(true);
    expect(BattleshipMove.safeParse({ type: "place", ships: FLEET.slice(1) }).success).toBe(false);
    expect(
      BattleshipMove.safeParse({
        type: "place",
        ships: [{ ...FLEET[0], row: 8 }, ...FLEET.slice(1)],
      }).success,
    ).toBe(false);
    expect(GameKind.options).toEqual(["battleship", "four-in-a-row"]);
    expect(BATTLESHIP_SIZE).toBe(8);
  });
});

describe("four in a row", () => {
  /** plays columns alternately, starting with side 0 */
  const play = (cols: number[], first: Side = 0): FourState => {
    let s = FourInARow.setup({ first });
    for (const col of cols) s = mustApply(FourInARow, s, s.turn, { type: "drop", col }).state;
    return s;
  };

  test("discs stack from the bottom, turns alternate, a full column is refused", () => {
    let s = FourInARow.setup({ first: 1 });
    expect(FourInARow.turn(s)).toBe(1);
    expect(FourInARow.apply(s, 0, { type: "drop", col: 3 })).toEqual({
      ok: false,
      error: "not your turn",
    });
    const first = mustApply(FourInARow, s, 1, { type: "drop", col: 3 });
    expect(first.events).toEqual([{ type: "drop", side: 1, col: 3, row: 0 }]);
    s = first.state;
    expect(fourLandingRow(s, 3)).toBe(1);
    s = play([3, 3, 3, 3, 3, 3]);
    expect(fourLandingRow(s, 3)).toBeNull();
    expect(fourOpenColumns(s)).toEqual([0, 1, 2, 4, 5, 6]);
    expect(FourInARow.apply(s, s.turn, { type: "drop", col: 3 })).toEqual({
      ok: false,
      error: "that column is full",
    });
    expect(FourMove.safeParse({ type: "drop", col: 7 }).success).toBe(false);
    expect(FourMove.safeParse({ type: "drop", col: 6 }).success).toBe(true);
  });

  test("four in a line wins in every direction", () => {
    const wins: [string, number[], number[]][] = [
      ["a row", [0, 0, 1, 1, 2, 2, 3], [0, 1, 2, 3]],
      ["a column", [0, 1, 0, 1, 0, 1, 0], [0, 7, 14, 21]],
      ["a rising diagonal", [0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3], [0, 8, 16, 24]],
      ["a falling diagonal", [3, 2, 2, 1, 1, 0, 1, 0, 0, 6, 0], [3, 9, 15, 21]],
    ];
    for (const [name, cols, line] of wins) {
      const s = play(cols);
      expect(FourInARow.outcome(s), name).toEqual({ winner: 0 });
      expect(s.line, name).toEqual(line);
      expect(FourInARow.phase(s)).toBe("over");
      expect(FourInARow.turn(s)).toBeNull();
      expect(FourInARow.apply(s, 1, { type: "drop", col: 6 })).toEqual({
        ok: false,
        error: "the game is over",
      });
    }
  });

  test("the winning move reports the line; three in a row is not enough", () => {
    const s = play([0, 0, 1, 1, 2, 2]);
    expect(FourInARow.outcome(s)).toBeNull();
    const r = mustApply(FourInARow, s, 0, { type: "drop", col: 3 });
    expect(r.events).toEqual([
      { type: "drop", side: 0, col: 3, row: 0 },
      { type: "won", side: 0, line: [0, 1, 2, 3] },
    ]);
  });

  test("a full board without a line is a draw", () => {
    // columns filled in an order that never makes four
    const order = [0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 2, 3, 2, 3, 2, 3, 3, 2, 3, 2, 3, 2];
    const rest = [4, 5, 4, 5, 4, 5, 5, 4, 5, 4, 5, 4, 6, 6, 6, 6, 6, 6];
    const s = play([...order, ...rest]);
    expect(s.moves).toHaveLength(FOUR_COLS * FOUR_ROWS);
    expect(FourInARow.outcome(s)).toEqual({ draw: true });
    expect(fourOpenColumns(s)).toEqual([]);
  });

  test("random games always end, and apply never changes the state it was given", () => {
    for (let seed = 0; seed < 300; seed++) {
      const random = mulberry32(seed);
      let s = FourInARow.setup({ first: seed % 2 === 0 ? 0 : 1 });
      while (FourInARow.phase(s) === "playing") {
        const open = fourOpenColumns(s);
        const before = JSON.stringify(s);
        const next = mustApply(FourInARow, s, s.turn, {
          type: "drop",
          col: open[Math.floor(random() * open.length)]!,
        }).state;
        expect(JSON.stringify(s)).toBe(before);
        s = next;
      }
      expect(FourInARow.outcome(s)).not.toBeNull();
      expect(FourInARow.view(s, "spectator")).toEqual(s);
    }
  });
});
