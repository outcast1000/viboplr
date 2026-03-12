export interface Artist {
  id: number;
  name: string;
  track_count: number;
}

export interface Album {
  id: number;
  title: string;
  artist_id: number | null;
  artist_name: string | null;
  year: number | null;
  track_count: number;
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
  track_number: number | null;
  duration_secs: number | null;
  format: string | null;
  file_size: number | null;
  collection_id: number | null;
  subsonic_id: string | null;
  liked: boolean;
}

export interface Collection {
  id: number;
  kind: "local" | "subsonic" | "seed";
  name: string;
  path: string | null;
  url: string | null;
  username: string | null;
  last_synced_at: number | null;
}

export type View = "all" | "artists" | "albums" | "tags" | "liked";

export type SortField = "num" | "title" | "artist" | "album" | "duration";
export type SortDir = "asc" | "desc";
