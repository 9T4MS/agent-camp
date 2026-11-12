/**
 * Turn-based office games (Battleship, Four in a Row): invites, turns, deadlines, results and
 * the notifications that go with them. The rules live in `@agent-office/protocol` (games/);
 * this is who may do what and when.
 *
 * Only the two players act, and only as the person their browser is confirmed to be (`ao_me`).
 * Everything that leaves this module for viewers is a `GameSummary` with the engine's
 * spectator view: a hidden fleet goes out only to its owner, in the answer to their own
 * request.
 *
 * All games are one KV value (like the party points): an office has a handful at a time.
 */
import {
  Battleship,
  type BattleshipEvent,
  BattleshipMove,
  envelope,
  type FourEvent,
  FourInARow,
  FourMove,
  GAME_RATING_START,
  type GameKind,
  GameRequest,
  type GameResponse,
  type GameResult,
  type GameStats,
  type GameStatus,
  type GameSummary,
  type GamesState,
  otherSide,
  type Side,
  type TurnGame,
  ulid,
} from "@agent-office/protocol";
import type { z } from "zod";
import type { Store } from "./store.ts";

/** Open games (invited, setup, playing) one person can have. */
export const GAMES_OPEN_MAX = 3;
/**
 * How long a side has for its answer or move: three days, of which Saturdays and Sundays (in
 * the office time zone) do not count. Afterwards an invite is gone; in a game nothing happens
 * by itself, but the waiting player may take the win or call it off.
 */
export const GAME_DEADLINE_MS = 3 * 86_400_000;
/** A waiting player may ask for the move after this much weekday time, once a day per game. */
export const GAME_NUDGE_AFTER_MS = 4 * 3_600_000;
export const GAME_NUDGE_EVERY_MS = 86_400_000;
/** A game nobody touched for this long ends without a result. */
export const GAME_STALE_MS = 14 * 86_400_000;
/**
 * A notification waits this long: a player who has the office open tells the server they saw
 * the move ("seen"), and then nothing pops up on their Mac.
 */
export const GAME_NOTICE_DELAY_MS = 60_000;
/** At most one game notification per person this often; several games are bundled. */
export const GAME_NOTICE_EVERY_MS = 30 * 60_000;
/** While a "this is me" code is on its way, game notifications wait (the Mac drops close ones). */
export const GAME_NOTICE_RETRY_MS = 30_000;
/** Finished games kept for the results list. */
export const GAME_RESULTS_KEPT = 20;
export const GAME_RATING_K = 24;
/**
 * Requests per second from one browser: moves are clicks, not a stream, but a click and the
 * page's own "seen" often come together.
 */
export const GAME_REQUESTS_PER_SECOND = 5;
const STORAGE_KEY = "games.v1";

export const GAME_LABEL: Record<GameKind, string> = {
  battleship: "Schiffe versenken",
  "four-in-a-row": "Vier gewinnt",
};

type Engine = {
  // biome-ignore lint/suspicious/noExplicitAny: one table for engines with different state types
  game: TurnGame<any, any, any, any>;
  move: z.ZodType;
  turns(state: unknown): number;
};
const ENGINES: Record<GameKind, Engine> = {
  battleship: {
    game: Battleship,
    move: BattleshipMove,
    turns: (s) => (s as { turns: number }).turns,
  },
  "four-in-a-row": {
    game: FourInARow,
    move: FourMove,
    turns: (s) => (s as { moves: number[] }).moves.length,
  },
};

type Notice = { at: number; text: string };
type StoredGame = {
  id: string;
  kind: GameKind;
  players: [string, string];
  names: [string, string];
  status: GameStatus;
  rated: boolean;
  result?: GameResult;
  winner?: Side;
  /** the engine's state; null while invited */
  state: unknown;
  createdAt: number;
  updatedAt: number;
  since: number;
  deadline: number | null;
  nudgedAt?: number;
  /** a notification still to go to each side's Mac */
  notices: [Notice | null, Notice | null];
};
type StoredPerson = { noticesOff?: true; noticedAt?: number };
type Stored = {
  games: StoredGame[];
  stats: Record<string, GameStats>;
  people: Record<string, StoredPerson>;
};

export type GamesDeps = {
  /** office time zone, for "weekends do not count" */
  timezone: string;
  /** everybody in the office right now (online or not): id -> name */
  people(): Map<string, string>;
  /** show a notification on that person's Macs; how many Macs took it */
  notify(personId: string, text: string): number;
  /** a "this is me" code is on its way to that person's Mac */
  codePending(personId: string, now: number): boolean;
  broadcast(json: string): void;
};

export type GamesReply = { status: number; body: GameResponse | { error: string } };
const fail = (status: number, error: string): GamesReply => ({ status, body: { error } });

/** `from` plus `ms` of weekday time: Saturdays and Sundays in `timezone` are skipped. */
export function addWeekdayMs(from: number, ms: number, timezone: string): number {
  let parts: Intl.DateTimeFormat;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
  } catch {
    return from + ms;
  }
  let at = from;
  let left = ms;
  // a day at a time; at most a few weeks of days for any deadline used here
  for (let i = 0; i < 400 && left > 0; i++) {
    const p = Object.fromEntries(parts.formatToParts(at).map((x) => [x.type, x.value]));
    const intoDay =
      (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000 + (at % 1000);
    const toMidnight = Math.max(1, 86_400_000 - intoDay);
    if (p.weekday === "Sat" || p.weekday === "Sun") {
      at += toMidnight;
      continue;
    }
    const step = Math.min(left, toMidnight);
    at += step;
    left -= step;
  }
  // landing exactly on a weekend's first instant is fine: nothing of it was used
  return at;
}

const isOpen = (g: StoredGame) => g.status !== "over";
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export class Games {
  private data: Stored = { games: [], stats: {}, people: {} };
  private requests = new Map<string, number[]>();

  constructor(
    private store: Store,
    private deps: GamesDeps,
  ) {
    try {
      const raw = store.kvGet(STORAGE_KEY);
      const saved = raw ? (JSON.parse(raw) as Partial<Stored>) : null;
      if (saved && Array.isArray(saved.games))
        this.data = {
          games: saved.games,
          stats: saved.stats ?? {},
          people: saved.people ?? {},
        };
    } catch {
      /* optional data must never stop the office */
    }
  }

  private person(id: string): StoredPerson {
    let person = this.data.people[id];
    if (!person) {
      person = {};
      this.data.people[id] = person;
    }
    return person;
  }

  private persist(): void {
    this.store.kvPut(STORAGE_KEY, JSON.stringify(this.data));
  }

  /** Per-browser limiter, applied before a body is read. Seconds to wait, or null. */
  requestAllowed(requester: string, now: number): number | null {
    for (const [key, times] of this.requests)
      if (now - times.at(-1)! >= 1000) this.requests.delete(key);
    const key = requester.slice(0, 128);
    const recent = (this.requests.get(key) ?? []).filter((at) => now - at < 1000);
    if (recent.length >= GAME_REQUESTS_PER_SECOND) return 1;
    if (!this.requests.has(key) && this.requests.size >= 512)
      this.requests.delete(this.requests.keys().next().value!);
    recent.push(now);
    this.requests.set(key, recent);
    return null;
  }

  // ---- what viewers see ---------------------------------------------------------------------

  private summary(g: StoredGame): GameSummary {
    const engine = ENGINES[g.kind];
    const awaits: Side[] =
      g.status === "invited"
        ? [1]
        : g.status === "over" || g.state === null
          ? []
          : ([0, 1] as const).filter((side) => engine.game.awaits(g.state, side));
    return {
      id: g.id,
      kind: g.kind,
      players: g.players,
      names: g.names,
      status: g.status,
      rated: g.rated,
      ...(g.result ? { result: g.result } : {}),
      ...(g.winner !== undefined ? { winner: g.winner } : {}),
      awaits,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      since: g.since,
      deadline: g.deadline,
      ...(g.nudgedAt !== undefined && isOpen(g) ? { nudgedAt: g.nudgedAt } : {}),
      turns: g.state === null ? 0 : engine.turns(g.state),
      ...(g.state === null ? {} : { view: engine.game.view(g.state, "spectator") }),
    };
  }

  /** Open games, the latest results and everybody's record (for the office snapshot). */
  state(): GamesState {
    return { games: this.data.games.map((g) => this.summary(g)), stats: this.data.stats };
  }

  private publish(g: StoredGame, now: number, withStats = false): void {
    this.deps.broadcast(
      JSON.stringify(
        envelope(
          "game.updated",
          { game: this.summary(g), ...(withStats ? { stats: this.data.stats } : {}) },
          { ts: now },
        ),
      ),
    );
  }

  private reply(g: StoredGame, me: string | null): GamesReply {
    const side = me === null ? -1 : g.players.indexOf(me);
    const viewer = side === 0 || side === 1 ? side : "spectator";
    return {
      status: 200,
      body: {
        ok: true,
        game: this.summary(g),
        ...(g.state === null ? {} : { view: ENGINES[g.kind].game.view(g.state, viewer) }),
        ...(viewer === "spectator" ? {} : { side: viewer }),
        ...(me === null ? {} : { notices: !this.data.people[me]?.noticesOff }),
      },
    };
  }

  /** `GET /api/games/:id`: the board as the asking browser may see it. */
  get(id: string, me: string | null): GamesReply {
    const g = this.data.games.find((x) => x.id === id);
    return g ? this.reply(g, me) : fail(404, "no such game");
  }

  /** `GET /api/games/me`: my settings. */
  settings(me: string): GamesReply {
    return { status: 200, body: { ok: true, notices: !this.data.people[me]?.noticesOff } };
  }

  // ---- what players do ----------------------------------------------------------------------

  handle(me: string, raw: unknown, now: number): GamesReply {
    const parsed = GameRequest.safeParse(raw);
    if (!parsed.success) return fail(400, "invalid game request");
    const req = parsed.data;
    this.expire(now);
    if (req.action === "notices") {
      const person = this.person(me);
      if (req.on) delete person.noticesOff;
      else {
        person.noticesOff = true;
        for (const g of this.data.games) {
          const side = g.players.indexOf(me);
          if (side >= 0) g.notices[side as Side] = null;
        }
      }
      this.persist();
      return this.settings(me);
    }
    if (req.action === "challenge") return this.challenge(me, req, now);

    const g = this.data.games.find((x) => x.id === req.id);
    if (!g) return fail(404, "no such game");
    const side = g.players.indexOf(me);
    if (side !== 0 && side !== 1) return fail(403, "not your game");
    const other = otherSide(side);
    const label = GAME_LABEL[g.kind];
    const name = g.names[side];

    // whoever acts on a game has seen it: nothing about it needs to pop up on their Mac
    const hadNotice = g.notices[side] !== null;
    g.notices[side] = null;
    if (req.action === "seen") {
      if (hadNotice) this.persist();
      return this.reply(g, me);
    }
    if (g.status === "over") return fail(409, "the game is over");
    const engine = ENGINES[g.kind];

    switch (req.action) {
      case "accept": {
        if (g.status !== "invited" || side !== 1) return fail(409, "nothing to accept");
        g.state = engine.game.setup({ first: this.firstMover(g) });
        g.status = engine.game.phase(g.state) === "setup" ? "setup" : "playing";
        this.waitFrom(g, now);
        if (engine.game.awaits(g.state, 0))
          this.notice(
            g,
            0,
            now,
            `${name} accepted: ${g.status === "setup" ? "place your fleet" : "your move"} (${label})`,
          );
        break;
      }
      case "decline":
        if (g.status !== "invited" || side !== 1) return fail(409, "nothing to decline");
        this.finish(g, "declined", undefined, now);
        break;
      case "cancel":
        if (g.status !== "invited" || side !== 0) return fail(409, "only an open invite");
        this.finish(g, "cancelled", undefined, now);
        break;
      case "move": {
        if (g.status === "invited") return fail(409, "the invite is not accepted yet");
        const move = engine.move.safeParse(req.move);
        if (!move.success) return fail(400, "invalid move");
        const r = engine.game.apply(g.state, side, move.data);
        if (!r.ok) return fail(409, r.error);
        g.state = r.state;
        const outcome = engine.game.outcome(g.state);
        const said = this.describe(g, side, r.events as (BattleshipEvent | FourEvent)[]);
        if (outcome) {
          const winner = "winner" in outcome ? outcome.winner : undefined;
          this.finish(g, winner === undefined ? "draw" : "won", winner, now);
          this.notice(
            g,
            other,
            now,
            winner === undefined
              ? `${said}. A draw (${label})`
              : `${said}. ${g.names[winner]} wins (${label})`,
          );
        } else {
          g.status = engine.game.phase(g.state) === "setup" ? "setup" : "playing";
          this.waitFrom(g, now);
          // only when it is the other side's turn now, not while they still place their fleet
          if (g.status === "playing" && engine.game.awaits(g.state, other))
            this.notice(g, other, now, `${said}. Your turn (${label})`);
        }
        break;
      }
      case "resign":
        this.finish(g, "resigned", other, now);
        this.notice(g, other, now, `${name} gave up: you win (${label})`);
        break;
      case "nudge": {
        if (g.status === "invited" || !engine.game.awaits(g.state, other))
          return fail(409, "it is not their turn");
        if (now < addWeekdayMs(g.since, GAME_NUDGE_AFTER_MS, this.deps.timezone))
          return fail(409, "give them a few hours first");
        if (g.nudgedAt !== undefined && now - g.nudgedAt < GAME_NUDGE_EVERY_MS)
          return fail(409, "you already asked today");
        g.nudgedAt = now;
        g.updatedAt = now;
        // asked for by a person: no "maybe they are looking at the office" delay
        g.notices[other] = { at: now, text: `${name} is waiting for your move (${label})` };
        break;
      }
      case "claim":
      case "call-off": {
        if (g.status === "invited" || engine.game.awaits(g.state, side))
          return fail(409, "it is your move");
        if (g.deadline === null || now < g.deadline)
          return fail(409, "they still have time for their move");
        if (req.action === "claim") {
          this.finish(g, "claimed", side, now);
          this.notice(g, other, now, `${name} took the win after waiting (${label})`);
        } else {
          this.finish(g, "void", undefined, now);
          this.notice(g, other, now, `${name} called off your game (${label})`);
        }
        break;
      }
    }
    this.persist();
    this.publish(g, now, !isOpen(g));
    this.deliver(now);
    return this.reply(g, me);
  }

  private challenge(
    me: string,
    req: Extract<GameRequest, { action: "challenge" }>,
    now: number,
  ): GamesReply {
    const people = this.deps.people();
    const myName = people.get(me);
    const theirName = people.get(req.opponentId);
    if (myName === undefined) return fail(409, "you are not in the office right now");
    if (req.opponentId === me) return fail(400, "pick somebody else");
    if (theirName === undefined) return fail(404, "they are not in the office");
    const label = GAME_LABEL[req.kind];
    const openOf = (id: string) =>
      this.data.games.filter((g) => isOpen(g) && g.players.includes(id)).length;
    if (
      this.data.games.some(
        (g) =>
          isOpen(g) &&
          g.kind === req.kind &&
          g.players.includes(me) &&
          g.players.includes(req.opponentId),
      )
    )
      return fail(409, `You already play ${label} with ${theirName}.`);
    if (openOf(me) >= GAMES_OPEN_MAX)
      return fail(409, `You have ${GAMES_OPEN_MAX} open games. Finish one first.`);
    if (openOf(req.opponentId) >= GAMES_OPEN_MAX)
      return fail(409, `${theirName} already has ${GAMES_OPEN_MAX} open games.`);
    const g: StoredGame = {
      id: ulid(now),
      kind: req.kind,
      players: [me, req.opponentId],
      names: [myName, theirName],
      status: "invited",
      rated: req.rated === true,
      state: null,
      createdAt: now,
      updatedAt: now,
      since: now,
      deadline: addWeekdayMs(now, GAME_DEADLINE_MS, this.deps.timezone),
      notices: [null, null],
    };
    this.data.games.push(g);
    this.notice(g, 1, now, `${myName} challenges you to ${label}${g.rated ? " (rated)" : ""}`);
    this.persist();
    this.publish(g, now);
    return this.reply(g, me);
  }

  /** The loser of their last game of this kind starts; otherwise the challenged person. */
  private firstMover(g: StoredGame): Side {
    const last = this.data.games
      .filter(
        (x) =>
          x.id !== g.id &&
          x.kind === g.kind &&
          x.winner !== undefined &&
          x.players.includes(g.players[0]) &&
          x.players.includes(g.players[1]),
      )
      .at(-1);
    if (!last || last.winner === undefined) return 1;
    return g.players.indexOf(last.players[otherSide(last.winner)]) as Side;
  }

  /** "Anna: 3 shots, 2 hits, sank a ship" / "Anna dropped in column 4". */
  private describe(g: StoredGame, side: Side, events: (BattleshipEvent | FourEvent)[]): string {
    const name = g.names[side];
    for (const e of events) {
      if (e.type === "salvo") {
        const hits = e.shots.filter((s) => s.hit).length;
        return `${name}: ${plural(e.shots.length, "shot")}, ${
          hits === 0 ? "all water" : plural(hits, "hit")
        }${e.sunk.length ? `, sank ${e.sunk.length === 1 ? "a ship" : `${e.sunk.length} ships`}` : ""}`;
      }
      if (e.type === "drop") return `${name} dropped in column ${e.col + 1}`;
      if (e.type === "placed") return `${name} placed the fleet`;
    }
    return `${name} moved`;
  }

  /** A new wait starts: the clock, the deadline and the "is waiting" mark begin again. */
  private waitFrom(g: StoredGame, now: number): void {
    g.updatedAt = now;
    g.since = now;
    g.deadline = addWeekdayMs(now, GAME_DEADLINE_MS, this.deps.timezone);
    delete g.nudgedAt;
  }

  private notice(g: StoredGame, side: Side, now: number, text: string): void {
    if (this.data.people[g.players[side]]?.noticesOff) return;
    g.notices[side] = { at: now + GAME_NOTICE_DELAY_MS, text: text.slice(0, 200) };
  }

  private finish(g: StoredGame, result: GameResult, winner: Side | undefined, now: number): void {
    g.status = "over";
    g.result = result;
    if (winner !== undefined) g.winner = winner;
    g.updatedAt = now;
    g.since = now;
    g.deadline = null;
    g.notices = [null, null];
    if (result === "won" || result === "resigned" || result === "claimed" || result === "draw") {
      const statsOf = (id: string): GameStats => {
        let st = this.data.stats[id];
        if (!st) {
          st = { wins: 0, losses: 0, draws: 0, rating: GAME_RATING_START, ratedGames: 0 };
          this.data.stats[id] = st;
        }
        return st;
      };
      const stats: [GameStats, GameStats] = [statsOf(g.players[0]), statsOf(g.players[1])];
      const score = winner === undefined ? 0.5 : winner === 0 ? 1 : 0;
      if (winner === undefined) for (const s of stats) s.draws++;
      else {
        stats[winner].wins++;
        stats[otherSide(winner)].losses++;
      }
      if (g.rated) {
        const expected = 1 / (1 + 10 ** ((stats[1].rating - stats[0].rating) / 400));
        const delta = GAME_RATING_K * (score - expected);
        stats[0].rating = Math.round((stats[0].rating + delta) * 10) / 10;
        stats[1].rating = Math.round((stats[1].rating - delta) * 10) / 10;
        for (const s of stats) s.ratedGames++;
      }
    }
    // keep the latest results only
    const over = this.data.games.filter((x) => !isOpen(x));
    if (over.length > GAME_RESULTS_KEPT) {
      const drop = new Set(
        over
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .slice(0, over.length - GAME_RESULTS_KEPT)
          .map((x) => x.id),
      );
      this.data.games = this.data.games.filter((x) => !drop.has(x.id));
    }
  }

  // ---- time ---------------------------------------------------------------------------------

  /** Invites that ran out and games nobody touched end by themselves. True if any did. */
  private expire(now: number): boolean {
    let changed = false;
    for (const g of [...this.data.games]) {
      if (!isOpen(g)) continue;
      if (g.status === "invited" && g.deadline !== null && now >= g.deadline)
        this.finish(g, "expired", undefined, now);
      else if (now - g.updatedAt >= GAME_STALE_MS) this.finish(g, "void", undefined, now);
      else continue;
      changed = true;
      this.publish(g, now);
    }
    if (changed) this.persist();
    return changed;
  }

  /** Send the notifications that are due: one per person, several games bundled. */
  private deliver(now: number): void {
    const due = new Map<string, { g: StoredGame; side: Side; n: Notice }[]>();
    for (const g of this.data.games)
      for (const side of [0, 1] as const) {
        const n = g.notices[side];
        if (!n || n.at > now) continue;
        const list = due.get(g.players[side]) ?? [];
        list.push({ g, side, n });
        due.set(g.players[side], list);
      }
    let changed = false;
    for (const [personId, list] of due) {
      const person = this.person(personId);
      if (person.noticedAt !== undefined && now - person.noticedAt < GAME_NOTICE_EVERY_MS) continue;
      if (this.deps.codePending(personId, now)) {
        for (const { n } of list) n.at = now + GAME_NOTICE_RETRY_MS;
        changed = true;
        continue;
      }
      const text = list.length === 1 ? list[0]!.n.text : `${list.length} games are waiting for you`;
      // no queue: without a Mac to show it, the page's badge is what tells them
      if (this.deps.notify(personId, text) > 0) person.noticedAt = now;
      for (const { g, side } of list) g.notices[side] = null;
      changed = true;
    }
    if (changed) this.persist();
  }

  /** Called at `nextDeadline()` (and it is harmless to call it more often). */
  tick(now: number): void {
    this.expire(now);
    this.deliver(now);
  }

  /** When `tick` has something to do next; null = nothing pending. */
  nextDeadline(): number | null {
    let min = Number.POSITIVE_INFINITY;
    for (const g of this.data.games) {
      if (isOpen(g)) {
        if (g.status === "invited" && g.deadline !== null) min = Math.min(min, g.deadline);
        min = Math.min(min, g.updatedAt + GAME_STALE_MS);
      }
      for (const side of [0, 1] as const) {
        const n = g.notices[side];
        if (!n) continue;
        const noticedAt = this.data.people[g.players[side]]?.noticedAt;
        min = Math.min(
          min,
          Math.max(n.at, noticedAt === undefined ? 0 : noticedAt + GAME_NOTICE_EVERY_MS),
        );
      }
    }
    return Number.isFinite(min) ? min : null;
  }

  /** When a game notification last went to that person's Mac (0 = never). */
  noticedAt(personId: string): number {
    return this.data.people[personId]?.noticedAt ?? 0;
  }
}
