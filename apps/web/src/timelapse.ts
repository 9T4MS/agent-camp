/**
 * /timelapse: gallery of the recorder's office snapshots (GET /api/snapshots) and a player
 * that steps through them full-size (play/pause, prev/next, scrubber, speed, arrow keys).
 */
import type { SnapshotList, SnapshotMeta } from "../../../packages/protocol/src/api.ts";
import { card, esc, getJson, notice, pageShell } from "./ui/page.ts";

const SPEEDS = [1, 2, 4, 8, 15] as const;
const params = new URLSearchParams(location.search);
const key = params.get("key");

const fmtStamp = (ts: number) =>
  new Date(ts).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const fmtShort = (ts: number) =>
  new Date(ts).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

function emptyState(main: HTMLElement) {
  const kiosk = `${location.origin}/?kiosk=1&recorder=1${key ? `&key=${encodeURIComponent(key)}` : ""}`;
  main.innerHTML = notice(
    "No frames yet",
    `<p>The timelapse is recorded by a kiosk screen: open
       <code>${esc(kiosk)}</code> (the iPad home-screen app does this) and every 15 minutes,
       while someone is in the office, it uploads a small picture of the whole floor.</p>
     <p class="muted">Developing? <code>bun run sim -- --snapshots 12</code> uploads test frames.</p>`,
  );
}

function render(main: HTMLElement, frames: SnapshotMeta[]) {
  let index = frames.length - 1;
  let speed = 4;
  let timer: ReturnType<typeof setInterval> | undefined;

  const speedOpts = SPEEDS.map(
    (s) => `<option value="${s}"${s === speed ? " selected" : ""}>${s} fps</option>`,
  ).join("");
  const thumbs = frames
    .map(
      (
        f,
        i,
      ) => `<button class="thumb" data-i="${i}" title="${esc(fmtStamp(f.ts))} · ${Math.round(f.size / 1024)} KB">
        <img loading="lazy" alt="Office at ${esc(fmtStamp(f.ts))}" src="${esc(f.url)}">
        <span>${esc(fmtShort(f.ts))}</span>
      </button>`,
    )
    .join("");
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  main.innerHTML = `
    ${card(
      `Timelapse · ${frames.length} frame${frames.length === 1 ? "" : "s"}`,
      `<div class="player">
        <div class="screen"><img alt="" class="frame"><span class="pixel-chip stamp"></span></div>
        <div class="controls">
          <button class="pixel-btn play" title="Play / pause (space)">&#9654; Play</button>
          <button class="pixel-btn prev" title="Previous frame (&larr;)">&lsaquo;</button>
          <button class="pixel-btn next" title="Next frame (&rarr;)">&rsaquo;</button>
          <input type="range" class="scrub" min="0" max="${frames.length - 1}" step="1" aria-label="Frame">
          <span class="count"></span>
          <label class="muted">Speed <select class="speed">${speedOpts}</select></label>
        </div>
      </div>`,
    )}
    ${card(`Frames · ${fmtShort(first.ts)} – ${fmtShort(last.ts)}`, `<div class="gallery">${thumbs}</div>`)}`;

  const $ = <T extends Element>(sel: string) => main.querySelector<T>(sel)!;
  const img = $<HTMLImageElement>(".frame");
  const stamp = $<HTMLElement>(".stamp");
  const scrub = $<HTMLInputElement>(".scrub");
  const count = $<HTMLElement>(".count");
  const playBtn = $<HTMLButtonElement>(".play");
  const thumbEls = [...main.querySelectorAll<HTMLButtonElement>(".thumb")];

  // warm the cache so playback doesn't flicker
  for (const f of frames) new Image().src = f.url;

  const show = (i: number) => {
    index = (i + frames.length) % frames.length;
    const f = frames[index]!;
    img.src = f.url;
    img.alt = `Office at ${fmtStamp(f.ts)}`;
    stamp.textContent = fmtStamp(f.ts);
    scrub.value = String(index);
    count.textContent = `${index + 1} / ${frames.length}`;
    thumbEls.forEach((t, j) => {
      t.classList.toggle("on", j === index);
    });
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    playBtn.innerHTML = "&#9654; Play";
  };
  const play = () => {
    stop();
    if (index >= frames.length - 1) show(0);
    timer = setInterval(() => {
      if (index >= frames.length - 1) return stop();
      show(index + 1);
    }, 1000 / speed);
    playBtn.innerHTML = "&#10074;&#10074; Pause";
  };
  const toggle = () => (timer ? stop() : play());

  playBtn.addEventListener("click", toggle);
  $(".prev").addEventListener("click", () => {
    stop();
    show(index - 1);
  });
  $(".next").addEventListener("click", () => {
    stop();
    show(index + 1);
  });
  scrub.addEventListener("input", () => {
    stop();
    show(Number(scrub.value));
  });
  $<HTMLSelectElement>(".speed").addEventListener("change", (e) => {
    speed = Number((e.target as HTMLSelectElement).value) || 4;
    if (timer) play();
  });
  for (const t of thumbEls) {
    t.addEventListener("click", () => {
      stop();
      show(Number(t.dataset.i));
      main.querySelector(".player")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
  window.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest("input, select")) return;
    if (e.key === " ") {
      e.preventDefault();
      toggle();
    } else if (e.key === "ArrowLeft") {
      stop();
      show(index - 1);
    } else if (e.key === "ArrowRight") {
      stop();
      show(index + 1);
    }
  });
  show(index);
}

async function main() {
  const main = pageShell("Timelapse", "timelapse");
  main.innerHTML = `<p class="muted" style="text-align:center">Loading…</p>`;
  try {
    const list = await getJson<SnapshotList>("/api/snapshots");
    const frames = [...list.snapshots].sort((a, b) => a.ts - b.ts || a.id - b.id);
    if (frames.length === 0) emptyState(main);
    else render(main, frames);
  } catch (err) {
    main.innerHTML = notice(
      "Timelapse unavailable",
      `<p>Could not load <code>/api/snapshots</code>.</p><p class="muted">${esc(String(err))}</p>`,
      "error",
    );
  }
  document.body.dataset.ready = "1";
}

void main();
