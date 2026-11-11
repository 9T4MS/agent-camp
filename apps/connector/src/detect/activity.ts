/**
 * Map the latest transcript entry to one activity verb.
 *
 * Each detector normalizes its agent's raw JSONL entries into `TurnEvent`s (or null to skip
 * them); `deriveActivity` then looks at the last relevant event plus the file mtime.
 * Mapping (PLAN "Deriving activity"):
 *   typing   edit/write tools
 *   reading  read/grep/glob/search tools
 *   running  bash/shell tools
 *   thinking assistant turn with no tool yet, a tool result waiting for the model, unknown tools
 *   waiting  turn finished (end_turn / task_complete / interrupted)
 *   idle     no transcript writes for IDLE_AFTER_MS while the process is alive
 */
import { type Activity, IDLE_AFTER_MS } from "@agent-office/protocol";

export type TurnEvent =
  /** the model called a tool (and we have not seen its result yet) */
  | { kind: "tool"; name: string }
  /** a tool result came back; the model is working on the next step */
  | { kind: "toolResult" }
  /** the human sent a prompt */
  | { kind: "user" }
  /** assistant text / reasoning; `final` when the turn is known to be complete */
  | { kind: "assistant"; final: boolean }
  /** the turn ended (task complete, aborted, interrupted) */
  | { kind: "turnEnd" };

/**
 * Assistant text without a tool and without an explicit end marker, followed by this much
 * silence, is treated as a finished turn (some agent versions never write stop reasons).
 */
export const TEXT_SETTLE_MS = 30_000;

const TYPING = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "apply_patch",
  "edit_file",
  "write_file",
  "create_file",
  "str_replace_editor",
  "str_replace_based_edit_tool",
]);
const READING = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "webfetch",
  "websearch",
  "find",
  "read_file",
  "list_dir",
  "list_directory",
  "search",
  "view_image",
  "notebookread",
  "web_search",
]);
const RUNNING = new Set([
  "bash",
  "shell",
  "exec",
  "exec_command",
  "shell_command",
  "local_shell",
  "local_shell_call",
  "bashoutput",
  "killshell",
  "write_stdin",
]);

/** Tool name -> activity. Case-insensitive; unknown tools (incl. MCP tools) -> thinking. */
export function toolActivity(name: string): Activity {
  const n = name.trim().toLowerCase();
  if (TYPING.has(n)) return "typing";
  if (READING.has(n)) return "reading";
  if (RUNNING.has(n)) return "running";
  return "thinking";
}

/**
 * Derive the activity from the normalized events of a transcript (oldest first).
 * `mtimeMs` is the transcript's last write; `now` the current time.
 */
export function deriveActivity(
  events: readonly (TurnEvent | null)[],
  mtimeMs: number,
  now: number,
): Activity {
  const age = now - mtimeMs;
  if (age >= IDLE_AFTER_MS) return "idle";
  let last: TurnEvent | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e) {
      last = e;
      break;
    }
  }
  if (!last) return "waiting";
  switch (last.kind) {
    case "tool":
      return toolActivity(last.name);
    case "toolResult":
    case "user":
      return "thinking";
    case "assistant":
      return last.final || age >= TEXT_SETTLE_MS ? "waiting" : "thinking";
    case "turnEnd":
      return "waiting";
  }
}

// ---- small helpers for normalizers -----------------------------------------------------------
export const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
