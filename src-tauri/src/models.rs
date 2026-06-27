use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Tri-state update for a nullable field. Distinguishes "leave unchanged"
/// from "clear to NULL" from "set to a value" — so a bulk edit can blank a
/// field (sent over the wire as JSON `null`) without it being confused with
/// an omitted (untouched) field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldUpdate<T> {
    Unchanged,
    Clear,
    Set(T),
}

impl<T> FieldUpdate<T> {
    /// Build from a serde "double option" (see `double_option` in commands):
    /// - `None`          (key absent)         => `Unchanged`
    /// - `Some(None)`    (key present, null)  => `Clear`
    /// - `Some(Some(v))` (key present, value) => `Set(v)`
    pub fn from_double_opt(v: Option<Option<T>>) -> Self {
        match v {
            None => FieldUpdate::Unchanged,
            Some(None) => FieldUpdate::Clear,
            Some(Some(x)) => FieldUpdate::Set(x),
        }
    }

    pub fn map<U>(self, f: impl FnOnce(T) -> U) -> FieldUpdate<U> {
        match self {
            FieldUpdate::Unchanged => FieldUpdate::Unchanged,
            FieldUpdate::Clear => FieldUpdate::Clear,
            FieldUpdate::Set(x) => FieldUpdate::Set(f(x)),
        }
    }
}

impl FieldUpdate<String> {
    /// Borrow the inner value as `&str` without consuming the update.
    pub fn as_str_update(&self) -> FieldUpdate<&str> {
        match self {
            FieldUpdate::Unchanged => FieldUpdate::Unchanged,
            FieldUpdate::Clear => FieldUpdate::Clear,
            FieldUpdate::Set(s) => FieldUpdate::Set(s.as_str()),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackQuery {
    pub album_id: Option<i64>,
    pub artist_id: Option<i64>,
    pub tag_id: Option<i64>,
    pub query: Option<String>,
    #[serde(default)]
    pub liked_only: bool,
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
    pub added_at: Option<i64>,
    pub modified_at: Option<i64>,
}

/// One match from a search across cached `information_values` (any info type —
/// lyrics, bios, reviews, similar lists, …). Backs the `search_information_values`
/// command / `api.informationTypes.searchValues`. `value` is the raw JSON string
/// as stored (the plugin parses it per its known shape); `snippet` is a short
/// excerpt of the matched text. `track` is the resolved library track, populated
/// only for `entity == "track"` matches when `resolve_tracks` was requested
/// (None when the track isn't in the library).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoValueMatch {
    pub type_id: String,
    pub plugin_id: String,
    pub entity: String,
    pub display_kind: String,
    pub entity_key: String,
    pub value: String,
    pub status: String,
    pub fetched_at: i64,
    pub snippet: String,
    pub track: Option<Track>,
}

/// ReplayGain values parsed from a track's `extra_tags` JSON. Gains are in dB,
/// peaks are linear (0..~1). Any field may be absent.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReplayGain {
    pub track_gain_db: Option<f64>,
    pub track_peak: Option<f64>,
    pub album_gain_db: Option<f64>,
    pub album_peak: Option<f64>,
}

impl ReplayGain {
    /// Extract REPLAYGAIN_* values from a track's `extra_tags` JSON object.
    /// Gains look like "-6.48 dB"; peaks like "0.987654". Returns None if no
    /// gain value is present (peaks alone are not useful without a gain).
    pub fn from_extra_tags_json(json: &str) -> Option<Self> {
        let v: serde_json::Value = serde_json::from_str(json).ok()?;
        let obj = v.as_object()?;
        let num = |k: &str| obj.get(k).and_then(|x| x.as_str()).and_then(parse_leading_number);
        let rg = ReplayGain {
            track_gain_db: num("REPLAYGAIN_TRACK_GAIN"),
            track_peak: num("REPLAYGAIN_TRACK_PEAK"),
            album_gain_db: num("REPLAYGAIN_ALBUM_GAIN"),
            album_peak: num("REPLAYGAIN_ALBUM_PEAK"),
        };
        if rg.track_gain_db.is_none() && rg.album_gain_db.is_none() {
            None
        } else {
            Some(rg)
        }
    }

    /// Build an `extra_tags`-style JSON object holding just the ReplayGain keys,
    /// using the same key names `from_extra_tags_json` reads. For non-file sources
    /// (e.g. OpenSubsonic) that expose RG as numbers. None if every value is absent.
    pub fn to_extra_tags_json(
        track_gain: Option<f64>,
        track_peak: Option<f64>,
        album_gain: Option<f64>,
        album_peak: Option<f64>,
    ) -> Option<String> {
        let mut map = serde_json::Map::new();
        if let Some(v) = track_gain { map.insert("REPLAYGAIN_TRACK_GAIN".to_string(), serde_json::Value::String(v.to_string())); }
        if let Some(v) = track_peak { map.insert("REPLAYGAIN_TRACK_PEAK".to_string(), serde_json::Value::String(v.to_string())); }
        if let Some(v) = album_gain { map.insert("REPLAYGAIN_ALBUM_GAIN".to_string(), serde_json::Value::String(v.to_string())); }
        if let Some(v) = album_peak { map.insert("REPLAYGAIN_ALBUM_PEAK".to_string(), serde_json::Value::String(v.to_string())); }
        if map.is_empty() {
            None
        } else {
            serde_json::to_string(&serde_json::Value::Object(map)).ok()
        }
    }
}

/// Parse the leading signed-decimal prefix of a string, ignoring a trailing unit
/// like " dB". e.g. "-6.48 dB" -> -6.48, "0.987654" -> 0.987654.
fn parse_leading_number(s: &str) -> Option<f64> {
    let s = s.trim();
    let end = s
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+'))
        .unwrap_or(s.len());
    s[..end].parse::<f64>().ok()
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
    // Resolved on read by matching display_title + display_artist against the
    // library (history itself stores no album). None when the play has no
    // matching library track. Powers album-cover lookup on the Home "Recently
    // played" shelf.
    pub display_album: Option<String>,
}

/// A single play row, stripped to only what bulk listening-pattern aggregation
/// needs. Unlike `HistoryEntry`, this does NOT resolve an album per row (the
/// per-row correlated subquery in `get_history_recent` is O(plays × tracks) and
/// can hang for minutes on large histories). Callers that need album/duration
/// resolve it client-side from an already-loaded library snapshot. Paginated by
/// keyset (`played_at`, `id`) so the whole history streams without one giant
/// query holding the DB lock. `id` is the play id (the keyset cursor).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryPlayLite {
    pub id: i64,
    pub played_at: i64,
    pub display_title: String,
    pub display_artist: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryMostPlayed {
    pub history_track_id: i64,
    pub play_count: i64,
    pub display_title: String,
    pub display_artist: Option<String>,
    pub rank: i64,
}

/// Lightweight liked-entity row read from the durable entity_likes table (the
/// "Liked Table"), used by the Home "Recently liked" / "Random liked" shelves
/// (tracks, artists, albums) and Liked-Track radio seeds. `name` is the entity's
/// display name (track/album title, or artist name). Captures non-library likes too.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LikedEntityInfo {
    pub name: String,
    pub artist_name: Option<String>,
    pub album_title: Option<String>,
    pub image_url: Option<String>,
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
    fn test_replaygain_parse_full() {
        let json = r#"{"REPLAYGAIN_TRACK_GAIN":"-6.48 dB","REPLAYGAIN_TRACK_PEAK":"0.987654","REPLAYGAIN_ALBUM_GAIN":"-7.02 dB","REPLAYGAIN_ALBUM_PEAK":"0.992"}"#;
        let rg = ReplayGain::from_extra_tags_json(json).expect("should parse");
        assert_eq!(rg.track_gain_db, Some(-6.48));
        assert_eq!(rg.track_peak, Some(0.987654));
        assert_eq!(rg.album_gain_db, Some(-7.02));
        assert_eq!(rg.album_peak, Some(0.992));
    }

    #[test]
    fn test_replaygain_handles_positive_and_no_space_unit() {
        let rg = ReplayGain::from_extra_tags_json(r#"{"REPLAYGAIN_TRACK_GAIN":"+3.2dB"}"#)
            .expect("should parse");
        assert_eq!(rg.track_gain_db, Some(3.2));
        assert_eq!(rg.album_gain_db, None);
    }

    #[test]
    fn test_replaygain_none_when_no_gain_keys() {
        // extra_tags present but carrying no RG gain -> None (peaks alone are useless).
        assert!(ReplayGain::from_extra_tags_json(r#"{"COMPOSER":"Roger Waters"}"#).is_none());
        assert!(ReplayGain::from_extra_tags_json("not valid json").is_none());
    }

    #[test]
    fn test_replaygain_roundtrip_from_numbers() {
        // OpenSubsonic-style numeric RG -> extra_tags JSON -> parsed back out.
        let json = ReplayGain::to_extra_tags_json(Some(-6.5), Some(0.97), Some(-7.0), Some(0.99))
            .expect("should build");
        let rg = ReplayGain::from_extra_tags_json(&json).expect("should parse");
        assert_eq!(rg.track_gain_db, Some(-6.5));
        assert_eq!(rg.track_peak, Some(0.97));
        assert_eq!(rg.album_gain_db, Some(-7.0));
        assert_eq!(rg.album_peak, Some(0.99));
        // All-absent -> no JSON at all.
        assert!(ReplayGain::to_extra_tags_json(None, None, None, None).is_none());
    }

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
