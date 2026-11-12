/** Exact allowlisted tokens; authored text is never interpreted as markup or a URL. */
export const officeEmotes = [
  ["campfire", "Campfire"],
  ["coffee", "Coffee break"],
  ["wave", "Hello wave"],
  ["shipit", "Ship it rocket"],
  ["thinking", "Thinking"],
  ["party", "Party popper"],
].map(([name, label]) => ({
  token: `:${name}:`,
  label: label!,
  url: `/emotes/office/${name}.svg`,
}));
export const unicodeEmoji = [
  ["😀", "Smile"],
  ["👋", "Wave"],
  ["👍🏽", "Thumbs up"],
  ["❤️", "Heart"],
  ["☕", "Coffee"],
  ["🎉", "Party"],
  ["🔥", "Fire"],
  ["🚀", "Rocket"],
  ["👩🏽‍💻", "Technologist"],
  ["🤔", "Thinking"],
  ["✅", "Done"],
  ["🏕️", "Camp"],
] as const;
export function insertMessageText(text: string, start: number, end: number, value: string) {
  const next = text.slice(0, start) + value + text.slice(end);
  return next.length <= 200 ? { text: next, caret: start + value.length } : null;
}
export function messageFragments(text: string) {
  return text
    .split(/(:[a-z]+:)/g)
    .filter(Boolean)
    .map((value) => ({
      text: value,
      emote: officeEmotes.find((emote) => emote.token === value),
    }));
}
export function renderMessageText(text: string, images: boolean): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const part of messageFragments(text)) {
    if (!images || !part.emote) {
      fragment.append(document.createTextNode(part.text));
      continue;
    }
    const image = document.createElement("img");
    image.src = part.emote.url;
    image.alt = part.text;
    image.title = part.emote.label;
    image.width = 24;
    image.height = 24;
    image.className = "message-emote";
    image.onerror = () => image.replaceWith(document.createTextNode(part.text));
    fragment.append(image);
  }
  return fragment;
}
