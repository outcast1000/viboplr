export interface Artist {
  id: number;
  name: string;
  /** Tracks that perform under this name. 0 for an album-artist-only artist. */
  track_count: number;
  liked: number;
  /**
   * Non-empty albums this artist owns as ALBUMARTIST. Only meaningful when
   * `track_count` is 0 — see `utils/artistCount.ts` for the display rule.
   */
  album_count: number;
}

export interface Album {
  id: number;
  title: string;
  artist_id: number | null;
  artist_name: string | null;
  year: number | null;
  track_count: number;
  liked: number;
}

export interface Tag {
  id: number;
  name: string;
  track_count: number;
  liked: number;
}

export interface Track {
  // There is deliberately no `key` field. It used to carry a `lib:{id}` row
  // token, vestigial in-app (everything keys on `id`) and kept only for the
  // plugin wire — removed after auditing every bundled plugin and every plugin
  // repo: nothing read it. Queue entries mint their own `q:N` keys via
  // `nextQueueKey` at conversion (`trackToQueueTrack`); a library row has none.
  id: number | null;
  path: string | null;
  title: string;
  artist_id: number | null;
  artist_name: string | null;
  album_id: number | null;
  album_title: string | null;
  /** The album's own artist (ALBUMARTIST). Differs from artist_name on
   * compilations; album art/navigation from a track should use
   * `album_artist_name ?? artist_name`. */
  album_artist_name?: string | null;
  year: number | null;
  track_number: number | null;
  duration_secs: number | null;
  format: string | null;
  file_size: number | null;
  collection_id: number | null;
  collection_name: string | null;
  liked: number;
  added_at: number | null;
  modified_at: number | null;
  /** Image URL for display in the queue (file path or HTTP URL, set by caller) */
  image_url?: string;
}

/**
 * What the Track-detail page is showing.
 *
 * A discriminated union, because the two cases are resolved by different means
 * and share nothing: a **library row** is fetched by id (`get_track_by_id`),
 * while an **id-less entry** — a plugin result, an external track, a restored
 * queue row — exists only in the queue and is found by matching its
 * `QueueTrack.key`. An entry is never in `library.tracks`, so there was never a
 * case where both an id and a key were meaningful at once.
 *
 * This replaced a `{ key, libraryId }` pair, which replaced smuggling the id
 * inside the key as `lib:N` and parsing it back out. Each step removed a way
 * for the two facts to disagree; the union removes the last one by making the
 * irrelevant field unrepresentable rather than merely null.
 *
 * Session-only, never persisted: SQLite reuses the rowids of deleted tracks, so
 * a stored id could reopen on a different track — the same reason
 * `QueueTrack.libraryId` isn't persisted.
 */
export type TrackSelection =
  | { kind: "library"; libraryId: number }
  | { kind: "entry"; key: string };

export interface QueueTrack {
  /** In-memory render/session identity, unique across the queue. Two copies of
   * the same song are two entries with two keys — see `withUniqueKeys`. Never
   * parse a library id out of this; read `libraryId`. Not persisted. */
  key: string;
  /** The library row this entry came from, when known. A **cache** of "what row
   * does this path belong to", not an identity: it survives duplication (a
   * second copy of a queued library track keeps it) and is re-resolved from
   * `path` on restore, because `key` cannot carry either. Absent/null means
   * "no cached id" — NOT "not a library track"; callers fall back to
   * `find_track_id_by_path` / `find_track_by_metadata`. Never persisted: SQLite
   * reuses the rowids of deleted tracks, so a stale id would silently address
   * the wrong row. */
  libraryId?: number | null;
  path: string | null;
  title: string;
  artist_name: string | null;
  album_title: string | null;
  /** The album's own artist (ALBUMARTIST) when known. Optional so persisted
   * queues from older builds restore unchanged; consumers fall back to
   * `artist_name` (and the backend album lookup matches either artist). */
  album_artist_name?: string | null;
  duration_secs: number | null;
  format: string | null;
  image_url?: string;
  liked: number;
  /** File size in bytes, when known (e.g. converted from a library Track). Not persisted across restarts. */
  file_size?: number | null;
}

// Pre-`convertFileSrc` origin of a resolved track, for the native (mpv)
// engine, which takes raw filesystem paths / http(s) URLs instead of webview
// asset URLs. `null`/absent means the source is webview-only (e.g. a
// transcode-server stream) and must play through the browser engine.
export type EngineSource =
  | { kind: "file"; path: string }
  // `audioUrl` (http video only): a separate audio stream the native mpv engine
  // attaches to the video via `audio-file`, so hi-res sources that split
  // video-only + audio-only (e.g. YouTube ≥720p) play merged. Absent for
  // self-contained streams.
  | { kind: "http"; url: string; audioUrl?: string; headers?: Record<string, string> };

// Result of resolving a track to a playable source. `patch` carries metadata
// discovered during resolution (e.g. the real file path + format of a local
// copy matched for a path-less/remote track) so the play path can re-classify
// audio vs video and surfaces can display the right info.
export interface ResolvedTrackSource {
  src: string;
  patch?: Partial<QueueTrack>;
  engineSource?: EngineSource | null;
}

/** The winning playback-resolution entry, surfaced to the now-playing UI. `name`
 * is the display label; `id` is the resolver id (`pluginId:resolverId`, or null
 * for native entries); `effectiveSource` is where the bytes actually come from and
 * is the single thing that drives the download button + source label. */
export interface ResolvedSource {
  name: string;
  url: string;
  sourceUrl: string | null;
  id: string | null;
  effectiveSource: import("./queueEntry").EffectiveSource;
}

export interface SearchAllResults {
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
}

export type SearchResultItem =
  | { kind: "artist"; data: Artist }
  | { kind: "album"; data: Album }
  | { kind: "track"; data: Track }
  // Global-search rows contributed by plugin catalogs, always after the library
  // ones. `plugin-run` is the "Search <query> on X" offer (the host never queries
  // a plugin catalog on its own — see PluginSearchAPI); `plugin-track` is a
  // result of having done so. Both live in the same flat item list as the
  // library rows so one highlight index drives the whole dropdown.
  | { kind: "plugin-run"; providerKey: string; name: string }
  | { kind: "plugin-track"; providerKey: string; track: import("./types/plugin").PluginTrack };

export interface Collection {
  id: number;
  kind: "local" | "subsonic" | "seed" | (string & {});
  name: string;
  path: string | null;
  url: string | null;
  username: string | null;
  last_synced_at: number | null;
  auto_update: boolean;
  auto_update_interval_mins: number;
  enabled: boolean;
  last_sync_duration_secs: number | null;
  last_sync_error: string | null;
}

export interface CollectionStats {
  collection_id: number;
  track_count: number;
  video_count: number;
  total_size: number;
  total_duration: number;
}

export type View = "home" | "search" | "artists" | "albums" | "tags" | "history" | "collections" | "playlists" | "nowplaying" | "quiz" | "settings" | "extensions" | `plugin:${string}`;
export type QueueMode = "normal" | "repeat-all" | "repeat-one";

export interface HistoryEntry {
  id: number;
  history_track_id: number;
  played_at: number;
  display_title: string;
  display_artist: string | null;
  play_count: number;
  // Album resolved from the library by title+artist (history stores none).
  // Null when no matching library track exists.
  display_album: string | null;
  // The resolved album's own album artist — what an album cover is keyed by
  // (see CLAUDE.md "Album identity"). Null whenever display_album is.
  display_album_artist: string | null;
}

// A single play row stripped to what bulk listening-pattern aggregation needs.
// Unlike HistoryEntry it carries NO album (the backend skips the per-row album
// subquery here — see get_history_plays_page). Keyset-paginated by (played_at, id).
export interface HistoryPlayLite {
  id: number;
  played_at: number;
  display_title: string;
  display_artist: string | null;
}

export interface HistoryMostPlayed {
  history_track_id: number;
  play_count: number;
  display_title: string;
  display_artist: string | null;
  rank: number;
  // Library-resolved album + its album artist, same contract as HistoryEntry's
  // pair — history stores no album and both are needed to key an album cover.
  display_album: string | null;
  display_album_artist: string | null;
}

// A liked entity (track/artist/album) read from the durable entity_likes table
// (Home liked shelves). `name` is the entity's display name.
export interface LikedEntityInfo {
  name: string;
  artist_name: string | null;
  album_title: string | null;
  image_url: string | null;
  // Scheme-prefixed path frozen at like-time (from the track's `source`), or
  // null for artist/album likes and path-less external tracks.
  path: string | null;
}

export interface HistoryArtistStats {
  history_artist_id: number;
  play_count: number;
  track_count: number;
  display_name: string;
  rank: number;
}

export interface PlaylistEntry {
  url: string;
  title: string;
  artist_name: string | null;
  duration_secs: number | null;
}

export interface PlaylistLoadResult {
  entries: PlaylistEntry[];
  playlist_name: string;
}

export type SortField = "num" | "title" | "artist" | "album" | "duration" | "path" | "year" | "quality" | "size" | "collection" | "added" | "modified" | "popularity" | "random";
export type SortDir = "asc" | "desc";

export type TrackColumnId = "like" | "num" | "title" | "artist" | "album" | "duration" | "path" | "year" | "quality" | "size" | "collection" | "added" | "modified" | "popularity";
export interface ColumnConfig {
  id: TrackColumnId;
  visible: boolean;
}

export type ViewMode = "basic" | "list" | "tiles";

// Mixtape file format types
export type MixtapeType = "custom" | "album" | "best_of_artist";

export interface MixtapeTrack {
  title: string;
  artist: string;
  album: string | null;
  duration_secs: number | null;
  file: string;
  thumb: string | null;
}

export interface MixtapeManifest {
  version: number;
  title: string;
  type: MixtapeType;
  metadata: Record<string, string>;
  created_at: string;
  created_by: string | null;
  cover: string | null;
  tracks: MixtapeTrack[];
}

export interface MixtapePreview {
  manifest: MixtapeManifest;
  cover_temp_path: string | null;
  file_size: number;
  total_duration_secs: number;
}

export interface MixtapeImportProgress {
  current_track: number;
  total_tracks: number;
  track_title: string;
}
