/** Wardrobe and shared party controls. Credentials remain in memory for this tab only. */
import {
  DEFAULT_PARTY_LOOK,
  PARTY_COLORS,
  PARTY_HEADWEAR,
  PARTY_ITEMS,
  PARTY_OUTFITS,
  PARTY_VEHICLES,
  PARTY_WRISTS,
  type PartyAction,
  type PartyLook,
  type PartyMutation,
  PartyState,
} from "@agent-office/protocol";
import { partyPortrait } from "./art/party.ts";
import type { OfficeModel } from "./state/officeModel.ts";
import type { PartyWorld } from "./world/party.ts";
import "./ui/party.css";

const STORAGE_KEY = "agent-office.party.person";
const emptyState = (): PartyState => ({ profiles: {}, events: [], scores: {} });
const catalogs = {
  headwear: { label: "Ears & headwear", entries: PARTY_HEADWEAR },
  wrist: { label: "Wristwear", entries: PARTY_WRISTS },
  outfit: { label: "Character", entries: PARTY_OUTFITS },
  color: { label: "Accent color", entries: PARTY_COLORS },
  item: { label: "Hand item", entries: PARTY_ITEMS },
  vehicle: { label: "Ride", entries: PARTY_VEHICLES },
} as const;

function button(text: string, run: () => void, cls = "pixel-btn"): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = text;
  el.className = cls;
  el.onclick = run;
  return el;
}

export class PartyPanel {
  private state = emptyState();
  private draft = { ...DEFAULT_PARTY_LOOK };
  private person = "";
  private busy = false;
  private cooldownUntil = 0;
  private dirty = false;
  private roster = "";
  private readonly drawer = document.createElement("section");
  private readonly personSelect = document.createElement("select");
  private readonly targetSelect = document.createElement("select");
  private readonly password = document.createElement("input");
  private readonly portrait = document.createElement("div");
  private readonly notice = document.createElement("p");
  private readonly board = document.createElement("ol");
  private readonly feed = document.createElement("p");
  private readonly fields: HTMLSelectElement[] = [];
  private readonly actions: HTMLButtonElement[] = [];
  private pollPending = false;
  private mutationVersion = 0;

  constructor(
    host: HTMLElement,
    private model: OfficeModel,
    private world: PartyWorld,
    private options: { demo: boolean; key: string | null; focus: (id: string) => void },
  ) {
    try {
      this.person = localStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
      /* optional */
    }
    const launch = button("✦ Dress up & play", () => this.open(), "pixel-btn party-launch");
    host.append(launch);
    this.drawer.className = "party-panel pixel-box";
    this.drawer.hidden = true;
    this.drawer.setAttribute("aria-label", "Wardrobe and office party");
    this.drawer.setAttribute("tabindex", "-1");
    this.drawer.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.drawer.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        this.close();
        launch.focus();
      }
    });
    const header = document.createElement("header");
    const title = document.createElement("h2");
    title.textContent = "AFTER HOURS";
    header.append(
      title,
      button("Close", () => {
        this.close();
        launch.focus();
      }),
    );
    const intro = document.createElement("p");
    intro.className = "party-intro";
    intro.textContent = "Your look. Your weird little office party.";
    this.drawer.append(header, intro);
    if (options.demo) {
      const badge = document.createElement("p");
      badge.className = "party-demo";
      badge.textContent = "LOCAL DEMO · changes stay in this tab";
      this.drawer.append(badge);
    }
    this.personSelect.id = "party-person";
    this.personSelect.onchange = () => {
      this.world.preview(this.person, null);
      this.person = this.personSelect.value;
      try {
        localStorage.setItem(STORAGE_KEY, this.person);
      } catch {
        /* optional */
      }
      this.loadLook();
      this.options.focus(this.person);
    };
    this.drawer.append(this.field("Playing as", this.personSelect));
    this.portrait.className = "party-portrait";
    this.drawer.append(this.portrait);
    const grid = document.createElement("div");
    grid.className = "party-fields";
    for (const [key, catalog] of Object.entries(catalogs)) {
      const select = document.createElement("select");
      select.id = `party-${key}`;
      for (const entry of catalog.entries) select.add(new Option(entry.label, entry.id));
      select.onchange = () => {
        this.draft = { ...this.draft, [key]: select.value };
        this.dirty = true;
        this.preview();
      };
      this.fields.push(select);
      grid.append(this.field(catalog.label, select));
    }
    this.drawer.append(grid);
    const presets = document.createElement("div");
    presets.className = "party-presets";
    presets.append(
      button("Neon cat", () =>
        this.preset({
          headwear: "cat-ears",
          wrist: "neon-cyan",
          outfit: "cat",
          color: "pink",
          item: "lightsaber",
          vehicle: "hoverboard",
        }),
      ),
      button("Space disco", () =>
        this.preset({
          headwear: "antenna",
          wrist: "rainbow",
          outfit: "astronaut",
          color: "purple",
          item: "disco-ball",
          vehicle: "spaceship",
        }),
      ),
      button("Party pirate", () =>
        this.preset({
          headwear: "party-hat",
          wrist: "neon-lime",
          outfit: "pirate",
          color: "gold",
          item: "confetti",
          vehicle: "car",
        }),
      ),
      button("Randomize", () => {
        const look = { ...DEFAULT_PARTY_LOOK };
        for (const [key, cat] of Object.entries(catalogs)) {
          Object.assign(look, {
            [key]: cat.entries[Math.floor(Math.random() * cat.entries.length)]!.id,
          });
        }
        this.preset(look);
      }),
    );
    this.drawer.append(presets);
    if (!options.demo) {
      this.password.type = "password";
      this.password.id = "party-password";
      this.password.autocomplete = "off";
      this.password.placeholder = "Office connector password";
      const note = document.createElement("small");
      note.textContent =
        "Shared team access, not personal accounts. Password stays in this tab's memory.";
      this.drawer.append(this.field("Team password", this.password), note);
    }
    const save = button(
      "Save outfit",
      () => void this.send({ personId: this.person, look: this.draft }),
    );
    save.classList.add("party-save");
    this.actions.push(save);
    this.drawer.append(save);
    const games = document.createElement("h3");
    games.textContent = "PLAY TOGETHER";
    this.targetSelect.id = "party-target";
    this.drawer.append(games, this.field("Buddy", this.targetSelect));
    const controls = document.createElement("div");
    controls.className = "party-actions";
    const actionList: [PartyAction, string][] = [
      ["use", "Use item"],
      ["dance", "Dance"],
      ["wave", "Wave"],
      ["high-five", "High-five"],
      ["tag", "Play tag"],
      ["race", "Roll & race"],
    ];
    for (const [action, label] of actionList) {
      const b = button(label, () => {
        const targetId =
          action === "tag" || action === "high-five" ? this.targetSelect.value : undefined;
        void this.send({ personId: this.person, action, ...(targetId ? { targetId } : {}) });
      });
      b.dataset.action = action;
      this.actions.push(b);
      controls.append(b);
    }
    const rules = document.createElement("p");
    rules.className = "party-rules";
    rules.textContent =
      "Save before playing. Tag earns you +1; high-fives give both buddies +1. Equip a ride to race: a server dice roll adds 1–6 points. Use your equipped item for effects. Short cooldown between actions.";
    this.notice.className = "party-notice";
    this.notice.setAttribute("role", "status");
    this.notice.setAttribute("aria-live", "polite");
    const boardTitle = document.createElement("h3");
    boardTitle.textContent = "PARTY POINTS";
    this.board.className = "party-board";
    this.feed.className = "party-feed";
    this.drawer.append(controls, rules, this.notice, boardTitle, this.board, this.feed);
    host.append(this.drawer);
    this.rosterChanged();
    if (!options.demo) void this.poll();
    window.setInterval(() => {
      this.rosterChanged();
      this.updateButtons();
      if (!options.demo && document.visibilityState === "visible") void this.poll();
    }, 1500);
  }

  private field(text: string, control: HTMLElement): HTMLLabelElement {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = text;
    label.append(span, control);
    return label;
  }

  private open() {
    this.drawer.hidden = false;
    this.rosterChanged();
    this.loadLook();
    if (this.person) this.options.focus(this.person);
    this.drawer.focus();
  }

  private close() {
    this.drawer.hidden = true;
    this.world.preview(this.person, null);
  }

  private rosterChanged() {
    const people = [...this.model.people.values()];
    const roster = people.map((p) => `${p.personId}:${p.name}`).join("|");
    if (roster === this.roster) return;
    this.roster = roster;
    this.personSelect.replaceChildren();
    for (const p of people) this.personSelect.add(new Option(p.name, p.personId));
    if (!this.model.people.has(this.person)) {
      this.world.preview(this.person, null);
      this.person =
        people.find((p) => p.personId === "schobes")?.personId ?? people[0]?.personId ?? "";
    }
    this.personSelect.value = this.person;
    this.loadLook();
    this.updateBoard();
  }

  private loadLook() {
    this.draft = { ...(this.state.profiles[this.person] ?? DEFAULT_PARTY_LOOK) };
    this.dirty = false;
    this.syncFields();
    const oldTarget = this.targetSelect.value;
    this.targetSelect.replaceChildren(new Option("Choose a buddy", ""));
    for (const p of this.model.people.values()) {
      if (p.personId !== this.person) this.targetSelect.add(new Option(p.name, p.personId));
    }
    if ([...this.targetSelect.options].some((o) => o.value === oldTarget))
      this.targetSelect.value = oldTarget;
    this.preview();
  }

  private preset(look: PartyLook) {
    this.draft = { ...look };
    this.dirty = true;
    this.syncFields();
    this.preview();
  }

  private syncFields() {
    for (const select of this.fields)
      select.value = this.draft[select.id.replace("party-", "") as keyof PartyLook];
  }

  private preview() {
    this.portrait.replaceChildren(partyPortrait(this.draft));
    const caption = document.createElement("span");
    caption.textContent = this.dirty ? "PREVIEW · save to share" : "Mix six slots. Make it yours.";
    this.portrait.append(caption);
    if (!this.drawer.hidden && this.person) this.world.preview(this.person, this.draft);
    this.updateButtons();
  }

  private updateButtons() {
    for (const b of this.actions) {
      const action = b.dataset.action;
      b.disabled =
        this.busy || !this.person || (!!action && (this.dirty || Date.now() < this.cooldownUntil));
    }
  }

  private apply(state: PartyState) {
    this.state = state;
    this.world.setState(state);
    this.updateBoard();
    if (!this.dirty) {
      this.draft = { ...(state.profiles[this.person] ?? DEFAULT_PARTY_LOOK) };
      this.syncFields();
      this.preview();
    }
  }

  private updateBoard() {
    this.board.replaceChildren();
    const leaders = Object.entries(this.state.scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    for (const [id, score] of leaders) {
      const row = document.createElement("li");
      row.textContent = `${this.model.people.get(id)?.name ?? id} · ${score} pts`;
      this.board.append(row);
    }
    if (!leaders.length) {
      const row = document.createElement("li");
      row.textContent = "The dance floor is yours. Start playing!";
      this.board.append(row);
    }
    const e = this.state.events.at(-1);
    this.feed.textContent = e
      ? `${this.model.people.get(e.personId)?.name ?? e.personId} · ${e.action}${e.roll ? ` · rolled ${e.roll}` : ""}`
      : "";
  }

  private async poll() {
    if (this.pollPending || this.busy) return;
    this.pollPending = true;
    const version = this.mutationVersion;
    try {
      const q = this.options.key ? `?key=${encodeURIComponent(this.options.key)}` : "";
      const response = await fetch(`/api/party${q}`);
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? "Party server update required."
            : "Party connection unavailable.",
        );
      const state = PartyState.parse(await response.json());
      if (!this.busy && version === this.mutationVersion) this.apply(state);
    } catch (err) {
      this.notice.textContent =
        err instanceof Error ? err.message : "Party connection unavailable.";
    } finally {
      this.pollPending = false;
    }
  }

  private async send(mutation: PartyMutation) {
    if (this.busy || !this.person) return;
    this.busy = true;
    this.mutationVersion++;
    this.notice.textContent = "";
    this.updateButtons();
    try {
      let state: PartyState;
      if (this.options.demo) {
        state = structuredClone(this.state);
        if (mutation.look) state.profiles[this.person] = mutation.look;
        if (mutation.action) {
          const look = state.profiles[this.person] ?? DEFAULT_PARTY_LOOK;
          if (mutation.action === "use" && look.item === "none")
            throw new Error("Equip and save a hand item first.");
          if (mutation.action === "race" && look.vehicle === "none")
            throw new Error("Equip and save a ride first.");
          if ((mutation.action === "tag" || mutation.action === "high-five") && !mutation.targetId)
            throw new Error("Choose a buddy first.");
          const roll = mutation.action === "race" ? 1 + Math.floor(Math.random() * 6) : undefined;
          state.events = [
            ...state.events.filter((e) => Date.now() - e.at < 15000),
            {
              id: crypto.randomUUID(),
              personId: this.person,
              action: mutation.action,
              item: look.item,
              at: Date.now(),
              ...(mutation.targetId ? { targetId: mutation.targetId } : {}),
              ...(roll ? { roll } : {}),
            },
          ].slice(-32);
          if (roll || mutation.targetId)
            state.scores[this.person] = (state.scores[this.person] ?? 0) + (roll ?? 1);
          if (mutation.action === "high-five" && mutation.targetId)
            state.scores[mutation.targetId] = (state.scores[mutation.targetId] ?? 0) + 1;
        }
      } else {
        if (!this.password.value)
          throw new Error("Enter the office connector password to save or play.");
        const response = await fetch("/api/party", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.password.value}`,
          },
          body: JSON.stringify(mutation),
        });
        const data: unknown = await response.json();
        if (!response.ok) {
          if (response.status === 401) this.password.value = "";
          const error =
            data && typeof data === "object" && "error" in data
              ? String(data.error)
              : "Party request failed.";
          throw new Error(error);
        }
        state = PartyState.parse(data);
      }
      this.dirty = false;
      this.world.preview(this.person, null);
      this.apply(state);
      this.notice.textContent = mutation.look
        ? "Outfit saved. Everyone can see your look."
        : "Party move sent!";
      if (mutation.action) this.cooldownUntil = Date.now() + 1500;
    } catch (err) {
      this.notice.textContent = err instanceof Error ? err.message : "Could not save. Try again.";
    } finally {
      this.busy = false;
      this.updateButtons();
    }
  }
}
