export interface Artist {
  id: number;
  name: string;
  track_count: number;
  liked: number;
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
  id: number | null;
  key: string;
  path: string | null;
  title: string;
  artist_id: number | null;
  artist_name: string | null;
  album_id: number | null;
  album_title: string | null;
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

export interface QueueTrack {
  key: string;
  path: string | null;
  title: string;
  artist_name: string | null;
  album_title: string | null;
  duration_secs: number | null;
  format: string | null;
  image_url?: string;
  liked: number;
}

// Result of resolving a track to a playable source. `patch` carries metadata
// discovered during resolution (e.g. the real file path + format of a local
// copy matched for a path-less/remote track) so the play path can re-classify
// audio vs video and surfaces can display the right info.
export interface ResolvedTrackSource {
  src: string;
  patch?: Partial<QueueTrack>;
}

export interface SearchAllResults {
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
}

export type SearchResultItem =
  | { kind: "artist"; data: Artist }
  | { kind: "album"; data: Album }
  | { kind: "track"; data: Track };

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

export type View = "home" | "search" | "artists" | "albums" | "tags" | "history" | "collections" | "playlists" | "nowplaying" | "settings" | "extensions" | `plugin:${string}`;
export type QueueMode = "normal" | "repeat-all" | "repeat-one";

export interface HistoryEntry {
  id: number;
  history_track_id: number;
  played_at: number;
  display_title: string;
  display_artist: string | null;
  play_count: number;
}

export interface HistoryMostPlayed {
  history_track_id: number;
  play_count: number;
  display_title: string;
  display_artist: string | null;
  rank: number;
}

// A liked track read from the durable entity_likes table (Home liked shelves).
export interface LikedTrackInfo {
  title: string;
  artist_name: string | null;
  album_title: string | null;
  image_url: string | null;
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
