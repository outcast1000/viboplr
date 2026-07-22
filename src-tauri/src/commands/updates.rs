//! App self-update commands — channel-aware (stable / beta).
//!
//! Stable channel: the config-baked endpoints (`releases/latest/download/…`),
//! which GitHub resolves to the newest NON-prerelease release — beta builds
//! are invisible there by construction (hyphenated tags publish as
//! prereleases; see release.yml).
//!
//! Beta channel: there is no static "latest including prereleases" URL, so
//! the newest release (stable or beta — whichever is most recent) is
//! discovered via the GitHub releases API and its updater manifest is fed to
//! the updater at runtime. A beta user therefore also receives the next
//! stable the moment it ships. On any discovery failure the check falls back
//! to the stable channel so beta subscribers are never stranded.
//!
//! The check/install flow lives in Rust (the JS updater plugin can't override
//! endpoints); the frontend drives it via `app_update_check` /
//! `app_update_install` and the `app-update-progress` event.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

const REPO: &str = "outcast1000/viboplr";

/// Which updater manifest this build consumes. There is a single build flavor
/// now (the native engine is bundled), so every build is on the one channel.
fn manifest_asset_name() -> &'static str {
    "latest.json"
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    draft: bool,
    assets: Vec<GhAsset>,
}

/// Newest release (GitHub returns creation-order, newest first) that isn't a
/// draft and actually carries this build's updater manifest. Prereleases and
/// stables both qualify — "newest overall" is exactly the beta-channel
/// semantic. Pure for tests.
fn pick_beta_manifest_url(releases: &[GhRelease], asset: &str) -> Option<String> {
    releases
        .iter()
        .find(|r| !r.draft && r.assets.iter().any(|a| a.name == asset))
        .map(|r| format!("https://github.com/{REPO}/releases/download/{}/{}", r.tag_name, asset))
}

async fn discover_beta_endpoint() -> Result<String, String> {
    let releases: Vec<GhRelease> = reqwest::Client::new()
        .get(format!("https://api.github.com/repos/{REPO}/releases?per_page=20"))
        .header("User-Agent", "viboplr-updater")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GitHub releases request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GitHub releases request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("GitHub releases parse failed: {e}"))?;
    pick_beta_manifest_url(&releases, manifest_asset_name())
        .ok_or_else(|| "no release carries this build's updater manifest".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateMeta {
    pub version: String,
    pub body: Option<String>,
}

#[tauri::command]
pub async fn app_update_check(
    app: AppHandle,
    state: State<'_, super::AppState>,
    channel: String,
) -> Result<Option<AppUpdateMeta>, String> {
    let updater = if channel == "beta" {
        match discover_beta_endpoint().await {
            Ok(url) => {
                log::info!("app-update: beta channel endpoint {url}");
                let url = url.parse().map_err(|e| format!("bad beta endpoint: {e}"))?;
                app.updater_builder()
                    .endpoints(vec![url])
                    .map_err(|e| e.to_string())?
                    .build()
                    .map_err(|e| e.to_string())?
            }
            Err(e) => {
                // Fail open to stable so beta subscribers are never stranded.
                log::error!("app-update: beta discovery failed ({e}); falling back to stable");
                app.updater().map_err(|e| e.to_string())?
            }
        }
    } else {
        app.updater().map_err(|e| e.to_string())?
    };

    let update = updater.check().await.map_err(|e| e.to_string())?;
    let meta = update.as_ref().map(|u| AppUpdateMeta {
        version: u.version.clone(),
        body: u.body.clone(),
    });
    *state.pending_app_update.lock().await = update;
    Ok(meta)
}

/// Download + install the update found by the last `app_update_check`.
/// Progress streams via the `app-update-progress` event; the frontend
/// relaunches on success (same contract as the old JS-plugin flow).
#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    state: State<'_, super::AppState>,
) -> Result<(), String> {
    let update = state
        .pending_app_update
        .lock()
        .await
        .take()
        .ok_or("no pending update — run app_update_check first")?;
    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit(
                    "app-update-progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, draft: bool, assets: &[&str]) -> GhRelease {
        GhRelease {
            tag_name: tag.into(),
            draft,
            assets: assets.iter().map(|n| GhAsset { name: (*n).into() }).collect(),
        }
    }

    #[test]
    fn test_picks_newest_release_with_manifest() {
        let releases = vec![
            release("v0.9.152-beta.1", false, &["latest.json", "latest-mpv.json"]),
            release("v0.9.151", false, &["latest.json"]),
        ];
        assert_eq!(
            pick_beta_manifest_url(&releases, "latest.json").as_deref(),
            Some("https://github.com/outcast1000/viboplr/releases/download/v0.9.152-beta.1/latest.json")
        );
    }

    #[test]
    fn test_newer_stable_wins_over_older_beta() {
        // GitHub order = newest first: a stable published after a beta comes first,
        // so beta subscribers are moved back onto stable.
        let releases = vec![
            release("v0.9.152", false, &["latest.json"]),
            release("v0.9.152-beta.1", false, &["latest.json"]),
        ];
        assert_eq!(
            pick_beta_manifest_url(&releases, "latest.json").as_deref(),
            Some("https://github.com/outcast1000/viboplr/releases/download/v0.9.152/latest.json")
        );
    }

    #[test]
    fn test_skips_drafts_and_releases_missing_this_builds_manifest() {
        let releases = vec![
            release("v0.9.153-beta.1", true, &["latest.json", "latest-mpv.json"]),
            release("v0.9.152-beta.1", false, &["latest.json"]), // lean-only upload
            release("v0.9.151", false, &["latest.json", "latest-mpv.json"]),
        ];
        assert_eq!(
            pick_beta_manifest_url(&releases, "latest-mpv.json").as_deref(),
            Some("https://github.com/outcast1000/viboplr/releases/download/v0.9.151/latest-mpv.json")
        );
    }

    #[test]
    fn test_none_when_no_release_qualifies() {
        let releases = vec![release("v0.9.150", false, &["Viboplr.dmg"])];
        assert_eq!(pick_beta_manifest_url(&releases, "latest.json"), None);
    }
}
