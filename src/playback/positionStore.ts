import { useSyncExternalStore } from "react";

// External store for the live playback position. The position ticks ~4×/sec
// (element `timeupdate` / native `engine-position`) for as long as anything is
// playing; holding it in App-level React state re-rendered the entire tree on
// every tick. Components that display the position subscribe individually via
// usePlaybackPosition(); non-render consumers (plugin API, persistence) read
// getPlaybackPosition() on demand or subscribe directly.

type Listener = () => void;

let position = 0;
const listeners = new Set<Listener>();

export function setPlaybackPosition(secs: number): void {
  if (secs === position) return;
  position = secs;
  for (const listener of listeners) listener();
}

export function getPlaybackPosition(): number {
  return position;
}

export function subscribePlaybackPosition(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const noopSubscribe = () => () => {};
const zeroSnapshot = () => 0;

/** Live playback position for display surfaces (seek bars, lyrics). Pass
 *  `enabled: false` to opt out of per-tick re-renders while keeping hook order
 *  (e.g. a lyrics panel shown for a track that isn't the one playing). */
export function usePlaybackPosition(enabled = true): number {
  return useSyncExternalStore(
    enabled ? subscribePlaybackPosition : noopSubscribe,
    enabled ? getPlaybackPosition : zeroSnapshot,
  );
}
