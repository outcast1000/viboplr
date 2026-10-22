//! Programs a plugin downloads, unpacks and runs — `api.system.programs`.
//!
//! The host knows nothing about any particular program. A plugin (the slskd
//! plugin is the first) downloads a release into its own file store, unpacks
//! it, and starts the binary through these primitives; everything specific to
//! the program — where to get it, which version, its config file, its graceful
//! stop — lives in the plugin. What the host owns is what a plugin can't do
//! from a worker: unpacking, executing, detaching and stopping by pid.
//!
//! Three rules hold everything together:
//!
//! - **Confined to the plugin's own store.** Every binary, working directory
//!   and archive is a path inside `{profile}/plugin-cache/<pluginId>/`,
//!   canonicalised (so a symlink can't lead out) by the same helpers the
//!   file-store commands use.
//! - **The registry lives outside that store.** What was started, with which
//!   pid, is written to `{profile}/plugin-programs/<pluginId>/<name>.json`,
//!   which the plugin's file API cannot reach. Otherwise a plugin could write a
//!   foreign pid there and have the host stop it. Every pid is also re-checked
//!   against the store before use (`process::is_ours`).
//! - **Independent by default.** A program outlives Vibo (`outliveApp`, on
//!   unless the plugin asks otherwise). Disabling the plugin leaves it running;
//!   uninstalling the plugin stops it (`remove_all`).
//! - **Started only from inside Vibo.** There are no login items (owner
//!   decision, 2026-10-19): the plugin starts its program when it needs it —
//!   e.g. on activation, if its own settings say so — and stops it. A user who
//!   wants it running without Vibo registers it with the OS themselves. So
//!   every start is in this process, under `approved::store_lock`.
//!
//! - **Only what the user approved runs.** A binary must have arrived through
//!   `download` (which the host confirms with the user) or `extract` of such a
//!   download, with its bytes unchanged since — see `approved.rs`. Anything
//!   else is refused at execute; nothing is asked there.
//!
//! The permission (`programs:run`, always asked; a second, warned consent for
//! an unsigned plugin) is enforced in the frontend bridge, like every other
//! worker permission — see plugins.md "api.system.programs".

pub mod approved;
pub mod archive;
pub mod process;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Registry folder, beside `plugin-cache` in the profile dir.
const REGISTRY_DIR: &str = "plugin-programs";
/// How long `start` watches a fresh process for an immediate exit.
const STARTUP_WATCH: Duration = Duration::from_millis(1500);
/// Default and ceiling for a one-shot run.
pub const RUN_DEFAULT_TIMEOUT_SECS: u64 = 60;
pub const RUN_MAX_TIMEOUT_SECS: u64 = 600;
/// Per stream, for a one-shot run's captured output.
const RUN_OUTPUT_CAP: usize = 1024 * 1024;

/// A program's name, chosen by the plugin: the registry key, the log file name
/// and part of the login item's label, so it is held to a filename-safe set.
pub fn validate_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !name.starts_with('.');
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid program name {name:?}: use 1-64 letters, digits, '-', '_' or '.'"))
    }
}

/// A plugin id names a folder (its store, its registry), so it is held to the
/// file-store's segment rules — which also refuse `"."`, the id that would
/// otherwise make the whole `plugin-cache` folder one plugin's store.
fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    crate::commands::validate_path_segment(plugin_id).map_err(|_| "Invalid plugin ID".to_string())
}

/// The plugin's own file store — the same root `api.storage.files` writes to.
pub fn store_root(app_dir: &Path, plugin_id: &str) -> PathBuf {
    app_dir.join("plugin-cache").join(plugin_id)
}

fn registry_dir(app_dir: &Path, plugin_id: &str) -> PathBuf {
    app_dir.join(REGISTRY_DIR).join(plugin_id)
}

pub fn registry_path(app_dir: &Path, plugin_id: &str, name: &str) -> PathBuf {
    registry_dir(app_dir, plugin_id).join(format!("{name}.json"))
}

/// `logs/<name>.log` inside the plugin's store, so the plugin can read its
/// program's output with `api.storage.files.readText(["logs", "<name>.log"])`.
pub fn log_path(app_dir: &Path, plugin_id: &str, name: &str) -> PathBuf {
    store_root(app_dir, plugin_id).join("logs").join(format!("{name}.log"))
}

/// A path inside the plugin's store, canonicalised. `must_exist` also checks it
/// is there; an empty `segments` is the store root itself.
pub fn resolve_in_store(app_dir: &Path, plugin_id: &str, segments: &[String], must_exist: bool) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;
    let root = store_root(app_dir, plugin_id);
    let target = if segments.is_empty() {
        std::fs::create_dir_all(&root).map_err(|e| format!("Couldn't create the plugin's folder: {e}"))?;
        root.clone()
    } else {
        crate::commands::resolve_plugin_path(app_dir, plugin_id, segments)?.1
    };
    crate::commands::ensure_within_root(&root, &target)?;
    if must_exist && !target.exists() {
        return Err(format!("{} doesn't exist", segments.join("/")));
    }
    Ok(without_verbatim_prefix(std::fs::canonicalize(&target).unwrap_or(target)))
}

/// Windows' `canonicalize` answers with a verbatim path (`\\?\C:\…`,
/// `\\?\UNC\server\share\…`). These paths become a program's working directory
/// and are handed to it in its arguments, where plenty of software (.NET's
/// single-file host among it) expects the ordinary form, so the prefix is
/// dropped again. Any other path is returned as it was. Pure string work, so
/// its test runs on every platform.
fn without_verbatim_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            return PathBuf::from(rest.to_string());
        }
    }
    p
}

/// What the plugin asks to start. Paths are store-relative segments. Exactly
/// one of `path` (a binary in the plugin's store) and `dependency` (Vibo's
/// managed copy of a tool the plugin's manifest lists) is given.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSpec {
    #[serde(default)]
    pub path: Option<Vec<String>>,
    #[serde(default)]
    pub dependency: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub cwd: Option<Vec<String>>,
    /// Keep running after Vibo quits. Defaults to true: programs are
    /// independent unless the plugin's own settings say otherwise.
    #[serde(default = "default_true")]
    pub outlive_app: bool,
}

fn default_true() -> bool {
    true
}

/// One started program, as the host remembers it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub plugin_id: String,
    pub name: String,
    pub exe: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    pub outlive_app: bool,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
    /// Started from Vibo's managed copy of this tool (`StartSpec::dependency`):
    /// `exe` lives in the shared bin dir, not the plugin's store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramStatus {
    pub name: String,
    /// Started at least once and not removed.
    pub registered: bool,
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
    pub outlive_app: bool,
    /// Absolute path of the program's output log (inside the plugin's store).
    pub log_path: String,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn read_registration(path: &Path) -> Option<Registration> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_registration(path: &Path, reg: &Registration) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(reg).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't write {}: {e}", path.display())
    })
}

/// The registration's pid, if that process is still alive and still running
/// a binary out of the plugin's store — or, for a dependency, out of that
/// tool's managed folder (or its one managed file).
fn running_pid(app_dir: &Path, reg: &Registration) -> Option<u32> {
    let pid = reg.pid?;
    let root = match &reg.dependency {
        None => store_root(app_dir, &reg.plugin_id),
        Some(dep) => dependency_root(dep, &reg.exe)?,
    };
    process::is_ours(pid, &root).then_some(pid)
}

/// What a dependency registration's process must be running from. Read off
/// the bin dir, not the definition in force, so an uninstall that already
/// dropped the definition can still stop it.
fn dependency_root(dep: &str, exe: &Path) -> Option<PathBuf> {
    let bin = crate::dependencies::managed_bin_dir()?;
    let folder = bin.join(dep);
    if folder.is_dir() {
        return Some(folder);
    }
    (exe.parent() == Some(bin)).then(|| exe.to_path_buf())
}

/// Tools whose managed copy an install is replacing right now. A start of one
/// is refused until the install is done, so a plugin polling its service can't
/// launch the old copy while its folder is being swapped.
static UPDATING: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Held by `dependency_install` from stopping the tool's services until just
/// before it starts them again.
pub struct UpdateGuard(String);

impl Drop for UpdateGuard {
    fn drop(&mut self) {
        let mut updating = UPDATING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = updating.iter().position(|n| *n == self.0) {
            updating.swap_remove(i);
        }
    }
}

/// Refused while another install of `name` holds it: two installs of one tool
/// share its download and staging paths, and each would stop and restart its
/// services.
pub fn begin_update(name: &str) -> Result<UpdateGuard, String> {
    let mut updating = UPDATING.lock().unwrap_or_else(|e| e.into_inner());
    if updating.iter().any(|n| n == name) {
        return Err(format!("{name} is already being updated"));
    }
    updating.push(name.to_string());
    Ok(UpdateGuard(name.to_string()))
}

fn is_updating(name: &str) -> bool {
    UPDATING.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|n| n == name)
}

/// The registrations of this profile whose dependency is `name` and that are
/// running now (what an update must stop and start again).
pub fn running_for_dependency(app_dir: &Path, name: &str) -> Vec<Registration> {
    let Ok(plugins) = std::fs::read_dir(app_dir.join(REGISTRY_DIR)) else { return Vec::new() };
    plugins
        .flatten()
        .flat_map(|p| registrations(&p.path()))
        .filter(|r| r.dependency.as_deref() == Some(name) && running_pid(app_dir, r).is_some())
        .collect()
}

/// This profile's registrations of tool `name`, with whether each is running
/// (the Tools row's status line).
pub fn services_for_dependency(app_dir: &Path, name: &str) -> Vec<(Registration, bool)> {
    let Ok(plugins) = std::fs::read_dir(app_dir.join(REGISTRY_DIR)) else { return Vec::new() };
    plugins
        .flatten()
        .flat_map(|p| registrations(&p.path()))
        .filter(|r| r.dependency.as_deref() == Some(name))
        .map(|r| {
            let running = running_pid(app_dir, &r).is_some();
            (r, running)
        })
        .collect()
}

// ---- Running a dependency (`StartSpec::dependency`) ---------------------

/// The error `start` answers with until the user agreed to let this plugin run
/// this tool in the background; the frontend asks and retries.
pub const DEPENDENCY_RUN_UNCONFIRMED: &str = "DEPENDENCY_RUN_UNCONFIRMED";

fn dependency_runs_path(app_dir: &Path, plugin_id: &str) -> PathBuf {
    registry_dir(app_dir, plugin_id).join(".dependency-runs")
}

fn read_dependency_runs(app_dir: &Path, plugin_id: &str) -> std::collections::BTreeMap<String, String> {
    std::fs::read_to_string(dependency_runs_path(app_dir, plugin_id))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// The managed copy of `dep` that `plugin_id` may start: the plugin lists the
/// tool, its definition is in force, Vibo installed the copy in use (a system
/// copy is the user's own and never started), and that copy came from the
/// definition in force.
fn dependency_exe(plugin_id: &str, dep: &str) -> Result<PathBuf, String> {
    if !crate::dependency_registry::declares(plugin_id, dep) {
        return Err(format!("{dep} isn't in this plugin's binaryDependencies"));
    }
    let def = crate::dependencies::get_def(dep).ok_or_else(|| format!("No definition of {dep} is in force"))?;
    if def.managed.is_none() {
        return Err(format!("Vibo doesn't install {dep}, so it can't start it"));
    }
    let exe = crate::dependencies::managed_binary_path(dep)
        .ok_or_else(|| format!("{dep} isn't installed by Vibo (Extensions → Tools)"))?;
    if let Some(bin) = crate::dependencies::managed_bin_dir() {
        if bin.join(format!("{dep}.pyz")).is_file() {
            return Err(format!("{dep} is installed as a Python app and can't run in the background"));
        }
    }
    if crate::dependencies::source_mismatch(dep) {
        return Err(format!("{dep} came from another source; reinstall it in Extensions → Tools"));
    }
    Ok(exe)
}

/// The user agreed that `plugin_id` may run `dep` in the background. Recorded
/// against the definition's fingerprint, i.e. its source: an update of the
/// same source doesn't ask again, a plugin moving the source does.
pub fn confirm_dependency_run(app_dir: &Path, plugin_id: &str, dep: &str) -> Result<(), String> {
    validate_plugin_id(plugin_id)?;
    dependency_exe(plugin_id, dep)?;
    let def = crate::dependencies::get_def(dep).ok_or_else(|| format!("No definition of {dep} is in force"))?;
    let mut runs = read_dependency_runs(app_dir, plugin_id);
    runs.insert(dep.to_string(), crate::dependencies::fingerprint(def));
    let path = dependency_runs_path(app_dir, plugin_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(&runs).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Couldn't record the consent: {e}"))
}

fn require_dependency_run(app_dir: &Path, plugin_id: &str, dep: &str) -> Result<(), String> {
    let def = crate::dependencies::get_def(dep).ok_or_else(|| format!("No definition of {dep} is in force"))?;
    let fingerprint = crate::dependencies::fingerprint(def);
    if read_dependency_runs(app_dir, plugin_id).get(dep) == Some(&fingerprint) {
        Ok(())
    } else {
        Err(format!("{DEPENDENCY_RUN_UNCONFIRMED}: {dep}"))
    }
}

fn status_of(app_dir: &Path, plugin_id: &str, name: &str, reg: Option<&Registration>) -> ProgramStatus {
    let pid = reg.and_then(|r| running_pid(app_dir, r));
    ProgramStatus {
        name: name.to_string(),
        registered: reg.is_some(),
        running: pid.is_some(),
        pid,
        started_at: pid.and(reg.and_then(|r| r.started_at)),
        outlive_app: reg.map(|r| r.outlive_app).unwrap_or(true),
        log_path: log_path(app_dir, plugin_id, name).to_string_lossy().into_owned(),
    }
}

pub fn status(app_dir: &Path, plugin_id: &str, name: &str) -> Result<ProgramStatus, String> {
    validate_plugin_id(plugin_id)?;
    validate_name(name)?;
    let reg = read_registration(&registry_path(app_dir, plugin_id, name));
    Ok(status_of(app_dir, plugin_id, name, reg.as_ref()))
}

/// Every program this plugin has registered.
pub fn list(app_dir: &Path, plugin_id: &str) -> Result<Vec<ProgramStatus>, String> {
    validate_plugin_id(plugin_id)?;
    let mut out = Vec::new();
    for reg in registrations(&registry_dir(app_dir, plugin_id)) {
        out.push(status_of(app_dir, plugin_id, &reg.name.clone(), Some(&reg)));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn registrations(dir: &Path) -> Vec<Registration> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| read_registration(&e.path()))
        .collect()
}

fn validate_env(env: &std::collections::BTreeMap<String, String>) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::with_capacity(env.len());
    for (k, v) in env {
        if k.is_empty() || k.contains('=') || k.contains('\0') || v.contains('\0') {
            return Err(format!("Invalid environment variable {k:?}"));
        }
        out.push((k.clone(), v.clone()));
    }
    Ok(out)
}

fn validate_args(args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| a.contains('\0')) {
        return Err("An argument contains a NUL character".to_string());
    }
    Ok(())
}

/// Make a file the plugin unpacked executable (owner, group and other x bits
/// where read is set). Zip archives often lose the mode; a Windows exe needs
/// nothing.
pub fn ensure_executable(path: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode();
        let wanted = mode | ((mode & 0o444) >> 2) | 0o100;
        if wanted != mode {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(wanted))
                .map_err(|e| format!("Couldn't make {} executable: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// Start `reg` detached and stamp its pid, refusing a binary the user never
/// approved (`approved.rs`). The caller holds `approved::store_lock`.
fn launch(app_dir: &Path, reg: &mut Registration) -> Result<u32, String> {
    let root = store_root(app_dir, &reg.plugin_id);
    crate::commands::ensure_within_root(&root, &reg.cwd)?;
    match reg.dependency.clone() {
        None => {
            crate::commands::ensure_within_root(&root, &reg.exe)?;
            approved::require(app_dir, &reg.plugin_id, &reg.exe)?;
            ensure_executable(&reg.exe)?;
        }
        // Vibo's own install, verified when it was downloaded; its modes were set
        // then, and a shared cross-profile file is never chmod-ed from here.
        Some(dep) => {
            if is_updating(&dep) {
                return Err(format!("{dep} is being updated; start it again in a moment"));
            }
            let exe = dependency_exe(&reg.plugin_id, &dep)?;
            if exe != reg.exe {
                return Err(format!("{dep} moved since it was registered; start it again"));
            }
            require_dependency_run(app_dir, &reg.plugin_id, &dep)?;
        }
    }
    let plan = process::SpawnPlan {
        exe: reg.exe.clone(),
        args: reg.args.clone(),
        env: reg.env.clone(),
        cwd: reg.cwd.clone(),
        log: log_path(app_dir, &reg.plugin_id, &reg.name),
    };
    let pid = process::spawn_detached(&plan)?;
    reg.pid = Some(pid);
    reg.started_at = Some(now_secs());
    write_registration(&registry_path(app_dir, &reg.plugin_id, &reg.name), reg)?;
    log::info!("plugin programs: {}:{} started (pid {pid}) — {}", reg.plugin_id, reg.name, reg.exe.display());
    Ok(pid)
}

/// Start a program, or report the one already running under that name — a
/// second copy is never started.
pub fn start(app_dir: &Path, plugin_id: &str, name: &str, spec: &StartSpec) -> Result<ProgramStatus, String> {
    validate_plugin_id(plugin_id)?;
    validate_name(name)?;
    validate_args(&spec.args)?;
    let env = validate_env(&spec.env)?;
    let reg_path = registry_path(app_dir, plugin_id, name);
    if let Some(existing) = read_registration(&reg_path) {
        if running_pid(app_dir, &existing).is_some() {
            return Ok(status_of(app_dir, plugin_id, name, Some(&existing)));
        }
    }
    let (exe, dependency) = match (&spec.path, &spec.dependency) {
        (Some(path), None) => (resolve_in_store(app_dir, plugin_id, path, true)?, None),
        (None, Some(dep)) => (dependency_exe(plugin_id, dep)?, Some(dep.clone())),
        _ => return Err("Give exactly one of `path` and `dependency`".to_string()),
    };
    let cwd = match (&spec.cwd, &dependency) {
        (Some(segments), _) => resolve_in_store(app_dir, plugin_id, segments, true)?,
        // Never the shared bin dir: a program's working folder is its plugin's.
        (None, Some(_)) => resolve_in_store(app_dir, plugin_id, &[], false)?,
        (None, None) => exe.parent().map(Path::to_path_buf).unwrap_or_else(|| store_root(app_dir, plugin_id)),
    };
    if !cwd.is_dir() {
        return Err(format!("{} is not a folder", cwd.display()));
    }
    let mut reg = Registration {
        plugin_id: plugin_id.to_string(),
        name: name.to_string(),
        exe,
        args: spec.args.clone(),
        env,
        cwd,
        outlive_app: spec.outlive_app,
        pid: None,
        started_at: None,
        dependency,
    };
    let pid = {
        let _store = approved::store_lock();
        launch(app_dir, &mut reg)?
    };
    watch_startup(app_dir, plugin_id, name, pid)?;
    Ok(status_of(app_dir, plugin_id, name, Some(&reg)))
}

/// A program that exits at once (a bad config, a port taken, "already
/// running") would otherwise read as started; say why instead.
fn watch_startup(app_dir: &Path, plugin_id: &str, name: &str, pid: u32) -> Result<(), String> {
    let deadline = Instant::now() + STARTUP_WATCH;
    while Instant::now() < deadline {
        if !process::pid_alive(pid) {
            let tail = log_tail(&log_path(app_dir, plugin_id, name), 20);
            return Err(if tail.is_empty() {
                format!("{name} exited as soon as it started")
            } else {
                format!("{name} exited as soon as it started:\n{tail}")
            });
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

/// Start a registration again exactly as it was registered (the host's restart
/// after it updated the tool). Same checks as `start`.
pub fn restart(app_dir: &Path, reg: &Registration) -> Result<(), String> {
    let mut reg = reg.clone();
    if let Some(dep) = &reg.dependency {
        // The update may have moved the entry (a one-file copy became a folder).
        reg.exe = dependency_exe(&reg.plugin_id, dep)?;
    }
    let pid = {
        let _store = approved::store_lock();
        launch(app_dir, &mut reg)?
    };
    watch_startup(app_dir, &reg.plugin_id, &reg.name, pid)
}

pub fn stop(app_dir: &Path, plugin_id: &str, name: &str, grace: Duration) -> Result<ProgramStatus, String> {
    validate_plugin_id(plugin_id)?;
    validate_name(name)?;
    let reg = read_registration(&registry_path(app_dir, plugin_id, name));
    if let Some(pid) = reg.as_ref().and_then(|r| running_pid(app_dir, r)) {
        let how = process::stop(pid, grace)?;
        log::info!("plugin programs: {plugin_id}:{name} stopped (pid {pid}, {how:?})");
    }
    Ok(status_of(app_dir, plugin_id, name, reg.as_ref()))
}

/// Stop it and forget it. The plugin's files stay.
pub fn remove(app_dir: &Path, plugin_id: &str, name: &str) -> Result<(), String> {
    stop(app_dir, plugin_id, name, Duration::from_secs(10))?;
    match std::fs::remove_file(registry_path(app_dir, plugin_id, name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Couldn't forget {name}: {e}")),
    }
}

/// Plugin uninstall: every program it started is stopped and forgotten —
/// otherwise they would keep running with no UI left to stop them. Best
/// effort per program; failures are logged.
pub fn remove_all(app_dir: &Path, plugin_id: &str) {
    if validate_plugin_id(plugin_id).is_err() {
        return;
    }
    let dir = registry_dir(app_dir, plugin_id);
    for reg in registrations(&dir) {
        if let Err(e) = remove(app_dir, plugin_id, &reg.name) {
            log::warn!("plugin programs: couldn't remove {plugin_id}:{}: {e}", reg.name);
        }
    }
    approved::forget_all(app_dir, plugin_id);
    let _ = std::fs::remove_file(dependency_runs_path(app_dir, plugin_id));
    let _ = std::fs::remove_dir(&dir);
}

/// Is a program that asked not to outlive Vibo (`outliveApp: false`) running?
/// Decides whether a quit waits for the plugins (`quit_handshake`).
pub fn has_running_tied_to_app(app_dir: &Path) -> bool {
    let Ok(plugins) = std::fs::read_dir(app_dir.join(REGISTRY_DIR)) else { return false };
    plugins
        .flatten()
        .flat_map(|p| registrations(&p.path()))
        .any(|reg| !reg.outlive_app && running_pid(app_dir, &reg).is_some())
}

/// App exit: stop the programs whose plugin asked them not to outlive Vibo.
/// The backstop after `quit_handshake` gave each plugin the chance to stop its
/// own cleanly.
pub fn stop_tied_to_app(app_dir: &Path) {
    let Ok(plugins) = std::fs::read_dir(app_dir.join(REGISTRY_DIR)) else { return };
    for plugin in plugins.flatten() {
        for reg in registrations(&plugin.path()) {
            if reg.outlive_app {
                continue;
            }
            if let Some(pid) = running_pid(app_dir, &reg) {
                match process::stop(pid, Duration::from_secs(5)) {
                    Ok(how) => log::info!("plugin programs: {}:{} stopped with Vibo ({how:?})", reg.plugin_id, reg.name),
                    Err(e) => log::warn!("plugin programs: {}:{} didn't stop with Vibo: {e}", reg.plugin_id, reg.name),
                }
            }
        }
    }
}

/// Last `lines` lines of a log file.
pub fn log_tail(path: &Path, lines: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// The one-shot result, same shape as `api.system.exec`.
#[derive(Debug)]
pub struct RunOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run a binary from the plugin's store to completion (a `--version` probe, a
/// config check), killed after `timeout`.
pub fn run(
    app_dir: &Path,
    plugin_id: &str,
    path: &[String],
    args: &[String],
    env: &std::collections::BTreeMap<String, String>,
    cwd: Option<&[String]>,
    timeout: Duration,
) -> Result<RunOutput, String> {
    validate_args(args)?;
    let env = validate_env(env)?;
    let exe = resolve_in_store(app_dir, plugin_id, path, true)?;
    let cwd = match cwd {
        Some(segments) => resolve_in_store(app_dir, plugin_id, segments, true)?,
        None => exe.parent().map(Path::to_path_buf).unwrap_or_else(|| store_root(app_dir, plugin_id)),
    };
    // Held from the check until the child has exec'd, so the plugin can't swap
    // the file in between.
    let store = approved::store_lock();
    approved::require(app_dir, plugin_id, &exe)?;
    ensure_executable(&exe)?;

    let mut cmd = std::process::Command::new(&exe);
    cmd.args(args)
        .envs(env)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(process::CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't run {}: {e}", exe.display()))?;
    drop(store);
    let read_capped = |mut pipe: Box<dyn std::io::Read + Send>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // Keep draining past the cap so the child never blocks on a full pipe.
                        let room = RUN_OUTPUT_CAP.saturating_sub(buf.len());
                        buf.extend_from_slice(&chunk[..n.min(room)]);
                    }
                }
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = read_capped(Box::new(child.stdout.take().expect("piped stdout")));
    let err = read_capped(Box::new(child.stderr.take().expect("piped stderr")));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{} didn't finish within {}s", exe.display(), timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("Couldn't wait for {}: {e}", exe.display())),
        }
    };
    Ok(RunOutput {
        exit_code: status.code().unwrap_or(-1),
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_file(app_dir: &Path, plugin: &str, rel: &[&str], body: &str) -> PathBuf {
        let mut p = store_root(app_dir, plugin);
        for seg in rel {
            p.push(seg);
        }
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
        p
    }

    fn segs(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    /// What a confirmed download would have recorded for this file.
    fn approve(app_dir: &Path, plugin: &str, rel: &[&str]) {
        let path = rel.iter().fold(store_root(app_dir, plugin), |p, s| p.join(s));
        approved::record(app_dir, plugin, [(approved::key(&segs(rel)), approved::hash_file(&path).unwrap())]).unwrap();
    }

    #[test]
    fn test_program_names_are_filename_safe() {
        for ok in ["slskd", "my-tool_2", "a.b"] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", ".hidden", "a/b", "a b", "../x", &"x".repeat(65)] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn test_windows_verbatim_paths_lose_their_prefix() {
        assert_eq!(without_verbatim_prefix(PathBuf::from(r"\\?\C:\Users\a\slskd")), PathBuf::from(r"C:\Users\a\slskd"));
        assert_eq!(without_verbatim_prefix(PathBuf::from(r"\\?\UNC\nas\share\x")), PathBuf::from(r"\\nas\share\x"));
        // A verbatim path that isn't a drive or UNC path keeps its prefix.
        assert_eq!(without_verbatim_prefix(PathBuf::from(r"\\?\Volume{1}\x")), PathBuf::from(r"\\?\Volume{1}\x"));
        assert_eq!(without_verbatim_prefix(PathBuf::from("/Users/a/slskd")), PathBuf::from("/Users/a/slskd"));
    }

    #[test]
    fn test_paths_must_stay_inside_the_plugins_store() {
        let app = tempfile::tempdir().unwrap();
        store_file(app.path(), "p", &["bin", "tool"], "x");
        assert!(resolve_in_store(app.path(), "p", &segs(&["bin", "tool"]), true).is_ok());
        assert!(resolve_in_store(app.path(), "p", &segs(&["..", "q", "tool"]), true).is_err());
        assert!(resolve_in_store(app.path(), "p", &segs(&["bin", "missing"]), true).is_err());
        assert!(resolve_in_store(app.path(), "../p", &segs(&["bin"]), false).is_err());
        for bad in [".", "..", "", "a/b", "a\0b"] {
            assert!(validate_plugin_id(bad).is_err(), "{bad:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn test_a_symlink_out_of_the_store_is_refused() {
        let app = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("evil"), "x").unwrap();
        let root = store_root(app.path(), "p");
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(outside.path().join("evil"), root.join("link")).unwrap();
        assert!(resolve_in_store(app.path(), "p", &segs(&["link"]), true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn test_unpacked_files_are_made_executable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("tool");
        std::fs::write(&f, "x").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        ensure_executable(&f).unwrap();
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn test_run_captures_output_and_times_out() {
        let app = tempfile::tempdir().unwrap();
        store_file(app.path(), "p", &["bin", "hi.sh"], "#!/bin/sh\necho \"out $X\"\necho err >&2\nexit 3\n");
        approve(app.path(), "p", &["bin", "hi.sh"]);
        let mut env = std::collections::BTreeMap::new();
        env.insert("X".to_string(), "1".to_string());
        let r = run(app.path(), "p", &segs(&["bin", "hi.sh"]), &[], &env, None, Duration::from_secs(10)).unwrap();
        assert_eq!((r.exit_code, r.stdout.trim(), r.stderr.trim()), (3, "out 1", "err"));

        store_file(app.path(), "p", &["bin", "slow.sh"], "#!/bin/sh\nsleep 30\n");
        approve(app.path(), "p", &["bin", "slow.sh"]);
        let e = run(app.path(), "p", &segs(&["bin", "slow.sh"]), &[], &Default::default(), None, Duration::from_millis(300));
        assert!(e.unwrap_err().contains("didn't finish"));
    }

    /// A real binary copied into the store — a script would run as /bin/sh,
    /// whose image lives outside it, so liveness would (rightly) disown it.
    #[cfg(unix)]
    #[test]
    fn test_start_is_single_instance_and_stop_stops_it() {
        let app = tempfile::tempdir().unwrap();
        let bin = store_root(app.path(), "p").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::copy("/bin/sleep", bin.join("sleeper")).unwrap();
        // macOS kills a copied platform binary on launch (SIGKILL); an ad-hoc
        // signature makes the copy an ordinary program again.
        #[cfg(target_os = "macos")]
        {
            let signed = std::process::Command::new("codesign")
                .args(["-f", "-s", "-"])
                .arg(bin.join("sleeper"))
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !signed {
                eprintln!("codesign unavailable; skipping");
                return;
            }
        }
        approve(app.path(), "p", &["bin", "sleeper"]);
        let spec = StartSpec {
            path: Some(segs(&["bin", "sleeper"])),
            dependency: None,
            args: vec!["30".into()],
            env: Default::default(),
            cwd: None,
            outlive_app: false,
        };
        let first = start(app.path(), "p", "d", &spec).unwrap();
        assert!(first.running, "{first:?}");
        assert!(!first.outlive_app);
        let again = start(app.path(), "p", "d", &spec).unwrap();
        assert_eq!(again.pid, first.pid, "a second start reports the running copy");
        assert_eq!(list(app.path(), "p").unwrap().len(), 1);

        assert!(has_running_tied_to_app(app.path()), "an outliveApp: false program holds the quit");
        stop_tied_to_app(app.path());
        assert!(!has_running_tied_to_app(app.path()));
        let after = status(app.path(), "p", "d").unwrap();
        assert!(after.registered && !after.running, "{after:?}");
        assert!(!process::pid_alive(first.pid.unwrap()));

        remove(app.path(), "p", "d").unwrap();
        assert!(!status(app.path(), "p", "d").unwrap().registered);
    }

    #[cfg(unix)]
    #[test]
    fn test_a_program_that_exits_at_once_reports_its_output() {
        let app = tempfile::tempdir().unwrap();
        store_file(app.path(), "p", &["bin", "fail.sh"], "#!/bin/sh\necho 'port 5030 is taken'\nexit 1\n");
        approve(app.path(), "p", &["bin", "fail.sh"]);
        let spec = StartSpec {
            path: Some(segs(&["bin", "fail.sh"])),
            dependency: None,
            args: vec![],
            env: Default::default(),
            cwd: None,
            outlive_app: true,
        };
        let err = start(app.path(), "p", "f", &spec).unwrap_err();
        assert!(err.contains("port 5030 is taken"), "{err}");
    }

    /// A real binary installed as Vibo's managed copy of a folder tool, with a
    /// bundled plugin declaring it (from `repo`). The caller holds
    /// `dependency_registry::TEST_SERIAL`. False when the copy can't run here.
    #[cfg(unix)]
    fn managed_service(plugins: &Path, app: &Path, tool: &str, repo: &str) -> bool {
        crate::dependencies::set_managed_bin_dir(std::env::temp_dir().join(format!("viboplr-test-bin-{}", std::process::id())));
        let bin = crate::dependencies::managed_bin_dir().unwrap();
        let folder = bin.join(tool);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::copy("/bin/sleep", folder.join(tool)).unwrap();
        #[cfg(target_os = "macos")]
        {
            let signed = std::process::Command::new("codesign")
                .args(["-f", "-s", "-"])
                .arg(folder.join(tool))
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !signed {
                eprintln!("codesign unavailable; skipping");
                return false;
            }
        }
        let mut entry = crate::dependency_registry::fixture_entry("slskd");
        entry["name"] = serde_json::json!(tool);
        entry["definition"]["managed"]["entry"] = serde_json::json!(tool);
        entry["definition"]["managed"]["repo"] = serde_json::json!(repo);
        // "lastfm" is on the bundle allow-list, so its definition counts as signed.
        let dir = plugins.join("lastfm");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::json!({ "id": "lastfm", "name": "Last.fm", "version": "1.0.0", "binaryDependencies": [entry] }).to_string(),
        )
        .unwrap();
        crate::dependency_registry::rebuild(
            app,
            vec![crate::dependency_registry::PluginRoot { dir: plugins.to_path_buf(), builtin: true, single: false }],
        );
        true
    }

    #[test]
    fn test_a_second_install_of_the_same_tool_is_refused_until_the_first_ends() {
        let first = begin_update("test-tool-concurrent").unwrap();
        let err = begin_update("test-tool-concurrent").err().unwrap();
        assert!(err.contains("already being updated"), "{err}");
        let other = begin_update("test-tool-other").unwrap();
        assert!(is_updating("test-tool-concurrent") && is_updating("test-tool-other"));
        drop(first);
        drop(other);
        assert!(!is_updating("test-tool-concurrent"));
        let again = begin_update("test-tool-concurrent");
        assert!(again.is_ok(), "the name is free again once the first install ends");
    }

    #[cfg(unix)]
    #[test]
    fn test_a_plugin_runs_the_managed_copy_of_a_tool_it_declares() {
        let app = tempfile::tempdir().unwrap();
        let plugins = tempfile::tempdir().unwrap();
        let tool = format!("demo-svc-{}", std::process::id());
        let _g = crate::dependency_registry::TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        if !managed_service(plugins.path(), app.path(), &tool, "example/svc") {
            return;
        }
        let spec = StartSpec {
            path: None,
            dependency: Some(tool.clone()),
            args: vec!["30".into()],
            env: Default::default(),
            cwd: None,
            outlive_app: true,
        };

        // Only a plugin that lists the tool, and only once the user agreed.
        let err = start(app.path(), "lyrics", "svc", &spec).unwrap_err();
        assert!(err.contains("isn't in this plugin's binaryDependencies"), "{err}");
        let err = start(app.path(), "lastfm", "svc", &spec).unwrap_err();
        assert!(err.starts_with(DEPENDENCY_RUN_UNCONFIRMED), "{err}");
        assert!(!status(app.path(), "lastfm", "svc").unwrap().registered, "a refused start registers nothing");

        confirm_dependency_run(app.path(), "lastfm", &tool).unwrap();
        let first = start(app.path(), "lastfm", "svc", &spec).unwrap();
        assert!(first.running, "{first:?}");
        let reg = read_registration(&registry_path(app.path(), "lastfm", "svc")).unwrap();
        assert_eq!(reg.dependency.as_deref(), Some(tool.as_str()));
        assert_eq!(
            std::fs::canonicalize(&reg.cwd).unwrap(),
            std::fs::canonicalize(store_root(app.path(), "lastfm")).unwrap(),
            "never the shared bin dir"
        );
        assert_eq!(running_for_dependency(app.path(), &tool).len(), 1);
        assert_eq!(services_for_dependency(app.path(), &tool), vec![(reg.clone(), true)]);

        // The host's restart around an update: same registration, no new consent.
        stop(app.path(), "lastfm", "svc", Duration::from_secs(5)).unwrap();
        assert!(running_for_dependency(app.path(), &tool).is_empty());
        restart(app.path(), &reg).unwrap();
        assert!(status(app.path(), "lastfm", "svc").unwrap().running);

        // A plugin that moves the source is asked again.
        stop(app.path(), "lastfm", "svc", Duration::from_secs(5)).unwrap();
        assert!(managed_service(plugins.path(), app.path(), &tool, "example/other"));
        let err = start(app.path(), "lastfm", "svc", &spec).unwrap_err();
        assert!(err.starts_with(DEPENDENCY_RUN_UNCONFIRMED), "{err}");

        // Uninstall stops it and forgets the consent.
        confirm_dependency_run(app.path(), "lastfm", &tool).unwrap();
        let pid = start(app.path(), "lastfm", "svc", &spec).unwrap().pid.unwrap();
        remove_all(app.path(), "lastfm");
        assert!(!process::pid_alive(pid));
        assert!(!dependency_runs_path(app.path(), "lastfm").exists());

        crate::dependency_registry::reset_for_tests();
        let _ = std::fs::remove_dir_all(crate::dependencies::managed_bin_dir().unwrap().join(&tool));
    }

    #[test]
    fn test_start_takes_exactly_one_of_path_and_dependency() {
        let app = tempfile::tempdir().unwrap();
        let both = StartSpec {
            path: Some(segs(&["bin", "x"])),
            dependency: Some("slskd".into()),
            args: vec![],
            env: Default::default(),
            cwd: None,
            outlive_app: true,
        };
        assert!(start(app.path(), "p", "x", &both).unwrap_err().contains("exactly one"));
        let neither = StartSpec { path: None, dependency: None, ..both };
        assert!(start(app.path(), "p", "x", &neither).unwrap_err().contains("exactly one"));
    }

    /// A file the plugin wrote itself (`api.storage.files`) never runs, and an
    /// approved one stops running once its bytes change.
    #[cfg(unix)]
    #[test]
    fn test_execute_refuses_what_the_user_did_not_approve() {
        let app = tempfile::tempdir().unwrap();
        let script = store_file(app.path(), "p", &["bin", "x.sh"], "#!/bin/sh\necho hi\n");
        let spec = StartSpec {
            path: Some(segs(&["bin", "x.sh"])),
            dependency: None,
            args: vec![],
            env: Default::default(),
            cwd: None,
            outlive_app: true,
        };
        let run_x = || run(app.path(), "p", &segs(&["bin", "x.sh"]), &[], &Default::default(), None, Duration::from_secs(10));
        assert!(run_x().unwrap_err().contains("wasn't installed"));
        assert!(start(app.path(), "p", "x", &spec).unwrap_err().contains("wasn't installed"));
        assert!(!status(app.path(), "p", "x").unwrap().registered, "a refused start registers nothing");

        approve(app.path(), "p", &["bin", "x.sh"]);
        assert_eq!(run_x().unwrap().stdout.trim(), "hi");

        std::fs::write(&script, "#!/bin/sh\necho evil\n").unwrap();
        assert!(run_x().unwrap_err().contains("has changed"));

        // A copy of an approved file under another name is not approved.
        std::fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        std::fs::copy(&script, script.with_file_name("y.sh")).unwrap();
        let e = run(app.path(), "p", &segs(&["bin", "y.sh"]), &[], &Default::default(), None, Duration::from_secs(10));
        assert!(e.unwrap_err().contains("wasn't installed"));
    }

    /// A registered program is relaunched through `launch`, so a binary
    /// swapped after its first start is refused on the next.
    #[cfg(unix)]
    #[test]
    fn test_launch_refuses_a_binary_changed_since_approval() {
        let app = tempfile::tempdir().unwrap();
        let exe = store_file(app.path(), "p", &["bin", "t.sh"], "#!/bin/sh\nsleep 1\n");
        approve(app.path(), "p", &["bin", "t.sh"]);
        std::fs::write(&exe, "#!/bin/sh\necho evil\n").unwrap();
        let mut reg = Registration {
            plugin_id: "p".into(),
            name: "t".into(),
            exe: exe.clone(),
            args: vec![],
            env: vec![],
            cwd: exe.parent().unwrap().to_path_buf(),
            outlive_app: true,
            pid: None,
            started_at: None,
            dependency: None,
        };
        assert!(launch(app.path(), &mut reg).unwrap_err().contains("has changed"));
        assert!(reg.pid.is_none());
    }

    #[test]
    fn test_a_registered_pid_that_is_not_ours_never_counts_as_running() {
        let app = tempfile::tempdir().unwrap();
        // Our own test process: alive, but its binary is not in the store.
        let reg = Registration {
            plugin_id: "p".into(),
            name: "x".into(),
            exe: store_root(app.path(), "p").join("x"),
            args: vec![],
            env: vec![],
            cwd: store_root(app.path(), "p"),
            outlive_app: true,
            pid: Some(std::process::id()),
            started_at: Some(1),
            dependency: None,
        };
        write_registration(&registry_path(app.path(), "p", "x"), &reg).unwrap();
        let s = status(app.path(), "p", "x").unwrap();
        assert!(s.registered && !s.running && s.pid.is_none());
        // And stop leaves that process alone.
        stop(app.path(), "p", "x", Duration::from_millis(100)).unwrap();
        assert!(process::pid_alive(std::process::id()));
    }
}
