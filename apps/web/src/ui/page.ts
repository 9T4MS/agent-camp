/**
 * Shared chrome for the small DOM pages (/stats, /timelapse): top bar in the office HUD style
 * plus tiny helpers. Deliberately imports nothing heavy (no Pixi, no zod).
 */
import "./theme.css";
import "./pages.css";

export const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const params = new URLSearchParams(location.search);

/** Link back to the office, keeping a viewer `?key=` if the page was opened with one. */
export function officeHref(): string {
  const key = params.get("key");
  return key ? `./?key=${encodeURIComponent(key)}` : "./";
}

export type PageNav = "stats" | "timelapse";

/** Render the top bar + an empty <main> and return the main element. */
export function pageShell(title: string, current: PageNav, actions = ""): HTMLElement {
  document.title = `Agent Office · ${title}`;
  const host = document.getElementById("app")!;
  host.className = "page";
  const nav = (id: PageNav, label: string) =>
    `<a class="pixel-btn${id === current ? " on" : ""}" href="./${id}"${id === current ? ' aria-current="page"' : ""}>${label}</a>`;
  host.innerHTML = `
    <header class="page-top">
      <a class="brand" href="${officeHref()}" title="Back to the office">
        <img alt="" src="./icons/icon-192.png" width="20" height="20">
        <span>Agent Office</span>
      </a>
      <h1 class="pixel-title">${esc(title)}</h1>
      <div class="page-actions">${actions}</div>
      <nav class="page-nav">
        ${nav("stats", "Stats")}
        ${nav("timelapse", "Timelapse")}
        <a class="pixel-btn back" href="${officeHref()}">&larr; Office</a>
      </nav>
    </header>
    <main class="page-main"></main>`;
  return host.querySelector<HTMLElement>(".page-main")!;
}

/** A pixel-box card with a title. */
export function card(title: string, body: string, extraClass = ""): string {
  return `<section class="pixel-box card ${extraClass}">
    <h2 class="pixel-title card-title">${esc(title)}</h2>
    ${body}
  </section>`;
}

/** Centered message box (loading / empty / error). */
export function notice(title: string, html: string, tone: "info" | "error" = "info"): string {
  return `<section class="pixel-box notice ${tone}">
    <img alt="" src="./icons/icon-192.png" width="64" height="64">
    <h2 class="pixel-title">${esc(title)}</h2>
    <div>${html}</div>
  </section>`;
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}
