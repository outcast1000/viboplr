//! The Home view's cached shelves (`useHome.ts` → `HomeSnapshot`), kept in
//! `{profile}/home-snapshot.json` rather than the app store.
//!
//! It lived in `app-state.json` until it was ~90% of that file: playlist cards
//! ship their whole track list so a click plays at once, and a few Spotify
//! shelves alone came to ~200 KB. The store rewrites the entire file
//! (pretty-printed) on every debounced save, so every settings tweak paid for
//! the snapshot too. Here it is written only when Home refreshes.
//!
//! The payload is opaque to the backend — the frontend owns its shape. The read
//! is on the startup path, so it hands the file's bytes back untouched: parsing
//! it here only to serialize it again for the IPC doubled the work, and the
//! webview parses it once (`utils/homeSnapshotFile.ts`, which also treats an
//! unparseable file as no snapshot). Writes are compact and replace the file
//! whole with write-then-rename.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const FILE: &str = "home-snapshot.json";

fn file(profile_dir: &Path) -> PathBuf {
    profile_dir.join(FILE)
}

/// The stored bytes, or `None` when there is no snapshot yet. Any other read
/// failure is an `Err`, which the frontend must not mistake for "missing".
pub fn read(profile_dir: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(file(profile_dir)) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read home snapshot: {e}")),
    }
}

/// Distinguishes concurrent writers' tmp files, so two overlapping writes each
/// rename a complete file of their own (last rename wins) instead of
/// interleaving into one shared tmp. The frontend serializes its writes for
/// ordering, but safety must not depend on that.
static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

fn tmp_prefix() -> String {
    format!("{FILE}.")
}

fn tmp_name(pid: u32, seq: u64) -> String {
    format!("{}{pid}.{seq}.tmp", tmp_prefix())
}

/// The pid a tmp file was written by, if `name` is one of ours.
fn tmp_owner(name: &str) -> Option<u32> {
    name.strip_prefix(&tmp_prefix())?.strip_suffix(".tmp")?.split('.').next()?.parse().ok()
}

/// Delete tmp files a previous run left behind (killed between write and
/// rename). Only other pids' files: this process's may be a write in flight.
/// Runs on the write path, which is never on startup's critical path.
fn sweep_stale_tmp(profile_dir: &Path) {
    let me = std::process::id();
    let Ok(entries) = std::fs::read_dir(profile_dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if tmp_owner(&name.to_string_lossy()).is_some_and(|pid| pid != me) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub fn write(profile_dir: &Path, snapshot: &serde_json::Value) -> Result<(), String> {
    sweep_stale_tmp(profile_dir);
    let bytes = serde_json::to_vec(snapshot).map_err(|e| format!("serialize home snapshot: {e}"))?;
    let dest = file(profile_dir);
    let tmp = profile_dir.join(tmp_name(std::process::id(), WRITE_SEQ.fetch_add(1, Ordering::Relaxed)));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("write home snapshot: {e}"))?;
    std::fs::rename(&tmp, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("write home snapshot: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read_json(dir: &Path) -> Option<serde_json::Value> {
        read(dir).unwrap().map(|b| serde_json::from_slice(&b).unwrap())
    }

    fn tmp_files(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn missing_file_reads_as_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read(tmp.path()).unwrap(), None);
    }

    #[test]
    fn round_trips_compact_and_replaces() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), &json!({ "shelves": [{ "id": "a" }], "savedAt": 1 })).unwrap();
        write(tmp.path(), &json!({ "shelves": [], "savedAt": 2 })).unwrap();
        assert_eq!(read_json(tmp.path()), Some(json!({ "shelves": [], "savedAt": 2 })));
        let raw = std::fs::read_to_string(tmp.path().join(FILE)).unwrap();
        assert!(!raw.contains('\n'), "stored compact, not pretty-printed");
        assert!(tmp_files(tmp.path()).is_empty(), "no tmp file left behind");
    }

    #[test]
    fn read_returns_the_bytes_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(FILE), b"{not json").unwrap();
        assert_eq!(read(tmp.path()).unwrap(), Some(b"{not json".to_vec()));
    }

    #[test]
    fn concurrent_writes_each_land_a_complete_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        let big: Vec<_> = (0..2000).map(|i| json!({ "id": i, "title": "x".repeat(50) })).collect();
        std::thread::scope(|s| {
            for n in 0..8 {
                let (dir, big) = (&dir, &big);
                s.spawn(move || write(dir, &json!({ "writer": n, "shelves": big })).unwrap());
            }
        });
        let v = read_json(&dir).expect("a whole, parseable snapshot");
        assert_eq!(v["shelves"].as_array().unwrap().len(), 2000);
    }

    #[test]
    fn write_sweeps_tmp_files_left_by_other_runs_only() {
        let tmp = tempfile::tempdir().unwrap();
        let me = std::process::id();
        let stale = tmp_name(me.wrapping_add(1), 0);
        let mine = tmp_name(me, u64::MAX);
        std::fs::write(tmp.path().join(&stale), b"half").unwrap();
        std::fs::write(tmp.path().join(&mine), b"in flight").unwrap();
        std::fs::write(tmp.path().join("other.tmp"), b"not ours").unwrap();
        write(tmp.path(), &json!({ "savedAt": 1 })).unwrap();
        let mut left = tmp_files(tmp.path());
        left.sort();
        let mut want = vec![mine, "other.tmp".to_string()];
        want.sort();
        assert_eq!(left, want);
    }

    #[test]
    fn tmp_owner_parses_only_our_names() {
        assert_eq!(tmp_owner(&tmp_name(42, 7)), Some(42));
        assert_eq!(tmp_owner("home-snapshot.json"), None);
        assert_eq!(tmp_owner("home-snapshot.json.tmp"), None);
        assert_eq!(tmp_owner("cue.json.42.0.tmp"), None);
    }
}
