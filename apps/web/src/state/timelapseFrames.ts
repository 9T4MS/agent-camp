import type { SnapshotMeta } from "../../../../packages/protocol/src/api.ts";

export const ALL_DAYS = "all";
export const PRELOAD_FRAME_LIMIT = 3;

export function sortFrames(frames: readonly SnapshotMeta[]): SnapshotMeta[] {
  return [...frames].sort((a, b) => a.ts - b.ts || a.id - b.id);
}

/** Calendar dates use the browser's local zone, not UTC or the office's zone. */
export function localDayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function normalizeDay(day: string | null): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return ALL_DAYS;
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day
    ? day
    : ALL_DAYS;
}

export function filterFrames(frames: readonly SnapshotMeta[], day: string): SnapshotMeta[] {
  const selectedDay = normalizeDay(day);
  return frames.filter(
    (frame) => selectedDay === ALL_DAYS || localDayKey(frame.ts) === selectedDay,
  );
}

/** Keep the selected frame when possible; otherwise show the latest in the new range. */
export function selectedFrameIndex(frames: readonly SnapshotMeta[], selectedId?: number): number {
  const index = frames.findIndex((frame) => frame.id === selectedId);
  return index >= 0 ? index : frames.length - 1;
}

/** Current + next two, without wrapping or ever warming the whole recording. */
export function preloadFrames(frames: readonly SnapshotMeta[], index: number): SnapshotMeta[] {
  if (!Number.isInteger(index) || index < 0 || index >= frames.length) return [];
  return frames.slice(index, index + PRELOAD_FRAME_LIMIT);
}
