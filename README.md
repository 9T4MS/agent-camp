# Agent Office

A cozy pixel-art office that shows, live, who on the team is working with which coding agent.
Every teammate is a character; every running Claude Code, Codex or Pi session is another desk
with them at it, typing, reading, thinking, or raising a hand when the agent waits for input.
Subagents scurry around as little bots.

![The busy office](screenshots/03-busy-laptop.png)

A small connector on each Mac watches local agent sessions (read-only, from the agents' own
transcript files) and reports *status only* to a Cloudflare Worker, which renders the office
for everyone.

## Join the office (teammates)

```sh
curl -fsSL https://<your-server>/install.sh | sh
```

It asks five things: **server URL** (already filled in), the **shared password**, your
**name**, an optional **description** of yourself ("curly hair, round glasses") that
shapes your avatar, and a **name for this machine** (defaults to its short hostname). Done: the connector runs in the background (launchd) and starts at login.
Re-run the same line any time to change answers. It updates itself.

```sh
agent-office status      # connected? which sessions does it see?
agent-office logs        # follow the log
agent-office uninstall   # stop and remove everything
```

![Installer and status](screenshots/10-terminal-install.png)

### Two machines, one you

Run the connector on every machine you code on (laptop, remote devbox, ...) and give it the
**same name** everywhere: the office matches people by name (case and extra spaces don't
matter), so you stay one character with one look, and the sessions from all your machines
sit side by side in your pod. The description only needs to be set on one machine; a machine
without one never changes your look, and the last description you set wins. The machine
name (`agent-office configure --machine-name devbox`, or `AO_MACHINE=` for the installer)
shows up on the agent card so you can tell the sessions apart.

### Privacy

Sent: agent kind (Claude/Codex/Pi), a salted hash of the session id, the project **folder
name** (turn off with `share_project_names = false` in `~/.config/agent-office/config.toml`),
an activity verb (typing/reading/thinking/running/waiting/idle), the subagent count, when the
session started, the connector version, and the **machine name** you chose (`machine_name`,
defaults to the short hostname, e.g. `martins-mbp`; set it to anything you like).

Never sent: prompts, responses, code, file contents or paths, commands, tool output, or
anything else from a transcript. A unit test feeds a transcript containing a fake secret and
checks it never appears in any outgoing message. History keeps only events (who, which agent,
project folder name, subagent counts), never content.

## Watching

| URL                  | What                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `/`                  | The office. Drag to pan, wheel/pinch to zoom. Click a character for its agent card, a nameplate for the person. |
| `/?kiosk=1`          | Wall/iPad mode: no chrome, bigger text, auto camera tour. Add it to the iPad home screen; it also records the timelapse (`&recorder=1`). |
| `/stats`             | Weekday × hour heatmap, leaderboards, Claude vs Codex vs Pi, CSV export. |
| `/timelapse`         | Snapshots of the office every 15 minutes, with a play button.          |

Other handy params: `?zoom=fit`, `?hour=22` (preview night), `?nohud=1`, `?demo=busy` (no
server needed). If the server sets `VIEWER_KEY`, add `?key=…`.

![Agent card](screenshots/11-agent-card-laptop.png)

| Stats | Timelapse |
| ----- | --------- |
| ![Stats](screenshots/07-stats-laptop.png) | ![Timelapse](screenshots/08-timelapse-laptop.png) |

## Developing

Bun monorepo: `packages/protocol` (zod wire schemas), `apps/connector` (Bun-compiled CLI),
`apps/server` (Worker + Durable Object), `apps/web` (Vite + PixiJS), `tools/sim`
(fake teammates over the real protocol), `tools/screenshots`.

```sh
bun install
bun run dev                           # wrangler dev :8787 + vite :5173 (hot reload), open :5173
bun run sim -- --scenario busy        # 6 people walk in (also: one, empty, join, stress, live)
bun run sim -- --backfill-week        # a fake week of history for /stats
bun run sim -- --snapshots 12         # test frames for /timelapse
```

The dev password is `devpass`. Run a connector against it with
`bun apps/connector/src/main.ts run --server http://localhost:8787 --password devpass --name You`.

```sh
bun run lint && bun run typecheck && bun test   # what CI runs first
bun run test:e2e      # real server + real connector on fixtures + viewer socket
bun run screenshots   # builds web, real server + simulator, Playwright -> screenshots/
```

`bun run screenshots` needs Chromium for Playwright (`bunx playwright install chromium`
once). It writes laptop (1440×900) and iPad (1180×820) shots plus `03-busy.gif`.

## Deploying

Pushing to `main` releases connector binaries (GitHub Release `v0.1.N`) and then deploys the
Worker. One-time setup:

1. GitHub repo secrets `CLOUDFLARE_API_TOKEN` (Workers edit rights) and
   `CLOUDFLARE_ACCOUNT_ID`. Without them the deploy job skips itself and stays green.
2. The shared password, once, from `apps/server`:
   `bunx wrangler secret put CONNECTOR_PASSWORD`
3. Optional: `VIEWER_KEY` (require `?key=` to watch), and AI avatars from descriptions with
   `GENUI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`, or `GENUI_PROVIDER=jev` +
   `AI_GATEWAY_API_KEY` (Vercel AI Gateway). Everything works with `GENUI_PROVIDER=off`.

Then share `curl -fsSL https://<worker-url>/install.sh | sh` with the team, and open
`https://<worker-url>/?kiosk=1&recorder=1` on the office iPad.

## More

- [PLAN.md](PLAN.md): the original brief and scope.
- [DECISIONS.md](DECISIONS.md): every implementer-decides choice, with one line of reasoning.
