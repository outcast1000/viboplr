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
  id: number;
  path: string;
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
  youtube_url: string | null;
  added_at: number | null;
  modified_at: number | null;
  relative_path: string | null;
  /** Playback URL computed when the track enters the queue (e.g. file://, tidal://, subsonic://) */
  url?: string;
  /** Image URL for display in the queue (file path or HTTP URL, set by caller) */
  image_url?: string;
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
  kind: "local" | "subsonic" | "seed" | "tidal";
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

export type View = "search" | "all" | "artists" | "albums" | "tags" | "liked" | "history" | "collections" | "playlists" | "settings" | `plugin:${string}`;

export interface HistoryEntry {
  id: number;
  history_track_id: number;
  played_at: number;
  display_title: string;
  display_artist: string | null;
  play_count: number;
  library_track_id: number | null;
}

export interface HistoryMostPlayed {
  history_track_id: number;
  play_count: number;
  display_title: string;
  display_artist: string | null;
  library_track_id: number | null;
  rank: number;
}

export interface HistoryArtistStats {
  history_artist_id: number;
  play_count: number;
  track_count: number;
  display_name: string;
  library_artist_id: number | null;
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

export type ArtistSortField = "name" | "tracks" | "random";
export type AlbumSortField = "name" | "artist" | "year" | "tracks" | "random";
export type TagSortField = "name" | "tracks" | "random";

export type ViewMode = "basic" | "list" | "tiles";

// TIDAL search result types
export interface TidalSearchTrack {
  tidal_id: string;
  title: string;
  artist_name: string | null;
  artist_id: string | null;
  album_title: string | null;
  album_id: string | null;
  cover_id: string | null;
  duration_secs: number | null;
  track_number: number | null;
}

export interface TidalSearchAlbum {
  tidal_id: string;
  title: string;
  artist_name: string | null;
  cover_id: string | null;
  year: number | null;
}

export interface TidalSearchArtist {
  tidal_id: string;
  name: string;
  picture_id: string | null;
}

export interface TidalSearchResult {
  tracks: TidalSearchTrack[];
  albums: TidalSearchAlbum[];
  artists: TidalSearchArtist[];
}

export interface TidalAlbumDetail {
  tidal_id: string;
  title: string;
  artist_name: string | null;
  cover_id: string | null;
  year: number | null;
  tracks: TidalSearchTrack[];
}

export interface TidalArtistDetail {
  tidal_id: string;
  name: string;
  picture_id: string | null;
  albums: TidalSearchAlbum[];
}

// Tape file format types
export type TapeType = "custom" | "album" | "best_of_artist";

export interface TapeTrack {
  title: string;
  artist: string;
  album: string | null;
  duration_secs: number | null;
  file: string;
  thumb: string | null;
}

export interface TapeManifest {
  version: number;
  title: string;
  type: TapeType;
  quality: string;
  comment: string | null;
  created_at: string;
  created_by: string | null;
  cover: string | null;
  tracks: TapeTrack[];
}

export interface TapePreview {
  manifest: TapeManifest;
  cover_temp_path: string | null;
  file_size: number;
  total_duration_secs: number;
}

export interface TapeImportProgress {
  current_track: number;
  total_tracks: number;
  track_title: string;
}
