use crate::error_chain::err_chain;
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

/// How many times a manifest fetch is retried before the extension is reported
/// as unreachable — the extension checker's counterpart to the app updater's
/// `CHECK_ATTEMPTS`, and the same failure: every gallery `updateUrl` is a
/// `github.com` release asset, and that host intermittently refuses a fresh
/// connection's HTTP/2 stream (`REFUSED_STREAM`) or closes a keep-alive
/// mid-response instead of serving the file. Measured at 2/6–9/12 requests from
/// one machine while every other host answered cleanly, so a single-shot fetch
/// reported extensions as unreachable that were merely unlucky.
const FETCH_ATTEMPTS: u32 = 3;

/// A failed fetch, plus whether it is worth another attempt.
struct FetchFailure {
    text: String,
    transient: bool,
}

/// Retried only when the failure came back *fast*.
///
/// A timeout has already spent `MANIFEST_TIMEOUT`, and this runs once per
/// installed extension — tripling a blackholed host's 15s wait would turn one
/// dead `updateUrl` into a 45s check, which is a worse bug than the one being
/// fixed. A malformed URL is deterministic and must not be retried either. The
/// refusal this retry exists for comes back in about a second.
fn error_is_fast_transient(e: &reqwest::Error) -> bool {
    !e.is_builder() && !e.is_timeout()
}

/// Whether an HTTP status is worth another attempt. GitHub's release CDN answers
/// 503 for a window after a release's assets are uploaded, and 429 when it is
/// rate-limiting — both clear on their own. A 404 does not: retrying it would
/// cost every extension with a stale `updateUrl` the full backoff ladder for an
/// answer that will not change.
fn status_is_transient(status: u16) -> bool {
    status == 429 || (500..=599).contains(&status)
}

/// Whether attempt `attempt` (1-based) should be followed by another one.
///
/// Extracted from `fetch_update_info`'s loop so the "a deterministic failure is
/// never retried" guarantee can be asserted directly. It used to be checked by
/// timing `check_extension` against a 1s wall-clock bound, which measured the
/// machine rather than the code and duly flaked on a loaded one.
fn should_retry(transient: bool, attempt: u32) -> bool {
    transient && attempt < FETCH_ATTEMPTS
}

/// Backoff before the attempt after `attempt`: 1s then 3s, matching the app
/// updater's ladder — the spacing that was measured to recover from GitHub's
/// refusal. Pure so the ladder's total cost (4s, the figure the retry rules are
/// justified against) is pinned by a test rather than by a comment.
fn retry_backoff(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_secs(attempt as u64 * 2 - 1)
}

fn fetch_update_info_once(url: &str) -> Result<UpdateInfo, FetchFailure> {
    // The client is built per attempt on purpose: a retry that reused a pooled
    // connection to a host that is shedding connections would be asking the same
    // socket the same question.
    let client = reqwest::blocking::Client::builder()
        .user_agent("Viboplr")
        .timeout(MANIFEST_TIMEOUT)
        .build()
        .map_err(|e| FetchFailure {
            text: format!("HTTP client error: {}", err_chain(&e)),
            transient: false,
        })?;
    let resp = client.get(url).send().map_err(|e| FetchFailure {
        text: format!("HTTP error: {}", err_chain(&e)),
        transient: error_is_fast_transient(&e),
    })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(FetchFailure {
            text: format!("HTTP {status}"),
            transient: status_is_transient(status.as_u16()),
        });
    }
    // A body that dies mid-read is the same class as a refused stream.
    let text = resp.text().map_err(|e| FetchFailure {
        text: format!("Read error: {}", err_chain(&e)),
        transient: error_is_fast_transient(&e),
    })?;
    serde_json::from_str(&text).map_err(|e| FetchFailure {
        text: format!("Parse error: {}", err_chain(&e)),
        transient: false,
    })
}

pub fn fetch_update_info(url: &str) -> Result<UpdateInfo, String> {
    for attempt in 1..=FETCH_ATTEMPTS {
        match fetch_update_info_once(url) {
            Ok(info) => return Ok(info),
            Err(failure) => {
                if !should_retry(failure.transient, attempt) {
                    return Err(failure.text);
                }
                log::warn!(
                    "update manifest attempt {attempt} failed for {url} ({}); retrying",
                    failure.text
                );
                // These run `CHECK_CONCURRENCY`-wide, so the cost is per chunk,
                // not per extension.
                std::thread::sleep(retry_backoff(attempt));
            }
        }
    }
    // Unreachable: the final attempt always returns above. Kept as a plain Err
    // rather than `unreachable!()` so a future edit can't turn it into a panic.
    Err("update manifest fetch failed".to_string())
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

/// What a scan of the extension directories found.
///
/// `unchecked` exists for the same reason `check_extension` separates `Ok(None)`
/// from `Err`: an extension nothing could be *asked* about must not be folded
/// into "up to date". Dropping those silently is how a plugin sat five releases
/// behind while the dialog reported good news.
#[derive(Debug, Default)]
pub struct InstalledScan {
    pub extensions: Vec<InstalledExtension>,
    /// Display names of **user-installed** extensions declaring no `updateUrl`.
    /// Built-in plugins are excluded: they ship with the app and correctly
    /// declare none, so listing them would bury the ones that are really stuck.
    pub unchecked: Vec<String>,
}

pub fn collect_installed_extensions(app_dir: &Path, native_plugins_dir: &Path) -> InstalledScan {
    let mut scan = InstalledScan::default();

    let user_plugins = crate::plugins::plugins_dir(app_dir);
    let native = native_plugins_dir.to_path_buf();
    let mut seen_plugin_ids = std::collections::HashSet::new();

    for (dir, is_user) in [(&user_plugins, true), (&native, false)] {
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
                        let name = manifest["name"].as_str().unwrap_or(&id).to_string();
                        let update_url = manifest["updateUrl"].as_str().unwrap_or_default().to_string();
                        if update_url.is_empty() {
                            if is_user {
                                scan.unchecked.push(name);
                            }
                            seen_plugin_ids.insert(id);
                            continue;
                        }
                        let version = manifest["version"].as_str().unwrap_or("0.0.0").to_string();
                        seen_plugin_ids.insert(id.clone());
                        scan.extensions.push(InstalledExtension {
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
                    let id = path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let name = skin["name"].as_str().unwrap_or(&id).to_string();
                    let update_url = skin["updateUrl"].as_str().unwrap_or_default().to_string();
                    if update_url.is_empty() {
                        scan.unchecked.push(name);
                        continue;
                    }
                    let version = skin["version"].as_str().unwrap_or("0.0.0").to_string();
                    scan.extensions.push(InstalledExtension {
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

    scan
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
    /// Display names of extensions that could not be checked at all because they
    /// declare no `updateUrl`. Three outcomes, all distinct: absent here and in
    /// `failed` means checked and current; `failed` means we tried and couldn't
    /// reach it; this means there was nothing to ask.
    pub unchecked: Vec<String>,
}

pub fn check_all_updates(
    app_dir: &Path,
    native_plugins_dir: &Path,
    app_version: &str,
) -> UpdateCheckReport {
    let scan = collect_installed_extensions(app_dir, native_plugins_dir);
    let mut report = UpdateCheckReport {
        unchecked: scan.unchecked,
        ..Default::default()
    };

    for chunk in scan.extensions.chunks(CHECK_CONCURRENCY) {
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
        // That this failure isn't *retried* is asserted directly by
        // `test_a_deterministic_failure_is_never_retried` +
        // `test_a_malformed_url_is_not_a_transient_error`, not by timing this
        // call. It was timed here once (elapsed < 1s) and that was a wall-clock
        // proxy for a pure decision: it measured the machine, so it failed on a
        // loaded one — reproducibly, on the first run after libmpv is vendored,
        // when the freshly-signed dylib's Gatekeeper check lands on the same
        // suite. Don't reintroduce a timing bound to stand in for a predicate.
    }

    /// The retry ladder must be spent only on answers that can change. A
    /// malformed URL, a parse error or a 404 is the same answer every time, and
    /// walking the ladder for one costs `retry_backoff` 1s + 3s = 4s per
    /// extension to learn nothing.
    #[test]
    fn test_a_deterministic_failure_is_never_retried() {
        for attempt in 1..=FETCH_ATTEMPTS {
            assert!(
                !should_retry(false, attempt),
                "a non-transient failure must not be retried (attempt {attempt})"
            );
        }
    }

    /// ...and a transient one must be retried, but only up to the cap — an
    /// off-by-one here either wastes an attempt or spends the ladder forever.
    #[test]
    fn test_a_transient_failure_is_retried_up_to_the_cap() {
        for attempt in 1..FETCH_ATTEMPTS {
            assert!(should_retry(true, attempt), "attempt {attempt} should retry");
        }
        assert!(
            !should_retry(true, FETCH_ATTEMPTS),
            "the last attempt must not schedule another"
        );
    }

    /// Pins the ladder's shape and its total cost, which is the figure every
    /// "don't retry this" rule above is justified against.
    #[test]
    fn test_retry_backoff_ladder_is_one_then_three_seconds() {
        assert_eq!(retry_backoff(1), std::time::Duration::from_secs(1));
        assert_eq!(retry_backoff(2), std::time::Duration::from_secs(3));
        let total: std::time::Duration =
            (1..FETCH_ATTEMPTS).map(retry_backoff).sum();
        assert_eq!(total, std::time::Duration::from_secs(4));
    }

    /// The retry exists for a host that refuses a connection it just accepted.
    /// It must not also be spent on answers that will never change.
    #[test]
    fn test_only_recoverable_statuses_are_retried() {
        for status in [429, 500, 502, 503, 504] {
            assert!(status_is_transient(status), "{status} should be retried");
        }
        for status in [400, 401, 403, 404, 410] {
            assert!(!status_is_transient(status), "{status} should not be retried");
        }
    }

    #[test]
    fn test_a_malformed_url_is_not_a_transient_error() {
        // The one reqwest error that can be produced without a network: the URL
        // never parses, so `send()` hands back a builder error.
        let e = reqwest::blocking::Client::new()
            .get("not-a-valid-url")
            .send()
            .expect_err("an unparseable URL must not send");
        assert!(e.is_builder(), "expected a builder error, got {e:?}");
        assert!(!error_is_fast_transient(&e));
    }

    /// The report keeps the three apart so the UI can word them differently:
    /// an update, a check that failed, and one there was nothing to ask about.
    #[test]
    fn test_report_separates_updates_from_failures() {
        let report = UpdateCheckReport {
            updates: Vec::new(),
            failed: vec!["Example".into()],
            unchecked: vec!["No Source".into()],
        };
        assert!(report.updates.is_empty());
        assert_eq!(report.failed, vec!["Example".to_string()]);
        assert_eq!(report.unchecked, vec!["No Source".to_string()]);
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
        let scan = collect_installed_extensions(tmp.path(), native.path());
        assert!(scan.extensions.is_empty());
        assert!(scan.unchecked.is_empty());
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

        let scan = collect_installed_extensions(tmp.path(), native.path());
        assert_eq!(scan.extensions.len(), 1);
        assert_eq!(scan.extensions[0].id, "test-plugin");
        assert_eq!(scan.extensions[0].update_url, "https://example.com/update.json");
        // Not silently dropped: a user plugin with no updateUrl is reportable,
        // because "we never asked" must not read as "up to date".
        assert_eq!(scan.unchecked, vec!["No Update".to_string()]);
    }

    #[test]
    fn test_builtin_plugin_without_update_url_is_not_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let native = tempfile::tempdir().unwrap();

        // Built-ins ship with the app and correctly declare no updateUrl. Listing
        // them would bury the user-installed ones that are genuinely stuck.
        let builtin = native.path().join("lastfm");
        std::fs::create_dir_all(&builtin).unwrap();
        std::fs::write(
            builtin.join("manifest.json"),
            r#"{"id":"lastfm","name":"Last.fm","version":"1.0.0"}"#,
        ).unwrap();

        let scan = collect_installed_extensions(tmp.path(), native.path());
        assert!(scan.extensions.is_empty());
        assert!(scan.unchecked.is_empty());
    }

    #[test]
    fn test_skin_without_update_url_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let native = tempfile::tempdir().unwrap();

        // No gallery skin has ever carried updateUrl, so every installed skin
        // landed in the silent-skip path. It is now visible.
        let skins = crate::skins::skins_dir(tmp.path());
        std::fs::create_dir_all(&skins).unwrap();
        std::fs::write(
            skins.join("dracula.json"),
            r#"{"name":"Dracula","version":"1.1.0"}"#,
        ).unwrap();

        let scan = collect_installed_extensions(tmp.path(), native.path());
        assert!(scan.extensions.is_empty());
        assert_eq!(scan.unchecked, vec!["Dracula".to_string()]);
    }

    #[test]
    fn test_stamp_update_url_fills_missing_and_preserves_declared() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = crate::plugins::plugins_dir(tmp.path()).join("stamped");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            r#"{"id":"stamped","name":"Stamped","version":"1.0.0"}"#,
        ).unwrap();

        crate::plugins::stamp_update_url(tmp.path(), "stamped", "https://example.com/u.json").unwrap();
        assert_eq!(
            crate::plugins::installed_update_url(tmp.path(), "stamped").as_deref(),
            Some("https://example.com/u.json")
        );

        // An author pointing updates elsewhere keeps their own value.
        crate::plugins::stamp_update_url(tmp.path(), "stamped", "https://gallery.example/u.json").unwrap();
        assert_eq!(
            crate::plugins::installed_update_url(tmp.path(), "stamped").as_deref(),
            Some("https://example.com/u.json")
        );

        // And the stamped copy is now visible to the checker.
        let native = tempfile::tempdir().unwrap();
        let scan = collect_installed_extensions(tmp.path(), native.path());
        assert_eq!(scan.extensions.len(), 1);
        assert!(scan.unchecked.is_empty());
    }
}
