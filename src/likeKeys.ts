import type { Track, QueueTrack } from "./types";
import type { LikeChange } from "./types/plugin";

/** Payload shape consumed by the `set_entity_like_state` Tauri command. */
export interface EntityLikePayload {
  title: string;
  artistName: string | null;
  albumTitle: string | null;
  durationSecs: number | null;
  source: string | null;
  imageUrl: string | null;
}

/** Build the entity payload for a track like/dislike. Either track shape —
 *  the durable key is metadata-based, so no id of any kind is involved. */
export function trackLikePayload(track: Track | QueueTrack): EntityLikePayload {
  return {
    title: track.title,
    artistName: track.artist_name ?? null,
    albumTitle: track.album_title ?? null,
    durationSecs: track.duration_secs ?? null,
    source: track.path ?? null,
    imageUrl: track.image_url ?? null,
  };
}

/** Build the entity payload for an artist/album/tag like/dislike (name-based). */
export function entityLikePayload(name: string, artistName?: string | null): EntityLikePayload {
  return {
    title: name,
    artistName: artistName ?? null,
    albumTitle: null,
    durationSecs: null,
    source: null,
    imageUrl: null,
  };
}

/** The `like:changed` plugin event for a track. */
export function trackLikeChange(track: Track | QueueTrack, liked: number, previous: number): LikeChange {
  return {
    kind: "track",
    name: track.title,
    artistName: track.artist_name ?? null,
    albumTitle: track.album_title ?? null,
    albumArtistName: track.album_artist_name ?? null,
    liked,
    previous,
  };
}

/** The `like:changed` plugin event for an artist, album or tag, from the
 *  payload that was saved (so the event names exactly what was liked). */
export function entityLikeChange(
  kind: "artist" | "album" | "tag",
  entity: EntityLikePayload,
  liked: number,
  previous: number,
): LikeChange {
  return {
    kind,
    name: entity.title,
    artistName: kind === "album" ? entity.artistName : null,
    albumTitle: null,
    albumArtistName: null,
    liked,
    previous,
  };
}

/** Compute the next tri-state value when toggling like or dislike. */
export function nextTriState(current: number, action: "like" | "dislike"): number {
  if (action === "like") return current === 1 ? 0 : 1;
  return current === -1 ? 0 : -1;
}
