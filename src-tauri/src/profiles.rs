// Profile management helpers: name validation, enumeration, creation.
// The startup path in lib.rs and the profile commands in commands/app.rs
// both route through these so the rules can't drift apart.

use std::path::Path;
use std::sync::Mutex;

/// A profile-switch request forwarded by a second launch (e.g. a profile
/// shortcut opened while the app is running). Managed on the Builder *before*
/// the single-instance plugin registers, so the callback can never observe
/// unmanaged state — the frontend consumes it via `get_pending_profile_switch`
/// after restore, in addition to the live `profile-switch-requested` event.
#[derive(Default)]
pub struct PendingProfileSwitch(pub Mutex<Option<String>>);

/// Profile names are case-insensitive identities: switching, list marking,
/// and the shortcut handoff all compare with this predicate, and
/// `create_profile_in` enforces uniqueness under it.
pub fn same_profile_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// Resolve a launch-time profile name to the casing of an existing profile
/// directory, if one matches case-insensitively. Keeps the startup path from
/// creating a case-variant duplicate on case-sensitive filesystems (which
/// `create_profile_in` rejects, and which listing would double-mark as
/// current). No match — including an unreadable dir — returns the name as-is.
pub fn canonical_profile_name(profiles_dir: &Path, name: &str) -> String {
    if let Ok(entries) = std::fs::read_dir(profiles_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let existing = entry.file_name().to_string_lossy().to_string();
            if same_profile_name(&existing, name) {
                return existing;
            }
        }
    }
    name.to_string()
}

/// Decide whether a forwarded second-launch argv is a switch request:
/// an explicit, valid `--profile` naming a *different* profile. Anything
/// else (absent flag, invalid name, the current profile) means "focus only".
// Only the release-gated single-instance callback calls this (plus tests), so
// debug `cargo check` would otherwise flag it dead.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn pending_switch_request(argv: &[String], current: &str) -> Option<String> {
    let requested = profile_from_argv(argv)?;
    if validate_profile_name(&requested).is_err() || same_profile_name(&requested, current) {
        return None;
    }
    Some(requested)
}

/// Parse an explicit `--profile <name>` / `--profile=<name>` from an argv
/// (the startup parser and the single-instance callback both route through
/// this; last occurrence wins). Returns `None` when no explicit flag is
/// present — for a forwarded second launch that means "focus only", never
/// "switch to default".
pub fn profile_from_argv(argv: &[String]) -> Option<String> {
    let mut profile: Option<String> = None;
    let mut i = 1;
    while i < argv.len() {
        if let Some(value) = argv[i].strip_prefix("--profile=") {
            profile = Some(value.to_string());
            i += 1;
        } else if argv[i] == "--profile" {
            if i + 1 < argv.len() {
                profile = Some(argv[i + 1].clone());
                i += 2;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    profile
}

/// Validate a profile name: 1-64 chars, starts alphanumeric, contains only
/// alphanumeric characters, hyphens, or underscores. `is_alphanumeric()` is
/// Unicode-aware, matching the startup parser's acceptance of e.g. Greek
/// names — so the length limit counts chars, not bytes.
// Windows reserved device names — rejected on every platform so a profile
// created on macOS/Linux can't break a synced or migrated Windows data dir.
const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

pub fn validate_profile_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name.chars().count() <= 64
        && name.chars().next().is_some_and(|c| c.is_alphanumeric())
        && name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
        && !WINDOWS_RESERVED_NAMES.contains(&name.to_ascii_lowercase().as_str());
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Invalid profile name '{}'. Must start with an alphanumeric character, contain only alphanumeric characters, hyphens, or underscores, and be 1-64 characters long.",
            name
        ))
    }
}

/// A profile as shown in the Settings list.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct ProfileEntry {
    pub name: String,
    #[serde(rename = "isCurrent")]
    pub is_current: bool,
}

/// Enumerate profiles: subdirectories of `profiles_dir` whose names pass the
/// profile-name rule, sorted case-insensitively. The current profile is marked
/// with a case-insensitive compare (a `--profile Work` launch against an
/// existing `work/` dir must still mark one row current).
pub fn list_profiles_in(profiles_dir: &Path, current: &str) -> Result<Vec<ProfileEntry>, String> {
    let mut names: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(profiles_dir)
        .map_err(|e| format!("Failed to read profiles directory: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        // file_type() comes free from the readdir data — no per-entry stat.
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if validate_profile_name(&name).is_err() {
            continue;
        }
        names.push(name);
    }
    names.sort_by_key(|n| n.to_lowercase());
    Ok(names
        .into_iter()
        .map(|name| ProfileEntry {
            is_current: same_profile_name(&name, current),
            name,
        })
        .collect())
}

/// Create a new profile directory. Because profile names are case-insensitive
/// identities (see `same_profile_name`), a case-variant duplicate is rejected
/// on every platform — not just where the filesystem happens to collide —
/// otherwise a case-sensitive filesystem could hold a profile that switching
/// rejects and listing double-marks as current. `create_dir` (not
/// `create_dir_all`) still backstops filesystem-level races.
pub fn create_profile_in(profiles_dir: &Path, name: &str) -> Result<(), String> {
    validate_profile_name(name)?;
    if let Ok(entries) = std::fs::read_dir(profiles_dir) {
        for entry in entries.flatten() {
            // Directories only — a stray file in profiles/ is not a profile
            // (listing filters the same way; the two must agree).
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let existing = entry.file_name().to_string_lossy().to_string();
            if same_profile_name(&existing, name) {
                return Err(format!("A profile named '{}' already exists.", existing));
            }
        }
    }
    match std::fs::create_dir(profiles_dir.join(name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(format!("A profile named '{}' already exists.", name))
        }
        Err(e) => Err(format!("Failed to create profile '{}': {}", name, e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_profile_from_argv_both_forms() {
        assert_eq!(profile_from_argv(&args(&["app", "--profile", "b"])), Some("b".into()));
        assert_eq!(profile_from_argv(&args(&["app", "--profile=b"])), Some("b".into()));
    }

    #[test]
    fn test_profile_from_argv_absent_means_none() {
        assert_eq!(profile_from_argv(&args(&["app"])), None);
        assert_eq!(profile_from_argv(&args(&["app", "viboplr://x"])), None);
    }

    #[test]
    fn test_profile_from_argv_flag_without_value_is_none() {
        assert_eq!(profile_from_argv(&args(&["app", "--profile"])), None);
    }

    #[test]
    fn test_profile_from_argv_last_occurrence_wins() {
        assert_eq!(
            profile_from_argv(&args(&["app", "--profile", "a", "--profile=b"])),
            Some("b".into())
        );
    }

    #[test]
    fn test_profile_from_argv_ignores_argv0() {
        // argv[0] is the binary path; a pathological binary name must not match.
        assert_eq!(profile_from_argv(&args(&["--profile=evil"])), None);
    }

    #[test]
    fn test_validate_accepts_valid_names() {
        for name in ["work", "kids-2", "a", "A_1", "Ελλάδα", &"x".repeat(64)] {
            assert!(validate_profile_name(name).is_ok(), "expected '{}' valid", name);
        }
    }

    #[test]
    fn test_validate_rejects_invalid_names() {
        for name in ["", "-work", "_work", "my profile", "a|b", "a/b", &"x".repeat(65)] {
            assert!(validate_profile_name(name).is_err(), "expected '{}' invalid", name);
        }
    }

    #[test]
    fn test_create_and_duplicate() {
        let tmp = tempfile::tempdir().unwrap();
        create_profile_in(tmp.path(), "kids").unwrap();
        assert!(tmp.path().join("kids").is_dir());
        let err = create_profile_in(tmp.path(), "kids").unwrap_err();
        assert!(err.contains("already exists"), "got: {}", err);
    }

    #[test]
    fn test_create_rejects_case_variant_on_every_platform() {
        let tmp = tempfile::tempdir().unwrap();
        create_profile_in(tmp.path(), "work").unwrap();
        // Case-insensitive identity rule, not a filesystem accident: 'Work'
        // must be rejected even on case-sensitive filesystems, where switching
        // and current-marking would otherwise contradict creation.
        let err = create_profile_in(tmp.path(), "Work").unwrap_err();
        assert!(err.contains("already exists"), "got: {}", err);
        let entries = std::fs::read_dir(tmp.path()).unwrap().flatten().count();
        assert_eq!(entries, 1, "no second directory may be created");
    }

    #[test]
    fn test_validate_rejects_windows_reserved_names() {
        for name in ["con", "CON", "nul", "com3", "LPT1"] {
            assert!(validate_profile_name(name).is_err(), "expected '{}' rejected", name);
        }
        assert!(validate_profile_name("console").is_ok());
    }

    #[test]
    fn test_canonical_profile_name_resolves_existing_casing() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("work")).unwrap();
        std::fs::write(tmp.path().join("Backup"), b"file, not a profile").unwrap();
        assert_eq!(canonical_profile_name(tmp.path(), "Work"), "work");
        assert_eq!(canonical_profile_name(tmp.path(), "kids"), "kids");
        // A plain file never canonicalizes a name onto itself.
        assert_eq!(canonical_profile_name(tmp.path(), "backup"), "backup");
    }

    #[test]
    fn test_create_ignores_stray_files_in_profiles_dir() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("Work"), b"stray file").unwrap();
        // A file named like the profile must not block creation... except via
        // the filesystem itself (case-insensitive fs collides on create_dir).
        match create_profile_in(tmp.path(), "work") {
            Ok(()) => assert!(tmp.path().join("work").is_dir()),
            Err(e) => assert!(e.contains("already exists") || e.contains("Failed to create"), "got: {}", e),
        }
    }

    #[test]
    fn test_validate_counts_chars_not_bytes() {
        // 33 Greek letters = 66 UTF-8 bytes; must pass a 64-char limit.
        let greek = "α".repeat(33);
        assert!(validate_profile_name(&greek).is_ok());
        assert!(validate_profile_name(&"α".repeat(65)).is_err());
    }

    #[test]
    fn test_pending_switch_request() {
        let argv = |s: &str| args(&["app", "--profile", s]);
        assert_eq!(pending_switch_request(&argv("b"), "a"), Some("b".into()));
        // Current profile (any casing) and invalid names are not requests.
        assert_eq!(pending_switch_request(&argv("Work"), "work"), None);
        assert_eq!(pending_switch_request(&argv("bad name"), "a"), None);
        // No flag at all → focus only.
        assert_eq!(pending_switch_request(&args(&["app"]), "a"), None);
    }

    #[test]
    fn test_create_rejects_invalid_name() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(create_profile_in(tmp.path(), "bad name").is_err());
        assert!(!tmp.path().join("bad name").exists());
    }

    #[test]
    fn test_list_filters_sorts_and_marks_current() {
        let tmp = tempfile::tempdir().unwrap();
        for dir in ["work", "Beta", "My Profile"] {
            std::fs::create_dir(tmp.path().join(dir)).unwrap();
        }
        std::fs::write(tmp.path().join(".DS_Store"), b"junk").unwrap();
        let entries = list_profiles_in(tmp.path(), "work").unwrap();
        assert_eq!(
            entries,
            vec![
                ProfileEntry { name: "Beta".into(), is_current: false },
                ProfileEntry { name: "work".into(), is_current: true },
            ]
        );
    }

    #[test]
    fn test_list_marks_current_case_insensitively() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("work")).unwrap();
        let entries = list_profiles_in(tmp.path(), "Work").unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].is_current);
    }
}
