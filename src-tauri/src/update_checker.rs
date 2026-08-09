use crate::models::{ExtensionUpdate, UpdateInfo};
use serde::Serialize;
use std::path::Path;
use tauri::Emitter;

fn semver_is_newer(current: &str, remote: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split('.')
            .filter_map(|s| s.parse().ok())
            .collect()
    };
    let c = parse(current);
    let r = parse(remote);
    for i in 0..3 {
        let cv = c.get(i).copied().unwrap_or(0);
        let rv = r.get(i).copied().unwrap_or(0);
        if rv > cv {
            return true;
        }
        if rv < cv {
            return false;
        }
    }
    false
}

fn semver_satisfies(current: &str, required: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split('.')
            .filter_map(|s| s.parse().ok())
            .collect()
    };
    let c = parse(current);
    let r = parse(required);
    for i in 0..3 {
        let cv = c.get(i).copied().unwrap_or(0);
        let rv = r.get(i).copied().unwrap_or(0);
        if cv > rv {
            return true;
        }
        if cv < rv {
            return false;
        }
    }
    true
}

#[derive(Debug, Clone)]
pub struct InstalledExtension {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub version: String,
    pub update_url: String,
}

/// Per-manifest ceiling. A missing timeout here meant one unreachable host
/// could stall the whole update check indefinitely.
const MANIFEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

pub fn fetch_update_info(url: &str) -> Result<UpdateInfo, String> {
    let resp = reqwest::blocking::Client::builder()
        .user_agent("Viboplr")
        .timeout(MANIFEST_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?
        .get(url)
        .send()
        .map_err(|e| format!("HTTP error: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let text = resp.text().map_err(|e| format!("Read error: {}", e))?;
    serde_json::from_str(&text).map_err(|e| format!("Parse error: {}", e))
}

/// `Ok(None)` = definitively no update. `Err` = we couldn't find out.
///
/// These were the same value before (`Err(_) => return None`), which is why a
/// network outage reported "All your extensions are up to date" — the one
/// answer the check had no evidence for.
pub fn check_extension(
    ext: &InstalledExtension,
    app_version: &str,
) -> Result<Option<ExtensionUpdate>, String> {
    let info = fetch_update_info(&ext.update_url)?;

    if !semver_is_newer(&ext.version, &info.version) {
        return Ok(None);
    }

    let status = if let Some(ref min_ver) = info.min_app_version {
        if semver_satisfies(app_version, min_ver) {
            "available".to_string()
        } else {
            "requires_app_update".to_string()
        }
    } else {
        "available".to_string()
    };

    Ok(Some(ExtensionUpdate {
        id: ext.id.clone(),
        kind: ext.kind.clone(),
        name: ext.name.clone(),
        current_version: ext.version.clone(),
        latest_version: info.version.clone(),
        changelog: info.changelog.unwrap_or_default(),
        download_url: info.file,
        status,
        min_app_version: info.min_app_version,
    }))
}

/// Resolve a plugin's updateUrl to its downloadable zip URL, enforcing
/// minAppVersion. Used by gallery install (install-from-own-repo). Returns the
/// zip `file` URL on success, or a human-readable error (e.g. requires newer app).
pub fn resolve_install_zip_url(update_url: &str, app_version: &str) -> Result<String, String> {
    let info = fetch_update_info(update_url)?;
    if let Some(ref min_ver) = info.min_app_version {
        if !semver_satisfies(app_version, min_ver) {
            return Err(format!(
                "This plugin requires app version {} or newer (you have {}).",
                min_ver, app_version
            ));
        }
    }
    Ok(info.file)
}

pub fn collect_installed_extensions(
    app_dir: &Path,
    native_plugins_dir: &Path,
) -> Vec<InstalledExtension> {
    let mut extensions = Vec::new();

    let user_plugins = crate::plugins::plugins_dir(app_dir);
    let mut seen_plugin_ids = std::collections::HashSet::new();

    for dir in &[&user_plugins, &native_plugins_dir.to_path_buf()] {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let manifest_path = path.join("manifest.json");
                if !manifest_path.exists() {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(&manifest_path) {
                    if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&content) {
                        let id = manifest["id"].as_str().unwrap_or_default().to_string();
                        if id.is_empty() || seen_plugin_ids.contains(&id) {
                            continue;
                        }
                        let update_url = manifest["updateUrl"].as_str().unwrap_or_default().to_string();
                        if update_url.is_empty() {
                            seen_plugin_ids.insert(id);
                            continue;
                        }
                        let name = manifest["name"].as_str().unwrap_or(&id).to_string();
                        let version = manifest["version"].as_str().unwrap_or("0.0.0").to_string();
                        seen_plugin_ids.insert(id.clone());
                        extensions.push(InstalledExtension {
                            id,
                            kind: "plugin".to_string(),
                            name,
                            version,
                            update_url,
                        });
                    }
                }
            }
        }
    }

    let skins_dir = crate::skins::skins_dir(app_dir);
    if let Ok(entries) = std::fs::read_dir(&skins_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(skin) = serde_json::from_str::<serde_json::Value>(&content) {
                    let update_url = skin["updateUrl"].as_str().unwrap_or_default().to_string();
                    if update_url.is_empty() {
                        continue;
                    }
                    let id = path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let name = skin["name"].as_str().unwrap_or(&id).to_string();
                    let version = skin["version"].as_str().unwrap_or("0.0.0").to_string();
                    extensions.push(InstalledExtension {
                        id,
                        kind: "skin".to_string(),
                        name,
                        version,
                        update_url,
                    });
                }
            }
        }
    }

    extensions
}

/// How many manifests are fetched at once. These are release-asset URLs, not
/// GitHub API calls, so they aren't subject to the 60/hr limit — the old
/// serial loop's 200 ms sleep between each was buying nothing and cost
/// `n × 200 ms` of pure latency on top of `n` sequential round-trips.
const CHECK_CONCURRENCY: usize = 5;

/// Outcome of a full check. `failed` exists so "we couldn't reach these" can be
/// told apart from "these are up to date" — see `check_extension`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckReport {
    pub updates: Vec<ExtensionUpdate>,
    /// Display names of extensions whose check failed.
    pub failed: Vec<String>,
}

pub fn check_all_updates(
    app_dir: &Path,
    native_plugins_dir: &Path,
    app_version: &str,
) -> UpdateCheckReport {
    let extensions = collect_installed_extensions(app_dir, native_plugins_dir);
    let mut report = UpdateCheckReport::default();

    for chunk in extensions.chunks(CHECK_CONCURRENCY) {
        // Scoped threads so the borrowed `ext` / `app_version` need no cloning
        // and every thread is joined before the chunk ends.
        let results = std::thread::scope(|s| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|ext| s.spawn(move || (ext, check_extension(ext, app_version))))
                .collect();
            handles
                .into_iter()
                .map(|h| h.join())
                .collect::<Vec<_>>()
        });

        for result in results {
            match result {
                Ok((_, Ok(Some(update)))) => report.updates.push(update),
                Ok((_, Ok(None))) => {}
                Ok((ext, Err(e))) => {
                    log::warn!("update check failed for {}: {}", ext.id, e);
                    report.failed.push(ext.name.clone());
                }
                // A panicked check is still a check we don't have an answer for.
                Err(_) => log::warn!("update check thread panicked"),
            }
        }
    }

    report
}

pub fn spawn_update_checker(
    app_handle: tauri::AppHandle,
    app_dir: std::path::PathBuf,
    native_plugins_dir: std::path::PathBuf,
    app_version: String,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    std::thread::spawn(move || {
        // Initial delay so the first check doesn't compete with startup work —
        // 30s after launch, then daily (matches the dependency auto-updater and
        // the in-app updater).
        std::thread::sleep(std::time::Duration::from_secs(30));
        loop {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }

            let report = check_all_updates(&app_dir, &native_plugins_dir, &app_version);
            // Only the updates are broadcast — a background check that couldn't
            // reach a host stays silent rather than nagging about the network.
            if !report.updates.is_empty() {
                let _ = app_handle.emit("extensions-updates-available", &report.updates);
            }

            for _ in 0..(24 * 60 * 2) {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs(30));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A check that can't reach its host must not be reported as "up to date".
    /// `check_extension` returned `Option` before, collapsing "no update" and
    /// "couldn't tell" into the same `None` — which is how a network outage
    /// came out as "All your extensions are up to date."
    ///
    /// Uses an unparseable URL rather than an unroutable address so the failure
    /// is immediate: a real dead host would sit out the 15s `MANIFEST_TIMEOUT`
    /// and make the whole suite that much slower for no extra coverage.
    #[test]
    fn test_unfetchable_manifest_is_an_error_not_no_update() {
        let ext = InstalledExtension {
            id: "example".into(),
            kind: "plugin".into(),
            name: "Example".into(),
            version: "1.0.0".into(),
            update_url: "not-a-valid-url".into(),
        };
        let result = check_extension(&ext, "1.0.0");
        assert!(result.is_err(), "a failed fetch must surface as Err, got {result:?}");
    }

    /// The report keeps the two apart so the UI can word them differently.
    #[test]
    fn test_report_separates_updates_from_failures() {
        let report = UpdateCheckReport {
            updates: Vec::new(),
            failed: vec!["Example".into()],
        };
        assert!(report.updates.is_empty());
        assert_eq!(report.failed, vec!["Example".to_string()]);
    }

    #[test]
    fn test_semver_is_newer() {
        assert!(semver_is_newer("1.0.0", "1.0.1"));
        assert!(semver_is_newer("1.0.0", "1.1.0"));
        assert!(semver_is_newer("1.0.0", "2.0.0"));
        assert!(!semver_is_newer("1.0.0", "1.0.0"));
        assert!(!semver_is_newer("2.0.0", "1.0.0"));
        assert!(semver_is_newer("1.0.0", "1.0.1"));
        assert!(!semver_is_newer("1.1.0", "1.0.1"));
    }

    #[test]
    fn test_semver_satisfies() {
        assert!(semver_satisfies("1.0.0", "1.0.0"));
        assert!(semver_satisfies("1.1.0", "1.0.0"));
        assert!(semver_satisfies("2.0.0", "1.0.0"));
        assert!(!semver_satisfies("0.9.0", "1.0.0"));
        assert!(!semver_satisfies("1.0.0", "1.0.1"));
    }

    #[test]
    fn test_collect_installed_extensions_empty_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let native = tempfile::tempdir().unwrap();
        let exts = collect_installed_extensions(tmp.path(), native.path());
        assert!(exts.is_empty());
    }

    #[test]
    fn test_collect_installed_extensions_with_update_url() {
        let tmp = tempfile::tempdir().unwrap();
        let native = tempfile::tempdir().unwrap();

        let plugin_dir = crate::plugins::plugins_dir(tmp.path()).join("test-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("manifest.json"),
            r#"{"id":"test-plugin","name":"Test","version":"1.0.0","updateUrl":"https://example.com/update.json"}"#,
        ).unwrap();

        let plugin2_dir = crate::plugins::plugins_dir(tmp.path()).join("no-update");
        std::fs::create_dir_all(&plugin2_dir).unwrap();
        std::fs::write(
            plugin2_dir.join("manifest.json"),
            r#"{"id":"no-update","name":"No Update","version":"1.0.0"}"#,
        ).unwrap();

        let exts = collect_installed_extensions(tmp.path(), native.path());
        assert_eq!(exts.len(), 1);
        assert_eq!(exts[0].id, "test-plugin");
        assert_eq!(exts[0].update_url, "https://example.com/update.json");
    }
}
