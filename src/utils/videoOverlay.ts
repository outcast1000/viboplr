import type { QueueTrack } from "../types";

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
