use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;

use crate::db::Database;
use super::protocols::{
    SearchMatch, SearchRequest, SearchResponse, TransferHeader, TransferRequest, TransferResponse,
};

const MAX_QUERY_LENGTH: usize = 100;
const RATE_LIMIT_PER_MINUTE: usize = 10;

pub struct RequestHandler {
    pub db: Arc<Database>,
    pub shared_collection_ids: Arc<RwLock<Vec<i64>>>,
    pub local_peer_id: String,
    rate_limits: Arc<RwLock<HashMap<String, Vec<Instant>>>>,
}

impl RequestHandler {
    pub fn new(
        db: Arc<Database>,
        shared_collection_ids: Arc<RwLock<Vec<i64>>>,
        local_peer_id: String,
    ) -> Self {
        Self {
            db,
            shared_collection_ids,
            local_peer_id,
            rate_limits: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn handle_search(
        &self,
        request: SearchRequest,
        from_peer: &str,
    ) -> SearchResponse {
        if request.query.len() > MAX_QUERY_LENGTH {
            return SearchResponse {
                peer_id: self.local_peer_id.clone(),
                matches: vec![],
            };
        }

        if !self.check_rate_limit(from_peer).await {
            log::warn!("Rate limited search from peer: {}", from_peer);
            return SearchResponse {
                peer_id: self.local_peer_id.clone(),
                matches: vec![],
            };
        }

        let shared_ids = self.shared_collection_ids.read().await;
        if shared_ids.is_empty() {
            return SearchResponse {
                peer_id: self.local_peer_id.clone(),
                matches: vec![],
            };
        }

        let limit = request.limit.min(50) as usize;
        let collection_ids: Vec<i64> = shared_ids.clone();
        let query = request.query.clone();

        let matches = match self.db.p2p_search_tracks(&query, &collection_ids, limit) {
            Ok(tracks) => tracks
                .into_iter()
                .map(|t| SearchMatch {
                    track_id: t.id.to_string(),
                    title: t.title,
                    artist_name: t.artist_name,
                    album_title: t.album_title,
                    duration_secs: t.duration_secs,
                    format: t.format,
                    file_size: t.file_size,
                })
                .collect(),
            Err(e) => {
                log::error!("P2P search query failed: {}", e);
                vec![]
            }
        };

        SearchResponse {
            peer_id: self.local_peer_id.clone(),
            matches,
        }
    }

    pub async fn handle_transfer(&self, request: TransferRequest) -> TransferResponse {
        let track_id: i64 = match request.track_id.parse() {
            Ok(id) => id,
            Err(_) => {
                return TransferResponse {
                    header: None,
                    error: Some("Invalid track ID".to_string()),
                    data: vec![],
                };
            }
        };

        let track = match self.db.get_track_by_id(track_id) {
            Ok(t) => t,
            Err(e) => {
                return TransferResponse {
                    header: None,
                    error: Some(format!("Track not found: {}", e)),
                    data: vec![],
                };
            }
        };

        // Verify track is in a shared collection
        let shared_ids = self.shared_collection_ids.read().await;
        if let Some(cid) = track.collection_id {
            if !shared_ids.contains(&cid) {
                return TransferResponse {
                    header: None,
                    error: Some("Track not in shared collection".to_string()),
                    data: vec![],
                };
            }
        } else {
            return TransferResponse {
                header: None,
                error: Some("Track has no collection".to_string()),
                data: vec![],
            };
        }

        // Get filesystem path
        let file_path = match track.path.strip_prefix("file://") {
            Some(p) => p.to_string(),
            None => {
                return TransferResponse {
                    header: None,
                    error: Some("Track is not a local file".to_string()),
                    data: vec![],
                };
            }
        };

        // Read file
        let data = match std::fs::read(&file_path) {
            Ok(d) => d,
            Err(e) => {
                return TransferResponse {
                    header: None,
                    error: Some(format!("Failed to read file: {}", e)),
                    data: vec![],
                };
            }
        };

        let file_size = data.len() as u64;

        TransferResponse {
            header: Some(TransferHeader {
                title: track.title,
                artist_name: track.artist_name,
                album_title: track.album_title,
                format: track.format.unwrap_or_else(|| "unknown".to_string()),
                file_size,
                duration_secs: track.duration_secs,
            }),
            error: None,
            data,
        }
    }

    async fn check_rate_limit(&self, peer_id: &str) -> bool {
        let mut limits = self.rate_limits.write().await;
        let now = Instant::now();
        let one_minute_ago = now - std::time::Duration::from_secs(60);

        let entries = limits.entry(peer_id.to_string()).or_default();
        entries.retain(|t| *t > one_minute_ago);

        if entries.len() >= RATE_LIMIT_PER_MINUTE {
            return false;
        }

        entries.push(now);
        true
    }
}
