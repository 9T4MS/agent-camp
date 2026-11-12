/** Browser-local presentation only: never store message bodies or delivery options here. */
export const MESSAGE_PRESENTATION_KEY = "agent-office.messages.presentation.v1";
export const presentationOptions = {
  mode: ["overlay", "popup"],
  position: ["left", "right"],
  width: [320, 380, 440],
  height: [200, 280, 400],
  size: [16, 18, 20],
  font: ["readable", "pixel"],
  background: [0, 20, 85, 100],
  icons: [true, false],
  timestamps: [true, false],
  emotes: [true, false],
} as const;
export type MessagePresentation = {
  [K in keyof typeof presentationOptions]: (typeof presentationOptions)[K][number];
};
export const defaultPresentation: MessagePresentation = {
  mode: "overlay",
  position: "left",
  width: 380,
  height: 280,
  size: 16,
  font: "readable",
  background: 85,
  icons: true,
  timestamps: true,
  emotes: true,
};
export type MessagePreferences = { version: 1; visible: boolean; appearance: MessagePresentation };
export function messagePreferences(raw: string | null, legacy: string | null): MessagePreferences {
  const result: MessagePreferences = {
    version: 1,
    visible: legacy === null || legacy === "true",
    appearance: { ...defaultPresentation, mode: legacy === null ? "overlay" : "popup" },
  };
  try {
    const saved = JSON.parse(raw ?? "null");
    if (saved?.version !== 1) return result;
    if (typeof saved.visible === "boolean") result.visible = saved.visible;
    for (const key of Object.keys(presentationOptions) as (keyof MessagePresentation)[]) {
      const value = saved.appearance?.[key];
      if ((presentationOptions[key] as readonly unknown[]).includes(value))
        Object.assign(result.appearance, { [key]: value });
    }
  } catch {
    /* unavailable/malformed storage uses defaults */
  }
  return result;
}
