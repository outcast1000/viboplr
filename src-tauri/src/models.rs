use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

#[derive(Debug, Clone, Serialize)]
pub struct SearchEntityResult {
    pub tracks: Option<Vec<Track>>,
    pub albums: Option<Vec<Album>>,
    pub artists: Option<Vec<Artist>>,
    pub tags: Option<Vec<Tag>>,
    pub total: i64,
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
    pub key: String,
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
    pub collection_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProgress {
    pub collection: String,
    pub synced: u64,
    pub total: u64,
    pub collection_id: i64,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub source: Option<String>,
    pub saved_at: i64,
    pub image_path: Option<String>,
    pub track_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistTrack {
    pub id: i64,
    pub playlist_id: i64,
    pub position: i64,
    pub title: String,
    pub artist_name: Option<String>,
    pub album_name: Option<String>,
    pub duration_secs: Option<f64>,
    pub source: Option<String>,
    pub image_path: Option<String>,
}

// --- Mixtape file format types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MixtapeType {
    Custom,
    Album,
    BestOfArtist,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MixtapeImportMode {
    PlaylistAndFiles,
    PlaylistOnly,
    FilesOnly,
    JustPlay,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MixtapeManifest {
    pub version: u32,
    pub title: String,
    #[serde(rename = "type")]
    pub mixtape_type: MixtapeType,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    pub tracks: Vec<MixtapeTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MixtapeTrack {
    pub title: String,
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixtapePreview {
    pub manifest: MixtapeManifest,
    pub cover_temp_path: Option<String>,
    pub file_size: u64,
    pub total_duration_secs: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixtapeExportOptions {
    pub title: String,
    pub mixtape_type: MixtapeType,
    pub metadata: HashMap<String, String>,
    pub created_by: Option<String>,
    pub cover_image_path: Option<String>,
    pub include_thumbs: bool,
    pub track_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixtapeExportProgress {
    pub current_track: u32,
    pub total_tracks: u32,
    pub phase: String,
    pub track_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixtapeImportProgress {
    pub current_track: u32,
    pub total_tracks: u32,
    pub track_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    #[serde(default)]
    pub min_app_version: Option<String>,
    pub file: String,
    #[serde(default)]
    pub changelog: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUpdate {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub current_version: String,
    pub latest_version: String,
    pub changelog: String,
    pub download_url: String,
    pub status: String,
    pub min_app_version: Option<String>,
}

