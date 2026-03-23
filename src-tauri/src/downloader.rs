use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DownloadFormat {
    Flac,
    Aac,
    Mp3,
}

impl DownloadFormat {
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "flac" => Ok(Self::Flac),
            "aac" => Ok(Self::Aac),
            "mp3" => Ok(Self::Mp3),
            _ => Err(format!("Unknown format: {}", s)),
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            Self::Flac => "flac",
            Self::Aac => "m4a",
            Self::Mp3 => "mp3",
        }
    }

    pub fn tidal_quality(&self) -> &'static str {
        match self {
            Self::Flac => "LOSSLESS",
            Self::Aac | Self::Mp3 => "HIGH",
        }
    }

    pub fn subsonic_format_param(&self) -> Option<&'static str> {
        match self {
            Self::Flac => None, // raw/original
            Self::Aac => Some("aac"),
            Self::Mp3 => Some("mp3"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct DownloadRequest {
    pub id: u64,
    pub track_title: String,
    pub artist_name: String,
    pub album_title: String,
    pub track_number: Option<u32>,
    pub genre: Option<String>,
    pub year: Option<i32>,
    pub cover_url: Option<String>,
    pub source_collection_id: i64,
    pub remote_track_id: String,
    pub dest_collection_id: i64,
    pub dest_collection_path: String,
    pub format: DownloadFormat,
    /// If true, this is the last track in a batch (album download). FTS rebuild happens after this one.
    pub is_batch_last: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadStatus {
    pub id: u64,
    pub track_title: String,
    pub artist_name: String,
    pub status: String,
    pub progress_pct: u8,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadQueueInfo {
    pub active: Option<DownloadStatus>,
    pub queued: Vec<DownloadStatus>,
    pub completed: Vec<DownloadStatus>,
}

pub struct DownloadManager {
    pub queue: Mutex<VecDeque<DownloadRequest>>,
    pub condvar: Condvar,
    pub active: Mutex<Option<DownloadStatus>>,
    pub next_id: AtomicU64,
    pub completed: Mutex<VecDeque<DownloadStatus>>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
            condvar: Condvar::new(),
            active: Mutex::new(None),
            next_id: AtomicU64::new(1),
            completed: Mutex::new(VecDeque::new()),
        }
    }

    pub fn enqueue(&self, request: DownloadRequest) {
        let mut queue = self.queue.lock().unwrap();
        queue.push_back(request);
        self.condvar.notify_one();
    }

    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn cancel(&self, download_id: u64) -> bool {
        let mut queue = self.queue.lock().unwrap();
        let len_before = queue.len();
        queue.retain(|r| r.id != download_id);
        queue.len() < len_before
    }

    pub fn get_status(&self) -> DownloadQueueInfo {
        let active = self.active.lock().unwrap().clone();
        let queued: Vec<DownloadStatus> = self
            .queue
            .lock()
            .unwrap()
            .iter()
            .map(|r| DownloadStatus {
                id: r.id,
                track_title: r.track_title.clone(),
                artist_name: r.artist_name.clone(),
                status: "queued".to_string(),
                progress_pct: 0,
                error: None,
            })
            .collect();
        let completed: Vec<DownloadStatus> =
            self.completed.lock().unwrap().iter().cloned().collect();
        DownloadQueueInfo {
            active,
            queued,
            completed,
        }
    }

    pub fn set_active(&self, status: Option<DownloadStatus>) {
        *self.active.lock().unwrap() = status;
    }

    pub fn push_completed(&self, status: DownloadStatus) {
        let mut completed = self.completed.lock().unwrap();
        completed.push_back(status);
        while completed.len() > 10 {
            completed.pop_front();
        }
    }

    /// Wait for next request from the queue (blocks until available)
    pub fn wait_for_next(&self) -> DownloadRequest {
        let mut queue = self.queue.lock().unwrap();
        while queue.is_empty() {
            queue = self.condvar.wait(queue).unwrap();
        }
        queue.pop_front().unwrap()
    }
}
