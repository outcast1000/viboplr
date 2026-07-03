// The playback progress machine: given "where are we in the current track",
// decide whether to request an auto-continue prefetch, (re)arm the next-track
// preload, or start the crossfade. Extracted from usePlayback's `onTimeUpdate`
// so the browser engine (timeupdate events) and the native mpv engine
// (`engine-position` events) drive the exact same logic. Pure — unit-tested.

import type { QueueTrack } from "../types";

export interface ProgressInputs {
  /** Effective playback position (secs). */
  position: number;
  /** Effective duration (secs); 0/unknown disables the machine. */
  duration: number;
  crossfadeSecs: number;
  /** peekNext() — the same-mode next queue track, or null at queue end. */
  next: QueueTrack | null;
  /** Key of the currently armed preload, or null. */
  preloadedKey: string | null;
  preloadReady: boolean;
  isPreloading: boolean;
  isCrossfading: boolean;
  prefetchRequested: boolean;
}

export interface ProgressActions {
  requestPrefetch: boolean;
  /** Drop the currently armed preload before arming the new one. */
  invalidatePreload: boolean;
  /** Track to arm for gapless/crossfade, or null. */
  preloadTrack: QueueTrack | null;
  startCrossfade: boolean;
}

const NO_ACTIONS: ProgressActions = {
  requestPrefetch: false,
  invalidatePreload: false,
  preloadTrack: null,
  startCrossfade: false,
};

/** A next track without a directly playable URL goes through the plugin
 * stream-resolver chain, which can be slow (e.g. yt-dlp) — start earlier. */
export function needsStreamResolve(next: QueueTrack | null): boolean {
  return !!next && (!next.path || (!next.path.startsWith("file://") && !next.path.startsWith("http")));
}

export function preloadLeadTime(next: QueueTrack | null): number {
  return needsStreamResolve(next) ? 45 : 20;
}

export function driveProgressMachine(i: ProgressInputs): ProgressActions {
  if (!(i.duration > 0 && i.duration - i.position > 0)) return NO_ACTIONS;
  const remaining = i.duration - i.position;
  const actions: ProgressActions = { ...NO_ACTIONS };

  if (remaining <= preloadLeadTime(i.next)) {
    // Queue exhausted → ask auto-continue to extend it (once per track).
    if (!i.prefetchRequested && !i.next) actions.requestPrefetch = true;

    if (i.next && i.preloadedKey !== i.next.key) {
      actions.invalidatePreload = i.preloadedKey !== null;
      if (!i.isPreloading) actions.preloadTrack = i.next;
      // Same-tick short-circuit as the original onTimeUpdate: the tick that
      // (re)arms a preload never also starts a crossfade.
      return actions;
    }
  }

  if (
    remaining <= i.crossfadeSecs &&
    i.crossfadeSecs > 0 &&
    i.preloadReady &&
    !i.isCrossfading
  ) {
    actions.startCrossfade = true;
  }
  return actions;
}
