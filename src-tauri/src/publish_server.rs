// Client for the Bandstatic upload API (publish-to-server). Wire contract v1
// (frozen server-side):
//
//   GET  {base}/api/v1/whoami                       -> artist identity + api_versions
//   POST {base}/api/v1/sessions                     -> 201 { session_id }
//   POST {base}/api/v1/sessions/{id}/tracks         -> multipart: "file" (+ "title"/"album")
//   POST {base}/api/v1/sessions/{id}/commit         -> { created: [..], replaced: [..] }
//   POST {base}/api/v1/sessions/{id}/abort          -> { ok: true }
//
// Auth: `Authorization: Bearer bst_<hex>` on every call. TLS verification
// stays ON — no danger_accept_invalid_certs, ever.
//
// Failure policy (mirrors R17's "per-track failure != batch failure"):
//   - 401 on any upload  -> token revoked: abort remaining tracks, return Ok
//     with the rest marked "aborted" and `aborted_reason` set (commit never sent).
//   - 413/507/other non-2xx/network error on ONE upload -> record a "rejected"
//     outcome for that track and continue with the next.
//   - Network error on begin/commit -> hard Err (nothing committed).
//   - Cancel (checked before each upload) -> abort session, Err("cancelled").

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::music_publish::PublishTrack;

/// Identity returned by the server's whoami endpoint (already version-checked).
#[derive(Debug, Clone)]
pub struct WhoAmI {
    pub slug: String,
    pub display_name: String,
    pub api_versions: Vec<String>,
}

/// Per-track upload outcome, surfaced verbatim to the frontend.
/// `status` is one of the server's "created" | "replaced" | "duplicate" |
/// "rejected", or the client-side "aborted" (token revoked mid-batch).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutcome {
    pub title: String,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub outcomes: Vec<PublishOutcome>,
    pub committed_created: usize,
    pub committed_replaced: usize,
    /// Set when the batch was aborted mid-flight (token revoked); the
    /// remaining tracks carry status "aborted" and nothing was committed.
    pub aborted_reason: Option<String>,
}

// --- wire shapes (private) ---

#[derive(Deserialize)]
struct WhoAmIWire {
    slug: String,
    display_name: String,
    server: WhoAmIServerWire,
}

#[derive(Deserialize)]
struct WhoAmIServerWire {
    #[serde(default)]
    api_versions: Vec<String>,
}

#[derive(Deserialize)]
struct SessionWire {
    session_id: String,
}

#[derive(Deserialize)]
struct UploadOutcomeWire {
    status: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
struct CommitWire {
    #[serde(default)]
    created: Vec<serde_json::Value>,
    #[serde(default)]
    replaced: Vec<serde_json::Value>,
}

// --- pure helpers (unit-tested) ---

/// Normalize a user-entered base URL: trim whitespace and trailing slashes so
/// path joins never double a '/'.
pub(crate) fn normalize_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Build an API endpoint URL from an already-normalized base.
fn api_url(base: &str, path: &str) -> String {
    format!("{}/api/v1/{}", base, path)
}

fn parse_whoami(body: &str) -> Result<WhoAmI, String> {
    let wire: WhoAmIWire = serde_json::from_str(body)
        .map_err(|e| format!("Server returned an unexpected whoami response: {}", e))?;
    Ok(WhoAmI {
        slug: wire.slug,
        display_name: wire.display_name,
        api_versions: wire.server.api_versions,
    })
}

fn check_api_version(who: &WhoAmI) -> Result<(), String> {
    if who.api_versions.iter().any(|v| v == "v1") {
        Ok(())
    } else {
        Err(format!(
            "This server requires a newer Viboplr (unsupported API versions: {})",
            who.api_versions.join(", ")
        ))
    }
}

// --- HTTP clients (per-call, timeouts per call class) ---

/// Client for control calls (whoami, begin/commit/abort): 30s timeout.
fn control_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Viboplr")
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))
}

/// Client for track uploads: 120s timeout (big files).
fn upload_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent("Viboplr")
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))
}

// --- public API ---

/// Validate a server URL + token pair: GET whoami, check the token is
/// accepted and the server speaks API v1. Returns the artist identity.
pub fn whoami(base_url: &str, token: &str) -> Result<WhoAmI, String> {
    let base = normalize_base_url(base_url);
    if base.is_empty() {
        return Err("A server URL is required".to_string());
    }
    let client = control_client()?;
    let resp = client
        .get(api_url(&base, "whoami"))
        .bearer_auth(token)
        .send()
        .map_err(|e| format!("Couldn't reach {}: {}", base, e))?;
    let status = resp.status();
    if status.as_u16() == 401 {
        return Err("Server rejected the token (HTTP 401) — check that it is valid and not revoked".to_string());
    }
    if !status.is_success() {
        return Err(format!("Server whoami returned HTTP {}", status));
    }
    let body = resp
        .text()
        .map_err(|e| format!("Failed to read whoami response: {}", e))?;
    let who = parse_whoami(&body)?;
    check_api_version(&who)?;
    Ok(who)
}

enum UploadError {
    /// HTTP 401 — the token was revoked mid-batch; the whole publish aborts.
    Revoked,
    /// Anything else — this track failed, the batch continues.
    PerTrack(String),
}

fn begin_session(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
) -> Result<String, String> {
    let resp = client
        .post(api_url(base, "sessions"))
        .bearer_auth(token)
        .send()
        .map_err(|e| format!("Couldn't open a publish session on {}: {}", base, e))?;
    match resp.status().as_u16() {
        401 => Err("Server rejected the token (HTTP 401) — check that it is valid and not revoked".to_string()),
        429 => Err("Server has too many publish sessions open (HTTP 429) — try again in a few minutes".to_string()),
        s if !(200..300).contains(&s) => Err(format!("Opening a publish session returned HTTP {}", s)),
        _ => {
            let wire: SessionWire = resp
                .json()
                .map_err(|e| format!("Server returned an unexpected session response: {}", e))?;
            Ok(wire.session_id)
        }
    }
}

fn upload_track(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    session_id: &str,
    track: &PublishTrack,
) -> Result<PublishOutcome, UploadError> {
    // Multipart part "file" carries bytes + filename; "title"/"album" text
    // parts are metadata overrides (the server prefers them over embedded tags,
    // which covers tag-less files). Title is always sent; album when present.
    let mut form = reqwest::blocking::multipart::Form::new()
        .file("file", &track.src_path)
        .map_err(|e| UploadError::PerTrack(format!("Couldn't read {}: {}", track.src_path, e)))?
        .text("title", track.title.clone());
    if let Some(album) = track.album.as_ref().filter(|a| !a.is_empty()) {
        form = form.text("album", album.clone());
    }

    let resp = client
        .post(api_url(base, &format!("sessions/{}/tracks", session_id)))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .map_err(|e| UploadError::PerTrack(format!("Upload failed: {}", e)))?;

    match resp.status().as_u16() {
        401 => Err(UploadError::Revoked),
        403 => Err(UploadError::PerTrack("Server refused the publish session (HTTP 403)".to_string())),
        413 => Err(UploadError::PerTrack("File too large or over the storage quota (HTTP 413)".to_string())),
        507 => Err(UploadError::PerTrack("Server is out of disk space (HTTP 507)".to_string())),
        s if !(200..300).contains(&s) => Err(UploadError::PerTrack(format!("Upload returned HTTP {}", s))),
        _ => {
            let wire: UploadOutcomeWire = resp
                .json()
                .map_err(|e| UploadError::PerTrack(format!("Server returned an unexpected upload response: {}", e)))?;
            Ok(PublishOutcome {
                title: wire.title.unwrap_or_else(|| track.title.clone()),
                status: wire.status,
                reason: wire.reason,
            })
        }
    }
}

fn commit_session(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    session_id: &str,
) -> Result<(usize, usize), String> {
    let resp = client
        .post(api_url(base, &format!("sessions/{}/commit", session_id)))
        .bearer_auth(token)
        .send()
        .map_err(|e| format!("Couldn't commit the publish session: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Committing the publish session returned HTTP {}", status));
    }
    let wire: CommitWire = resp
        .json()
        .map_err(|e| format!("Server returned an unexpected commit response: {}", e))?;
    Ok((wire.created.len(), wire.replaced.len()))
}

/// Best-effort session abort (cancel / token-revoked cleanup). Failure is
/// logged, not surfaced — the server expires stale sessions on its own.
fn abort_session(client: &reqwest::blocking::Client, base: &str, token: &str, session_id: &str) {
    match client
        .post(api_url(base, &format!("sessions/{}/abort", session_id)))
        .bearer_auth(token)
        .send()
    {
        Ok(resp) if !resp.status().is_success() => {
            log::warn!("Publish session abort returned HTTP {}", resp.status());
        }
        Err(e) => log::warn!("Failed to abort publish session: {}", e),
        Ok(_) => {}
    }
}

/// Run a staged batch publish: begin session -> upload each track -> commit.
/// `progress(i, total, title)` fires before each upload (0-based index);
/// `cancel` is checked before each upload — on cancel the session is aborted
/// and `Err("cancelled")` is returned (commit is never sent).
pub fn publish_tracks(
    base_url: &str,
    token: &str,
    tracks: &[PublishTrack],
    cancel: &AtomicBool,
    mut progress: impl FnMut(usize, usize, &str),
) -> Result<PublishResult, String> {
    let base = normalize_base_url(base_url);
    if base.is_empty() {
        return Err("A server URL is required".to_string());
    }
    let total = tracks.len();
    let control = control_client()?;
    let uploader = upload_client()?;

    let session_id = begin_session(&control, &base, token)?;

    let mut outcomes: Vec<PublishOutcome> = Vec::with_capacity(total);
    for (i, track) in tracks.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            abort_session(&control, &base, token, &session_id);
            return Err("cancelled".to_string());
        }
        progress(i, total, &track.title);

        match upload_track(&uploader, &base, token, &session_id, track) {
            Ok(outcome) => outcomes.push(outcome),
            Err(UploadError::Revoked) => {
                // Token revoked mid-batch: mark this and every remaining track
                // "aborted", best-effort abort the session, and return the
                // partial outcomes — nothing is committed.
                for rest in &tracks[i..] {
                    outcomes.push(PublishOutcome {
                        title: rest.title.clone(),
                        status: "aborted".to_string(),
                        reason: Some("token revoked".to_string()),
                    });
                }
                abort_session(&control, &base, token, &session_id);
                return Ok(PublishResult {
                    outcomes,
                    committed_created: 0,
                    committed_replaced: 0,
                    aborted_reason: Some("token was revoked — publish aborted".to_string()),
                });
            }
            Err(UploadError::PerTrack(reason)) => {
                // One track failing (413/507/network/…) never fails the batch.
                log::warn!("Publish upload failed for '{}': {}", track.title, reason);
                outcomes.push(PublishOutcome {
                    title: track.title.clone(),
                    status: "rejected".to_string(),
                    reason: Some(reason),
                });
            }
        }
    }

    let (committed_created, committed_replaced) = commit_session(&control, &base, token, &session_id)?;
    Ok(PublishResult {
        outcomes,
        committed_created,
        committed_replaced,
        aborted_reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_base_url() {
        assert_eq!(normalize_base_url("https://music.example.com/"), "https://music.example.com");
        assert_eq!(normalize_base_url("  https://music.example.com//  "), "https://music.example.com");
        assert_eq!(normalize_base_url("https://music.example.com"), "https://music.example.com");
        assert_eq!(normalize_base_url("   "), "");
    }

    #[test]
    fn test_api_url_building() {
        let base = normalize_base_url("https://music.example.com/");
        assert_eq!(api_url(&base, "whoami"), "https://music.example.com/api/v1/whoami");
        assert_eq!(api_url(&base, "sessions"), "https://music.example.com/api/v1/sessions");
        assert_eq!(
            api_url(&base, &format!("sessions/{}/tracks", "abc-123")),
            "https://music.example.com/api/v1/sessions/abc-123/tracks"
        );
        assert_eq!(
            api_url(&base, &format!("sessions/{}/commit", "abc-123")),
            "https://music.example.com/api/v1/sessions/abc-123/commit"
        );
    }

    #[test]
    fn test_parse_whoami_full_fixture() {
        // Exactly the shape Bandstatic emits, extra fields included.
        let body = r#"{
            "artist_id": 7,
            "slug": "maria-callas",
            "display_name": "Maria Callas",
            "scope": "upload",
            "server": { "name": "Bandstatic", "version": "0.1.0", "api_versions": ["v1"] }
        }"#;
        let who = parse_whoami(body).unwrap();
        assert_eq!(who.slug, "maria-callas");
        assert_eq!(who.display_name, "Maria Callas");
        assert_eq!(who.api_versions, vec!["v1".to_string()]);
        assert!(check_api_version(&who).is_ok());
    }

    #[test]
    fn test_parse_whoami_rejects_garbage() {
        let err = parse_whoami("not json").unwrap_err();
        assert!(err.contains("unexpected whoami response"), "got: {}", err);
        // Valid JSON but missing mandatory fields also fails.
        assert!(parse_whoami(r#"{"server": {}}"#).is_err());
    }

    #[test]
    fn test_check_api_version_requires_v1() {
        let who = WhoAmI {
            slug: "s".into(),
            display_name: "S".into(),
            api_versions: vec!["v2".into(), "v3".into()],
        };
        let err = check_api_version(&who).unwrap_err();
        assert!(err.contains("newer Viboplr"), "got: {}", err);
        assert!(err.contains("v2, v3"), "lists the server's versions: {}", err);

        // Empty api_versions (older/misbehaving server) also fails closed.
        let none = WhoAmI { slug: "s".into(), display_name: "S".into(), api_versions: vec![] };
        assert!(check_api_version(&none).is_err());

        // v1 anywhere in the list passes.
        let mixed = WhoAmI { slug: "s".into(), display_name: "S".into(), api_versions: vec!["v2".into(), "v1".into()] };
        assert!(check_api_version(&mixed).is_ok());
    }

    #[test]
    fn test_upload_outcome_wire_parses_all_shapes() {
        let created: UploadOutcomeWire =
            serde_json::from_str(r#"{"status":"created","title":"First Song","provisional_slug":"first-song"}"#).unwrap();
        assert_eq!(created.status, "created");
        assert_eq!(created.title.as_deref(), Some("First Song"));
        assert_eq!(created.reason, None);

        let rejected: UploadOutcomeWire =
            serde_json::from_str(r#"{"status":"rejected","title":"Bad File","reason":"undecodable"}"#).unwrap();
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.reason.as_deref(), Some("undecodable"));
    }

    #[test]
    fn test_commit_wire_counts() {
        let wire: CommitWire = serde_json::from_str(
            r#"{"created":[{"id":1,"slug":"a"},{"id":2,"slug":"b"}],"replaced":[{"id":3,"slug":"c"}]}"#,
        )
        .unwrap();
        assert_eq!(wire.created.len(), 2);
        assert_eq!(wire.replaced.len(), 1);

        let empty: CommitWire = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(empty.created.len(), 0);
        assert_eq!(empty.replaced.len(), 0);
    }
}
