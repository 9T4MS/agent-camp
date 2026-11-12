/** Turn-based games over HTTP: the browser asks, the result also arrives on the viewer socket. */
import { type GameRequest, GameResponse } from "@agent-office/protocol";
import { loginIfLoggedOut } from "./viewer.ts";

export type GameReply = { ok: true; res: GameResponse } | { ok: false; error: string };

export class GamesClient {
  constructor(
    private opts: {
      key?: string | null;
      fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    } = {},
  ) {}

  private async request(path: string, body?: GameRequest, retry = true): Promise<GameReply> {
    const url = `${path}${this.opts.key ? `?key=${encodeURIComponent(this.opts.key)}` : ""}`;
    let r: Response;
    try {
      r = await (this.opts.fetch ?? fetch)(url, {
        cache: "no-store",
        ...(body
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
    } catch {
      return { ok: false, error: "Could not reach the office." };
    }
    if (r.status === 401) void loginIfLoggedOut();
    // the limiter is per network address, so a colleague's click can be in the way: once more
    if (r.status === 429 && retry) {
      await new Promise((done) => setTimeout(done, 350));
      return this.request(path, body, false);
    }
    const data: unknown = await r.json().catch(() => null);
    if (!r.ok) {
      const error = data && typeof data === "object" && "error" in data ? String(data.error) : "";
      return { ok: false, error: error || `That did not work (${r.status}).` };
    }
    const parsed = GameResponse.safeParse(data);
    return parsed.success
      ? { ok: true, res: parsed.data }
      : { ok: false, error: "The office answered something unexpected." };
  }

  post(body: GameRequest): Promise<GameReply> {
    return this.request("/api/games", body);
  }

  /** The game with the board as I may see it (my own fleet included). */
  get(id: string): Promise<GameReply> {
    return this.request(`/api/games/${encodeURIComponent(id)}`);
  }

  /** My settings (game notifications on my Mac). */
  settings(): Promise<GameReply> {
    return this.request("/api/games/me");
  }
}
