# Agent Office

A cozy pixel-art office that shows, live, who on the team is working with which coding agent.
Every teammate is a character; every running Claude Code, Codex or Pi session is another desk
with them at it, typing, reading, thinking, or raising a hand when the agent waits for input.
Subagents scurry around as little bots.

![The busy office](screenshots/03-busy-laptop.png)

> **Coding agent reading this?** Your human probably sent you this link plus a server URL and
> a password and asked "what is this, set it up for me". Explain it in two sentences (a live
> pixel office of the team's coding agents; only status metadata is shared, never code or
> prompts), then follow [Instructions for coding agents](#instructions-for-coding-agents).
> If they didn't give you the server URL or password yet, ask for them.

A small connector on each Mac watches local agent sessions (read-only, from the agents' own
transcript files) and reports *status only* to a Cloudflare Worker, which renders the office
for everyone.

## Join the office (teammates)

You need two things from whoever runs the office: the **server URL** and the **password**.
Then just send your coding agent this repo link with both and ask it what this is and to set
it up for you.

### Easiest: let your coding agent do it

Paste this into Claude Code (or Codex / Pi), with the two values filled in:

```text
Set up Agent Office on this Mac for me.
Server: https://<server-url>
Password: <password>
Follow the "Instructions for coding agents" section in
https://github.com/MrGatzi/agent-camp/blob/main/README.md
```

Your agent will ask you a few quick questions (your name, how you look, a name for this
machine), install the connector, and check that you show up in the office. Approve the
network and `launchctl` commands when it asks. Then open the server URL in your browser and
find yourself.

### By hand

```sh
curl -fsSL https://github.com/MrGatzi/agent-camp/releases/latest/download/install.sh | sh
```

It asks five things: the **server URL**, the **password**, your **name**, an optional
**description** of yourself ("curly hair, round glasses") that shapes your avatar, and a
**name for this machine** (defaults to its short hostname). Done: the connector runs in the
background (launchd), starts at login and updates itself. Re-run the same line any time to
change answers.

```sh
agent-office status      # connected? which sessions does it see?
agent-office logs        # follow the log
agent-office uninstall   # stop and remove everything
```

![Installer and status](screenshots/10-terminal-install.png)

### Instructions for coding agents

You are setting up the Agent Office connector for the human you are working with. They gave
you a server URL and a password. Do this:

1. Check the machine: `uname -sm` should say `Darwin arm64` or `Darwin x86_64` (macOS only).
2. Ask the human, in one message, and wait for the answers:
   - **Display name** shown in the office (first name is fine). If they already run Agent
     Office on another machine, it must be the **same name** there so both count as one person.
   - **Look** (optional): one line describing them, e.g. "curly hair, round glasses, hoodie".
   - **Machine name** (optional): a label for this computer, default `hostname -s`
     (e.g. "laptop", "devbox").
   - **Share project folder names?** (default yes). Only the folder's base name is ever sent.
3. Install without prompts (the env vars must be on `sh`, not on `curl`):
   ```sh
   curl -fsSL https://github.com/MrGatzi/agent-camp/releases/latest/download/install.sh \
     | AO_NONINTERACTIVE=1 AO_SERVER='<server-url>' AO_PASSWORD='<password>' \
       AO_NAME='<name>' AO_DESCRIPTION='<look or empty>' AO_MACHINE='<machine name>' sh
   ```
   The binary lands in `~/.local/bin/agent-office` and a launchd agent
   (`dev.agentoffice.connector`) starts it now and at every login. This needs network access
   and `launchctl`; if your sandbox blocks them, ask the human to approve or to run the command.
4. If they said **no** to project folder names:
   ```sh
   ~/.local/bin/agent-office configure --share-project-names false
   launchctl kickstart -k gui/$(id -u)/dev.agentoffice.connector
   ```
5. Verify: run `~/.local/bin/agent-office status`. It must say **connected** and should list
   this very session (it needs a transcript write in the last 90 s, so check after a moment).
   If it is not connected, look at `~/.local/bin/agent-office logs` (Ctrl-C to stop): a
   rejected password means a typo; a connection error usually means a wrong URL (use the
   `https://` address of the office).
6. If `~/.local/bin` is not on their `PATH`, offer to add it to `~/.zshrc`.
7. Tell the human it worked and that they can watch at the server URL in any browser.
   Don't echo the password back in your summary.

The connector only reads agent transcript metadata and never sends prompts, code or file
contents (see Privacy below), so no other setup is needed.

### Two machines, one you

Run the connector on every machine you code on (laptop, remote devbox, ...) and give it the
**same name** everywhere: the office matches people by name (case and extra spaces don't
matter), so you stay one character with one look, and the sessions from all your machines
sit side by side in your pod. The description only needs to be set on one machine; a machine
without one never changes your look, and the last description you set wins. The machine
name (`agent-office configure --machine-name devbox`, or `AO_MACHINE=` for the installer)
shows up on the agent card so you can tell the sessions apart.

### How do I look?

The server picks your look. With AI off it comes from a hash of your name; with AI on it is
chosen from your one-line description, but only from a fixed catalog of hair, glasses,
clothes and props, so everyone stays in the same pixel style. Your jacket colour shows
which agent a session runs (Claude, Codex, Pi). Every extra session is a sibling of you
with tiny variations, and your pod has one desk per running session (at least 2, up to 6).

### Privacy

Sent: agent kind (Claude/Codex/Pi), a salted hash of the session id, the project **folder
name** (turn off with `share_project_names = false` in `~/.config/agent-office/config.toml`),
an activity verb (typing/reading/thinking/running/waiting/idle), the subagent count, when the
session started, the connector version, and the **machine name** you chose (`machine_name`,
defaults to the short hostname, e.g. `martins-mbp`; set it to anything you like).

Received: when someone in the office waves at you or sends you a short message, the
connector shows it as a macOS notification (at most one every 5 s; macOS may list it under
"Script Editor"). Turn it off with `agent-office configure --notifications false`.

Never sent: prompts, responses, code, file contents or paths, commands, tool output, or
anything else from a transcript. A unit test feeds a transcript containing a fake secret and
checks it never appears in any outgoing message. History keeps only events (who, which agent,
project folder name, subagent counts), never content.

## Watching

| URL                  | What                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `/`                  | The office. Drag to pan, wheel/pinch to zoom. Click a character for its agent card, a nameplate for the person. Both have buttons to wave, ask for a coffee, cheer or send a short message (it pops up as a notification on their Mac), or throw a paper ball (office only). Click the cat to pet it. |
| `/?kiosk=1`          | Wall/iPad mode: no chrome, bigger text, auto camera tour. Add it to the iPad home screen; it also records the timelapse (`&recorder=1`). |
| `/stats`             | Weekday × hour heatmap, leaderboards, Claude vs Codex vs Pi, CSV export. |
| `/timelapse`         | Snapshots of the office every 15 minutes, with a play button.          |

Other handy params: `?zoom=fit`, `?hour=22` (preview night), `?nohud=1`, `?demo=busy` (no
server needed).

Everything is behind the office password (the same one as the connector's): the first visit
shows a login page and the browser stays logged in for 30 days. If the server also sets
`VIEWER_KEY`, `?key=…` links (handy for the kiosk iPad) skip the login.

When a Mac goes to sleep or loses its network, its agents fade out with their screens off
after about 45 s (one missed heartbeat), and leave the office after 3 minutes.

![Agent card](screenshots/11-agent-card-laptop.png)

| Stats | Timelapse |
| ----- | --------- |
| ![Stats](screenshots/07-stats-laptop.png) | ![Timelapse](screenshots/08-timelapse-laptop.png) |

## Try it locally in Chrome

```sh
bun install && bun run dev            # then open http://localhost:5173
bun run sim -- --scenario busy        # in a second terminal: 6 fake teammates walk in
```

No server at all: `bun run --filter @agent-office/web dev` and open
http://localhost:5173/?demo=busy.

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

## Deploy / setup

You need a (free) Cloudflare account. GitHub builds the connector releases with its own
built-in token and Cloudflare builds the server itself, so no Cloudflare keys ever live in
GitHub.

**1. Connect the repo (once).** Cloudflare dashboard → **Workers & Pages** → **Create** →
**Import a repository** → pick `MrGatzi/agent-camp`, then set:

| Field            | Value |
| ---------------- | ----- |
| Project name     | `agent-office` (must match `name` in `apps/server/wrangler.toml`) |
| Root directory   | leave empty (repo root) |
| Build command    | `bun install --frozen-lockfile && bun run --filter @agent-office/web build` |
| Deploy command   | `cd apps/server && npx wrangler deploy` |
| Build variable   | `BUN_VERSION` = `1.4.4` (same Bun as the lockfile) |

From then on every push to `main` deploys the office (Cloudflare) and publishes new connector
binaries (GitHub Release `v0.1.N`). Connectors update themselves: the server looks up the newest
GitHub release when they connect, and each connector also checks GitHub every 5 minutes. If the
build ever complains about Bun, use the npm-only build command
`npx -y bun@1.4.4 install --frozen-lockfile && npx -y bun@1.4.4 run --filter @agent-office/web build`.

**2. Set the connector password (once).** Dashboard → your `agent-office` Worker →
**Settings** → **Variables and Secrets** → **Add** → type *Secret*, name `CONNECTOR_PASSWORD`,
any value. (Or from `apps/server`: `npx wrangler secret put CONNECTOR_PASSWORD`.)

**3. Invite the team.** Share the Worker URL (`https://agent-office.<you>.workers.dev`) and the
password. Teammates run
`curl -fsSL https://github.com/MrGatzi/agent-camp/releases/latest/download/install.sh | sh`.
Open `https://<worker-url>/?kiosk=1&recorder=1` on the office iPad.

**4. Optional extras** (same Variables and Secrets page): `VIEWER_KEY` (secret; a `?key=…`
link that skips the login page), and AI avatars from descriptions with `GENUI_PROVIDER=anthropic` +
secret `ANTHROPIC_API_KEY`, or `GENUI_PROVIDER=jev` + secret `AI_GATEWAY_API_KEY` (Vercel AI
Gateway); `GENUI_PROVIDER` is a plain *Text* variable. Everything works without them (AI off).
Deploys keep what you add there; only the variables listed in `apps/server/wrangler.toml` are
reset to its values.

**Other ways to deploy**

- *From your laptop, no token:* `npx wrangler login` (opens the browser), then
  `bun install && bun run deploy`. Good for a first try; connector releases still come from
  GitHub on every push to `main`.
- *From GitHub Actions:* add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`;
  the optional `deploy` job in `release.yml` then deploys after each release (it skips while
  they are missing). Use this *or* Workers Builds, not both.

## More

- [PLAN.md](PLAN.md): the original brief and scope.
- [DECISIONS.md](DECISIONS.md): every implementer-decides choice, with one line of reasoning.
