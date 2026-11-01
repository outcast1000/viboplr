import type { Track, QueueTrack } from "./types";
import type { LikeChange } from "./types/plugin";

// Rust's `char::is_whitespace` (Unicode White_Space), which `str::trim` uses.
// Not JS's `String.prototype.trim`: that one also trims U+FEFF and leaves
// U+0085, so a name carrying either folds to a different key than the backend's.
const WS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const TRIM = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");

/** One segment of an entity_likes key: the port of Rust's `db::likes::norm_segment`
 *  (trim → lowercase → NFD → drop marks). Rust's `is_combining_mark` is
 *  General_Category=Mark, the same set as `\p{M}`. Pinned against Rust by the
 *  shared `src-tauri/tests/fixtures/entity-key-fold.json`. Never make it fuzzier:
 *  the fold is a contract with the Vibo Community server (backend.md "Likes"). */
export function foldKeySegment(s: string | null | undefined): string {
  return (s ?? "").replace(TRIM, "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

/** The port of Rust's `build_entity_key`: the exact key `entity_likes` stores. */
export function entityKey(
  kind: "track" | "album" | "artist" | "tag",
  nameOrTitle: string,
  artistName?: string | null,
): string {
  if (kind === "track" || kind === "album") {
    return `${kind}:${foldKeySegment(artistName)}:${foldKeySegment(nameOrTitle)}`;
  }
  return `${kind}:${foldKeySegment(nameOrTitle)}`;
}

/** A track's entity_likes key — the song's identity for likes. */
export function trackLikeKey(title: string | null | undefined, artistName: string | null | undefined): string {
  return entityKey("track", title ?? "", artistName);
}

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
