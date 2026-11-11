/**
 * DOM HUD over the canvas: top bar (office name, people, sessions, helpers, agent split,
 * clock), join banner, side panel (person panel or agent card), reconnect sign.
 * Pixel-styled via theme.css.
 */
import {
  type ACTIVITIES,
  type Activity,
  AGENT_COLORS,
  AGENT_PALETTES,
  type AgentKind,
  type InteractionKind,
  type PersonDayResponse,
} from "@agent-office/protocol";
import { iconUrl } from "./art/icons.ts";
import type { ConnectionStatus } from "./net/viewer.ts";
import { installMode, onInstallChange, promptInstall } from "./pwa.ts";
import type { OfficeModel, OfficeStats, PersonState, SessionState } from "./state/officeModel.ts";

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
];
const NAME_KEY = "agent-office.viewerName";

function storedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
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
  if (helpers >= 5) out.push(`Swarm boss (${helpers} helpers)`);
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
    top.append(this.name, this.chips, this.clock);
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
      ${install}
      <form method="post" action="/api/logout"><button class="pixel-btn" type="submit" role="menuitem">Log out</button></form>`;
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
    v.title = `server ${version ?? "?"} · web build ${build}`;
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
    this.panelPerson = personId;
    this.panelSession = null;
    this.renderPanel();
  }

  /** Open the agent card of one session. Returns false when it does not exist (or kiosk). */
  openSession(sessionId: string): boolean {
    if (this.opts.kiosk) return false;
    const s = this.model.sessions.get(sessionId);
    if (!s) return false;
    this.panelPerson = s.personId;
    this.panelSession = sessionId;
    this.loadDay(s.personId);
    this.renderPanel();
    return true;
  }

  closePanel() {
    this.panelPerson = null;
    this.panelSession = null;
    this.panel.classList.remove("show", "card");
    this.onPanelChange();
  }

  get panelOpen() {
    return this.panelPerson !== null;
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
    // don't yank the poke box away while someone is typing in it
    if (this.pokeBox?.isConnected && this.pokeBox.contains(document.activeElement)) return;
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
      <div class="badges">${badges}</div>`;
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
    fromInput.addEventListener("change", () => {
      try {
        localStorage.setItem(NAME_KEY, fromInput.value.trim());
      } catch {
        // private mode: the name just isn't remembered
      }
    });
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
