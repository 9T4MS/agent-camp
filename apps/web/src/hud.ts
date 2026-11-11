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
  MAX_SELF_DESCRIPTION,
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
import { CustomizeSection, type PutGif } from "./ui/customizeSection.ts";

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
  design: "Design",
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
  design: "Claude Design",
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
export type LookResult = {
  ok: boolean;
  message: string;
  avatar?: AvatarSpec;
  /** the person's own Mac is drawing it: the new look arrives over the socket */
  pending?: boolean;
};
/** GET /api/people/:id/avatar, as far as the look studio cares. */
export type LookInfo = {
  custom: boolean;
  aiLooks?: boolean;
  description?: string;
  /** local AI tools on this person's Macs ("Claude Code") */
  localLooks?: string[];
};
/** How long the studio waits for a look drawn on the person's Mac. */
const LOCAL_LOOK_WAIT_MS = 5 * 60_000;

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

/** The digits of a typed or pasted claim code ("123 456" -> "123456"). */
export const claimDigits = (raw: string) => raw.replace(/\D/g, "").slice(0, 6);

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
  /** "GIF over your head" section of your own card, kept across re-renders (half-typed link) */
  private customize: CustomizeSection | null = null;
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
  /** set / remove a person's head GIF (PUT /api/people/:id/gif); null = no server (demo) */
  putGif: PutGif | null = null;
  /** the panel opened, closed or switched between person and agent card */
  onPanelChange: () => void = () => {};
  /** send a poke / paper ball; null hides the poke buttons (kiosk, no server) */
  onPoke: ((req: PokeRequest) => Promise<PokeResult>) | null = null;
  /** Open the one shared office composer (optionally preselect a person). */
  onMessages: ((personId?: string) => void) | null = null;
  onLogout: () => void = () => {};
  /** survives panel re-renders, so a half-typed message is not lost */
  private pokeBox: HTMLElement | null = null;
  private pokeFor: string | null = null;
  /** look editor: save a custom look (null = back to automatic); null hides the editor */
  onEditLook: ((personId: string, avatar: AvatarSpec | null) => Promise<LookResult>) | null = null;
  /** preview canvases (front, side, at the desk) of a look in a given agent's colors */
  previewLook: (avatar: AvatarSpec, agent: AgentKind) => HTMLCanvasElement[] = () => [];
  /** custom look? AI looks on? own description? (GET /api/people/:id/avatar); null = unknown */
  fetchLookInfo: (personId: string) => Promise<LookInfo | null> = async () => null;
  /** look studio: a new look from a description (server GenUI); null hides the box */
  onDescribeLook: ((personId: string, description: string) => Promise<LookResult>) | null = null;
  private meId: string | null = null;
  /** `me` changed (confirmed, forgotten, restored from the cookie) */
  onMeChange: (me: string | null) => void = () => {};
  private meChip: HTMLButtonElement | null = null;
  private meChipKey = "";
  private meMenu: HTMLElement;
  /** Me menu: the person whose code is being entered (null = the list / my own menu) */
  private claiming: string | null = null;
  /** Me menu: why it opened ("Confirm it's you to play") and what to do once confirmed */
  private claimWhy = "";
  private claimThen: (() => void) | null = null;
  private meNote = "";
  /** demo feed: no server, every look is editable */
  editAnyLook = false;
  /** "This is me": send a code to the person's Macs / confirm it; null hides the flow */
  onClaim: {
    send: (personId: string) => Promise<PokeResult>;
    verify: (personId: string, code: string) => Promise<PokeResult>;
    forget: () => Promise<void>;
  } | null = null;
  /** the claim box survives Me menu re-renders (half-typed code) */
  private claimBox: HTMLElement | null = null;
  private claimFor: string | null = null;
  /** open look editor (survives model re-renders) */
  private lookEditor: {
    personId: string;
    box: HTMLElement;
    onKey: (e: KeyboardEvent) => void;
  } | null = null;
  /** "My desk" in the Me menu */
  onOpenMe: (personId: string) => void = (id) => this.openPanel(id);
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
    this.meMenu = el("div", "me-menu pixel-box");
    if (!opts.kiosk) {
      this.meChip = el("button", "me-chip");
      this.meChip.type = "button";
      this.meChip.setAttribute("aria-haspopup", "dialog");
      this.meChip.setAttribute("aria-expanded", "false");
      top.append(this.meChip);
      top.classList.add("with-me");
      this.setupMeMenu();
      this.renderMeChip();
    }
    this.banner = el("div", "hud-banner pixel-box");
    this.panel = el("div", "hud-panel pixel-box");
    this.reconnect = el(
      "div",
      "hud-reconnect pixel-box",
      `<span class="blink">&#9632;</span> reconnecting&hellip;`,
    );
    this.minimapHost = el("div", "hud-minimap pixel-box");
    host.append(
      top,
      this.menu,
      this.meMenu,
      this.banner,
      this.panel,
      this.reconnect,
      this.minimapHost,
    );
    if (!opts.kiosk) this.setupMenu();
    this.panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.panel.addEventListener("wheel", (e) => e.stopPropagation());
    // (Escape inside the Customize inputs only blurs them, see CustomizeSection)
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
      ${this.onMessages ? '<button type="button" class="pixel-btn open-messages" role="menuitem">Messages</button>' : ""}
      <a class="pixel-btn" role="menuitem" href="./stats${q}">Stats</a>
      <a class="pixel-btn" role="menuitem" href="./timelapse${q}">Timelapse</a>
      ${this.onWhatsNew ? `<button type="button" class="pixel-btn whats-new" role="menuitem">What's new</button>` : ""}
      ${install}
      <form method="post" action="/api/logout"><button class="pixel-btn" type="submit" role="menuitem">Log out</button></form>`;
    this.menu.querySelector(".open-messages")?.addEventListener("click", () => {
      this.closeMenu();
      this.onMessages?.();
    });
    this.menu.querySelector("form")?.addEventListener("submit", () => this.onLogout());
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
    this.panel.hidden = false;
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
    this.panel.hidden = false;
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

  /** Hide on a narrow screen without discarding the selected card or look draft. */
  suspendPanel() {
    this.panel.hidden = true;
    this.onPanelChange();
  }

  get panelOpen() {
    return (this.panelPerson !== null || this.panelCat !== null) && !this.panel.hidden;
  }

  /** Slot of the cat whose card is open, if any. */
  get openCatSlot() {
    return this.panelCat;
  }

  /** The cat card: name, coat, what it is up to, and things to do with it. */
  openCat(slot: number): boolean {
    if (this.opts.kiosk) return false;
    this.panel.hidden = false;
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
    this.fillFrom(fromInput);
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
    this.refreshMe();
  }

  /** The Me chip and menu follow the office (my name and look, who is here). */
  refreshMe() {
    this.renderMeChip();
    // a half-typed code and my own menu are left alone
    if (this.meMenuOpen && !this.me && !this.claiming) this.renderMeMenu();
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
    // don't yank the poke box away while someone is typing in it
    if (this.pokeBox?.isConnected && this.pokeBox.contains(document.activeElement)) return;
    if (this.customize?.root.isConnected && this.customize.root.contains(document.activeElement)) {
      // ... but the GIF section still shows a new GIF as soon as `gif.updated` arrives
      this.customize.update(this.model.people.get(this.customize.personId)?.gif);
      return;
    }
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
            ? `<button type="button" class="pixel-btn edit-look" title="Pick hair, outfit, things in hand...">&#9998; Customize look</button>`
            : this.onClaim && !this.me
              ? '<button type="button" class="link-btn this-is-me" title="Confirm with a code from your Mac">This is me</button>'
              : ""
      }`;
    this.panel
      .querySelector(".edit-look")
      ?.addEventListener("click", () => this.openLookEditor(p.personId));
    this.panel
      .querySelector(".this-is-me")
      ?.addEventListener("click", () => this.openMeMenu({ personId: p.personId }));
    this.mountCustomize(p);
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

  /**
   * The "GIF over your head" section, on your own card only (this browser confirmed "It's me",
   * like the look editor; the server checks the same cookie). The same element across
   * re-renders, so a half-typed link survives; a fresh one for a different person. Not in
   * kiosk mode, not without a server (demo).
   */
  private mountCustomize(p: PersonState) {
    if (this.opts.kiosk || !this.putGif || this.me !== p.personId) return;
    if (this.customize?.personId !== p.personId)
      this.customize = new CustomizeSection(p.personId, p.gif, this.putGif);
    else this.customize.update(p.gif);
    this.panel.append(this.customize.root);
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
      // not yet proven to be anyone: confirm first, then open the studio. Somebody else's
      // look stays theirs.
      if (!this.me && this.onClaim)
        this.openMeMenu({
          personId,
          why: "Confirm it's you to change this look.",
          after: () => this.openLookEditor(personId),
        });
      else this.openPanel(personId);
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
    /** a freshly generated look (detailed): previewed until a carousel is touched */
    let generated: AvatarSpec | null = null;
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
            <div class="look-note dim">Only you can see this until you save. Saving pins the look; a new description no longer changes it.</div>${
              this.onDescribeLook
                ? `<form class="look-describe">
              <label class="describe-label" for="look-describe-text">Describe your look</label>
              <textarea id="look-describe-text" rows="4" maxlength="${MAX_SELF_DESCRIPTION}" placeholder="A few words or a whole paragraph: hair, glasses, clothes, shoes, colors..."></textarea>
              <div class="describe-foot">
                <span class="describe-hint dim">The AI draws you from this text (up to a minute). It replaces a look picked here.</span>
                <button class="pixel-btn describe-go" type="submit">&#10024; Generate look</button>
              </div>
            </form>`
                : ""
            }
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
    const drawPreview = () =>
      preview.replaceChildren(...this.previewLook(generated ?? draft, agent));
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
    const describeForm = box.querySelector<HTMLFormElement>(".look-describe");
    const describeText = describeForm?.querySelector("textarea") ?? null;
    const describeGo = describeForm?.querySelector<HTMLButtonElement>(".describe-go") ?? null;
    const describeHint = describeForm?.querySelector<HTMLElement>(".describe-hint") ?? null;
    void this.fetchLookInfo(p.personId).then((info) => {
      if (!info) return;
      if (!info.custom) autoBtn.title = "This look is already automatic";
      if (info.custom) say("custom look (picked here)");
      if (describeText && info.description && !describeText.value)
        describeText.value = info.description;
      if (describeHint && info.localLooks?.length)
        describeHint.textContent = `Your Mac draws it with ${info.localLooks[0]} on your own subscription (about a minute). It replaces a look picked here.`;
      else if (describeHint && info.aiLooks === false)
        describeHint.textContent =
          "AI looks are off on this office server: your text is saved and used as soon as the admin turns them on (GENUI_PROVIDER, see README).";
    });
    const showAvatar = (avatar: AvatarSpec) => {
      Object.assign(draft, structuredClone(catalogAvatar(avatar)));
      for (const i of slotIdx) slots[i] = draft.deskProps[i] ?? "none";
      generated = avatar.look ? structuredClone(avatar) : null;
      paintAll();
    };
    /** bumped by saving a picked look: the server then drops the Mac's answer, stop waiting */
    let localWait = 0;
    describeForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!this.onDescribeLook || !describeText || !describeGo) return;
      const text = describeText.value.trim();
      if (!text) {
        say("write a few words about how you look first", false);
        describeText.focus();
        return;
      }
      describeGo.disabled = true;
      say("the AI is drawing you, this can take a minute...");
      const before = JSON.stringify(this.model.people.get(p.personId)?.avatar ?? null);
      const r = await this.onDescribeLook(p.personId, text);
      if (r.pending) {
        say(r.message);
        // the look arrives as avatar.updated: watch the model until it changes
        const until = Date.now() + LOCAL_LOOK_WAIT_MS;
        const wait = ++localWait;
        const watch = () => {
          if (this.lookEditor?.box !== box || wait !== localWait) return; // closed or picked
          const now = this.model.people.get(p.personId)?.avatar;
          if (now && JSON.stringify(now) !== before) {
            describeGo.disabled = false;
            showAvatar(now);
            say("new look, drawn on your Mac!", true);
          } else if (Date.now() > until) {
            describeGo.disabled = false;
            say("no new look yet: run `agent-office logs` on your Mac to see why", false);
          } else setTimeout(watch, 1_500);
        };
        watch();
        return;
      }
      describeGo.disabled = false;
      say(r.message, r.ok);
      if (r.ok && r.avatar) showAvatar(r.avatar);
    });
    const step = (r: LookRow, dir: -1 | 1) => {
      // touching a carousel starts from the generated look's catalog ids (what Save keeps)
      generated = null;
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
      if (avatar) {
        localWait++;
        if (describeGo) describeGo.disabled = false;
      }
      say("...");
      const r = await this.onEditLook(p.personId, avatar);
      say(r.message, r.ok);
      if (r.ok && r.avatar && !avatar) {
        // back to automatic: show the look the server picked
        showAvatar(r.avatar);
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
      const typing = (e.target as HTMLElement | null)?.closest?.("textarea, input");
      if (typing && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        describeForm?.requestSubmit();
        return;
      }
      // in the description box arrows move the caret, they do not flip carousels
      if (!keys.includes(e.key) || typing) {
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

  /** Person this browser confirmed to be ("It's me" code); null = a spectator. */
  get me(): string | null {
    return this.meId;
  }

  set me(id: string | null) {
    if (id === this.meId) return;
    this.meId = id;
    // the "from" line of the poke box and the claim step depend on who I am
    this.pokeBox = null;
    this.pokeFor = null;
    this.claimBox = null;
    this.claimFor = null;
    this.claiming = null;
    this.renderMeChip();
    if (this.meMenuOpen) this.renderMeMenu();
    if (this.panelPerson) this.renderPanel();
    this.onMeChange(id);
  }

  /** My name for "from" lines once this browser is confirmed (nothing to type then). */
  private myName(): string | undefined {
    return this.me ? this.model.people.get(this.me)?.name : undefined;
  }

  private setupMeMenu() {
    const chip = this.meChip!;
    this.meMenu.setAttribute("role", "dialog");
    chip.addEventListener("click", () =>
      this.meMenuOpen ? this.closeMeMenu() : this.openMeMenu(),
    );
    for (const ev of ["pointerdown", "wheel"] as const)
      this.meMenu.addEventListener(ev, (e) => e.stopPropagation());
    document.addEventListener("pointerdown", (e) => {
      const t = e.target as Node;
      if (this.meMenuOpen && !this.meMenu.contains(t) && !chip.contains(t)) this.closeMeMenu();
    });
    // typing a code must not trigger office shortcuts
    this.meMenu.addEventListener("keydown", (e) => e.stopPropagation());
    // Esc closes this layer only (capture: before the panel underneath sees it), wherever
    // the focus is
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || !this.meMenuOpen) return;
        e.stopImmediatePropagation();
        this.closeMeMenu();
        chip.focus();
      },
      true,
    );
  }

  get meMenuOpen() {
    return this.meMenu.classList.contains("show");
  }

  /**
   * The Me menu (top right): who this browser is, or "Which one is you?" for a spectator.
   * `personId` goes straight to that person's code step; `why` says what needs confirming and
   * `after` runs once this browser is confirmed.
   */
  openMeMenu(opts: { personId?: string; why?: string; after?: () => void } = {}) {
    if (!this.meChip) return;
    this.closeMenu();
    this.meNote = "";
    this.claimWhy = opts.why ?? "";
    this.claimThen = opts.after ?? null;
    this.claiming = null;
    if (!this.me && opts.personId) this.pickMe(opts.personId);
    this.renderMeMenu();
    this.meMenu.classList.add("show");
    this.meChip.setAttribute("aria-expanded", "true");
    (
      this.meMenu.querySelector<HTMLElement>(".claim-send") ??
      this.meMenu.querySelector<HTMLElement>("button")
    )?.focus();
  }

  closeMeMenu() {
    this.meMenu.classList.remove("show");
    this.meChip?.setAttribute("aria-expanded", "false");
    this.claimThen = null;
  }

  /** A spectator picked a person: the demo has no server to ask, everyone else gets a code. */
  private pickMe(personId: string) {
    if (!this.model.people.has(personId)) return;
    if (this.onClaim) this.claiming = personId;
    else if (this.editAnyLook) this.confirmed(personId);
  }

  private confirmed(personId: string) {
    const then = this.claimThen;
    this.claimThen = null;
    this.me = personId;
    this.meNote = `That's you! This device is ${this.myName() ?? "you"} for a year.`;
    if (this.meMenuOpen) this.renderMeMenu();
    if (then) {
      this.closeMeMenu();
      then();
    }
  }

  private miniPortrait(personId: string): HTMLCanvasElement | null {
    const c = this.portrait(personId);
    if (c) c.className = "portrait-mini";
    return c;
  }

  /** The chip in the top bar: my portrait and name, or "Who are you?". */
  private renderMeChip() {
    const chip = this.meChip;
    if (!chip) return;
    const p = this.me ? this.model.people.get(this.me) : undefined;
    // the portrait is redrawn only when the look changes
    const key = this.me ? `${this.me}|${p?.name ?? ""}|${JSON.stringify(p?.avatar ?? null)}` : "";
    if (key === this.meChipKey && chip.childElementCount > 0) return;
    this.meChipKey = key;
    if (!this.me) {
      chip.innerHTML = `<span class="me-q" aria-hidden="true">?</span><span class="me-name">Who are you?</span>`;
      chip.title = "Tell the office which character is you";
      chip.setAttribute("aria-label", "Me: who are you?");
      chip.classList.remove("confirmed");
      return;
    }
    const name = p?.name ?? "You";
    chip.innerHTML = `<span class="me-name">${esc(name)}</span>`;
    const portrait = this.miniPortrait(this.me);
    chip.prepend(portrait ?? el("span", "me-q", "&#9786;"));
    chip.title = `You are ${name} on this device`;
    chip.setAttribute("aria-label", `Me: ${name}`);
    chip.classList.add("confirmed");
  }

  private renderMeMenu() {
    const menu = this.meMenu;
    const me = this.me;
    if (me) {
      const name = this.myName();
      menu.setAttribute("aria-label", "Me");
      menu.innerHTML = `
        <div class="me-head"><span class="portrait-slot"></span><b>${esc(name ?? "You")}</b><span class="dim">this device</span></div>
        ${this.meNote ? `<div class="me-note ok" role="status">${esc(this.meNote)}</div>` : ""}
        ${
          name
            ? `${this.onEditLook ? '<button type="button" class="pixel-btn me-look">&#9998; Customize look</button>' : ""}
               <button type="button" class="pixel-btn me-card">My desk</button>`
            : '<div class="me-note dim">You are not in the office right now.</div>'
        }
        <button type="button" class="link-btn me-forget" title="This browser stops being you (e.g. a shared iPad)">Not ${esc(name ?? "you")}? Forget this device</button>`;
      const portrait = this.miniPortrait(me);
      if (portrait) menu.querySelector(".portrait-slot")!.replaceWith(portrait);
      menu.querySelector(".me-look")?.addEventListener("click", () => {
        this.closeMeMenu();
        this.openLookEditor(me);
      });
      menu.querySelector(".me-card")?.addEventListener("click", () => {
        this.closeMeMenu();
        this.onOpenMe(me);
      });
      menu.querySelector(".me-forget")!.addEventListener("click", () => {
        void (this.onClaim?.forget() ?? Promise.resolve()).then(() => {
          this.me = null;
          this.meChip?.focus();
        });
      });
      return;
    }
    menu.setAttribute("aria-label", "Which one is you?");
    const why = this.claimWhy ? `<div class="me-note">${esc(this.claimWhy)}</div>` : "";
    const p = this.claiming ? this.model.people.get(this.claiming) : undefined;
    if (p) {
      menu.innerHTML = `${why}<div class="claim-slot"></div>
        <button type="button" class="link-btn me-back">Not ${esc(p.name)}? Pick someone else</button>`;
      if (!this.claimBox || this.claimFor !== p.personId) {
        this.claimBox = this.buildClaim(p);
        this.claimFor = p.personId;
      }
      menu.querySelector(".claim-slot")!.replaceWith(this.claimBox);
      menu.querySelector(".me-back")!.addEventListener("click", () => {
        this.claiming = null;
        this.renderMeMenu();
        this.meMenu.querySelector<HTMLElement>("button")?.focus();
      });
      return;
    }
    this.claiming = null;
    const people = [...this.model.people.values()].sort((a, b) => a.name.localeCompare(b.name));
    // keep the keyboard position when the office changes while the list is open
    const focused = (document.activeElement as HTMLElement | null)?.dataset.person;
    menu.innerHTML = `
      <div class="me-title">Which one is you?</div>${why}
      <ul class="me-people">${people
        .map(
          (x) =>
            `<li><button type="button" class="pixel-btn" data-person="${esc(x.personId)}"><span class="portrait-slot"></span>${esc(x.name)}</button></li>`,
        )
        .join("")}</ul>
      <div class="me-note dim">${
        people.length ? "Not here?" : "Nobody is in the office yet."
      } You get a desk once the connector runs on your Mac. Until then you can watch and say hi.</div>`;
    for (const b of menu.querySelectorAll<HTMLButtonElement>(".me-people button")) {
      const id = b.dataset.person!;
      const portrait = this.miniPortrait(id);
      if (portrait) b.querySelector(".portrait-slot")!.replaceWith(portrait);
      b.addEventListener("click", () => {
        this.pickMe(id);
        this.renderMeMenu();
        this.meMenu.querySelector<HTMLElement>(".claim-send")?.focus();
      });
      if (id === focused) b.focus();
    }
  }

  /**
   * "This is me": a code goes to the person's Macs as a notification; typing it here marks
   * this browser as them. From then on it may change that look (and only that one) and plays
   * the office games as them. A courtesy lock, not real identity (see DECISIONS L9).
   */
  private buildClaim(p: PersonState): HTMLElement {
    const box = el("div", "claim");
    box.innerHTML = `
      <div class="claim-title">A 6-digit code pops up as a notification on ${esc(p.name)}'s Mac.</div>
      <button type="button" class="pixel-btn claim-send">&#128274; Send a code to my Mac</button>
      <form class="claim-form" hidden novalidate>
        <label for="claim-code">Code from the notification</label>
        <div class="claim-row">
          <input id="claim-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" placeholder="123456" aria-describedby="claim-status">
          <button class="pixel-btn" type="submit">Confirm</button>
        </div>
      </form>
      <div class="poke-status claim-status" id="claim-status" aria-live="polite"></div>
      <details class="claim-help"><summary>No code?</summary>Notifications must be on for the Agent Office connector on that Mac. A code works for 5 minutes; you can send a new one after 30 seconds, up to 10 a day.</details>`;
    const status = box.querySelector<HTMLElement>(".claim-status")!;
    const form = box.querySelector<HTMLFormElement>(".claim-form")!;
    const input = form.querySelector<HTMLInputElement>("input")!;
    const sendBtn = box.querySelector<HTMLButtonElement>(".claim-send")!;
    const say = (r: PokeResult) => {
      status.textContent = r.message;
      status.className = `poke-status claim-status ${r.ok ? "ok" : "err"}`;
    };
    // the server sends one code per person per 30 s: count down instead of failing
    let timer: ReturnType<typeof setInterval> | undefined;
    const countdown = (until: number) => {
      clearInterval(timer);
      const tick = () => {
        const left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0 || !box.isConnected) {
          clearInterval(timer);
          sendBtn.disabled = false;
          sendBtn.textContent = "Send again";
          return;
        }
        sendBtn.disabled = true;
        sendBtn.textContent = `Send again (0:${String(left).padStart(2, "0")})`;
      };
      tick();
      timer = setInterval(tick, 1000);
    };
    sendBtn.addEventListener("click", async () => {
      if (!this.onClaim) return;
      status.textContent = "...";
      const r = await this.onClaim.send(p.personId);
      say(r.ok ? { ok: true, message: `Code sent to ${p.name}'s Mac.` } : r);
      if (r.ok) {
        form.hidden = false;
        countdown(Date.now() + 30_000);
        input.focus();
      }
    });
    // a pasted "123 456" is still six digits
    input.addEventListener("input", () => {
      input.value = claimDigits(input.value);
      input.removeAttribute("aria-invalid");
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!this.onClaim) return;
      const r = await this.onClaim.verify(p.personId, claimDigits(input.value));
      if (!r.ok) {
        say(r);
        input.setAttribute("aria-invalid", "true");
        input.focus();
        input.select();
        return;
      }
      clearInterval(timer);
      this.confirmed(p.personId);
    });
    return box;
  }

  /** The "from" line: my name once this browser is confirmed, otherwise a typed one. */
  private fillFrom(input: HTMLInputElement) {
    const mine = this.myName();
    if (mine) {
      input.value = mine;
      input.closest<HTMLElement>(".poke-from")!.hidden = true;
      return;
    }
    input.value = storedName();
    input.addEventListener("change", () => storeName(input.value));
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
      ${this.onMessages ? '<button type="button" class="pixel-btn poke-message">Message</button>' : ""}
      <label class="poke-from">from <input name="from" maxlength="40" placeholder="your name"></label>
      <div class="poke-status" aria-live="polite"></div>`;
    const status = box.querySelector<HTMLElement>(".poke-status")!;
    const fromInput = box.querySelector<HTMLInputElement>("input[name=from]")!;
    this.fillFrom(fromInput);
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
    };
    for (const b of box.querySelectorAll<HTMLButtonElement>(".poke-btns button")) {
      b.addEventListener("click", () => void send(b.dataset.kind as InteractionKind));
    }
    box
      .querySelector(".poke-message")
      ?.addEventListener("click", () => this.onMessages?.(p.personId));
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
