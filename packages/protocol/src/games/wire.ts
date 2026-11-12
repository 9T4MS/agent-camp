/**
 * Turn-based games on the wire: what viewers see of a game (never a hidden fleet) and what a
 * player's browser may ask the server to do.
 */
import { z } from "zod";

/** The games an office can play. The names shown to people live in the web app. */
export const GameKind = z.enum(["battleship", "four-in-a-row"]);
export type GameKind = z.infer<typeof GameKind>;

const PersonRef = z.string().min(1).max(64);
const GameId = z.string().min(1).max(64);
const SideIndex = z.union([z.literal(0), z.literal(1)]);

/**
 * `invited`: waiting for the challenged person; `setup`: both prepare (Battleship fleets);
 * `playing`; `over`: see `result`.
 */
export const GameStatus = z.enum(["invited", "setup", "playing", "over"]);
export type GameStatus = z.infer<typeof GameStatus>;

/**
 * How a game ended. With a winner: `won` (on the board), `resigned`, `claimed` (the other side
 * did not move in time and the waiting player took the win). Without: `draw`, `declined`,
 * `cancelled` (by the challenger), `expired` (invite never answered), `void` (called off).
 */
export const GameResult = z.enum([
  "won",
  "draw",
  "resigned",
  "claimed",
  "declined",
  "cancelled",
  "expired",
  "void",
]);
export type GameResult = z.infer<typeof GameResult>;

/** A game as everybody may see it. `view` is the engine's spectator view of the board. */
export const GameSummary = z.object({
  id: GameId,
  kind: GameKind,
  /** [challenger, challenged]: sides 0 and 1 of the engine */
  players: z.tuple([PersonRef, PersonRef]),
  /** their names when the game started, so a result stays readable after someone leaves */
  names: z.tuple([z.string().max(64), z.string().max(64)]),
  status: GameStatus,
  /** counts for the ratings (the challenged person saw that before accepting) */
  rated: z.boolean(),
  result: GameResult.optional(),
  winner: SideIndex.optional(),
  /** the sides that have to do something now (answer, place a fleet, move) */
  awaits: z.array(SideIndex).max(2),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** since when `awaits` has been waited for */
  since: z.number().int().nonnegative(),
  /** an invite runs out then; in a game the waiting player may take the win or call it off */
  deadline: z.number().int().nonnegative().nullable(),
  /** the waiting player asked for the move (shown as "… is waiting") */
  nudgedAt: z.number().int().nonnegative().optional(),
  /** turns played so far */
  turns: z.number().int().nonnegative(),
  /** spectator view of the board (`BattleshipView` / `FourView`); absent while invited */
  view: z.unknown().optional(),
});
export type GameSummary = z.infer<typeof GameSummary>;

/** Wins, losses and draws of finished games; `rating` moves only in rated games. */
export const GameStats = z.object({
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  rating: z.number(),
  ratedGames: z.number().int().nonnegative(),
});
export type GameStats = z.infer<typeof GameStats>;
export const GAME_RATING_START = 1000;
/** a rating is shown as provisional until this many rated games */
export const GAME_RATING_PROVISIONAL = 5;

/** Open games plus the latest results, and everybody's record. */
export const GamesState = z.object({
  games: z.array(GameSummary).max(200),
  stats: z.record(z.string(), GameStats),
});
export type GamesState = z.infer<typeof GamesState>;

/**
 * A cached page keeps working when a newer server knows a game it does not: such a game is
 * dropped instead of failing the whole office message.
 */
export const ViewerGamesState = z.object({
  games: z
    .array(z.unknown())
    .max(200)
    .transform((games) =>
      games.flatMap((g) => {
        const r = GameSummary.safeParse(g);
        return r.success ? [r.data] : [];
      }),
    ),
  stats: z.record(z.string(), GameStats).catch({}),
});
export type ViewerGamesState = z.infer<typeof ViewerGamesState>;

/** `POST /api/games`: the player is the person the browser is confirmed to be (`ao_me`). */
export const GameRequest = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("challenge"),
    opponentId: PersonRef,
    kind: GameKind,
    rated: z.boolean().optional(),
  }),
  z.strictObject({ action: z.literal("accept"), id: GameId }),
  z.strictObject({ action: z.literal("decline"), id: GameId }),
  z.strictObject({ action: z.literal("cancel"), id: GameId }),
  /** a move of that game's engine (`BattleshipMove` / `FourMove`), checked by the server */
  z.strictObject({ action: z.literal("move"), id: GameId, move: z.unknown() }),
  z.strictObject({ action: z.literal("resign"), id: GameId }),
  /** ask the other side for their move (a notification on their Mac) */
  z.strictObject({ action: z.literal("nudge"), id: GameId }),
  /** after the deadline: take the win */
  z.strictObject({ action: z.literal("claim"), id: GameId }),
  /** after the deadline: end the game without a result */
  z.strictObject({ action: z.literal("call-off"), id: GameId }),
  /** "I have the office open and saw this": no notification needed for it */
  z.strictObject({ action: z.literal("seen"), id: GameId }),
  /** game notifications on my Mac on / off */
  z.strictObject({ action: z.literal("notices"), on: z.boolean() }),
]);
export type GameRequest = z.infer<typeof GameRequest>;

/**
 * Answer to `POST /api/games` and `GET /api/games/:id`: the game, and the board as the asking
 * player may see it (their own fleet included).
 */
export const GameResponse = z.object({
  ok: z.literal(true),
  game: GameSummary.optional(),
  view: z.unknown().optional(),
  /** my side in that game; absent for a spectator */
  side: SideIndex.optional(),
  /** whether game notifications reach my Mac */
  notices: z.boolean().optional(),
});
export type GameResponse = z.infer<typeof GameResponse>;
