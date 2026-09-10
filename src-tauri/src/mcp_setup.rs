//! "Connect an AI assistant" support for Settings → General → AI remote control.
//!
//! The MCP server (`mcp/viboplr-mcp.mjs`) ships **in the bundle** — see
//! `bundle.resources` in `tauri.conf.json`. It is deliberately not downloaded
//! from GitHub at runtime: the file is small, self-contained and already ours,
//! so fetching it would only add a failure mode and let a `main`-branch server
//! run against an older app. A bundled copy is version-matched for free.
//!
//! What is left is the part a user genuinely cannot be expected to work out:
//! the script's absolute path, and which `node` will actually run it. GUI apps
//! launch without the shell's PATH, so `"command": "node"` frequently resolves
//! to nothing — `docs/help.html` currently tells the user to go run
//! `which node` and paste the result, which is a workaround for a question the
//! host can answer itself. `collect()` answers both.
//!
//! Node itself is **not** bundled and this cannot change that; when it is
//! missing or too old, that is reported so Settings can say so plainly instead
//! of the user discovering it as a server that silently never appears.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The MCP server requires Node 18+ (see `mcp/README.md`).
pub const MIN_NODE_MAJOR: u32 = 18;

/// Everything Settings needs to render the connect rows and build the config
/// block. Every field is optional because every one of them can legitimately
/// be absent, and the UI says which.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetupInfo {
    /// Absolute path of the bundled server script.
    pub script_path: Option<String>,
    /// Absolute path of the `node` that will run it.
    pub node_path: Option<String>,
    /// Raw `node --version` output (e.g. `v22.23.2`).
    pub node_version: Option<String>,
    /// Found, ran, and at least [`MIN_NODE_MAJOR`].
    pub node_ok: bool,
    /// Minimum major this build asks for, so the UI needn't restate it.
    pub min_node_major: u32,
    /// The running profile. `Some` only when it is **not** `default` — the MCP
    /// server picks `default` on its own, so the config block needs a
    /// `--profile=` argument exactly when this is set.
    pub profile: Option<String>,
}

/// Where the bundled script can be, most-preferred first.
///
/// Dev builds read it out of the repo, since there is no bundle yet; release
/// builds read it out of `Resources/mcp/`, which `tauri.conf.json` maps it
/// into. Same two-candidate shape as the native plugins dir in `lib.rs`.
pub fn script_candidates(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut c = Vec::new();
    #[cfg(debug_assertions)]
    {
        // CARGO_MANIFEST_DIR is src-tauri/; the script lives at the repo root.
        if let Some(repo) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            c.push(repo.join("mcp").join("viboplr-mcp.mjs"));
        }
    }
    if let Some(res) = resource_dir {
        c.push(res.join("mcp").join("viboplr-mcp.mjs"));
    }
    c
}

/// First candidate that is actually a file.
pub fn pick_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.is_file()).cloned()
}

/// Directories a `node` install lands in, in preference order.
///
/// These are the fixed locations. Version managers keep theirs under the home
/// directory and are appended by [`node_candidates`].
#[cfg(not(windows))]
const NODE_DIRS: &[&str] = &[
    "/opt/homebrew/bin", // Homebrew, Apple Silicon
    "/usr/local/bin",    // Homebrew on Intel, and the official macOS installer
    "/usr/bin",
    "/opt/local/bin", // MacPorts
];

#[cfg(windows)]
const NODE_DIRS: &[&str] = &[r"C:\Program Files\nodejs", r"C:\Program Files (x86)\nodejs"];

#[cfg(not(windows))]
const NODE_EXE: &str = "node";
#[cfg(windows)]
const NODE_EXE: &str = "node.exe";

/// Every path worth probing for `node`, most-preferred first.
///
/// PATH comes first: when the app *was* launched from a terminal it is both
/// correct and free, and when it wasn't it simply contributes nothing. The
/// fixed directories then cover the ordinary installs, and the version-manager
/// roots come last — a machine with nvm usually also has a system node, and the
/// system one is the more stable thing to bake into a config file.
pub fn node_candidates() -> Vec<PathBuf> {
    let mut c = Vec::new();

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            c.push(dir.join(NODE_EXE));
        }
    }
    for dir in NODE_DIRS {
        c.push(Path::new(dir).join(NODE_EXE));
    }

    if let Some(home) = home_dir() {
        // Volta and asdf expose a stable shim, so they need no version walk.
        c.push(home.join(".volta").join("bin").join(NODE_EXE));
        c.push(home.join(".asdf").join("shims").join(NODE_EXE));
        // nvm and fnm keep one directory per installed version.
        c.extend(newest_versioned(&home.join(".nvm").join("versions").join("node"), &["bin"]));
        c.extend(newest_versioned(
            &home.join(".fnm").join("node-versions"),
            &["installation", "bin"],
        ));
    }

    c.dedup();
    c
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// The `node` under the highest-numbered version directory in `root`.
///
/// Deliberately only the newest rather than all of them: these are fallbacks,
/// and probing every installed version of node on a developer's machine would
/// spawn a process per version to answer a question the first hit settles.
fn newest_versioned(root: &Path, tail: &[&str]) -> Option<PathBuf> {
    let mut versions: Vec<(Vec<u32>, PathBuf)> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            Some((parse_version_key(&name)?, e.path()))
        })
        .collect();
    versions.sort();
    let (_, newest) = versions.pop()?;
    let mut path = newest;
    for part in tail {
        path = path.join(part);
    }
    Some(path.join(NODE_EXE))
}

/// `"v22.23.2"` / `"22.23.2"` → `[22, 23, 2]`, for ordering version directories.
/// `None` for anything that isn't a version (nvm keeps aliases like `default`
/// in the same directory, and those must not sort as versions).
pub fn parse_version_key(name: &str) -> Option<Vec<u32>> {
    let trimmed = name.trim().trim_start_matches(['v', 'V']);
    if trimmed.is_empty() {
        return None;
    }
    trimmed.split('.').map(|p| p.parse::<u32>().ok()).collect()
}

/// Major version out of `node --version` output.
pub fn parse_node_major(output: &str) -> Option<u32> {
    parse_version_key(output.lines().next()?)?.first().copied()
}

/// Ask a candidate `node` for its version. `None` when it isn't there or won't
/// run — a candidate list is mostly misses by construction, so a failure here
/// is ordinary and not worth logging.
fn probe_node(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let out = Command::new(path).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// First candidate that runs and is new enough, else the first that runs at
/// all.
///
/// The fallback is what lets Settings say "you have Node 16, the server needs
/// 18" instead of "no Node found" — naming the version the user actually has is
/// the difference between an actionable message and a confusing one.
pub fn resolve_node(candidates: &[PathBuf]) -> Option<(PathBuf, String, bool)> {
    let mut too_old: Option<(PathBuf, String)> = None;
    for path in candidates {
        let Some(version) = probe_node(path) else { continue };
        let ok = parse_node_major(&version).is_some_and(|m| m >= MIN_NODE_MAJOR);
        if ok {
            return Some((path.clone(), version, true));
        }
        too_old.get_or_insert((path.clone(), version));
    }
    too_old.map(|(p, v)| (p, v, false))
}

/// Gather everything Settings needs. Blocking (filesystem walks plus a
/// subprocess per candidate), so callers must keep it off the main thread.
pub fn collect(resource_dir: Option<&Path>, profile_name: &str) -> McpSetupInfo {
    let script_path = pick_existing(&script_candidates(resource_dir))
        .map(|p| p.to_string_lossy().into_owned());
    let node = resolve_node(&node_candidates());

    McpSetupInfo {
        script_path,
        node_path: node.as_ref().map(|(p, _, _)| p.to_string_lossy().into_owned()),
        node_version: node.as_ref().map(|(_, v, _)| v.clone()),
        node_ok: node.as_ref().is_some_and(|(_, _, ok)| *ok),
        min_node_major: MIN_NODE_MAJOR,
        profile: (profile_name != "default").then(|| profile_name.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_keys_order_numerically_not_lexically() {
        // The bug this guards: "v9" sorts above "v22" as a string.
        let mut v = vec![
            parse_version_key("v9.1.0").unwrap(),
            parse_version_key("v22.23.2").unwrap(),
            parse_version_key("v18.0.0").unwrap(),
        ];
        v.sort();
        assert_eq!(v.last().unwrap(), &vec![22, 23, 2]);
    }

    #[test]
    fn test_nvm_aliases_are_not_versions() {
        // nvm keeps `default`/`stable` beside the version dirs; treating one as
        // a version would make it sort and possibly win.
        assert!(parse_version_key("default").is_none());
        assert!(parse_version_key("lts/hydrogen").is_none());
        assert!(parse_version_key("").is_none());
        assert!(parse_version_key("v").is_none());
    }

    #[test]
    fn test_node_major_is_read_from_version_output() {
        assert_eq!(parse_node_major("v22.23.2"), Some(22));
        assert_eq!(parse_node_major("v18.0.0\n"), Some(18));
        assert_eq!(parse_node_major("not a version"), None);
    }

    #[test]
    fn test_script_is_looked_for_under_the_resource_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let res = tmp.path();
        std::fs::create_dir_all(res.join("mcp")).unwrap();
        let script = res.join("mcp").join("viboplr-mcp.mjs");

        // Absent until it exists — a missing bundle must not report a path
        // that would land in a config file and fail at launch.
        let candidates = script_candidates(Some(res));
        assert!(candidates.contains(&script));
        std::fs::write(&script, "// server").unwrap();
        assert_eq!(pick_existing(&[script.clone()]), Some(script));
    }

    #[test]
    fn test_a_directory_is_not_accepted_as_the_script() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("viboplr-mcp.mjs");
        std::fs::create_dir(&dir).unwrap();
        assert_eq!(pick_existing(&[dir]), None);
    }

    /// Prints what the resolver finds on *this* machine. `#[ignore]`d because
    /// it asserts against the developer's own Node install and would fail on a
    /// CI runner with none (and on `ubuntu-latest` the fixed dirs are wrong).
    ///
    /// Recipe: `cargo test --lib probe_node_resolution -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn probe_node_resolution() {
        let candidates = node_candidates();
        println!("{} candidate paths", candidates.len());
        let found = resolve_node(&candidates);
        println!("resolved: {found:?}");
        let (path, version, ok) = found.expect("no node found on this machine");
        assert!(path.is_absolute(), "a config file needs an absolute path");
        assert!(ok, "found {version}, which is older than {MIN_NODE_MAJOR}");
    }

    #[test]
    fn test_only_a_named_profile_is_reported() {
        // The MCP server picks `default` itself, so the config block needs a
        // `--profile=` argument only for a named one.
        assert_eq!(collect(None, "default").profile, None);
        assert_eq!(collect(None, "perf").profile, Some("perf".to_string()));
    }
}
