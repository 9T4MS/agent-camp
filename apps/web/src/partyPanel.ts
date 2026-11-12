/** Shared games use the office login and existing viewer socket; no background requests. */
import { type PartyAction, type PartyMutation, ViewerPartyState } from "@agent-office/protocol";
import { loginIfLoggedOut } from "./net/viewer.ts";
import type { OfficeModel } from "./state/officeModel.ts";
import "./ui/party.css";

const button = (label: string, action: () => void) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pixel-btn";
  b.textContent = label;
  b.onclick = action;
  return b;
};

export class PartyPanel {
  onOpen: () => void = () => {};
  close(): void {
    this.drawer.hidden = true;
  }
  /** who moves are sent as: `me` while they are in the office, otherwise nobody */
  private person = "";
  private me: string | null = null;
  private busy = false;
  private until = 0;
  private rosterKey = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly drawer = document.createElement("section");
  private readonly player = document.createElement("p");
  private readonly confirm: HTMLButtonElement;
  private readonly target = document.createElement("select");
  private readonly equipment = document.createElement("p");
  private readonly notice = document.createElement("p");
  private readonly board = document.createElement("ol");
  private readonly feed = document.createElement("p");
  private readonly controls: HTMLButtonElement[] = [];

  constructor(
    host: HTMLElement,
    private model: OfficeModel,
    private options: {
      demo: boolean;
      key: string | null;
      focus: (id: string) => void;
      /** a spectator wants to play: ask who they are (the Me menu), then come back */
      claim: (then: () => void) => void;
      /** the turn-based games' lists (my games, live games, results) */
      games?: HTMLElement;
      onDemo: (mutation: PartyMutation) => void;
    },
  ) {
    const open = () => {
      this.onOpen();
      this.drawer.hidden = false;
      this.refresh();
      if (this.person) this.options.focus(this.person);
      this.drawer.focus();
    };
    const launch = button("✦ Office games", open);
    launch.classList.add("party-launch");
    this.drawer.className = "party-panel pixel-box";
    this.drawer.hidden = true;
    this.drawer.tabIndex = -1;
    this.drawer.setAttribute("aria-label", "Office games");
    const close = () => {
      this.drawer.hidden = true;
      launch.focus();
    };
    this.drawer.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.drawer.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close();
    });
    const header = document.createElement("header");
    const title = document.createElement("h2");
    title.textContent = "OFFICE GAMES";
    header.append(title, button("Close", close));
    const intro = document.createElement("p");
    intro.textContent = options.demo
      ? "LOCAL DEMO · scores stay in this tab"
      : "Send a move to everyone watching.";
    this.player.id = "party-person";
    this.player.className = "party-player";
    // moves are yours: a spectator confirms who they are first (the Me menu, top right)
    this.confirm = button("Who are you? Confirm to play", () => {
      this.drawer.hidden = true;
      this.options.claim(open);
    });
    this.confirm.classList.add("party-confirm");
    this.target.id = "party-target";
    this.target.onchange = () => this.updateButtons();
    this.equipment.className = "party-equipment";
    const moves = document.createElement("div");
    moves.className = "party-actions";
    const actions: [PartyAction, string, "left" | "right" | undefined][] = [
      ["use", "Use left item", "left"],
      ["use", "Use right item", "right"],
      ["dance", "Dance", undefined],
      ["wave", "Wave", undefined],
      ["high-five", "High-five", undefined],
      ["tag", "Play tag", undefined],
      ["race", "Roll & race", undefined],
    ];
    for (const [action, label, hand] of actions) {
      const b = button(
        label,
        () =>
          void this.send({
            personId: this.person,
            action,
            ...(hand ? { hand } : {}),
            ...((action === "tag" || action === "high-five") && this.target.value
              ? { targetId: this.target.value }
              : {}),
          }),
      );
      b.dataset.action = action;
      if (hand) b.dataset.hand = hand;
      this.controls.push(b);
      moves.append(b);
    }
    const rules = document.createElement("p");
    rules.className = "party-rules";
    rules.textContent =
      "Choose items and a ride in Customize look (your portrait, top right). Tag earns you +1; high-fives give both buddies +1. A vehicle race rolls a server dice for 1–6 points.";
    this.notice.className = "party-notice";
    this.notice.setAttribute("role", "status");
    this.notice.setAttribute("aria-live", "polite");
    const scores = document.createElement("h3");
    scores.textContent = "PARTY POINTS";
    this.board.className = "party-board";
    this.feed.className = "party-feed";
    this.drawer.append(
      header,
      intro,
      this.player,
      this.confirm,
      ...(options.games ? [options.games] : []),
      this.equipment,
      this.field("Buddy", this.target),
      moves,
      rules,
      this.notice,
      scores,
      this.board,
      this.feed,
    );
    host.append(launch, this.drawer);
    this.refresh();
  }

  private field(text: string, control: HTMLElement) {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = text;
    label.append(span, control);
    return label;
  }

  private refreshTargets() {
    const selected = this.target.value;
    this.target.replaceChildren(new Option("Choose a buddy", ""));
    for (const p of this.model.people.values())
      if (p.personId !== this.person && this.online(p.personId))
        this.target.add(new Option(p.name, p.personId));
    if ([...this.target.options].some((o) => o.value === selected)) this.target.value = selected;
  }

  private online(id: string) {
    return this.model.sessionsOf(id).some((s) => !s.offline);
  }

  /** The person this browser is confirmed to be (the Me chip); null = a spectator. */
  setMe(me: string | null) {
    if (me === this.me) return;
    this.me = me;
    this.rosterKey = "";
    this.refresh();
  }

  /** Called by office events. No polling, timers or API reads are needed. */
  refresh() {
    const people = [...this.model.people.values()].filter((p) => this.online(p.personId));
    const roster = `${this.me}>${people.map((p) => `${p.personId}:${p.name}`).join("|")}`;
    if (roster !== this.rosterKey) {
      this.rosterKey = roster;
      // you play as yourself, and only while your Mac is in the office (the server checks)
      this.person = people.some((p) => p.personId === this.me) ? (this.me ?? "") : "";
      const name = this.me ? this.model.people.get(this.me)?.name : undefined;
      this.player.textContent = this.person
        ? `Playing as ${name}`
        : this.me
          ? `${name ?? "You"}: your Mac is not in the office right now.`
          : "You are watching.";
      this.confirm.hidden = !!this.me;
      this.refreshTargets();
    }
    const avatar = this.model.people.get(this.person)?.avatar;
    this.equipment.hidden = !avatar;
    this.equipment.textContent = avatar
      ? `Left: ${avatar.leftHand} · Right: ${avatar.rightHand} · Ride: ${avatar.vehicle}`
      : "";
    this.board.replaceChildren();
    const leaders = Object.entries(this.model.party.scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    for (const [id, score] of leaders) {
      const row = document.createElement("li");
      row.textContent = `${this.model.people.get(id)?.name ?? id} · ${score} pts`;
      this.board.append(row);
    }
    if (!leaders.length) {
      const row = document.createElement("li");
      row.textContent = "Start playing to earn party points.";
      this.board.append(row);
    }
    const e = this.model.party.events.at(-1);
    this.feed.textContent = e
      ? `${this.model.people.get(e.personId)?.name ?? e.personId} · ${e.action}${e.roll ? ` · rolled ${e.roll}` : ""}`
      : "";
    this.updateButtons();
  }

  private updateButtons() {
    this.target.disabled = this.busy;
    const avatar = this.model.people.get(this.person)?.avatar;
    for (const b of this.controls) {
      const action = b.dataset.action;
      const hand = b.dataset.hand;
      b.disabled =
        this.busy ||
        !this.person ||
        (!!action && Date.now() < this.until) ||
        (action === "race" && (!avatar || avatar.vehicle === "none")) ||
        (action === "use" &&
          (!avatar || (hand === "left" ? avatar.leftHand : avatar.rightHand) === "none")) ||
        ((action === "tag" || action === "high-five") && !this.target.value);
    }
  }

  private async send(mutation: PartyMutation) {
    if (this.busy || Date.now() < this.until) return;
    this.busy = true;
    this.notice.textContent = "Sending…";
    this.updateButtons();
    try {
      if (this.options.demo) this.options.onDemo(mutation);
      else {
        const q = this.options.key ? `?key=${encodeURIComponent(this.options.key)}` : "";
        const r = await fetch(`/api/party${q}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mutation),
        });
        if (r.status === 401) void loginIfLoggedOut();
        const data: unknown = await r.json();
        if (!r.ok) {
          if (r.status === 429)
            this.until = Date.now() + Math.max(1, Number(r.headers.get("retry-after")) || 2) * 1000;
          const message =
            data && typeof data === "object" && "error" in data
              ? String(data.error)
              : "Could not send the move.";
          throw new Error(message);
        }
        // State arrives over the existing socket. Validate the HTTP acknowledgement only,
        // so a delayed response cannot overwrite a newer socket state.
        ViewerPartyState.parse(data);
      }
      this.notice.textContent = "Party move sent!";
      this.until = Date.now() + 1500;
    } catch (err) {
      this.notice.textContent = err instanceof Error ? err.message : "Could not reach the office.";
    } finally {
      this.busy = false;
      this.updateButtons();
      clearTimeout(this.timer);
      this.timer = setTimeout(
        () => this.updateButtons(),
        Math.max(0, this.until - Date.now()) + 20,
      );
    }
  }
}
