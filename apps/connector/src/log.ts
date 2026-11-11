/** One readable line per change: "2026-11-10T09:00:00Z session+ claude agent-office typing". */
export type Logger = (line: string) => void;

export const log: Logger = (line) => {
  console.log(`${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")} ${line}`);
};

export const silent: Logger = () => {};
