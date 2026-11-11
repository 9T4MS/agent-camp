/** Server-owned wardrobe, short-lived shared actions and persistent party scores. */
import {
  DEFAULT_PARTY_LOOK,
  type PartyEvent,
  type PartyLook,
  PartyMutation,
  PartyState,
} from "@agent-office/protocol";
import type { Store } from "./store.ts";

export const PARTY_BODY_MAX_BYTES = 8 * 1024;
export const PARTY_COOLDOWN_MS = 1200;
export const PARTY_EVENT_TTL_MS = 15_000;
const STORAGE_KEY = "party.v1";
const MAX_PROFILES = 1000;
const MAX_SCORE = 1_000_000;

type PartyResult = { status: number; body: PartyState | { error: string } };

export class Party {
  private profiles: Record<string, PartyLook> = Object.create(null);
  private scores: Record<string, number> = Object.create(null);
  private events: PartyEvent[] = [];
  private lastAction = new Map<string, number>();

  constructor(private store: Store) {
    const raw = store.kvGet(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = PartyState.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.profiles = Object.assign(Object.create(null), parsed.data.profiles);
        this.scores = Object.assign(Object.create(null), parsed.data.scores);
      }
    } catch {
      // A malformed optional party record must not stop office presence.
    }
  }

  state(now: number): PartyState {
    this.events = this.events.filter((event) => now - event.at < PARTY_EVENT_TTL_MS).slice(-32);
    for (const [personId, at] of this.lastAction) {
      if (now - at >= PARTY_COOLDOWN_MS) this.lastAction.delete(personId);
    }
    return {
      profiles: { ...this.profiles },
      scores: { ...this.scores },
      events: [...this.events],
    };
  }

  mutate(input: unknown, online: ReadonlySet<string>, now: number): PartyResult {
    const parsed = PartyMutation.safeParse(input);
    const error = (status: number, message: string): PartyResult => ({
      status,
      body: { error: message },
    });
    if (!parsed.success) return error(400, "Invalid party look or action");
    const { personId, look, action, targetId } = parsed.data;
    if (!online.has(personId)) return error(404, "Choose someone currently in the office");
    if (targetId && !online.has(targetId)) return error(404, "Target is no longer in the office");
    if ((action === "tag" || action === "high-five") && (!targetId || targetId === personId)) {
      return error(400, "Choose another person for this action");
    }
    const current = look ?? this.profiles[personId] ?? DEFAULT_PARTY_LOOK;
    if (action === "use" && current.item === "none") return error(400, "Equip an item first");
    if (action === "race" && current.vehicle === "none") return error(400, "Equip a vehicle first");
    // Clean old entries even when there is no viewer polling.
    this.state(now);
    if (action && now - (this.lastAction.get(personId) ?? -Infinity) < PARTY_COOLDOWN_MS) {
      return error(429, "Give your character a moment before the next action");
    }
    const tracked = new Set([...Object.keys(this.profiles), ...Object.keys(this.scores)]);
    const added = [personId, ...(action === "high-five" && targetId ? [targetId] : [])].filter(
      (id) => !tracked.has(id),
    );
    if (tracked.size + added.length > MAX_PROFILES) {
      return error(409, "The office wardrobe is full");
    }
    if (look) this.profiles[personId] = look;
    if (action) {
      this.lastAction.set(personId, now);
      const event: PartyEvent = {
        id: crypto.randomUUID(),
        personId,
        action,
        item: current.item,
        at: now,
        ...(targetId ? { targetId } : {}),
      };
      if (action === "race") event.roll = 1 + Math.floor(Math.random() * 6);
      if (action === "race" || action === "tag" || action === "high-five") {
        this.scores[personId] = Math.min(
          MAX_SCORE,
          (this.scores[personId] ?? 0) + (event.roll ?? 1),
        );
        if (action === "high-five" && targetId) {
          this.scores[targetId] = Math.min(MAX_SCORE, (this.scores[targetId] ?? 0) + 1);
        }
      }
      this.events.push(event);
    }
    this.store.kvPut(
      STORAGE_KEY,
      JSON.stringify({ profiles: this.profiles, scores: this.scores, events: [] }),
    );
    return { status: 200, body: this.state(now) };
  }
}

/** Bound actual bytes, including chunked uploads with no Content-Length header. */
export async function readPartyBody(req: Request): Promise<{ value?: unknown; status?: number }> {
  if (Number(req.headers.get("content-length") ?? 0) > PARTY_BODY_MAX_BYTES) return { status: 413 };
  if (!req.body) return { status: 400 };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PARTY_BODY_MAX_BYTES) {
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
