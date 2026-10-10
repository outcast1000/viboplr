//! What the assistant is doing to the app, and the user's pause switch.
//!
//! Every control-API request (socket or in-process) passes the middleware in
//! `control_api.rs`, which asks this module two questions:
//!
//! 1. **What is it?** [`classify`] maps a method + route pattern to a short
//!    label and a [`Kind`]. The kind drives the activity pill (reads are
//!    log-only) and the pause switch (reads and UI navigation pass, writes and
//!    outward-facing calls are refused).
//! 2. **Is the assistant paused?** [`is_paused`] reads a marker file in the
//!    profile dir on every request, the same way write scopes are re-read, so
//!    a restart cannot silently resume it and the frontend never holds the
//!    authoritative copy.
//!
//! The event the webview listens to (`assistant-activity`) is a presentation
//! concern only: pausing is enforced here in Rust, before any bridge.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Marker file in the profile dir: present = the assistant is paused.
pub const PAUSE_FILE: &str = "assistant-paused";

/// Tauri event carrying one [`ActivityEvent`].
pub const ACTIVITY_EVENT: &str = "assistant-activity";
/// Tauri event sent when the pause switch flips (payload: `bool`).
pub const PAUSED_EVENT: &str = "assistant-paused-changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// Changes nothing. Logged, never shown in the pill.
    Read,
    /// Opens pages and dialogs. Changes no library row, file or like.
    Ui,
    /// Changes the app's state: library, queue, playlists, files, likes, tags.
    Write,
    /// Hands work to a plugin, a download provider or the network. Whether it
    /// leaves the machine is up to the plugin, so it is treated as if it might.
    Outward,
}

impl Kind {
    /// Refused while the assistant is paused.
    pub fn blocked_when_paused(self) -> bool {
        matches!(self, Kind::Write | Kind::Outward)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    pub label: &'static str,
    pub kind: Kind,
}

const fn c(label: &'static str, kind: Kind) -> Classified {
    Classified { label, kind }
}

/// Map a request to what it does. `route` is the router's **pattern**
/// (`/v1/playlists/{id}/tracks`), never the concrete URI.
///
/// Anything not named is a `Write` when it isn't a `GET`, so a route added
/// later is refused while paused until someone decides it is harmless —
/// the safe direction to be wrong in.
pub fn classify(method: &str, route: &str) -> Classified {
    use Kind::*;
    let method = method.to_ascii_uppercase();
    match (method.as_str(), route) {
        // Reads that happen to be POSTs (they carry a body).
        ("POST", "/v1/query") => c("Run a read-only query", Read),
        ("POST", "/v1/search/plugin") => c("Search a plugin catalog", Read),
        ("POST", "/v1/info/fetch") => c("Fetch information", Read),
        ("POST", "/v1/home/shelf") => c("Read a Home shelf", Read),
        // UI verbs: open pages and panels, change no data.
        ("POST", "/v1/ui/navigate") => c("Open a page", Ui),
        ("POST", "/v1/ui/action") => c("Do a UI action", Ui),
        ("POST", "/v1/window") | ("PUT", "/v1/window") | ("PATCH", "/v1/window") => c("Move or resize the window", Ui),
        // Outward-facing: plugins, providers, the network.
        ("POST", "/v1/actions/invoke") => c("Run a plugin action", Outward),
        ("POST", "/v1/plugins/{id}/deep-link") => c("Open a plugin deep link", Outward),
        ("POST", "/v1/assistant/invoke") => c("Run a plugin tool", Outward),
        ("POST", "/v1/downloads/plugin") => c("Download through a plugin", Outward),
        ("DELETE", "/v1/downloads/plugin") => c("Cancel a plugin download", Write),
        ("POST", "/v1/tracks/{id}/download") => c("Download a track", Outward),
        ("POST", "/v1/images/{kind}") => c("Fetch an image", Outward),
        ("POST", "/v1/extensions/check-updates") => c("Check for extension updates", Outward),
        ("POST", "/v1/extensions/{id}/install") => c("Install an extension", Write),
        ("POST", "/v1/home/play") => c("Play a Home item", Write),
        // Writes.
        ("POST", "/v1/playlists") => c("Create a playlist", Write),
        ("POST", "/v1/playlists/{id}/tracks") => c("Add to a playlist", Write),
        ("DELETE", "/v1/playlists/{id}/tracks") => c("Remove from a playlist", Write),
        ("PUT", "/v1/playlists/{id}/order") => c("Reorder a playlist", Write),
        ("POST", "/v1/playlists/{id}/play") => c("Play a playlist", Write),
        ("POST", "/v1/playlists/{id}/enqueue") => c("Queue a playlist", Write),
        ("PATCH", "/v1/playlists/{id}") => c("Rename a playlist", Write),
        ("POST", "/v1/collections/{id}/rescan") => c("Rescan a collection", Write),
        ("POST", "/v1/history/rename") => c("Rename history", Write),
        ("POST", "/v1/logs") => c("Change logging", Write),
        ("PUT", "/v1/cues") => c("Save a cue sheet", Write),
        ("DELETE", "/v1/cues") => c("Delete a cue sheet", Write),
        ("POST", "/v1/queue/play-search") => c("Play a search", Write),
        ("POST", "/v1/queue/play") => c("Play tracks", Write),
        ("POST", "/v1/queue/tracks") => c("Add to the queue", Write),
        ("DELETE", "/v1/queue/tracks") => c("Remove from the queue", Write),
        ("POST", "/v1/queue/clear") => c("Clear the queue", Write),
        ("POST", "/v1/queue/jump") => c("Jump in the queue", Write),
        ("POST", "/v1/queue/randomize") => c("Shuffle the queue", Write),
        ("POST", "/v1/playback") => c("Control playback", Write),
        ("POST", "/v1/radio") => c("Start a radio", Write),
        ("POST", "/v1/likes") => c("Change a like", Write),
        ("POST", "/v1/tracks/{id}/tags") => c("Edit tags", Write),
        ("POST", "/v1/tracks/file-tags") => c("Write tags into files", Write),
        ("POST", "/v1/tracks/{id}/lyrics-file") => c("Write a lyrics file", Write),
        ("POST", "/v1/albums/{id}/cover-file") => c("Write a cover image", Write),
        ("POST", "/v1/files/move") => c("Move files", Write),
        ("POST", "/v1/tracks/{id}/replace-file") => c("Replace a track's file", Write),
        ("POST", "/v1/extensions/{id}/enabled") => c("Enable or disable an extension", Write),
        ("POST", "/v1/skins/apply") => c("Apply a skin", Write),
        ("GET", _) | ("HEAD", _) => c("Read", Read),
        _ => c("Change something", Write),
    }
}

/// One step of a request's life, as the webview receives it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    /// Unique per request; the `start` and `end` of one request share it.
    pub id: u64,
    /// `"start"` (writes only — reads announce themselves once, at the end) or `"end"`.
    pub phase: &'static str,
    /// Unix milliseconds when this event was produced.
    pub at_ms: u64,
    pub method: String,
    pub route: String,
    /// Human label; a plugin tool call appends the tool, e.g. `"Run a plugin tool · spotify: push_playlist"`.
    pub label: String,
    pub kind: Kind,
    /// On `end`: `"ok"`, `"failed"` or `"paused"` (refused because the user paused the assistant).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// What the call was asked to do, to what (`assistant_describe::describe`):
    /// "Liked track “So What” – Miles Davis". On both `start` and `end`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// What came back, when it adds something ("added 2, skipped 1 duplicate"). On `end`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn pause_path(app_dir: &Path) -> PathBuf {
    app_dir.join(PAUSE_FILE)
}

/// Re-read on every request. A missing or unreadable dir means "not paused":
/// the marker is something the user *added*, so its absence cannot be a refusal.
pub fn is_paused(app_dir: &Path) -> bool {
    pause_path(app_dir).exists()
}

pub fn set_paused(app_dir: &Path, paused: bool) -> Result<(), String> {
    let path = pause_path(app_dir);
    if paused {
        std::fs::write(&path, b"paused\n").map_err(|e| format!("Failed to write {}: {}", path.display(), e))
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Failed to remove {}: {}", path.display(), e)),
        }
    }
}

/// What a caller is told when it is refused. Names the user's switch, like the
/// scope errors do, so an assistant can relay exactly what to do.
pub const PAUSED_MESSAGE: &str =
    "the assistant is paused — the user paused it in Viboplr (the Pause button on the assistant activity pill, or Settings → AI control). Reads still work; writes resume when they press Resume";

/// For a plugin tool call: append `pluginId: tool` to the label so the pill
/// and the log say *which* tool ran. Anything that isn't a short plain
/// identifier is dropped — the body comes from the caller.
pub fn plugin_tool_label(base: &str, body: &[u8]) -> String {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) else {
        return base.to_string();
    };
    let ident = |s: Option<&str>| {
        s.filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
        .map(str::to_string)
    };
    match (ident(v["pluginId"].as_str()), ident(v["tool"].as_str())) {
        (Some(p), Some(t)) => format!("{base} · {p}: {t}"),
        (Some(p), None) => format!("{base} · {p}"),
        _ => base.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gets_are_reads_and_unknown_non_gets_are_writes() {
        assert_eq!(classify("GET", "/v1/anything").kind, Kind::Read);
        // A route nobody classified is refused while paused, not waved through.
        assert_eq!(classify("POST", "/v1/brand-new").kind, Kind::Write);
        assert_eq!(classify("DELETE", "/v1/brand-new").kind, Kind::Write);
    }

    #[test]
    fn test_read_posts_ui_and_outward_are_told_apart() {
        assert_eq!(classify("POST", "/v1/query").kind, Kind::Read);
        assert_eq!(classify("POST", "/v1/ui/navigate").kind, Kind::Ui);
        assert_eq!(classify("POST", "/v1/assistant/invoke").kind, Kind::Outward);
        assert_eq!(classify("POST", "/v1/likes").kind, Kind::Write);
    }

    #[test]
    fn test_only_writes_and_outward_calls_are_blocked_when_paused() {
        assert!(!Kind::Read.blocked_when_paused());
        assert!(!Kind::Ui.blocked_when_paused());
        assert!(Kind::Write.blocked_when_paused());
        assert!(Kind::Outward.blocked_when_paused());
    }

    #[test]
    fn test_pause_marker_round_trips_and_clearing_twice_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_paused(dir.path()));
        set_paused(dir.path(), true).unwrap();
        assert!(is_paused(dir.path()));
        set_paused(dir.path(), false).unwrap();
        assert!(!is_paused(dir.path()));
        set_paused(dir.path(), false).unwrap();
    }

    #[test]
    fn test_plugin_tool_label_names_the_tool_and_drops_junk() {
        let base = "Run a plugin tool";
        assert_eq!(
            plugin_tool_label(base, br#"{"pluginId":"spotify","tool":"push_playlist"}"#),
            "Run a plugin tool · spotify: push_playlist"
        );
        assert_eq!(
            plugin_tool_label(base, br#"{"pluginId":"spotify","tool":"a b\nc"}"#),
            "Run a plugin tool · spotify"
        );
        assert_eq!(plugin_tool_label(base, b"not json"), base);
    }
}
