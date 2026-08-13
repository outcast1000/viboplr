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

use crate::error_chain::err_chain;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

const REPO: &str = "outcast1000/viboplr";

/// Ceiling on the manifest fetch. Only the *check* honours it — the plugin
/// hardcodes `timeout: None` onto the `Update` it hands back, so a 50 MB
/// download can't be cut short by it.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

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
    let client = reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| format!("GitHub releases client failed: {}", err_chain(&e)))?;
    let releases: Vec<GhRelease> = client
        .get(format!("https://api.github.com/repos/{REPO}/releases?per_page=20"))
        .header("User-Agent", "viboplr-updater")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GitHub releases request failed: {}", err_chain(&e)))?
        .error_for_status()
        .map_err(|e| format!("GitHub releases request failed: {}", err_chain(&e)))?
        .json()
        .await
        .map_err(|e| format!("GitHub releases parse failed: {}", err_chain(&e)))?;
    pick_beta_manifest_url(&releases, manifest_asset_name())
        .ok_or_else(|| "no release carries this build's updater manifest".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateMeta {
    pub version: String,
    pub body: Option<String>,
}

/// How many times a transient check failure is retried before the user ever
/// sees it — the check's counterpart to `DOWNLOAD_ATTEMPTS`, and for the same
/// reason: `github.com` intermittently answers a *fresh* connection with an
/// HTTP/2 `REFUSED_STREAM` (or closes a keep-alive mid-response) instead of
/// serving the manifest. Measured from one machine: 2/6 to 9/12 requests failed
/// that way, while `api.github.com`, `objects.githubusercontent.com` and every
/// non-GitHub host stayed at 0/6 and `curl` to the same URL stayed at 0/30. It
/// is not the user's connection and not the TLS stack (native-tls failed at the
/// same rate as rustls), it is load-shedding at that one edge — so a single-shot
/// check turned a momentary refusal into a reported failure.
const CHECK_ATTEMPTS: u32 = 3;

/// Check, retrying transient failures. `check()` is a plain GET, so a retry is
/// safe; only the errors `is_transient` admits are retried, exactly as on the
/// download side.
async fn check_with_retry(
    updater: &tauri_plugin_updater::Updater,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    for attempt in 1..=CHECK_ATTEMPTS {
        match updater.check().await {
            Ok(update) => return Ok(update),
            Err(e) => {
                let detail = err_chain(&e);
                if !is_transient(&e) || attempt == CHECK_ATTEMPTS {
                    return Err(detail);
                }
                log::warn!("app-update: check attempt {attempt} failed ({detail}); retrying");
                // 1s then 3s: the manual path has a user watching a spinner, so
                // the whole ladder has to stay inside a few seconds.
                tokio::time::sleep(Duration::from_secs(attempt as u64 * 2 - 1)).await;
            }
        }
    }
    // Unreachable: the final attempt always returns above. Kept as a plain Err
    // rather than `unreachable!()` so a future edit can't turn it into a panic.
    Err("update check failed".to_string())
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
                    .timeout(CHECK_TIMEOUT)
                    .build()
                    .map_err(|e| e.to_string())?
            }
            Err(e) => {
                // Fail open to stable so beta subscribers are never stranded.
                log::error!("app-update: beta discovery failed ({e}); falling back to stable");
                app.updater_builder()
                    .timeout(CHECK_TIMEOUT)
                    .build()
                    .map_err(|e| e.to_string())?
            }
        }
    } else {
        // Builder rather than `app.updater()` purely to carry the timeout; the
        // endpoints still come from the config.
        app.updater_builder()
            .timeout(CHECK_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?
    };

    let update = check_with_retry(&updater).await?;
    let meta = update.as_ref().map(|u| AppUpdateMeta {
        version: u.version.clone(),
        body: u.body.clone(),
    });
    *state.pending_app_update.lock().await = update;
    Ok(meta)
}

/// How many times a transient download failure is retried before the user ever
/// sees it. GitHub's release CDN answers 503 for a window after a release's
/// assets are uploaded, and intermittently under load — that is a
/// wait-and-succeed condition, not something worth surfacing as an error.
const DOWNLOAD_ATTEMPTS: u32 = 3;

/// Transient = worth retrying. A signature or decode failure is deterministic
/// (and, for minisign, a security signal), so it fails on the first attempt
/// instead of being tried three times.
fn is_transient(e: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error;
    matches!(e, Error::Network(_) | Error::Reqwest(_) | Error::Io(_))
}

/// Download (with retries) then install. Split out of the command so the
/// command itself only owns the take/restore of the pending update.
async fn download_and_install(
    app: &AppHandle,
    update: &tauri_plugin_updater::Update,
) -> Result<(), String> {
    for attempt in 1..=DOWNLOAD_ATTEMPTS {
        // Counted per attempt: a carried-over total would run past `total` and
        // drive the frontend's progress bar past 100% on a retry.
        let mut downloaded: u64 = 0;
        let progress_app = app.clone();
        let result = update
            .download(
                move |chunk, total| {
                    downloaded += chunk as u64;
                    let _ = progress_app.emit(
                        "app-update-progress",
                        serde_json::json!({ "downloaded": downloaded, "total": total }),
                    );
                },
                || {},
            )
            .await;

        match result {
            Ok(bytes) => return update.install(bytes).map_err(|e| err_chain(&e)),
            Err(e) => {
                let detail = err_chain(&e);
                if !is_transient(&e) || attempt == DOWNLOAD_ATTEMPTS {
                    return Err(detail);
                }
                log::warn!("app-update: download attempt {attempt} failed ({detail}); retrying");
                tokio::time::sleep(Duration::from_secs(2 * attempt as u64)).await;
            }
        }
    }
    // Unreachable: the final attempt always returns above. Kept as a plain Err
    // rather than `unreachable!()` so a future edit can't turn it into a panic.
    Err("update download failed".to_string())
}

/// Download + install the update found by the last `app_update_check`.
/// Progress streams via the `app-update-progress` event; the frontend
/// relaunches on success (same contract as the old JS-plugin flow).
#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    state: State<'_, super::AppState>,
) -> Result<(), String> {
    // Taken rather than borrowed so a concurrent `app_update_check` isn't
    // blocked behind a 50 MB download.
    let update = state
        .pending_app_update
        .lock()
        .await
        .take()
        .ok_or("no pending update — run app_update_check first")?;

    let result = download_and_install(&app, &update).await;

    if result.is_err() {
        // A retry needs something to retry. Dropping the pending update on
        // failure made the frontend's "Try again" fail with "no pending
        // update" until the user manually re-ran the check.
        *state.pending_app_update.lock().await = Some(update);
    }
    result
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
