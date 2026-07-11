//! Downloadable libmpv engine component.
//!
//! The lean build carries no libmpv; when the user selects the native engine,
//! the app downloads a pinned, SHA-256-verified, ready-to-load artifact into
//! `{app_data_dir}/engine/` (shared across profiles) and the runtime loader
//! (`ffi.rs`) picks it up — no restart needed, since load failures are never
//! cached. Mirrors the managed-binary flow in `dependencies.rs`.
//!
//! Pins live in `src-tauri/engine-component.lock.json` (baked in at compile
//! time). The artifacts are produced by `scripts/package-engine-component.mjs`
//! from the post-processed vendor dir and published as GitHub release assets —
//! they are packaged ONCE per pin bump, so the baked hash always matches.

use super::ffi;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::PathBuf;
use std::sync::OnceLock;

const LOCK_JSON: &str = include_str!("../../engine-component.lock.json");
/// Version stamp written next to the installed files.
const STAMP_FILE: &str = "component.json";

#[derive(Debug, Clone, Deserialize)]
struct LockEntry {
    version: String,
    url: String,
    sha256: String,
    #[serde(default)]
    size_mb: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct Lock {
    platforms: std::collections::HashMap<String, LockEntry>,
}

fn lock_entry() -> Option<&'static LockEntry> {
    static LOCK: OnceLock<Option<Lock>> = OnceLock::new();
    let lock = LOCK.get_or_init(|| match serde_json::from_str::<Lock>(LOCK_JSON) {
        Ok(lock) => Some(lock),
        Err(e) => {
            log::error!("mpv-engine: invalid engine-component.lock.json: {e}");
            None
        }
    });
    let entry = lock.as_ref()?.platforms.get(&ffi::platform_key())?;
    // An entry without a published artifact (empty url/sha) is a placeholder.
    (!entry.url.is_empty() && !entry.sha256.is_empty()).then_some(entry)
}

#[derive(Debug, Serialize, Deserialize)]
struct Stamp {
    version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentStatus {
    /// A pinned artifact exists for this platform.
    pub available: bool,
    /// The managed copy is present in the engine dir.
    pub installed: bool,
    pub installed_version: Option<String>,
    /// The pin the installer would fetch.
    pub lock_version: Option<String>,
    pub update_available: bool,
    /// Where the loader found (or would find) libmpv:
    /// env | bundled | managed | vendored | system.
    pub origin: Option<String>,
    /// libmpv is loaded in this process right now.
    pub loaded: bool,
    /// Approximate download size, for the install button label.
    pub size_mb: Option<f64>,
}

pub fn status() -> ComponentStatus {
    let entry = lock_entry();
    let dir = ffi::component_dir();
    let installed = dir
        .as_ref()
        .is_some_and(|d| d.join(ffi::LIB_FILENAME).is_file());
    let installed_version = dir.as_ref().and_then(|d| {
        let stamp = std::fs::read_to_string(d.join(STAMP_FILE)).ok()?;
        Some(serde_json::from_str::<Stamp>(&stamp).ok()?.version)
    });
    let loaded_lib = ffi::loaded();
    let origin = loaded_lib
        .map(|lib| lib.origin)
        .or_else(|| ffi::resolve_lib().map(|(_, origin)| origin));
    ComponentStatus {
        available: entry.is_some(),
        installed,
        update_available: match (entry, installed, &installed_version) {
            // Unstamped installs predate versioning — offer the update.
            (Some(_), true, None) => true,
            (Some(e), true, Some(v)) => *v != e.version,
            _ => false,
        },
        installed_version,
        lock_version: entry.map(|e| e.version.clone()),
        origin: origin.map(str::to_owned),
        loaded: loaded_lib.is_some(),
        size_mb: entry.and_then(|e| e.size_mb),
    }
}

/// Download + verify + install the pinned component. `progress` receives
/// (downloaded, total) while the artifact streams in.
pub fn install(mut progress: impl FnMut(u64, Option<u64>)) -> Result<ComponentStatus, String> {
    let entry = lock_entry()
        .ok_or_else(|| format!("no engine component published for {}", ffi::platform_key()))?
        .clone();
    let dir = ffi::component_dir().ok_or("engine component directory not initialized")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;

    let client = reqwest::blocking::Client::builder()
        .user_agent("Viboplr")
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let mut resp = client
        .get(&entry.url)
        .send()
        .map_err(|e| format!("download error: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length();

    let mut data: Vec<u8> = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    loop {
        let n = resp
            .read(&mut buf)
            .map_err(|e| format!("download read error: {e}"))?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
        downloaded += n as u64;
        progress(downloaded, total);
    }

    let actual = sha256_hex(&data);
    if actual != entry.sha256.to_lowercase() {
        return Err(format!(
            "checksum mismatch for engine component (expected {}, got {actual})",
            entry.sha256
        ));
    }

    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data))
        .map_err(|e| format!("invalid component archive: {e}"))?;
    let mut installed_files: Vec<PathBuf> = Vec::new();
    for i in 0..zip.len() {
        let mut file = zip
            .by_index(i)
            .map_err(|e| format!("component archive read error: {e}"))?;
        if file.is_dir() {
            continue;
        }
        // Flat archive; reject anything that isn't a bare filename.
        let name = match file.enclosed_name().and_then(|p| {
            (p.components().count() == 1).then(|| p.file_name().map(|n| n.to_owned()))?
        }) {
            Some(name) => name,
            None => return Err(format!("unexpected path in component archive: {}", file.name())),
        };
        let mut contents = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut contents)
            .map_err(|e| format!("component archive read error: {e}"))?;

        // Temp + atomic rename per file; on Windows a loaded DLL holds a
        // lock, so surface that as a retry-after-restart error.
        let tmp = dir.join(format!(".{}.download", name.to_string_lossy()));
        std::fs::write(&tmp, &contents).map_err(|e| format!("write error: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("chmod error: {e}"))?;
        }
        let dest = dir.join(&name);
        if let Err(e) = std::fs::rename(&tmp, &dest) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!(
                "install error (restart Viboplr and retry if the engine is in use): {e}"
            ));
        }
        installed_files.push(dest);
    }
    if !installed_files.iter().any(|p| p.ends_with(ffi::LIB_FILENAME)) {
        return Err(format!(
            "component archive did not contain {}",
            ffi::LIB_FILENAME
        ));
    }

    let stamp = serde_json::to_string_pretty(&Stamp { version: entry.version.clone() })
        .expect("stamp serializes");
    std::fs::write(dir.join(STAMP_FILE), stamp).map_err(|e| format!("stamp write error: {e}"))?;
    log::info!(
        "mpv-engine: installed engine component {} into {}",
        entry.version,
        dir.display()
    );
    Ok(status())
}

/// Remove the managed copy. A library already loaded in this process stays
/// usable until restart; the loader simply won't find the files next launch.
pub fn uninstall() -> Result<ComponentStatus, String> {
    let dir = ffi::component_dir().ok_or("engine component directory not initialized")?;
    if dir.is_dir() {
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("read error: {e}"))? {
            let path = entry.map_err(|e| format!("read error: {e}"))?.path();
            if path.is_file() {
                std::fs::remove_file(&path)
                    .map_err(|e| format!("failed to remove {}: {e}", path.display()))?;
            }
        }
    }
    Ok(status())
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lock_json_parses() {
        let lock: Lock = serde_json::from_str(LOCK_JSON).expect("lock file must parse");
        // Every entry must be either a placeholder (both empty) or complete.
        for (platform, e) in &lock.platforms {
            assert_eq!(
                e.url.is_empty(),
                e.sha256.is_empty(),
                "{platform}: url and sha256 must be both set or both empty"
            );
            assert!(!e.version.is_empty(), "{platform}: version required");
            if !e.sha256.is_empty() {
                assert_eq!(e.sha256.len(), 64, "{platform}: sha256 must be 64 hex chars");
            }
        }
    }

    #[test]
    fn test_status_is_serializable() {
        let s = status();
        let json = serde_json::to_value(&s).unwrap();
        assert!(json.get("available").is_some());
        assert!(json.get("installed").is_some());
    }

    /// Network-dependent — run explicitly:
    /// `cargo test test_install_from_published_release -- --ignored --nocapture`
    /// Exercises the real install path against the live `engine-components`
    /// release: download, SHA-256 verify, flat extraction, version stamp.
    #[test]
    #[ignore]
    fn test_install_from_published_release() {
        let entry = lock_entry().expect("this platform must have a published component");
        let dir = tempfile::tempdir().unwrap();
        ffi::set_component_dir(dir.path().to_path_buf());

        let status = install(|downloaded, total| {
            if downloaded % (8 * 1024 * 1024) < 65536 {
                eprintln!("[component-test] {downloaded} / {total:?}");
            }
        })
        .expect("install from published release");

        assert!(status.installed, "component must report installed");
        assert_eq!(status.installed_version.as_deref(), Some(entry.version.as_str()));
        assert!(!status.update_available, "fresh install must match the lock pin");
        let lib = dir.path().join(ffi::LIB_FILENAME);
        assert!(lib.is_file(), "{} must exist", lib.display());
        assert!(std::fs::metadata(&lib).unwrap().len() > 1_000_000, "lib must be non-trivial");
    }
}
