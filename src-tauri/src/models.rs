use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artist {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Album {
    pub id: i64,
    pub title: String,
    pub artist_id: Option<i64>,
    pub artist_name: Option<String>,
    pub year: Option<i32>,
    pub track_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
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
    pub track_number: Option<i32>,
    pub duration_secs: Option<f64>,
    pub format: Option<String>,
    pub file_size: Option<i64>,
    pub collection_id: Option<i64>,
    pub subsonic_id: Option<String>,
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
