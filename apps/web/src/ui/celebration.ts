import type { ChangelogSection } from "../release.ts";

const CONFETTI_COLORS = [
  "#feae34",
  "#fee761",
  "#63c74d",
  "#2ce8f5",
  "#f6757a",
  "#b55088",
  "#0099db",
];
const AUTO_CLOSE_MS = 15_000;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/`([^`]+)`/g, "<code>$1</code>");

/**
 * The "new version" banner: a wide strip across the office with confetti and the version.
 * The office stays usable around it; it closes on a click, Escape, or by itself after 15 s.
 * Only "What's new" from the menu passes a changelog section to list.
 */
export class Celebration {
  private el: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.close();
  };

  constructor(private readonly host: HTMLElement) {}

  get open() {
    return this.el !== null;
  }

  show(opts: { heading: string; version: string | null; section?: ChangelogSection }) {
    this.close();
    const root = document.createElement("div");
    root.className = "celebration";
    root.setAttribute("role", "status");
    const confetti = Array.from({ length: 80 }, (_, i) => {
      const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      const style = `left:${Math.random() * 100}%;background:${color};animation-delay:${(Math.random() * 2.5).toFixed(2)}s;animation-duration:${(2.8 + Math.random() * 2.4).toFixed(2)}s;--drift:${Math.round(Math.random() * 160 - 80)}px`;
      return `<i style="${style}"></i>`;
    }).join("");
    const items = opts.section?.items.slice(0, 8) ?? [];
    root.innerHTML = `
      <div class="confetti" aria-hidden="true">${confetti}</div>
      <div class="strip">
        <div class="row">
          <p class="kicker">${esc(opts.heading)}</p>
          <p class="version">${opts.version ? esc(opts.version) : "&#127881;"}</p>
          <button type="button" class="pixel-btn go">Let's go</button>
        </div>
        ${items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}
      </div>`;
    const strip = root.querySelector<HTMLElement>(".strip")!;
    for (const ev of ["pointerdown", "wheel"] as const)
      strip.addEventListener(ev, (e) => e.stopPropagation());
    strip.addEventListener("click", () => this.close());
    window.addEventListener("keydown", this.onKey);
    this.host.append(root);
    this.el = root;
    if (!items.length) this.timer = setTimeout(() => this.close(), AUTO_CLOSE_MS);
  }

  /** Swap in the version once the server knows it. */
  setVersion(version: string) {
    const v = this.el?.querySelector(".version");
    if (v) v.textContent = version;
  }

  close() {
    clearTimeout(this.timer);
    window.removeEventListener("keydown", this.onKey);
    this.el?.remove();
    this.el = null;
  }
}
