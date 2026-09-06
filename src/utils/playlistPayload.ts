// Conversion from an in-app track (library Track or id-less QueueTrack) to
// the backend's PlaylistTrackPayload shape — the one mapping used by every
// path that writes playlist rows (save_playlist_record, append_playlist_tracks).
import type { QueueTrack, Track } from "../types";

export interface PlaylistTrackPayload {
  title: string;
  artist_name: string | null;
  album_name: string | null;
  duration_secs: number | null;
  source: string | null;
  image_url: string | null;
}

export function toPlaylistTrackPayload(t: QueueTrack | Track): PlaylistTrackPayload {
  return {
    title: t.title,
    artist_name: t.artist_name ?? null,
    album_name: t.album_title ?? null,
    duration_secs: t.duration_secs ?? null,
    source: t.path ?? null,
    image_url: t.image_url ?? null,
  };
}
