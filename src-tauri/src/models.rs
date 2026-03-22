use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackQuery {
    pub album_id: Option<i64>,
    pub artist_id: Option<i64>,
    pub tag_id: Option<i64>,
    pub query: Option<String>,
    #[serde(default)]
    pub liked_only: bool,
    #[serde(default)]
    pub has_youtube_url: bool,
    pub sort_field: Option<String>,
    pub sort_dir: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artist {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
    pub liked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Album {
    pub id: i64,
    pub title: String,
    pub artist_id: Option<i64>,
    pub artist_name: Option<String>,
    pub year: Option<i32>,
    pub track_count: i64,
    pub liked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
    pub liked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub artist_id: Option<i64>,
    pub artist_name: Option<String>,
    pub album_id: Option<i64>,
    pub album_title: Option<String>,
    pub year: Option<i32>,
    pub track_number: Option<i32>,
    pub duration_secs: Option<f64>,
    pub format: Option<String>,
    pub file_size: Option<i64>,
    pub collection_id: Option<i64>,
    pub collection_name: Option<String>,
    pub subsonic_id: Option<String>,
    pub liked: bool,
    pub deleted: bool,
    pub youtube_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub path: Option<String>,
    pub url: Option<String>,
    pub username: Option<String>,
    pub last_synced_at: Option<i64>,
    pub auto_update: bool,
    pub auto_update_interval_mins: i64,
    pub enabled: bool,
    pub last_sync_duration_secs: Option<f64>,
    pub last_sync_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CollectionCredentials {
    pub url: String,
    pub username: String,
    pub password_token: String,
    pub salt: Option<String>,
    pub auth_method: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanProgress {
    pub folder: String,
    pub scanned: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProgress {
    pub collection: String,
    pub synced: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayHistoryEntry {
    pub id: i64,
    pub track_id: i64,
    pub played_at: i64,
    pub track_title: String,
    pub artist_name: Option<String>,
    pub album_title: Option<String>,
    pub duration_secs: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MostPlayedTrack {
    pub track_id: i64,
    pub play_count: i64,
    pub track_title: String,
    pub artist_name: Option<String>,
    pub album_title: Option<String>,
    pub duration_secs: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistLoadResult {
    pub tracks: Vec<Track>,
    pub not_found_count: usize,
    pub playlist_name: String,
}

// --- TIDAL search result types (ephemeral, not DB-backed) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TidalSearchTrack {
    pub tidal_id: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub artist_id: Option<String>,
    pub album_title: Option<String>,
    pub album_id: Option<String>,
    pub cover_id: Option<String>,
    pub duration_secs: Option<f64>,
    pub track_number: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TidalSearchAlbum {
    pub tidal_id: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub cover_id: Option<String>,
    pub year: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TidalSearchArtist {
    pub tidal_id: String,
    pub name: String,
    pub picture_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TidalSearchResult {
    pub tracks: Vec<TidalSearchTrack>,
    pub albums: Vec<TidalSearchAlbum>,
    pub artists: Vec<TidalSearchArtist>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TidalAlbumDetail {
    pub tidal_id: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub cover_id: Option<String>,
    pub year: Option<i32>,
    pub tracks: Vec<TidalSearchTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TidalArtistDetail {
    pub tidal_id: String,
    pub name: String,
    pub picture_id: Option<String>,
    pub albums: Vec<TidalSearchAlbum>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastfmStatus {
    pub connected: bool,
    pub username: Option<String>,
}
