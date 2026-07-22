// Publish-to-server (Bandstatic) commands. See commands/mod.rs for shared
// types & helpers, publish_server.rs for the HTTP client, and
// db/publish_servers.rs for credential storage.

use super::*;
use crate::publish_server;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPublishServerResult {
    pub id: i64,
    pub slug: String,
    pub display_name: String,
}

/// Validate a server URL + token via whoami (token validity + API version),
/// then store the server with the artist slug the server reports.
#[tauri::command]
pub fn add_publish_server(
    state: State<'_, AppState>,
    name: String,
    url: String,
    token: String,
) -> Result<AddPublishServerResult, String> {
    let base = publish_server::normalize_base_url(&url);
    let who = publish_server::whoami(&base, &token)?;
    let id = state
        .db
        .add_publish_server(&name, &base, &token, &who.slug)
        .map_err(|e| format!("Failed to save publish server: {}", e))?;
    Ok(AddPublishServerResult {
        id,
        slug: who.slug,
        display_name: who.display_name,
    })
}

/// List stored publish servers. Tokens are never included — the
/// `PublishServer` struct has no token field by design.
#[tauri::command]
pub fn list_publish_servers(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::publish_servers::PublishServer>, String> {
    state
        .db
        .list_publish_servers()
        .map_err(|e| format!("Failed to list publish servers: {}", e))
}

#[tauri::command]
pub fn remove_publish_server(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state
        .db
        .remove_publish_server(id)
        .map_err(|e| format!("Failed to remove publish server: {}", e))
}

/// Push a track selection (or a whole collection) to a stored Bandstatic
/// server as a staged batch session. Returns immediately; the worker thread
/// emits `publish-server-progress` per track, then a terminal
/// `publish-server-complete` (with per-track outcomes, the skipped list, and
/// the public/manifest/deep-link URLs) or `publish-server-error`.
#[tauri::command]
pub fn publish_to_server(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: i64,
    track_ids: Option<Vec<i64>>,
    collection_id: Option<i64>,
) -> Result<(), String> {
    let (tracks, skipped) = resolve_publish_tracks(&state, track_ids, collection_id)?;

    let (url, token, slug) = state
        .db
        .get_publish_server_token(server_id)
        .map_err(|e| format!("Failed to load publish server: {}", e))?
        .ok_or_else(|| format!("Publish server {} not found", server_id))?;

    // Fresh cancel flag for this batch.
    state.publish_cancel.store(false, Ordering::SeqCst);
    let cancel = state.publish_cancel.clone();

    thread::spawn(move || {
        let progress_app = app.clone();
        let result = publish_server::publish_tracks(
            &url,
            &token,
            &tracks,
            &cancel,
            |i, total, title| {
                // 1-based `current` for display, matching the other progress events.
                let _ = progress_app.emit(
                    "publish-server-progress",
                    serde_json::json!({
                        "current": i + 1,
                        "total": total,
                        "title": title,
                    }),
                );
            },
        );

        match result {
            Ok(res) => {
                let base = publish_server::normalize_base_url(&url);
                let public_url = format!("{}/{}/", base, slug);
                let manifest_url = format!("{}/{}/manifest.json", base, slug);
                let deep_link = format!(
                    "viboplr://add-collection?kind=manifest&url={}",
                    crate::music_publish::percent_encode(&manifest_url)
                );
                let _ = app.emit(
                    "publish-server-complete",
                    serde_json::json!({
                        "outcomes": res.outcomes,
                        "skipped": skipped,
                        "publicUrl": public_url,
                        "manifestUrl": manifest_url,
                        "deepLink": deep_link,
                        "committedCreated": res.committed_created,
                        "committedReplaced": res.committed_replaced,
                        "abortedReason": res.aborted_reason,
                    }),
                );
            }
            Err(e) => {
                log::error!("Publish to server {} failed: {}", server_id, e);
                let _ = app.emit(
                    "publish-server-error",
                    serde_json::json!({ "message": e }),
                );
            }
        }
    });

    Ok(())
}

/// Cancel the in-flight publish batch: the worker checks the flag before each
/// upload, aborts the server session, and reports via `publish-server-error`.
#[tauri::command]
pub fn cancel_publish_to_server(state: State<'_, AppState>) -> Result<(), String> {
    state.publish_cancel.store(true, Ordering::SeqCst);
    Ok(())
}
