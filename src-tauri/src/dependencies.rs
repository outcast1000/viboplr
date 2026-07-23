use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallInstructions {
    pub macos: &'static str,
    pub windows: &'static str,
    pub linux: &'static str,
    pub url: &'static str,
}

/// Where to fetch an app-managed copy of a binary from. All assets come from
/// GitHub releases of `repo`; a `None` asset means the platform/arch has no
/// managed binary and falls back to instruct-only install.
#[derive(Debug, Clone)]
pub struct ManagedSource {
    pub repo: &'static str,
    pub asset_macos: Option<&'static str>,
    pub asset_windows: Option<&'static str>,
    pub asset_linux_x64: Option<&'static str>,
    pub asset_linux_arm64: Option<&'static str>,
    /// Platform-independent zipapp asset from the same release, runnable by a
    /// system Python. On macOS the installer prefers this over the PyInstaller
    /// one-file binary when a suitable Python is present: the one-file form
    /// re-extracts itself on every launch so Gatekeeper re-assesses it every
    /// time (~16s per invocation); the zipapp is a stable on-disk file that
    /// starts in under a second.
    pub asset_zipapp: Option<&'static str>,
    pub checksums_asset: &'static str,
}

impl ManagedSource {
    pub fn platform_asset(&self) -> Option<&'static str> {
        #[cfg(target_os = "macos")]
        {
            self.asset_macos
        }
        #[cfg(target_os = "windows")]
        {
            self.asset_windows
        }
        #[cfg(target_os = "linux")]
        {
            if cfg!(target_arch = "aarch64") {
                self.asset_linux_arm64
            } else {
                self.asset_linux_x64
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct DependencyDef {
    pub name: &'static str,
    pub description: &'static str,
    pub version_args: &'static [&'static str],
    pub parse_version: fn(&str) -> Option<String>,
    pub install: InstallInstructions,
    pub internal_consumers: &'static [(&'static str, &'static str)],
    pub managed: Option<ManagedSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DepOrigin {
    /// The app-managed copy in the shared bin dir is the one in use.
    Managed,
    /// Found on the system PATH (package manager or manual install).
    System,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DepStatus {
    Installed { version: String, origin: DepOrigin },
    NotFound,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerInfo {
    pub name: String,
    pub reason: String,
    /// Whether this consumer marks the dependency as required (plugin consumers
    /// only; internal consumers are always treated as required → true).
    pub required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInfo {
    pub name: String,
    pub description: String,
    #[serde(flatten)]
    pub status: DepStatus,
    pub internal_consumers: Vec<ConsumerInfo>,
    pub plugin_consumers: Vec<ConsumerInfo>,
    pub install: InstallInstructions,
    /// True when this dependency has a managed source with an asset for the
    /// current platform — i.e. the app can install/update it itself.
    pub managed_available: bool,
    /// Latest released version, if the TTL cache has one (never fetched here).
    pub latest_version: Option<String>,
}

fn parse_ffmpeg_version(output: &str) -> Option<String> {
    output.lines().next().and_then(|line| {
        line.strip_prefix("ffmpeg version ")
            .map(|rest| rest.split_whitespace().next().unwrap_or("unknown").to_string())
    })
}

fn parse_ytdlp_version(output: &str) -> Option<String> {
    output.lines().next().map(|l| l.trim().to_string())
}

fn parse_fictional_version(output: &str) -> Option<String> {
    output.lines().next().map(|l| l.trim().to_string())
}

pub static REGISTRY: &[DependencyDef] = &[
    DependencyDef {
        name: "ffmpeg",
        description: "Audio/video transcoding and format conversion",
        version_args: &["-version"],
        parse_version: parse_ffmpeg_version,
        install: InstallInstructions {
            macos: "brew install ffmpeg",
            windows: "winget install Gyan.FFmpeg",
            linux: "sudo apt install ffmpeg",
            url: "https://ffmpeg.org/download.html",
        },
        internal_consumers: &[
            ("Video playback", "Transcode MKV/AVI/WMV to streamable MP4"),
            ("Video frame preview", "Extract thumbnail frames from video files"),
            ("Audio format conversion", "Convert WebM downloads to M4A"),
        ],
        managed: None,
    },
    DependencyDef {
        name: "yt-dlp",
        description: "YouTube video/audio downloading",
        version_args: &["--version"],
        parse_version: parse_ytdlp_version,
        install: InstallInstructions {
            macos: "brew install yt-dlp",
            windows: "winget install yt-dlp.yt-dlp",
            linux: "sudo apt install yt-dlp",
            url: "https://github.com/yt-dlp/yt-dlp#installation",
        },
        internal_consumers: &[],
        managed: Some(ManagedSource {
            repo: "yt-dlp/yt-dlp",
            asset_macos: Some("yt-dlp_macos"),
            asset_windows: Some("yt-dlp.exe"),
            asset_linux_x64: Some("yt-dlp_linux"),
            asset_linux_arm64: Some("yt-dlp_linux_aarch64"),
            asset_zipapp: Some("yt-dlp"),
            checksums_asset: "SHA2-256SUMS",
        }),
    },
    #[cfg(debug_assertions)]
    DependencyDef {
        name: "fictional-tool",
        description: "A fake dependency for testing the dependency UI (debug only)",
        version_args: &["--version"],
        parse_version: parse_fictional_version,
        install: InstallInstructions {
            macos: "brew install fictional-tool",
            windows: "winget install Fictional.Tool",
            linux: "sudo apt install fictional-tool",
            url: "https://example.com/fictional-tool",
        },
        internal_consumers: &[("Test feature", "Verifies the dependency modal works in dev mode")],
        managed: None,
    },
];

pub fn get_def(name: &str) -> Option<&'static DependencyDef> {
    REGISTRY.iter().find(|d| d.name == name)
}

/// Compare two version strings by numeric segments (handles "2024.10.22",
/// "7.1", a leading "v", and unequal segment counts). Non-numeric segments
/// compare as 0, so exotic versions (ffmpeg nightlies) never report outdated.
pub fn version_lt(installed: &str, latest: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim()
            .trim_start_matches('v')
            .split(|c: char| c == '.' || c == '-')
            .map(|s| s.parse().unwrap_or(0))
            .collect()
    };
    let a = parse(installed);
    let b = parse(latest);
    for i in 0..a.len().max(b.len()) {
        let av = a.get(i).copied().unwrap_or(0);
        let bv = b.get(i).copied().unwrap_or(0);
        if av != bv {
            return av < bv;
        }
    }
    false
}

/// Latest-version lookups are cached for 24h; failures are cached too so a
/// flaky network can't hammer the GitHub API (60 req/h unauthenticated).
const LATEST_VERSION_TTL: Duration = Duration::from_secs(24 * 60 * 60);

pub struct DepCache {
    entries: Mutex<HashMap<String, DepStatus>>,
    latest: Mutex<HashMap<String, (Instant, Option<String>)>>,
    /// Names with a version probe currently running. `check_single` claims a
    /// name here before spawning, so concurrent callers wait for that one
    /// probe instead of each spawning their own copy of the binary (a slow
    /// probe used to fan out into dozens of leaked processes).
    in_flight: Mutex<HashSet<String>>,
    probe_done: Condvar,
}

impl DepCache {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            latest: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(HashSet::new()),
            probe_done: Condvar::new(),
        }
    }

    pub fn get(&self, name: &str) -> Option<DepStatus> {
        self.entries.lock().unwrap().get(name).cloned()
    }

    pub fn set(&self, name: &str, status: DepStatus) {
        self.entries.lock().unwrap().insert(name.to_string(), status);
    }

    pub fn invalidate(&self, name: &str) {
        self.entries.lock().unwrap().remove(name);
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
    }

    /// Cached latest version if the entry is fresh. `Some(None)` means a fresh
    /// lookup failure (don't retry yet); `None` means no fresh entry.
    pub fn get_latest(&self, name: &str) -> Option<Option<String>> {
        self.latest
            .lock()
            .unwrap()
            .get(name)
            .filter(|(at, _)| at.elapsed() < LATEST_VERSION_TTL)
            .map(|(_, v)| v.clone())
    }

    pub fn set_latest(&self, name: &str, version: Option<String>) {
        self.latest
            .lock()
            .unwrap()
            .insert(name.to_string(), (Instant::now(), version));
    }
}

/// Directory holding app-managed binary copies. Shared across profiles
/// (`{app_data_dir}/bin`), set once during app setup.
static MANAGED_BIN_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_managed_bin_dir(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = MANAGED_BIN_DIR.set(dir);
}

pub fn managed_bin_dir() -> Option<&'static Path> {
    MANAGED_BIN_DIR.get().map(|p| p.as_path())
}

fn binary_filename(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{}.exe", name)
    } else {
        name.to_string()
    }
}

/// Path of the app-managed copy, if one has been installed.
pub fn managed_binary_path(name: &str) -> Option<PathBuf> {
    let path = managed_bin_dir()?.join(binary_filename(name));
    path.is_file().then_some(path)
}

/// PATH with the managed bin dir prepended (so app-managed copies win) and,
/// on macOS, common package-manager dirs appended (GUI apps don't inherit the
/// shell PATH).
pub fn augmented_path() -> std::ffi::OsString {
    use std::ffi::OsString;

    let current = std::env::var_os("PATH").unwrap_or_default();
    let sep = if cfg!(target_os = "windows") { ";" } else { ":" };

    let mut new_path = OsString::new();
    if let Some(bin_dir) = managed_bin_dir() {
        new_path.push(bin_dir);
        new_path.push(sep);
    }
    new_path.push(&current);

    #[cfg(target_os = "macos")]
    {
        let extra_dirs: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
        for dir in extra_dirs {
            if !current.to_string_lossy().contains(dir) {
                new_path.push(sep);
                new_path.push(dir);
            }
        }
    }
    new_path
}

pub fn command_with_path(program: &str) -> std::process::Command {
    // PATH lookup happens in the child's environment, but resolve the managed
    // copy explicitly so it wins even on platforms where the spawn resolves
    // the program against the parent PATH.
    let resolved = managed_binary_path(program)
        .map(|p| p.into_os_string())
        .unwrap_or_else(|| program.into());
    let mut cmd = std::process::Command::new(resolved);
    cmd.env("PATH", augmented_path());
    // Force Python UTF-8 Mode (see note below).
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

// UTF-8 note (env vars above): yt-dlp is a Python program; when its stdout is a
// pipe, CPython encodes text with the locale's preferred encoding — on Windows
// that's the ANSI code page (e.g. cp1253 on Greek Windows), not UTF-8 — so
// non-ASCII titles/metadata/paths come back as mojibake once the Rust side does
// `from_utf8_lossy`. `PYTHONUTF8=1` forces UTF-8 for stdio and the filesystem
// encoding regardless of locale; `PYTHONIOENCODING` pins stdio explicitly. Both
// are no-ops on already-UTF-8 platforms and are ignored by non-Python programs
// (ffmpeg).
pub fn tokio_command_with_path(program: &str) -> tokio::process::Command {
    let resolved = managed_binary_path(program)
        .map(|p| p.into_os_string())
        .unwrap_or_else(|| program.into());
    let mut cmd = tokio::process::Command::new(resolved);
    cmd.env("PATH", augmented_path());
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

/// Upper bound for a version probe. yt-dlp's PyInstaller binary can take
/// 15-20s to start on macOS, so this must be generous — it exists to bound
/// the damage of a wedged binary, not to police slow ones.
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// Removes the in-flight claim and wakes waiters even if the probe panics.
struct ProbeClaim<'a> {
    cache: &'a DepCache,
    name: &'a str,
}

impl Drop for ProbeClaim<'_> {
    fn drop(&mut self) {
        self.cache.in_flight.lock().unwrap().remove(self.name);
        self.cache.probe_done.notify_all();
    }
}

pub fn check_single(name: &str, cache: &DepCache) -> DepStatus {
    let def = match REGISTRY.iter().find(|d| d.name == name) {
        Some(d) => d,
        None => {
            let status = DepStatus::Error {
                message: format!("Unknown dependency: {}", name),
            };
            cache.set(name, status.clone());
            return status;
        }
    };

    // Single-flight: exactly one thread runs the probe for a given name;
    // everyone else blocks until its result lands in the cache. Loop because
    // a waiter can wake to find the entry already invalidated again.
    loop {
        if let Some(cached) = cache.get(name) {
            return cached;
        }
        {
            let mut in_flight = cache.in_flight.lock().unwrap();
            if in_flight.contains(name) {
                drop(
                    cache
                        .probe_done
                        .wait_while(in_flight, |set| set.contains(name))
                        .unwrap(),
                );
                continue;
            }
            in_flight.insert(name.to_string());
        }
        let _claim = ProbeClaim { cache, name };
        let status = run_probe(def);
        // Publish before the claim drops, so woken waiters find the result.
        cache.set(name, status.clone());
        return status;
    }
}

/// The binary `command_with_path` would run, if it can be located: the
/// managed copy first, then the augmented PATH. Used to key the persistent
/// probe cache; when this returns None the spawn is still attempted so any
/// exotic PATH resolution keeps working.
fn resolve_binary(name: &str) -> Option<(PathBuf, DepOrigin)> {
    if let Some(path) = managed_binary_path(name) {
        return Some((path, DepOrigin::Managed));
    }
    let filename = binary_filename(name);
    std::env::split_paths(&augmented_path())
        .map(|dir| dir.join(&filename))
        .find(|candidate| candidate.is_file())
        .map(|path| (path, DepOrigin::System))
}

fn run_probe(def: &DependencyDef) -> DepStatus {
    let resolved = resolve_binary(def.name);

    // The version is a property of the binary file: if this exact file
    // (path + mtime + size) was probed before — even in a past session —
    // reuse that result instead of paying the probe again.
    if let Some((path, origin)) = &resolved {
        if let Some(version) = persisted_probe_version(def.name, path) {
            return DepStatus::Installed { version, origin: *origin };
        }
    }

    let mut cmd = command_with_path(def.name);
    cmd.args(def.version_args);

    match output_with_timeout(&mut cmd, PROBE_TIMEOUT) {
        Ok(Some(output)) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let version = (def.parse_version)(&stdout)
                .unwrap_or_else(|| "unknown".to_string());
            // command_with_path prefers the managed copy, so if one exists
            // it is the one that just ran.
            let origin = if managed_binary_path(def.name).is_some() {
                DepOrigin::Managed
            } else {
                DepOrigin::System
            };
            if let Some((path, _)) = &resolved {
                persist_probe_version(def.name, path, &version);
            }
            DepStatus::Installed { version, origin }
        }
        Ok(Some(_)) => DepStatus::NotFound,
        Ok(None) => DepStatus::Error {
            message: format!(
                "{} did not answer a version check within {}s",
                def.name,
                PROBE_TIMEOUT.as_secs()
            ),
        },
        Err(_) => DepStatus::NotFound,
    }
}

/// `Command::output()` with an upper bound: returns Ok(None) if the child
/// doesn't exit in time, killing its whole process group so helper children
/// (PyInstaller binaries fork a bootstrap pair) die with it. The child's
/// output must fit the OS pipe buffer — fine for version banners.
fn output_with_timeout(
    cmd: &mut std::process::Command,
    timeout: Duration,
) -> std::io::Result<Option<std::process::Output>> {
    use std::process::Stdio;

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        // Own process group, so the timeout path can kill probe + children
        // together instead of orphaning the children.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output().map(Some);
        }
        if Instant::now() >= deadline {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait(); // reap
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

// --- Persistent probe cache ---
//
// Version probes are expensive (yt-dlp's PyInstaller binary takes ~15s to
// boot on macOS), so successful results are persisted next to the managed
// binaries, keyed by the probed file's identity (path + mtime + size). Any
// change to the binary — install, update, uninstall exposing a system copy —
// changes the key and forces a real probe. Failures are never persisted.

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProbeCacheEntry {
    path: String,
    mtime_secs: u64,
    size: u64,
    version: String,
}

fn probe_cache_file() -> Option<PathBuf> {
    managed_bin_dir().map(|d| d.join(".probe-cache.json"))
}

fn file_stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some((mtime, meta.len()))
}

fn read_probe_cache(file: &Path) -> HashMap<String, ProbeCacheEntry> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn lookup_probe_cache(file: &Path, name: &str, binary: &Path) -> Option<String> {
    let entry = read_probe_cache(file).remove(name)?;
    let (mtime_secs, size) = file_stamp(binary)?;
    (Path::new(&entry.path) == binary && entry.mtime_secs == mtime_secs && entry.size == size)
        .then_some(entry.version)
}

fn store_probe_cache(file: &Path, name: &str, binary: &Path, version: &str) {
    let Some((mtime_secs, size)) = file_stamp(binary) else { return };
    let mut map = read_probe_cache(file);
    map.insert(
        name.to_string(),
        ProbeCacheEntry {
            path: binary.to_string_lossy().into_owned(),
            mtime_secs,
            size,
            version: version.to_string(),
        },
    );
    // Temp + rename so a crash mid-write can't leave torn JSON behind.
    let tmp = file.with_extension("tmp");
    let Ok(json) = serde_json::to_string(&map) else { return };
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, file);
    }
}

fn persisted_probe_version(name: &str, binary: &Path) -> Option<String> {
    lookup_probe_cache(&probe_cache_file()?, name, binary)
}

fn persist_probe_version(name: &str, binary: &Path, version: &str) {
    if let Some(file) = probe_cache_file() {
        store_probe_cache(&file, name, binary, version);
    }
}

pub fn is_available(name: &str, cache: &DepCache) -> bool {
    matches!(check_single(name, cache), DepStatus::Installed { .. })
}

pub fn allowed_names() -> Vec<&'static str> {
    REGISTRY.iter().map(|d| d.name).collect()
}

// --- Managed install / update ---

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepUpdateInfo {
    pub name: String,
    pub installed: Option<String>,
    pub latest: Option<String>,
    pub outdated: bool,
    pub origin: Option<DepOrigin>,
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Viboplr")
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))
}

/// Latest release tag for a managed dependency, via the GitHub API.
/// Results (including failures) are cached for 24h in `cache`.
pub fn latest_version(name: &str, cache: &DepCache) -> Result<String, String> {
    if let Some(cached) = cache.get_latest(name) {
        return cached.ok_or_else(|| format!("Latest version lookup for {} failed recently", name));
    }

    let def = get_def(name).ok_or_else(|| format!("Unknown dependency: {}", name))?;
    let managed = def
        .managed
        .as_ref()
        .ok_or_else(|| format!("{} is not a managed dependency", name))?;

    let url = format!("https://api.github.com/repos/{}/releases/latest", managed.repo);
    let result: Result<String, String> = (|| {
        let resp = http_client()?
            .get(&url)
            .send()
            .map_err(|e| format!("HTTP error: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().map_err(|e| format!("Parse error: {}", e))?;
        json["tag_name"]
            .as_str()
            .map(|s| s.trim_start_matches('v').to_string())
            .ok_or_else(|| "No tag_name in release".to_string())
    })();

    cache.set_latest(name, result.as_ref().ok().cloned());
    result
}

/// Extract the hex digest for `asset` from a `<sha256>  <filename>` checksums
/// file (the format yt-dlp and most GitHub projects publish).
pub fn parse_checksum_line(checksums: &str, asset: &str) -> Option<String> {
    checksums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let file = parts.next()?;
        // Some tools prefix the filename with '*' for binary mode.
        (file.trim_start_matches('*') == asset).then(|| hash.to_lowercase())
    })
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

/// How the managed copy of a dependency is materialized on disk.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum InstallShape {
    /// The platform's standalone binary, installed as `{bin}/{name}`.
    Binary(&'static str),
    /// The zipapp asset installed as `{bin}/{name}.pyz`, plus a shell wrapper
    /// at `{bin}/{name}` that execs it under the given Python interpreter.
    Zipapp { asset: &'static str, python: PathBuf },
}

fn zipapp_filename(name: &str) -> String {
    format!("{}.pyz", name)
}

/// Minimum interpreter for the zipapp form (yt-dlp's own requirement).
#[cfg(target_os = "macos")]
const ZIPAPP_MIN_PYTHON: (u32, u32) = (3, 10);

/// Parse "Python 3.14.4" (stdout or stderr) into (major, minor).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // caller is macOS-only
fn parse_python_version(output: &str) -> Option<(u32, u32)> {
    let rest = output.trim().strip_prefix("Python ")?;
    let mut segments = rest.split('.');
    let major = segments.next()?.trim().parse().ok()?;
    let minor = segments.next()?.trim().parse().ok()?;
    Some((major, minor))
}

/// A Python new enough for the zipapp, from the usual install locations.
/// Probed with the same bounded runner as dependency checks.
#[cfg(target_os = "macos")]
fn find_zipapp_python() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/python3"),
        PathBuf::from("/usr/local/bin/python3"),
        PathBuf::from("/opt/local/bin/python3"),
    ];
    // Apple's /usr/bin/python3 is a stub that pops the Command Line Tools
    // install dialog when they're absent — only consider it when installed.
    if Path::new("/Library/Developer/CommandLineTools").is_dir() {
        candidates.push(PathBuf::from("/usr/bin/python3"));
    }
    candidates.into_iter().find(|python| {
        if !python.is_file() {
            return false;
        }
        let mut cmd = std::process::Command::new(python);
        cmd.arg("--version");
        match output_with_timeout(&mut cmd, Duration::from_secs(10)) {
            Ok(Some(out)) if out.status.success() => {
                let text = format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                parse_python_version(&text).is_some_and(|v| v >= ZIPAPP_MIN_PYTHON)
            }
            _ => false,
        }
    })
}

/// Prefer the zipapp form where it can run; fall back to the platform binary.
fn choose_install_shape(name: &str, managed: &ManagedSource) -> Result<InstallShape, String> {
    #[cfg(target_os = "macos")]
    if let Some(asset) = managed.asset_zipapp {
        if let Some(python) = find_zipapp_python() {
            log::info!("Installing {} as zipapp under {}", name, python.display());
            return Ok(InstallShape::Zipapp { asset, python });
        }
    }
    managed
        .platform_asset()
        .map(InstallShape::Binary)
        .ok_or_else(|| format!("{} has no managed binary for this platform", name))
}

/// Write the `{bin}/{name}` launcher for a zipapp install. Rewritten on every
/// install so its mtime tracks updates (it keys the persistent probe cache).
fn write_zipapp_wrapper(bin_dir: &Path, name: &str, python: &Path) -> Result<(), String> {
    let script = format!(
        "#!/bin/sh\n# Written by Viboplr: runs the managed {} zipapp under the system Python.\nexec \"{}\" \"{}\" \"$@\"\n",
        name,
        python.display(),
        bin_dir.join(zipapp_filename(name)).display(),
    );
    let tmp = bin_dir.join(format!(".{}.wrapper", name));
    std::fs::write(&tmp, script).map_err(|e| format!("Wrapper write error: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Wrapper chmod error: {}", e))?;
    }
    std::fs::rename(&tmp, bin_dir.join(binary_filename(name)))
        .map_err(|e| format!("Wrapper install error: {}", e))
}

/// Download + checksum-verify + atomically install the managed copy of `name`.
/// `progress` is called with (downloaded, total) as the body streams in.
/// Returns the installed version.
pub fn install_managed(
    name: &str,
    cache: &DepCache,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<String, String> {
    let def = get_def(name).ok_or_else(|| format!("Unknown dependency: {}", name))?;
    let managed = def
        .managed
        .as_ref()
        .ok_or_else(|| format!("{} is not a managed dependency", name))?;
    let bin_dir = managed_bin_dir().ok_or("Managed bin directory not initialized")?;

    let shape = choose_install_shape(name, managed)?;
    let (asset, dest_filename) = match &shape {
        InstallShape::Binary(asset) => (*asset, binary_filename(name)),
        InstallShape::Zipapp { asset, .. } => (*asset, zipapp_filename(name)),
    };

    let client = http_client()?;
    let base = format!("https://github.com/{}/releases/latest/download", managed.repo);

    // Stream the binary to a temp file next to the final location.
    let mut resp = client
        .get(format!("{}/{}", base, asset))
        .send()
        .map_err(|e| format!("Download error: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length();

    let temp_path = bin_dir.join(format!(".{}.download", dest_filename));
    let result: Result<String, String> = (|| {
        let mut data: Vec<u8> = Vec::with_capacity(total.unwrap_or(0) as usize);
        let mut buf = [0u8; 64 * 1024];
        let mut downloaded: u64 = 0;
        loop {
            use std::io::Read;
            let n = resp.read(&mut buf).map_err(|e| format!("Download read error: {}", e))?;
            if n == 0 {
                break;
            }
            data.extend_from_slice(&buf[..n]);
            downloaded += n as u64;
            progress(downloaded, total);
        }

        // Verify against the published checksums from the same release.
        let checksums = client
            .get(format!("{}/{}", base, managed.checksums_asset))
            .send()
            .map_err(|e| format!("Checksums download error: {}", e))?
            .text()
            .map_err(|e| format!("Checksums read error: {}", e))?;
        let expected = parse_checksum_line(&checksums, asset)
            .ok_or_else(|| format!("No checksum entry for {}", asset))?;
        let actual = sha256_hex(&data);
        if actual != expected {
            return Err(format!(
                "Checksum mismatch for {} (expected {}, got {})",
                asset, expected, actual
            ));
        }

        std::fs::write(&temp_path, &data).map_err(|e| format!("Write error: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("chmod error: {}", e))?;
        }

        // Atomic rename handles concurrent profiles; on Windows a running
        // binary holds a lock, so surface that as a retryable error.
        let final_path = bin_dir.join(&dest_filename);
        std::fs::rename(&temp_path, &final_path)
            .map_err(|e| format!("Install error (is {} running?): {}", name, e))?;

        match &shape {
            InstallShape::Zipapp { python, .. } => {
                write_zipapp_wrapper(bin_dir, name, python)?;
            }
            InstallShape::Binary(_) => {
                // Drop the companion zipapp if a previous install used that
                // shape — the binary just overwrote its wrapper.
                let _ = std::fs::remove_file(bin_dir.join(zipapp_filename(name)));
            }
        }

        cache.invalidate(name);
        match check_single(name, cache) {
            DepStatus::Installed { version, .. } => Ok(version),
            _ => Err(format!("{} installed but version check failed", name)),
        }
    })();

    if result.is_err() {
        // Best-effort temp cleanup; the install error is what matters.
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

/// Remove the app-managed copy of a dependency. After this, PATH resolution
/// falls back to any system copy. Returns the post-removal status so the caller
/// can report whether a system copy took over.
pub fn uninstall_managed(name: &str, cache: &DepCache) -> Result<DepStatus, String> {
    let def = get_def(name).ok_or_else(|| format!("Unknown dependency: {}", name))?;
    if def.managed.is_none() {
        return Err(format!("{} is not a managed dependency", name));
    }
    if let Some(path) = managed_binary_path(name) {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to remove {}: {}", name, e))?;
    }
    // Companion zipapp, if the managed copy was the wrapper shape.
    if let Some(dir) = managed_bin_dir() {
        let _ = std::fs::remove_file(dir.join(zipapp_filename(name)));
    }
    cache.invalidate(name);
    Ok(check_single(name, cache))
}

/// Whether silent auto-update of managed copies is enabled. Read straight
/// from the profile's store file (same pattern as `loggingEnabled` in lib.rs)
/// so the background thread needs no IPC. Default: enabled.
fn auto_update_enabled(store_path: &Path) -> bool {
    if let Ok(contents) = std::fs::read_to_string(store_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) {
            return json
                .get("autoUpdateManagedDeps")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
        }
    }
    true
}

/// One pass of the background auto-updater: for every managed dependency whose
/// in-use copy is the app-managed one and is older than the latest release,
/// reinstall it. System (package-manager) copies are never touched. Emits
/// `dependency-updated { name, from, to }` per successful update.
pub fn auto_update_managed(
    cache: &DepCache,
    store_path: &Path,
    emit: impl Fn(&str, serde_json::Value),
) {
    if !auto_update_enabled(store_path) {
        return;
    }

    for def in REGISTRY.iter() {
        let Some(managed) = def.managed.as_ref() else { continue };
        if managed.platform_asset().is_none() {
            continue;
        }
        // Re-probe: a copy may have been installed/removed since the cache filled.
        cache.invalidate(def.name);
        let DepStatus::Installed { version: installed, origin: DepOrigin::Managed } =
            check_single(def.name, cache)
        else {
            continue;
        };
        let latest = match latest_version(def.name, cache) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("Auto-update: latest version check for {} failed: {}", def.name, e);
                continue;
            }
        };
        if !version_lt(&installed, &latest) {
            continue;
        }
        log::info!("Auto-updating managed {} {} -> {}", def.name, installed, latest);
        match install_managed(def.name, cache, |_, _| {}) {
            Ok(new_version) => {
                emit(
                    "dependency-updated",
                    serde_json::json!({ "name": def.name, "from": installed, "to": new_version }),
                );
            }
            Err(e) => {
                // E.g. Windows file lock while the binary runs — retry next cycle.
                log::warn!("Auto-update of {} failed: {}", def.name, e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ffmpeg_version_standard() {
        let output = "ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers\nbuilt with Apple clang\n";
        assert_eq!(parse_ffmpeg_version(output), Some("7.1".to_string()));
    }

    #[test]
    fn test_parse_ffmpeg_version_nightly() {
        let output = "ffmpeg version N-12345-gabcdef0 Copyright (c) 2000-2024\n";
        assert_eq!(parse_ffmpeg_version(output), Some("N-12345-gabcdef0".to_string()));
    }

    #[test]
    fn test_parse_ffmpeg_version_no_prefix() {
        let output = "not ffmpeg output\n";
        assert_eq!(parse_ffmpeg_version(output), None);
    }

    #[test]
    fn test_parse_ffmpeg_version_empty() {
        assert_eq!(parse_ffmpeg_version(""), None);
    }

    #[test]
    fn test_parse_ytdlp_version() {
        let output = "2024.10.22\n";
        assert_eq!(parse_ytdlp_version(output), Some("2024.10.22".to_string()));
    }

    #[test]
    fn test_parse_ytdlp_version_with_whitespace() {
        let output = "  2024.10.22  \n";
        assert_eq!(parse_ytdlp_version(output), Some("2024.10.22".to_string()));
    }

    #[test]
    fn test_cache_get_set() {
        let cache = DepCache::new();
        assert!(cache.get("ffmpeg").is_none());

        cache.set("ffmpeg", DepStatus::Installed { version: "7.1".to_string(), origin: DepOrigin::System });
        let status = cache.get("ffmpeg").unwrap();
        assert!(matches!(status, DepStatus::Installed { version, .. } if version == "7.1"));
    }

    #[test]
    fn test_cache_invalidate() {
        let cache = DepCache::new();
        cache.set("ffmpeg", DepStatus::NotFound);
        assert!(cache.get("ffmpeg").is_some());

        cache.invalidate("ffmpeg");
        assert!(cache.get("ffmpeg").is_none());
    }

    #[test]
    fn test_cache_clear() {
        let cache = DepCache::new();
        cache.set("ffmpeg", DepStatus::NotFound);
        cache.set("yt-dlp", DepStatus::Installed { version: "1.0".to_string(), origin: DepOrigin::Managed });

        cache.clear();
        assert!(cache.get("ffmpeg").is_none());
        assert!(cache.get("yt-dlp").is_none());
    }

    #[test]
    fn test_check_single_unknown_dep() {
        let cache = DepCache::new();
        let status = check_single("nonexistent-program-xyz", &cache);
        assert!(matches!(status, DepStatus::Error { .. }));
    }

    #[test]
    fn test_check_single_not_found() {
        let cache = DepCache::new();
        // fictional-tool doesn't exist on any system
        let status = check_single("fictional-tool", &cache);
        assert!(matches!(status, DepStatus::NotFound));
        // Verify it was cached
        assert!(cache.get("fictional-tool").is_some());
    }

    #[test]
    fn test_check_single_uses_cache() {
        let cache = DepCache::new();
        cache.set("ffmpeg", DepStatus::Installed { version: "cached-version".to_string(), origin: DepOrigin::System });

        let status = check_single("ffmpeg", &cache);
        // Should return cached value without running the binary
        assert!(matches!(status, DepStatus::Installed { version, .. } if version == "cached-version"));
    }

    #[test]
    fn test_is_available_with_cached_installed() {
        let cache = DepCache::new();
        cache.set("ffmpeg", DepStatus::Installed { version: "7.1".to_string(), origin: DepOrigin::System });
        assert!(is_available("ffmpeg", &cache));
    }

    #[test]
    fn test_check_single_concurrent_single_flight() {
        // fictional-tool doesn't exist, so probes fail fast — this exercises
        // the claim/wait/wake plumbing across threads without hanging.
        let cache = std::sync::Arc::new(DepCache::new());
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let cache = std::sync::Arc::clone(&cache);
                std::thread::spawn(move || check_single("fictional-tool", &cache))
            })
            .collect();
        for h in handles {
            assert!(matches!(h.join().unwrap(), DepStatus::NotFound));
        }
        assert!(cache.in_flight.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn test_output_with_timeout_kills_slow_child() {
        let mut cmd = std::process::Command::new("/bin/sleep");
        cmd.arg("30");
        let start = Instant::now();
        let result = output_with_timeout(&mut cmd, Duration::from_millis(300)).unwrap();
        assert!(result.is_none());
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn test_output_with_timeout_captures_output() {
        let mut cmd = std::process::Command::new("/bin/echo");
        cmd.arg("hello");
        let output = output_with_timeout(&mut cmd, Duration::from_secs(10))
            .unwrap()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hello");
    }

    #[test]
    fn test_probe_cache_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let cache_file = dir.path().join("probe-cache.json");
        let binary = dir.path().join("fake-bin");
        std::fs::write(&binary, b"binary-bytes").unwrap();

        assert!(lookup_probe_cache(&cache_file, "yt-dlp", &binary).is_none());
        store_probe_cache(&cache_file, "yt-dlp", &binary, "2026.07.04");
        assert_eq!(
            lookup_probe_cache(&cache_file, "yt-dlp", &binary),
            Some("2026.07.04".to_string())
        );
        // A different dependency name doesn't match this entry.
        assert!(lookup_probe_cache(&cache_file, "ffmpeg", &binary).is_none());
    }

    #[test]
    fn test_parse_python_version() {
        assert_eq!(parse_python_version("Python 3.14.4\n"), Some((3, 14)));
        assert_eq!(parse_python_version("Python 3.9.6"), Some((3, 9)));
        assert_eq!(parse_python_version("Python 3.10"), Some((3, 10)));
        assert_eq!(parse_python_version("not python"), None);
        assert_eq!(parse_python_version(""), None);
    }

    #[test]
    fn test_choose_install_shape_binary_fallback() {
        // No zipapp asset declared → always the platform binary.
        let managed = ManagedSource {
            repo: "example/tool",
            asset_macos: Some("tool_macos"),
            asset_windows: Some("tool.exe"),
            asset_linux_x64: Some("tool_linux"),
            asset_linux_arm64: Some("tool_linux_aarch64"),
            asset_zipapp: None,
            checksums_asset: "SHA2-256SUMS",
        };
        let shape = choose_install_shape("tool", &managed).unwrap();
        assert!(matches!(shape, InstallShape::Binary(_)));
    }

    #[cfg(unix)]
    #[test]
    fn test_write_zipapp_wrapper() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let python = Path::new("/opt/homebrew/bin/python3");
        write_zipapp_wrapper(dir.path(), "yt-dlp", python).unwrap();

        let wrapper = dir.path().join("yt-dlp");
        let script = std::fs::read_to_string(&wrapper).unwrap();
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains("/opt/homebrew/bin/python3"));
        assert!(script.contains(&dir.path().join("yt-dlp.pyz").display().to_string()));
        assert!(script.trim_end().ends_with("\"$@\""));

        let mode = std::fs::metadata(&wrapper).unwrap().permissions().mode();
        assert_eq!(mode & 0o755, 0o755);
    }

    #[test]
    fn test_probe_cache_invalidated_by_binary_change() {
        let dir = tempfile::tempdir().unwrap();
        let cache_file = dir.path().join("probe-cache.json");
        let binary = dir.path().join("fake-bin");
        std::fs::write(&binary, b"v1").unwrap();
        store_probe_cache(&cache_file, "yt-dlp", &binary, "1.0");

        // Changing the size always breaks the stamp (mtime granularity can
        // be too coarse to rely on within a test).
        std::fs::write(&binary, b"v2-longer-content").unwrap();
        assert!(lookup_probe_cache(&cache_file, "yt-dlp", &binary).is_none());

        // A different path never matches, even with identical content.
        let other = dir.path().join("other-bin");
        std::fs::write(&other, b"v1").unwrap();
        assert!(lookup_probe_cache(&cache_file, "yt-dlp", &other).is_none());
    }

    #[test]
    fn test_is_available_with_cached_not_found() {
        let cache = DepCache::new();
        cache.set("ffmpeg", DepStatus::NotFound);
        assert!(!is_available("ffmpeg", &cache));
    }

    #[test]
    fn test_allowed_names_contains_known_deps() {
        let names = allowed_names();
        assert!(names.contains(&"ffmpeg"));
        assert!(names.contains(&"yt-dlp"));
    }

    #[test]
    fn test_allowed_names_includes_fictional_in_debug() {
        let names = allowed_names();
        assert!(names.contains(&"fictional-tool"));
    }

    #[test]
    fn test_registry_has_install_instructions() {
        for def in REGISTRY.iter() {
            assert!(!def.install.macos.is_empty(), "{} missing macos install", def.name);
            assert!(!def.install.windows.is_empty(), "{} missing windows install", def.name);
            assert!(!def.install.linux.is_empty(), "{} missing linux install", def.name);
            assert!(!def.install.url.is_empty(), "{} missing install url", def.name);
        }
    }

    #[test]
    fn test_version_lt_ytdlp_dates() {
        assert!(version_lt("2024.10.22", "2026.06.01"));
        assert!(version_lt("2026.05.31", "2026.06.01"));
        assert!(!version_lt("2026.06.01", "2026.06.01"));
        assert!(!version_lt("2026.06.01", "2024.10.22"));
    }

    #[test]
    fn test_version_lt_v_prefix_and_segments() {
        assert!(version_lt("v1.0", "1.0.1"));
        assert!(!version_lt("1.0.0", "v1.0"));
        assert!(version_lt("7.1", "7.1.1"));
        assert!(!version_lt("7.1.0", "7.1"));
    }

    #[test]
    fn test_version_lt_non_numeric_never_outdated() {
        // ffmpeg nightly builds: every segment parses as 0 on both sides of
        // the alpha part, so neither direction reports outdated spuriously
        // against an equal string.
        assert!(!version_lt("N-12345-gabcdef0", "N-12345-gabcdef0"));
    }

    #[test]
    fn test_parse_checksum_line() {
        let sums = "abc123  yt-dlp\nDEF456  yt-dlp_macos\n789ghi  *yt-dlp.exe\n";
        assert_eq!(parse_checksum_line(sums, "yt-dlp_macos"), Some("def456".to_string()));
        assert_eq!(parse_checksum_line(sums, "yt-dlp"), Some("abc123".to_string()));
        // '*' binary-mode prefix is stripped
        assert_eq!(parse_checksum_line(sums, "yt-dlp.exe"), Some("789ghi".to_string()));
        assert_eq!(parse_checksum_line(sums, "missing"), None);
    }

    #[test]
    fn test_sha256_hex() {
        // Known digest of the empty string
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn test_managed_source_ytdlp_all_platforms() {
        let def = get_def("yt-dlp").unwrap();
        let managed = def.managed.as_ref().unwrap();
        assert!(managed.asset_macos.is_some());
        assert!(managed.asset_windows.is_some());
        assert!(managed.asset_linux_x64.is_some());
        assert!(!managed.checksums_asset.is_empty());
        // Current platform resolves to an asset (all dev/CI platforms covered)
        assert!(managed.platform_asset().is_some());
    }

    #[test]
    fn test_ffmpeg_not_managed() {
        assert!(get_def("ffmpeg").unwrap().managed.is_none());
    }

    #[test]
    fn test_uninstall_managed_rejects_non_managed() {
        let cache = DepCache::new();
        assert!(uninstall_managed("ffmpeg", &cache).is_err());
        assert!(uninstall_managed("nonexistent-xyz", &cache).is_err());
    }

    #[test]
    fn test_latest_version_cache() {
        let cache = DepCache::new();
        assert!(cache.get_latest("yt-dlp").is_none());

        cache.set_latest("yt-dlp", Some("2026.06.01".to_string()));
        assert_eq!(cache.get_latest("yt-dlp"), Some(Some("2026.06.01".to_string())));

        // Cached failure is distinct from "no entry"
        cache.set_latest("yt-dlp", None);
        assert_eq!(cache.get_latest("yt-dlp"), Some(None));
    }

    #[test]
    fn test_managed_binary_path_none_without_init() {
        // MANAGED_BIN_DIR may be set by another test via set_managed_bin_dir,
        // but a binary named like this will never exist in it.
        assert!(managed_binary_path("definitely-not-a-real-binary-xyz").is_none());
    }

    // Regression guard: spawn helpers must force Python UTF-8 Mode so yt-dlp's
    // piped stdout is UTF-8 on Windows (else Greek/other non-ASCII titles come
    // back as mojibake). See the UTF-8 note on `command_with_path`.
    fn env_value<'a>(cmd: &'a std::process::Command, key: &str) -> Option<&'a str> {
        cmd.get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new(key))
            .and_then(|(_, v)| v)
            .and_then(|v| v.to_str())
    }

    #[test]
    fn test_command_with_path_forces_utf8_io() {
        let cmd = command_with_path("yt-dlp");
        assert_eq!(env_value(&cmd, "PYTHONUTF8"), Some("1"));
        assert_eq!(env_value(&cmd, "PYTHONIOENCODING"), Some("utf-8"));
    }

    #[test]
    fn test_tokio_command_with_path_forces_utf8_io() {
        let cmd = tokio_command_with_path("yt-dlp");
        let std_cmd = cmd.as_std();
        assert_eq!(env_value(std_cmd, "PYTHONUTF8"), Some("1"));
        assert_eq!(env_value(std_cmd, "PYTHONIOENCODING"), Some("utf-8"));
    }
}
