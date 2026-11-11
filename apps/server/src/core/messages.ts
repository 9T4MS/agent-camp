/** Durable authored history + best-effort live alerts. No notification replay/outbox. */
import {
  envelope,
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
export type MessageResult =
  | { status: 200 | 201; message: MessageRecord }
  | { status: 409 | 422 | 429; error: string; retryAfter?: number };

export class OfficeMessages {
  constructor(
    private store: Store,
    private hub: Hub,
    private sendSocket: (socket: string, json: string) => boolean,
    private broadcast: (json: string) => void,
    private guard: (who: string, now: number) => number | null,
  ) {}

  /** Shared with quick pokes; expire keys when used so hibernation cannot reset the guard. */
  private cooldowns(now: number): Record<string, number> {
    const saved: Record<string, number> = JSON.parse(
      this.store.kvGet("notifications.cooldowns") ?? "{}",
    );
    return Object.fromEntries(
      Object.entries(saved).filter(([, at]) => now - at < BROADCAST_NOTIFY_MS),
    );
  }
  pokeWait(personId: string, now: number): number {
    const at = this.cooldowns(now)[`person:${personId}`];
    return at === undefined ? 0 : Math.max(0, at + NOTIFY_PERSON_MS - now);
  }
  markPoke(personId: string, now: number): void {
    this.store.kvPut(
      "notifications.cooldowns",
      JSON.stringify({ ...this.cooldowns(now), [`person:${personId}`]: now }),
    );
  }
  prune(now: number): void {
    this.store.pruneMessages(now);
  }
  nextDeadline(): number | null {
    return this.store.nextMessageExpiry();
  }

  page(query: MessageQuery, now: number): MessagePage {
    this.prune(now);
    const head = this.store.messageHead();
    const first = this.store.messages({ after: 0, limit: 1 })[0];
    const fetched = this.store.messages({ ...query, limit: query.limit + 1 });
    const hasMore = fetched.length > query.limit;
    const messages =
      query.after === undefined ? fetched.slice(-query.limit) : fetched.slice(0, query.limit);
    const start = messages[0]?.seq;
    return {
      messages,
      head,
      older: start !== undefined && first && first.seq < start ? start : null,
      next: messages.at(-1)?.seq ?? query.after ?? head,
      hasMore,
      gap: query.after !== undefined && query.after < (first ? first.seq - 1 : head),
      retention: {
        maxAgeMs: MESSAGE_RETENTION_MS,
        maxRows: MESSAGE_MAX_ROWS,
        expiresAt: this.nextDeadline(),
      },
    };
  }

  send(request: SendMessageRequest, who: string, now: number): MessageResult {
    this.prune(now);
    // Canonicalize selection order and optional blank signatures before comparing retries.
    const payload = JSON.stringify({
      audience:
        request.audience.kind === "everyone"
          ? { kind: "everyone" }
          : {
              kind: "selected",
              personIds: [...request.audience.personIds].sort(),
            },
      text: request.text,
      from: request.from || null,
      notifyDesktop: request.notifyDesktop,
    });
    const previous = this.store.findMessage(request.requestId);
    if (previous)
      return previous.payload === payload
        ? { status: 200, message: previous.message }
        : { status: 409, error: "request ID already used for a different message" };
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

    // Persist unknown delivery first. Any interruption must remain a saved, non-replayed send.
    const message = this.store.insertMessage(request.requestId, payload, {
      id: ulid(now),
      ts: now,
      text: request.text,
      ...(request.from ? { from: request.from } : {}),
      audience: request.audience.kind,
      recipients,
      notifyDesktop: request.notifyDesktop,
      delivery: {
        socketSends: 0,
        people: recipients.map(({ personId }) => ({
          personId,
          status: request.notifyDesktop ? "unknown" : "notRequested",
        })),
      },
    });
    if (request.notifyDesktop) {
      if (request.audience.kind === "everyone") {
        this.store.kvPut(
          "notifications.cooldowns",
          JSON.stringify({ ...cooldowns, broadcast: now }),
        );
      }
      const poke = JSON.stringify(
        envelope(
          "connector.poked",
          { kind: "message", text: request.text, ...(request.from ? { from: request.from } : {}) },
          { ts: now },
        ),
      );
      for (const outcome of message.delivery.people) {
        const sockets = this.hub.liveSocketsOf(outcome.personId, now);
        if (this.pokeWait(outcome.personId, now)) {
          outcome.status = "cooldown";
          continue;
        }
        if (!sockets.length) {
          outcome.status = "offline";
          continue;
        }
        // Set before I/O; do not replay even if a socket send or process fails.
        this.markPoke(outcome.personId, now);
        let queued = 0;
        let failed = false;
        for (const socket of new Set(sockets)) {
          try {
            if (this.sendSocket(socket, poke)) queued++;
          } catch {
            failed = true;
          }
        }
        message.delivery.socketSends += queued;
        outcome.status = queued ? "queued" : failed ? "unknown" : "offline";
      }
    }
    try {
      this.store.updateMessage(message);
    } catch {
      // The durable pre-send record still says unknown; never turn a saved send into a retry.
      message.delivery = {
        socketSends: 0,
        people: recipients.map(({ personId }) => ({
          personId,
          status: request.notifyDesktop ? "unknown" : "notRequested",
        })),
      };
    }
    this.prune(now);
    try {
      this.broadcast(JSON.stringify(envelope("message.sent", { message }, { ts: now })));
    } catch {
      /* reconnect/history recovers a saved row */
    }
    return { status: 201, message };
  }
}
