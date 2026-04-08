use serde::{Deserialize, Serialize};

fn default_true() -> bool { true }

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
    #[serde(default = "default_true")]
    pub include_lyrics: bool,
    pub media_type: Option<String>,
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
    pub liked: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Album {
    pub id: i64,
    pub title: String,
    pub artist_id: Option<i64>,
    pub artist_name: Option<String>,
    pub year: Option<i32>,
    pub track_count: i64,
    pub liked: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchAllResults {
    pub artists: Vec<Artist>,
    pub albums: Vec<Album>,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
    pub liked: i32,
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
    pub liked: i32,
    pub youtube_url: Option<String>,
    pub added_at: Option<i64>,
    pub modified_at: Option<i64>,
    pub relative_path: Option<String>,
}

impl Track {
    /// Returns true if this track is from a remote server (subsonic:// or tidal://).
    pub fn is_remote(&self) -> bool {
        self.path.starts_with("subsonic://") || self.path.starts_with("tidal://")
    }

    /// Returns the bare filesystem path by stripping the file:// prefix.
    /// Returns None for remote tracks.
    pub fn filesystem_path(&self) -> Option<&str> {
        self.path.strip_prefix("file://")
    }

    /// Extracts the remote track ID from a subsonic:// path (last path segment).
    pub fn remote_id(&self) -> Option<&str> {
        self.path.strip_prefix("subsonic://")
            .and_then(|rest| rest.rfind('/').map(|i| &rest[i + 1..]))
            .filter(|id| !id.is_empty())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lyrics {
    pub track_id: i64,
    pub text: String,
    pub kind: String,
    pub provider: String,
    pub fetched_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricsLoaded {
    pub track_id: i64,
    pub text: String,
    pub kind: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricsError {
    pub track_id: i64,
    pub error: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionStats {
    pub collection_id: i64,
    pub track_count: i64,
    pub video_count: i64,
    pub total_size: i64,
    pub total_duration: f64,
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
pub struct HistoryEntry {
    pub id: i64,
    pub history_track_id: i64,
    pub played_at: i64,
    pub display_title: String,
    pub display_artist: Option<String>,
    pub play_count: i64,
    pub library_track_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryMostPlayed {
    pub history_track_id: i64,
    pub play_count: i64,
    pub display_title: String,
    pub display_artist: Option<String>,
    pub library_track_id: Option<i64>,
    pub rank: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryArtistStats {
    pub history_artist_id: i64,
    pub play_count: i64,
    pub track_count: i64,
    pub display_name: String,
    pub library_artist_id: Option<i64>,
    pub rank: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackPlayEntry {
    pub played_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackPlayStats {
    pub play_count: i64,
    pub first_played_at: Option<i64>,
    pub last_played_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistEntry {
    pub url: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub duration_secs: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistLoadResult {
    pub entries: Vec<PlaylistEntry>,
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

#[derive(Debug, Clone, Serialize)]
pub struct DeleteFailure {
    pub title: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTracksResult {
    pub deleted_ids: Vec<i64>,
    pub failures: Vec<DeleteFailure>,
}

