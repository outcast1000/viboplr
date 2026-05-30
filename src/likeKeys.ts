import type { QueueTrack } from "./types";

/** Payload shape consumed by the `set_entity_like_state` Tauri command. */
export interface EntityLikePayload {
  title: string;
  artistName: string | null;
  albumTitle: string | null;
  durationSecs: number | null;
  source: string | null;
  imageUrl: string | null;
}

/** Build the entity payload for a track like/dislike. */
export function trackLikePayload(track: QueueTrack): EntityLikePayload {
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

/** Compute the next tri-state value when toggling like or dislike. */
export function nextTriState(current: number, action: "like" | "dislike"): number {
  if (action === "like") return current === 1 ? 0 : 1;
  return current === -1 ? 0 : -1;
}
