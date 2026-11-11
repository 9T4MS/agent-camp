/** Shared games use the office login and existing viewer socket; no background requests. */
import { type PartyAction, type PartyMutation, ViewerPartyState } from "@agent-office/protocol";
import { loginIfLoggedOut } from "./net/viewer.ts";
import type { OfficeModel } from "./state/officeModel.ts";
import "./ui/party.css";

const STORAGE_KEY = "agent-office.party.person";
const button = (label: string, action: () => void) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pixel-btn";
  b.textContent = label;
  b.onclick = action;
  return b;
};

export class PartyPanel {
  private person = "";
  private busy = false;
  private until = 0;
  private rosterKey = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly drawer = document.createElement("section");
  private readonly player = document.createElement("select");
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
      customize: (id: string) => void;
      onDemo: (mutation: PartyMutation) => void;
    },
  ) {
    try {
      this.person = localStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
      /* optional */
    }
    const launch = button("✦ Office games", () => {
      this.drawer.hidden = false;
      this.refresh();
      this.options.focus(this.person);
      this.drawer.focus();
    });
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
      : "Pick a player and send a move to everyone watching.";
    this.player.id = "party-person";
    this.player.onchange = () => {
      this.person = this.player.value;
      try {
        localStorage.setItem(STORAGE_KEY, this.person);
      } catch {
        /* optional */
      }
      this.refreshTargets();
      this.refresh();
      this.options.focus(this.person);
    };
    this.target.id = "party-target";
    this.target.onchange = () => this.updateButtons();
    const customize = button("Customize look", () => {
      this.drawer.hidden = true;
      this.options.customize(this.person);
    });
    this.controls.push(customize);
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
      "Choose items and a ride in Customize look. Tag earns you +1; high-fives give both buddies +1. A vehicle race rolls a server dice for 1–6 points. This office uses shared team access: pick your own character.";
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
      this.field("Playing as", this.player),
      this.equipment,
      customize,
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

  /** Called by office events. No polling, timers or API reads are needed. */
  refresh() {
    const people = [...this.model.people.values()].filter((p) => this.online(p.personId));
    const roster = people.map((p) => `${p.personId}:${p.name}`).join("|");
    if (roster !== this.rosterKey) {
      this.rosterKey = roster;
      this.player.replaceChildren();
      for (const p of people) this.player.add(new Option(p.name, p.personId));
      if (!people.some((p) => p.personId === this.person)) this.person = people[0]?.personId ?? "";
      this.player.value = this.person;
      this.refreshTargets();
    }
    const avatar = this.model.people.get(this.person)?.avatar;
    this.equipment.textContent = avatar
      ? `Left: ${avatar.leftHand} · Right: ${avatar.rightHand} · Ride: ${avatar.vehicle}`
      : "Waiting for someone to join the office.";
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
    this.player.disabled = this.busy;
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
