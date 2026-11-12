/**
 * Words for the turn-based games: what a row, a status line or an announcement says. Pure, so
 * the wording is tested without a browser.
 */
import {
  BATTLESHIP_FIRST_SALVO,
  BATTLESHIP_SALVO,
  type BattleshipView,
  battleshipCellName,
  type FourView,
  GAME_RATING_PROVISIONAL,
  type GameKind,
  type GameStats,
  type GameSummary,
  otherSide,
  type Side,
} from "@agent-office/protocol";

export const GAME_NAME: Record<GameKind, string> = {
  battleship: "Schiffe versenken",
  "four-in-a-row": "Vier gewinnt",
};

/** My side in a game, or null when I only watch (or am nobody). */
export function sideOf(game: GameSummary, me: string | null): Side | null {
  const i = me === null ? -1 : game.players.indexOf(me);
  return i === 0 || i === 1 ? i : null;
}

/** Whether the game waits for me (answer an invite, place a fleet, move). */
export function waitsForMe(game: GameSummary, me: string | null): boolean {
  const side = sideOf(game, me);
  return side !== null && game.awaits.includes(side);
}

/** My open games, the ones waiting for me first, then the most recently touched. */
export function myGames(games: GameSummary[], me: string | null): GameSummary[] {
  return games
    .filter((g) => g.status !== "over" && sideOf(g, me) !== null)
    .sort(
      (a, b) => Number(waitsForMe(b, me)) - Number(waitsForMe(a, me)) || b.updatedAt - a.updatedAt,
    );
}

/** One line for a game in a list, from my point of view ("Your turn", "Anna won"). */
export function gameLine(game: GameSummary, me: string | null): string {
  const side = sideOf(game, me);
  const [a, b] = game.names;
  if (side === null) {
    if (game.status === "over") return resultLine(game);
    if (game.status === "invited") return `${a} invited ${b}`;
    const turn = game.awaits.length === 1 ? game.names[game.awaits[0]!] : null;
    return game.status === "setup" ? "placing fleets" : turn ? `${turn}'s turn` : "playing";
  }
  const them = game.names[otherSide(side)];
  if (game.status === "over") {
    switch (game.result) {
      case "draw":
        return "A draw";
      case "declined":
        return side === 0 ? `${them} passed this time` : "You passed";
      case "cancelled":
        return side === 0 ? "You took the invite back" : `${them} took the invite back`;
      case "expired":
        return "The invite ran out";
      case "void":
        return "Called off";
      default: {
        const how =
          game.result === "resigned" ? " (gave up)" : game.result === "claimed" ? " (no move)" : "";
        return game.winner === side ? `You won${how}` : `${them} won${how}`;
      }
    }
  }
  if (game.status === "invited")
    return side === 1
      ? `${them} wants to play${game.rated ? " (rated)" : ""}`
      : `Waiting for ${them} to answer`;
  if (game.awaits.includes(side)) return game.status === "setup" ? "Place your fleet" : "Your turn";
  if (game.nudgedAt !== undefined) return `You asked ${them} for their move`;
  return game.status === "setup" ? `Waiting for ${them}'s fleet` : `${them}'s turn`;
}

/** "Tom beat Anna", "Anna and Tom drew": a finished game for everybody. */
export function resultLine(game: GameSummary): string {
  const [a, b] = game.names;
  if (game.winner !== undefined) {
    const how =
      game.result === "resigned" ? " (gave up)" : game.result === "claimed" ? " (no move)" : "";
    return `${game.names[game.winner]} beat ${game.names[otherSide(game.winner)]}${how}`;
  }
  if (game.result === "draw") return `${a} and ${b} drew`;
  if (game.result === "declined") return `${b} passed`;
  return game.result === "expired" ? "invite ran out" : "called off";
}

/** "by Thu 14:00" in the office's time zone; "" without a deadline. */
export function deadlineText(deadline: number | null, timezone?: string): string {
  if (deadline === null) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(new Date(deadline));
    return `by ${parts.replace(",", "")}`;
  } catch {
    return "";
  }
}

/** "7 W · 3 L · 1 D", plus the rating once a rated game was played ("1012?" = provisional). */
export function recordLine(stats: GameStats | undefined): string {
  if (!stats) return "no games yet";
  const parts = [`${stats.wins} W`, `${stats.losses} L`];
  if (stats.draws) parts.push(`${stats.draws} D`);
  if (stats.ratedGames > 0)
    parts.push(
      `rating ${Math.round(stats.rating)}${stats.ratedGames < GAME_RATING_PROVISIONAL ? "?" : ""}`,
    );
  return parts.join(" · ");
}

/** The ladder: most wins first; people who never finished a game are not on it. */
export function ladder(
  stats: Record<string, GameStats>,
  me: string | null,
  top = 5,
): { personId: string; stats: GameStats; place: number }[] {
  const rows = Object.entries(stats)
    .filter(([, s]) => s.wins + s.losses + s.draws > 0)
    .sort(([, a], [, b]) => b.rating - a.rating || b.wins - a.wins || a.losses - b.losses)
    .map(([personId, s], i) => ({ personId, stats: s, place: i + 1 }));
  const shown = rows.slice(0, top);
  const mine = rows.find((r) => r.personId === me);
  if (mine && !shown.includes(mine)) shown.push(mine);
  return shown;
}

/** How many shots the last salvo of a side had, from how many it fired in total. */
export function lastSalvoSize(shots: number, first: boolean): number {
  if (shots === 0) return 0;
  if (!first) return ((shots - 1) % BATTLESHIP_SALVO) + 1;
  return shots <= BATTLESHIP_FIRST_SALVO
    ? shots
    : ((shots - BATTLESHIP_FIRST_SALVO - 1) % BATTLESHIP_SALVO) + 1;
}

export type BattleshipCellState =
  | "untried"
  | "empty"
  | "miss"
  | "hit"
  | "sunk"
  | "water"
  | "ship"
  | "ship-hit"
  | "ship-sunk";

/**
 * What a Battleship cell is called for a screen reader: "C4, hit". `own` = my fleet's grid.
 */
export function battleshipCellLabel(
  cell: number,
  state: BattleshipCellState,
  picked = false,
): string {
  const text = {
    untried: "untried",
    empty: "empty",
    "ship-sunk": "your ship, sunk",
    miss: "miss",
    hit: "hit",
    sunk: "sunk",
    water: "water",
    ship: "your ship",
    "ship-hit": "your ship, hit",
  }[state];
  return `${battleshipCellName(cell)}, ${text}${picked ? ", picked" : ""}`;
}

/**
 * What changed in a Battleship game since `before`, as one sentence for the status line:
 * "Tom fired 3 shots: B2 miss, C4 hit, C5 hit. A ship sunk. Your turn."
 */
export function battleshipNews(
  before: BattleshipView | null,
  now: BattleshipView,
  names: [string, string],
  me: Side | null,
): string {
  const parts: string[] = [];
  for (const side of [0, 1] as const) {
    const target = otherSide(side);
    const fired = now.waters[target].shots.slice(before?.waters[target].shots.length ?? 0);
    // on first sight only the latest salvo is worth telling
    const shots = before
      ? fired
      : now.turn === target || now.winner === side
        ? fired.slice(-lastSalvoSize(fired.length, now.first === side))
        : [];
    if (shots.length === 0) continue;
    const who = side === me ? "You" : names[side];
    parts.push(
      `${who} fired ${shots.length} ${shots.length === 1 ? "shot" : "shots"}: ${shots
        .map((s) => `${battleshipCellName(s.cell)} ${s.hit ? "hit" : "miss"}`)
        .join(", ")}.`,
    );
    const sunk = now.waters[target].sunk.length - (before?.waters[target].sunk.length ?? 0);
    if (before && sunk > 0) parts.push(sunk === 1 ? "A ship sunk." : `${sunk} ships sunk.`);
  }
  parts.push(turnText(now.phase, now.turn, now.winner, names, me));
  return parts.join(" ");
}

/** "Tom dropped in column 4. Your turn." */
export function fourNews(
  before: FourView | null,
  now: FourView,
  names: [string, string],
  me: Side | null,
): string {
  const parts: string[] = [];
  const last = now.moves.at(-1);
  if (last !== undefined && (!before || now.moves.length > before.moves.length)) {
    // the turn passes with every drop, also with the last one
    const side = otherSide(now.turn);
    parts.push(`${side === me ? "You" : names[side]} dropped in column ${last + 1}.`);
  }
  parts.push(
    turnText(
      now.winner !== null || now.draw ? "over" : "playing",
      now.winner !== null || now.draw ? null : now.turn,
      now.winner,
      names,
      me,
      now.draw,
    ),
  );
  return parts.join(" ");
}

function turnText(
  phase: "setup" | "playing" | "over",
  turn: Side | null,
  winner: Side | null,
  names: [string, string],
  me: Side | null,
  draw = false,
): string {
  if (winner !== null) return winner === me ? "You win!" : `${names[winner]} wins.`;
  if (draw) return "A draw.";
  if (phase === "setup") return "Fleets are being placed.";
  if (turn === null || phase === "over") return "";
  return turn === me ? "Your turn." : `${names[turn]}'s turn.`;
}
