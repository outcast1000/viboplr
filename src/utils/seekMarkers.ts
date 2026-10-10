// Seek-bar markers a plugin puts on the playing track (`api.playback.setMarkers`):
// the Community plugin's timed comments, drawn as ticks with a hover label.
//
// Pure, so the limits and the "which marker is under the pointer" rule are
// asserted without a bar to render.

import type { PluginSeekMarker } from "../types/plugin";

/** Kept per plugin, per track. More than this is noise on a seek bar. */
export const MAX_SEEK_MARKERS = 200;
export const MAX_SEEK_MARKER_LABEL = 160;

export interface SeekMarker {
  at: number;
  label: string;
}

/** A plugin's markers as the host keeps them: finite, non-negative times,
 *  plain-text labels trimmed and capped, sorted, at most `MAX_SEEK_MARKERS`.
 *  Anything malformed is dropped rather than failing the call. */
export function sanitizeSeekMarkers(markers: unknown): SeekMarker[] {
  if (!Array.isArray(markers)) return [];
  const out: SeekMarker[] = [];
  for (const m of markers as PluginSeekMarker[]) {
    if (!m || typeof m !== "object") continue;
    const at = Number(m.at);
    if (!Number.isFinite(at) || at < 0) continue;
    const label = typeof m.label === "string" ? m.label.replace(/\s+/g, " ").trim().slice(0, MAX_SEEK_MARKER_LABEL) : "";
    out.push({ at, label });
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(0, MAX_SEEK_MARKERS);
}

/** Every plugin's markers for one track, as one sorted list. */
export function mergeSeekMarkers(byPlugin: Record<string, SeekMarker[]>): SeekMarker[] {
  return Object.values(byPlugin)
    .flat()
    .sort((a, b) => a.at - b.at);
}

/**
 * The labels of the markers near `secs`, for the hover bubble. "Near" is a
 * fraction of the track (`tolerancePct` of its length, at least one second),
 * because a tick is a few pixels wide whatever the duration. Several markers
 * can sit on one tick, so all of them are returned, at most `max`.
 */
export function markerLabelsNear(
  markers: readonly SeekMarker[],
  secs: number,
  durationSecs: number,
  tolerancePct = 0.008,
  max = 3,
): string[] {
  if (durationSecs <= 0 || markers.length === 0) return [];
  const tolerance = Math.max(1, durationSecs * tolerancePct);
  return markers
    .filter((m) => m.label && Math.abs(m.at - secs) <= tolerance)
    .sort((a, b) => Math.abs(a.at - secs) - Math.abs(b.at - secs))
    .slice(0, max)
    .map((m) => m.label);
}
