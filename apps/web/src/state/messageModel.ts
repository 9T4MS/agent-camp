/** Authored messages are separate from world/session/statistics state. */
import {
  MESSAGE_MAX_ROWS,
  MESSAGE_RETENTION_MS,
  type MessagePage,
  type MessageRecord,
} from "@agent-office/protocol";

export class MessageModel {
  private records = new Map<string, MessageRecord>();
  initialized = false;
  /** Contiguous HTTP catch-up watermark, NEVER advanced by a live event or POST response. */
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
    const fresh = !this.records.has(message.id);
    this.records.set(message.id, message);
    this.prune();
    return fresh;
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
    for (const message of page.messages) this.records.set(message.id, message);
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
  }
  clear(): void {
    this.records.clear();
    this.initialized = false;
    this.cursor = 0;
    this.older = null;
  }
}
