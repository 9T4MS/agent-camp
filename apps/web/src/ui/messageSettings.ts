import {
  defaultPresentation,
  type MessagePresentation,
  presentationOptions,
} from "../state/messagePreferences.ts";
import { renderMessageText } from "./messageEmotes.ts";

export function messageSettings(
  appearance: MessagePresentation,
  change: (value: MessagePresentation) => void,
  close: () => void,
) {
  const section = document.createElement("section");
  section.className = "messages-settings";
  section.setAttribute("aria-label", "Chat settings");
  const heading = document.createElement("h3");
  heading.textContent = "Chat settings";
  const description = document.createElement("p");
  description.textContent =
    "Saved only in this browser for this office. History: 24 hours, newest 100 messages.";
  section.append(heading, description);
  const labels: Record<keyof MessagePresentation, string> = {
    mode: "Display",
    position: "Position",
    width: "Width",
    height: "Feed height",
    size: "Text size",
    font: "Text style",
    background: "Overlay background",
    icons: "Sender icons",
    timestamps: "Timestamps",
    emotes: "Office emotes",
  };
  const names: Record<string, string> = {
    overlay: "Chat overlay",
    popup: "Button + popup",
    left: "Bottom left",
    right: "Bottom right",
    readable: "Readable",
    pixel: "Pixel",
    "0": "Clear (0%)",
    "20": "Soft (20%)",
    "85": "Dark (85%)",
    "100": "Solid (100%)",
  };
  const selects = new Map<keyof MessagePresentation, HTMLSelectElement>();
  const sample = document.createElement("div");
  sample.className = "messages-sample";
  const update = () => {
    sample.style.fontSize = `${appearance.size}px`;
    sample.style.fontFamily =
      appearance.font === "pixel" ? "var(--font-body)" : "system-ui, sans-serif";
    sample.replaceChildren(
      renderMessageText("Anna → Everyone · Coffee? :coffee: ☕", appearance.emotes),
    );
  };
  for (const key of Object.keys(labels) as (keyof MessagePresentation)[]) {
    const label = document.createElement("label");
    label.textContent = labels[key];
    const select = document.createElement("select");
    select.setAttribute("aria-label", labels[key]);
    for (const value of presentationOptions[key]) {
      const title =
        typeof value === "boolean"
          ? key === "emotes"
            ? value
              ? "Images"
              : "Text names"
            : value
              ? "On"
              : "Off"
          : typeof value === "number" && key !== "background"
            ? `${value}px`
            : (names[String(value)] ?? String(value));
      select.add(new Option(title, String(value)));
    }
    select.value = String(appearance[key]);
    select.onchange = () => {
      const value = presentationOptions[key].find((v) => String(v) === select.value);
      appearance = { ...appearance, [key]: value };
      change(appearance);
      update();
    };
    selects.set(key, select);
    label.append(select);
    section.append(label);
  }
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "pixel-btn";
  reset.textContent = "Reset appearance";
  reset.onclick = () => {
    appearance = { ...defaultPresentation };
    for (const [key, select] of selects) select.value = String(appearance[key]);
    change(appearance);
    update();
  };
  const done = document.createElement("button");
  done.type = "button";
  done.className = "pixel-btn";
  done.textContent = "Done";
  done.onclick = close;
  section.append(sample, reset, done);
  update();
  return section;
}
