//! Binary dependencies that plugins define in their own manifest.
//!
//! A plugin's `binaryDependencies` entries say which tools it uses (`name`,
//! `required`, `reason`). An entry may also carry a `definition` — how to probe,
//! install and update the tool — so the host needs no code or data of its own
//! for a tool only plugins use (yt-dlp, rqbit). Everything downstream
//! (`dependencies.rs`: the Tools tab, managed installs, auto-update, the
//! `api.system.exec` allow-list) reads the definitions in force through
//! `dependencies::get_def` / `all_defs`, so a declared tool behaves exactly like
//! a built-in one.
//!
//! **Trust.** A definition is a promise about what the host will download and
//! run, so it is read only from files on disk, never from the webview (main-realm
//! code can invoke any command). A definition from a bundled plugin or one signed
//! by Vibo (`plugin_signing`, which covers `manifest.json`) is registered at once.
//! One from an unsigned plugin waits for the user's consent, recorded here in
//! `{profile}/plugin-dependencies/consent.json` against the definition's
//! fingerprint, so an update that changes the definition asks again. A plugin
//! whose signature is `invalid` contributes nothing.
//!
//! **Conflicts.** Identity is the tool's name (it is the program `exec` runs and
//! the file in the shared bin dir). Definitions with the same fingerprint
//! (`dependencies::fingerprint`) merge; a different one for a name already taken
//! is a conflict: a signed definition beats an unsigned one, otherwise the first
//! registered stays. The loser is not registered and the conflict is reported.

use crate::dependencies::{
    self, Checksum, DependencyDef, InstallInstructions, ManagedSource, OsTrust, VersionParser,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

/// A plugin folder root to scan, in precedence order.
#[derive(Debug, Clone)]
pub struct PluginRoot {
    pub dir: PathBuf,
    /// Shipped inside the app bundle: trusted like a signed plugin.
    pub builtin: bool,
    /// One folder that IS a plugin (the dev plugin path), id from its manifest.
    pub single: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingConsent {
    pub plugin_id: String,
    pub plugin_name: String,
    pub name: String,
    pub fingerprint: String,
    pub repo: Option<String>,
    pub verified: bool,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub name: String,
    pub kept: String,
    pub dropped: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Refused {
    pub plugin_id: String,
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryStatus {
    pub pending_consent: Vec<PendingConsent>,
    pub conflicts: Vec<Conflict>,
    pub refused: Vec<Refused>,
}

#[derive(Debug, Clone)]
struct Active {
    def: &'static DependencyDef,
    fingerprint: String,
    declared_by: Vec<String>,
    signed: bool,
}

#[derive(Default)]
struct Registry {
    active: Vec<Active>,
    /// Plugin id → every tool its `binaryDependencies` names, defined or only
    /// referenced: what `programs.start({ dependency })` checks (`declares`).
    uses: HashMap<String, Vec<String>>,
    status: RegistryStatus,
}

static REGISTRY: RwLock<Option<Registry>> = RwLock::new(None);
/// The inputs of the last rebuild, so a consent or an uninstall can rebuild
/// with the same roots (incl. the dev folder the frontend named).
static LAST_INPUTS: Mutex<Option<(PathBuf, Vec<PluginRoot>)>> = Mutex::new(None);
/// Definitions are leaked once each and reused: a rebuild that finds the same
/// definition again hands back the same `&'static`, so repeated rebuilds don't
/// grow memory. Keyed by the whole canonical definition.
static INTERNED: Mutex<Option<HashMap<String, &'static DependencyDef>>> = Mutex::new(None);

pub fn active_def(name: &str) -> Option<&'static DependencyDef> {
    let reg = REGISTRY.read().ok()?;
    reg.as_ref()?.active.iter().find(|a| a.def.name == name).map(|a| a.def)
}

pub fn active_defs() -> Vec<&'static DependencyDef> {
    let Ok(reg) = REGISTRY.read() else { return Vec::new() };
    reg.as_ref().map(|r| r.active.iter().map(|a| a.def).collect()).unwrap_or_default()
}

/// Plugin ids whose manifest defines `name` (empty for a built-in).
pub fn declared_by(name: &str) -> Vec<String> {
    let Ok(reg) = REGISTRY.read() else { return Vec::new() };
    reg.as_ref()
        .and_then(|r| r.active.iter().find(|a| a.def.name == name))
        .map(|a| a.declared_by.clone())
        .unwrap_or_default()
}

/// Does `plugin_id`'s manifest list `name` in `binaryDependencies` (with or
/// without a definition). Unlike `declared_by`, this counts references too.
pub fn declares(plugin_id: &str, name: &str) -> bool {
    let Ok(reg) = REGISTRY.read() else { return false };
    reg.as_ref()
        .and_then(|r| r.uses.get(plugin_id))
        .is_some_and(|names| names.iter().any(|n| n == name))
}

/// Is the definition of `name` Vibo's or a bundled / Vibo-signed plugin's
/// (shown in the Tools tab; nothing installs silently either way).
pub fn signed_definition(name: &str) -> bool {
    if let Ok(reg) = REGISTRY.read() {
        if let Some(a) = reg.as_ref().and_then(|r| r.active.iter().find(|a| a.def.name == name)) {
            return a.signed;
        }
    }
    dependencies::BUILTIN_REGISTRY.iter().any(|d| d.name == name)
}

pub fn status() -> RegistryStatus {
    REGISTRY
        .read()
        .ok()
        .and_then(|r| r.as_ref().map(|r| r.status.clone()))
        .unwrap_or_default()
}

// ---- Consent -----------------------------------------------------------

fn consent_file(profile_dir: &Path) -> PathBuf {
    profile_dir.join("plugin-dependencies").join("consent.json")
}

fn read_consent(profile_dir: &Path) -> HashMap<String, Vec<String>> {
    std::fs::read_to_string(consent_file(profile_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_consent(profile_dir: &Path, map: &HashMap<String, Vec<String>>) -> Result<(), String> {
    let file = consent_file(profile_dir);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(map).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

/// The user agreed to run these definitions of an unsigned plugin. Only
/// fingerprints that plugin is currently waiting on are recorded.
pub fn grant_consent(profile_dir: &Path, plugin_id: &str, fingerprints: &[String]) -> Result<(), String> {
    let pending = status().pending_consent;
    let mut map = read_consent(profile_dir);
    let entry = map.entry(plugin_id.to_string()).or_default();
    for fp in fingerprints {
        let waiting = pending.iter().any(|p| p.plugin_id == plugin_id && &p.fingerprint == fp);
        if !waiting {
            return Err(format!("{plugin_id} is not waiting for consent to that definition"));
        }
        if !entry.contains(fp) {
            entry.push(fp.clone());
        }
    }
    write_consent(profile_dir, &map)?;
    rebuild_again();
    Ok(())
}

/// Drop a plugin's consents (Revoke, uninstall).
pub fn revoke_consent(profile_dir: &Path, plugin_id: &str) -> Result<(), String> {
    let mut map = read_consent(profile_dir);
    if map.remove(plugin_id).is_some() {
        write_consent(profile_dir, &map)?;
    }
    rebuild_again();
    Ok(())
}

// ---- Parsing -----------------------------------------------------------

/// A validated definition, owned, before interning.
#[derive(Debug, Clone)]
struct Parsed {
    name: String,
    required: bool,
    description: String,
    version_args: Vec<String>,
    version_pattern: String,
    probe_env: Vec<(String, String)>,
    install: [String; 4],
    managed: Option<ParsedManaged>,
    os_trust: Option<(Vec<String>, Option<String>)>,
}

#[derive(Debug, Clone)]
struct ParsedManaged {
    repo: String,
    /// In `ASSET_KEYS` order.
    assets: [Option<String>; 8],
    zipapp: Option<String>,
    checksum: ParsedChecksum,
    folder_entry: Option<String>,
}

#[derive(Debug, Clone)]
enum ParsedChecksum {
    File(String),
    None,
    GitHub,
}

/// `managed.assets` keys; the arch-specific ones win over `macos` / `windows`.
const ASSET_KEYS: [&str; 8] = [
    "macos",
    "windows",
    "linux-x64",
    "linux-arm64",
    "macos-arm64",
    "macos-x64",
    "windows-x64",
    "windows-arm64",
];
const ALLOWED_CA_FILE_ENV: &[&str] = &["SSL_CERT_FILE"];
/// What a definition's `probeEnv` may set: slskd's .NET runtime switches.
const ALLOWED_PROBE_ENV: &[&str] = &["DOTNET_BUNDLE_EXTRACT_BASE_DIR", "DOTNET_CLI_TELEMETRY_OPTOUT", "DOTNET_NOLOGO"];
const HOST_ZIPAPP_PYTHON: (u32, u32) = (3, 10);

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    first_ok
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

fn valid_asset(asset: &str) -> bool {
    !asset.is_empty() && asset.len() <= 200 && !asset.contains('/') && !asset.contains('\\') && !asset.contains("..")
}

/// A plain file name that may carry `{version}` / `{tag}` (filled from the
/// release being installed) and no other `{…}`.
fn valid_asset_template(asset: &str) -> bool {
    let bare = asset.replace("{version}", "").replace("{tag}", "");
    !bare.contains('{') && !bare.contains('}') && valid_asset(asset) && valid_asset(&dependencies::with_tag(asset, "v1.0.0"))
}

fn is_archive_name(asset: &str) -> bool {
    let a = asset.to_ascii_lowercase();
    a.ends_with(".zip") || a.ends_with(".tar.gz") || a.ends_with(".tgz")
}

/// A `probeEnv` value: a short literal, or `{install}` / `{install}/<relative
/// path>` inside the managed folder.
fn valid_probe_env_value(value: &str) -> bool {
    let plain = |s: &str| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    match value.strip_prefix("{install}") {
        None => plain(value),
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('/')
            .is_some_and(|rel| rel.split('/').all(|seg| plain(seg) && seg != "." && seg != "..")),
    }
}

fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let ok = |s: Option<&str>| {
        s.is_some_and(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) && s != "..")
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

fn str_field(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> Result<Option<String>, String> {
    match obj.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("`{key}` must be a string")),
    }
}

fn only_keys(obj: &serde_json::Map<String, serde_json::Value>, allowed: &[&str], what: &str) -> Result<(), String> {
    match obj.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(format!("`{what}.{k}` is not understood by this version of Vibo — it needs a newer Vibo")),
        None => Ok(()),
    }
}

fn string_list(v: Option<&serde_json::Value>, key: &str, max: usize) -> Result<Vec<String>, String> {
    let Some(v) = v else { return Ok(Vec::new()) };
    let arr = v.as_array().ok_or_else(|| format!("`{key}` must be a list of strings"))?;
    if arr.len() > max {
        return Err(format!("`{key}` may hold at most {max} entries"));
    }
    arr.iter()
        .map(|x| {
            let s = x.as_str().ok_or_else(|| format!("`{key}` must be a list of strings"))?;
            if s.contains('\0') {
                return Err(format!("`{key}` contains a NUL character"));
            }
            Ok(s.to_string())
        })
        .collect()
}

/// Validate one `binaryDependencies` entry that carries a `definition`.
fn parse_entry(entry: &serde_json::Value) -> Result<Parsed, String> {
    let obj = entry.as_object().ok_or("entry is not an object")?;
    let name = str_field(obj, "name")?.ok_or("`name` is missing")?;
    if !valid_name(&name) {
        return Err(format!("`{name}` is not a valid tool name"));
    }
    if dependencies::is_core_builtin(&name) {
        return Err(format!("{name} is one of Vibo's own tools and can't be redefined"));
    }
    let required = obj
        .get("required")
        .and_then(|v| v.as_bool())
        .ok_or("`required` must be true or false on an entry with a definition")?;
    let def = obj.get("definition").and_then(|v| v.as_object()).ok_or("`definition` must be an object")?;
    only_keys(
        def,
        &["description", "versionArgs", "versionPattern", "probeEnv", "install", "managed", "osTrust"],
        "definition",
    )?;

    let description = str_field(def, "description")?.unwrap_or_default();
    if description.len() > 200 {
        return Err("`description` is longer than 200 characters".into());
    }
    let version_args = string_list(def.get("versionArgs"), "versionArgs", 4)?;
    let version_pattern = str_field(def, "versionPattern")?.ok_or("`versionPattern` is missing")?;
    if version_pattern.len() > 200 {
        return Err("`versionPattern` is longer than 200 characters".into());
    }
    let re = regex::Regex::new(&version_pattern).map_err(|e| format!("`versionPattern` is not a valid pattern: {e}"))?;
    if re.captures_len() != 2 {
        return Err("`versionPattern` must have exactly one capture group (the version)".into());
    }
    let probe_env = match def.get("probeEnv") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(v) => {
            let env = v.as_object().ok_or("`probeEnv` must be an object")?;
            if env.len() > 8 {
                return Err("`probeEnv` may hold at most 8 variables".into());
            }
            let mut out = Vec::new();
            for (key, value) in env {
                if !ALLOWED_PROBE_ENV.contains(&key.as_str()) {
                    return Err(format!("`probeEnv.{key}` is not one Vibo lets a definition set ({ALLOWED_PROBE_ENV:?})"));
                }
                let value = value.as_str().ok_or_else(|| format!("`probeEnv.{key}` must be a string"))?;
                if !valid_probe_env_value(value) {
                    return Err(format!(
                        "`probeEnv.{key}` must be a short plain value or `{{install}}/<folder>` inside the install"
                    ));
                }
                out.push((key.clone(), value.to_string()));
            }
            out
        }
    };

    let install = match def.get("install") {
        None => [String::new(), String::new(), String::new(), String::new()],
        Some(v) => {
            let i = v.as_object().ok_or("`install` must be an object")?;
            only_keys(i, &["macos", "windows", "linux", "url"], "install")?;
            let url = str_field(i, "url")?.unwrap_or_default();
            if !url.is_empty() && !url.starts_with("https://") {
                return Err("`install.url` must be an https link".into());
            }
            [
                str_field(i, "macos")?.unwrap_or_default(),
                str_field(i, "windows")?.unwrap_or_default(),
                str_field(i, "linux")?.unwrap_or_default(),
                url,
            ]
        }
    };

    let managed = match def.get("managed") {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => {
            let m = v.as_object().ok_or("`managed` must be an object")?;
            only_keys(m, &["repo", "assets", "zipapp", "checksum", "layout", "entry"], "managed")?;
            let repo = str_field(m, "repo")?.ok_or("`managed.repo` is missing")?;
            if !valid_repo(&repo) {
                return Err("`managed.repo` must be a GitHub `owner/name`".into());
            }
            let assets_obj = m.get("assets").and_then(|v| v.as_object()).ok_or("`managed.assets` must be an object")?;
            only_keys(assets_obj, &ASSET_KEYS, "managed.assets")?;
            let mut assets: [Option<String>; 8] = Default::default();
            for (i, key) in ASSET_KEYS.iter().enumerate() {
                if let Some(a) = str_field(assets_obj, key)? {
                    if !valid_asset_template(&a) {
                        return Err(format!(
                            "`managed.assets.{key}` must be a plain file name (it may use {{version}} or {{tag}})"
                        ));
                    }
                    assets[i] = Some(a);
                }
            }
            let folder_entry = match str_field(m, "layout")?.as_deref() {
                None => {
                    if m.contains_key("entry") {
                        return Err("`managed.entry` needs `\"layout\": \"folder\"`".into());
                    }
                    None
                }
                Some("folder") => {
                    let entry = str_field(m, "entry")?.ok_or("`\"layout\": \"folder\"` needs `managed.entry`, the program inside it")?;
                    if !valid_asset(&entry) || entry.contains('{') {
                        return Err("`managed.entry` must be a plain file name".into());
                    }
                    if let Some((i, _)) = assets.iter().enumerate().find(|(_, a)| a.as_deref().is_some_and(|a| !is_archive_name(a))) {
                        return Err(format!("`managed.assets.{}` must be a .zip or .tar.gz for a folder layout", ASSET_KEYS[i]));
                    }
                    Some(entry)
                }
                Some(other) => return Err(format!("`managed.layout` \"{other}\" is not understood by this version of Vibo — it needs a newer Vibo")),
            };
            let zipapp = match m.get("zipapp") {
                None | Some(serde_json::Value::Null) => None,
                Some(z) => {
                    let z = z.as_object().ok_or("`managed.zipapp` must be an object")?;
                    only_keys(z, &["asset", "minPython"], "managed.zipapp")?;
                    if folder_entry.is_some() {
                        return Err("`managed.zipapp` can't be combined with `\"layout\": \"folder\"`".into());
                    }
                    let asset = str_field(z, "asset")?.ok_or("`managed.zipapp.asset` is missing")?;
                    if !valid_asset_template(&asset) {
                        return Err("`managed.zipapp.asset` is not a plain file name".into());
                    }
                    if let Some(min) = str_field(z, "minPython")? {
                        let mut parts = min.split('.');
                        let v = (|| Some((parts.next()?.parse::<u32>().ok()?, parts.next()?.parse::<u32>().ok()?)))()
                            .filter(|_| parts.next().is_none())
                            .ok_or("`managed.zipapp.minPython` must look like 3.10")?;
                        if v > HOST_ZIPAPP_PYTHON {
                            return Err(format!("`managed.zipapp.minPython` {min} needs a newer Vibo"));
                        }
                    }
                    Some(asset)
                }
            };
            let checksum = {
                let c = m.get("checksum").and_then(|v| v.as_object()).ok_or(
                    "`managed.checksum` is missing: give `{ \"file\": … }`, `{ \"github\": true }` or say `{ \"none\": true }`",
                )?;
                match (c.get("file"), c.get("github"), c.get("none"), c.len()) {
                    (Some(serde_json::Value::String(f)), None, None, 1) => {
                        if !valid_asset_template(f) {
                            return Err("`managed.checksum.file` is not a plain file name".into());
                        }
                        ParsedChecksum::File(f.clone())
                    }
                    (None, Some(serde_json::Value::Bool(true)), None, 1) => ParsedChecksum::GitHub,
                    (None, None, Some(serde_json::Value::Bool(true)), 1) => ParsedChecksum::None,
                    _ if c.contains_key("pinned") => {
                        return Err("`managed.checksum.pinned` needs a newer Vibo".into());
                    }
                    _ => {
                        return Err(
                            "`managed.checksum` must be exactly `{ \"file\": … }`, `{ \"github\": true }` or `{ \"none\": true }`"
                                .into(),
                        )
                    }
                }
            };
            Some(ParsedManaged { repo, assets, zipapp, checksum, folder_entry })
        }
    };

    let os_trust = match def.get("osTrust") {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => {
            let t = v.as_object().ok_or("`osTrust` must be an object")?;
            only_keys(t, &["args", "caFileEnv"], "osTrust")?;
            let args = string_list(t.get("args"), "osTrust.args", 8)?;
            let env = str_field(t, "caFileEnv")?;
            if let Some(e) = &env {
                if !ALLOWED_CA_FILE_ENV.contains(&e.as_str()) {
                    return Err(format!("`osTrust.caFileEnv` may only be one of {ALLOWED_CA_FILE_ENV:?}"));
                }
            }
            Some((args, env))
        }
    };

    let has_folder = managed.as_ref().is_some_and(|m| m.folder_entry.is_some());
    if let Some((key, _)) = probe_env.iter().find(|(_, v)| v.starts_with("{install}")) {
        if !has_folder {
            return Err(format!("`probeEnv.{key}` uses {{install}}, which needs `\"layout\": \"folder\"`"));
        }
    }

    Ok(Parsed { name, required, description, version_args, version_pattern, probe_env, install, managed, os_trust })
}

fn leak(s: &str) -> &'static str {
    Box::leak(s.to_string().into_boxed_str())
}

fn leak_list(v: &[String]) -> &'static [&'static str] {
    Box::leak(v.iter().map(|s| leak(s)).collect::<Vec<_>>().into_boxed_slice())
}

fn intern(p: &Parsed) -> &'static DependencyDef {
    let key = format!("{p:?}");
    let mut guard = INTERNED.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some(def) = map.get(&key) {
        return def;
    }
    let re: &'static regex::Regex = Box::leak(Box::new(
        regex::Regex::new(&p.version_pattern).expect("validated in parse_entry"),
    ));
    let def: &'static DependencyDef = Box::leak(Box::new(DependencyDef {
        name: leak(&p.name),
        description: leak(&p.description),
        version_args: leak_list(&p.version_args),
        probe_env: Box::leak(
            p.probe_env
                .iter()
                .map(|(k, v)| (leak(k), leak(v)))
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        ),
        parse_version: VersionParser::Pattern(re),
        install: InstallInstructions {
            macos: leak(&p.install[0]),
            windows: leak(&p.install[1]),
            linux: leak(&p.install[2]),
            url: leak(&p.install[3]),
        },
        internal_consumers: &[],
        managed: p.managed.as_ref().map(|m| ManagedSource {
            repo: leak(&m.repo),
            asset_macos: m.assets[0].as_deref().map(leak),
            asset_windows: m.assets[1].as_deref().map(leak),
            asset_linux_x64: m.assets[2].as_deref().map(leak),
            asset_linux_arm64: m.assets[3].as_deref().map(leak),
            asset_macos_arm64: m.assets[4].as_deref().map(leak),
            asset_macos_x64: m.assets[5].as_deref().map(leak),
            asset_windows_x64: m.assets[6].as_deref().map(leak),
            asset_windows_arm64: m.assets[7].as_deref().map(leak),
            folder_entry: m.folder_entry.as_deref().map(leak),
            asset_zipapp: m.zipapp.as_deref().map(leak),
            checksum: match &m.checksum {
                ParsedChecksum::File(f) => Checksum::File(leak(f)),
                ParsedChecksum::GitHub => Checksum::GitHubDigest,
                ParsedChecksum::None => Checksum::Unverified,
            },
        }),
        os_trust: p.os_trust.as_ref().map(|(args, env)| OsTrust {
            args: leak_list(args),
            ca_file_env: env.as_deref().map(leak),
        }),
    }));
    map.insert(key, def);
    def
}

// ---- Scanning ----------------------------------------------------------

struct Candidate {
    plugin_id: String,
    plugin_name: String,
    signed: bool,
    order: u64,
    parsed: Parsed,
}

fn manifest_mtime(dir: &Path) -> u64 {
    std::fs::metadata(dir.join("manifest.json"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX)
}

/// Read one plugin folder: its id, name, trust, and validated definitions.
fn read_plugin(
    dir: &Path,
    folder_id: Option<&str>,
    builtin: bool,
    refused: &mut Vec<Refused>,
) -> Option<ReadPlugin> {
    let text = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&text).ok()?;
    let manifest_id = manifest.get("id").and_then(|v| v.as_str()).map(str::to_string);
    let id = folder_id.map(str::to_string).or(manifest_id.clone())?;
    let name = manifest.get("name").and_then(|v| v.as_str()).unwrap_or(&id).to_string();
    let all: &[serde_json::Value] = manifest
        .get("binaryDependencies")
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();
    let uses: Vec<String> = all
        .iter()
        .filter_map(|e| e.get("name").and_then(|v| v.as_str()))
        .map(str::to_string)
        .collect();
    let entries: Vec<&serde_json::Value> = all.iter().filter(|e| e.get("definition").is_some()).collect();
    if entries.is_empty() {
        return Some(ReadPlugin { id, name, signed: builtin, order: 0, parsed: Vec::new(), uses });
    }
    let signed = if builtin {
        true
    } else {
        let code = std::fs::read_to_string(dir.join("index.js")).ok();
        let status = crate::plugin_signing::verify_scanned(dir, text.as_bytes(), code.as_deref());
        let status = match folder_id {
            Some(folder) => crate::plugin_signing::bind_to_folder(status, manifest_id.as_deref(), folder),
            None => status,
        };
        match status {
            crate::plugin_signing::SignatureStatus::Verified => true,
            crate::plugin_signing::SignatureStatus::Unsigned => false,
            crate::plugin_signing::SignatureStatus::Invalid(why) => {
                for e in &entries {
                    refused.push(Refused {
                        plugin_id: id.clone(),
                        name: e.get("name").and_then(|v| v.as_str()).unwrap_or("?").to_string(),
                        reason: format!("the plugin's signature doesn't match its files ({why})"),
                    });
                }
                return Some(ReadPlugin { id, name, signed: false, order: 0, parsed: Vec::new(), uses: Vec::new() });
            }
        }
    };
    let mut parsed = Vec::new();
    for e in entries {
        match parse_entry(e) {
            Ok(p) => parsed.push(p),
            Err(reason) => refused.push(Refused {
                plugin_id: id.clone(),
                name: e.get("name").and_then(|v| v.as_str()).unwrap_or("?").to_string(),
                reason,
            }),
        }
    }
    let order = if builtin { 0 } else { manifest_mtime(dir) };
    Some(ReadPlugin { id, name, signed, order, parsed, uses })
}

struct ReadPlugin {
    id: String,
    name: String,
    signed: bool,
    order: u64,
    parsed: Vec<Parsed>,
    uses: Vec<String>,
}

fn collect(
    roots: &[PluginRoot],
    refused: &mut Vec<Refused>,
    uses: &mut HashMap<String, Vec<String>>,
) -> Vec<Candidate> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for root in roots {
        let folders: Vec<(PathBuf, Option<String>)> = if root.single {
            vec![(root.dir.clone(), None)]
        } else {
            let Ok(rd) = std::fs::read_dir(&root.dir) else { continue };
            let mut v: Vec<_> = rd
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter_map(|e| Some((e.path(), Some(e.file_name().into_string().ok()?))))
                .collect();
            v.sort();
            v
        };
        for (dir, folder) in folders {
            // A bundled folder off the build's allow-list is a leftover from an
            // older install (see `plugins::is_bundled_plugin_id`).
            if root.builtin && !root.single {
                let id = folder.as_deref().unwrap_or_default();
                if !crate::plugins::is_bundled_plugin_id(id) && !crate::plugins::is_dev_plugin_id(id) {
                    continue;
                }
            }
            let Some(ReadPlugin { id, name, signed, order, parsed, uses: names }) =
                read_plugin(&dir, folder.as_deref(), root.builtin, refused)
            else {
                continue;
            };
            // Same precedence as the plugin listing: the first root that has an
            // id wins, the copies it hides contribute nothing.
            if !seen.insert(id.clone()) {
                continue;
            }
            uses.insert(id.clone(), names);
            for p in parsed {
                out.push(Candidate { plugin_id: id.clone(), plugin_name: name.clone(), signed, order, parsed: p });
            }
        }
    }
    out
}

/// The roots in the plugin listing's precedence: the dev folder (debug builds
/// only — a release build ignores an unsigned dev folder's definitions), the
/// profile's plugins, the bundled plugins, then the debug-only test plugins.
pub fn roots_for(profile_dir: &Path, native_dir: Option<&Path>, dev_dir: Option<&str>) -> Vec<PluginRoot> {
    let mut roots = Vec::new();
    if cfg!(debug_assertions) {
        if let Some(dev) = dev_dir.filter(|d| !d.is_empty()) {
            roots.push(PluginRoot { dir: PathBuf::from(dev), builtin: false, single: true });
        }
    }
    roots.push(PluginRoot { dir: crate::plugins::plugins_dir(profile_dir), builtin: false, single: false });
    for dir in native_dir.map(Path::to_path_buf).into_iter().chain(crate::plugins::dev_plugins_dir()) {
        roots.push(PluginRoot { dir, builtin: true, single: false });
    }
    roots
}

/// Rebuild the registry from the plugins on disk. `roots` in precedence order
/// (dev folder, user plugins, bundled). Returns whether anything a caller shows
/// changed (definitions in force, consents waited on, conflicts, refusals).
pub fn rebuild(profile_dir: &Path, roots: Vec<PluginRoot>) -> bool {
    let consent = read_consent(profile_dir);
    let mut refused = Vec::new();
    let mut uses = HashMap::new();
    let mut candidates = collect(&roots, &mut refused, &mut uses);
    // Signed before unsigned, then first installed first.
    candidates.sort_by(|a, b| b.signed.cmp(&a.signed).then(a.order.cmp(&b.order)).then(a.plugin_id.cmp(&b.plugin_id)));

    let mut active: Vec<Active> = Vec::new();
    let mut pending = Vec::new();
    let mut conflicts = Vec::new();
    for c in candidates {
        let def = intern(&c.parsed);
        let fp = dependencies::fingerprint(def);
        if let Some(existing) = active.iter_mut().find(|a| a.def.name == def.name) {
            if existing.fingerprint == fp {
                if !existing.declared_by.contains(&c.plugin_id) {
                    existing.declared_by.push(c.plugin_id);
                }
            } else {
                conflicts.push(Conflict {
                    name: def.name.to_string(),
                    kept: existing.declared_by.first().cloned().unwrap_or_default(),
                    dropped: c.plugin_id,
                    reason: if existing.signed && !c.signed {
                        "a definition signed by Vibo wins over an unsigned one".into()
                    } else {
                        "the plugin installed first keeps its definition".into()
                    },
                });
            }
            continue;
        }
        if !c.signed && !consent.get(&c.plugin_id).is_some_and(|fps| fps.contains(&fp)) {
            pending.push(PendingConsent {
                plugin_id: c.plugin_id,
                plugin_name: c.plugin_name,
                name: def.name.to_string(),
                fingerprint: fp,
                repo: def.managed.as_ref().map(|m| m.repo.to_string()),
                verified: def.managed.as_ref().is_none_or(|m| m.checksum != Checksum::Unverified),
                required: c.parsed.required,
            });
            continue;
        }
        active.push(Active { def, fingerprint: fp, declared_by: vec![c.plugin_id], signed: c.signed });
    }
    for c in &conflicts {
        log::warn!("Dependency {}: {}'s definition was not used — {}", c.name, c.dropped, c.reason);
    }
    for r in &refused {
        log::warn!("Dependency {} from {} refused: {}", r.name, r.plugin_id, r.reason);
    }
    let status = RegistryStatus { pending_consent: pending, conflicts, refused };
    let summary = |active: &[Active], status: &RegistryStatus| {
        let mut a: Vec<String> = active
            .iter()
            .map(|x| format!("{}={}:{}:{}", x.def.name, x.fingerprint, x.signed, x.declared_by.join(",")))
            .collect();
        a.sort();
        format!("{a:?}|{:?}|{:?}|{:?}", status.pending_consent, status.conflicts, status.refused)
    };
    let mut changed = true;
    if let Ok(mut reg) = REGISTRY.write() {
        let next = summary(&active, &status);
        changed = reg.as_ref().is_none_or(|r| summary(&r.active, &r.status) != next);
        *reg = Some(Registry { active, uses, status });
    }
    if let Ok(mut last) = LAST_INPUTS.lock() {
        *last = Some((profile_dir.to_path_buf(), roots));
    }
    changed
}

/// Rebuild with the inputs of the last rebuild (after a consent change or an
/// uninstall). A no-op before the first rebuild.
pub fn rebuild_again() {
    let last = LAST_INPUTS.lock().ok().and_then(|l| l.clone());
    if let Some((profile, roots)) = last {
        let _ = rebuild(&profile, roots);
    }
}

/// The `binaryDependencies` entry a released plugin ships for `name`, copied
/// verbatim from its manifest (`tests/fixtures/plugin-dependencies/`).
#[cfg(test)]
pub(crate) fn fixture_entry(name: &str) -> serde_json::Value {
    let text = match name {
        "yt-dlp" => include_str!("../tests/fixtures/plugin-dependencies/yt-dlp.json"),
        "rqbit" => include_str!("../tests/fixtures/plugin-dependencies/rqbit.json"),
        "slskd" => include_str!("../tests/fixtures/plugin-dependencies/slskd.json"),
        other => panic!("no fixture for {other}"),
    };
    serde_json::from_str(text).unwrap()
}

/// That entry's definition, validated and interned like a rebuild would.
#[cfg(test)]
pub(crate) fn fixture_def(name: &str) -> &'static DependencyDef {
    intern(&parse_entry(&fixture_entry(name)).unwrap())
}

/// The registry is process-global; every test that rebuilds it (here and in
/// `plugin_programs`) runs under this lock.
#[cfg(test)]
pub(crate) static TEST_SERIAL: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) fn reset_for_tests() {
    if let Ok(mut reg) = REGISTRY.write() {
        *reg = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ytdlp_entry() -> serde_json::Value {
        fixture_entry("yt-dlp")
    }

    fn rqbit_entry() -> serde_json::Value {
        fixture_entry("rqbit")
    }

    #[test]
    fn test_plugin_definitions_keep_the_fingerprints_the_host_recorded() {
        // Hosts up to v1.0.112 defined yt-dlp and rqbit themselves and recorded
        // these fingerprints in `.sources.json` for every managed copy they
        // installed. The plugins' definitions must keep producing them, or
        // those copies read as another source and stop auto-updating.
        for (name, expected) in [
            ("yt-dlp", "af969c1a37284e857e1fe6c09f03584aa70c33bb0f6224f1dd62730c99ac173b"),
            ("rqbit", "4d5deda1d61a1e283d97d901b7e880ff7554a981d4dd717fe448f176ba439080"),
        ] {
            assert_eq!(dependencies::fingerprint(fixture_def(name)), expected, "{name}");
        }
    }

    #[test]
    fn test_fixture_version_patterns() {
        let yt = fixture_def("yt-dlp");
        assert_eq!(yt.parse_version.parse("2026.10.10.232918\n"), Some("2026.10.10.232918".to_string()));
        assert_eq!(yt.parse_version.parse("  2024.10.22  \n"), Some("2024.10.22".to_string()));
        let rq = fixture_def("rqbit");
        assert_eq!(rq.parse_version.parse("rqbit 9.0.1\n"), Some("9.0.1".to_string()));
        assert_eq!(rq.parse_version.parse("  rqbit 10.2.0-beta.1"), Some("10.2.0-beta.1".to_string()));
        assert_eq!(rq.parse_version.parse("not rqbit"), None);
        assert_eq!(rq.parse_version.parse(""), None);
    }

    #[test]
    fn test_fixture_managed_sources() {
        let yt = fixture_def("yt-dlp");
        let m = yt.managed.as_ref().unwrap();
        assert_eq!(m.checksum, dependencies::Checksum::File("SHA2-256SUMS"));
        assert!(m.asset_zipapp.is_some());
        assert!(m.platform_asset().is_some(), "every dev/CI platform has an asset");
        let trust = yt.os_trust.expect("yt-dlp bundles certifi, so it needs os_trust");
        // Repeated --compat-options accumulate in yt-dlp, so a plugin's own
        // `--compat-options …` can't undo this one.
        assert_eq!(trust.args, &["--compat-options", "no-certifi"]);
        assert_eq!(trust.ca_file_env, Some("SSL_CERT_FILE"));

        let rq = fixture_def("rqbit");
        let m = rq.managed.as_ref().unwrap();
        assert_eq!(m.repo, "ikatson/rqbit");
        assert_eq!(m.checksum, dependencies::Checksum::Unverified);
        assert!(m.asset_zipapp.is_none(), "rqbit is a native binary, never a zipapp");
        assert!(m.platform_asset().is_some());
        assert!(rq.os_trust.is_none());
    }

    #[test]
    fn test_no_host_definition_of_a_plugin_tool() {
        // yt-dlp and rqbit belong to their plugins: nothing in force without one.
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_tests();
        for name in ["yt-dlp", "rqbit"] {
            assert!(dependencies::get_def(name).is_none(), "{name}");
            assert!(!dependencies::allowed_names().contains(&name), "{name}");
        }
    }

    #[test]
    fn test_interning_reuses_the_same_definition() {
        let a = intern(&parse_entry(&ytdlp_entry()).unwrap());
        let b = intern(&parse_entry(&ytdlp_entry()).unwrap());
        assert!(std::ptr::eq(a, b));
    }

    #[test]
    fn test_validation_refuses_what_it_cannot_honour() {
        let cases: Vec<(Box<dyn Fn(&mut serde_json::Value)>, &str)> = vec![
            (Box::new(|e| e["name"] = json!("ffmpeg")), "own tools"),
            (Box::new(|e| e["name"] = json!("Bad Name")), "valid tool name"),
            (Box::new(|e| { e.as_object_mut().unwrap().remove("required"); }), "required"),
            (Box::new(|e| e["definition"]["versionPattern"] = json!("^\\S+$")), "capture group"),
            (Box::new(|e| e["definition"]["versionPattern"] = json!("(")), "valid pattern"),
            (Box::new(|e| e["definition"]["managed"]["repo"] = json!("https://evil.example/x")), "owner/name"),
            (Box::new(|e| e["definition"]["managed"]["assets"]["macos"] = json!("../x")), "plain file name"),
            (Box::new(|e| e["definition"]["managed"]["checksum"] = json!({})), "exactly"),
            (Box::new(|e| { e["definition"]["managed"].as_object_mut().unwrap().remove("checksum"); }), "checksum` is missing"),
            (Box::new(|e| e["definition"]["managed"]["checksum"] = json!({ "pinned": { "a": "b" } })), "newer Vibo"),
            (Box::new(|e| e["definition"]["managed"]["version"] = json!("1.0")), "newer Vibo"),
            (Box::new(|e| e["definition"]["managed"]["zipapp"]["minPython"] = json!("3.12")), "newer Vibo"),
            (Box::new(|e| e["definition"]["osTrust"]["caFileEnv"] = json!("LD_PRELOAD")), "caFileEnv"),
            (Box::new(|e| e["definition"]["install"]["url"] = json!("http://x")), "https"),
            (Box::new(|e| e["definition"]["managed"]["assets"]["macos"] = json!("tool-{build}")), "plain file name"),
            (Box::new(|e| e["definition"]["managed"]["entry"] = json!("yt-dlp")), "layout"),
            (Box::new(|e| e["definition"]["managed"]["layout"] = json!("tree")), "newer Vibo"),
            (Box::new(|e| e["definition"]["probeEnv"] = json!({ "LD_PRELOAD": "x" })), "probeEnv.LD_PRELOAD"),
            (Box::new(|e| e["definition"]["probeEnv"] = json!({ "DOTNET_NOLOGO": "{install}/x" })), "needs `\"layout\": \"folder\"`"),
            (Box::new(|e| e["definition"]["managed"]["checksum"] = json!({ "github": false })), "exactly"),
            (Box::new(|e| e["definition"]["managed"]["checksum"] = json!({ "github": true, "none": true })), "exactly"),
        ];
        for (mutate, needle) in cases {
            let mut e = ytdlp_entry();
            mutate(&mut e);
            let err = parse_entry(&e).unwrap_err();
            assert!(err.contains(needle), "{err:?} should mention {needle:?}");
        }
    }

    #[test]
    fn test_folder_layout_validation() {
        let cases: Vec<(Box<dyn Fn(&mut serde_json::Value)>, &str)> = vec![
            (Box::new(|e| { e["definition"]["managed"].as_object_mut().unwrap().remove("entry"); }), "needs `managed.entry`"),
            (Box::new(|e| e["definition"]["managed"]["entry"] = json!("../slskd")), "plain file name"),
            (Box::new(|e| e["definition"]["managed"]["assets"]["macos-arm64"] = json!("slskd-{version}")), ".zip or .tar.gz"),
            (Box::new(|e| e["definition"]["managed"]["zipapp"] = json!({ "asset": "x.pyz" })), "can't be combined"),
            (Box::new(|e| e["definition"]["probeEnv"]["DOTNET_NOLOGO"] = json!("{install}/../x")), "inside the install"),
            (Box::new(|e| e["definition"]["probeEnv"]["DOTNET_NOLOGO"] = json!("/etc")), "inside the install"),
            (Box::new(|e| e["definition"]["probeEnv"]["DOTNET_NOLOGO"] = json!("{install}x")), "inside the install"),
        ];
        for (mutate, needle) in cases {
            let mut e = fixture_entry("slskd");
            mutate(&mut e);
            let err = parse_entry(&e).unwrap_err();
            assert!(err.contains(needle), "{err:?} should mention {needle:?}");
        }
    }

    #[test]
    fn test_slskd_fixture_parses_as_a_folder_tool() {
        let def = fixture_def("slskd");
        let m = def.managed.as_ref().unwrap();
        assert_eq!(m.repo, "slskd/slskd");
        assert_eq!(m.folder_entry, Some("slskd"));
        assert_eq!(m.checksum, dependencies::Checksum::GitHubDigest);
        assert!(m.asset_macos.is_none() && m.asset_windows.is_none(), "only arch-specific assets");
        assert_eq!(m.asset_macos_arm64, Some("slskd-{version}-osx-arm64.zip"));
        assert_eq!(m.asset_windows_x64, Some("slskd-{version}-win-x64.zip"));
        assert!(m.platform_asset().is_some(), "every dev/CI platform has an asset");
        assert_eq!(
            def.probe_env,
            &[
                ("DOTNET_BUNDLE_EXTRACT_BASE_DIR", "{install}/.probe-extract"),
                ("DOTNET_CLI_TELEMETRY_OPTOUT", "1"),
                ("DOTNET_NOLOGO", "1"),
            ]
        );
        // What slskd 0.26.1 really prints for `--version`.
        assert_eq!(def.parse_version.parse("0.26.1.0 (0.26.1.0+71dcc7a6)\n"), Some("0.26.1".to_string()));
    }

    #[test]
    fn test_new_fields_move_the_fingerprint_only_when_present() {
        let base = dependencies::fingerprint(fixture_def("slskd"));
        let mut other = fixture_entry("slskd");
        other["definition"]["managed"]["entry"] = json!("slskd-server");
        assert_ne!(dependencies::fingerprint(intern(&parse_entry(&other).unwrap())), base, "the entry is part of what runs");
        let mut cosmetic = fixture_entry("slskd");
        cosmetic["definition"]["probeEnv"]["DOTNET_NOLOGO"] = json!("0");
        assert_eq!(dependencies::fingerprint(intern(&parse_entry(&cosmetic).unwrap())), base, "the probe is not the source");
    }

    fn write_plugin(root: &Path, id: &str, entries: serde_json::Value) -> PathBuf {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            json!({ "id": id, "name": format!("{id} plugin"), "version": "1.0.0", "binaryDependencies": entries }).to_string(),
        )
        .unwrap();
        std::fs::write(dir.join("index.js"), "function activate() {}").unwrap();
        dir
    }

    use super::TEST_SERIAL as SERIAL;

    #[test]
    fn test_unsigned_definitions_wait_for_consent_then_register() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let profile = tempfile::tempdir().unwrap();
        let plugins = tempfile::tempdir().unwrap();
        let mut entry = rqbit_entry();
        entry["name"] = json!("demo-torrent");
        entry["definition"]["managed"]["repo"] = json!("someone/rqbit-fork");
        write_plugin(plugins.path(), "torrents", json!([entry, { "name": "ffmpeg", "required": false }]));
        let roots = vec![PluginRoot { dir: plugins.path().to_path_buf(), builtin: false, single: false }];

        rebuild(profile.path(), roots.clone());
        assert!(active_def("demo-torrent").is_none(), "an unsigned definition isn't used before consent");
        let pending = status().pending_consent;
        assert_eq!(pending.len(), 1, "a reference-only entry asks nothing");
        assert_eq!(pending[0].plugin_id, "torrents");
        assert!(pending[0].required);
        assert!(!pending[0].verified);

        grant_consent(profile.path(), "torrents", &[pending[0].fingerprint.clone()]).unwrap();
        assert_eq!(active_def("demo-torrent").unwrap().managed.as_ref().unwrap().repo, "someone/rqbit-fork");
        assert!(!signed_definition("demo-torrent"), "an unsigned plugin's definition");
        assert_eq!(declared_by("demo-torrent"), vec!["torrents".to_string()]);
        assert!(status().pending_consent.is_empty());

        // An update that changes the definition asks again.
        let mut changed = rqbit_entry();
        changed["name"] = json!("demo-torrent");
        changed["definition"]["managed"]["repo"] = json!("someone/other-fork");
        write_plugin(plugins.path(), "torrents", json!([changed]));
        rebuild_again();
        assert!(active_def("demo-torrent").is_none());
        assert_eq!(status().pending_consent.len(), 1);

        // Consent only for what the plugin is waiting on.
        assert!(grant_consent(profile.path(), "torrents", &["nope".into()]).is_err());
        revoke_consent(profile.path(), "torrents").unwrap();
        reset_for_tests();
    }

    #[test]
    fn test_bundled_definitions_register_and_conflicts_keep_the_first() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let profile = tempfile::tempdir().unwrap();
        let bundled = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        // A bundled plugin counts as signed. "lastfm" is on the bundle allow-list.
        let mut demo = ytdlp_entry();
        demo["name"] = json!("demo-video");
        write_plugin(bundled.path(), "lastfm", json!([demo.clone()]));
        let mut other = demo.clone();
        other["definition"]["managed"]["repo"] = json!("yt-dlp/yt-dlp");
        write_plugin(user.path(), "second", json!([other]));
        write_plugin(user.path(), "same", json!([demo]));
        let roots = vec![
            PluginRoot { dir: user.path().to_path_buf(), builtin: false, single: false },
            PluginRoot { dir: bundled.path().to_path_buf(), builtin: true, single: false },
        ];
        rebuild(profile.path(), roots);
        let def = active_def("demo-video").unwrap();
        assert_eq!(def.managed.as_ref().unwrap().repo, "yt-dlp/yt-dlp-nightly-builds");
        assert!(signed_definition("demo-video"));
        let st = status();
        assert_eq!(st.conflicts.len(), 1);
        assert_eq!(st.conflicts[0].kept, "lastfm");
        assert_eq!(st.conflicts[0].dropped, "second");
        // An unsigned copy of the very same definition adds nothing to consent
        // to: it is merged as one more declaring plugin.
        assert!(st.pending_consent.is_empty());
        assert_eq!(declared_by("demo-video"), vec!["lastfm".to_string(), "same".to_string()]);
        assert!(dependencies::allowed_names().contains(&"demo-video"));
        reset_for_tests();
    }

    #[test]
    fn test_declares_counts_references_but_declared_by_only_definers() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let profile = tempfile::tempdir().unwrap();
        let bundled = tempfile::tempdir().unwrap();
        let mut demo = ytdlp_entry();
        demo["name"] = json!("demo-ref");
        write_plugin(bundled.path(), "lastfm", json!([demo]));
        write_plugin(bundled.path(), "lyrics", json!([{ "name": "demo-ref", "required": false, "reason": "x" }]));
        rebuild(profile.path(), vec![PluginRoot { dir: bundled.path().to_path_buf(), builtin: true, single: false }]);
        assert!(declares("lastfm", "demo-ref"));
        assert!(declares("lyrics", "demo-ref"), "a reference without a definition still declares");
        assert!(!declares("lyrics", "yt-dlp"));
        assert!(!declares("nobody", "demo-ref"));
        assert_eq!(declared_by("demo-ref"), vec!["lastfm".to_string()], "Provided by stays the definers");
        reset_for_tests();
    }
}
