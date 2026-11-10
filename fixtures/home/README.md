# fixtures/home — fake agent home directory

A tiny, realistic stand-in for `~` used by connector detector tests
(`AGENT_OFFICE_HOME=fixtures/home`). File mtimes are **not** meaningful in git:
tests must `utimes()` the files they want to look "live" (< 90 s) or stale at runtime.

Privacy canary: the string `SECRET_DO_NOT_LEAK_8f3a` appears in a Claude **user prompt**
and in a Claude **Edit tool input** (session `3f6c2a1e…`). Privacy tests assert it never
shows up in any outgoing connector message.

## Claude Code (`.claude/`, respects `CLAUDE_CONFIG_DIR`)

| Path                                                                           | Meaning                                                                                                     |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `projects/<encoded-cwd>/<session-uuid>.jsonl`                                  | Transcript. `<encoded-cwd>` = cwd with `/` (and `.`) replaced by `-`, e.g. `-Users-anna-code-agent-office`. |
| `projects/<encoded-cwd>/<session-uuid>/subagents/agent-*.jsonl`                | Subagent transcripts (level 1).                                                                             |
| `projects/<encoded-cwd>/<session-uuid>/subagents/workflows/<id>/agent-*.jsonl` | Workflow subagents (level 2).                                                                               |
| `sessions/<pid>.json`                                                          | `{ pid, sessionId, cwd, startedAt }` — maps a running process to a session.                                 |

Transcript lines are JSON objects with `type`:

- `user` — `message.content` is a string (prompt) or an array of `tool_result` blocks.
- `assistant` — `message.content` is an array of `text` / `thinking` / `tool_use`
  (`{type:"tool_use", name:"Edit"|"Write"|"Read"|"Grep"|"Glob"|"Bash"|…, input:{…}}`) blocks,
  `message.stop_reason` is `"tool_use"`, `"end_turn"` or `null` (streaming / mid-turn).
- other types (`summary`, `file-history-snapshot`, …) must be skipped. One line in the
  website transcript is deliberately invalid JSON.

Sessions here:

- `-Users-anna-code-agent-office/3f6c2a1e-8b7d-4c59-9e21-5a0d4b7c8e91` — active; last entry is
  an `Edit` tool_use (→ `typing`); has 2 subagents (`agent-abc`, `workflows/wf1/agent-def`);
  pid 12345.
- `-Users-anna-code-website/b81e4d07-2c3a-4f6e-a5d9-0e7f1c2b3a46` — last entry is assistant
  text with `stop_reason: "end_turn"` (→ `waiting`); pid 12346.

## Codex (`.codex/`, respects `CODEX_HOME`)

`sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Line 1 is
`{type:"session_meta", payload:{id, cwd, cli_version, …}}`; then `response_item` lines whose
`payload.type` is `message`, `reasoning`, `function_call` (`name:"shell"`, `arguments` JSON
string), `function_call_output`, `custom_tool_call` (`name:"apply_patch"`), … and `event_msg`
lines. Fixture: cwd `/Users/anna/code/codex-thing`, last entry is a `shell` call (→ `running`).

## Pi (`.pi/agent/`, respects `PI_CODING_AGENT_DIR`)

`sessions/--<cwd with / as ->--/<iso-ts>_<uuid>.jsonl`. Line 1 is
`{type:"session", id, cwd, timestamp}`; then `model_change` and `message` lines where
`message.role` is `user` / `assistant` / `toolResult`; assistant content includes
`{type:"toolCall", name:"bash"|"read"|"edit"|"write", arguments}`. Fixture: cwd
`/Users/anna/code/pi-proj`, last entry is an `edit` tool call (→ `typing`).
