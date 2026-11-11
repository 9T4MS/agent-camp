/**
 * /stats: weekday x hour heatmap of sessions started, agent split, leaderboards.
 * Data: GET /api/stats?days=N (StatsResponse). Range comes from ?days= (7 / 30 / all).
 * Imports only the zod-free protocol constants to keep this page tiny.
 */
import type { StatsResponse } from "../../../packages/protocol/src/api.ts";
import { AGENT_COLORS } from "../../../packages/protocol/src/constants.ts";
import { card, esc, getJson, notice, pageShell } from "./ui/page.ts";

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 0, label: "All time" },
] as const;

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
  design: "Design",
  unknown: "Other",
};

/** Endesga ramp, cold-empty to hot: ink, cocoa, bark, rust, orange, amber, lemon. */
const HEAT_RAMP = [
  "#262b44",
  "#3e2731",
  "#733e39",
  "#be4a2f",
  "#f77622",
  "#feae34",
  "#fee761",
] as const;

/** Bucket a count into the ramp (0 always maps to the empty color). */
function heatColor(value: number, max: number): string {
  if (value <= 0 || max <= 0) return HEAT_RAMP[0];
  const steps = HEAT_RAMP.length - 1;
  const i = Math.min(steps, Math.max(1, Math.ceil((value / max) * steps)));
  return HEAT_RAMP[i]!;
}

const params = new URLSearchParams(location.search);
const daysParam = params.get("days");
const days = daysParam === null ? 7 : Math.max(0, Math.floor(Number(daysParam) || 0));

const fmtNum = (n: number) => n.toLocaleString("en-US");
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;

function rangeButtons(): string {
  const btns = RANGES.map((r) => {
    const href = r.days === 7 ? "?days=7" : `?days=${r.days}`;
    return `<a class="pixel-btn${r.days === days ? " on" : ""}" href="${href}">${r.label}</a>`;
  }).join("");
  return `${btns}<a class="pixel-btn" href="/api/history.csv" download title="Every history row as CSV (no content, just events)">&darr; CSV</a>`;
}

function heatmap(s: StatsResponse): string {
  const max = Math.max(0, ...s.heatmap.flat());
  const hours = Array.from({ length: 24 }, (_, h) =>
    h % 3 === 0 ? `<div class="hr">${String(h).padStart(2, "0")}</div>` : `<div class="hr"></div>`,
  ).join("");
  const rows = s.heatmap
    .map((row, d) => {
      const day = s.weekdays[d] ?? String(d);
      const cells = row
        .map((v, h) => {
          const tip = `${day} ${hourLabel(h)}–${hourLabel((h + 1) % 24)}: ${plural(v, "session")} started`;
          return `<div class="cell" style="background:${heatColor(v, max)}" title="${esc(tip)}"></div>`;
        })
        .join("");
      return `<div class="lab">${esc(day)}</div>${cells}`;
    })
    .join("");
  const legend = HEAT_RAMP.map((c) => `<i style="background:${c}"></i>`).join("");
  return card(
    "Sessions started · weekday × hour",
    `<div class="heat" role="img" aria-label="Heatmap of sessions started by weekday and hour">
      <div></div>${hours}${rows}
    </div>
    <div class="heat-foot">
      <span class="muted">Hours in ${esc(s.timezone)} · busiest hour: ${max > 0 ? plural(max, "session") : "none yet"}</span>
      <div class="legend"><span>less</span>${legend}<span>more</span></div>
    </div>`,
    "heat-card",
  );
}

function agentSplit(s: StatsResponse): string {
  const entries = Object.entries(s.agentSplit).filter(([, v]) => v > 0);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  const color = (k: string) => AGENT_COLORS[k as keyof typeof AGENT_COLORS] ?? AGENT_COLORS.unknown;
  if (total === 0)
    return card("Claude vs Codex vs Pi", `<p class="board-empty">No sessions in this range.</p>`);
  const order = ["claude", "codex", "pi", "design", "unknown"];
  entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  const pct = (v: number) => Math.round((v / total) * 1000) / 10;
  const bar = entries
    .map(
      ([k, v]) =>
        `<i style="width:${(v / total) * 100}%;background:${color(k)}" title="${esc(AGENT_LABELS[k] ?? k)}: ${fmtNum(v)} (${pct(v)}%)"></i>`,
    )
    .join("");
  const legend = entries
    .map(
      ([k, v]) =>
        `<div><span class="dot" style="background:${color(k)}"></span>${esc(AGENT_LABELS[k] ?? k)} <b>${pct(v)}%</b><span class="muted">${fmtNum(v)}</span></div>`,
    )
    .join("");
  return card(
    "Claude vs Codex vs Pi",
    `<div class="split-bar">${bar}</div><div class="split-legend">${legend}</div>`,
  );
}

function board(
  title: string,
  entries: { key: string; value: number }[],
  name: (key: string) => string,
  unit: (v: number) => string,
  barColor: string,
): string {
  if (entries.length === 0) return card(title, `<p class="board-empty">Nobody yet.</p>`);
  const max = Math.max(...entries.map((e) => e.value), 1);
  const items = entries
    .map(
      (e, i) => `<li title="${esc(`${name(e.key)}: ${unit(e.value)}`)}">
        <span class="rank">${i + 1}</span>
        <span class="who">${esc(name(e.key))}</span>
        <span class="val">${fmtNum(e.value)}</span>
        <span class="bar"><i style="width:${(e.value / max) * 100}%;background:${barColor}"></i></span>
      </li>`,
    )
    .join("");
  return card(title, `<ol class="board">${items}</ol>`);
}

const mins = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** Today's wall of shame: a WANTED poster for each crime's top offender, runners-up below. */
function shameWall(s: StatsResponse, person: (id: string) => string): string {
  const sh = s.shame;
  if (!sh) return "";
  const crimes = [
    { title: "Serial /clearer", list: sh.clears, fmt: (v: number) => plural(v, "/clear") },
    { title: "Left an agent hanging", list: sh.waits, fmt: (v: number) => `waited ${mins(v)}` },
    { title: "Arsonist", list: sh.fires, fmt: (v: number) => plural(v, "fire") },
  ];
  const posters = crimes
    .map((c) => {
      const [top, ...rest] = c.list;
      if (!top)
        return `<div class="wanted empty"><div class="w-head">WANTED</div><div class="w-crime">${esc(c.title)}</div><div class="w-name">nobody… yet</div></div>`;
      const others = rest
        .map((e) => `<li>${esc(person(e.key))} <span>${esc(c.fmt(e.value))}</span></li>`)
        .join("");
      return `<div class="wanted"><div class="w-head">WANTED</div>
        <div class="w-name">${esc(person(top.key))}</div>
        <div class="w-crime">${esc(c.title)}</div>
        <div class="w-proof">${esc(c.fmt(top.value))}</div>
        <div class="w-reward">reward: 1 coffee</div>
        ${others ? `<ol class="w-rest">${others}</ol>` : ""}</div>`;
    })
    .join("");
  return card("Wall of shame · today", `<div class="shame">${posters}</div>`);
}

function render(main: HTMLElement, s: StatsResponse) {
  // names only exist for people seen live since the last deploy; prettify the slug otherwise
  const person = (id: string) =>
    s.names[id] ?? id.replace(/-/g, " ").replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  const project = (p: string) => p;
  if (!s.range || s.totalSessions === 0) {
    main.innerHTML = notice(
      days > 0 ? `Nothing in the last ${days} days` : "No history yet",
      `<p>Stats fill up as teammates run Claude, Codex and Pi with the connector installed.</p>
       <p class="muted">Developing? Fake a week with <code>bun run sim -- --backfill-week</code>.</p>
       ${days > 0 ? `<p><a class="pixel-btn" href="?days=0">Show all time</a></p>` : ""}`,
    );
    return;
  }
  const dayTotals = s.heatmap.map((row) => row.reduce((a, b) => a + b, 0));
  const busiestDay = dayTotals.indexOf(Math.max(...dayTotals));
  const fmtDate = (ts: number) =>
    new Date(ts).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: s.timezone,
    });
  main.innerHTML = `
    <div class="summary">
      <span class="pixel-chip"><span class="num">${fmtNum(s.totalSessions)}</span><span class="lbl">sessions</span></span>
      <span class="pixel-chip"><span class="num">${fmtNum(s.totalSubagents)}</span><span class="lbl">subagents</span></span>
      <span class="pixel-chip"><span class="lbl">busiest day</span><span class="num">${esc(s.weekdays[busiestDay] ?? "-")}</span></span>
      <span class="pixel-chip"><span class="lbl">${fmtDate(s.range.from)} – ${fmtDate(s.range.to)}</span></span>
    </div>
    ${shameWall(s, person)}
    ${heatmap(s)}
    ${agentSplit(s)}
    <div class="boards">
      ${board("Most sessions", s.leaderboards.mostSessions, person, (v) => plural(v, "session"), "var(--amber)")}
      ${board("Most agents at once", s.leaderboards.mostParallel, person, (v) => `${v} in parallel`, "var(--sky)")}
      ${board("Most subagents", s.leaderboards.mostSubagents, person, (v) => plural(v, "subagent"), "var(--leaf)")}
      ${board("Busiest project", s.leaderboards.busiestProjects, project, (v) => plural(v, "session"), "var(--berry)")}
    </div>
    <footer class="stats-foot">
      <span>Only events are stored: who, which agent, project folder name, subagent counts. Never content.</span>
      <span>Updated ${new Date(s.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
    </footer>`;
}

async function main() {
  const main = pageShell("Stats", "stats", rangeButtons());
  main.innerHTML = `<p class="muted" style="text-align:center">Loading…</p>`;
  try {
    const s = await getJson<StatsResponse>(`/api/stats${days > 0 ? `?days=${days}` : ""}`);
    render(main, s);
  } catch (err) {
    main.innerHTML = notice(
      "Stats unavailable",
      `<p>Could not load <code>/api/stats</code>.</p><p class="muted">${esc(String(err))}</p>`,
      "error",
    );
  }
  document.body.dataset.ready = "1";
}

void main();
