/** Small shared log + best-effort live alerts, with no delivery ledger or automatic retry. */
import {
  envelope,
  MESSAGE_DAILY_CAP,
  MESSAGE_MAX_ROWS,
  MESSAGE_RETENTION_MS,
  type MessagePage,
  type MessageQuery,
  type MessageRecord,
  type SendMessageRequest,
  ulid,
} from "@agent-office/protocol";
import type { Hub } from "./hub.ts";
import type { Store } from "./store.ts";

export const BROADCAST_NOTIFY_MS = 30_000;
export const NOTIFY_PERSON_MS = 10_000;
export const MESSAGE_EXPIRY_BATCH_MS = 3_600_000;
export type MessageResult =
  | { status: 201; message: MessageRecord; queued: number }
  | { status: 422 | 429 | 503; error: string; retryAfter?: number };

export class OfficeMessages {
  constructor(
    private store: Store,
    private hub: Hub,
    private sendSocket: (socket: string, json: string) => boolean,
    private broadcast: (json: string) => void,
    private guard: (who: string, now: number) => number | null,
    private lastPoke: Map<string, number> = new Map(),
  ) {}

  private cooldowns(now: number): Record<string, number> {
    const saved: Record<string, number> = JSON.parse(
      this.store.kvGet("notifications.cooldowns") ?? "{}",
    );
    return Object.fromEntries(
      Object.entries(saved).filter(([, at]) => now - at < BROADCAST_NOTIFY_MS),
    );
  }
  prune(now: number): void {
    this.store.pruneMessages(now);
  }
  nextDeadline(): number | null {
    const expiry = this.store.nextMessageExpiry();
    return expiry === null
      ? null
      : Math.ceil(expiry / MESSAGE_EXPIRY_BATCH_MS) * MESSAGE_EXPIRY_BATCH_MS;
  }
  page(query: MessageQuery, now: number, ownerHash: string | null = null): MessagePage {
    // Reads expire visibility at 24h without writes; the hourly alarm batches physical cleanup.
    const since = now - MESSAGE_RETENTION_MS;
    const head = this.store.messageHead();
    const first = this.store.messages({ after: 0, limit: 1, since })[0];
    const fetched = this.store.messages({ ...query, limit: query.limit + 1, since });
    const messages =
      query.after === undefined ? fetched.slice(-query.limit) : fetched.slice(0, query.limit);
    const start = messages[0]?.seq;
    return {
      messages: messages.map(({ ownerHash: _private, ...message }) => message),
      ownedIds: messages.filter((m) => !!ownerHash && m.ownerHash === ownerHash).map((m) => m.id),
      head,
      older: start !== undefined && first && first.seq < start ? start : null,
      next: messages.at(-1)?.seq ?? query.after ?? head,
      hasMore: fetched.length > query.limit,
      gap: query.after !== undefined && query.after < (first ? first.seq - 1 : head),
      retention: {
        maxAgeMs: MESSAGE_RETENTION_MS,
        maxRows: MESSAGE_MAX_ROWS,
        expiresAt: this.store.nextMessageExpiry(),
      },
    };
  }
  delete(id: string, ownerHash: string | null, now: number): { status: number; error?: string } {
    const row = this.store.findMessageById(id);
    if (!row || row.message.ts + MESSAGE_RETENTION_MS <= now)
      return { status: 404, error: "message not found" };
    if (!ownerHash || row.ownerHash !== ownerHash)
      return { status: 403, error: "Only the sending browser can delete this message." };
    this.store.deleteMessage(id);
    this.broadcast(JSON.stringify(envelope("message.deleted", { messageId: id }, { ts: now })));
    return { status: 200 };
  }
  send(request: SendMessageRequest, who: string, now: number, ownerHash?: string): MessageResult {
    try {
      return this.sendOnce(request, who, now, ownerHash);
    } catch {
      return {
        status: 503,
        error:
          "Could not confirm the send. It may already be saved; check history before sending again.",
      };
    }
  }
  private sendOnce(
    request: SendMessageRequest,
    who: string,
    now: number,
    ownerHash?: string,
  ): MessageResult {
    const people = this.hub.state().people;
    const selected = request.audience.kind === "selected" ? request.audience.personIds : null;
    if (selected?.some((id) => !people.some((p) => p.personId === id)))
      return {
        status: 422,
        error: "A selected person left the office. Update the recipients and try again.",
      };
    const recipients = people
      .filter((p) => !selected || selected.includes(p.personId))
      .map(({ personId, name }) => ({ personId, name }));
    const cooldowns = this.cooldowns(now);
    const lastBroadcast = cooldowns.broadcast;
    if (
      request.audience.kind === "everyone" &&
      request.notifyDesktop &&
      lastBroadcast !== undefined &&
      now - lastBroadcast < BROADCAST_NOTIFY_MS
    )
      return {
        status: 429,
        error:
          "Office-wide notifications are cooling down. Wait or send without Mac notifications.",
        retryAfter: Math.ceil((lastBroadcast + BROADCAST_NOTIFY_MS - now) / 1000),
      };
    const wait = this.guard(who, now);
    if (wait !== null) return { status: 429, error: "slow down", retryAfter: wait };
    const day = new Date(now).toISOString().slice(0, 10);
    const saved = JSON.parse(this.store.kvGet("messages.daily") ?? "null") as {
      day: string;
      count: number;
    } | null;
    const count = saved?.day === day ? saved.count : 0;
    if (count >= MESSAGE_DAILY_CAP)
      return {
        status: 429,
        error: `The office reached its ${MESSAGE_DAILY_CAP}-message daily cap. Try tomorrow (UTC).`,
        retryAfter: Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now) / 1000),
      };
    // A failed insertion can conservatively reserve a slot, but a crash cannot bypass the cap.
    this.store.kvPut("messages.daily", JSON.stringify({ day, count: count + 1 }));
    const message = this.store.insertMessage(
      {
        id: ulid(now),
        ts: now,
        text: request.text,
        ...(request.from ? { from: request.from } : {}),
        audience: request.audience.kind,
        recipients,
        notifyDesktop: request.notifyDesktop,
      },
      ownerHash,
    );
    this.prune(now);
    let queued = 0;
    if (request.notifyDesktop) {
      let changed = false;
      if (request.audience.kind === "everyone") {
        cooldowns.broadcast = now;
        changed = true;
      }
      const poke = JSON.stringify(
        envelope(
          "connector.poked",
          { kind: "message", text: request.text, ...(request.from ? { from: request.from } : {}) },
          { ts: now },
        ),
      );
      for (const { personId } of recipients) {
        const last = Math.max(
          cooldowns[`person:${personId}`] ?? -Infinity,
          this.lastPoke.get(personId) ?? -Infinity,
        );
        if (now - last < NOTIFY_PERSON_MS) continue;
        const sockets = this.hub.liveSocketsOf(personId, now);
        if (!sockets.length) continue;
        this.lastPoke.set(personId, now);
        cooldowns[`person:${personId}`] = now;
        changed = true;
        for (const socket of new Set(sockets)) {
          try {
            if (this.sendSocket(socket, poke)) queued++;
          } catch {
            /* saved history does not depend on alerts */
          }
        }
      }
      // One write per notified message, never one per person. Quick pokes stay in memory.
      if (changed) this.store.kvPut("notifications.cooldowns", JSON.stringify(cooldowns));
    }
    this.broadcast(JSON.stringify(envelope("message.sent", { message }, { ts: now })));
    return { status: 201, message, queued };
  }
}
