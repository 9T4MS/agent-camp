/** Tiny "coming soon" page in the office style, used by stats.html / timelapse.html stubs. */
import { iconUrl } from "../art/icons.ts";

export function placeholder(title: string, text: string) {
  const host = document.getElementById("app")!;
  host.style.cssText =
    "min-height:100%;display:grid;place-items:center;padding:24px;background:var(--ink)";
  host.innerHTML = `
    <section class="pixel-box" style="padding:24px 28px;max-width:420px;text-align:center">
      <img alt="" src="${iconUrl("logo")}" style="width:64px;height:64px;image-rendering:pixelated">
      <h1 class="pixel-title" style="color:var(--amber);font-size:22px;margin:12px 0 6px">${title}</h1>
      <p style="margin:0 0 16px">${text}</p>
      <a class="pixel-btn" href="./" style="text-decoration:none;display:inline-block">Back to the office</a>
    </section>`;
  document.title = `Agent Office · ${title}`;
}
