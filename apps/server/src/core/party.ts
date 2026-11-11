/** Server-owned party actions and scores. Equipment belongs to the canonical avatar. */
import {
  type AvatarSpec,
  type PartyEvent,
  PartyMutation,
  type PartyState,
} from "@agent-office/protocol";
import { z } from "zod";
import type { Store } from "./store.ts";

export const PARTY_BODY_MAX_BYTES = 8 * 1024;
export const PARTY_COOLDOWN_MS = 1200;
export const PARTY_REQUEST_INTERVAL_MS = 1200;
export const PARTY_EVENT_TTL_MS = 15_000;
export const PARTY_MAX_REQUESTERS = 512;
const STORAGE_KEY = "party.v1";
const MAX_PARTICIPANTS = 1000;
const MAX_SCORE = 1_000_000;
const Times = z.record(z.string().max(128), z.number().int().nonnegative());
// z.object strips the former parallel wardrobe when loading an older party record.
const StoredParty = z.object({
  scores: z
    .record(z.string(), z.number().int().nonnegative())
    .refine((r) => Object.keys(r).length <= MAX_PARTICIPANTS),
  cooldowns: Times.default({}).refine((r) => Object.keys(r).length <= MAX_PARTICIPANTS),
});
type PartyResult = { status: number; body: PartyState | { error: string }; retryAfter?: number };

export class Party {
  private scores: Record<string, number> = Object.create(null);
  private events: PartyEvent[] = [];
  private lastAction = new Map<string, number>();
  private requests = new Map<string, number>();

  constructor(private store: Store) {
    try {
      const raw = store.kvGet(STORAGE_KEY);
      const parsed = StoredParty.safeParse(raw ? JSON.parse(raw) : null);
      if (parsed.success) {
        this.scores = Object.assign(Object.create(null), parsed.data.scores);
        this.lastAction = new Map(Object.entries(parsed.data.cooldowns));
        // Drop obsolete cosmetic data from the old record on migration.
        if (
          raw &&
          Object.keys(JSON.parse(raw)).some((key) => key !== "scores" && key !== "cooldowns")
        )
          this.persist();
      }
    } catch {
      /* Optional party data must never stop office presence. */
    }
  }

  /** Apply before reading a body, including malformed/unauthorized POST attempts. */
  requestAllowed(requester: string, now: number): number | null {
    for (const [key, at] of this.requests)
      if (now - at >= PARTY_REQUEST_INTERVAL_MS) this.requests.delete(key);
    const key = requester.slice(0, 128);
    const at = this.requests.get(key);
    if (at !== undefined)
      return Math.max(1, Math.ceil((at + PARTY_REQUEST_INTERVAL_MS - now) / 1000));
    if (this.requests.size >= PARTY_MAX_REQUESTERS) {
      const firstExpiry = Math.min(...this.requests.values()) + PARTY_REQUEST_INTERVAL_MS;
      return Math.max(1, Math.ceil((firstExpiry - now) / 1000));
    }
    this.requests.set(key, now);
    return null;
  }

  state(now: number): PartyState {
    this.events = this.events.filter((event) => now - event.at < PARTY_EVENT_TTL_MS).slice(-32);
    for (const [personId, at] of this.lastAction)
      if (now - at >= PARTY_COOLDOWN_MS) this.lastAction.delete(personId);
    return { scores: { ...this.scores }, events: [...this.events] };
  }

  mutate(input: unknown, online: ReadonlyMap<string, AvatarSpec>, now: number): PartyResult {
    const parsed = PartyMutation.safeParse(input);
    const error = (status: number, message: string): PartyResult => ({
      status,
      body: { error: message },
    });
    if (!parsed.success) return error(400, "Invalid party action");
    const { personId, action, targetId, hand } = parsed.data;
    const avatar = online.get(personId);
    if (!avatar) return error(404, "Choose someone currently in the office");
    if (targetId && !online.has(targetId)) return error(404, "Target is no longer in the office");
    if ((action === "tag" || action === "high-five") && (!targetId || targetId === personId))
      return error(400, "Choose another person for this action");
    const item =
      hand === "left"
        ? avatar.leftHand
        : hand === "right"
          ? avatar.rightHand
          : avatar.rightHand !== "none"
            ? avatar.rightHand
            : avatar.leftHand;
    if (action === "use" && item === "none") return error(400, "Equip an item in that hand first");
    if (action === "race" && avatar.vehicle === "none") return error(400, "Equip a vehicle first");
    this.state(now);
    const last = this.lastAction.get(personId);
    if (last !== undefined && now - last < PARTY_COOLDOWN_MS)
      return {
        ...error(429, "Give your character a moment before the next action"),
        retryAfter: Math.max(1, Math.ceil((last + PARTY_COOLDOWN_MS - now) / 1000)),
      };
    const tracked = new Set([...Object.keys(this.scores), ...this.lastAction.keys()]);
    const added = [personId, ...(action === "high-five" && targetId ? [targetId] : [])].filter(
      (id) => !tracked.has(id),
    );
    if (tracked.size + added.length > MAX_PARTICIPANTS)
      return error(409, "The office party is full");
    this.lastAction.set(personId, now);
    const event: PartyEvent = {
      id: crypto.randomUUID(),
      personId,
      action,
      item,
      vehicle: avatar.vehicle,
      at: now,
      ...(targetId ? { targetId } : {}),
    };
    if (action === "race") event.roll = 1 + Math.floor(Math.random() * 6);
    if (action === "race" || action === "tag" || action === "high-five") {
      this.scores[personId] = Math.min(MAX_SCORE, (this.scores[personId] ?? 0) + (event.roll ?? 1));
      if (action === "high-five" && targetId)
        this.scores[targetId] = Math.min(MAX_SCORE, (this.scores[targetId] ?? 0) + 1);
    }
    this.events.push(event);
    this.persist();
    return { status: 200, body: this.state(now) };
  }

  private persist(): void {
    this.store.kvPut(
      STORAGE_KEY,
      JSON.stringify({ scores: this.scores, cooldowns: Object.fromEntries(this.lastAction) }),
    );
  }
}

/** Bound actual bytes, including chunked uploads with no Content-Length header. */
export async function readPartyBody(
  req: Request,
  maxBytes = PARTY_BODY_MAX_BYTES,
): Promise<{ value?: unknown; status?: number }> {
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) return { status: 413 };
  if (!req.body) return { status: 400 };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { status: 413 };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { status: 400 };
  } finally {
    reader.releaseLock();
  }
}
