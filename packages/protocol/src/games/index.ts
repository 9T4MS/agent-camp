import { z } from "zod";

export * from "./battleship.ts";
export * from "./fourInARow.ts";
export * from "./types.ts";

/** The games an office can play. The names shown to people live in the web app. */
export const GameKind = z.enum(["battleship", "four-in-a-row"]);
export type GameKind = z.infer<typeof GameKind>;
