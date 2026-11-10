# Decisions

Implementer-decides choices from `PLAN.md`, one line of reasoning each. Newest at the bottom.

| #   | Topic            | Decision                                                                                                                    | Why                                                                                                                         |
| --- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Repo shape       | One monorepo, Bun workspaces (`packages/*`, `apps/*`, `tools/*`)                                                            | Shared protocol types, one PR flow, one CI file; Bun is already the runtime for tests and the connector.                    |
| 2   | Package wiring   | Workspaces import TS source directly (`exports: ./src/index.ts`, `workspace:*`), no build step for `@agent-office/protocol` | Bun, Vite and Wrangler (esbuild) all consume TS natively; zero build orchestration.                                         |
| 3   | Connector        | Single Bun-compiled binary (`bun build --compile`, darwin-arm64/x64), runs under launchd                                    | Same TypeScript + protocol package as the server; one file to download and swap on self-update; still runs on Linux for CI. |
| 4   | Server           | Cloudflare Workers free plan + one SQLite-backed Durable Object (`office`) with WebSocket Hibernation                       | Long-lived WebSockets, free HTTPS/wss, durable SQLite for history; matches the recommendation.                              |
| 5   | Hub core         | Runtime-agnostic Hub (state, `diff()`, stats) in plain TS, wrapped by the DO and by a Bun dev harness                       | Unit tests and local e2e need no Workers runtime; the DO is a thin adapter.                                                 |
| 6   | Renderer         | PixiJS v8 + Vite, served as static assets by the Worker                                                                     | Fast WebGL sprites, good pixel-art support (nearest scaling), tiny API surface vs. a full game engine.                      |
| 7   | Schemas          | zod v4 for every wire message, discriminated unions per channel, non-throwing parsers                                       | One source of truth for runtime validation and TS types; v4 is smaller and faster.                                          |
| 8   | Lint/format      | Biome (recommended rules, 2-space, width 100)                                                                               | One fast tool for lint + format, no ESLint/Prettier config sprawl.                                                          |
| 9   | Tests            | `bun test` everywhere                                                                                                       | Built into the runtime, fast, no Jest/Vitest config.                                                                        |
| 10  | Art style        | Cozy top-down 3/4 office, 16 px tiles scaled by integers, Endesga 32 palette, characters drawn in code (paper-doll layers)  | Consistent intentional look with no asset licensing; palette constants live in `@agent-office/protocol`.                    |
| 11  | Agent colors     | Claude `#be4a2f`, Codex `#0099db`, Pi `#63c74d`, unknown `#8b9bb4` (all Endesga 32, with light/shade ramps)                 | Fixed hues from PLAN mapped to the nearest palette entries.                                                                 |
| 12  | IDs              | ULIDs (dependency-free) for envelope ids; `personId` = slug of the display name; `sessionId` = `clientId:sessionKey`        | Time-sortable ids; two laptops with the same name become one person; session ids stable across reconnects.                  |
| 13  | Avatars w/o AI   | `avatarFromSeed(name)` via FNV-1a + mulberry32; `sessionVariation(sessionKey)` for sibling tweaks                           | Deterministic on every side, so server and renderer agree without coordination.                                             |
| 14  | Extra close code | `4003` = bad message (besides 4001 bad password, 4002 too old)                                                              | Lets the connector distinguish its own bugs from auth problems.                                                             |

## Pending / unbuilt ideas

- (fill in as we go)
