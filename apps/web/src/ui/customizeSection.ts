/**
 * "Head GIF" section of your own person card (only once this browser confirmed "It's me",
 * like the look editor): shows the GIF over your head and lets you paste a Giphy link to set,
 * change or remove it (PUT /api/people/:id/gif; the server checks the `ao_me` cookie).
 *
 * The HUD re-renders the rest of the card with innerHTML on nearly every model change, so this
 * section is a long-lived element (one per opened person) that the HUD re-appends after each
 * render and doesn't re-render while it has focus; `update()` only refreshes the "current GIF"
 * bits. The current GIF follows the model (`gif.updated`), never the PUT response.
 *
 * Every string goes in via textContent; image URLs are only ever built by giphyGifUrl().
 */
import { giphyGifUrl, giphyPageUrl } from "@agent-office/protocol";
import {
  type GifInputCheck,
  type PutGifResult,
  saveOutcome,
  validateGifInput,
} from "./customize.ts";

/** Injected by main.ts: PUT the link (null = remove). Resolves with status 0 on network errors. */
export type PutGif = (personId: string, link: string | null) => Promise<PutGifResult>;

type Tone = "info" | "ok" | "error";

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class CustomizeSection {
  readonly root: HTMLElement;
  private currentLink: HTMLAnchorElement;
  private currentImg: HTMLImageElement;
  private none: HTMLElement;
  private input: HTMLInputElement;
  private newBox: HTMLElement;
  private newImg: HTMLImageElement;
  private hint: HTMLElement;
  private saveBtn: HTMLButtonElement;
  private removeBtn: HTMLButtonElement;
  private status: HTMLElement;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  private gif: string | undefined;
  private check: GifInputCheck = { state: "empty" };
  private saving = false;

  constructor(
    readonly personId: string,
    gif: string | undefined,
    private readonly putGif: PutGif,
  ) {
    this.root = node("section", "customize");
    this.root.setAttribute("aria-label", "Head GIF");
    const title = node("div", "today-title customize-title", "GIF over your head");

    const current = node("div", "customize-current");
    this.currentLink = node("a", "customize-current-link");
    this.currentLink.target = "_blank";
    this.currentLink.rel = "noopener noreferrer";
    this.currentLink.title = "Open on Giphy";
    this.currentImg = node("img", "customize-current-img");
    this.currentImg.alt = "Current GIF";
    this.currentImg.decoding = "async";
    this.currentImg.referrerPolicy = "no-referrer";
    this.currentLink.append(this.currentImg);
    this.none = node("span", "customize-none dim", "No GIF yet");
    current.append(this.currentLink, this.none);

    // Enter is handled on the input
    const form = node("form", "customize-form");
    form.noValidate = true;
    form.addEventListener("submit", (e) => e.preventDefault());

    this.input = node("input", "customize-input");
    this.input.type = "text";
    this.input.inputMode = "url";
    this.input.placeholder = "Paste a Giphy link";
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.setAttribute("autocapitalize", "off");
    this.input.setAttribute("autocorrect", "off");
    this.input.setAttribute("enterkeyhint", "done");
    this.input.setAttribute("aria-label", "Giphy link");
    this.input.maxLength = 2000;
    this.input.addEventListener("input", () => {
      if (!this.saving) this.setStatus("", "info");
      this.revalidate();
    });
    this.input.addEventListener("keydown", (e) => this.onKey(e));

    this.newBox = node("div", "customize-new");
    this.newImg = node("img", "customize-new-img");
    this.newImg.alt = "New GIF preview";
    this.newImg.decoding = "async";
    this.newImg.referrerPolicy = "no-referrer";
    this.newImg.addEventListener("error", () => {
      if (this.check.state === "valid" && this.newImg.getAttribute("src"))
        this.hint.textContent = "Giphy has no preview for that GIF";
    });
    this.newBox.append(node("span", "customize-new-label dim", "New"), this.newImg);

    this.hint = node("div", "customize-hint");
    this.hint.setAttribute("aria-live", "polite");

    const buttons = node("div", "customize-buttons");
    this.saveBtn = node("button", "pixel-btn customize-save", "Save");
    this.saveBtn.type = "button";
    this.saveBtn.addEventListener("click", () => void this.submit("save"));
    this.removeBtn = node("button", "pixel-btn customize-remove", "Remove");
    this.removeBtn.type = "button";
    this.removeBtn.addEventListener("click", () => void this.submit("remove"));
    buttons.append(this.saveBtn, this.removeBtn);

    this.status = node("div", "customize-status");
    this.status.setAttribute("role", "status");

    form.append(this.input, this.newBox, this.hint, buttons, this.status);
    this.root.append(title, current, form);
    this.showCurrent(gif);
    this.revalidate();
  }

  /** The model changed: refresh the current GIF (keeps whatever is being typed). */
  update(gif: string | undefined) {
    if (gif !== this.gif) this.showCurrent(gif);
    this.revalidate();
  }

  private showCurrent(gif: string | undefined) {
    this.gif = gif;
    if (gif) {
      this.currentLink.href = giphyPageUrl(gif);
      this.currentImg.src = giphyGifUrl(gif);
    } else {
      this.currentLink.removeAttribute("href");
      this.currentImg.removeAttribute("src");
    }
    this.currentLink.hidden = !gif;
    this.none.hidden = !!gif;
  }

  private revalidate() {
    this.check = validateGifInput(this.input.value, this.gif);
    const c = this.check;
    this.hint.textContent = c.state === "invalid" || c.state === "same" ? c.hint : "";
    this.hint.classList.toggle("is-error", c.state === "invalid");
    if (c.state === "valid") {
      const src = giphyGifUrl(c.id);
      if (this.newImg.getAttribute("src") !== src) this.newImg.src = src;
      this.newBox.hidden = false;
    } else {
      this.newImg.removeAttribute("src");
      this.newBox.hidden = true;
    }
    this.renderButtons();
  }

  private renderButtons() {
    this.saveBtn.disabled = this.saving || this.check.state !== "valid";
    this.removeBtn.disabled = this.saving || !this.gif;
    this.input.readOnly = this.saving;
  }

  private setStatus(text: string, tone: Tone, clearAfterMs = 0) {
    clearTimeout(this.statusTimer);
    this.status.textContent = text;
    this.status.classList.toggle("is-error", tone === "error");
    this.status.classList.toggle("is-ok", tone === "ok");
    if (clearAfterMs > 0)
      this.statusTimer = setTimeout(() => {
        if (this.status.textContent === text) this.setStatus("", "info");
      }, clearAfterMs);
  }

  /** Enter saves; Escape blurs. Typing must not reach the office keyboard shortcuts. */
  private onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      // keep the card (and an unsaved link) open; a second Escape closes the card
      (e.currentTarget as HTMLElement).blur();
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      if (!this.saveBtn.disabled) void this.submit("save");
    }
  }

  private async submit(action: "save" | "remove") {
    if (this.saving) return;
    const link = action === "save" && this.check.state === "valid" ? this.check.id : null;
    if (action === "save" ? link === null : !this.gif) return;
    this.saving = true;
    this.setStatus("Saving…", "info");
    this.renderButtons();
    const res = await this.putGif(this.personId, link).catch(
      (): PutGifResult => ({ status: 0, body: null }),
    );
    this.saving = false;
    const out = saveOutcome(res);
    if (out.kind === "saved") {
      if (action === "save") this.input.value = "";
      this.setStatus(action === "save" ? "Saved" : "Removed", "ok", 3000);
    } else {
      this.setStatus(out.message, "error");
    }
    this.revalidate();
  }
}
