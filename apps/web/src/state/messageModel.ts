/** Authored messages are separate from world/session/statistics state. */
import {
  MESSAGE_DAILY_CAP,
  MESSAGE_MAX_ROWS,
  MESSAGE_RETENTION_MS,
  type MessagePage,
  type MessageRecord,
} from "@agent-office/protocol";

export class MessageModel {
  private records = new Map<string, MessageRecord>();
  readonly ownedIds = new Set<string>();
  private deleted = new Map<string, number>();
  initialized = false;
  /** Advance only through known contiguous sequences; a higher live event cannot skip a gap. */
  cursor = 0;
  older: number | null = null;
  lastRead: number;
  private firstVisit: boolean;
  constructor(
    lastRead: number | null = null,
    private now = Date.now,
  ) {
    this.firstVisit = lastRead === null;
    this.lastRead = lastRead ?? 0;
  }
  get rows(): MessageRecord[] {
    return [...this.records.values()].sort((a, b) => a.seq - b.seq);
  }
  get unread(): number {
    return this.rows.filter((m) => m.seq > this.lastRead).length;
  }
  receive(message: MessageRecord): boolean {
    if (this.deleted.has(message.id)) return false;
    const fresh = !this.records.has(message.id);
    this.records.set(message.id, message);
    this.advanceKnown();
    this.prune();
    return fresh;
  }
  private advanceKnown(): void {
    if (!this.initialized) return;
    const sequences = new Set(this.rows.map((m) => m.seq));
    while (sequences.has(this.cursor + 1)) this.cursor++;
  }
  remove(id: string): void {
    this.records.delete(id);
    this.ownedIds.delete(id);
    this.deleted.set(id, this.now());
    this.prune();
  }
  page(page: MessagePage, mode: "initial" | "older" | "catchup"): void {
    if (mode === "initial") {
      // Keep newer events that raced this snapshot, not stale/expired older pages.
      for (const [id, message] of this.records)
        if (message.seq <= page.head) this.records.delete(id);
      if (this.firstVisit || this.lastRead > page.head) this.lastRead = page.head;
      this.firstVisit = false;
      this.initialized = true;
      this.cursor = page.head;
      this.older = page.older;
    } else if (mode === "catchup") {
      this.cursor = page.hasMore ? page.next : page.head;
    } else this.older = page.older;
    for (const message of page.messages)
      if (!this.deleted.has(message.id)) this.records.set(message.id, message);
    for (const id of page.ownedIds ?? []) if (this.records.has(id)) this.ownedIds.add(id);
    this.advanceKnown();
    this.prune();
  }
  markRead(visible: boolean, atBottom: boolean, unfiltered: boolean): void {
    if (!this.initialized || !visible || !atBottom || !unfiltered) return;
    // Do not mark a live high sequence read before the missing interval has been fetched.
    this.lastRead = Math.max(
      this.lastRead,
      Math.min(this.cursor, this.rows.at(-1)?.seq ?? this.cursor),
    );
  }
  prune(): void {
    const cutoff = this.now() - MESSAGE_RETENTION_MS;
    for (const [id, m] of this.records) if (m.ts <= cutoff) this.records.delete(id);
    for (const row of this.rows.slice(0, -MESSAGE_MAX_ROWS)) this.records.delete(row.id);
    for (const id of this.ownedIds) if (!this.records.has(id)) this.ownedIds.delete(id);
    for (const [id, at] of this.deleted) if (at <= cutoff) this.deleted.delete(id);
    while (this.deleted.size > MESSAGE_DAILY_CAP * 2)
      this.deleted.delete(this.deleted.keys().next().value!);
  }
  clear(): void {
    this.records.clear();
    this.ownedIds.clear();
    this.deleted.clear();
    this.initialized = false;
    this.cursor = 0;
    this.older = null;
  }
}
