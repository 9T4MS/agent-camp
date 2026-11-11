/**
 * Battleship ("Schiffe versenken"), the short office variant: an 8x8 board, a fleet of four
 * ships (4, 3, 3, 2) that may not touch, and a salvo of three shots per turn whose results
 * come back together. A hit gives no extra shot. The side that moves first opens with two
 * shots: with three, the first mover won about 60% of simulated games between equal players,
 * with two about 53%.
 *
 * Hidden information: `view()` shows a fleet only to its owner, plus ships that were sunk;
 * when the game is over both fleets are shown.
 */
import { z } from "zod";
import { mulberry32 } from "../hash.ts";
import {
  type GameOutcome,
  type MoveResult,
  otherSide,
  type Side,
  type TurnGame,
  type Viewer,
} from "./types.ts";

export const BATTLESHIP_SIZE = 8;
/** ship lengths, longest first */
export const BATTLESHIP_FLEET = [4, 3, 3, 2] as const;
export const BATTLESHIP_SALVO = 3;
/** the opening salvo of the side that moves first */
export const BATTLESHIP_FIRST_SALVO = 2;

const CELLS = BATTLESHIP_SIZE * BATTLESHIP_SIZE;
const Cell = z
  .number()
  .int()
  .min(0)
  .max(CELLS - 1);

/** A ship by its top-left cell: it runs right when `horizontal`, down otherwise. */
export const BattleshipShip = z.strictObject({
  row: z
    .number()
    .int()
    .min(0)
    .max(BATTLESHIP_SIZE - 1),
  col: z
    .number()
    .int()
    .min(0)
    .max(BATTLESHIP_SIZE - 1),
  length: z.number().int().min(2).max(4),
  horizontal: z.boolean(),
});
export type BattleshipShip = z.infer<typeof BattleshipShip>;

export const BattleshipMove = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("place"),
    ships: z.array(BattleshipShip).length(BATTLESHIP_FLEET.length),
  }),
  z.strictObject({
    type: z.literal("fire"),
    /** cell indexes (row * 8 + col), one per shot of the salvo */
    cells: z.array(Cell).min(1).max(BATTLESHIP_SALVO),
  }),
]);
export type BattleshipMove = z.infer<typeof BattleshipMove>;

export type BattleshipShot = { cell: number; hit: boolean };

export type BattleshipState = {
  kind: "battleship";
  /** each side's fleet; null until that side placed it */
  fleets: [BattleshipShip[] | null, BattleshipShip[] | null];
  /** the shots each side fired at the other, in order */
  shots: [BattleshipShot[], BattleshipShot[]];
  first: Side;
  turn: Side;
  /** turns taken so far, by both sides together */
  turns: number;
  winner: Side | null;
};

export type BattleshipEvent =
  | { type: "placed"; side: Side }
  | {
      type: "salvo";
      side: Side;
      shots: BattleshipShot[];
      /** ships this salvo finished off */
      sunk: BattleshipShip[];
    }
  | { type: "won"; side: Side };

/** One side's waters as a viewer may see them. */
export type BattleshipWaters = {
  placed: boolean;
  /** the whole fleet: only for its owner, or for everybody once the game is over */
  ships: BattleshipShip[] | null;
  /** shots that landed here */
  shots: BattleshipShot[];
  /** ships that were sunk (known to everybody) */
  sunk: BattleshipShip[];
  /** cells next to a sunk ship: ships may not touch, so these are known to be water */
  water: number[];
};

export type BattleshipView = {
  kind: "battleship";
  phase: "setup" | "playing" | "over";
  first: Side;
  turn: Side | null;
  turns: number;
  /** how many shots the side to move fires this turn */
  salvo: number;
  waters: [BattleshipWaters, BattleshipWaters];
  winner: Side | null;
};

export const battleshipCell = (row: number, col: number) => row * BATTLESHIP_SIZE + col;

/** "C4": column letter, then row number from 1. */
export const battleshipCellName = (cell: number) =>
  `${String.fromCharCode(65 + (cell % BATTLESHIP_SIZE))}${Math.floor(cell / BATTLESHIP_SIZE) + 1}`;

/** The cells a ship covers; cells outside the board are left out. */
export function battleshipShipCells(ship: BattleshipShip): number[] {
  const cells: number[] = [];
  for (let i = 0; i < ship.length; i++) {
    const row = ship.row + (ship.horizontal ? 0 : i);
    const col = ship.col + (ship.horizontal ? i : 0);
    if (row < BATTLESHIP_SIZE && col < BATTLESHIP_SIZE) cells.push(battleshipCell(row, col));
  }
  return cells;
}

/** The cells around `cells` (sides and corners) that are on the board. */
function ring(cells: number[]): number[] {
  const own = new Set(cells);
  const out = new Set<number>();
  for (const cell of cells) {
    const row = Math.floor(cell / BATTLESHIP_SIZE);
    const col = cell % BATTLESHIP_SIZE;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= BATTLESHIP_SIZE || c < 0 || c >= BATTLESHIP_SIZE) continue;
        const near = battleshipCell(r, c);
        if (!own.has(near)) out.add(near);
      }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Why a fleet cannot be placed like this, or null when it is fine: the right ships, all on
 * the board, none overlapping or touching (corners count).
 */
export function battleshipFleetError(ships: BattleshipShip[]): string | null {
  const lengths = ships.map((s) => s.length).sort((a, b) => b - a);
  if (lengths.join() !== [...BATTLESHIP_FLEET].join())
    return `the fleet is ${BATTLESHIP_FLEET.join(", ")}`;
  const taken = new Set<number>();
  const blocked = new Set<number>();
  for (const ship of ships) {
    const cells = battleshipShipCells(ship);
    if (cells.length !== ship.length) return "a ship is off the board";
    for (const cell of cells) {
      if (taken.has(cell)) return `ships overlap at ${battleshipCellName(cell)}`;
      if (blocked.has(cell)) return `ships touch at ${battleshipCellName(cell)}`;
    }
    for (const cell of cells) taken.add(cell);
    for (const cell of ring(cells)) blocked.add(cell);
  }
  return null;
}

/** A random valid fleet; the same seed gives the same fleet. */
export function battleshipAutoPlace(seed: number): BattleshipShip[] {
  const random = mulberry32(seed);
  for (;;) {
    const ships: BattleshipShip[] = [];
    let stuck = false;
    for (const length of BATTLESHIP_FLEET) {
      let placed = false;
      for (let attempt = 0; attempt < 200 && !placed; attempt++) {
        const horizontal = random() < 0.5;
        const ship: BattleshipShip = {
          row: Math.floor(random() * (horizontal ? BATTLESHIP_SIZE : BATTLESHIP_SIZE - length + 1)),
          col: Math.floor(random() * (horizontal ? BATTLESHIP_SIZE - length + 1 : BATTLESHIP_SIZE)),
          length,
          horizontal,
        };
        // the partial fleet is checked like a whole one, minus the "right ships" rule
        const error = partialFleetError([...ships, ship]);
        if (!error) {
          ships.push(ship);
          placed = true;
        }
      }
      if (!placed) {
        stuck = true;
        break;
      }
    }
    if (!stuck) return ships;
  }
}

function partialFleetError(ships: BattleshipShip[]): boolean {
  const taken = new Set<number>();
  const blocked = new Set<number>();
  for (const ship of ships) {
    const cells = battleshipShipCells(ship);
    if (cells.length !== ship.length) return true;
    if (cells.some((cell) => taken.has(cell) || blocked.has(cell))) return true;
    for (const cell of cells) taken.add(cell);
    for (const cell of ring(cells)) blocked.add(cell);
  }
  return false;
}

/** The ships of `fleet` whose every cell was hit by `shots`. */
function sunkShips(fleet: BattleshipShip[], shots: BattleshipShot[]): BattleshipShip[] {
  const hits = new Set(shots.filter((s) => s.hit).map((s) => s.cell));
  return fleet.filter((ship) => battleshipShipCells(ship).every((cell) => hits.has(cell)));
}

/** Cells `side` can still usefully fire at: not fired yet and not known water. */
export function battleshipTargets(state: BattleshipState, side: Side): number[] {
  const fleet = state.fleets[otherSide(side)];
  const shots = state.shots[side];
  const known = new Set(shots.map((s) => s.cell));
  if (fleet)
    for (const ship of sunkShips(fleet, shots))
      for (const cell of ring(battleshipShipCells(ship))) known.add(cell);
  const targets: number[] = [];
  for (let cell = 0; cell < CELLS; cell++) if (!known.has(cell)) targets.push(cell);
  return targets;
}

/** How many shots `side` fires on its next turn. */
export function battleshipSalvoSize(state: BattleshipState, side: Side): number {
  const opening = side === state.first && state.shots[side].length === 0;
  const size = opening ? BATTLESHIP_FIRST_SALVO : BATTLESHIP_SALVO;
  return Math.min(size, battleshipTargets(state, side).length);
}

const phaseOf = (state: BattleshipState) =>
  state.winner !== null ? "over" : state.fleets[0] && state.fleets[1] ? "playing" : "setup";

export const Battleship: TurnGame<
  BattleshipState,
  BattleshipMove,
  BattleshipEvent,
  BattleshipView
> = {
  setup({ first }) {
    return {
      kind: "battleship",
      fleets: [null, null],
      shots: [[], []],
      first,
      turn: first,
      turns: 0,
      winner: null,
    };
  },
  phase: phaseOf,
  turn(state) {
    return phaseOf(state) === "playing" ? state.turn : null;
  },
  awaits(state, side) {
    const phase = phaseOf(state);
    if (phase === "setup") return state.fleets[side] === null;
    return phase === "playing" && state.turn === side;
  },
  apply(state, side, move): MoveResult<BattleshipState, BattleshipEvent> {
    const phase = phaseOf(state);
    if (phase === "over") return { ok: false, error: "the game is over" };
    if (move.type === "place") {
      if (state.fleets[side]) return { ok: false, error: "your fleet is already placed" };
      const error = battleshipFleetError(move.ships);
      if (error) return { ok: false, error };
      const fleets: BattleshipState["fleets"] = [state.fleets[0], state.fleets[1]];
      fleets[side] = move.ships.map((ship) => ({ ...ship }));
      return { ok: true, state: { ...state, fleets }, events: [{ type: "placed", side }] };
    }
    if (phase === "setup") return { ok: false, error: "both fleets must be placed first" };
    if (state.turn !== side) return { ok: false, error: "not your turn" };
    const size = battleshipSalvoSize(state, side);
    if (move.cells.length !== size)
      return { ok: false, error: `fire ${size} ${size === 1 ? "shot" : "shots"}` };
    if (new Set(move.cells).size !== move.cells.length)
      return { ok: false, error: "each shot needs its own cell" };
    const targets = new Set(battleshipTargets(state, side));
    const wasted = move.cells.find((cell) => !targets.has(cell));
    if (wasted !== undefined)
      return { ok: false, error: `${battleshipCellName(wasted)} is already known` };
    const fleet = state.fleets[otherSide(side)]!;
    const occupied = new Set(fleet.flatMap(battleshipShipCells));
    const salvo = move.cells.map((cell) => ({ cell, hit: occupied.has(cell) }));
    const before = sunkShips(fleet, state.shots[side]);
    const shots: BattleshipState["shots"] = [state.shots[0], state.shots[1]];
    shots[side] = [...state.shots[side], ...salvo];
    const after = sunkShips(fleet, shots[side]);
    const won = after.length === fleet.length;
    const events: BattleshipEvent[] = [
      { type: "salvo", side, shots: salvo, sunk: after.filter((ship) => !before.includes(ship)) },
    ];
    if (won) events.push({ type: "won", side });
    return {
      ok: true,
      events,
      state: {
        ...state,
        shots,
        turn: otherSide(side),
        turns: state.turns + 1,
        winner: won ? side : null,
      },
    };
  },
  outcome(state): GameOutcome | null {
    return state.winner === null ? null : { winner: state.winner };
  },
  view(state, viewer: Viewer): BattleshipView {
    const phase = phaseOf(state);
    const waters = (side: Side): BattleshipWaters => {
      const fleet = state.fleets[side];
      const shots = state.shots[otherSide(side)];
      const sunk = fleet ? sunkShips(fleet, shots) : [];
      return {
        placed: fleet !== null,
        ships: fleet && (viewer === side || phase === "over") ? fleet : null,
        shots,
        sunk,
        water: ring(sunk.flatMap(battleshipShipCells)).filter(
          (cell) => !sunk.some((ship) => battleshipShipCells(ship).includes(cell)),
        ),
      };
    };
    return {
      kind: "battleship",
      phase,
      first: state.first,
      turn: phase === "playing" ? state.turn : null,
      turns: state.turns,
      salvo: phase === "playing" ? battleshipSalvoSize(state, state.turn) : 0,
      waters: [waters(0), waters(1)],
      winner: state.winner,
    };
  },
};
