import type { QueueTrack } from "../types";
import { nextExternalKey } from "../queueEntry";

/**
 * Build a metadata-only external queue track (no path). At play time the
 * stream-resolver chain resolves a playable source by title/artist (preferring
 * a local library copy when one exists).
 */
export function buildExternalQueueTrack(name: string, artist?: string | null): QueueTrack {
  return {
    key: nextExternalKey(),
    path: null,
    title: name,
    artist_name: artist ? artist : null,
    album_title: null,
    duration_secs: null,
    format: null,
    liked: 0,
  };
}
