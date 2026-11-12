/** Four in a Row ("Vier gewinnt"): 7 columns, 6 rows, no hidden information. */
import { z } from "zod";
import {
  type GameOutcome,
  type MoveResult,
  otherSide,
  type Side,
  type TurnGame,
  type Viewer,
} from "./types.ts";

export const FOUR_COLS = 7;
export const FOUR_ROWS = 6;

export const FourMove = z.strictObject({
  type: z.literal("drop"),
  col: z
    .number()
    .int()
    .min(0)
    .max(FOUR_COLS - 1),
});
export type FourMove = z.infer<typeof FourMove>;

export type FourState = {
  kind: "four-in-a-row";
  /** `FOUR_ROWS * FOUR_COLS` cells, row 0 at the bottom: index = row * FOUR_COLS + col */
  board: (Side | null)[];
  first: Side;
  turn: Side;
  /** columns in the order they were played */
  moves: number[];
  winner: Side | null;
  /** the four (or more) winning cells */
  line: number[] | null;
  draw: boolean;
};

export type FourEvent =
  | { type: "drop"; side: Side; col: number; row: number }
  | { type: "won"; side: Side; line: number[] }
  | { type: "draw" };

/** Nothing is hidden, so every viewer gets the same picture. */
export type FourView = FourState;

const cell = (row: number, col: number) => row * FOUR_COLS + col;

/** Columns that still have room. */
export function fourOpenColumns(state: FourState): number[] {
  const open: number[] = [];
  for (let col = 0; col < FOUR_COLS; col++)
    if (state.board[cell(FOUR_ROWS - 1, col)] === null) open.push(col);
  return open;
}

/** The row a disc dropped into `col` lands on; null when the column is full. */
export function fourLandingRow(state: FourState, col: number): number | null {
  for (let row = 0; row < FOUR_ROWS; row++) if (state.board[cell(row, col)] === null) return row;
  return null;
}

const DIRECTIONS: [number, number][] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

/** The line of four or more through (row, col) for `side`, if there is one. */
function lineThrough(board: (Side | null)[], row: number, col: number, side: Side) {
  for (const [dr, dc] of DIRECTIONS) {
    const line = [cell(row, col)];
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < FOUR_ROWS && c >= 0 && c < FOUR_COLS && board[cell(r, c)] === side) {
        line.push(cell(r, c));
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= 4) return line.sort((a, b) => a - b);
  }
  return null;
}

export const FourInARow: TurnGame<FourState, FourMove, FourEvent, FourView> = {
  setup({ first }) {
    return {
      kind: "four-in-a-row",
      board: Array.from({ length: FOUR_ROWS * FOUR_COLS }, () => null),
      first,
      turn: first,
      moves: [],
      winner: null,
      line: null,
      draw: false,
    };
  },
  phase(state) {
    return state.winner !== null || state.draw ? "over" : "playing";
  },
  turn(state) {
    return this.phase(state) === "over" ? null : state.turn;
  },
  awaits(state, side) {
    return this.turn(state) === side;
  },
  apply(state, side, move): MoveResult<FourState, FourEvent> {
    if (this.phase(state) === "over") return { ok: false, error: "the game is over" };
    if (state.turn !== side) return { ok: false, error: "not your turn" };
    const row = fourLandingRow(state, move.col);
    if (row === null) return { ok: false, error: "that column is full" };
    const board = state.board.slice();
    board[cell(row, move.col)] = side;
    const events: FourEvent[] = [{ type: "drop", side, col: move.col, row }];
    const line = lineThrough(board, row, move.col, side);
    const full = board.every((c) => c !== null);
    if (line) events.push({ type: "won", side, line });
    else if (full) events.push({ type: "draw" });
    return {
      ok: true,
      events,
      state: {
        ...state,
        board,
        moves: [...state.moves, move.col],
        turn: otherSide(side),
        winner: line ? side : null,
        line,
        draw: !line && full,
      },
    };
  },
  outcome(state): GameOutcome | null {
    if (state.winner !== null) return { winner: state.winner };
    return state.draw ? { draw: true } : null;
  },
  view(state, _viewer: Viewer) {
    return state;
  },
};
