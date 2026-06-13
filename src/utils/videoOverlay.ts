import type { QueueTrack } from "../types";
import type { RGB } from "./extractDominantColor";

/** The next queue track after the current index (mode-naive, mirrors the
 *  up-next peek), or null when there is none. Returns the absolute index so
 *  callers can jump to it. */
export function nextQueueTrack(
  queue: QueueTrack[],
  queueIndex: number,
): { track: QueueTrack; index: number } | null {
  if (queueIndex < 0) return null;
  const next = queue[queueIndex + 1];
  return next ? { track: next, index: queueIndex + 1 } : null;
}

/** CSS value for the ambient glow color. A sampled RGB becomes an rgb() string;
 *  a null sample (no/failed/desaturated image) falls back to the skin accent. */
export function glowColorValue(rgb: RGB | null): string {
  if (!rgb) return "var(--accent-dim)";
  return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
}
