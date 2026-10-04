// Pure half of the in-app replace (`api.library.replaceTrackFile`): what the
// host's Replace dialog says about the two files, and whether the track being
// replaced is the one playing. The flow itself lives in App.tsx; the dialog in
// components/ReplaceTrackFileModal.tsx.
import { formatDuration, formatFileSize } from "../utils";
import type { QueueTrack } from "../types";

/** One side of the comparison, as `stage_track_replacement` reports it. */
export interface FileQuality {
  format?: string | null;
  fileSize?: number | null;
  durationSecs?: number | null;
  bitrateKbps?: number | null;
  sampleRate?: number | null;
  bitDepth?: number | null;
}

/** What `stage_track_replacement` returns. */
export interface StagedReplacement {
  stageId: string;
  trackId: number;
  title: string;
  artistName: string | null;
  albumTitle: string | null;
  current: FileQuality;
  replacement: FileQuality;
}

const LOSSLESS = new Set(["flac", "alac", "wav", "aiff", "aif", "aifc", "ape", "wv", "tta", "dsf", "dff"]);

/**
 * "FLAC · 16-bit · 44.1 kHz · 38.2 MB" / "MP3 · 192 kbps · 7.9 MB". Lossless
 * reads as depth + rate (a bitrate is meaningless there), lossy as bitrate.
 */
export function describeQuality(q: FileQuality): string {
  const format = (q.format ?? "").toLowerCase();
  const parts: string[] = [format ? format.toUpperCase() : "Unknown format"];
  if (LOSSLESS.has(format)) {
    if (q.bitDepth) parts.push(`${q.bitDepth}-bit`);
    if (q.sampleRate) parts.push(`${(q.sampleRate / 1000).toFixed(1).replace(/\.0$/, "")} kHz`);
  } else if (q.bitrateKbps) {
    parts.push(`${q.bitrateKbps} kbps`);
  }
  if (q.fileSize) parts.push(formatFileSize(q.fileSize));
  return parts.join(" · ");
}

/** Beyond this the two files are probably different recordings. */
export const LENGTH_MISMATCH_SECS = 5;

/**
 * A warning when the two files' lengths disagree (a live take, an edit, a
 * different song), or null. Only when both lengths are known.
 */
export function lengthWarning(current: FileQuality, replacement: FileQuality): string | null {
  const a = current.durationSecs;
  const b = replacement.durationSecs;
  if (!a || !b || Math.abs(a - b) <= LENGTH_MISMATCH_SECS) return null;
  return `The lengths differ (${formatDuration(a)} now, ${formatDuration(b)} new) — it may be a different recording.`;
}

/**
 * Is `track` (the one playing) the library row being replaced? By cached id
 * when the entry has one, else by its file URI — `libraryId` is a cache, not
 * an identity (queue.md), so a missing one must not read as "not this track".
 */
export function isTrackBeingReplaced(track: QueueTrack | null, trackId: number, trackPath: string | null): boolean {
  if (!track) return false;
  if (track.libraryId != null) return track.libraryId === trackId;
  return trackPath != null && track.path === trackPath;
}
