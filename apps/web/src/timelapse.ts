/**
 * /timelapse: gallery of the recorder's office snapshots (GET /api/snapshots) and a player
 * that steps through them full-size (play/pause, prev/next, scrubber, speed, arrow keys).
 */
import type { SnapshotList, SnapshotMeta } from "../../../packages/protocol/src/api.ts";
import {
  ALL_DAYS,
  filterFrames,
  normalizeDay,
  preloadFrames,
  selectedFrameIndex,
  sortFrames,
} from "./state/timelapseFrames.ts";
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

function render(
  main: HTMLElement,
  frames: SnapshotMeta[],
  selectedId: number | undefined,
  onSelect: (id: number) => void,
): () => void {
  if (frames.length === 0) {
    main.innerHTML = notice("No frames for this day", "<p>Choose another day or All.</p>");
    return () => {};
  }
  let index = selectedFrameIndex(frames, selectedId);
  let speed = 4;
  let timer: ReturnType<typeof setInterval> | undefined;
  const events = new AbortController();
  const listenerOptions = { signal: events.signal };
  const preloaded = new Map<number, HTMLImageElement>();

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

  if (frames.length === 1) {
    for (const control of main.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      ".play, .prev, .next, .scrub",
    ))
      control.disabled = true;
  }

  const show = (i: number) => {
    index = (i + frames.length) % frames.length;
    const f = frames[index]!;
    onSelect(f.id);
    const preloadWindow = preloadFrames(frames, index);
    const ids = new Set(preloadWindow.map((frame) => frame.id));
    for (const id of preloaded.keys()) if (!ids.has(id)) preloaded.delete(id);
    for (const frame of preloadWindow) {
      if (preloaded.has(frame.id)) continue;
      const image = new Image();
      image.src = frame.url;
      preloaded.set(frame.id, image);
    }
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
    if (frames.length < 2) return;
    if (index >= frames.length - 1) show(0);
    timer = setInterval(() => {
      if (index >= frames.length - 1) return stop();
      show(index + 1);
    }, 1000 / speed);
    playBtn.innerHTML = "&#10074;&#10074; Pause";
  };
  const toggle = () => (timer ? stop() : play());

  playBtn.addEventListener("click", toggle, listenerOptions);
  $(".prev").addEventListener(
    "click",
    () => {
      stop();
      show(index - 1);
    },
    listenerOptions,
  );
  $(".next").addEventListener(
    "click",
    () => {
      stop();
      show(index + 1);
    },
    listenerOptions,
  );
  scrub.addEventListener(
    "input",
    () => {
      stop();
      show(Number(scrub.value));
    },
    listenerOptions,
  );
  $<HTMLSelectElement>(".speed").addEventListener(
    "change",
    (e) => {
      speed = Number((e.target as HTMLSelectElement).value) || 4;
      if (timer) play();
    },
    listenerOptions,
  );
  for (const t of thumbEls) {
    t.addEventListener(
      "click",
      () => {
        stop();
        show(Number(t.dataset.i));
        main.querySelector(".player")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      },
      listenerOptions,
    );
  }
  window.addEventListener(
    "keydown",
    (e) => {
      if (
        (e.target as Element | null)?.closest("input, select, textarea, button, [contenteditable]")
      )
        return;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stop();
        show(index - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stop();
        show(index + 1);
      }
    },
    listenerOptions,
  );
  show(index);
  return () => {
    stop();
    events.abort();
    preloaded.clear();
  };
}

function renderDays(main: HTMLElement, frames: SnapshotMeta[]) {
  let day = normalizeDay(params.get("day"));
  let selectedId: number | undefined;
  let dispose = () => {};
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  main.innerHTML = `
    ${card(
      "Recording day",
      `<div class="day-controls">
      <button class="pixel-btn all-days">All</button>
      <label>Day <input type="date" class="day" aria-label="Recording day"></label>
      <span class="muted">Browser-local time (${esc(timezone)})</span>
      <span class="day-count" role="status"></span>
    </div>`,
    )}
    <div class="timelapse-results"></div>`;
  const all = main.querySelector<HTMLButtonElement>(".all-days")!;
  const input = main.querySelector<HTMLInputElement>(".day")!;
  const count = main.querySelector<HTMLElement>(".day-count")!;
  const results = main.querySelector<HTMLElement>(".timelapse-results")!;
  const update = () => {
    dispose();
    const filtered = filterFrames(frames, day);
    all.classList.toggle("on", day === ALL_DAYS);
    all.setAttribute("aria-pressed", String(day === ALL_DAYS));
    input.value = day === ALL_DAYS ? "" : day;
    count.textContent = `${filtered.length} of ${frames.length} frames`;
    if (frames.length === 0) {
      emptyState(results);
    } else {
      dispose = render(results, filtered, selectedId, (id) => {
        selectedId = id;
      });
    }
  };
  all.addEventListener("click", () => {
    day = ALL_DAYS;
    update();
  });
  input.addEventListener("change", () => {
    day = normalizeDay(input.value);
    update();
  });
  update();
}

async function main() {
  const main = pageShell("Timelapse", "timelapse");
  main.innerHTML = `<p class="muted" style="text-align:center">Loading…</p>`;
  try {
    const list = await getJson<SnapshotList>("/api/snapshots");
    const frames = sortFrames(list.snapshots);
    renderDays(main, frames);
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
