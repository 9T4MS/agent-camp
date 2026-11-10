# Agent Office — Build Plan

## Mission brief

Build Agent Office overnight: a small Mac connector, installed with one shell command, that detects local coding-agent sessions and reports them over WebSocket to a server, which renders a live pixel-art office where every teammate and every running agent shows up as an animated character. Implement, test and verify everything yourself, end to end, and leave screenshots for the morning.

This is a coding-camp project for a small team, used for about half a week. Optimize for fun, clean code, and a nice look. Do not build for scale, enterprise security, or long-term maintenance.

Hard constraints:

- Team uses macOS only. The connector is a small CLI daemon built in GitHub Actions that auto-updates from main.
- GitHub flow: one `main` branch, every change via pull request, merge to main ships a new connector and server, live on every machine within minutes. Fast beats small.
- AI usage must be near-zero cost and fully optional. Everything must work with AI turned off.
- Privacy: the connector never sends prompts, file contents, tool inputs, or code. Only status metadata.
- Simple auth: one shared password. No accounts, no OAuth.
- The repo is public.

You own every decision marked "implementer decides". Make it, write it down in `DECISIONS.md` with one line of reasoning, and keep going. Do not stop overnight to ask questions.

Morning deliverables: a PR ready to merge (or a green main), screenshots of the office in several states, a short README for teammates, and `DECISIONS.md`.

## Decisions: fixed vs. yours

| Topic | Status | Recommendation |
| --- | --- | --- |
| One repo vs. two | Implementer decides | One monorepo. Shared protocol types, one PR flow, one CI file. |
| Connector | Implementer decides | Headless CLI daemon (single Bun-compiled binary, or Rust/Go), installed via one shell command, runs under launchd. |
| Server | Implementer decides | Cloudflare Workers free plan + one SQLite-backed Durable Object. Any similar host with long-lived WebSockets is fine; Vercel is out (no long-lived WebSockets). |
| Office renderer | Implementer decides | PixiJS v8 or Phaser 3 in the browser, served as static assets by the Worker. |
| Art style | Implementer decides | Cozy top-down office, 16 px tiles scaled up, limited palette. Not Pokemon. |
| Transport | Fixed | WebSocket, JSON messages, versioned envelope, schema-validated. |
| Auth | Fixed | One shared connector password. Viewer is read-only. |
| Agents supported | Fixed | Claude Code first. Codex and Pi if time allows. |
| Agent colors | Fixed | Claude = warm red-orange jacket, Codex = blue, Pi = green, unknown = grey. |
| Data sent | Fixed | Status metadata only. |
| AI usage | Fixed | Off by default, event-driven, cached, hard daily cap. |
| Auto-update | Fixed | Merge to main → new connector + server live in under 5 minutes. |

## Repo layout

```
agent-office/
  packages/protocol/    zod schemas + TS types for every message, shared by all
  apps/server/          Cloudflare Worker + Durable Object: hub, state, history, genUI
  apps/web/             office renderer (static assets served by the Worker)
  apps/connector/       CLI daemon + install.sh
  tools/sim/            fake teammates + sessions for testing and screenshots
  fixtures/home/        fake ~/.claude, ~/.codex, ~/.pi trees for detector tests
  .github/workflows/    ci.yml, release.yml
  PLAN.md  DECISIONS.md  README.md
```

Commit sample JSON for every message type under `packages/protocol/fixtures/` and test that each parses on every side (including the connector if it is not TypeScript).

## Connector (CLI daemon)

Install is one line: `curl -fsSL https://<server>/install.sh | sh`. It downloads the right binary for the Mac's architecture from the latest GitHub Release, asks for server URL, password, display name, and an optional one-line self-description for the avatar ("curly hair, round glasses, always in a hoodie"), writes `~/.config/agent-office/config.toml`, and registers a launchd agent so it runs at login. Commands: `agent-office status`, `agent-office logs`, `agent-office uninstall`.

Files downloaded with curl are not quarantined, so no Gatekeeper right-click step is needed.

Headless test mode: `agent-office run --server ws://... --password ... --name ...`, plus `AGENT_OFFICE_HOME` to point detectors at `fixtures/home` instead of `~`. Overnight tests run against this, possibly on Linux, so the core must build and run cross-platform.

### Self-update (fast)

- The server sends `latestConnectorVersion` in `connector.welcomed`. A deploy restarts the Durable Object, so every connector reconnects within seconds, sees the new version, downloads it, swaps its binary and restarts via launchd.
- Fallback: poll the latest GitHub release every 5 minutes.
- If the server's `minConnectorVersion` is higher, update before sending anything else.

### How to detect sessions (file-watching, no hooks required)

Poll every 2 s, cheap filesystem and process checks only. A session is live when its agent process is running and its transcript was written recently.

| Agent | Transcripts | Live signal | Subagents |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` | `claude` process with matching cwd, or `~/.claude/sessions/<pid>.json` if present; mtime < 90 s | `<session-id>/subagents/**/agent-*.jsonl` modified in the last 60 s (walk two levels, incl. `subagents/workflows/<id>/`) |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (first line `session_meta` has `cwd`, `id`) | `codex` process; mtime < 90 s | count 0 |
| Pi | `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl` (respect `PI_CODING_AGENT_DIR`) | `pi` process; mtime < 90 s | count 0 |

Respect `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. These formats are internal and change between releases: parse defensively, skip unknown lines, never crash.

Optional: the installer may add a user-level Claude Code hook in `~/.claude/settings.json` that pings the local daemon on session start/end for faster reactions. Hooks cost no tokens, but file-watching must work on its own.

### Deriving activity

Tail only the last ~32 KB of each live transcript (append-only, keep a byte offset). Map the latest entry to one verb: `typing` (edit/write tools), `reading` (read/grep/glob/search), `running` (bash/shell), `thinking` (assistant turn, no tool yet), `waiting` (turn finished, waiting for the human), `idle` (no writes for 2+ min, process alive). Exact mapping is implementer decides; unknown tools → `thinking`.

### What gets sent

Only: agent kind, hashed session id, project folder basename (can be disabled in config), activity verb, subagent count, started-at, connector version. Add a unit test that feeds a transcript containing a fake secret and asserts it never appears in any outgoing message.

## WebSocket protocol

Connectors sync state; the server emits events. Each connector sends its full current snapshot whenever something changes. The server diffs snapshots and turns them into clean, named events for viewers. Reconnects, missed messages and crashes become harmless.

### Envelope

```ts
type Envelope<T extends string, D> = {
  v: 1;            // protocol version
  type: T;         // "domain.verbPastTense" for facts, "domain.verb" for commands
  id: string;      // ulid
  ts: number;      // epoch ms, sender clock
  data: D;
};
```

One discriminated union per channel, so `switch (msg.type)` is exhaustive and type-checked.

### Endpoints

- `/ws/connector`: shared password, write-mostly.
- `/ws/viewer`: read-only, no password by default (optional `VIEWER_KEY` query param).

### Connector → server

| Type | When | Data |
| --- | --- | --- |
| `connector.hello` | On connect | name, password, clientId, connectorVersion, selfDescription? |
| `presence.snapshot` | On change (debounced 500 ms) + heartbeat every 30 s | sessions: [{ sessionKey, agent, project?, activity, subagents, startedAt }] |
| `connector.bye` | Clean quit | none |

### Server → connector

| Type | When | Data |
| --- | --- | --- |
| `connector.welcomed` | Hello accepted | personId, serverVersion, latestConnectorVersion, minConnectorVersion |
| `connector.rejected` | Bad password / too old | reason; socket closes with 4001 / 4002 |

### Server → viewers

| Type | When |
| --- | --- |
| `office.snapshot` | On viewer connect |
| `person.joined` / `person.left` | First connector of a person connects / last one gone for 60 s |
| `session.started` / `session.ended` | Session appears in / disappears from a snapshot |
| `session.activityChanged` | Activity verb changes |
| `subagent.spawned` / `subagent.finished` | Subagent count up / down (one event per unit) |
| `avatar.updated` | Generative UI produced or changed a look |

Liveness: no message from a connector for 75 s = gone; its sessions end, the person leaves after a further 60 s grace period. Both sides reconnect with exponential backoff (1 s → 30 s, jitter).

## Server (Cloudflare Worker + Durable Object)

A Worker serves the office web client as static assets and routes `/ws/*` and `/api/*` to one SQLite-backed Durable Object named `office`. It holds live state in memory and stores avatars, history and snapshots in its SQLite. HTTPS and `wss://` come for free.

- Use the WebSocket Hibernation API and `setWebSocketAutoResponse` for ping/pong so heartbeats don't wake the object. Keep traffic event-driven. Note a rough usage estimate in `DECISIONS.md` (free plan: 100k requests/day across the whole account, which the owner already uses for another small app; this project should stay at a few thousand/day).
- State model: `people` keyed by personId (derived from name, so two laptops = one person with more sessions), sessions keyed by `clientId + sessionKey`. A pure `diff(prev, next) => Event[]` function produces all viewer events. Unit-test it hard.
- Keep core logic (protocol, diff, stats) in plain TypeScript modules that also run under Node, so unit tests don't need the Workers runtime. Local dev with `wrangler dev`.
- Config (Worker vars/secrets): `CONNECTOR_PASSWORD`, `VIEWER_KEY` (optional), `LATEST_CONNECTOR_VERSION`, `MIN_CONNECTOR_VERSION`, `GENUI_PROVIDER` (`off` default), `GENUI_MAX_CALLS_PER_DAY` (200), model API keys.
- `GET /healthz`, `GET /api/state` (current snapshot as JSON), `GET /install.sh`.
- Logs: one readable line per event, e.g. `session.started martin claude agent-office`.

### History and stats

Basic history that survives redeploys, so there is fun data after camp.

- One row per viewer event in the DO's SQLite: time, type, person, agent, project basename, subagent count. No content.
- `/stats` page styled like the office: heatmap of sessions started by weekday × hour, plus small leaderboards (most sessions, most parallel agents at once, most subagents, Claude vs Codex vs Pi split, busiest project).
- `GET /api/history.csv` export.

### Timelapse snapshots

Every 15 minutes, a viewer opened with `?recorder=1` (the iPad kiosk) grabs a downscaled PNG of the canvas and uploads it to `POST /api/snapshots`. Store in DO SQLite (or R2 if you prefer). `/timelapse` shows a simple gallery with a play button. Skip frames when the office is empty.

## Office view

A larger map of connected areas, top-down at a slight 3/4 angle, cozy rather than corporate. Pixel art at 16 px tiles, scaled up crisp (nearest-neighbor, integer scaling), limited palette such as Endesga 32. Characters ~16×24 px with real animation frames. Final style is implementer decides; it must look intentional and consistent.

### Characters

Layered paper-doll sprites drawn in code or from a small hand-made sheet: body, skin tone, hair style, hair color, jacket, accessory. Only CC0 third-party assets (Kenney is fine).

- Person look: stable, from the avatar spec (Generative UI). With AI off, seeded from a hash of the name.
- Session variation: each extra session is a sibling character with small seeded tweaks from the session key (hair shade, hat, mug) so it reads as "another Martin".
- Jacket = agent color.
- Subagents: tiny helper sprites (bots or interns) that pop out near the parent's desk, scurry, vanish on finish. Above 5, show 5 plus a "+3" badge.

### Map and layout

Areas: main desk floor, coffee lounge, meeting room with whiteboard, game corner, outdoor garden or rooftop. Build from a tile map (Tiled JSON or a hand-written grid) so areas are easy to add in later PRs. Each person gets a desk pod with a floor nameplate, one desk per session; pods fill a grid that grows as people join.

- Drag to pan, pinch/wheel to zoom with limits and easing. Double-tap a person to focus. Small minimap.
- Auto camera: after 30 s without input (always in kiosk), follow the latest event, otherwise slowly tour the areas.
- Idle characters wander to lounge or garden; waiting ones stay at their desk with a raised hand; walk-ins start at the main door.

### Animations and moments

| Event or activity | What happens |
| --- | --- |
| `person.joined` | Door opens, character walks in, small confetti, banner "Anna joined" |
| `session.started` | New sibling character walks to the next free desk |
| `typing` / `reading` / `running` / `thinking` | Typing loop / flipping a book / screen glows green / idle bob with "..." |
| `waiting` | Turns toward camera, raises a hand, "!" bubble |
| `idle` | Wanders to coffee machine or plants |
| `subagent.spawned` | Helper pops out with a puff |
| `session.ended` | Waves, walks out the door |

Speech bubbles: project name + activity icon, short, fading after a few seconds.

### Living areas (stretch, cheap ones first)

Day/night lighting from server local time, idle loops on plants and lamps, steaming coffee machine, an office cat that naps near idle characters. Optional: weather in windows, whiteboard with today's stats, game corner lighting up above 10 agents. Note unbuilt ideas in `DECISIONS.md`.

### HUD and iPad kiosk

Thin top bar: office name, people online, sessions, subagents, clock. Tapping a person opens a small side panel (Generative UI spot 2, optional). `?kiosk=1`: no cursor, bigger text, no panels, Screen Wake Lock, web manifest for home screen, 30 fps cap, silent auto-reconnect with a small pixel "reconnecting" sign. Targets: iPad landscape 1180×820 and laptop 1440×900.

## Generative UI

Declarative pattern: the AI never draws pixels or writes code; it picks from a catalog you define and the renderer draws it. Everything works with `GENUI_PROVIDER=off` (seeded random picks).

- Spot 1 (required): catalog in `packages/protocol` (zod): hair styles, hair colors, skin tones, glasses, facial hair, accessories, desk props, desk mess level. On first join or when the self-description changes, one call turns name + description into an `AvatarSpec` of catalog IDs. Validate; invalid → seeded fallback. Cache in DO storage, broadcast `avatar.updated`. Session variations stay deterministic, never AI.
- Spot 2 (stretch): person side panel composed from a small component catalog (stat card, mini chart, badge, quote) via Vercel's json-render or an A2UI-style spec. Badges like "3 Claudes at once". Cache per person 10 min.
- Providers: `jev` = TypeSafe Jev (`typesafe-ai/jev`) via Vercel AI Gateway, ideal for picking catalog options; `anthropic` = latest small Claude model with structured output, for anything needing words; `off` = default for tests and screenshots.
- Rules: calls only on events (join, description change, panel open), never per frame. Enforce `GENUI_MAX_CALLS_PER_DAY`, log token counts, pluggable provider interface. Expected cost for 10 people over the week: well under 1 USD.

## CI/CD

### `ci.yml` (every PR)

1. Install, lint, typecheck, unit tests (protocol, diff, detectors on `fixtures/home`, privacy leak test).
2. End-to-end: `wrangler dev` (or Node harness), headless connector against fixtures, assert viewer events.
3. Run the simulator, capture Playwright screenshots, upload as artifact.
4. Build connector binaries (`darwin-arm64`, `darwin-x64`) as artifacts.

### `release.yml` (push to main)

1. Auto version `0.1.<run_number>`.
2. Build connector binaries, create a GitHub Release with them and `install.sh`.
3. Then `wrangler deploy` with `LATEST_CONNECTOR_VERSION` set, using `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. Order matters: release first, deploy second.
4. Target: merge → live on every machine in under 5 minutes.

If the Cloudflare secrets are missing, the deploy step should skip with a clear message, not fail the whole run.

## Overnight testing and done

No real teammates overnight, so build the simulator early.

### Simulator

`tools/sim` connects N fake connectors over the real protocol and plays a script: people join, sessions start, activities change, subagent bursts, sessions end, a laptop drops without bye. Flags: `--people 6 --chaos`, `--backfill-week` (fake history for `/stats`), and `--fixture-writer` (writes fake JSONL into a temp home so the real detectors run).

### Screenshots (Playwright, iPad 1180×820 and laptop 1440×900, saved to `screenshots/`, attached to the PR)

1. Empty office
2. One person, one Claude session, typing
3. Busy office: 6 people, mixed agents, subagents, one waiting with raised hand
4. `person.joined` mid-animation
5. Kiosk mode
6. Whole map zoomed out
7. `/stats` heatmap with a simulated week
8. `/timelapse` with a few frames
9. Side panel, if built
10. Terminal output of the install script and `agent-office status`

A short GIF of the busy office if tooling allows.

### Definition of done

- [ ] One command starts server + web with hot reload; `sim` fills the office
- [ ] Unit tests: protocol fixtures, diff engine, detectors, privacy leak test
- [ ] End-to-end: headless connector against fixtures shows up in the viewer
- [ ] CI green; connector binaries built
- [ ] Release workflow written; deploy works once secrets exist
- [ ] 30 fps with 12 people and 30 sessions in the simulator
- [ ] Map pans, zooms, auto-tours in kiosk mode
- [ ] History survives a redeploy; `/stats` renders
- [ ] Install script and self-update tested against a local server
- [ ] Works fully with `GENUI_PROVIDER=off`; AI path unit-tested with a mocked provider
- [ ] README: run the install one-liner, enter server + password + name, done
- [ ] `DECISIONS.md` covers every implementer-decides choice
- [ ] Screenshots attached to the PR

If time runs out, cut in this order: living-area extras, side panel, timelapse, Pi, Codex. Never cut the simulator, tests, history, or screenshots.
