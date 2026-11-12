/**
 * The boards of the turn-based games as DOM: a Battleship grid is a real ARIA grid (one tab
 * stop, arrow keys, "C4" typed as a coordinate), Four in a Row is seven column buttons. A
 * cell's state is always a glyph and a name, never colour alone.
 */
import {
  BATTLESHIP_SIZE,
  type BattleshipShip,
  type BattleshipWaters,
  battleshipCellName,
  battleshipShipCells,
  FOUR_COLS,
  FOUR_ROWS,
  type FourView,
  type Side,
} from "@agent-office/protocol";
import { type BattleshipCellState, battleshipCellLabel } from "../state/gameText.ts";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const GLYPH: Record<BattleshipCellState, string> = {
  untried: "",
  empty: "",
  miss: "○",
  hit: "✕",
  sunk: "✕",
  water: "·",
  ship: "",
  "ship-hit": "✕",
  "ship-sunk": "✕",
};

export type GridCell = {
  state: BattleshipCellState;
  /** part of the salvo being picked, or of the ship being moved */
  picked?: boolean;
  /** hit by the latest salvo */
  last?: boolean;
};

/** The other side's waters as I know them: my shots, sunk ships, known water. */
export function targetCells(
  waters: BattleshipWaters,
  picked: ReadonlySet<number>,
  last: ReadonlySet<number>,
): GridCell[] {
  const sunk = new Set(waters.sunk.flatMap(battleshipShipCells));
  const water = new Set(waters.water);
  const shots = new Map(waters.shots.map((s) => [s.cell, s.hit]));
  // after the game the rest of the fleet is shown too
  const ships = new Set((waters.ships ?? []).flatMap(battleshipShipCells));
  return Array.from({ length: BATTLESHIP_SIZE * BATTLESHIP_SIZE }, (_, cell) => {
    const hit = shots.get(cell);
    const state: BattleshipCellState = sunk.has(cell)
      ? "sunk"
      : hit === true
        ? "hit"
        : hit === false
          ? "miss"
          : ships.has(cell)
            ? "ship"
            : water.has(cell)
              ? "water"
              : "untried";
    return { state, picked: picked.has(cell), last: last.has(cell) };
  });
}

/** My own waters: my ships and what landed on them. */
export function fleetCells(
  ships: BattleshipShip[],
  waters: BattleshipWaters | null,
  selected: BattleshipShip | null,
  last: ReadonlySet<number>,
): GridCell[] {
  const mine = new Set(ships.flatMap(battleshipShipCells));
  const sel = new Set(selected ? battleshipShipCells(selected) : []);
  const sunk = new Set((waters?.sunk ?? []).flatMap(battleshipShipCells));
  const shots = new Map((waters?.shots ?? []).map((s) => [s.cell, s.hit]));
  return Array.from({ length: BATTLESHIP_SIZE * BATTLESHIP_SIZE }, (_, cell) => {
    const shot = shots.has(cell);
    const state: BattleshipCellState = mine.has(cell)
      ? sunk.has(cell)
        ? "ship-sunk"
        : shot
          ? "ship-hit"
          : "ship"
      : shot
        ? "miss"
        : "empty";
    return { state, picked: sel.has(cell), last: last.has(cell) };
  });
}

/**
 * An 8x8 grid. `onPick` makes the cells act (fire at / move a ship to); without it the grid is
 * still readable cell by cell with the arrow keys. `id` keeps the focus across re-renders.
 */
export function buildGrid(opts: {
  id: string;
  label: string;
  cells: GridCell[];
  onPick?: (cell: number) => void;
  /** cells that cannot be picked (already fired at, known water) */
  canPick?: (cell: number) => boolean;
}): HTMLTableElement {
  const table = el("table", "sea");
  table.setAttribute("role", "grid");
  table.setAttribute("aria-label", opts.label);
  table.dataset.grid = opts.id;
  const head = el("tr");
  head.setAttribute("role", "row");
  head.append(el("td"));
  for (let col = 0; col < BATTLESHIP_SIZE; col++) {
    const th = el("th", undefined, String.fromCharCode(65 + col));
    th.scope = "col";
    th.setAttribute("role", "columnheader");
    head.append(th);
  }
  table.append(head);
  const buttons: HTMLButtonElement[] = [];
  for (let row = 0; row < BATTLESHIP_SIZE; row++) {
    const tr = el("tr");
    tr.setAttribute("role", "row");
    const th = el("th", undefined, String(row + 1));
    th.scope = "row";
    th.setAttribute("role", "rowheader");
    tr.append(th);
    for (let col = 0; col < BATTLESHIP_SIZE; col++) {
      const cell = row * BATTLESHIP_SIZE + col;
      const c = opts.cells[cell]!;
      const td = el("td");
      td.setAttribute("role", "gridcell");
      const b = el("button", `cell ${c.state}${c.picked ? " picked" : ""}${c.last ? " last" : ""}`);
      b.type = "button";
      b.textContent = c.picked && c.state === "untried" ? "◎" : GLYPH[c.state];
      b.setAttribute("aria-label", battleshipCellLabel(cell, c.state, c.picked));
      b.tabIndex = -1;
      b.dataset.key = `${opts.id}:${cell}`;
      const can = !!opts.onPick && (opts.canPick?.(cell) ?? true);
      // still focusable, so the board can be read; it just does nothing
      if (!can) b.setAttribute("aria-disabled", "true");
      else b.addEventListener("click", () => opts.onPick?.(cell));
      buttons.push(b);
      td.append(b);
      tr.append(td);
    }
    table.append(tr);
  }
  buttons[0]!.tabIndex = 0;
  const focus = (cell: number) => {
    for (const b of buttons) b.tabIndex = -1;
    const b = buttons[Math.max(0, Math.min(buttons.length - 1, cell))]!;
    b.tabIndex = 0;
    b.focus();
  };
  // one tab stop: remember where the focus was inside the grid
  table.addEventListener("focusin", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".cell");
    if (!b) return;
    for (const x of buttons) x.tabIndex = -1;
    b.tabIndex = 0;
  });
  let typed = "";
  let typedAt = 0;
  table.addEventListener("keydown", (e) => {
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 || e.altKey || e.metaKey) return;
    const row = Math.floor(at / BATTLESHIP_SIZE);
    const col = at % BATTLESHIP_SIZE;
    const N = BATTLESHIP_SIZE;
    const to: Record<string, number> = {
      ArrowLeft: col > 0 ? at - 1 : at,
      ArrowRight: col < N - 1 ? at + 1 : at,
      ArrowUp: row > 0 ? at - N : at,
      ArrowDown: row < N - 1 ? at + N : at,
      Home: e.ctrlKey ? 0 : row * N,
      End: e.ctrlKey ? N * N - 1 : row * N + N - 1,
      PageUp: col,
      PageDown: (N - 1) * N + col,
    };
    if (e.key in to) {
      e.preventDefault();
      focus(to[e.key]!);
      return;
    }
    // "C4": a typed coordinate moves the focus there (it never fires)
    if (/^[a-hA-H1-8]$/.test(e.key) && !e.ctrlKey) {
      const now = Date.now();
      typed = now - typedAt > 1000 ? e.key : typed + e.key;
      typedAt = now;
      const m = /^([a-h])([1-8])$/i.exec(typed);
      if (m) {
        e.preventDefault();
        focus((Number(m[2]) - 1) * N + (m[1]!.toUpperCase().charCodeAt(0) - 65));
        typed = "";
      } else if (!/^[a-h]$/i.test(typed)) typed = "";
    }
  });
  return table;
}

/** Where a ship moved to `cell` ends up: pushed back onto the board if it would stick out. */
export function moveShip(ship: BattleshipShip, cell: number): BattleshipShip {
  const row = Math.floor(cell / BATTLESHIP_SIZE);
  const col = cell % BATTLESHIP_SIZE;
  const max = BATTLESHIP_SIZE - ship.length;
  return {
    ...ship,
    row: ship.horizontal ? row : Math.min(row, max),
    col: ship.horizontal ? Math.min(col, max) : col,
  };
}

/** The ship turned on its top-left cell, pushed back onto the board. */
export function rotateShip(ship: BattleshipShip): BattleshipShip {
  return moveShip({ ...ship, horizontal: !ship.horizontal }, ship.row * BATTLESHIP_SIZE + ship.col);
}

/** "B2 to B4": a ship for a list. */
export function shipName(ship: BattleshipShip): string {
  const cells = battleshipShipCells(ship);
  return `${ship.length} long, ${battleshipCellName(cells[0]!)} to ${battleshipCellName(cells.at(-1)!)}`;
}

/**
 * Four in a Row: seven column buttons, each the whole column. `onDrop` absent = read-only.
 * On touch a first tap shows where the disc would land and a second one drops it.
 */
export function buildFour(opts: {
  view: FourView;
  names: [string, string];
  mySide: Side | null;
  onDrop?: (col: number) => void;
  /** touch: the column tapped once (the board may be redrawn between the two taps) */
  armed?: number | null;
  onArm?: (col: number) => void;
}): HTMLElement {
  const { view } = opts;
  const board = el("div", "four");
  board.setAttribute("role", "group");
  board.setAttribute("aria-label", "Board: 7 columns, discs fall to the bottom");
  const last = view.moves.at(-1);
  const win = new Set(view.line ?? []);
  const coarse = matchMedia("(pointer: coarse)").matches;
  const cols: HTMLButtonElement[] = [];
  let armed = opts.armed ?? -1;
  for (let col = 0; col < FOUR_COLS; col++) {
    const b = el("button", "four-col");
    b.type = "button";
    b.dataset.key = `four:${col}`;
    let filled = 0;
    let lastRow = -1;
    for (let row = FOUR_ROWS - 1; row >= 0; row--) {
      const side = view.board[row * FOUR_COLS + col];
      if (side !== null && side !== undefined) {
        filled++;
        lastRow = Math.max(lastRow, row);
      }
      const disc = el(
        "span",
        `disc ${side === 0 ? "s0" : side === 1 ? "s1" : "none"}${
          win.has(row * FOUR_COLS + col) ? " win" : ""
        }`,
      );
      disc.dataset.row = String(row);
      disc.setAttribute("aria-hidden", "true");
      b.append(disc);
    }
    if (last === col && lastRow >= 0)
      b.querySelector(`.disc[data-row="${lastRow}"]`)?.classList.add("last");
    const full = filled === FOUR_ROWS;
    const top = lastRow >= 0 ? view.board[lastRow * FOUR_COLS + col] : null;
    b.setAttribute(
      "aria-label",
      `Column ${col + 1}, ${filled} of ${FOUR_ROWS} filled${
        top === 0 || top === 1
          ? `, ${top === opts.mySide ? "your" : `${opts.names[top]}'s`} disc on top`
          : ""
      }`,
    );
    if (!opts.onDrop || full) b.setAttribute("aria-disabled", "true");
    else
      b.addEventListener("click", () => {
        if (coarse && armed !== col) {
          armed = col;
          for (const x of cols) x.classList.toggle("armed", x === b);
          opts.onArm?.(col);
          return;
        }
        opts.onDrop?.(col);
      });
    if (armed === col && opts.onDrop && !full) b.classList.add("armed");
    cols.push(b);
    board.append(b);
  }
  if (opts.mySide !== null) board.classList.add(`me-s${opts.mySide}`);
  board.addEventListener("keydown", (e) => {
    const at = cols.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const to =
      e.key === "ArrowLeft"
        ? at - 1
        : e.key === "ArrowRight"
          ? at + 1
          : /^[1-7]$/.test(e.key)
            ? Number(e.key) - 1
            : -1;
    if (to < 0 || to >= FOUR_COLS) return;
    e.preventDefault();
    cols[to]!.focus();
  });
  return board;
}
