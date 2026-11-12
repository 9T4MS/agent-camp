/**
 * Cheap, defensive JSONL tailing.
 *
 * Transcripts are append-only, so for each file we remember the byte offset we have read up
 * to and only read what was appended since (capped at the last TAIL_BYTES). Lines that are
 * not valid JSON objects are skipped. Nothing in here ever throws.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Read at most this many bytes from the end of a file. */
export const TAIL_BYTES = 32 * 1024;
/** Keep this many most-recent parsed entries per file. */
export const KEEP_ENTRIES = 64;
/** Read at most this many bytes from the start of a file when looking at its header. */
export const HEAD_BYTES = 64 * 1024;

const NL = 0x0a;

type FileState = {
  offset: number;
  /** bytes after the last newline (an incomplete line still being written) */
  carry: Uint8Array;
  entries: Record<string, unknown>[];
};

/** Parse one JSONL line into an object, or null. Never throws. */
export function parseLine(line: string): Record<string, unknown> | null {
  const s = line.trim();
  if (s.length === 0 || s[0] !== "{") return null;
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Parse a block of complete JSONL text, skipping bad lines. */
export function parseJsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const obj = parseLine(line);
    if (obj) out.push(obj);
  }
  return out;
}

function readRange(path: string, start: number, length: number): Uint8Array {
  const buf = new Uint8Array(Math.max(0, length));
  if (length <= 0) return buf;
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const decoder = new TextDecoder();

/**
 * Incremental tail reader with per-file byte offsets. `read(path)` returns the most recent
 * parsed entries (oldest first). Call `retain(paths)` to forget files that are gone.
 */
export class TailReader {
  private files = new Map<string, FileState>();

  read(path: string): Record<string, unknown>[] {
    const prev = this.files.get(path);
    try {
      const size = statSync(path).size;
      let state = prev;
      // first look, or the file shrank (rotated / rewritten): start over from the tail
      if (!state || size < state.offset) {
        const start = Math.max(0, size - TAIL_BYTES);
        let bytes = readRange(path, start, size - start);
        if (start > 0) {
          // we probably landed mid-line: drop everything up to the first newline
          const nl = bytes.indexOf(NL);
          bytes = nl >= 0 ? bytes.subarray(nl + 1) : new Uint8Array(0);
        }
        state = { offset: size, carry: new Uint8Array(0), entries: [] };
        this.consume(state, bytes);
      } else if (size > state.offset) {
        const delta = size - state.offset;
        if (delta > TAIL_BYTES) {
          // a big burst: only the end matters
          const start = size - TAIL_BYTES;
          let bytes = readRange(path, start, TAIL_BYTES);
          const nl = bytes.indexOf(NL);
          bytes = nl >= 0 ? bytes.subarray(nl + 1) : new Uint8Array(0);
          state = { offset: size, carry: new Uint8Array(0), entries: state.entries };
          this.consume(state, bytes);
        } else {
          const bytes = readRange(path, state.offset, delta);
          state.offset = size;
          this.consume(state, bytes);
        }
      }
      this.files.set(path, state);
      return state.entries;
    } catch {
      return prev?.entries ?? [];
    }
  }

  private consume(state: FileState, bytes: Uint8Array): void {
    const all = concat(state.carry, bytes);
    const lastNl = all.lastIndexOf(NL);
    if (lastNl < 0) {
      // no complete line yet; keep it unless it's absurdly long
      state.carry = all.length > TAIL_BYTES ? new Uint8Array(0) : all;
      return;
    }
    state.carry = all.slice(lastNl + 1);
    if (state.carry.length > TAIL_BYTES) state.carry = new Uint8Array(0);
    const parsed = parseJsonl(decoder.decode(all.subarray(0, lastNl)));
    if (parsed.length > 0) {
      state.entries = state.entries.concat(parsed).slice(-KEEP_ENTRIES);
    }
  }

  /** Forget state for files not in `keep`. */
  retain(keep: Set<string>): void {
    for (const p of this.files.keys()) if (!keep.has(p)) this.files.delete(p);
  }

  get size(): number {
    return this.files.size;
  }
}

/**
 * Parse the first lines of a file (up to HEAD_BYTES), e.g. Codex `session_meta` or a Pi
 * `session` header. Returns [] on any error.
 */
export function readHead(path: string, maxLines = 5): Record<string, unknown>[] {
  try {
    const bytes = readRange(path, 0, HEAD_BYTES);
    const text = decoder.decode(bytes);
    const lines = text.split("\n");
    // the last piece may be truncated if the file is bigger than HEAD_BYTES
    if (bytes.length === HEAD_BYTES) lines.pop();
    const out: Record<string, unknown>[] = [];
    for (const line of lines) {
      const obj = parseLine(line);
      if (obj) out.push(obj);
      if (out.length >= maxLines) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Parse the complete lines in the last `maxBytes` of a file (one-shot, no offset state), for
 * files we only glance at occasionally such as subagent transcripts. Returns [] on any error.
 */
export function readTail(path: string, maxBytes = TAIL_BYTES): Record<string, unknown>[] {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    let bytes = readRange(path, start, size - start);
    if (start > 0) {
      // we probably landed mid-line: drop everything up to the first newline
      const nl = bytes.indexOf(NL);
      bytes = nl >= 0 ? bytes.subarray(nl + 1) : new Uint8Array(0);
    }
    return parseJsonl(decoder.decode(bytes));
  } catch {
    return [];
  }
}
