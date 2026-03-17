export interface Artist {
  id: number;
  name: string;
  track_count: number;
  liked: boolean;
}

export interface Album {
  id: number;
  title: string;
  artist_id: number | null;
  artist_name: string | null;
  year: number | null;
  track_count: number;
  liked: boolean;
}

export interface Tag {
  id: number;
  name: string;
  track_count: number;
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
  subsonic_id: string | null;
  liked: boolean;
  deleted: boolean;
}

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
}

export type View = "all" | "artists" | "albums" | "tags" | "liked" | "history" | "tidal";

export interface PlayHistoryEntry {
  id: number;
  track_id: number;
  played_at: number;
  track_title: string;
  artist_name: string | null;
  album_title: string | null;
  duration_secs: number | null;
}

export interface MostPlayedTrack {
  track_id: number;
  play_count: number;
  track_title: string;
  artist_name: string | null;
  album_title: string | null;
  duration_secs: number | null;
}

export interface PlaylistLoadResult {
  tracks: Track[];
  not_found_count: number;
  playlist_name: string;
}

export type SortField = "num" | "title" | "artist" | "album" | "duration" | "path" | "year" | "quality" | "collection";
export type SortDir = "asc" | "desc";

export type TrackColumnId = "like" | "num" | "title" | "artist" | "album" | "duration" | "path" | "year" | "quality" | "collection";
export interface ColumnConfig {
  id: TrackColumnId;
  visible: boolean;
}

export type ArtistSortField = "name" | "tracks" | "random";
export type AlbumSortField = "name" | "year" | "random";
export type TagSortField = "name" | "tracks" | "random";

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
