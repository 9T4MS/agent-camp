/**
 * DOM HUD over the canvas: top bar (office name, people, sessions, helpers, agent split,
 * clock), join banner, side panel (person panel or agent card), reconnect sign.
 * Pixel-styled via theme.css.
 */
import {
  ACCENT_COLORS,
  ACCESSORIES,
  type ACTIVITIES,
  type Activity,
  AGENT_COLORS,
  AGENT_PALETTES,
  type AgentKind,
  type AvatarSpec,
  catalogAvatar,
  DESK_MESS_LEVELS,
  DESK_PROPS,
  FACIAL_HAIR,
  GLASSES,
  HAIR_COLORS,
  HAIR_STYLES,
  HELD_ITEMS,
  type InteractionKind,
  MAX_DESK_PROPS,
  OUTFITS,
  type PersonDayResponse,
  SKIN_TONES,
  VEHICLES,
  WRISTWEAR,
} from "@agent-office/protocol";
import { iconUrl } from "./art/icons.ts";
import type { ConnectionStatus } from "./net/viewer.ts";
import { installMode, onInstallChange, promptInstall } from "./pwa.ts";
import type { OfficeModel, OfficeStats, PersonState, SessionState } from "./state/officeModel.ts";
import { cycleOption } from "./ui/carousel.ts";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const AGENT_LABEL: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
  unknown: "Agent",
};
const ACTIVITY_LABEL: Record<(typeof ACTIVITIES)[number], string> = {
  typing: "typing",
  reading: "reading",
  running: "running",
  thinking: "thinking",
  waiting: "waiting",
  idle: "idle",
};

/** Activity colors for the agent card (dot + timeline strip). */
export const ACTIVITY_COLORS: Record<Activity, string> = {
  typing: "#63c74d",
  reading: "#0099db",
  running: "#feae34",
  thinking: "#b55088",
  waiting: "#e43b44",
  idle: "#5a6988",
};
const AGENT_TITLE: Record<AgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  unknown: "Agent",
};
export type PokeRequest = {
  kind: InteractionKind;
  personId: string;
  from?: string;
  text?: string;
};
/** What the HUD shows after a poke: a short status line. */
export type PokeResult = { ok: boolean; message: string };
/** After saving in the look editor. */
export type LookResult = { ok: boolean; message: string; avatar?: AvatarSpec };

type LookField = Exclude<keyof AvatarSpec, "deskProps" | "deskMess">;
/** The look editor's catalog rows (arrow carousels), in order. */
const LOOK_FIELDS: {
  key: LookField;
  label: string;
  options: readonly { id: string; label: string }[];
}[] = [
  { key: "hairStyle", label: "Hair", options: HAIR_STYLES },
  { key: "hairColor", label: "Hair color", options: HAIR_COLORS },
  { key: "skinTone", label: "Skin", options: SKIN_TONES },
  { key: "facialHair", label: "Face", options: FACIAL_HAIR },
  { key: "glasses", label: "Glasses", options: GLASSES },
  { key: "accessory", label: "Head", options: ACCESSORIES },
  { key: "outfit", label: "Outfit", options: OUTFITS },
  { key: "leftHand", label: "Left hand", options: HELD_ITEMS },
  { key: "rightHand", label: "Right hand", options: HELD_ITEMS },
  { key: "wrist", label: "Bracelets", options: WRISTWEAR },
  { key: "accentColor", label: "Accent color", options: ACCENT_COLORS },
  { key: "vehicle", label: "Vehicle", options: VEHICLES },
];
const MESS_LABEL = ["spotless", "a bit messy", "messy", "chaos"] as const;
/** Where each catalog row sits in the look studio. */
const LOOK_GROUPS: { title: string; keys: readonly LookField[] }[] = [
  {
    title: "Character",
    keys: ["hairStyle", "hairColor", "skinTone", "facialHair", "glasses", "accessory"],
  },
  { title: "Outfit & hands", keys: ["outfit", "leftHand", "rightHand", "wrist", "accentColor"] },
  { title: "Ride", keys: ["vehicle"] },
];

/** One carousel in the look studio: a list of choices and how it reads/writes the draft. */
type LookRow = {
  id: string;
  label: string;
  options: readonly { id: string; label: string }[];
  get: () => string;
  set: (id: string) => void;
  /** choices to skip right now (desk props already on another slot) */
  skip?: () => ReadonlySet<string>;
};

const POKES: { kind: InteractionKind; label: string; title: string }[] = [
  { kind: "wave", label: "&#128075; Wave", title: "Wave (pops up on their Mac)" },
  {
    kind: "coffee",
    label: "&#9749; Coffee?",
    title: "Ask them for a coffee (pops up on their Mac)",
  },
  { kind: "cheer", label: "&#127881; Cheer", title: "Cheer them on (pops up on their Mac)" },
  {
    kind: "paper",
    label: "&#128196; Paper ball",
    title: "Throw a paper ball (only in the office)",
  },
  {
    kind: "tomato",
    label: "&#127813; Tomato",
    title: "Throw a tomato: a red splat for 10 min (only in the office)",
  },
  {
    kind: "cat",
    label: "&#128008; Send a cat",
    title: "An office cat goes and sits on their desk (pops up on their Mac)",
  },
];

/** What a viewer can do with an office cat (its card). */
export type CatAction = "pet" | "feed" | "yarn" | "laser";
export type CatInfo = {
  slot: number;
  name: string;
  /** e.g. "orange tabby" */
  coat: string;
  status: string;
  portrait: HTMLCanvasElement | null;
};
const CAT_ACTIONS: { kind: CatAction; label: string; title: string }[] = [
  { kind: "pet", label: "&#9995; Pet", title: "Pet the cat (purrs for everyone watching)" },
  { kind: "feed", label: "&#128031; Feed", title: "Put a food bowl next to the cat" },
  { kind: "yarn", label: "&#129526; Yarn ball", title: "Toss a yarn ball to play with" },
  { kind: "laser", label: "&#128308; Laser", title: "Then tap the floor: the cats chase the dot" },
];
const NAME_KEY = "agent-office.viewerName";

function storedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name.trim());
  } catch {
    // private mode: the name just isn't remembered
  }
}

/** Card timeline window. */
export const TIMELINE_MS = 30 * 60_000;

/** "3m", "1h 12m", "<1m" */
export function shortDuration(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function duration(ms: number) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** Context window bar for the agent card: calm, then smoking (50%), then burning (80%). */
export function contextMeter(share: number | undefined): string {
  if (share === undefined) return '<span class="dim">unknown</span>';
  const pct = Math.round(share * 100);
  const tone = share >= 0.8 ? "fire" : share >= 0.5 ? "warm" : "ok";
  const icon = share >= 0.8 ? " &#128293;" : share >= 0.5 ? " &#128168;" : "";
  return `<span class="ctx ${tone}" title="share of the model's context window in use"><span class="ctx-bar"><span style="width:${pct}%"></span></span>${pct}%${icon}</span>`;
}

/** Fun client-side badges for the side panel. */
export function badgesFor(
  person: PersonState,
  sessions: SessionState[],
  now = Date.now(),
): string[] {
  const out: string[] = [];
  const claudes = sessions.filter((s) => s.agent === "claude").length;
  if (claudes >= 2) out.push(`${claudes} Claudes at once`);
  const kinds = new Set(sessions.map((s) => s.agent));
  if (kinds.size >= 2) out.push("Multi-agent");
  const helpers = sessions.reduce((a, s) => a + s.subagents, 0);
  if (sessions.some((s) => (s.context ?? 0) >= 0.8)) out.push("On fire");
  if (helpers >= 5)
    out.push(
      person.helpers === "cats"
        ? `Cat herder (${helpers} kittens)`
        : `Swarm boss (${helpers} helpers)`,
    );
  else if (helpers > 0) out.push("Delegator");
  const projects = new Set(sessions.map((s) => s.project).filter(Boolean));
  if (projects.size >= 3) out.push("Juggler");
  if (sessions.some((s) => now - s.startedAt > 2 * 3600_000)) out.push("Marathon");
  if (sessions.some((s) => s.activity === "waiting")) out.push("Needs you!");
  const h = new Date(now).getHours();
  if (h >= 21 || h < 5) out.push("Night owl");
  else if (new Date(person.joinedAt).getHours() < 8) out.push("Early bird");
  if (out.length === 0) out.push("Just vibing");
  return out;
}

export class Hud {
  readonly root: HTMLElement;
  private name: HTMLElement;
  private chips: HTMLElement;
  private clock: HTMLElement;
  private refreshBtn: HTMLButtonElement | null = null;
  /** the refresh button was pressed */
  onRefresh: () => void = () => location.reload();
  /** "What's new" in the menu */
  onWhatsNew: (() => void) | null = null;
  private banner: HTMLElement;
  private bannerTimer: ReturnType<typeof setTimeout> | undefined;
  private bannerQueue: {
    title: string;
    sub: string;
    portrait: HTMLCanvasElement | null;
    joins?: string[];
  }[] = [];
  private panel: HTMLElement;
  private menu: HTMLElement;
  private reconnect: HTMLElement;
  readonly minimapHost: HTMLElement;
  private panelPerson: string | null = null;
  /** agent card: the session shown (panelPerson is its person) */
  private panelSession: string | null = null;
  /** cat card: the cat's slot */
  private panelCat: number | null = null;
  /** name, coat and mood of an office cat; null = no such cat (anymore) */
  catInfo: (slot: number) => CatInfo | null = () => null;
  /** play with a cat from its card; null hides the buttons (kiosk, no server) */
  onCatAction: ((action: CatAction, slot: number, from?: string) => Promise<PokeResult>) | null =
    null;
  private lastStatsKey = "";
  private days = new Map<string, { at: number; data: PersonDayResponse | null }>();
  portrait: (personId: string) => HTMLCanvasElement | null = () => null;
  /** "today" numbers for a person (GET /api/people/:id); null = not available (demo) */
  fetchDay: (personId: string) => Promise<PersonDayResponse | null> = async () => null;
  /** the panel opened, closed or switched between person and agent card */
  onPanelChange: () => void = () => {};
  /** send a poke / paper ball; null hides the poke buttons (kiosk, no server) */
  onPoke: ((req: PokeRequest) => Promise<PokeResult>) | null = null;
  /** survives panel re-renders, so a half-typed message is not lost */
  private pokeBox: HTMLElement | null = null;
  private pokeFor: string | null = null;
  /** look editor: save a custom look (null = back to automatic); null hides the editor */
  onEditLook: ((personId: string, avatar: AvatarSpec | null) => Promise<LookResult>) | null = null;
  /** preview canvases (front, side, at the desk) of a look in a given agent's colors */
  previewLook: (avatar: AvatarSpec, agent: AgentKind) => HTMLCanvasElement[] = () => [];
  /** whether a person's look is custom (GET /api/people/:id/avatar); null = unknown */
  fetchLookCustom: (personId: string) => Promise<boolean | null> = async () => null;
  /** person this browser confirmed to be ("It's me" code); only their look is editable */
  me: string | null = null;
  /** demo feed: no server, every look is editable */
  editAnyLook = false;
  /** "This is me": send a code to the person's Macs / confirm it; null hides the flow */
  onClaim: {
    send: (personId: string) => Promise<PokeResult>;
    verify: (personId: string, code: string) => Promise<PokeResult>;
    forget: () => Promise<void>;
  } | null = null;
  /** the claim box survives panel re-renders (half-typed code) */
  private claimBox: HTMLElement | null = null;
  private claimFor: string | null = null;
  /** open look editor (survives model re-renders) */
  private lookEditor: {
    personId: string;
    box: HTMLElement;
    onKey: (e: KeyboardEvent) => void;
  } | null = null;
  /** a session row in the person panel was clicked */
  onOpenSession: (sessionId: string) => void = (id) => this.openSession(id);

  constructor(
    host: HTMLElement,
    private readonly model: OfficeModel,
    private readonly opts: { kiosk: boolean },
  ) {
    this.root = host;
    const top = el("div", "hud-top");
    // the logo opens the menu (stats, timelapse, install, log out): an installed app has no
    // address bar to type /stats into. The kiosk keeps a plain label.
    this.name = el(
      opts.kiosk ? "div" : "button",
      "brand",
      `<img alt="" src="${iconUrl("logo")}"><span>Agent Office</span><span class="ver"></span>${opts.kiosk ? "" : '<i class="caret" aria-hidden="true"></i>'}`,
    );
    this.menu = el("div", "hud-menu pixel-box");
    this.chips = el("div", "chips");
    this.clock = el("div", "clock");
    top.append(this.name, this.chips);
    if (!opts.kiosk) {
      this.refreshBtn = el(
        "button",
        "refresh",
        `<span class="icon" aria-hidden="true">&#8635;</span><span class="label">New version</span>`,
      );
      this.refreshBtn.type = "button";
      this.refreshBtn.title = "Refresh";
      this.refreshBtn.setAttribute("aria-label", "Refresh");
      this.refreshBtn.addEventListener("click", () => this.onRefresh());
      top.append(this.refreshBtn);
    }
    top.append(this.clock);
    this.banner = el("div", "hud-banner pixel-box");
    this.panel = el("div", "hud-panel pixel-box");
    this.reconnect = el(
      "div",
      "hud-reconnect pixel-box",
      `<span class="blink">&#9632;</span> reconnecting&hellip;`,
    );
    this.minimapHost = el("div", "hud-minimap pixel-box");
    host.append(top, this.menu, this.banner, this.panel, this.reconnect, this.minimapHost);
    if (!opts.kiosk) this.setupMenu();
    this.panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.panel.addEventListener("wheel", (e) => e.stopPropagation());
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.panelOpen) this.closePanel();
    });
    this.tickClock();
    setInterval(() => this.tickClock(), 10_000);
    // "since 3m" and the timeline strip move on even when nothing happens
    setInterval(() => {
      if (this.panelSession) this.renderPanel();
      if (this.panelCat !== null) this.refreshCat();
    }, 5_000);
  }

  private setupMenu() {
    const btn = this.name as HTMLButtonElement;
    btn.type = "button";
    btn.title = "Menu";
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    const markInstall = () => btn.classList.toggle("can-install", installMode() === "prompt");
    markInstall();
    onInstallChange(() => {
      markInstall();
      if (this.menuOpen) this.renderMenu();
    });
    btn.addEventListener("click", () => (this.menuOpen ? this.closeMenu() : this.openMenu()));
    for (const ev of ["pointerdown", "wheel"] as const)
      this.menu.addEventListener(ev, (e) => e.stopPropagation());
    document.addEventListener("pointerdown", (e) => {
      if (this.menuOpen && !this.menu.contains(e.target as Node) && !btn.contains(e.target as Node))
        this.closeMenu();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.menuOpen) this.closeMenu();
    });
  }

  get menuOpen() {
    return this.menu.classList.contains("show");
  }

  openMenu() {
    this.renderMenu();
    this.menu.classList.add("show");
    this.name.setAttribute("aria-expanded", "true");
  }

  closeMenu() {
    this.menu.classList.remove("show", "ios-tip");
    this.name.setAttribute("aria-expanded", "false");
  }

  private renderMenu() {
    const key = new URLSearchParams(location.search).get("key");
    const q = key ? `?key=${encodeURIComponent(key)}` : "";
    const mode = installMode();
    const install =
      mode === "prompt"
        ? `<button type="button" class="pixel-btn install" role="menuitem">Install app</button>`
        : mode === "ios"
          ? `<button type="button" class="pixel-btn ios" role="menuitem">Add to Home Screen</button>
             <p class="tip">Tap <b>Share</b> <span class="share-icon" aria-hidden="true"></span> in Safari, then <b>Add to Home Screen</b>.</p>`
          : "";
    this.menu.setAttribute("role", "menu");
    this.menu.innerHTML = `
      <a class="pixel-btn" role="menuitem" href="./stats${q}">Stats</a>
      <a class="pixel-btn" role="menuitem" href="./timelapse${q}">Timelapse</a>
      ${this.onWhatsNew ? `<button type="button" class="pixel-btn whats-new" role="menuitem">What's new</button>` : ""}
      ${install}
      <form method="post" action="/api/logout"><button class="pixel-btn" type="submit" role="menuitem">Log out</button></form>`;
    this.menu.querySelector(".whats-new")?.addEventListener("click", () => {
      this.closeMenu();
      this.onWhatsNew?.();
    });
    this.menu.querySelector(".install")?.addEventListener("click", () => {
      this.closeMenu();
      void promptInstall();
    });
    this.menu
      .querySelector(".ios")
      ?.addEventListener("click", () => this.menu.classList.toggle("ios-tip"));
  }

  private tickClock() {
    const tz = this.model.timezone;
    try {
      this.clock.textContent = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        ...(tz ? { timeZone: tz } : {}),
      }).format(new Date());
    } catch {
      this.clock.textContent = new Date().toTimeString().slice(0, 5);
    }
  }

  setOfficeName(name: string) {
    this.name.querySelector("span")!.textContent = name;
    document.title = name;
  }

  /** "v0.1.42" next to the office name; the build's commit in the tooltip. */
  setVersion(version: string | undefined, build: string) {
    const v = this.name.querySelector<HTMLElement>(".ver");
    if (!v) return;
    v.textContent = version && version !== "0.0.0" ? `v${version.replace(/^v/, "")}` : build;
    v.title = `version ${version ?? "?"} · web build ${build}`;
  }

  /** A newer build is deployed: the refresh button says so. */
  setUpdateReady(ready: boolean) {
    if (!this.refreshBtn) return;
    this.refreshBtn.classList.toggle("ready", ready);
    this.refreshBtn.title = ready ? "A new version is out: refresh" : "Refresh";
  }

  setStats(st: OfficeStats) {
    const key = JSON.stringify(st);
    if (key === this.lastStatsKey) return;
    this.lastStatsKey = key;
    const chip = (icon: string, n: number, label: string) =>
      `<span class="pixel-chip"><img class="chip-icon" alt="" src="${icon}"><span class="chip-num">${n}</span><span class="chip-label">${label}</span></span>`;
    const agents = (Object.keys(st.byAgent) as AgentKind[])
      .filter((a) => st.byAgent[a] > 0)
      .map(
        (a) =>
          `<span class="pixel-chip"><span class="dot" style="background:${AGENT_COLORS[a]}"></span><span class="chip-num">${st.byAgent[a]}</span><span class="chip-label">${AGENT_LABEL[a]}</span></span>`,
      )
      .join("");
    this.chips.innerHTML =
      chip(iconUrl("person"), st.people, st.people === 1 ? "person" : "people") +
      chip(iconUrl("monitor"), st.sessions, st.sessions === 1 ? "session" : "sessions") +
      chip(iconUrl("bot"), st.subagents, st.subagents === 1 ? "helper" : "helpers") +
      (agents ? `<span class="agents">${agents}</span>` : "");
    if (this.panelPerson) this.renderPanel();
  }

  setStatus(status: ConnectionStatus) {
    this.reconnect.classList.toggle("show", status === "reconnecting");
  }

  showBanner(title: string, sub = "", opts: { portrait?: HTMLCanvasElement | null } = {}) {
    this.bannerQueue.push({ title, sub, portrait: opts.portrait ?? null });
    if (!this.bannerTimer) this.nextBanner();
  }

  /** "Anna joined" banner; joins that pile up while one is showing merge into one banner. */
  showJoin(name: string, portrait: HTMLCanvasElement | null) {
    const pending = this.bannerQueue.at(-1);
    if (pending?.joins) {
      pending.joins.push(name);
      const [a, b] = pending.joins;
      const n = pending.joins.length;
      pending.title = n === 2 ? `${a} & ${b} joined` : `${a}, ${b} +${n - 2} joined`;
      return;
    }
    this.bannerQueue.push({
      title: `${name} joined`,
      sub: "welcome to the office!",
      portrait,
      joins: [name],
    });
    if (!this.bannerTimer) this.nextBanner();
  }

  private nextBanner() {
    const b = this.bannerQueue.shift();
    if (!b) {
      this.bannerTimer = undefined;
      return;
    }
    this.banner.innerHTML = `<div class="text"><div class="title">${esc(b.title)}</div>${
      b.sub ? `<div class="sub">${esc(b.sub)}</div>` : ""
    }</div>`;
    if (b.portrait) {
      b.portrait.className = "banner-portrait";
      this.banner.prepend(b.portrait);
    }
    this.banner.classList.toggle("with-portrait", !!b.portrait);
    this.banner.classList.add("show");
    this.bannerTimer = setTimeout(() => {
      this.banner.classList.remove("show");
      this.bannerTimer = setTimeout(() => this.nextBanner(), 450);
    }, 4200);
  }

  openPanel(personId: string) {
    if (this.opts.kiosk) return;
    this.panelCat = null;
    this.panelPerson = personId;
    this.panelSession = null;
    this.renderPanel();
  }

  /** Open the agent card of one session. Returns false when it does not exist (or kiosk). */
  openSession(sessionId: string): boolean {
    if (this.opts.kiosk) return false;
    const s = this.model.sessions.get(sessionId);
    if (!s) return false;
    this.panelCat = null;
    this.panelPerson = s.personId;
    this.panelSession = sessionId;
    this.loadDay(s.personId);
    this.renderPanel();
    return true;
  }

  closePanel() {
    this.panelPerson = null;
    this.panelSession = null;
    this.panelCat = null;
    this.panel.classList.remove("show", "card");
    this.onPanelChange();
  }

  get panelOpen() {
    return this.panelPerson !== null || this.panelCat !== null;
  }

  /** Slot of the cat whose card is open, if any. */
  get openCatSlot() {
    return this.panelCat;
  }

  /** The cat card: name, coat, what it is up to, and things to do with it. */
  openCat(slot: number): boolean {
    if (this.opts.kiosk) return false;
    const info = this.catInfo(slot);
    if (!info) return false;
    this.panelPerson = null;
    this.panelSession = null;
    this.panelCat = slot;
    this.panel.innerHTML = `
      <button class="pixel-btn close" aria-label="Close">x</button>
      <header><div class="portrait-slot"></div><div>
        <h2>${esc(info.name)}</h2>
        <div class="since">office cat &middot; ${esc(info.coat)}</div>
        <div class="since cat-status">${esc(info.status)}</div>
      </div></header>`;
    if (info.portrait) {
      info.portrait.className = "portrait cat";
      this.panel.querySelector(".portrait-slot")!.replaceWith(info.portrait);
    }
    if (this.onCatAction) this.panel.append(this.buildCatBox(info));
    this.panel.querySelector(".close")!.addEventListener("click", () => this.closePanel());
    this.panel.classList.remove("card");
    this.panel.classList.add("show");
    this.onPanelChange();
    return true;
  }

  /** Update the cat card's mood line (or close it when the cat walked out). */
  refreshCat() {
    if (this.panelCat === null) return;
    const info = this.catInfo(this.panelCat);
    if (!info) {
      this.closePanel();
      return;
    }
    const line = this.panel.querySelector(".cat-status");
    if (line) line.textContent = info.status;
  }

  /** The laser was used (with its result) or cancelled: un-highlight its button. */
  laserDone(result?: PokeResult) {
    this.panel.querySelector(".poke-btns .armed")?.classList.remove("armed");
    const status = this.panel.querySelector<HTMLElement>(".poke-status");
    if (result && status && this.panelCat !== null) {
      status.textContent = result.message;
      status.className = `poke-status ${result.ok ? "ok" : "err"}`;
    }
  }

  private buildCatBox(info: CatInfo): HTMLElement {
    const box = el("div", "poke");
    box.innerHTML = `
      <div class="poke-title">Play with ${esc(info.name)}</div>
      <div class="poke-btns">${CAT_ACTIONS.map(
        (k) =>
          `<button type="button" class="pixel-btn" data-kind="${k.kind}" title="${k.title}">${k.label}</button>`,
      ).join("")}</div>
      <label class="poke-from">from <input name="from" maxlength="40" placeholder="your name"></label>
      <div class="poke-status" aria-live="polite"></div>`;
    const status = box.querySelector<HTMLElement>(".poke-status")!;
    const fromInput = box.querySelector<HTMLInputElement>("input[name=from]")!;
    fromInput.value = storedName();
    fromInput.addEventListener("change", () => storeName(fromInput.value));
    for (const b of box.querySelectorAll<HTMLButtonElement>(".poke-btns button")) {
      b.addEventListener("click", async () => {
        if (!this.onCatAction) return;
        const kind = b.dataset.kind as CatAction;
        const from = fromInput.value.trim();
        this.laserDone();
        if (kind === "laser") b.classList.add("armed");
        status.textContent = "...";
        status.className = "poke-status";
        const r = await this.onCatAction(kind, info.slot, from || undefined);
        status.textContent = r.message;
        status.className = `poke-status ${r.ok ? "ok" : "err"}`;
        if (!r.ok) b.classList.remove("armed");
        this.refreshCat();
      });
    }
    box.addEventListener("keydown", (e) => e.stopPropagation());
    return box;
  }

  /** Session whose agent card is open, if any. */
  get openSessionId() {
    return this.panelSession;
  }

  /** Re-render the open panel (call after model changes). */
  refresh() {
    if (this.panelPerson) this.renderPanel();
  }

  private loadDay(personId: string) {
    const hit = this.days.get(personId);
    if (hit && Date.now() - hit.at < 60_000) return;
    this.days.set(personId, { at: Date.now(), data: hit?.data ?? null });
    this.fetchDay(personId)
      .then((data) => {
        this.days.set(personId, { at: Date.now(), data });
        for (const [sessionId, log] of Object.entries(data?.recentActivity ?? {}))
          this.model.mergeActivityHistory(sessionId, log);
        if (this.panelPerson === personId && this.panelSession) this.renderPanel();
      })
      .catch(() => {});
  }

  private renderPanel() {
    // don't yank the poke / claim box away while someone is typing in it
    if (this.pokeBox?.isConnected && this.pokeBox.contains(document.activeElement)) return;
    if (this.claimBox?.isConnected && this.claimBox.contains(document.activeElement)) return;
    const p = this.panelPerson ? this.model.people.get(this.panelPerson) : undefined;
    if (!p) {
      this.closePanel();
      return;
    }
    if (this.panelSession) {
      const s = this.model.sessions.get(this.panelSession);
      if (s) return this.renderCard(p, s);
      // the session ended: fall back to its person
      this.panelSession = null;
    }
    const sessions = this.model.sessionsOf(p.personId);
    const now = Date.now();
    const items = sessions
      .map(
        (
          s,
        ) => `<li class="session-row" data-session="${esc(s.sessionId)}" tabindex="0" role="button">
          <span class="dot" style="background:${AGENT_COLORS[s.agent]}"></span>
          <span class="proj">${esc(s.project ?? "(private)")}</span>
          <span class="act">${s.offline ? "offline" : ACTIVITY_LABEL[s.activity]}</span>
          <span class="meta">${AGENT_LABEL[s.agent]} &middot; ${duration(now - s.startedAt)}${
            s.subagents ? ` &middot; ${s.subagents} helper${s.subagents > 1 ? "s" : ""}` : ""
          }${s.machine ? ` &middot; ${esc(s.machine)}` : ""}</span>
        </li>`,
      )
      .join("");
    const badges = badgesFor(p, sessions, now)
      .map((b) => `<span class="badge">${esc(b)}</span>`)
      .join("");
    this.panel.innerHTML = `
      <button class="pixel-btn close" aria-label="Close">x</button>
      <header><div class="portrait-slot"></div><div>
        <h2>${esc(p.name)}</h2>
        <div class="since">here for ${duration(now - p.joinedAt)}</div>
        <div class="since">${sessions.length} session${sessions.length === 1 ? "" : "s"}</div>
      </div></header>
      <ul>${items || "<li>No agents running</li>"}</ul>
      <div class="badges">${badges}</div>
      ${
        !this.onEditLook
          ? ""
          : this.canEditLook(p.personId)
            ? `<button type="button" class="pixel-btn edit-look" title="Pick hair, outfit, things in hand...">&#9998; Customize look</button>${
                this.me === p.personId
                  ? '<button type="button" class="link-btn forget-me" title="This browser stops being you (e.g. a shared iPad)">not you? forget this device</button>'
                  : ""
              }`
            : '<div class="claim-slot"></div>'
      }`;
    this.panel
      .querySelector(".edit-look")
      ?.addEventListener("click", () => this.openLookEditor(p.personId));
    this.panel.querySelector(".forget-me")?.addEventListener("click", () => {
      void this.onClaim?.forget().then(() => {
        this.me = null;
        this.renderPanel();
      });
    });
    const slot = this.panel.querySelector(".claim-slot");
    if (slot && this.onClaim) {
      if (!this.claimBox || this.claimFor !== p.personId) {
        this.claimBox = this.buildClaim(p);
        this.claimFor = p.personId;
      }
      slot.replaceWith(this.claimBox);
    } else slot?.remove();
    this.mountPoke(p);
    const portrait = this.portrait(p.personId);
    if (portrait) {
      portrait.className = "portrait";
      this.panel.querySelector(".portrait-slot")!.replaceWith(portrait);
    }
    this.panel.querySelector(".close")!.addEventListener("click", () => this.closePanel());
    for (const row of this.panel.querySelectorAll<HTMLElement>(".session-row")) {
      const open = () => this.onOpenSession(row.dataset.session!);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") open();
      });
    }
    this.panel.classList.remove("card");
    this.panel.classList.add("show");
    this.onPanelChange();
  }

  /** Whether the fullscreen look studio is open. */
  get lookEditorOpen() {
    return this.lookEditor !== null;
  }

  /** Open the fullscreen look studio for a person. */
  /** Only your own look (proved with a code), except in the demo. */
  canEditLook(personId: string): boolean {
    return this.editAnyLook || this.me === personId;
  }

  openLookEditor(personId: string) {
    const p = this.model.people.get(personId);
    if (!p || !this.onEditLook || this.opts.kiosk) return;
    if (!this.canEditLook(personId)) {
      // someone else's (or not yet proven) look: show the "This is me" box instead
      this.openPanel(personId);
      this.claimBox?.querySelector<HTMLElement>(".claim-send")?.focus();
      return;
    }
    this.closeLookEditor();
    const { box, onKey } = this.buildLookEditor(p);
    this.lookEditor = { personId, box, onKey };
    // capture: arrows / Esc belong to the studio, not to the office camera underneath
    window.addEventListener("keydown", onKey, true);
    this.root.append(box);
    box.querySelector<HTMLElement>(".look-row")?.focus();
    this.onPanelChange();
  }

  closeLookEditor() {
    if (!this.lookEditor) return;
    window.removeEventListener("keydown", this.lookEditor.onKey, true);
    this.lookEditor.box.remove();
    this.lookEditor = null;
    this.onPanelChange();
  }

  private buildLookEditor(p: PersonState): { box: HTMLElement; onKey: (e: KeyboardEvent) => void } {
    const box = el("div", "look-editor look-studio");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", `${p.name}'s look`);
    // catalog ids only: a saved custom look is drawn from them (a detailed GenUI look is not
    // kept), so the preview shows exactly what Save gives
    const draft: AvatarSpec = structuredClone(catalogAvatar(p.avatar));
    const agent = this.model.sessionsOf(p.personId)[0]?.agent ?? "claude";

    // desk props are three slots of their own; empty ones are dropped when saving
    const slotIdx = Array.from({ length: MAX_DESK_PROPS }, (_, i) => i);
    const slots: string[] = slotIdx.map((i) => draft.deskProps[i] ?? "none");
    const syncProps = () => {
      draft.deskProps = slots.filter((x) => x !== "none") as AvatarSpec["deskProps"];
    };
    const byKey = new Map(LOOK_FIELDS.map((f) => [f.key, f]));
    const fieldRow = (key: LookField): LookRow => {
      const f = byKey.get(key)!;
      return {
        id: key,
        label: f.label,
        options: f.options,
        get: () => String(draft[key]),
        set: (id) => {
          (draft as Record<string, unknown>)[key] = id;
        },
      };
    };
    const groups: { title: string; rows: LookRow[] }[] = LOOK_GROUPS.map((g) => ({
      title: g.title,
      rows: g.keys.filter((k) => byKey.has(k)).map(fieldRow),
    }));
    groups.push({
      title: "Desk",
      rows: [
        ...slotIdx.map(
          (i): LookRow => ({
            id: `desk${i}`,
            label: `Desk item ${i + 1}`,
            options: [{ id: "none", label: "nothing" }, ...DESK_PROPS],
            get: () => slots[i]!,
            set: (id) => {
              slots[i] = id;
              syncProps();
            },
            skip: () => new Set(slots.filter((x, j) => j !== i && x !== "none")),
          }),
        ),
        {
          id: "deskMess",
          label: "Desk mess",
          options: DESK_MESS_LEVELS.map((m) => ({ id: String(m), label: MESS_LABEL[m] })),
          get: () => String(draft.deskMess),
          set: (id) => {
            draft.deskMess = Number(id) as AvatarSpec["deskMess"];
          },
        },
      ],
    });
    const rows = groups.flatMap((g) => g.rows);

    const rowHtml = (r: LookRow) =>
      `<div class="look-row" data-field="${r.id}" tabindex="0" role="group" aria-label="${esc(r.label)}">
        <span class="row-label">${esc(r.label)}</span>
        <button type="button" class="pixel-btn arrow prev" aria-label="Previous ${esc(r.label.toLowerCase())}">&#9664;</button>
        <span class="row-value" aria-live="polite"></span>
        <button type="button" class="pixel-btn arrow next" aria-label="Next ${esc(r.label.toLowerCase())}">&#9654;</button>
      </div>`;
    box.innerHTML = `
      <div class="studio pixel-box">
        <header class="studio-head">
          <h2>${esc(p.name)}'s look</h2>
          <span class="studio-keys dim">&#9664; &#9654; change &middot; &#9650; &#9660; row &middot; Esc close</span>
          <button type="button" class="pixel-btn close" aria-label="Close">&times;</button>
        </header>
        <div class="studio-body">
          <section class="studio-stage">
            <div class="look-preview" aria-label="preview"></div>
            <div class="look-note dim">Only you can see this until you save. Saving pins the look; a new description no longer changes it.</div>
          </section>
          <section class="studio-rows">${groups
            .map(
              (g) =>
                `<div class="look-group"><h3>${esc(g.title)}</h3>${g.rows.map(rowHtml).join("")}</div>`,
            )
            .join("")}</section>
        </div>
        <footer class="studio-foot">
          <div class="poke-status look-status" aria-live="polite"></div>
          <button class="pixel-btn auto" type="button" title="Drop the custom look: back to the one from the description">Automatic</button>
          <button class="pixel-btn save" type="button">Save look</button>
        </footer>
      </div>`;
    const preview = box.querySelector<HTMLElement>(".look-preview")!;
    const status = box.querySelector<HTMLElement>(".look-status")!;
    const autoBtn = box.querySelector<HTMLButtonElement>(".auto")!;
    const rowEls = new Map(
      [...box.querySelectorAll<HTMLElement>(".look-row")].map((e) => [e.dataset.field!, e]),
    );
    const drawPreview = () => preview.replaceChildren(...this.previewLook(draft, agent));
    const paintRow = (r: LookRow) => {
      const e = rowEls.get(r.id)!;
      const value = r.get();
      const idx = r.options.findIndex((o) => o.id === value);
      e.dataset.value = value;
      e.querySelector(".row-value")!.innerHTML =
        `<span class="row-text">${esc(r.options[idx]?.label ?? value)}</span><span class="row-count">${idx + 1}/${r.options.length}</span>`;
    };
    const paintAll = () => {
      for (const r of rows) paintRow(r);
      drawPreview();
    };
    paintAll();
    const say = (msg: string, ok?: boolean) => {
      status.textContent = msg;
      status.className = `poke-status look-status${ok === undefined ? "" : ok ? " ok" : " err"}`;
    };
    void this.fetchLookCustom(p.personId).then((custom) => {
      if (custom === false) autoBtn.title = "This look is already automatic";
      if (custom) say("custom look (picked here)");
    });
    const step = (r: LookRow, dir: -1 | 1) => {
      r.set(cycleOption(r.options, r.get(), dir, r.skip?.()));
      paintRow(r);
      drawPreview();
      say("");
    };
    for (const r of rows) {
      const e = rowEls.get(r.id)!;
      e.querySelector(".prev")!.addEventListener("click", () => step(r, -1));
      e.querySelector(".next")!.addEventListener("click", () => step(r, 1));
    }
    const save = async (avatar: AvatarSpec | null) => {
      if (!this.onEditLook) return;
      say("...");
      const r = await this.onEditLook(p.personId, avatar);
      say(r.message, r.ok);
      if (r.ok && r.avatar && !avatar) {
        // back to automatic: show the look the server picked
        Object.assign(draft, structuredClone(catalogAvatar(r.avatar)));
        for (const i of slotIdx) slots[i] = draft.deskProps[i] ?? "none";
        paintAll();
      }
    };
    box.querySelector(".save")!.addEventListener("click", () => void save(structuredClone(draft)));
    autoBtn.addEventListener("click", () => void save(null));
    box.querySelector(".close")!.addEventListener("click", () => this.closeLookEditor());
    // clicks / scrolls must not reach the office canvas underneath
    for (const ev of ["pointerdown", "wheel"] as const)
      box.addEventListener(ev, (e) => e.stopPropagation());
    box.addEventListener("pointerdown", (e) => {
      if (e.target === box) this.closeLookEditor();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.closeLookEditor();
        return;
      }
      const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
      if (!keys.includes(e.key)) {
        // typing shortcuts of the office must not fire behind the studio
        e.stopImmediatePropagation();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      const current = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
        ".look-row",
      );
      const at = Math.max(
        0,
        rows.findIndex((r) => r.id === current?.dataset.field),
      );
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const next = rows[(at + (e.key === "ArrowUp" ? -1 : 1) + rows.length) % rows.length]!;
        rowEls.get(next.id)!.focus();
        return;
      }
      if (!current) rowEls.get(rows[0]!.id)!.focus();
      step(rows[at]!, e.key === "ArrowLeft" ? -1 : 1);
    };
    return { box, onKey };
  }

  /**
   * "This is me": a code goes to the person's Macs as a notification; typing it here marks
   * this browser as them, and from then on it may change that look (and only that one). A
   * courtesy lock against restyling colleagues, not real identity (see DECISIONS L9).
   */
  private buildClaim(p: PersonState): HTMLElement {
    const box = el("div", "claim");
    box.innerHTML = `
      <div class="claim-title">Is this you? Confirm with a code from your Mac to change this look.</div>
      <button type="button" class="pixel-btn claim-send" title="A 6-digit code pops up on this person's Mac">&#128274; It's me: send a code</button>
      <form class="claim-form" hidden>
        <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" aria-label="code from the Mac notification">
        <button class="pixel-btn" type="submit">Confirm</button>
      </form>
      <div class="poke-status claim-status" aria-live="polite"></div>`;
    const status = box.querySelector<HTMLElement>(".claim-status")!;
    const form = box.querySelector<HTMLFormElement>(".claim-form")!;
    const input = form.querySelector<HTMLInputElement>("input")!;
    const say = (r: PokeResult) => {
      status.textContent = r.message;
      status.className = `poke-status claim-status ${r.ok ? "ok" : "err"}`;
    };
    box.querySelector(".claim-send")!.addEventListener("click", async () => {
      if (!this.onClaim) return;
      status.textContent = "...";
      const r = await this.onClaim.send(p.personId);
      say(r);
      if (r.ok) {
        form.hidden = false;
        input.focus();
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!this.onClaim) return;
      const r = await this.onClaim.verify(p.personId, input.value.trim());
      say(r);
      if (!r.ok) return;
      this.me = p.personId;
      this.claimBox = null;
      this.claimFor = null;
      input.blur();
      this.renderPanel();
      this.openLookEditor(p.personId);
    });
    box.addEventListener("keydown", (e) => e.stopPropagation());
    return box;
  }

  /** The poke box at the bottom of the person panel and the agent card. */
  private mountPoke(p: PersonState) {
    if (!this.onPoke) return;
    if (!this.pokeBox || this.pokeFor !== p.personId) {
      this.pokeBox = this.buildPoke(p);
      this.pokeFor = p.personId;
    }
    this.panel.append(this.pokeBox);
  }

  private buildPoke(p: PersonState): HTMLElement {
    const box = el("div", "poke");
    box.innerHTML = `
      <div class="poke-title">Say hi to ${esc(p.name)}</div>
      <div class="poke-btns">${POKES.map(
        (k) =>
          `<button type="button" class="pixel-btn" data-kind="${k.kind}" title="${k.title}">${k.label}</button>`,
      ).join("")}</div>
      <form class="poke-msg">
        <input name="text" maxlength="80" placeholder="Short message to their Mac" autocomplete="off">
        <button class="pixel-btn" type="submit">Send</button>
      </form>
      <label class="poke-from">from <input name="from" maxlength="40" placeholder="your name"></label>
      <div class="poke-status" aria-live="polite"></div>`;
    const status = box.querySelector<HTMLElement>(".poke-status")!;
    const fromInput = box.querySelector<HTMLInputElement>("input[name=from]")!;
    const textInput = box.querySelector<HTMLInputElement>("input[name=text]")!;
    fromInput.value = storedName();
    fromInput.addEventListener("change", () => storeName(fromInput.value));
    const send = async (kind: InteractionKind, text?: string) => {
      if (!this.onPoke) return;
      const from = fromInput.value.trim();
      status.textContent = "...";
      status.className = "poke-status";
      const r = await this.onPoke({
        kind,
        personId: p.personId,
        ...(from ? { from } : {}),
        ...(text ? { text } : {}),
      });
      status.textContent = r.message;
      status.className = `poke-status ${r.ok ? "ok" : "err"}`;
      if (r.ok && kind === "message") textInput.value = "";
    };
    for (const b of box.querySelectorAll<HTMLButtonElement>(".poke-btns button")) {
      b.addEventListener("click", () => void send(b.dataset.kind as InteractionKind));
    }
    box.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = textInput.value.trim();
      if (text) void send("message", text);
    });
    // typing in the box must not trigger office keyboard shortcuts
    box.addEventListener("keydown", (e) => e.stopPropagation());
    return box;
  }

  /** The agent card: one session in detail. */
  private renderCard(p: PersonState, s: SessionState) {
    const now = Date.now();
    const pal = AGENT_PALETTES[s.agent];
    const act = s.activity;
    // timeline strip: last 30 min, client clock; before we saw the session = "no data"
    const from = now - TIMELINE_MS;
    const pct = (t: number) => ((t - from) / TIMELINE_MS) * 100;
    const segs = this.model.timeline(s.sessionId, TIMELINE_MS, now);
    const known = segs[0]?.from ?? now;
    const strip =
      (known > from
        ? `<span class="seg unknown" style="left:0;width:${pct(known).toFixed(2)}%" title="before this page was opened"></span>`
        : "") +
      segs
        .map(
          (g) =>
            `<span class="seg" style="left:${pct(g.from).toFixed(2)}%;width:${Math.max(0.6, pct(g.to) - pct(g.from)).toFixed(2)}%;background:${ACTIVITY_COLORS[g.activity]}" title="${g.activity} ${shortDuration(g.to - g.from)}"></span>`,
        )
        .join("");
    const seen = [...new Set(segs.map((g) => g.activity))];
    const legend = seen
      .map(
        (a) =>
          `<span class="lg"><span class="sw" style="background:${ACTIVITY_COLORS[a]}"></span>${ACTIVITY_LABEL[a]}</span>`,
      )
      .join("");
    const day = this.days.get(p.personId)?.data ?? null;
    // without the server (demo) fall back to what this viewer can see right now
    const mine = this.model.sessionsOf(p.personId);
    const today = day
      ? {
          sessions: day.sessionsToday,
          peak: day.peakParallelToday,
          helpers: day.subagentsToday,
        }
      : {
          sessions: mine.length,
          peak: mine.length,
          helpers: mine.reduce((a, x) => a + x.peakSubagents, 0),
        };
    const tile = (n: number, label: string) =>
      `<div class="tile"><b>${n}</b><span>${label}</span></div>`;
    const fact = (k: string, v: string) =>
      `<div class="fact"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    this.panel.innerHTML = `
      <button class="pixel-btn close" aria-label="Close">&times;</button>
      <div class="card-head">
        <div class="agent-tile" style="--j-light:${pal.light};--j-main:${pal.main};--j-shade:${pal.shade}">
          <img alt="" src="${iconUrl(s.agent)}">
        </div>
        <div class="head-text">
          <div class="kind" style="color:${pal.light}">${AGENT_TITLE[s.agent]}</div>
          <h2 title="${esc(s.project ?? "")}">${esc(s.project ?? "(private project)")}</h2>
          <button class="who" type="button"><span class="portrait-mini"></span><span>${esc(p.name)}</span><span class="chev">&rsaquo;</span></button>
        </div>
      </div>
      ${
        s.offline
          ? `<div class="now offline">
        <span class="act-dot" style="background:${ACTIVITY_COLORS.idle}"></span>
        <span class="act-name">offline</span>
        <span class="act-since">connector stopped answering (asleep or no network?)</span>
      </div>`
          : `<div class="now">
        <span class="act-dot${act === "waiting" ? " blink" : ""}" style="background:${ACTIVITY_COLORS[act]}"></span>
        <span class="act-name" style="color:${ACTIVITY_COLORS[act]}">${ACTIVITY_LABEL[act]}</span>
        <span class="act-since">since ${shortDuration(now - s.activitySince)}</span>
      </div>`
      }
      <div class="strip" role="img" aria-label="activity, last 30 minutes">${strip}</div>
      <div class="strip-axis"><span>30 min ago</span><span>now</span></div>
      <div class="legend">${legend}</div>
      <div class="facts">
        ${fact("running", shortDuration(now - (s.startedAt - this.model.clockSkew)))}
        ${fact("helpers", `${s.subagents} now <span class="dim">&middot; peak ${s.peakSubagents}</span>`)}
        ${fact("machine", s.machine ? esc(s.machine) : '<span class="dim">unknown</span>')}
        ${fact("context", contextMeter(s.context))}
      </div>
      <div class="today-title">${esc(p.name)} today</div>
      <div class="today">
        ${tile(today.sessions, today.sessions === 1 ? "session" : "sessions")}
        ${tile(today.peak, "at once")}
        ${tile(today.helpers, today.helpers === 1 ? "helper" : "helpers")}
      </div>`;
    this.mountPoke(p);
    const portrait = this.portrait(p.personId);
    if (portrait) {
      portrait.className = "portrait-mini";
      this.panel.querySelector(".portrait-mini")!.replaceWith(portrait);
    }
    this.panel.querySelector(".close")!.addEventListener("click", () => this.closePanel());
    this.panel.querySelector(".who")!.addEventListener("click", () => this.openPanel(p.personId));
    this.panel.classList.add("show", "card");
    this.onPanelChange();
  }
}
