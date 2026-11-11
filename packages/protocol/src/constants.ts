import { hashString } from "./hash.ts";

/** Wire protocol version; goes into every envelope's `v` field. */
export const PROTOCOL_VERSION = 1 as const;

/** WebSocket close codes the server uses when rejecting a connector. */
export const CLOSE_BAD_PASSWORD = 4001;
export const CLOSE_TOO_OLD = 4002;
/** Malformed / schema-invalid message (not in PLAN, but handy). */
export const CLOSE_BAD_MESSAGE = 4003;

/** WebSocket paths. */
export const WS_CONNECTOR_PATH = "/ws/connector";
export const WS_VIEWER_PATH = "/ws/viewer";

// ---- timing -------------------------------------------------------------------------------
/** Connector debounces snapshot sends by this much after a change. */
export const SNAPSHOT_DEBOUNCE_MS = 500;
/** Connector re-sends its snapshot at least this often (heartbeat). */
export const HEARTBEAT_MS = 30_000;
/** Server shows a connector's sessions as offline after this long without any message. */
export const CONNECTOR_STALE_MS = 45_000;
/** Server treats a connector as gone after this long without any message. */
export const CONNECTOR_TIMEOUT_MS = 180_000;
/** After a person's last connector is gone, wait this long before `person.left`. */
export const PERSON_GRACE_MS = 60_000;
/** Reconnect backoff bounds (exponential with jitter), both sides. */
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** Detector poll interval and liveness window (see PLAN "How to detect sessions"). */
export const DETECT_POLL_MS = 2_000;
export const TRANSCRIPT_LIVE_MS = 90_000;
export const SUBAGENT_LIVE_MS = 60_000;
export const IDLE_AFTER_MS = 120_000;

/** Exponential backoff with full jitter: attempt 0 -> ~1s, capped at 30s. */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
  return Math.round(BACKOFF_MIN_MS / 2 + rand() * (ceiling - BACKOFF_MIN_MS / 2));
}

// ---- palette ------------------------------------------------------------------------------
/** The Endesga 32 palette (https://lospec.com/palette-list/endesga-32), in canonical order. */
export const PALETTE = [
  "#be4a2f",
  "#d77643",
  "#ead4aa",
  "#e4a672",
  "#b86f50",
  "#733e39",
  "#3e2731",
  "#a22633",
  "#e43b44",
  "#f77622",
  "#feae34",
  "#fee761",
  "#63c74d",
  "#3e8948",
  "#265c42",
  "#193c3e",
  "#124e89",
  "#0099db",
  "#2ce8f5",
  "#ffffff",
  "#c0cbdc",
  "#8b9bb4",
  "#5a6988",
  "#3a4466",
  "#262b44",
  "#181425",
  "#ff0044",
  "#68386c",
  "#b55088",
  "#f6757a",
  "#e8b796",
  "#c28569",
] as const;
export type PaletteColor = (typeof PALETTE)[number];

/** Jacket color per agent kind (fixed by PLAN). All from Endesga 32. */
export const AGENT_COLORS = {
  claude: "#be4a2f",
  codex: "#0099db",
  pi: "#63c74d",
  unknown: "#8b9bb4",
} as const satisfies Record<string, PaletteColor>;

/** Three-step ramps for shading jackets (light / main / shade). */
export const AGENT_PALETTES = {
  claude: { light: "#d77643", main: "#be4a2f", shade: "#733e39" },
  codex: { light: "#2ce8f5", main: "#0099db", shade: "#124e89" },
  pi: { light: "#fee761", main: "#63c74d", shade: "#3e8948" },
  unknown: { light: "#c0cbdc", main: "#8b9bb4", shade: "#5a6988" },
} as const satisfies Record<keyof typeof AGENT_COLORS, Record<string, PaletteColor>>;

// ---- helpers ------------------------------------------------------------------------------
/**
 * Stable person id from a display name: lowercase ASCII slug ("Anna Müller" -> "anna-muller").
 * Two laptops with the same name map to the same person. Names with no slug-able
 * characters fall back to "p-<hash>".
 */
export function personIdFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : `p-${hashString(name.trim()).toString(36)}`;
}

/**
 * Compare dotted numeric versions like "0.1.42" (optional leading "v", missing parts = 0,
 * non-numeric parts = 0). Returns -1, 0 or 1.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .slice(0, 3)
      .map((p) => {
        const n = Number.parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
