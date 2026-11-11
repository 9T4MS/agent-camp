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
const AUTO_CLOSE_MS = 20_000;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/`([^`]+)`/g, "<code>$1</code>");

/**
 * The full-screen "new version" banner: confetti, the version, and the newest changelog
 * section. Closes on a click, Escape, or by itself after 20 s (wall screens have nobody to click).
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

  show(opts: { heading: string; version: string | null; section: ChangelogSection | undefined }) {
    this.close();
    const root = document.createElement("div");
    root.className = "celebration";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", opts.heading);
    const confetti = Array.from({ length: 80 }, (_, i) => {
      const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      const style = `left:${Math.random() * 100}%;background:${color};animation-delay:${(Math.random() * 2.5).toFixed(2)}s;animation-duration:${(2.8 + Math.random() * 2.4).toFixed(2)}s;--drift:${Math.round(Math.random() * 160 - 80)}px`;
      return `<i style="${style}"></i>`;
    }).join("");
    const items = opts.section?.items.slice(0, 8) ?? [];
    root.innerHTML = `
      <div class="confetti" aria-hidden="true">${confetti}</div>
      <div class="card pixel-box">
        <p class="kicker">${esc(opts.heading)}</p>
        <p class="version">${opts.version ? esc(opts.version) : "&#127881;"}</p>
        ${
          items.length
            ? `<p class="since">${esc(opts.section!.title)}</p><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
            : ""
        }
        <button type="button" class="pixel-btn go">Let's go</button>
      </div>`;
    for (const ev of ["pointerdown", "wheel"] as const)
      root.addEventListener(ev, (e) => e.stopPropagation());
    root.addEventListener("click", (e) => {
      const card = root.querySelector(".card");
      if (!card?.contains(e.target as Node) || (e.target as Element).closest(".go")) this.close();
    });
    window.addEventListener("keydown", this.onKey);
    this.host.append(root);
    this.el = root;
    root.querySelector<HTMLButtonElement>(".go")?.focus({ preventScroll: true });
    this.timer = setTimeout(() => this.close(), AUTO_CLOSE_MS);
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
