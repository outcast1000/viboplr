import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack, Track } from "../types";
import { nextQueueKey, trackToQueueTrack } from "../queueEntry";

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
  };
}

/**
 * A song named by metadata as a queue entry: its library copy when the library
 * has one (`find_track_by_metadata`, the canonical lookup — local copy first),
 * otherwise metadata-only for the stream resolvers. `inLibrary` says which.
 *
 * The one implementation of "library copy wins, else play by name" — app links
 * (`viboplr://play`) and the control API go through it. A failed lookup is
 * logged and treated as no copy: the song still plays by name.
 */
export async function playableByName(
  title: string,
  artistName?: string | null,
  extra: { albumTitle?: string | null; durationSecs?: number | null } = {},
): Promise<{ track: QueueTrack; inLibrary: boolean }> {
  const row = await invoke<Track | null>("find_track_by_metadata", {
    title, artistName: artistName ?? null, albumName: extra.albumTitle ?? null,
  }).catch((e) => {
    console.error("Failed to look up a named track in the library:", e);
    return null;
  });
  return row
    ? { track: trackToQueueTrack(row), inLibrary: true }
    : { track: buildExternalQueueTrack(title, artistName, extra), inLibrary: false };
}
