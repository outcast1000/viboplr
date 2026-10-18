//! One-time removal of what the Roadie CLI left behind.
//!
//! Vibo used to install the Roadie tool manager as a managed dependency and
//! let the slskd plugin drive it; Roadie in turn installed and ran slskd under
//! Vibo's own data dir (`{app_data_dir}/roadie`). That integration was removed
//! (2026-10-18): a plugin's programs are now installed and run by the signed
//! plugin itself through `api.system.programs`. This module clears the
//! leftovers once per install:
//!
//! 1. stop any program Roadie started from that dir (its `tool.pid` files),
//!    but only a process whose executable really lives there;
//! 2. remove the login items Roadie wrote for it — a macOS LaunchAgent or a
//!    Windows Run value — but only ones that point into that dir, so the
//!    user's own standalone Roadie (data dir `com.outcast1000.roadie`) is left
//!    alone;
//! 3. delete the dir and our managed `bin/roadie` copy.
//!
//! The marker `{app_data_dir}/.roadie-removed` is written only when every step
//! succeeded, so a step that failed (a program that wouldn't stop, a file held
//! open on Windows) is retried at the next launch. The persisted probe cache
//! (`bin/.probe-cache.json`) is not touched: its entries are keyed by the
//! binary's path + mtime + size, so a deleted binary's entry never matches
//! anything again.

use std::path::{Path, PathBuf};
use std::time::Duration;

const MARKER: &str = ".roadie-removed";
const STOP_GRACE: Duration = Duration::from_secs(15);

pub fn run_once(app_data_dir: &Path) {
    let marker = app_data_dir.join(MARKER);
    if marker.exists() {
        return;
    }
    let roadie_dir = app_data_dir.join("roadie");
    let bins = managed_binaries(app_data_dir);
    if !roadie_dir.exists() && !bins.iter().any(|b| b.exists()) && !has_login_items(&roadie_dir) {
        // Never had it (or already clean): nothing to do, ever.
        let _ = std::fs::write(&marker, "");
        return;
    }
    log::info!("roadie cleanup: removing leftovers under {}", roadie_dir.display());
    let stopped = stop_programs(&roadie_dir);
    let mut ok = stopped;
    ok &= remove_login_items(&roadie_dir);
    // Never delete the folder of a program still running from it; the next
    // launch tries the stop again first.
    if stopped && roadie_dir.exists() {
        match std::fs::remove_dir_all(&roadie_dir) {
            Ok(()) => log::info!("roadie cleanup: deleted {}", roadie_dir.display()),
            Err(e) => {
                log::warn!("roadie cleanup: couldn't delete {}: {e}", roadie_dir.display());
                ok = false;
            }
        }
    }
    for bin in bins.iter().filter(|b| b.exists()) {
        match std::fs::remove_file(bin) {
            Ok(()) => log::info!("roadie cleanup: deleted {}", bin.display()),
            Err(e) => {
                log::warn!("roadie cleanup: couldn't delete {}: {e}", bin.display());
                ok = false;
            }
        }
    }
    if ok {
        if let Err(e) = std::fs::write(&marker, "") {
            log::warn!("roadie cleanup: couldn't write {}: {e}", marker.display());
        }
    } else {
        log::warn!("roadie cleanup: incomplete, will retry at next launch");
    }
}

fn managed_binaries(app_data_dir: &Path) -> Vec<PathBuf> {
    let bin = app_data_dir.join("bin");
    vec![bin.join("roadie"), bin.join("roadie.exe")]
}

// --- Programs Roadie started ---

/// The pid in a Roadie `tool.pid`: JSON `{ "pid": 123, … }` (what Roadie
/// writes), or a bare number.
pub fn parse_pid_file(text: &str) -> Option<u32> {
    let t = text.trim();
    if let Ok(n) = t.parse::<u32>() {
        return Some(n);
    }
    let v: serde_json::Value = serde_json::from_str(t).ok()?;
    v.get("pid")?.as_u64().and_then(|n| u32::try_from(n).ok())
}

/// Every `tools/<tool>/data/tool.pid` under the Roadie dir.
fn pid_files(roadie_dir: &Path) -> Vec<PathBuf> {
    let Ok(tools) = std::fs::read_dir(roadie_dir.join("tools")) else { return Vec::new() };
    tools
        .flatten()
        .map(|t| t.path().join("data").join("tool.pid"))
        .filter(|p| p.is_file())
        .collect()
}

fn stop_programs(roadie_dir: &Path) -> bool {
    let mut ok = true;
    for file in pid_files(roadie_dir) {
        let Some(pid) = std::fs::read_to_string(&file).ok().as_deref().and_then(parse_pid_file) else {
            continue;
        };
        if !crate::plugin_programs::process::is_ours(pid, roadie_dir) {
            continue;
        }
        match crate::plugin_programs::process::stop(pid, STOP_GRACE) {
            Ok(how) => log::info!("roadie cleanup: stopped pid {pid} from {} ({how:?})", file.display()),
            Err(e) => {
                log::warn!("roadie cleanup: {e}");
                ok = false;
            }
        }
    }
    ok
}

// --- Login items ---

/// Whether a login item's text points into `roadie_dir`: the path itself, its
/// canonical form, or either XML-escaped (a plist), followed by a separator or
/// the end of the string — so `…/roadie-other` doesn't count.
pub fn mentions_dir(text: &str, roadie_dir: &Path) -> bool {
    let mut forms = vec![roadie_dir.to_string_lossy().into_owned()];
    if let Ok(c) = std::fs::canonicalize(roadie_dir) {
        forms.push(c.to_string_lossy().into_owned());
    }
    let escaped: Vec<String> = forms.iter().map(|f| f.replace('&', "&amp;")).collect();
    forms.extend(escaped);
    forms.iter().any(|form| {
        text.match_indices(form.as_str()).any(|(i, m)| {
            match text[i + m.len()..].chars().next() {
                None => true,
                Some(c) => matches!(c, '/' | '\\' | '<' | '"' | ' ' | '\n' | '\r'),
            }
        })
    })
}

/// `reg query <Run key>` output → `(value name, data)` pairs. Lines look like
/// `    Roadie service-ab12    REG_SZ    "C:\…\roadie.exe" --serve …`; a name
/// may itself contain spaces, so split on the type column. Windows-only at
/// runtime; compiled everywhere so its test runs on every CI runner.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_reg_query(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        .filter_map(|line| {
            for ty in ["REG_EXPAND_SZ", "REG_SZ"] {
                if let Some(idx) = line.find(&format!("    {ty}    ")) {
                    let name = line[..idx].trim().to_string();
                    let data = line[idx + ty.len() + 8..].trim().to_string();
                    if !name.is_empty() {
                        return Some((name, data));
                    }
                }
            }
            None
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn roadie_launch_agents(roadie_dir: &Path) -> Vec<(String, PathBuf)> {
    let Some(home) = std::env::var_os("HOME") else { return Vec::new() };
    let dir = PathBuf::from(home).join("Library").join("LaunchAgents");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?.to_string();
            let label = name.strip_suffix(".plist")?.to_string();
            if !label.starts_with("com.outcast1000.roadie.") {
                return None;
            }
            let text = std::fs::read_to_string(&path).ok()?;
            mentions_dir(&text, roadie_dir).then_some((label, path))
        })
        .collect()
}

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
fn reg(args: &[&str]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("reg.exe")
        .args(args)
        .creation_flags(crate::plugin_programs::process::CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("reg.exe: {e}"))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() { Ok(text) } else { Err(format!("reg {} failed: {}", args.join(" "), text.trim())) }
}

#[cfg(windows)]
fn roadie_run_values(roadie_dir: &Path) -> Vec<String> {
    let Ok(out) = reg(&["query", RUN_KEY]) else { return Vec::new() };
    parse_reg_query(&out)
        .into_iter()
        .filter(|(name, data)| name.starts_with("Roadie ") && mentions_dir(data, roadie_dir))
        .map(|(name, _)| name)
        .collect()
}

fn has_login_items(roadie_dir: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        !roadie_launch_agents(roadie_dir).is_empty()
    }
    #[cfg(windows)]
    {
        !roadie_run_values(roadie_dir).is_empty()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = roadie_dir;
        false
    }
}

fn remove_login_items(roadie_dir: &Path) -> bool {
    let mut ok = true;
    #[cfg(target_os = "macos")]
    for (label, path) in roadie_launch_agents(roadie_dir) {
        let target = format!("gui/{}/{label}", unsafe { libc::getuid() });
        // Not loaded is the usual case (Roadie wrote them without loading).
        let _ = std::process::Command::new("/bin/launchctl").args(["bootout", &target]).output();
        match std::fs::remove_file(&path) {
            Ok(()) => log::info!("roadie cleanup: removed login item {}", path.display()),
            Err(e) => {
                log::warn!("roadie cleanup: couldn't remove {}: {e}", path.display());
                ok = false;
            }
        }
    }
    #[cfg(windows)]
    for name in roadie_run_values(roadie_dir) {
        match reg(&["delete", RUN_KEY, "/v", &name, "/f"]) {
            Ok(_) => log::info!("roadie cleanup: removed login item {name}"),
            Err(e) => {
                log::warn!("roadie cleanup: {e}");
                ok = false;
            }
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = roadie_dir;
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pid_file_is_read_as_json_or_a_bare_number() {
        let roadie = r#"{ "pid": 44394, "version": "0.26.1", "exe": "/x/slskd", "startedAt": 1, "startedBy": "roadie" }"#;
        assert_eq!(parse_pid_file(roadie), Some(44394));
        assert_eq!(parse_pid_file(" 123\n"), Some(123));
        assert_eq!(parse_pid_file("{}"), None);
        assert_eq!(parse_pid_file("garbage"), None);
        assert_eq!(parse_pid_file(r#"{"pid": -1}"#), None);
    }

    #[test]
    fn test_only_items_pointing_into_vibos_roadie_dir_match() {
        let dir = Path::new("/Users/a/Library/Application Support/com.alex.viboplr/roadie");
        let ours = "<string>/Users/a/Library/Application Support/com.alex.viboplr/roadie/tools/slskd/versions/0.26.1/slskd</string>";
        assert!(mentions_dir(ours, dir));
        assert!(mentions_dir("--data-dir \"/Users/a/Library/Application Support/com.alex.viboplr/roadie\"", dir));
        // The user's standalone Roadie keeps its own data dir.
        let theirs = "<string>/Users/a/Library/Application Support/com.outcast1000.roadie</string>";
        assert!(!mentions_dir(theirs, dir));
        // A sibling whose name merely starts the same.
        assert!(!mentions_dir("<string>/Users/a/Library/Application Support/com.alex.viboplr/roadie-old/x</string>", dir));
        // XML-escaped ampersands in a plist.
        let amp = Path::new("/Users/a b/App & Co/roadie");
        assert!(mentions_dir("<string>/Users/a b/App &amp; Co/roadie/tools/x</string>", amp));
    }

    #[test]
    fn test_reg_query_output_is_split_on_the_type_column() {
        let out = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    OneDrive    REG_SZ    \"C:\\OneDrive.exe\" /background\r\n    Roadie service-ab12    REG_SZ    \"C:\\Roadie\\roadie.exe\" --serve --data-dir \"C:\\Users\\x\\AppData\\Roaming\\com.alex.viboplr\\roadie\"\r\n    Thing    REG_EXPAND_SZ    %ProgramFiles%\\t.exe\r\n";
        let pairs = parse_reg_query(out);
        assert_eq!(pairs.len(), 3);
        assert_eq!(pairs[1].0, "Roadie service-ab12");
        assert!(pairs[1].1.ends_with("com.alex.viboplr\\roadie\""));
        assert_eq!(pairs[2], ("Thing".to_string(), "%ProgramFiles%\\t.exe".to_string()));
        let dir = Path::new("C:\\Users\\x\\AppData\\Roaming\\com.alex.viboplr\\roadie");
        assert!(mentions_dir(&pairs[1].1, dir));
        assert!(!mentions_dir(&pairs[0].1, dir));
    }

    #[test]
    fn test_cleanup_deletes_the_dir_and_binary_then_marks_itself_done() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("roadie").join("tools").join("slskd").join("data");
        std::fs::create_dir_all(&data).unwrap();
        // A pid that isn't ours (our own test process runs from elsewhere) is left alone.
        std::fs::write(data.join("tool.pid"), format!("{{\"pid\": {}}}", std::process::id())).unwrap();
        std::fs::create_dir_all(root.path().join("bin")).unwrap();
        std::fs::write(root.path().join("bin").join("roadie"), "x").unwrap();
        std::fs::write(root.path().join("bin").join("yt-dlp"), "keep").unwrap();
        run_once(root.path());
        assert!(!root.path().join("roadie").exists());
        assert!(!root.path().join("bin").join("roadie").exists());
        assert!(root.path().join("bin").join("yt-dlp").exists(), "other managed tools stay");
        assert!(root.path().join(MARKER).exists());
        // Idempotent: a second run with the marker present does nothing.
        std::fs::create_dir_all(root.path().join("roadie")).unwrap();
        run_once(root.path());
        assert!(root.path().join("roadie").exists());
    }

    #[test]
    fn test_a_clean_install_just_writes_the_marker() {
        let root = tempfile::tempdir().unwrap();
        run_once(root.path());
        assert!(root.path().join(MARKER).exists());
    }
}
