/** Validated HTTP message history, independent of the viewer's status snapshot. */
import {
  MessagePage,
  type MessageRecord,
  type SendMessageRequest,
  SendMessageResponse,
} from "@agent-office/protocol";
import type { MessageModel } from "../state/messageModel.ts";

export class MessageRequestError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
export class MessagesClient {
  status = "Loading history…";
  private syncing: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  constructor(
    readonly model: MessageModel,
    private opts: {
      key?: string | null;
      changed: () => void;
      authFailed: () => void;
      fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    },
  ) {}
  private async request(path: string, body?: SendMessageRequest): Promise<unknown> {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${path}${this.opts.key ? `${separator}key=${encodeURIComponent(this.opts.key)}` : ""}`;
    let response: Response;
    try {
      response = await (this.opts.fetch ?? fetch)(url, {
        cache: "no-store",
        ...(body
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
    } catch {
      throw new MessageRequestError(
        "Could not reach the office. Retry the same message safely.",
        !!body,
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
      throw new MessageRequestError(
        `${error}${retry ? ` Try again in ${retry}s.` : ""}`,
        !!body && response.status >= 500,
      );
    }
    return value;
  }
  receive(message: MessageRecord): void {
    if (this.stopped) return;
    const fresh = this.model.receive(message);
    this.opts.changed();
    if (fresh && this.model.initialized && message.seq > this.model.cursor) void this.sync();
  }
  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
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
      if (!this.model.initialized) {
        const page = MessagePage.parse(await this.request("/api/messages?limit=50"));
        if (this.stopped) return;
        this.model.page(page, "initial");
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
            this.status = "Older messages expired.";
            this.opts.changed();
            return;
          }
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
  async send(request: SendMessageRequest): Promise<MessageRecord> {
    if (this.stopped) throw new MessageRequestError("Office login expired.");
    const value = await this.request("/api/messages", request);
    const parsed = SendMessageResponse.safeParse(value);
    if (!parsed.success)
      throw new MessageRequestError(
        "Send acknowledgement unavailable. Retry the same message safely.",
        true,
      );
    if (this.stopped) throw new MessageRequestError("Office login expired.");
    this.receive(parsed.data.message);
    return parsed.data.message;
  }
  clear(): void {
    this.stopped = true;
    this.model.clear();
    this.status = "";
    this.opts.changed();
  }
}
