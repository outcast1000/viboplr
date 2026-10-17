import { nativeEngine } from "./nativeEngine";

// External store for the live level meter (mpv engine only — see the engine's
// `meter.rs`), plus the ref count that decides whether the engine measures at
// all. Readings arrive ~11×/sec while something plays; like positionStore and
// bufferStore, this keeps them out of React state so a reading re-renders
// nothing that didn't ask for it.
//
// What a reading is: per-channel peak and RMS in dBFS of what the engine is
// decoding, after the EQ and **before** ReplayGain and the volume, which mpv
// applies together as one output gain (a program meter — the slider doesn't
// move it). Null means there is no live reading: paused, stopped, a track
// change, or Bit-perfect mode (which suspends the meter
// along with the rest of the DSP).
//
// Nothing is measured until a consumer holds the meter (`watchPlaybackLevel`).
// The engine's filter and poll run only between the first acquire and the last
// release, so a session with no consumer pays nothing.

export interface PlaybackLevel {
  /** Per channel, dBFS, floored at -90 (digital silence). Can exceed 0 for a
   *  clipped lossy master. */
  peakDb: number[];
  rmsDb: number[];
}

type Listener = (level: PlaybackLevel | null) => void;

let level: PlaybackLevel | null = null;
const listeners = new Set<Listener>();

export function setPlaybackLevel(next: PlaybackLevel | null): void {
  if (next === null && level === null) return;
  level = next;
  for (const listener of listeners) listener(level);
}

/** Reset at session boundaries (see usePlayback's clearStreamReadouts). */
export function clearPlaybackLevel(): void {
  setPlaybackLevel(null);
}

export function getPlaybackLevel(): PlaybackLevel | null {
  return level;
}

/**
 * How long the meter stays on after its last consumer lets go. A plugin
 * reloading, or a visualizer moving between the Now Playing and fullscreen
 * slots, drops the count to zero for a moment; switching the filter off and
 * straight back on there would rebuild mpv's filter chain twice for nothing.
 */
export const METER_RELEASE_GRACE_MS = 2000;

let holders = 0;
let meterOn = false;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

function setMeter(enabled: boolean) {
  if (meterOn === enabled) return;
  meterOn = enabled;
  nativeEngine.setMeter(enabled).catch((e) => {
    console.error(`Failed to turn the level meter ${enabled ? "on" : "off"}:`, e);
    // The engine dropped it; let the next holder ask again.
    if (enabled && meterOn) meterOn = false;
  });
}

/**
 * Subscribe to level readings, turning the engine's meter on while anyone is
 * subscribed. Every consumer shares the one meter and the one event stream;
 * the returned function releases this consumer's hold (idempotent).
 */
export function watchPlaybackLevel(listener: Listener): () => void {
  listeners.add(listener);
  holders += 1;
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  setMeter(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    listeners.delete(listener);
    holders = Math.max(0, holders - 1);
    if (holders > 0) return;
    if (releaseTimer !== null) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (holders === 0) setMeter(false);
    }, METER_RELEASE_GRACE_MS);
  };
}

/** Test-only: forget every holder and reading. */
export function resetLevelStoreForTests(): void {
  if (releaseTimer !== null) clearTimeout(releaseTimer);
  releaseTimer = null;
  holders = 0;
  meterOn = false;
  level = null;
  listeners.clear();
}
