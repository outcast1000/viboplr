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

/** Like subscribePlaybackPosition, but muted while the document is hidden
 *  (minimized/occluded window — WKWebView maps occlusion to visibilityState).
 *  For display-only consumers: a seek bar or lyric line nobody can see was
 *  still re-rendering ~4×/sec for as long as anything played. Fires once on
 *  becoming visible again so the display resyncs immediately. Consumers that
 *  must tick while hidden (position persistence, the plugin-facing position
 *  ref) stay on the unfiltered subscribe. */
export function subscribeVisiblePlaybackPosition(listener: Listener): () => void {
  const forward = () => { if (!document.hidden) listener(); };
  const unsubscribe = subscribePlaybackPosition(forward);
  document.addEventListener("visibilitychange", forward);
  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", forward);
  };
}

const noopSubscribe = () => () => {};
const zeroSnapshot = () => 0;

/** Live playback position for display surfaces (seek bars, lyrics). Pass
 *  `enabled: false` to opt out of per-tick re-renders while keeping hook order
 *  (e.g. a lyrics panel shown for a track that isn't the one playing).
 *  Display-only by contract, so updates pause while the document is hidden. */
export function usePlaybackPosition(enabled = true): number {
  return useSyncExternalStore(
    enabled ? subscribeVisiblePlaybackPosition : noopSubscribe,
    enabled ? getPlaybackPosition : zeroSnapshot,
  );
}
