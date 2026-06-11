import type { QueueMode } from "./types";

/**
 * Index of the next track to play, or null if playback should stop.
 * - normal: linear, null at end (caller may hand off to auto-continue)
 * - repeat-all: wraps to 0
 * - repeat-one: same index (replays current)
 */
export function nextIndex(mode: QueueMode, idx: number, length: number): number | null {
  if (length === 0) return null;
  if (mode === "repeat-one") return idx;
  if (mode === "repeat-all") return (idx + 1) % length;
  // normal
  return idx + 1 < length ? idx + 1 : null;
}

/**
 * Index of the previous track, or null if at the start in a non-wrapping mode.
 */
export function prevIndex(mode: QueueMode, idx: number, length: number): number | null {
  if (length === 0) return null;
  if (mode === "repeat-one") return idx;
  if (mode === "repeat-all") return (idx - 1 + length) % length;
  // normal
  return idx > 0 ? idx - 1 : null;
}

/**
 * Build a randomized index order of [0..length) with the element currently at
 * `current` placed first. Fisher-Yates over the rest. `rng` is injectable for
 * deterministic tests (defaults to Math.random at call sites).
 * If `current` is < 0 (nothing playing), all indices are shuffled freely.
 */
export function randomizeOrder(length: number, current: number, rng: () => number): number[] {
  if (length === 0) return [];
  const hasCurrent = current >= 0 && current < length;
  const rest = Array.from({ length }, (_, i) => i).filter(i => !(hasCurrent && i === current));
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return hasCurrent ? [current, ...rest] : rest;
}
