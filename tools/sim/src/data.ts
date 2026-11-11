/** Fake teammates, projects and weighted picks shared by every simulator mode. */
import type { Activity, AgentKind } from "@agent-office/protocol";

export type PersonDef = {
  name: string;
  description: string;
  /** favourite projects (folder basenames) */
  projects: readonly string[];
};

export const PEOPLE: readonly PersonDef[] = [
  {
    name: "Anna",
    // deliberately longer than 200 chars: exercises the detailed-look path (lookDescription)
    description:
      "Curly copper-red hair to the shoulders, round gold-rimmed glasses, a few freckles and a " +
      "big smile. Always in an oversized mustard-yellow hoodie with the sleeves pushed up, dark " +
      "green cargo trousers with a rolled hem, mismatched striped socks and scuffed white " +
      "high-top sneakers. Usually has a pencil tucked behind one ear.",
    projects: ["agent-office", "website"],
  },
  {
    name: "Martin",
    description: "short dark hair, stubble, big headphones",
    projects: ["billing-api", "agent-office", "infra"],
  },
  {
    name: "Lena",
    description: "blonde ponytail, loves plants on her desk",
    projects: ["design-system", "website"],
  },
  {
    name: "Jonas",
    description: "buzz cut, full beard, beanie",
    projects: ["data-pipeline", "infra"],
  },
  {
    name: "Sofia",
    description: "long black hair, square glasses, rubber duck on the desk",
    projects: ["mobile-app", "design-system"],
  },
  {
    name: "Felix",
    description: "messy brown hair, baseball cap, coffee addict",
    projects: ["game-jam", "agent-office"],
  },
  { name: "Mia", description: "pink hair in a top bun, earrings", projects: ["website", "docs"] },
  {
    name: "Paul",
    description: "bald, mustache, tidy desk with a lamp",
    projects: ["billing-api", "data-pipeline"],
  },
  {
    name: "Clara",
    description: "silver hair, sunglasses indoors, hair bow",
    projects: ["mobile-app", "docs"],
  },
  { name: "Noah", description: "blue dyed mohawk, figurines everywhere", projects: ["game-jam"] },
  {
    name: "Emma",
    description: "ginger curls, freckles, stack of books",
    projects: ["research-notes", "agent-office"],
  },
  {
    name: "Leo",
    description: "tan skin, short black hair, cactus fan",
    projects: ["infra", "cli"],
  },
  { name: "Ida", description: "auburn bob, round glasses", projects: ["cli", "docs"] },
  { name: "Ben", description: "dark brown curls, beard, headphones", projects: ["mobile-app"] },
  { name: "Hanna", description: "long blonde hair, cat photo on desk", projects: ["website"] },
  { name: "Tom", description: "buzz cut, sunglasses, messy desk", projects: ["data-pipeline"] },
  { name: "Lea", description: "ponytail, beanie, two mugs at once", projects: ["design-system"] },
  { name: "Max", description: "grey hair, stubble, lamp and books", projects: ["billing-api"] },
  { name: "Nina", description: "black bun, earring, plants", projects: ["research-notes"] },
  { name: "Elias", description: "brown hair, cap, rubber duck", projects: ["game-jam", "cli"] },
];

/** Person by index; wraps around with a numeric suffix so any count works. */
export function personAt(i: number): PersonDef {
  const base = PEOPLE[i % PEOPLE.length]!;
  const round = Math.floor(i / PEOPLE.length);
  return round === 0 ? base : { ...base, name: `${base.name} ${round + 1}` };
}

export type Weighted<T> = readonly (readonly [T, number])[];

export function weighted<T>(rand: () => number, table: Weighted<T>): T {
  let total = 0;
  for (const [, w] of table) total += w;
  let r = rand() * total;
  for (const [v, w] of table) {
    r -= w;
    if (r < 0) return v;
  }
  return table[table.length - 1]![0];
}

/** Mostly Claude, some Codex and Pi, rarely unknown. */
export const AGENT_MIX: Weighted<AgentKind> = [
  ["claude", 70],
  ["codex", 17],
  ["pi", 10],
  ["unknown", 3],
];

/** Activity a fresh session starts in. */
export const START_ACTIVITY: Weighted<Activity> = [
  ["thinking", 40],
  ["reading", 30],
  ["typing", 15],
  ["running", 15],
];

/** Plausible next activity given the current one (a tiny Markov chain). */
export const NEXT_ACTIVITY: Record<Activity, Weighted<Activity>> = {
  thinking: [
    ["reading", 35],
    ["typing", 30],
    ["running", 20],
    ["waiting", 10],
    ["thinking", 5],
  ],
  reading: [
    ["reading", 20],
    ["thinking", 35],
    ["typing", 30],
    ["running", 15],
  ],
  typing: [
    ["typing", 20],
    ["running", 30],
    ["thinking", 30],
    ["reading", 10],
    ["waiting", 10],
  ],
  running: [
    ["thinking", 40],
    ["typing", 25],
    ["reading", 20],
    ["waiting", 10],
    ["running", 5],
  ],
  waiting: [
    ["thinking", 60],
    ["waiting", 25],
    ["idle", 15],
  ],
  idle: [
    ["thinking", 50],
    ["idle", 40],
    ["waiting", 10],
  ],
};

/** 0-based random hex string of `len` chars from `rand`. */
export function hex(rand: () => number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

export function intBetween(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}
