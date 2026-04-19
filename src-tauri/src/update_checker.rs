use crate::models::{ExtensionUpdate, UpdateInfo};
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

pub fn fetch_update_info(url: &str) -> Result<UpdateInfo, String> {
    let resp = reqwest::blocking::get(url)
        .map_err(|e| format!("HTTP error: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let text = resp.text().map_err(|e| format!("Read error: {}", e))?;
    serde_json::from_str(&text).map_err(|e| format!("Parse error: {}", e))
}

pub fn check_extension(
    ext: &InstalledExtension,
    app_version: &str,
) -> Option<ExtensionUpdate> {
    let info = match fetch_update_info(&ext.update_url) {
        Ok(info) => info,
        Err(_) => return None,
    };

    if !semver_is_newer(&ext.version, &info.version) {
        return None;
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

    Some(ExtensionUpdate {
        id: ext.id.clone(),
        kind: ext.kind.clone(),
        name: ext.name.clone(),
        current_version: ext.version.clone(),
        latest_version: info.version.clone(),
        changelog: info.changelog.unwrap_or_default(),
        download_url: info.file,
        status,
        min_app_version: info.min_app_version,
    })
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

pub fn check_all_updates(
    app_dir: &Path,
    native_plugins_dir: &Path,
    app_version: &str,
) -> Vec<ExtensionUpdate> {
    let extensions = collect_installed_extensions(app_dir, native_plugins_dir);
    let mut updates = Vec::new();

    for ext in &extensions {
        if let Some(update) = check_extension(ext, app_version) {
            updates.push(update);
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    updates
}

pub fn spawn_update_checker(
    app_handle: tauri::AppHandle,
    app_dir: std::path::PathBuf,
    native_plugins_dir: std::path::PathBuf,
    app_version: String,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    std::thread::spawn(move || {
        loop {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }

            let updates = check_all_updates(&app_dir, &native_plugins_dir, &app_version);
            if !updates.is_empty() {
                let _ = app_handle.emit("extensions-updates-available", &updates);
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
