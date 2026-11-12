import { officeEmotes, renderMessageText, unicodeEmoji } from "./messageEmotes.ts";

export function messageEmojiPicker(insert: (value: string) => void) {
  const section = document.createElement("section");
  section.className = "messages-emoji-picker";
  section.setAttribute("aria-label", "Emoji & office emotes");
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search emoji & emotes";
  search.setAttribute("aria-label", "Search emoji & emotes");
  const tabs = document.createElement("div");
  const results = document.createElement("div");
  results.className = "messages-emoji-results";
  let office = false;
  const render = () => {
    results.replaceChildren();
    const entries = office ? officeEmotes.map((e) => [e.token, e.label]) : unicodeEmoji;
    for (const [value, label] of entries) {
      if (!`${value} ${label}`.toLowerCase().includes(search.value.toLowerCase())) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pixel-btn";
      button.setAttribute("aria-label", `${label} ${value}`);
      button.title = label!;
      button.append(renderMessageText(value!, true));
      button.onclick = () => insert(value!);
      results.append(button);
    }
    if (!results.childElementCount) results.textContent = "No emoji or emotes found.";
  };
  for (const label of ["Emoji", "Office"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pixel-btn";
    button.textContent = label;
    button.setAttribute("aria-pressed", String((label === "Office") === office));
    button.onclick = () => {
      office = label === "Office";
      for (const tab of tabs.querySelectorAll("button"))
        tab.setAttribute("aria-pressed", String(tab === button));
      render();
    };
    tabs.append(button);
  }
  search.oninput = render;
  section.append(tabs, search, results);
  render();
  section.hidden = true;
  return section;
}
