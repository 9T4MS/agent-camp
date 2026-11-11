/**
 * Decision logic for the "Head GIF" section of your own person card (set / change / remove the
 * GIF over your head). Pure: no DOM, so it is unit tested.
 */
import { ApiError, parseGiphyId } from "@agent-office/protocol";

// ---- link input -----------------------------------------------------------------------------

export type GifInputCheck =
  | { state: "empty" }
  | { state: "invalid"; hint: string }
  | { state: "same"; id: string; hint: string }
  | { state: "valid"; id: string };

export const HINT_INVALID = "That's not a Giphy GIF link";
export const HINT_SAME = "Already the current GIF";

/** What the pasted text means: nothing yet, not a Giphy GIF, the GIF already set, or a new one. */
export function validateGifInput(
  input: string,
  currentGif: string | null | undefined,
): GifInputCheck {
  if (!input.trim()) return { state: "empty" };
  const id = parseGiphyId(input);
  if (!id) return { state: "invalid", hint: HINT_INVALID };
  if (id === currentGif) return { state: "same", id, hint: HINT_SAME };
  return { state: "valid", id };
}

// ---- PUT /api/people/:personId/gif result -------------------------------------------------------

/** What the injected `putGif` callback reports: the HTTP status (0 = no response) and JSON body. */
export type PutGifResult = { status: number; body: unknown };

export type SaveOutcome =
  /** 200: the server broadcasts `gif.updated`; the card follows the model, not this response */
  { kind: "saved" } | { kind: "error"; message: string };

export const MSG_LOGGED_OUT = "Your login ran out. Reload the page and sign in again.";
export const MSG_NOT_YOU = "Only you can change your GIF: confirm it's you first.";
export const MSG_NOT_FOUND = "Not in the office right now";
export const MSG_NETWORK = "Couldn't reach the office. Check your connection and try again.";

const serverError = (body: unknown): string | null => {
  const e = ApiError.safeParse(body);
  return e.success && e.data.error.trim() ? e.data.error.trim().slice(0, 200) : null;
};

/** Map a save attempt's HTTP status + body to what the card shows. */
export function saveOutcome({ status, body }: PutGifResult): SaveOutcome {
  if (status >= 200 && status < 300) return { kind: "saved" };
  if (status === 401) return { kind: "error", message: MSG_LOGGED_OUT };
  if (status === 403) return { kind: "error", message: MSG_NOT_YOU };
  if (status === 404) return { kind: "error", message: MSG_NOT_FOUND };
  if (status === 0) return { kind: "error", message: MSG_NETWORK };
  if (status === 400) return { kind: "error", message: serverError(body) ?? "That didn't work" };
  return {
    kind: "error",
    message: serverError(body) ?? `Something went wrong (HTTP ${status}). Try again.`,
  };
}
