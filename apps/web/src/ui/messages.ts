/** One persistent DOM composer/log; never render authored content into Pixi textures. */
import {
  MESSAGE_MAX_RECIPIENTS,
  type MessageRecord,
  SendMessageRequest,
  type SendMessageResponse,
} from "@agent-office/protocol";
import type { MessageModel } from "../state/messageModel.ts";
import {
  MESSAGE_PRESENTATION_KEY,
  type MessagePresentation,
  messagePreferences,
} from "../state/messagePreferences.ts";
import type { OfficeModel } from "../state/officeModel.ts";
import { messageEmojiPicker } from "./messageEmojiPicker.ts";
import { insertMessageText, renderMessageText } from "./messageEmotes.ts";
import { messageSettings } from "./messageSettings.ts";
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
  private olderButton: HTMLButtonElement;
  private jump: HTMLButtonElement;
  private recipientNames = new Map<string, string>();
  private origin: HTMLElement | null = null;
  private busy = false;
  private loadingOlder = false;
  private deleting = new Set<string>();
  private lastRendered = "";
  private rosterKey = "";
  private filterKey = "";
  private atBottom = true;
  private restoringScroll = false;
  private readingAnchor: { id: string; offset: number; top: number } | null = null;
  private preferences = messagePreferences(stored(MESSAGE_PRESENTATION_KEY), stored(EXPANDED_KEY));
  private view: "chat" | "history" | "compose" = "chat";
  private settings: HTMLElement | null = null;
  private settingsButton: HTMLButtonElement;
  private emoji: HTMLElement;
  private emojiButton: HTMLButtonElement;
  private writeButton: HTMLButtonElement;
  private historyButton: HTMLButtonElement;
  private toolbar = node("div");
  private occluded = false;
  private contextKey = "";
  private yielded = false;
  onOpen: () => void = () => {};

  constructor(
    host: HTMLElement,
    private office: OfficeModel,
    readonly model: MessageModel,
    private actions: {
      send: (request: SendMessageRequest) => Promise<SendMessageResponse>;
      delete: (id: string) => Promise<void>;
      sync: () => Promise<void>;
      older: () => Promise<void>;
      status: () => string;
      demo: boolean;
    },
  ) {
    this.launcher = button("Messages", () => (this.expanded ? this.hide() : this.open()));
    this.launcher.classList.add("messages-launch");
    this.launcher.setAttribute("aria-controls", "office-messages");
    this.launcher.setAttribute("aria-expanded", "false");
    this.panel.id = "office-messages";
    this.panel.className = "messages-panel pixel-box";
    this.panel.hidden = true;
    this.panel.setAttribute("aria-label", "Office messages");
    this.panel.tabIndex = -1;
    const heading = node("header");
    this.historyButton = button("History", () => {
      this.view = this.view === "history" ? "chat" : "history";
      if (this.view === "history" && this.overlay && window.innerWidth < 900) this.onOpen();
      this.applyPresentation();
      this.panel.focus();
    });
    this.historyButton.setAttribute("aria-label", "Show message history");
    this.settingsButton = button("Settings", () => this.toggleSettings());
    this.settingsButton.setAttribute("aria-label", "Chat settings");
    this.settingsButton.setAttribute("aria-expanded", "false");
    heading.append(
      node("h2", "Office chat"),
      this.historyButton,
      this.settingsButton,
      button("Hide", () => this.hide()),
    );
    this.filter.setAttribute("aria-label", "Filter office messages");
    this.filter.onchange = () => {
      this.lastRendered = "";
      this.refresh();
    };
    const retry = button("Retry history", () => void this.actions.sync());
    this.toolbar.className = "messages-toolbar";
    this.toolbar.append(this.filter, retry);
    this.historyStatus.className = "messages-history-status";
    this.historyStatus.setAttribute("role", "status");
    this.log.className = "messages-log";
    this.log.tabIndex = 0;
    this.log.setAttribute("role", "region");
    this.log.setAttribute("aria-label", "Shared office message history");
    this.olderButton = button("Load older", () => void this.loadOlder());
    this.log.append(this.olderButton, this.rows);
    this.log.onscroll = () => {
      if (this.restoringScroll || !this.log.getClientRects().length) return;
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
    this.text.oninput = () => {
      this.sendStatus.textContent = "";
      this.updateSubmit();
    };
    this.emoji = messageEmojiPicker((value) => {
      const next = insertMessageText(
        this.text.value,
        this.text.selectionStart,
        this.text.selectionEnd,
        value,
      );
      if (!next) {
        this.sendStatus.textContent =
          "Not inserted: messages allow 200 UTF-16 units; emoji can use several.";
        return;
      }
      this.text.value = next.text;
      this.sendStatus.textContent = "";
      this.emoji.hidden = true;
      this.emojiButton.setAttribute("aria-expanded", "false");
      this.text.focus();
      this.text.setSelectionRange(next.caret, next.caret);
      this.updateSubmit();
    });
    this.emojiButton = button("Emoji & office emotes", () => {
      this.emoji.hidden = !this.emoji.hidden;
      this.emojiButton.setAttribute("aria-expanded", String(!this.emoji.hidden));
      if (!this.emoji.hidden) this.emoji.querySelector("input")?.focus();
    });
    this.emojiButton.setAttribute("aria-expanded", "false");
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
      this.emojiButton,
      this.emoji,
      this.count,
      notifyLabel,
    );
    const privacy = node(
      "p",
      actions.demo
        ? "Demo — no Macs notified. Visible to everyone."
        : "Visible to everyone. Selected people controls who can be notified. Names are unverified.",
    );
    privacy.className = "messages-privacy";
    this.submit = node("button", "Send");
    this.submit.className = "pixel-btn";
    this.submit.type = "submit";
    const footer = node("div");
    footer.className = "messages-send-row";
    footer.append(this.submit);
    this.sendStatus.setAttribute("role", "status");
    this.sendStatus.className = "messages-send-status";
    this.form.append(this.fields, privacy, footer, this.sendStatus);
    this.form.onsubmit = (e) => {
      e.preventDefault();
      void this.send();
    };
    this.writeButton = button("Write a message…", () => this.compose());
    this.writeButton.classList.add("messages-write");
    this.panel.append(
      heading,
      this.toolbar,
      this.historyStatus,
      this.log,
      this.jump,
      this.announcement,
      this.writeButton,
      this.form,
    );
    host.append(this.launcher, this.panel);
    for (const event of ["pointerdown", "pointerup", "click", "wheel"] as const)
      this.panel.addEventListener(event, (e) => e.stopPropagation());
    this.panel.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        if (!this.emoji.hidden) {
          this.emoji.hidden = true;
          this.emojiButton.setAttribute("aria-expanded", "false");
          this.emojiButton.focus();
        } else if (!this.picker.hidden) {
          this.picker.hidden = true;
          this.pickerButton.setAttribute("aria-expanded", "false");
          this.pickerButton.focus();
        } else if (this.settings) this.toggleSettings();
        else this.collapse();
      }
      if (
        !e.isComposing &&
        e.key === "Enter" &&
        (e.ctrlKey || e.metaKey) &&
        this.form.contains(e.target as Node)
      ) {
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
    window.addEventListener("focus", () => {
      this.read();
      this.updateBadge();
    });
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
    this.applyPresentation();
    this.refresh();
    if (this.preferences.visible) this.open(false);
  }
  get expanded(): boolean {
    return !this.panel.hidden;
  }
  /** Fullscreen release auto-reload must not discard a draft even after focus moves away. */
  get hasDraft(): boolean {
    return this.text.value.length > 0 || this.busy;
  }
  get overlay(): boolean {
    return this.preferences.appearance.mode === "overlay";
  }
  get interacting(): boolean {
    return (
      this.expanded &&
      !this.occluded &&
      (!this.overlay || this.view !== "chat" || !!this.settings || !this.atBottom)
    );
  }
  open(focus = true): void {
    this.origin =
      document.activeElement instanceof HTMLElement ? document.activeElement : this.launcher;
    if (!this.overlay) this.onOpen();
    this.preferences.visible = true;
    this.applyPresentation();
    this.refresh();
    if (this.atBottom) this.scrollBottom();
    if (focus) this.panel.focus();
  }
  /** Escape exits interaction; only explicit Hide disables the persistent overlay. */
  collapse(restoreFocus = true): void {
    if (!this.overlay) {
      this.hide(restoreFocus);
      return;
    }
    this.view = "chat";
    this.closePickers();
    this.settings?.remove();
    this.settings = null;
    this.settingsButton.setAttribute("aria-expanded", "false");
    this.applyPresentation();
    if (restoreFocus) this.writeButton.focus();
  }
  private hide(restoreFocus = true): void {
    this.preferences.visible = false;
    this.closePickers();
    this.applyPresentation();
    if (restoreFocus)
      (this.origin?.isConnected && this.origin.getClientRects().length
        ? this.origin
        : this.launcher
      ).focus();
  }
  private closePickers(): void {
    this.picker.hidden = true;
    this.emoji.hidden = true;
    this.pickerButton.setAttribute("aria-expanded", "false");
    this.emojiButton.setAttribute("aria-expanded", "false");
  }
  /** Temporary collisions never rewrite the user's saved placement/visibility. */
  setContext(rightOccupied: boolean, leftOccupied: boolean, modal: boolean): void {
    const key = `${rightOccupied}/${leftOccupied}/${modal}/${window.innerWidth}`;
    if (key === this.contextKey) return;
    this.contextKey = key;
    this.occluded = modal;
    const narrow = window.innerWidth < 900;
    this.yielded = (narrow && (rightOccupied || leftOccupied)) || (rightOccupied && leftOccupied);
    if (this.yielded && this.overlay && this.view !== "chat") this.collapse(false);
    const position = this.preferences.appearance.position;
    this.panel.dataset.position =
      position === "right" && rightOccupied
        ? "left"
        : position === "left" && leftOccupied
          ? "right"
          : position;
    this.panel.classList.toggle("messages-compact", this.yielded);
    this.panel.classList.toggle("messages-both-lanes", rightOccupied && leftOccupied);
    this.panel.classList.toggle("messages-occluded", modal);
    this.read();
  }
  private toggleSettings(): void {
    if (this.settings) {
      this.settings.remove();
      this.settings = null;
      this.settingsButton.setAttribute("aria-expanded", "false");
      this.applyPresentation();
      this.settingsButton.focus();
      return;
    }
    this.closePickers();
    if (this.overlay && window.innerWidth < 900) this.onOpen();
    this.settings = messageSettings(
      this.preferences.appearance,
      (value: MessagePresentation) => {
        const changedMode = value.mode !== this.preferences.appearance.mode;
        this.preferences.appearance = value;
        this.preferences.visible = true;
        if (changedMode && !this.overlay) this.onOpen();
        this.lastRendered = "";
        this.applyPresentation();
        this.refresh();
      },
      () => this.toggleSettings(),
    );
    this.panel.append(this.settings);
    this.settingsButton.setAttribute("aria-expanded", "true");
    this.applyPresentation();
    this.settings.querySelector("select")?.focus();
  }
  private captureReadingPosition(): void {
    if (this.atBottom || !this.log.getClientRects().length) return;
    const top = this.log.getBoundingClientRect().top;
    const row = [...this.rows.querySelectorAll<HTMLElement>("article")].find(
      (row) => row.getBoundingClientRect().bottom > top,
    );
    if (row)
      this.readingAnchor = {
        id: row.dataset.messageId!,
        offset: row.getBoundingClientRect().top - top,
        top: this.log.scrollTop,
      };
  }
  private restoreReadingPosition(): void {
    if (!this.log.getClientRects().length) return;
    if (this.atBottom) {
      this.log.scrollTop = this.log.scrollHeight;
      return;
    }
    const anchor = this.readingAnchor;
    if (!anchor) return;
    this.restoringScroll = true;
    requestAnimationFrame(() => {
      this.restoringScroll = false;
    });
    const row = [...this.rows.querySelectorAll<HTMLElement>("article")].find(
      (row) => row.dataset.messageId === anchor.id,
    );
    if (row)
      this.log.scrollTop +=
        row.getBoundingClientRect().top - this.log.getBoundingClientRect().top - anchor.offset;
    else this.log.scrollTop = anchor.top;
  }
  private applyPresentation(): void {
    this.captureReadingPosition();
    const a = this.preferences.appearance;
    this.panel.classList.toggle("messages-overlay", this.overlay);
    this.panel.classList.toggle(
      "messages-resting",
      this.overlay && this.view === "chat" && !this.settings,
    );
    this.panel.classList.toggle("messages-configuring", !!this.settings);
    this.panel.classList.toggle("messages-text-pixel", a.font === "pixel");
    this.panel.hidden = !this.preferences.visible;
    this.panel.style.setProperty("--chat-width", `${a.width}px`);
    this.panel.style.setProperty("--chat-height", `${a.height}px`);
    this.panel.style.setProperty("--chat-size", `${a.size}px`);
    this.panel.style.setProperty("--chat-fill", `${a.background}%`);
    this.panel.dataset.position = a.position;
    this.contextKey = "";
    this.form.hidden = !!this.settings || (this.overlay && this.view === "chat");
    this.toolbar.hidden = !!this.settings || (this.overlay && this.view !== "history");
    this.log.hidden = !!this.settings;
    this.writeButton.hidden = !!this.settings || !this.overlay || this.view !== "chat";
    this.historyButton.textContent = this.view === "history" ? "Back" : "History";
    this.historyButton.setAttribute(
      "aria-label",
      this.view === "history" ? "Back to chat" : "Show message history",
    );
    this.launcher.setAttribute("aria-expanded", String(this.expanded));
    this.restoreReadingPosition();
    remember(MESSAGE_PRESENTATION_KEY, JSON.stringify(this.preferences));
    if (!this.overlay) remember(EXPANDED_KEY, String(this.preferences.visible));
  }
  compose(personId?: string): void {
    if (!this.busy && personId) {
      const hasDraft = this.text.value.length > 0;
      this.audience.value = "selected";
      if (!hasDraft) this.recipientNames.clear();
      this.recipientNames.set(personId, this.office.people.get(personId)?.name ?? personId);
      if (!hasDraft) this.notify.checked = true;
    }
    this.view = "compose";
    if (this.overlay && window.innerWidth < 900) this.onOpen();
    this.open(false);
    this.renderRecipients();
    this.updateSubmit();
    if (this.atBottom) this.scrollBottom();
    this.text.focus();
  }
  clear(): void {
    this.text.value = "";
    this.from.value = "";
    this.recipientNames.clear();
    this.sendStatus.textContent = "";
    this.announcement.textContent = "";
    this.view = "chat";
    this.settings?.remove();
    this.settings = null;
    this.settingsButton.setAttribute("aria-expanded", "false");
    this.hide(false);
    this.rows.replaceChildren();
    this.refresh();
  }
  announce(message: MessageRecord): void {
    this.announcement.textContent = `${message.from || "Someone"} sent an office message.`;
  }
  refresh(): void {
    const followBottom = this.atBottom && !this.loadingOlder;
    if (!followBottom && !this.loadingOlder) this.captureReadingPosition();
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
    const key = JSON.stringify([this.filter.value, visible, [...this.model.ownedIds]]);
    if (key !== this.lastRendered) {
      this.lastRendered = key;
      const existing = new Map(
        [...this.rows.querySelectorAll<HTMLElement>("article")].map((row) => [
          row.dataset.messageId,
          row,
        ]),
      );
      const keep = new Set(visible.map((row) => row.id));
      for (const child of [...this.rows.children]) {
        if (
          !(child instanceof HTMLElement) ||
          !child.dataset.messageId ||
          !keep.has(child.dataset.messageId)
        )
          child.remove();
      }
      if (!visible.length)
        this.rows.append(
          node("p", this.model.initialized ? "No messages here yet." : "Waiting for history…"),
        );
      let previous: Element | null = null;
      for (const m of visible) {
        const rowKey = JSON.stringify([
          m,
          this.model.ownedIds.has(m.id),
          this.deleting.has(m.id),
          this.preferences.appearance,
        ]);
        const saved = existing.get(m.id);
        if (saved?.dataset.rowKey === rowKey) {
          if (saved !== (previous ? previous.nextElementSibling : this.rows.firstElementChild))
            this.rows.insertBefore(
              saved,
              previous ? previous.nextElementSibling : this.rows.firstElementChild,
            );
          previous = saved;
          continue;
        }
        const article = node("article");
        article.dataset.rowKey = rowKey;
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
        if (this.preferences.appearance.icons) {
          const icon = node(
            "span",
            (m.from || "?")
              .trim()
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => Array.from(part)[0])
              .join(""),
          );
          icon.className = "messages-sender-icon";
          icon.setAttribute("aria-hidden", "true");
          byline.append(icon);
        }
        if (this.preferences.appearance.timestamps) byline.append(time);
        byline.append(
          node(
            "b",
            `${m.from || "Someone"} → ${m.audience === "everyone" ? "Everyone" : m.recipients.map((p) => p.name).join(", ")}`,
          ),
        );
        const body = node("p");
        body.append(renderMessageText(m.text, this.preferences.appearance.emotes));
        body.dir = "auto";
        article.append(byline, body);
        if (this.model.ownedIds.has(m.id)) {
          const remove = button("Delete", () => void this.deleteMessage(m.id));
          remove.setAttribute("aria-label", "Delete your message");
          remove.disabled = this.deleting.has(m.id);
          const actions = node("details");
          actions.className = "messages-row-actions";
          actions.append(node("summary", "More actions"), remove);
          article.append(actions);
        }
        if (saved) saved.replaceWith(article);
        if (article !== (previous ? previous.nextElementSibling : this.rows.firstElementChild))
          this.rows.insertBefore(
            article,
            previous ? previous.nextElementSibling : this.rows.firstElementChild,
          );
        previous = article;
      }
    }
    this.historyStatus.textContent = this.actions.status();
    this.olderButton.hidden = this.model.older === null;
    this.olderButton.disabled = this.loadingOlder;
    this.updateSubmit();
    if (followBottom && this.expanded) this.scrollBottom();
    else if (!this.loadingOlder) this.restoreReadingPosition();
    this.read();
    this.updateBadge();
  }
  private read(): void {
    this.model.markRead(
      this.expanded &&
        !this.occluded &&
        !this.settings &&
        this.log.getClientRects().length > 0 &&
        document.visibilityState === "visible" &&
        document.hasFocus(),
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
    this.fields.disabled = this.busy;
    this.submit.disabled = this.busy || !this.text.value.trim() || !validRecipients;
    this.count.textContent = `${this.text.value.length}/200`;
    const count = selected ? this.recipientNames.size : this.office.people.size;
    this.submit.textContent = this.busy
      ? "Sending…"
      : this.notify.checked
        ? `Send + notify ${count} ${count === 1 ? "person" : "people"}`
        : "Send";
  }
  private async deleteMessage(id: string): Promise<void> {
    if (
      this.deleting.has(id) ||
      !confirm(
        "Delete this message from shared office history? Already queued Mac notifications cannot be recalled.",
      )
    )
      return;
    this.deleting.add(id);
    this.lastRendered = "";
    this.refresh();
    try {
      await this.actions.delete(id);
      this.announcement.textContent = "Message deleted from office history.";
    } catch (error) {
      this.sendStatus.textContent =
        error instanceof Error ? error.message : "Deletion failed; try again.";
    } finally {
      this.deleting.delete(id);
      this.lastRendered = "";
      this.refresh();
    }
  }
  private async send(): Promise<void> {
    if (this.submit.disabled) return;
    const parsed = SendMessageRequest.safeParse({
      audience:
        this.audience.value === "everyone"
          ? { kind: "everyone" }
          : { kind: "selected", personIds: [...this.recipientNames.keys()] },
      text: this.text.value,
      from: this.from.value.trim(),
      notifyDesktop: this.notify.checked,
    });
    if (!parsed.success) {
      this.sendStatus.textContent = "Check the text and selected recipients.";
      return;
    }
    const request = parsed.data;
    if (
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
    try {
      const { queued } = await this.actions.send(request);
      this.text.value = "";
      this.sendStatus.textContent = this.actions.demo
        ? "Saved in this demo — no Macs notified."
        : !request.notifyDesktop
          ? "Saved to office history."
          : `Saved. Queued to ${queued} connected Mac socket${queued === 1 ? "" : "s"}. Not a display/read receipt.`;
    } catch (error) {
      this.sendStatus.textContent =
        error instanceof Error ? error.message : "Send failed. Draft retained.";
    } finally {
      this.busy = false;
      this.updateSubmit();
    }
  }
}
