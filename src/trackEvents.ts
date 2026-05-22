import type { Track } from "./types";

export type TrackEvent =
  | { kind: "patch"; trackId: number; patch: Partial<Track> }
  | { kind: "deleted"; trackIds: number[] };

type Listener = (event: TrackEvent) => void;

const listeners = new Set<Listener>();

export function subscribeTrackEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitTrackPatch(trackId: number, patch: Partial<Track>): void {
  const event: TrackEvent = { kind: "patch", trackId, patch };
  for (const l of listeners) {
    try { l(event); } catch (e) { console.error("trackEvents listener failed:", e); }
  }
}

export function emitTracksDeleted(trackIds: number[]): void {
  if (trackIds.length === 0) return;
  const event: TrackEvent = { kind: "deleted", trackIds };
  for (const l of listeners) {
    try { l(event); } catch (e) { console.error("trackEvents listener failed:", e); }
  }
}
