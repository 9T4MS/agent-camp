/**
 * Turn-based games in the page: the lists in the games drawer, the challenge box on a
 * nameplate and the board window. State comes over the viewer socket (`model.games`); a
 * player's own Battleship fleet comes from the server's answer to that player only.
 */
import {
  type BattleshipShip,
  type BattleshipView,
  battleshipAutoPlace,
  battleshipFleetError,
  battleshipShipCells,
  type FourView,
  type GameKind,
  type GameRequest,
  type GameSummary,
  otherSide,
  type Side,
} from "@agent-office/protocol";
import type { GameReply, GamesClient } from "../net/games.ts";
import {
  battleshipNews,
  deadlineText,
  fourNews,
  GAME_NAME,
  gameLine,
  ladder,
  lastSalvoSize,
  myGames,
  recordLine,
  resultLine,
  sideOf,
  waitsForMe,
} from "../state/gameText.ts";
import type { ModelChange, OfficeModel, PersonState } from "../state/officeModel.ts";
import {
  buildFour,
  buildGrid,
  fleetCells,
  moveShip,
  rotateShip,
  shipName,
  targetCells,
} from "./gameBoard.ts";
import "./games.css";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const button = (label: string, key: string, action: () => void, cls = "pixel-btn") => {
  const b = el("button", cls, label);
  b.type = "button";
  b.dataset.key = key;
  b.addEventListener("click", action);
  return b;
};

/** A row for the Me menu: something that waits for me. */
export type WaitingGame = { id: string; title: string; line: string; invite: boolean };

type Board = {
  id: string;
  root: HTMLElement;
  opener: HTMLElement | null;
  /** cells picked for the salvo */
  picked: Set<number>;
  /** Four in a Row on touch: the column tapped once, and at which turn */
  armed: { col: number; turns: number } | null;
  /** phones show one Battleship grid at a time */
  tab: "target" | "fleet";
  /** the fleet being placed, and the ship that moves next */
  placing: { ships: BattleshipShip[]; selected: number } | null;
  confirmResign: boolean;
  error: string;
  /** what the status line was last built from */
  seen: BattleshipView | FourView | null;
  news: string;
  busy: boolean;
};

export class GamesUi {
  /** "My games", "Live games", results and records: goes into the games drawer */
  readonly list = el("section", "games-list");
  private me: string | null = null;
  /** my own view of my Battleship games (with my fleet), by game id */
  private mine = new Map<string, BattleshipView>();
  private board: Board | null = null;
  private notice = "";
  /** what I already told the server I saw: game id -> its `updatedAt` */
  private told = new Map<string, number>();
  private challengeBoxes = new Map<string, { root: HTMLElement; update: () => void }>();
  /** the Me chip and menu show what waits for me */
  onWaitingChange: () => void = () => {};

  constructor(
    private host: HTMLElement,
    private model: OfficeModel,
    private client: GamesClient,
    private opts: {
      /** a spectator wants to play: ask who they are, then go on */
      claim: (why: string, after: () => void) => void;
      banner: (title: string, sub: string) => void;
      /** the drawer should make room (the board is fullscreen) */
      onBoard: (open: boolean) => void;
    },
  ) {
    this.list.setAttribute("aria-label", "Turn-based games");
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.sawAll();
    });
    this.refresh();
  }

  get boardOpen(): boolean {
    return this.board !== null;
  }

  /** The person this browser is confirmed to be; null = a spectator. */
  setMe(me: string | null): void {
    if (me === this.me) return;
    this.me = me;
    this.mine.clear();
    this.told.clear();
    this.challengeBoxes.clear();
    if (this.board) this.loadBoard();
    this.refresh();
    this.sawAll();
    this.onWaitingChange();
  }

  private game(id: string): GameSummary | undefined {
    return this.model.games.find((g) => g.id === id);
  }

  /** What waits for me, for the Me chip's badge and menu. */
  waiting(): WaitingGame[] {
    return myGames(this.model.games, this.me)
      .filter((g) => waitsForMe(g, this.me))
      .map((g) => ({
        id: g.id,
        title: `${GAME_NAME[g.kind]} · ${g.names[otherSide(sideOf(g, this.me)!)]}`,
        line: gameLine(g, this.me),
        invite: g.status === "invited",
      }));
  }

  /** The first game that waits for me (`?game=next`); false when there is none. */
  openNext(): boolean {
    const next = this.waiting()[0];
    if (next) this.open(next.id);
    return !!next;
  }

  // ---- changes from the office ----------------------------------------------------------

  /** A game changed (viewer socket). */
  onChange(change: Extract<ModelChange, { kind: "gameChanged" }>): void {
    const { game, before } = change;
    const mine = sideOf(game, this.me) !== null;
    const waits = waitsForMe(game, this.me);
    const visible = document.visibilityState === "visible";
    const open = this.board?.id === game.id;
    if (mine && waits && visible) {
      // I am looking at the office: nothing has to pop up on my Mac for this
      this.saw(game);
      if (!open && !(before && waitsForMe(before, this.me)))
        this.opts.banner(
          game.status === "invited" ? "A challenge!" : "Your turn",
          `${gameLine(game, this.me)} · ${GAME_NAME[game.kind]}`,
        );
    } else if (open && mine && game.kind === "battleship") this.loadBoard();
    if (game.status === "over" && before && before.status !== "over" && game.winner !== undefined)
      this.opts.banner(
        `${game.names[game.winner]} wins!`,
        `${resultLine(game)} · ${GAME_NAME[game.kind]}`,
      );
    if (open) this.renderBoard();
    this.refresh();
    this.onWaitingChange();
  }

  /** The games arrived again (snapshot after a reconnect). */
  onSnapshot(): void {
    if (this.board) this.loadBoard();
    this.refresh();
    this.sawAll();
    this.onWaitingChange();
  }

  /** I came back to the tab: whatever waited for me is seen now. */
  private sawAll(): void {
    if (document.visibilityState !== "visible") return;
    for (const g of this.model.games) if (waitsForMe(g, this.me)) this.saw(g);
  }

  /** Tell the server once per change that I saw it (nothing has to pop up on my Mac). */
  private saw(game: GameSummary): void {
    if (this.told.get(game.id) === game.updatedAt) return;
    this.told.set(game.id, game.updatedAt);
    void this.client.post({ action: "seen", id: game.id }).then((r) => this.took(game.id, r));
  }

  /** Keep what an answer says about my own view of a game. */
  private took(id: string, r: GameReply): void {
    if (!r.ok || r.res.side === undefined) return;
    const view = r.res.view as BattleshipView | undefined;
    if (view?.kind !== "battleship") return;
    this.mine.set(id, view);
    if (this.board?.id === id) this.renderBoard();
  }

  private loadBoard(): void {
    const id = this.board?.id;
    if (!id) return;
    void this.client.get(id).then((r) => this.took(id, r));
  }

  // ---- doing things ---------------------------------------------------------------------

  private async act(req: GameRequest, where: "board" | "list" = "board"): Promise<boolean> {
    if (this.board) {
      this.board.busy = true;
      this.board.error = "";
    }
    const r = await this.client.post(req);
    if (this.board) this.board.busy = false;
    if (!r.ok) {
      if (where === "board" && this.board) this.board.error = r.error;
      else this.notice = r.error;
    } else {
      this.notice = "";
      if ("id" in req) this.took(req.id, r);
    }
    if (this.board) this.renderBoard();
    this.refresh();
    return r.ok;
  }

  /** Challenge somebody; a spectator is asked who they are first. */
  challenge(opponentId: string, kind: GameKind, rated: boolean): void {
    if (!this.me) {
      const name = this.model.people.get(opponentId)?.name ?? "them";
      this.opts.claim(`Confirm it's you to challenge ${name}.`, () =>
        this.challenge(opponentId, kind, rated),
      );
      return;
    }
    void this.client.post({ action: "challenge", opponentId, kind, rated }).then((r) => {
      if (r.ok && r.res.game) this.open(r.res.game.id);
      else if (!r.ok) {
        this.notice = r.error;
        this.challengeBoxes.get(opponentId)?.update();
        this.refresh();
      }
    });
  }

  answer(id: string, accept: boolean): void {
    void this.act({ action: accept ? "accept" : "decline", id }, "list").then((ok) => {
      if (ok && accept) this.open(id);
    });
  }

  // ---- the lists in the drawer ----------------------------------------------------------

  /** Re-render the lists (call after model changes). */
  refresh(): void {
    const focused = (document.activeElement as HTMLElement | null)?.dataset.key;
    const had = this.list.contains(document.activeElement);
    this.list.replaceChildren();
    const games = this.model.games;
    const mine = myGames(games, this.me);
    const head = (text: string) => this.list.append(el("h3", undefined, text));
    if (this.me) {
      head("MY GAMES");
      if (mine.length === 0)
        this.list.append(
          el("p", "games-empty", "No games yet. Click a colleague's nameplate and challenge them."),
        );
      for (const g of mine) this.list.append(this.row(g, true));
    }
    const live = games.filter((g) => g.status !== "over" && sideOf(g, this.me) === null);
    if (live.length) {
      head("LIVE GAMES");
      for (const g of live) this.list.append(this.row(g, false));
    }
    const done = games
      .filter((g) => g.status === "over" && (g.winner !== undefined || g.result === "draw"))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5);
    if (done.length) {
      head("RESULTS");
      for (const g of done) this.list.append(this.row(g, false));
    }
    const top = ladder(this.model.gameStats, this.me);
    if (top.length) {
      head("RECORDS");
      const ol = el("ol", "games-ladder");
      for (const r of top) {
        const li = el("li", r.personId === this.me ? "me" : undefined);
        li.value = r.place;
        li.textContent = `${this.model.people.get(r.personId)?.name ?? r.personId} · ${recordLine(r.stats)}`;
        ol.append(li);
      }
      this.list.append(ol);
    }
    if (this.notice) {
      const p = el("p", "games-notice", this.notice);
      p.setAttribute("role", "alert");
      this.list.append(p);
    }
    if (had && focused)
      this.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }

  private row(g: GameSummary, mine: boolean): HTMLElement {
    const row = el("div", `game-row${waitsForMe(g, this.me) ? " waits" : ""}`);
    const side = sideOf(g, this.me);
    const who = side === null ? `${g.names[0]} vs ${g.names[1]}` : g.names[otherSide(side)];
    const open = button("", `open:${g.id}`, () => this.open(g.id), "game-open");
    open.append(
      el("span", "game-title", `${GAME_NAME[g.kind]} · ${who}`),
      el("span", "game-line", gameLine(g, this.me)),
    );
    row.append(open);
    if (mine && g.status === "invited" && side === 1) {
      const answers = el("div", "game-answers");
      answers.append(
        button("Play", `accept:${g.id}`, () => this.answer(g.id, true)),
        button("Not now", `decline:${g.id}`, () => this.answer(g.id, false)),
      );
      row.append(answers);
    }
    return row;
  }

  // ---- the challenge box on a nameplate -------------------------------------------------

  /** "Challenge Tom" for a person's panel; my own panel gets my record instead. */
  challengeBox(person: PersonState): HTMLElement {
    const cached = this.challengeBoxes.get(person.personId);
    if (cached) {
      cached.update();
      return cached.root;
    }
    const root = el("div", "challenge");
    const title = el("div", "challenge-title");
    const buttons = el("div", "challenge-btns");
    const rated = el("input");
    rated.type = "checkbox";
    const ratedLabel = el("label", "challenge-rated");
    ratedLabel.append(rated, " counts for the ratings");
    const why = el("div", "challenge-why");
    const record = el("div", "challenge-record");
    const kinds: GameKind[] = ["battleship", "four-in-a-row"];
    const btns = kinds.map((kind) => {
      const b = button(GAME_NAME[kind], `challenge:${kind}`, () => {
        const running = this.openWith(person.personId, kind);
        if (running) this.open(running.id);
        else this.challenge(person.personId, kind, rated.checked);
      });
      buttons.append(b);
      return b;
    });
    root.append(title, buttons, ratedLabel, why, record);
    root.addEventListener("keydown", (e) => e.stopPropagation());
    const update = () => {
      const self = person.personId === this.me;
      const name = this.model.people.get(person.personId)?.name ?? person.name;
      title.textContent = self ? "Your games" : `Challenge ${name}`;
      buttons.hidden = self;
      ratedLabel.hidden = self || !this.me;
      for (const [i, kind] of kinds.entries()) {
        const running = this.openWith(person.personId, kind);
        btns[i]!.textContent = running ? `${GAME_NAME[kind]}: open` : GAME_NAME[kind];
      }
      const online = this.model.sessionsOf(person.personId).some((s) => !s.offline);
      why.textContent = self
        ? ""
        : this.notice ||
          (!this.me
            ? "You confirm who you are first."
            : online
              ? ""
              : `${name} is away and will see it when back.`);
      record.textContent = recordLine(this.model.gameStats[person.personId]);
    };
    update();
    this.challengeBoxes.set(person.personId, { root, update });
    return root;
  }

  /** My open game of that kind with that person, if there is one. */
  private openWith(personId: string, kind: GameKind): GameSummary | undefined {
    return this.model.games.find(
      (g) =>
        g.status !== "over" &&
        g.kind === kind &&
        sideOf(g, this.me) !== null &&
        g.players.includes(personId),
    );
  }

  // ---- the board window -----------------------------------------------------------------

  open(id: string): void {
    if (!this.game(id)) return;
    const opener = this.board?.opener ?? (document.activeElement as HTMLElement | null);
    this.close(false);
    const root = el("div", "game-modal");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "game-title");
    // nothing of this reaches the office underneath: camera, shortcuts, the panel's Esc
    for (const ev of ["pointerdown", "wheel"] as const)
      root.addEventListener(ev, (e) => e.stopPropagation());
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) this.close();
    });
    root.addEventListener("keydown", (e) => this.onKey(e));
    this.board = {
      id,
      root,
      opener,
      picked: new Set(),
      armed: null,
      tab: "target",
      placing: null,
      confirmResign: false,
      error: "",
      seen: null,
      news: "",
      busy: false,
    };
    this.host.append(root);
    this.opts.onBoard(true);
    this.loadBoard();
    this.renderBoard();
    (
      root.querySelector<HTMLElement>(".cell[tabindex='0'], .four-col") ??
      root.querySelector<HTMLElement>("button")
    )?.focus();
  }

  close(restore = true): void {
    const b = this.board;
    if (!b) return;
    b.root.remove();
    this.board = null;
    this.opts.onBoard(false);
    if (restore && b.opener?.isConnected) b.opener.focus();
  }

  private onKey(e: KeyboardEvent): void {
    const b = this.board;
    if (!b) return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if ((e.key === "r" || e.key === "R") && b.placing && !e.ctrlKey && !e.metaKey) {
      this.rotate();
      return;
    }
    if (e.key !== "Tab") return;
    // the focus stays in the window; a grid counts as one stop
    const stops = [
      ...b.root.querySelectorAll<HTMLElement>(
        'button:not([tabindex="-1"]):not([disabled]), input, [tabindex="0"]',
      ),
    ].filter((x) => x.offsetParent !== null);
    if (stops.length === 0) return;
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? at - 1 : at + 1;
    if (at >= 0 && next >= 0 && next < stops.length) return;
    e.preventDefault();
    stops[next < 0 ? stops.length - 1 : 0]!.focus();
  }

  private rotate(): void {
    const p = this.board?.placing;
    if (!p) return;
    p.ships[p.selected] = rotateShip(p.ships[p.selected]!);
    this.renderBoard();
  }

  private renderBoard(): void {
    const b = this.board;
    if (!b) return;
    const g = this.game(b.id);
    if (!g) {
      this.close();
      return;
    }
    const side = sideOf(g, this.me);
    const focused = (document.activeElement as HTMLElement | null)?.dataset.key;
    const had = b.root.contains(document.activeElement);
    const box = el("div", "game-box pixel-box");
    const head = el("header", "game-head");
    const title = el("h2", undefined, GAME_NAME[g.kind]);
    title.id = "game-title";
    head.append(
      title,
      el("span", "game-vs", `${g.names[0]} vs ${g.names[1]}${g.rated ? " · rated" : ""}`),
      button("×", "close", () => this.close(), "pixel-btn close"),
    );
    head.querySelector(".close")!.setAttribute("aria-label", "Close");
    const status = el("p", "game-status");
    status.setAttribute("role", "status");
    const body = el("div", "game-body");
    const foot = el("footer", "game-foot");
    const error = el("p", "game-error", b.error);
    error.setAttribute("role", "alert");

    let news = gameLine(g, this.me);
    if (g.kind === "battleship") {
      const view =
        (side !== null ? this.mine.get(g.id) : undefined) ?? (g.view as BattleshipView | undefined);
      if (view) {
        news = battleshipNews(b.seen as BattleshipView | null, view, g.names, side);
        this.battleship(b, g, view, side, body);
        b.seen = view;
      }
    } else {
      const view = g.view as FourView | undefined;
      if (view) {
        news = fourNews(b.seen as FourView | null, view, g.names, side);
        body.append(
          buildFour({
            view,
            names: g.names,
            mySide: side,
            ...(side !== null && waitsForMe(g, this.me) && !b.busy
              ? {
                  armed: b.armed?.turns === g.turns ? b.armed.col : null,
                  onArm: (col: number) => {
                    b.armed = { col, turns: g.turns };
                  },
                  onDrop: (col: number) => {
                    b.armed = null;
                    void this.act({ action: "move", id: g.id, move: { type: "drop", col } });
                  },
                }
              : {}),
          }),
        );
        b.seen = view;
      }
    }
    // only the turn-by-turn changes are worth saying again
    if (g.status === "invited" || g.status === "over") news = `${gameLine(g, this.me)}.`;
    if (news.trim()) b.news = news;
    status.textContent = b.news;
    this.actions(b, g, side, foot);

    box.append(head, status, body, error, foot);
    b.root.replaceChildren(box);
    if (had) {
      const again = focused
        ? b.root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)
        : null;
      (
        again ?? b.root.querySelector<HTMLElement>(".cell[tabindex='0'], .four-col, button")
      )?.focus();
    }
  }

  private battleship(
    b: Board,
    g: GameSummary,
    view: BattleshipView,
    side: Side | null,
    body: HTMLElement,
  ): void {
    const lastOf = (target: Side) => {
      const shots = view.waters[target].shots;
      const n = lastSalvoSize(shots.length, view.first === otherSide(target));
      return new Set(shots.slice(shots.length - n).map((s) => s.cell));
    };
    // a spectator sees both waters; "target" is the challenger's then
    const mine: Side = side ?? 0;
    const theirs = otherSide(mine);
    const myWaters = view.waters[mine];
    const placing = side !== null && view.phase === "setup" && !myWaters.placed;
    if (placing && !b.placing)
      b.placing = {
        ships: battleshipAutoPlace(Math.floor(Math.random() * 2 ** 31)),
        selected: 0,
      };
    if (!placing) b.placing = null;

    const pane = (cls: string, heading: string, grid: HTMLElement, extra?: HTMLElement) => {
      const p = el("section", `sea-pane ${cls}`);
      p.append(el("h3", undefined, heading), grid);
      if (extra) p.append(extra);
      return p;
    };

    if (b.placing) {
      const p = b.placing;
      const problem = battleshipFleetError(p.ships);
      const grid = buildGrid({
        id: "fleet",
        label: "Your fleet: pick a ship in the list, then a cell to move it there",
        cells: fleetCells(p.ships, null, p.ships[p.selected]!, new Set()),
        onPick: (cell) => {
          // a cell of another ship selects that ship; any other cell moves the selected one
          const hit = p.ships.findIndex((s) => battleshipShipCells(s).includes(cell));
          if (hit >= 0 && hit !== p.selected) p.selected = hit;
          else p.ships[p.selected] = moveShip(p.ships[p.selected]!, cell);
          this.renderBoard();
        },
      });
      const tools = el("div", "place-tools");
      const ships = el("div", "place-ships");
      ships.setAttribute("role", "radiogroup");
      ships.setAttribute("aria-label", "Ship to move");
      for (const [i, s] of p.ships.entries()) {
        const pick = button(`${"■".repeat(s.length)}`, `ship:${i}`, () => {
          p.selected = i;
          this.renderBoard();
        });
        pick.setAttribute("role", "radio");
        pick.setAttribute("aria-checked", String(i === p.selected));
        pick.setAttribute("aria-label", `Ship ${shipName(s)}`);
        ships.append(pick);
      }
      const say = el("p", problem ? "place-problem" : "place-ok");
      say.textContent = problem
        ? `Can't place like this: ${problem}.`
        : "Ships may not touch, not even at a corner.";
      const ready = button("Ready", "ready", () => {
        void this.act({ action: "move", id: g.id, move: { type: "place", ships: p.ships } });
      });
      ready.disabled = !!problem || b.busy;
      ready.classList.add("primary");
      tools.append(
        ships,
        button("Rotate (R)", "rotate", () => this.rotate()),
        button("Shuffle", "shuffle", () => {
          p.ships = battleshipAutoPlace(Math.floor(Math.random() * 2 ** 31));
          this.renderBoard();
        }),
        say,
        ready,
      );
      body.append(pane("fleet", "Place your fleet", grid, tools));
      body.dataset.tab = "fleet";
      return;
    }

    const myTurn = side !== null && view.phase === "playing" && view.turn === side;
    for (const cell of [...b.picked]) {
      // a cell that became known meanwhile cannot stay picked
      const w = view.waters[theirs];
      if (!myTurn || w.shots.some((s) => s.cell === cell) || w.water.includes(cell))
        b.picked.delete(cell);
    }
    const known = new Set([
      ...view.waters[theirs].shots.map((s) => s.cell),
      ...view.waters[theirs].water,
    ]);
    const target = buildGrid({
      id: "target",
      label:
        side === null
          ? `${g.names[theirs]}'s waters`
          : `Your shots at ${g.names[theirs]}${myTurn ? `: pick ${view.salvo}` : ""}`,
      cells: targetCells(view.waters[theirs], b.picked, lastOf(theirs)),
      ...(myTurn && !b.busy
        ? {
            canPick: (cell: number) => !known.has(cell),
            onPick: (cell: number) => {
              if (b.picked.has(cell)) b.picked.delete(cell);
              else if (b.picked.size < view.salvo) b.picked.add(cell);
              this.renderBoard();
            },
          }
        : {}),
    });
    let salvo: HTMLElement | undefined;
    if (myTurn) {
      salvo = el("div", "salvo");
      const fire = button(`Fire ${view.salvo}`, "fire", () => {
        const cells = [...b.picked];
        b.picked.clear();
        void this.act({ action: "move", id: g.id, move: { type: "fire", cells } });
      });
      fire.classList.add("primary");
      fire.disabled = b.picked.size !== view.salvo || b.busy;
      const clear = button("Clear", "clear", () => {
        b.picked.clear();
        this.renderBoard();
      });
      clear.disabled = b.picked.size === 0;
      salvo.append(
        el("span", "salvo-count", `${b.picked.size} of ${view.salvo} picked`),
        clear,
        fire,
      );
    }
    const fleet = buildGrid({
      id: "fleet",
      label: side === null ? `${g.names[mine]}'s waters` : "Your fleet",
      cells:
        side === null
          ? targetCells(myWaters, new Set(), lastOf(mine))
          : fleetCells(myWaters.ships ?? [], myWaters, null, lastOf(mine)),
    });
    const tabs = el("div", "sea-tabs");
    tabs.setAttribute("role", "tablist");
    for (const [tab, label] of [
      ["target", side === null ? g.names[theirs] : "Target"],
      ["fleet", side === null ? g.names[mine] : "My fleet"],
    ] as const) {
      const t = button(label, `tab:${tab}`, () => {
        b.tab = tab;
        this.renderBoard();
      });
      t.setAttribute("role", "tab");
      t.setAttribute("aria-selected", String(b.tab === tab));
      tabs.append(t);
    }
    body.dataset.tab = b.tab;
    body.append(
      tabs,
      pane(
        "target",
        side === null ? `${g.names[theirs]}'s waters` : `${g.names[theirs]}'s waters`,
        target,
        salvo,
      ),
      pane("fleet", side === null ? `${g.names[mine]}'s waters` : "Your fleet", fleet),
    );
  }

  private actions(b: Board, g: GameSummary, side: Side | null, foot: HTMLElement): void {
    const id = g.id;
    const them = side === null ? "" : g.names[otherSide(side)];
    const say = (text: string) => foot.append(el("span", "game-note", text));
    if (side === null) {
      if (g.status !== "over") say("You are watching.");
      return;
    }
    const mineToAct = g.awaits.includes(side);
    const due = deadlineText(g.deadline, this.model.timezone);
    if (g.status === "invited") {
      if (side === 1)
        foot.append(
          button("Play", "accept", () => void this.act({ action: "accept", id })),
          button("Not now", "decline", () => void this.act({ action: "decline", id })),
        );
      else
        foot.append(
          button("Take the invite back", "cancel", () => void this.act({ action: "cancel", id })),
        );
      if (due) say(`open ${due}`);
      return;
    }
    if (g.status === "over") {
      const kind = g.kind;
      const opponent = g.players[otherSide(side)];
      if (!this.openWith(opponent, kind))
        foot.append(
          button("Rematch", "rematch", () => {
            this.close();
            this.challenge(opponent, kind, g.rated);
          }),
        );
      return;
    }
    const late = g.deadline !== null && Date.now() + this.model.clockSkew >= g.deadline;
    if (!mineToAct) {
      if (late)
        foot.append(
          button("Claim the win", "claim", () => void this.act({ action: "claim", id })),
          button("Call it off", "call-off", () => void this.act({ action: "call-off", id })),
        );
      else
        foot.append(
          button(`Ask ${them} for the move`, "nudge", () => void this.act({ action: "nudge", id })),
        );
      say(
        late
          ? `${them} has not moved in time. You can also keep waiting.`
          : `${them} has time ${due}`,
      );
    } else if (due) say(`You have time ${due}`);
    foot.append(
      b.confirmResign
        ? button(`Really give up? ${them} wins`, "resign", () => {
            b.confirmResign = false;
            void this.act({ action: "resign", id });
          })
        : button("Give up", "resign", () => {
            b.confirmResign = true;
            this.renderBoard();
          }),
    );
  }
}
