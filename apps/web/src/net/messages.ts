/** Socket-first shared history. Sending is deliberately not automatically retried. */
import {
  DeleteMessageResponse,
  MessagePage,
  type MessageRecord,
  type SendMessageRequest,
  SendMessageResponse,
} from "@agent-office/protocol";
import type { MessageModel } from "../state/messageModel.ts";

export class MessageRequestError extends Error {}
export class MessagesClient {
  status = "Loading history…";
  private syncing: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private ownerReady = false;
  private resetRequested = false;
  constructor(
    readonly model: MessageModel,
    private opts: {
      key?: string | null;
      changed: () => void;
      authFailed: () => void;
      fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    },
  ) {}
  private async request(
    path: string,
    body?: SendMessageRequest,
    method = body ? "POST" : "GET",
  ): Promise<unknown> {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${path}${this.opts.key ? `${separator}key=${encodeURIComponent(this.opts.key)}` : ""}`;
    let response: Response;
    try {
      response = await (this.opts.fetch ?? fetch)(url, {
        cache: "no-store",
        ...(method !== "GET"
          ? {
              method,
              headers: { "content-type": "application/json" },
              ...(body ? { body: JSON.stringify(body) } : {}),
            }
          : {}),
      });
    } catch {
      throw new MessageRequestError(
        body
          ? "Could not confirm the send. It may already be saved; check history before sending again."
          : "Could not reach the office.",
      );
    }
    if (response.status === 401) {
      this.clear();
      this.opts.authFailed();
      throw new MessageRequestError("Office login expired.");
    }
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error =
        value && typeof value === "object" && "error" in value && typeof value.error === "string"
          ? value.error
          : `Request failed (${response.status})`;
      const retry = response.headers.get("retry-after");
      throw new MessageRequestError(`${error}${retry ? ` Try again in ${retry}s.` : ""}`);
    }
    return value;
  }
  receive(message: MessageRecord): void {
    if (this.stopped) return;
    const fresh = this.model.receive(message);
    this.opts.changed();
    if (fresh && this.model.initialized && message.seq > this.model.cursor) void this.sync();
  }
  removed(id: string): void {
    if (!this.stopped) {
      this.model.remove(id);
      this.opts.changed();
    }
  }
  sync(reset = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.resetRequested ||= reset;
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = this.synchronize().finally(() => {
      this.syncing = null;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.sync();
      }
    });
    return this.syncing;
  }
  private async synchronize(): Promise<void> {
    try {
      const reset = this.resetRequested;
      this.resetRequested = false;
      if (!this.model.initialized || reset) {
        const page = MessagePage.parse(await this.request("/api/messages?limit=50"));
        if (this.stopped) return;
        this.ownerReady = true;
        this.model.page(page, "initial");
        if ((this.model.rows.at(-1)?.seq ?? 0) > this.model.cursor) this.again = true;
      } else {
        for (;;) {
          const page = MessagePage.parse(
            await this.request(`/api/messages?after=${this.model.cursor}&limit=100`),
          );
          if (this.stopped) return;
          if (page.gap) {
            const recent = MessagePage.parse(await this.request("/api/messages?limit=50"));
            if (this.stopped) return;
            this.model.page(recent, "initial");
            this.ownerReady = true;
            this.status = "Older messages expired or were deleted.";
            this.opts.changed();
            return;
          }
          this.ownerReady = true;
          this.model.page(page, "catchup");
          if (!page.hasMore) break;
        }
      }
      this.status = "";
    } catch {
      if (!this.stopped)
        this.status = "History unavailable — retry. Live messages may be incomplete.";
    }
    this.opts.changed();
  }
  async older(): Promise<void> {
    if (this.model.older === null || this.stopped) return;
    try {
      const page = MessagePage.parse(
        await this.request(`/api/messages?before=${this.model.older}&limit=50`),
      );
      if (this.stopped) return;
      this.model.page(page, "older");
      this.status = "";
    } catch {
      if (!this.stopped) this.status = "Older history unavailable — retry.";
    }
    this.opts.changed();
  }
  async delete(id: string): Promise<void> {
    if (this.stopped) throw new MessageRequestError("Office login expired.");
    DeleteMessageResponse.parse(
      await this.request(`/api/messages/${encodeURIComponent(id)}`, undefined, "DELETE"),
    );
    if (!this.stopped) this.removed(id);
  }
  async send(request: SendMessageRequest): Promise<SendMessageResponse> {
    if (this.syncing) await this.syncing;
    if (this.stopped) throw new MessageRequestError("Office login expired.");
    if (!this.ownerReady) {
      DeleteMessageResponse.parse(await this.request("/api/messages/owner"));
      this.ownerReady = true;
    }
    const parsed = SendMessageResponse.safeParse(await this.request("/api/messages", request));
    if (!parsed.success)
      throw new MessageRequestError(
        "Send acknowledgement unavailable. It may already be saved; check history before sending again.",
      );
    if (this.stopped) throw new MessageRequestError("Office login expired.");
    this.model.ownedIds.add(parsed.data.message.id);
    this.receive(parsed.data.message);
    return parsed.data;
  }
  clear(): void {
    this.stopped = true;
    this.ownerReady = false;
    this.model.clear();
    this.status = "";
    this.opts.changed();
  }
}
