use serde::{Deserialize, Serialize};

// --- Search Protocol ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    pub peer_id: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchMatch {
    pub track_id: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub album_title: Option<String>,
    pub duration_secs: Option<f64>,
    pub format: Option<String>,
    pub file_size: Option<i64>,
}

// --- Transfer Protocol (v2 — binary framing) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferRequest {
    pub track_id: String,
    pub mode: TransferMode,
    #[serde(default)]
    pub offset: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferMode {
    Stream,
    Download,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TransferResponseHeader {
    pub error: Option<String>,
    pub title: Option<String>,
    pub artist_name: Option<String>,
    pub album_title: Option<String>,
    pub format: Option<String>,
    pub file_size: Option<u64>,
    pub duration_secs: Option<f64>,
    pub checksum: Option<String>,
}
