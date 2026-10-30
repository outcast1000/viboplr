import type { QueueTrack } from "../types";
import { nextQueueKey } from "../queueEntry";

/**
 * Build a metadata-only external queue track (no path). At play time the
 * stream-resolver chain resolves a playable source by title/artist (preferring
 * a local library copy when one exists).
 */
export function buildExternalQueueTrack(
  name: string,
  artist?: string | null,
  extra: { albumTitle?: string | null; durationSecs?: number | null } = {},
): QueueTrack {
  return {
    key: nextQueueKey(),
    path: null,
    title: name,
    artist_name: artist ? artist : null,
    album_title: extra.albumTitle ?? null,
    duration_secs: extra.durationSecs ?? null,
    format: null,
    liked: 0,
  };
}
