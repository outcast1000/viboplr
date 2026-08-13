import { useSyncExternalStore } from "react";
import { applyBuffer, type PlaybackBuffer } from "./bufferState";

// External store for the current source's buffer readout, mirroring
// positionStore. While a network stream fills its cache the buffered edge
// advances continuously (browser `progress` events several times a second,
// mpv's change-gated `engine-buffer`); holding it in App-level React state
// re-rendered the entire tree 1-4×/sec for the filling phase of every
// streamed track — continuously for internet radio. Only the two surfaces
// that draw it (NowPlayingBar, FullscreenControls) subscribe, via
// usePlaybackBuffer().

type Listener = () => void;

let buffer: PlaybackBuffer | null = null;
const listeners = new Set<Listener>();

/** Merge a patch via applyBuffer, which returns the previous object identity
 *  when nothing visibly moved — in that case nobody is notified, preserving
 *  the no-change render economics the React state version had. */
export function updatePlaybackBuffer(patch: Partial<PlaybackBuffer>): void {
  const next = applyBuffer(buffer, patch);
  if (next === buffer) return;
  buffer = next;
  for (const listener of listeners) listener();
}

/** Reset at session boundaries (see usePlayback's clearStreamReadouts). */
export function clearPlaybackBuffer(): void {
  if (buffer === null) return;
  buffer = null;
  for (const listener of listeners) listener();
}

export function getPlaybackBuffer(): PlaybackBuffer | null {
  return buffer;
}

export function subscribePlaybackBuffer(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Live buffer state for the surfaces that draw the buffered edge / stall chip. */
export function usePlaybackBuffer(): PlaybackBuffer | null {
  return useSyncExternalStore(subscribePlaybackBuffer, getPlaybackBuffer);
}
