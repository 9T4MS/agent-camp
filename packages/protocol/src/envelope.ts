/**
 * Versioned message envelope shared by every channel:
 *   { v: 1, type: "domain.verbPastTense", id: <ulid>, ts: <epoch ms>, data: {...} }
 */
import { PROTOCOL_VERSION } from "./constants.ts";
import type { AnyMessage, MessageData, MessageType } from "./messages.ts";

export type Envelope<T extends string = string, D = unknown> = {
  /** protocol version */
  v: typeof PROTOCOL_VERSION;
  /** "domain.verbPastTense" for facts, "domain.verb" for commands */
  type: T;
  /** ulid; unique and lexicographically time-sortable */
  id: string;
  /** epoch ms, sender clock */
  ts: number;
  data: D;
};

// ---- ulid ---------------------------------------------------------------------------------
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b & 31);
}

/**
 * Dependency-free monotonic ULID (26 chars, Crockford base32): 10 chars of ms timestamp +
 * 16 random chars. Within the same millisecond the random part is incremented, so ids are
 * strictly increasing per process.
 */
export function ulid(now: number = Date.now()): string {
  let rand: number[];
  if (now === lastTime) {
    rand = lastRandom.slice();
    let i = rand.length - 1;
    while (i >= 0 && rand[i] === 31) {
      rand[i] = 0;
      i--;
    }
    if (i >= 0) rand[i] = (rand[i] ?? 0) + 1;
  } else {
    rand = randomDigits();
  }
  lastTime = now;
  lastRandom = rand;

  let t = Math.max(0, Math.floor(now));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + rand.map((d) => CROCKFORD[d]).join("");
}

/** Extract the epoch-ms timestamp encoded in a ULID. */
export function ulidTime(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, 10).toUpperCase()) t = t * 32 + CROCKFORD.indexOf(ch);
  return t;
}

/**
 * Build a fully typed protocol message. `type` is checked against every known message type
 * and `data` must match that type's payload:
 *   envelope("presence.snapshot", { sessions: [] })
 * Note: this does not validate at runtime; senders are trusted to pass well-typed data.
 */
export function envelope<T extends MessageType>(
  type: T,
  data: MessageData<T>,
  opts: { id?: string; ts?: number } = {},
): Extract<AnyMessage, { type: T }> {
  const ts = opts.ts ?? Date.now();
  return {
    v: PROTOCOL_VERSION,
    type,
    id: opts.id ?? ulid(ts),
    ts,
    data,
  } as Extract<AnyMessage, { type: T }>;
}
