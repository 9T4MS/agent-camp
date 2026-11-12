/**
 * Turn-based office games: pure rules shared by the server (which owns the state), the web
 * page (previews, legal moves) and the tests. No I/O, no clock, no randomness except a seed.
 * States are plain JSON so the server can store them as they are.
 */

/** The two players of a game: 0 is the challenger, 1 the challenged. */
export type Side = 0 | 1;
export const otherSide = (side: Side): Side => (side === 0 ? 1 : 0);

/** Who is looking at a game: a player sees their own hidden things, a spectator none. */
export type Viewer = Side | "spectator";

export type GameOutcome = { winner: Side } | { draw: true };

/**
 * `setup`: both players prepare at the same time (placing a fleet); `playing`: one side is to
 * move; `over`: there is an outcome.
 */
export type GamePhase = "setup" | "playing" | "over";

export type MoveResult<S, E> = { ok: true; state: S; events: E[] } | { ok: false; error: string };

export interface TurnGame<S, M, E, V> {
  /** A fresh game; `first` moves first once play starts. */
  setup(options: { first: Side }): S;
  phase(state: S): GamePhase;
  /** Whose move it is while playing; null during setup and when the game is over. */
  turn(state: S): Side | null;
  /** Whether this side still has something to do right now (place a fleet, make a move). */
  awaits(state: S, side: Side): boolean;
  /** Applies a move without touching `state`; an illegal move says why. */
  apply(state: S, side: Side, move: M): MoveResult<S, E>;
  outcome(state: S): GameOutcome | null;
  /** What `viewer` may know. Everything sent to a browser goes through this. */
  view(state: S, viewer: Viewer): V;
}
