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
    pub sort_chain: Option<Vec<SortKey>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    pub field: String,
    pub dir: String,
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
    /// Returns true if this track is not a local file (anything except file://).
    pub fn is_remote(&self) -> bool {
        !self.path.is_empty() && !self.path.starts_with("file://")
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

/// Returns true if `bare_path` (a filesystem path with any `file://` prefix
/// already stripped) points at a Windows network share / UNC location.
///
/// Network shares need special handling on Windows for two reasons:
/// - The OS has no Recycle Bin for them, so `trash::delete` cannot honor an
///   undo-able move (callers must permanently delete instead).
/// - `std::fs::canonicalize` turns them into a `\\?\UNC\...` verbatim path that
///   the shell "reveal/select" APIs reject (callers must open the folder a
///   different way).
///
/// UNC paths begin with two separators (`\\server\share` or `//server/share`).
/// A plain triple-slash `file:///foo` URI strips to a single-separator `/foo`,
/// and a local Windows drive strips to `C:\...`, so neither is misclassified.
pub fn is_network_path(bare_path: &str) -> bool {
    bare_path.starts_with("\\\\") || bare_path.starts_with("//")
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryMostPlayed {
    pub history_track_id: i64,
    pub play_count: i64,
    pub display_title: String,
    pub display_artist: Option<String>,
    pub rank: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryArtistStats {
    pub history_artist_id: i64,
    pub play_count: i64,
    pub track_count: i64,
    pub display_name: String,
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
    pub deleted_paths: Vec<String>,
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
    pub description: Option<String>,
    pub metadata: Option<String>,
    pub system_kind: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixtapeTrackMeta {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_secs: Option<f64>,
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixtapePlaylistExportOptions {
    pub title: String,
    pub mixtape_type: MixtapeType,
    pub metadata: HashMap<String, String>,
    pub created_by: Option<String>,
    pub cover_image_path: Option<String>,
    pub include_thumbs: bool,
    pub tracks: Vec<MixtapeTrackMeta>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixtapeExportTrackInput {
    #[allow(dead_code)]
    pub id: Option<i64>,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_secs: Option<f64>,
    pub path: Option<String>,
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixtapeFullExportOptions {
    pub title: String,
    pub mixtape_type: MixtapeType,
    pub metadata: HashMap<String, String>,
    pub created_by: Option<String>,
    pub cover_image_path: Option<String>,
    pub include_thumbs: bool,
    pub tracks: Vec<MixtapeExportTrackInput>,
    pub format: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MainPlaylistState {
    pub queue_index: i32,
    // "normal" | "repeat-all" | "repeat-one"; legacy "loop"/"shuffle" normalized on read (frontend).
    pub queue_mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainPlaylistReadResult {
    pub manifest: Option<MixtapeManifest>,
    pub state: Option<MainPlaylistState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSource {
    /// Local filesystem path to copy from.
    pub path: Option<String>,
    /// Remote URL to download from.
    pub url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_network_path() {
        // Windows UNC paths (backslash and forward-slash forms).
        assert!(is_network_path("\\\\server\\share\\song.mp3"));
        assert!(is_network_path("//server/share/song.mp3"));

        // Local Windows drive and POSIX absolute paths are NOT network shares.
        assert!(!is_network_path("C:\\Music\\song.mp3"));
        assert!(!is_network_path("/home/user/song.mp3"));

        // A `file:///foo` URI strips to a single-slash path — not a share.
        assert!(!is_network_path("/Users/alex/song.mp3"));

        // Relative / empty are not shares.
        assert!(!is_network_path("song.mp3"));
        assert!(!is_network_path(""));
    }
}
