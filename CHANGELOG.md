# Changelog

What changed in the office, newest first. Every PR adds a line under today's date (create the
heading if it isn't there yet), written for the people in the office, not for the code. The top
section is what "What's new" in the menu shows; a new line there also brings up the "New version!"
banner after a deploy.

## 2026-11-12

- Timelapse now lets you watch All frames or one day in your browser's local timezone, with matching counts and thumbnails, and warms only a few frames ahead instead of the whole recording
- `agent-office status --json` now gives scripts a privacy-safe health snapshot, without config, project names or server credentials
- 🚢 Schiffe versenken and Vier gewinnt: challenge a colleague from their nameplate and play a move whenever you get to it; your portrait in the top bar shows when it is your turn
- 🎀 New looks for your character: a curved hairband (hidden from behind, unlike the straight headband), longer sweaters and shirts that hang down over the hips instead of looking like a crop top, and lots of colourful clips in the hair
- 🎨 Customize look is simpler: one tab to describe your look (a new AI look goes live right away, nothing to save) and one to pick parts (with its own Save). Saving no longer quietly swaps your AI look for a rough copy, and reopening shows the look you actually wear
- When your Mac can't draw your look, the studio now says why and how to fix it (e.g. "your Mac reconnected: confirm it's you again", right there with a new code) instead of "ask the office admin"; if Claude Code fails on your Mac you see its error within seconds, not after a silent 5-minute wait
- 🗂️ The CFO moved in: he has his own office next to the game corner. Now and then someone walks in to ask for their contract; it's hard and it will take time. Every so often he picks up the phone and calls his beloved colleague at WEKAO. He also keeps coming out of his office to ask people at their desks: "WHERE IS THE WIFI?!" or "ANYONE ORDERING LUNCH AT PHO HA NOI?!"
- 🔥 The IT guy moved into the wooden server cabin in the garden: in crocs and shorts he puts out the cabin whenever it catches fire again, and when an agent runs out of room he brings the dev a fresh RAM stick for the server rack (click him!)
- 🐈 Kiwi and Eloy moved in: Kiwi has the zoomies and races from one end of the office to the other, and Eloy goes from desk to desk and won't stop meowing at the devs
- 🍳 The head of sales moved in: he cooks Eierspeis in the kitchen (grab a plate while he's at the stove) and runs out to his stand in the garden whenever a client shows up, to talk the price up
- ⏱️ The head of development got her own head desk with a time clock: people punch their hours there, and she walks over to anyone who hasn't
- 🙇 Every full hour all agents jump up, run to the head desk, line up and bow to her one by one
- The office no longer jumps or changes size while the camera zooms
- 🐈 Cece and Jess moved in: two office cats who are always hungry and go from desk to desk begging the agents for treats and, at mealtimes, for a proper meal
- Claude Code sessions in the Code tab of the Claude desktop app now get their desk too (before they only flickered in now and then)
- The Codex app no longer leaves a ghost desk behind ("idle, started 9 days ago")
- An agent running a long command, waiting for a subagent or working in the background stays at its desk instead of heading to the bar
- Background subagents keep their helper bot until they are done, even when they are quiet for a while
- Agents done for a while stay at the bar: no more walking back to the desk for two minutes when Claude Code jots down its recap
- A Codex agent waiting for you to approve a command goes to the bar after 2 minutes instead of "running" at its desk; Claude Code's own searches no longer show up as helper bots
- More sessions than desks? The working ones sit at the desks, the long-idle ones get up and roam
- 🙂 "Who are you?" in the top bar: confirm once with a code from your Mac, then your portrait sits there with Customize look and your desk; office games and pokes now go out as you

## 2026-11-11

- 🌀 Two cartoon characters drop by: they wander around the office and jump through portals from a portal gun to pop up somewhere else (click them!)
- Sharper office at every zoom: name tags and signs stay readable on wall screens and phones
- The auto-tour comes back to the desks after every other stop and shows the pods where agents are working
- Agents sitting on a sofa, bench or chair now sit in front of it instead of hiding behind it
- The "New version!" popup is now a wide banner across the office that goes away by itself after 15 s
- Version numbers now go 0.2.x and show up right after a deploy, the same on the page, the release and the connectors
- 🎉 A new version now opens with a full-screen celebration banner and what changed
- ↻ A refresh button in the top bar; it lights up when a new version is out
- The office updates itself after a deploy everywhere, also fullscreen on a desktop (it waits until nobody is clicking around)
- "What's new" in the menu shows this changelog
- Look studio: fullscreen editor with ◀ ▶ carousels
- East street block: Feierabend bar, weed shop and smokers' corner
- Prom queen: a teammate without a coding agent pages the developers
- Cowork sessions of the Claude desktop app can get a desk too (project "Cowork"): `agent-office configure --cowork true`
- Designers get a pink Claude Design desk while their Claude app runs: `agent-office configure --claude-app design` (it shows that you are there, not what Claude is doing)
