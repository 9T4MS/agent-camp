/** One persistent DOM composer/log; never render authored content into Pixi textures. */
import {
  MESSAGE_MAX_RECIPIENTS,
  type MessageRecord,
  SendMessageRequest,
} from "@agent-office/protocol";
import { MessageRequestError } from "../net/messages.ts";
import { type MessageModel, messageRetryExpired } from "../state/messageModel.ts";
import type { OfficeModel } from "../state/officeModel.ts";
import "./messages.css";

const READ_KEY = "agent-office.messages.read";
const EXPANDED_KEY = "agent-office.messages.expanded";
const NAME_KEY = "agent-office.viewerName";
const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* optional */
  }
};
export function storedMessageRead(): number | null {
  const value = stored(READ_KEY);
  return value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;
}
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};
const button = (text: string, action: () => void) => {
  const element = node("button", text);
  element.type = "button";
  element.className = "pixel-btn";
  element.onclick = action;
  return element;
};

export class MessagesPanel {
  readonly launcher: HTMLButtonElement;
  readonly panel = node("section");
  private log = node("div");
  private rows = node("div");
  private historyStatus = node("p");
  private announcement = node("p");
  private sendStatus = node("p");
  private filter = node("select");
  private form = node("form");
  private fields = node("fieldset");
  private audience = node("select");
  private from = node("input");
  private text = node("textarea");
  private notify = node("input");
  private chips = node("div");
  private picker = node("div");
  private search = node("input");
  private choices = node("div");
  private count = node("span");
  private pickerButton: HTMLButtonElement;
  private submit: HTMLButtonElement;
  private newAttempt: HTMLButtonElement;
  private olderButton: HTMLButtonElement;
  private jump: HTMLButtonElement;
  private recipientNames = new Map<string, string>();
  private origin: HTMLElement | null = null;
  private busy = false;
  private loadingOlder = false;
  private uncertain: { request: SendMessageRequest; at: number; head: number } | null = null;
  private lastRendered = "";
  private rosterKey = "";
  private filterKey = "";
  private atBottom = true;
  onOpen: () => void = () => {};

  constructor(
    host: HTMLElement,
    private office: OfficeModel,
    readonly model: MessageModel,
    private actions: {
      send: (request: SendMessageRequest) => Promise<MessageRecord>;
      sync: () => Promise<void>;
      older: () => Promise<void>;
      status: () => string;
      historyAvailable: () => boolean;
      demo: boolean;
    },
  ) {
    this.launcher = button("Messages", () => (this.expanded ? this.collapse() : this.open()));
    this.launcher.classList.add("messages-launch");
    this.launcher.setAttribute("aria-controls", "office-messages");
    this.launcher.setAttribute("aria-expanded", "false");
    this.panel.id = "office-messages";
    this.panel.className = "messages-panel pixel-box";
    this.panel.hidden = true;
    this.panel.setAttribute("aria-label", "Office messages");
    this.panel.tabIndex = -1;
    const heading = node("header");
    const historyTab = button("History", () => this.panel.focus());
    historyTab.classList.add("messages-history-tab");
    historyTab.setAttribute("aria-label", "Show message history");
    heading.append(
      node("h2", "Office messages"),
      button("−", () => this.collapse()),
    );
    heading.lastElementChild!.setAttribute("aria-label", "Collapse messages");
    heading.insertBefore(historyTab, heading.lastElementChild);
    this.filter.setAttribute("aria-label", "Filter office messages");
    this.filter.onchange = () => {
      this.lastRendered = "";
      this.refresh();
    };
    const retry = button("Retry history", () => void this.actions.sync());
    const toolbar = node("div");
    toolbar.className = "messages-toolbar";
    toolbar.append(this.filter, retry);
    this.historyStatus.className = "messages-history-status";
    this.historyStatus.setAttribute("role", "status");
    this.log.className = "messages-log";
    this.log.tabIndex = 0;
    this.log.setAttribute("role", "region");
    this.log.setAttribute("aria-label", "Shared office message history");
    this.olderButton = button("Load older", () => void this.loadOlder());
    this.log.append(this.olderButton, this.rows);
    this.log.onscroll = () => {
      this.atBottom = this.isAtBottom();
      this.read();
      this.updateBadge();
    };
    this.jump = button("New messages ↓", () => this.scrollBottom());
    this.jump.classList.add("messages-jump");
    this.jump.hidden = true;
    this.announcement.className = "messages-announcement";
    this.announcement.setAttribute("role", "status");

    this.audience.append(
      new Option("Everyone in the office", "everyone"),
      new Option("Selected people", "selected"),
    );
    this.audience.setAttribute("aria-label", "Notification recipients");
    this.audience.onchange = () => {
      this.renderRecipients();
      this.updateSubmit();
    };
    this.pickerButton = button("Add people", () => {
      this.picker.hidden = !this.picker.hidden;
      if (!this.picker.hidden) this.search.focus();
      this.pickerButton.setAttribute("aria-expanded", String(!this.picker.hidden));
    });
    this.pickerButton.setAttribute("aria-expanded", "false");
    this.pickerButton.setAttribute("aria-controls", "message-recipient-picker");
    this.picker.id = "message-recipient-picker";
    this.picker.className = "messages-picker";
    this.picker.hidden = true;
    this.search.type = "search";
    this.search.placeholder = "Find people";
    this.search.setAttribute("aria-label", "Find recipients");
    this.search.oninput = () => this.renderChoices();
    this.picker.append(this.search, this.choices);
    this.chips.className = "messages-chips";
    this.from.maxLength = 40;
    this.from.value = stored(NAME_KEY) ?? "";
    this.from.onchange = () => remember(NAME_KEY, this.from.value.trim());
    const fromLabel = node("label", "From (display name)");
    fromLabel.append(this.from);
    this.text.maxLength = 200;
    this.text.rows = 2;
    this.text.placeholder = "Write an office message…";
    this.text.setAttribute("aria-label", "Office message");
    this.text.oninput = () => this.updateSubmit();
    this.notify.type = "checkbox";
    const notifyLabel = node("label", "");
    notifyLabel.className = "messages-notify";
    notifyLabel.append(this.notify, node("span", "Also notify recipients’ Macs"));
    this.notify.onchange = () => this.updateSubmit();
    const audienceRow = node("div");
    audienceRow.className = "messages-audience";
    audienceRow.append(this.audience, this.pickerButton);
    this.fields.append(
      audienceRow,
      this.chips,
      this.picker,
      fromLabel,
      this.text,
      this.count,
      notifyLabel,
    );
    const privacy = node(
      "p",
      actions.demo
        ? "Demo — no Macs notified. Visible to everyone."
        : "Visible to everyone in this office. Names are unverified.",
    );
    privacy.className = "messages-privacy";
    this.submit = node("button", "Send");
    this.submit.className = "pixel-btn";
    this.submit.type = "submit";
    this.newAttempt = button("Edit as a new message", () => {
      if (
        !confirm(
          "The previous message may already be saved. Editing and sending again can create a second message. Continue?",
        )
      )
        return;
      this.uncertain = null;
      this.sendStatus.textContent = "Editing as a new message.";
      this.updateSubmit();
    });
    this.newAttempt.hidden = true;
    const footer = node("div");
    footer.className = "messages-send-row";
    footer.append(this.newAttempt, this.submit);
    this.sendStatus.setAttribute("role", "status");
    this.sendStatus.className = "messages-send-status";
    this.form.append(this.fields, privacy, footer, this.sendStatus);
    this.form.onsubmit = (e) => {
      e.preventDefault();
      void this.send();
    };
    this.panel.append(
      heading,
      toolbar,
      this.historyStatus,
      this.log,
      this.jump,
      this.announcement,
      this.form,
    );
    host.append(this.launcher, this.panel);
    for (const event of ["pointerdown", "pointerup", "click", "wheel"] as const)
      this.panel.addEventListener(event, (e) => e.stopPropagation());
    this.panel.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        if (!this.picker.hidden) {
          this.picker.hidden = true;
          this.pickerButton.setAttribute("aria-expanded", "false");
          this.pickerButton.focus();
        } else this.collapse();
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && this.form.contains(e.target as Node)) {
        e.preventDefault();
        if (!this.submit.disabled) this.form.requestSubmit();
      }
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.expanded && !e.defaultPrevented) {
        e.preventDefault();
        this.collapse();
      }
    });
    document.addEventListener("visibilitychange", () => this.read());
    let largestViewport = window.innerHeight;
    const viewport = () => {
      const v = window.visualViewport;
      largestViewport = Math.max(largestViewport, window.innerHeight);
      this.panel.classList.toggle(
        "messages-keyboard",
        (v?.height ?? window.innerHeight) < largestViewport * 0.75 &&
          this.form.contains(document.activeElement),
      );
      this.panel.style.setProperty("--messages-vh", `${v?.height ?? window.innerHeight}px`);
      this.panel.style.setProperty(
        "--messages-bottom",
        `${v ? Math.max(0, window.innerHeight - v.height - v.offsetTop) : 0}px`,
      );
    };
    this.form.addEventListener("focusin", viewport);
    this.form.addEventListener("focusout", () => setTimeout(viewport, 0));
    window.visualViewport?.addEventListener("resize", viewport);
    window.visualViewport?.addEventListener("scroll", viewport);
    viewport();
    setInterval(() => {
      this.model.prune();
      this.refresh();
    }, 30_000);
    this.refresh();
    if (stored(EXPANDED_KEY) === "true") this.open(false);
  }
  get expanded(): boolean {
    return !this.panel.hidden;
  }
  open(focus = true): void {
    this.origin =
      document.activeElement instanceof HTMLElement ? document.activeElement : this.launcher;
    this.onOpen();
    this.panel.hidden = false;
    this.launcher.setAttribute("aria-expanded", "true");
    remember(EXPANDED_KEY, "true");
    this.refresh();
    if (this.atBottom) this.scrollBottom();
    if (focus) this.panel.focus();
  }
  collapse(restoreFocus = true): void {
    this.panel.hidden = true;
    this.picker.hidden = true;
    this.pickerButton.setAttribute("aria-expanded", "false");
    this.launcher.setAttribute("aria-expanded", "false");
    remember(EXPANDED_KEY, "false");
    if (restoreFocus)
      (this.origin?.isConnected && this.origin.getClientRects().length
        ? this.origin
        : this.launcher
      ).focus();
  }
  compose(personId?: string): void {
    if (!this.uncertain && !this.busy && personId) {
      const hasDraft = this.text.value.length > 0;
      this.audience.value = "selected";
      if (!hasDraft) this.recipientNames.clear();
      this.recipientNames.set(personId, this.office.people.get(personId)?.name ?? personId);
      if (!hasDraft) this.notify.checked = true;
    }
    this.open();
    this.renderRecipients();
    this.updateSubmit();
    if (this.atBottom) this.scrollBottom();
    this.text.focus();
  }
  clear(): void {
    this.text.value = "";
    this.from.value = "";
    this.recipientNames.clear();
    this.uncertain = null;
    this.sendStatus.textContent = "";
    this.announcement.textContent = "";
    this.collapse(false);
    this.refresh();
  }
  announce(message: MessageRecord): void {
    this.announcement.textContent = `${message.from || "Someone"} sent an office message.`;
  }
  refresh(): void {
    const followBottom = this.atBottom && !this.loadingOlder;
    const roster = JSON.stringify(
      [...this.office.people.values()].map((p) => [
        p.personId,
        p.name,
        this.office.sessionsOf(p.personId).every((s) => s.offline),
      ]),
    );
    if (roster !== this.rosterKey) {
      this.rosterKey = roster;
      this.renderChoices();
      this.renderRecipients();
    }
    const known = new Map([...this.office.people.values()].map((p) => [p.personId, p.name]));
    for (const m of this.model.rows)
      for (const p of m.recipients) if (!known.has(p.personId)) known.set(p.personId, p.name);
    const filterKey = JSON.stringify([...known]);
    if (filterKey !== this.filterKey) {
      this.filterKey = filterKey;
      const selected = this.filter.value || "all";
      this.filter.replaceChildren(
        new Option("All messages", "all"),
        new Option("Broadcasts", "everyone"),
      );
      for (const [id, name] of known) this.filter.add(new Option(`To: ${name}`, `person:${id}`));
      this.filter.value = [...this.filter.options].some((o) => o.value === selected)
        ? selected
        : "all";
    }
    const visible = this.model.rows.filter(
      (m) =>
        this.filter.value === "all" ||
        (this.filter.value === "everyone"
          ? m.audience === "everyone"
          : m.recipients.some((p) => `person:${p.personId}` === this.filter.value)),
    );
    const key = JSON.stringify([this.filter.value, visible]);
    if (key !== this.lastRendered) {
      this.lastRendered = key;
      this.rows.replaceChildren();
      if (!visible.length)
        this.rows.append(
          node("p", this.model.initialized ? "No messages here yet." : "Waiting for history…"),
        );
      for (const m of visible) {
        const article = node("article");
        article.dataset.messageId = m.id;
        const time = node("time");
        time.dateTime = new Date(m.ts).toISOString();
        time.textContent = new Intl.DateTimeFormat("en-GB", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          ...(this.office.timezone ? { timeZone: this.office.timezone } : {}),
        }).format(m.ts);
        const byline = node("div");
        byline.className = "messages-byline";
        byline.append(
          time,
          node(
            "b",
            `${m.from || "Someone"} → ${m.audience === "everyone" ? "Everyone" : m.recipients.map((p) => p.name).join(", ")}`,
          ),
        );
        const body = node("p", m.text);
        body.dir = "auto";
        article.append(byline, body);
        this.rows.append(article);
      }
    }
    this.historyStatus.textContent = this.actions.status();
    this.olderButton.hidden = this.model.older === null;
    this.olderButton.disabled = this.loadingOlder;
    this.updateSubmit();
    if (followBottom && this.expanded) this.scrollBottom();
    this.read();
    this.updateBadge();
  }
  private read(): void {
    this.model.markRead(
      this.expanded && document.visibilityState === "visible",
      this.atBottom,
      this.filter.value === "all",
    );
    if (this.model.initialized) remember(READ_KEY, String(this.model.lastRead));
  }
  private updateBadge(): void {
    this.launcher.textContent = `Messages${this.model.unread ? ` · ${this.model.unread}` : ""}`;
    this.jump.hidden = this.atBottom || this.model.unread === 0;
    this.jump.textContent = `${this.model.unread} new ↓`;
  }
  private isAtBottom(): boolean {
    return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 12;
  }
  private scrollBottom(): void {
    this.log.scrollTop = this.log.scrollHeight;
    this.atBottom = true;
    this.read();
    this.updateBadge();
  }
  private async loadOlder(): Promise<void> {
    if (this.loadingOlder) return;
    const height = this.log.scrollHeight;
    const top = this.log.scrollTop;
    this.loadingOlder = true;
    this.olderButton.disabled = true;
    await this.actions.older();
    this.loadingOlder = false;
    this.log.scrollTop = top + this.log.scrollHeight - height;
    this.atBottom = this.isAtBottom();
    this.refresh();
  }
  private renderChoices(): void {
    this.choices.replaceChildren();
    for (const p of this.office.people.values()) {
      if (!p.name.toLowerCase().includes(this.search.value.toLowerCase())) continue;
      const label = node("label");
      const checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.recipientNames.has(p.personId);
      checkbox.disabled = !checkbox.checked && this.recipientNames.size >= MESSAGE_MAX_RECIPIENTS;
      const offline = !this.office.sessionsOf(p.personId).some((s) => !s.offline);
      label.append(checkbox, node("span", `${p.name}${offline ? " (offline)" : ""}`));
      checkbox.onchange = () => {
        if (checkbox.checked) this.recipientNames.set(p.personId, p.name);
        else this.recipientNames.delete(p.personId);
        this.renderRecipients();
        this.updateSubmit();
        for (const input of this.choices.querySelectorAll("input"))
          input.disabled = !input.checked && this.recipientNames.size >= MESSAGE_MAX_RECIPIENTS;
      };
      this.choices.append(label);
    }
    if (!this.choices.childElementCount) this.choices.append(node("p", "No people found."));
  }
  private renderRecipients(): void {
    const selected = this.audience.value === "selected";
    this.pickerButton.hidden = !selected;
    this.chips.hidden = !selected;
    if (!selected) {
      this.picker.hidden = true;
      this.pickerButton.setAttribute("aria-expanded", "false");
    }
    this.chips.replaceChildren();
    for (const [id, name] of this.recipientNames) {
      const available = this.office.people.has(id);
      const chip = button(`${name}${available ? "" : " (left office)"} ×`, () => {
        this.recipientNames.delete(id);
        this.renderRecipients();
        this.renderChoices();
        this.updateSubmit();
        this.pickerButton.focus();
      });
      chip.setAttribute("aria-label", `Remove ${name}`);
      this.chips.append(chip);
    }
  }
  private updateSubmit(): void {
    const selected = this.audience.value === "selected";
    const validRecipients =
      !selected ||
      (this.recipientNames.size > 0 &&
        this.recipientNames.size <= MESSAGE_MAX_RECIPIENTS &&
        [...this.recipientNames.keys()].every((id) => this.office.people.has(id)));
    this.fields.disabled = this.busy || !!this.uncertain;
    const expired =
      !!this.uncertain &&
      messageRetryExpired(this.uncertain.at, this.uncertain.head, Date.now(), this.model.cursor);
    this.submit.disabled =
      this.busy || (this.uncertain ? expired : !this.text.value.trim() || !validRecipients);
    this.count.textContent = `${this.text.value.length}/200`;
    const count = selected ? this.recipientNames.size : this.office.people.size;
    this.submit.textContent = this.busy
      ? "Sending…"
      : this.uncertain
        ? expired
          ? "Retry expired"
          : "Retry same message"
        : this.notify.checked
          ? `Send + notify ${count} ${count === 1 ? "person" : "people"}`
          : "Send";
    this.newAttempt.hidden = !this.uncertain;
    this.newAttempt.disabled = this.busy;
  }
  private async send(): Promise<void> {
    if (this.submit.disabled) return;
    const parsed = SendMessageRequest.safeParse(
      this.uncertain?.request ?? {
        requestId: crypto.randomUUID(),
        audience:
          this.audience.value === "everyone"
            ? { kind: "everyone" }
            : { kind: "selected", personIds: [...this.recipientNames.keys()] },
        text: this.text.value,
        from: this.from.value.trim(),
        notifyDesktop: this.notify.checked,
      },
    );
    if (!parsed.success) {
      this.sendStatus.textContent = "Check the text and selected recipients.";
      return;
    }
    const request = parsed.data;
    if (
      !this.uncertain &&
      request.audience.kind === "everyone" &&
      request.notifyDesktop &&
      !confirm(
        `Notify everyone’s connected Macs (${this.office.people.size} people currently in the office)? This message is visible to everyone.`,
      )
    )
      return;
    this.busy = true;
    this.sendStatus.textContent = "Saving…";
    this.updateSubmit();
    const attemptedAt = this.uncertain?.at ?? Date.now();
    const attemptedHead = this.uncertain?.head ?? this.model.cursor;
    try {
      if (this.uncertain) {
        await this.actions.sync();
        if (!this.actions.historyAvailable())
          throw new MessageRequestError(
            "History unavailable. Recover history before retrying, or explicitly edit as a new message.",
            true,
          );
        if (messageRetryExpired(attemptedAt, attemptedHead, Date.now(), this.model.cursor))
          throw new MessageRequestError(
            "The retry window expired. Explicitly edit as a new message if you still want to send it.",
            true,
          );
      }
      const message = await this.actions.send(request);
      this.text.value = "";
      this.uncertain = null;
      const queued = message.delivery.people.filter((p) => p.status === "queued").length;
      const offline = message.delivery.people.filter((p) => p.status === "offline").length;
      const cooldown = message.delivery.people.filter((p) => p.status === "cooldown").length;
      const unknown = message.delivery.people.filter((p) => p.status === "unknown").length;
      this.sendStatus.textContent = this.actions.demo
        ? "Saved in this demo — no Macs notified."
        : !message.notifyDesktop
          ? "Saved to office history."
          : `Saved. Queued to ${queued} people’s connected Macs; ${offline} offline, ${cooldown} cooling down, ${unknown} unknown. Not a display/read receipt.`;
    } catch (error) {
      this.uncertain =
        error instanceof MessageRequestError && error.uncertain
          ? { request, at: attemptedAt, head: attemptedHead }
          : null;
      this.sendStatus.textContent =
        error instanceof Error ? error.message : "Send failed. Draft retained.";
    } finally {
      this.busy = false;
      this.updateSubmit();
    }
  }
}
