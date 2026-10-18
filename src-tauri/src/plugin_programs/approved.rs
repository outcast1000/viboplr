//! Which files in a plugin's store the user agreed to run.
//!
//! The user is asked when a program arrives (`programs.download`, behind the
//! host's install confirmation), not when it runs: a start happens on every
//! activation, every retry and at every login, where there is no one to ask
//! and nothing new to ask about. So the answer is recorded here and every
//! execute path — `start` and `run` — **refuses** a binary it
//! doesn't find in this record, or whose bytes have changed since. There is no
//! "run it anyway" prompt.
//!
//! - **What gets recorded:** the file a confirmed `download` wrote, and every
//!   file `extract` unpacked out of an archive that is itself recorded. Each as
//!   a store-relative path (the plugin's own segments joined with `/`) and its
//!   sha256. A file the plugin wrote through `api.storage.files` never is, so
//!   writing a script or fetching a binary that way and then starting it fails.
//! - **Where:** `{profile}/plugin-programs/<pluginId>/.approved`, beside the
//!   registrations and for the same reason — the plugin's file API can't reach
//!   it. (The leading dot keeps it out of `registrations()`, which reads
//!   `*.json`.)
//! - **Checked by content, not by name.** An execute hashes the file and
//!   compares; a path that differs only in case from the recorded one simply
//!   isn't found and is refused, which is the safe direction.
//! - **One lock for "check, then use".** `store_lock` is held across the hash
//!   and the spawn, and by every command that changes a plugin's store, so a
//!   plugin can't swap the file between the check and the exec. Every start is
//!   in this process (there is no login-item launcher), so the lock covers all
//!   of them.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const LEDGER_FILE: &str = ".approved";

static STORE_LOCK: Mutex<()> = Mutex::new(());

/// Held while a plugin's store changes, and across an execute's check + spawn.
/// A poisoned lock still serializes — nothing it guards is left half-done.
pub fn store_lock() -> MutexGuard<'static, ()> {
    STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Ledger {
    /// Store-relative path → sha256 (lowercase hex).
    files: BTreeMap<String, String>,
}

fn ledger_path(app_dir: &Path, plugin_id: &str) -> PathBuf {
    super::registry_dir(app_dir, plugin_id).join(LEDGER_FILE)
}

fn read_ledger(app_dir: &Path, plugin_id: &str) -> Ledger {
    let path = ledger_path(app_dir, plugin_id);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            // Unreadable reads as "nothing approved": every execute refuses
            // until the plugin downloads again, which asks the user again.
            log::warn!("plugin programs: {} is unreadable, treating it as empty: {e}", path.display());
            Ledger::default()
        }),
        Err(_) => Ledger::default(),
    }
}

fn write_ledger(app_dir: &Path, plugin_id: &str, ledger: &Ledger) -> Result<(), String> {
    let path = ledger_path(app_dir, plugin_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(ledger).map_err(|e| e.to_string())?;
    let tmp = path.with_file_name(format!("{LEDGER_FILE}.tmp-{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't write {}: {e}", path.display())
    })
}

/// The ledger key for a path given as the plugin's own segments.
pub fn key(segments: &[String]) -> String {
    segments.join("/")
}

/// sha256 of a file, streamed.
pub fn hash_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Record files as approved. Entries whose file is gone are dropped while
/// we're here, so the record doesn't grow with every old version. Caller holds
/// `store_lock`.
pub fn record(app_dir: &Path, plugin_id: &str, files: impl IntoIterator<Item = (String, String)>) -> Result<(), String> {
    update(app_dir, plugin_id, |_| false, files)
}

/// Record what an unpack produced: `dest` (the plugin's segments) replaced
/// whatever was there, so its old entries go and the new ones come in.
pub fn record_unpacked(app_dir: &Path, plugin_id: &str, dest: &[String], files: &[(PathBuf, String)]) -> Result<(), String> {
    let prefix = format!("{}/", key(dest));
    let entries: Vec<(String, String)> = files
        .iter()
        .filter_map(|(rel, sha)| {
            let parts: Option<Vec<&str>> = rel.components().map(|c| c.as_os_str().to_str()).collect();
            parts.map(|p| (format!("{prefix}{}", p.join("/")), sha.clone()))
        })
        .collect();
    update(app_dir, plugin_id, |k| k.starts_with(&prefix), entries)
}

fn update(
    app_dir: &Path,
    plugin_id: &str,
    drop: impl Fn(&str) -> bool,
    files: impl IntoIterator<Item = (String, String)>,
) -> Result<(), String> {
    let root = super::store_root(app_dir, plugin_id);
    let mut ledger = read_ledger(app_dir, plugin_id);
    ledger.files.retain(|k, _| !drop(k) && root.join(k).is_file());
    ledger.files.extend(files);
    write_ledger(app_dir, plugin_id, &ledger)
}

/// The ledger key of an absolute path inside the plugin's store: its
/// canonical form relative to the store's. A path that reaches the file under
/// another spelling (case, a symlinked folder) gets a key nothing was recorded
/// under, and is refused.
fn key_of(app_dir: &Path, plugin_id: &str, path: &Path) -> Result<String, String> {
    let canon = |p: &Path| std::fs::canonicalize(p).map(super::without_verbatim_prefix);
    let root = canon(&super::store_root(app_dir, plugin_id)).map_err(|e| format!("Couldn't resolve the plugin's folder: {e}"))?;
    let file = canon(path).map_err(|e| format!("Couldn't resolve {}: {e}", path.display()))?;
    let rel = file.strip_prefix(&root).map_err(|_| format!("{} is outside the plugin's folder", path.display()))?;
    let parts: Option<Vec<&str>> = rel.components().map(|c| c.as_os_str().to_str()).collect();
    parts.map(|p| p.join("/")).ok_or_else(|| format!("{} has a name Vibo can't record", path.display()))
}

/// Refuse unless the file at `path` (inside the plugin's store) is recorded
/// and still has the recorded bytes. The caller holds `store_lock` from this
/// check until the program has been spawned.
pub fn require(app_dir: &Path, plugin_id: &str, path: &Path) -> Result<(), String> {
    let ledger = read_ledger(app_dir, plugin_id);
    let k = key_of(app_dir, plugin_id, path)?;
    let Some(expected) = ledger.files.get(&k) else {
        return Err(format!(
            "{k} wasn't installed through api.system.programs.download or extract, so Vibo won't use it"
        ));
    };
    let actual = hash_file(path)?;
    if &actual != expected {
        return Err(format!("{k} has changed since it was installed, so Vibo won't use it"));
    }
    Ok(())
}

/// Plugin uninstall: forget everything.
pub fn forget_all(app_dir: &Path, plugin_id: &str) {
    let _ = std::fs::remove_file(ledger_path(app_dir, plugin_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segs(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    fn put(app: &Path, rel: &[&str], body: &str) -> PathBuf {
        let mut p = super::super::store_root(app, "p");
        for s in rel {
            p.push(s);
        }
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn test_only_recorded_unchanged_files_pass() {
        let app = tempfile::tempdir().unwrap();
        let tool = put(app.path(), &["bin", "tool"], "v1");
        let other = put(app.path(), &["bin", "other"], "x");
        assert!(require(app.path(), "p", &tool).is_err(), "nothing recorded yet");

        record(app.path(), "p", [(key(&segs(&["bin", "tool"])), hash_file(&tool).unwrap())]).unwrap();
        require(app.path(), "p", &tool).unwrap();
        let e = require(app.path(), "p", &other).unwrap_err();
        assert!(e.contains("wasn't installed"), "{e}");

        std::fs::write(&tool, "v2").unwrap();
        let e = require(app.path(), "p", &tool).unwrap_err();
        assert!(e.contains("has changed"), "{e}");
    }

    #[test]
    fn test_an_unpack_replaces_the_destinations_entries() {
        let app = tempfile::tempdir().unwrap();
        let old = put(app.path(), &["v", "1", "old"], "o");
        put(app.path(), &["v", "1", "new"], "n");
        record(app.path(), "p", [("v/1/old".to_string(), hash_file(&old).unwrap())]).unwrap();
        record_unpacked(app.path(), "p", &segs(&["v", "1"]), &[(PathBuf::from("new"), "abc".into())]).unwrap();
        let ledger = read_ledger(app.path(), "p");
        assert_eq!(ledger.files.keys().collect::<Vec<_>>(), vec!["v/1/new"]);
    }

    #[test]
    fn test_entries_for_deleted_files_are_pruned() {
        let app = tempfile::tempdir().unwrap();
        let a = put(app.path(), &["a"], "a");
        record(app.path(), "p", [("a".to_string(), hash_file(&a).unwrap())]).unwrap();
        std::fs::remove_file(&a).unwrap();
        let b = put(app.path(), &["b"], "b");
        record(app.path(), "p", [("b".to_string(), hash_file(&b).unwrap())]).unwrap();
        assert_eq!(read_ledger(app.path(), "p").files.keys().collect::<Vec<_>>(), vec!["b"]);
    }

    #[test]
    fn test_the_ledger_is_not_read_as_a_registration() {
        let app = tempfile::tempdir().unwrap();
        record(app.path(), "p", [("x".to_string(), "00".to_string())]).unwrap();
        assert!(super::super::list(app.path(), "p").unwrap().is_empty());
    }
}
