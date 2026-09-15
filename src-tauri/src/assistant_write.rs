//! Write authorization + audit trail for the AI-assistant control API.
//!
//! The control API's bearer token authorizes *reading and driving* the app.
//! Anything that changes the user's files or library metadata additionally
//! requires a **write scope**, three booleans the user switches on in
//! Settings → General → AI control:
//!
//! - `modify_tags`  — write tag/metadata edits into audio files
//! - `manage_files` — create lyrics/cover files, move/rename tracks
//! - `downloads`    — download a track's own source into a collection
//!
//! Scopes live in `assistant-permissions.json` in the profile dir, owned and
//! read by **Rust** (never the frontend store): the HTTP handlers re-read the
//! file per request and fail closed on anything missing or malformed — the
//! same "the gate is re-checked in Rust, never trusted from the caller"
//! pattern as `write_probe_dump`. Default is everything off.
//!
//! Every applied write is appended to `assistant-changes.jsonl` (same dir) so
//! the user can always answer "what did the assistant change?" — surfaced in
//! Settings → Debug and in the Report-a-problem diagnostics.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};

pub const SCOPES_FILE: &str = "assistant-permissions.json";
pub const AUDIT_FILE: &str = "assistant-changes.jsonl";

/// Trim the audit file back to this many newest lines once it crosses
/// `AUDIT_MAX_BYTES` — a journal, not a landfill.
const AUDIT_KEEP_LINES: usize = 1000;
const AUDIT_MAX_BYTES: u64 = 1024 * 1024;

// --- Scopes ---

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WriteScopes {
    pub modify_tags: bool,
    pub manage_files: bool,
    pub downloads: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    ModifyTags,
    ManageFiles,
    Downloads,
}

impl Scope {
    /// The Settings-facing name, used in error messages so an assistant can
    /// tell the user exactly which switch to flip.
    pub fn label(self) -> &'static str {
        match self {
            Scope::ModifyTags => "Modify tags",
            Scope::ManageFiles => "Manage files",
            Scope::Downloads => "Downloads",
        }
    }
}

impl WriteScopes {
    pub fn allows(&self, scope: Scope) -> bool {
        match scope {
            Scope::ModifyTags => self.modify_tags,
            Scope::ManageFiles => self.manage_files,
            Scope::Downloads => self.downloads,
        }
    }
}

fn scopes_path(app_dir: &Path) -> PathBuf {
    app_dir.join(SCOPES_FILE)
}

/// Read the scopes, failing closed: no file, unreadable, or unparseable all
/// mean "nothing is allowed". Unknown fields are ignored, missing ones false.
pub fn load_scopes(app_dir: &Path) -> WriteScopes {
    let Ok(contents) = std::fs::read_to_string(scopes_path(app_dir)) else {
        return WriteScopes::default();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

pub fn save_scopes(app_dir: &Path, scopes: &WriteScopes) -> Result<(), String> {
    let path = scopes_path(app_dir);
    let contents = serde_json::to_string_pretty(scopes).map_err(|e| e.to_string())?;
    std::fs::write(&path, contents)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

// --- Audit journal ---

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub ts: String,
    pub verb: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

fn audit_path(app_dir: &Path) -> PathBuf {
    app_dir.join(AUDIT_FILE)
}

/// Append one entry. Failures are logged, never propagated — a broken journal
/// must not fail the mutation it records (the mutation already happened).
pub fn append_audit(app_dir: &Path, verb: &str, summary: &str, detail: Option<Value>) {
    let entry = AuditEntry {
        ts: chrono::Utc::now().to_rfc3339(),
        verb: verb.to_string(),
        summary: summary.to_string(),
        detail,
    };
    if let Err(e) = try_append(app_dir, &entry) {
        log::error!("Assistant audit: failed to append entry: {}", e);
    }
}

fn try_append(app_dir: &Path, entry: &AuditEntry) -> Result<(), String> {
    let path = audit_path(app_dir);
    let line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{}", line).map_err(|e| e.to_string())?;
    drop(file);
    // Trim opportunistically once the file grows past the cap.
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > AUDIT_MAX_BYTES {
        let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let lines: Vec<&str> = contents.lines().collect();
        let keep = lines.len().saturating_sub(AUDIT_KEEP_LINES);
        let trimmed: String = lines[keep..].iter().map(|l| format!("{}\n", l)).collect();
        std::fs::write(&path, trimmed).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The newest `limit` entries, oldest first. Unparseable lines are skipped —
/// the journal is best-effort evidence, not a ledger with integrity claims.
pub fn read_audit_tail(app_dir: &Path, limit: usize) -> Vec<AuditEntry> {
    let Ok(contents) = std::fs::read_to_string(audit_path(app_dir)) else {
        return Vec::new();
    };
    let mut entries: Vec<AuditEntry> = contents
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let skip = entries.len().saturating_sub(limit);
    entries.drain(..skip);
    entries
}

// --- Path safety ---

/// Parse a caller-supplied *relative* directory into components, refusing
/// everything that could step outside a root: absolute paths, drive prefixes,
/// `..`, and empty/dot-only input is fine (means "the root itself").
///
/// This is the textual half of the check; `ensure_within_root` is the
/// filesystem half (symlinks). Both run on every assistant file write.
pub fn parse_relative_dir(rel: &str) -> Result<PathBuf, String> {
    let trimmed = rel.trim();
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err("path must be relative to the collection root, not absolute".to_string());
    }
    let candidate = Path::new(trimmed);
    let mut out = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => {
                let s = part.to_string_lossy();
                // A Windows drive/UNC hiding inside a "normal" component on
                // unix (e.g. "C:") is refused by the colon check below.
                if s.contains(':') {
                    return Err(format!("invalid path segment \"{}\"", s));
                }
                out.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("path must not contain \"..\"".to_string());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("path must be relative to the collection root, not absolute".to_string());
            }
        }
    }
    Ok(out)
}

/// Verify `candidate` (which need not exist yet) resolves inside `root`,
/// symlinks included: canonicalize the deepest *existing* ancestor of the
/// candidate and require it to start with the canonicalized root. Textual
/// prefix checks alone are defeated by a symlinked subdirectory.
pub fn ensure_within_root(root: &Path, candidate: &Path) -> Result<(), String> {
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("collection root {} is not accessible: {}", root.display(), e))?;
    let mut probe = candidate.to_path_buf();
    let existing = loop {
        if probe.exists() {
            break probe;
        }
        match probe.parent() {
            Some(p) => probe = p.to_path_buf(),
            None => return Err("destination has no accessible ancestor".to_string()),
        }
    };
    let canon = existing
        .canonicalize()
        .map_err(|e| format!("failed to resolve {}: {}", existing.display(), e))?;
    if !canon.starts_with(&canon_root) {
        return Err("destination escapes the collection root".to_string());
    }
    Ok(())
}

/// A filename for a file the assistant creates: no separators, no traversal,
/// no leading dot, bounded length. (Track *moves* keep or sanitize names via
/// the downloader's `sanitize_filename`; this guards created sidecar files.)
pub fn validate_filename(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 255 {
        return Err("invalid filename length".to_string());
    }
    if name.starts_with('.') {
        return Err("filename must not start with a dot".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains(':') || name.contains("..") {
        return Err("filename must not contain path separators".to_string());
    }
    Ok(())
}

// --- Operations ---
//
// Plain functions over `&Database` + paths, so the control-API handlers stay
// thin (scope check → spawn_blocking → audit) and everything here is
// unit-testable without axum or a webview.

use crate::db::Database;
use crate::models::{is_network_path, TrackQuery};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const MAX_LYRICS_BYTES: usize = 200_000;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_MOVES: usize = 50;
pub const MAX_TAG_TRACKS: usize = 100;

/// Send an existing file out of the way before an explicit overwrite: trash
/// for local paths, plain remove for network shares (no recycle bin there —
/// same split as `delete_tracks`). Refuses to proceed when neither works, so
/// an overwrite can never silently clobber without the old file being
/// recoverable (locally) or the failure being visible.
fn displace_existing(path: &Path) -> Result<(), String> {
    let as_str = path.to_string_lossy();
    if is_network_path(&as_str) {
        std::fs::remove_file(path).map_err(|e| format!("failed to remove {}: {}", path.display(), e))
    } else {
        trash::delete(path).map_err(|e| format!("failed to move {} to trash: {}", path.display(), e))
    }
}

fn local_file_of(track: &crate::models::Track) -> Result<PathBuf, String> {
    let Some(p) = track.filesystem_path() else {
        return Err(format!(
            "track {} (\"{}\") is not a local file — its source is {}",
            track.id,
            track.title,
            track.path.split("://").next().unwrap_or("unknown")
        ));
    };
    let path = PathBuf::from(p);
    if !path.exists() {
        return Err(format!("track file {} does not exist on disk", path.display()));
    }
    Ok(path)
}

/// Join relative components with `/` regardless of platform — this is the
/// string stored in `tracks.path`, which `PATH_EXPR` concatenates with `/`.
fn rel_to_string(p: &Path) -> String {
    p.components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

// --- Lyrics files ---

pub fn write_lyrics_file(
    db: &Database,
    track_id: i64,
    content: &str,
    kind: &str,
    overwrite: bool,
) -> Result<Value, String> {
    if content.trim().is_empty() {
        return Err("content must not be empty".to_string());
    }
    if content.len() > MAX_LYRICS_BYTES {
        return Err(format!("content exceeds the {} KB limit", MAX_LYRICS_BYTES / 1000));
    }
    let ext = match kind {
        "synced" => "lrc",
        "plain" => "txt",
        "auto" | "" => {
            if crate::local_lyrics::is_synced_lyrics(content) { "lrc" } else { "txt" }
        }
        other => return Err(format!("kind must be auto|synced|plain, got \"{}\"", other)),
    };
    let track = db.get_track_by_id(track_id).map_err(|e| format!("track {}: {}", track_id, e))?;
    let audio_path = local_file_of(&track)?;
    let stem = audio_path
        .file_stem()
        .ok_or_else(|| "track file has no name".to_string())?;
    let dest = audio_path.with_file_name(format!("{}.{}", stem.to_string_lossy(), ext));

    let replaced = dest.exists();
    if replaced {
        if !overwrite {
            return Err(format!(
                "{} already exists — pass overwrite=true to replace it (the old file goes to the trash)",
                dest.display()
            ));
        }
        displace_existing(&dest)?;
    }
    std::fs::write(&dest, content).map_err(|e| format!("failed to write {}: {}", dest.display(), e))?;
    Ok(serde_json::json!({
        "path": dest.to_string_lossy(),
        "kind": if ext == "lrc" { "synced" } else { "plain" },
        "bytes": content.len(),
        "replaced": replaced,
        "note": "cached lyrics refresh within a day; fetch with pluginId=core:local-lyrics to see the new file immediately",
    }))
}

// --- Album cover files ---

pub fn write_album_cover(
    db: &Database,
    app_dir: &Path,
    album_id: i64,
    url: Option<&str>,
    from_cache: bool,
    overwrite: bool,
) -> Result<Value, String> {
    let album = db
        .get_album_by_id(album_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no album with id {}", album_id))?;

    // Destination: the directory holding most of the album's local files —
    // the same sidecar location the core:folder image provider reads.
    let opts = TrackQuery { album_id: Some(album_id), ..Default::default() };
    let tracks = db.get_tracks(&opts).map_err(|e| e.to_string())?;
    let mut dir_counts: Vec<(PathBuf, usize)> = Vec::new();
    for t in &tracks {
        let Some(p) = t.filesystem_path() else { continue };
        let Some(parent) = Path::new(p).parent() else { continue };
        match dir_counts.iter_mut().find(|(d, _)| d == parent) {
            Some((_, n)) => *n += 1,
            None => dir_counts.push((parent.to_path_buf(), 1)),
        }
    }
    let Some((dest_dir, _)) = dir_counts.iter().max_by_key(|(_, n)| *n) else {
        return Err("this album has no local files to put a cover next to".to_string());
    };
    if !dest_dir.exists() {
        return Err(format!("album folder {} does not exist", dest_dir.display()));
    }

    // Source bytes: a URL the app fetches itself, or the already-cached
    // entity image. Never caller-supplied raw bytes.
    let bytes: Vec<u8> = if from_cache {
        let slug = crate::entity_image::entity_image_slug("album", &album.title, album.artist_name.as_deref());
        let Some(cached) = crate::entity_image::get_image_path(app_dir, "album", &slug) else {
            return Err("no cached image for this album — resolve one first (POST /v1/images/album), or pass url".to_string());
        };
        std::fs::read(&cached).map_err(|e| format!("failed to read cached image: {}", e))?
    } else {
        let Some(url) = url else {
            return Err("pass url (http/https) or fromCache=true".to_string());
        };
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err("url must be http(s)".to_string());
        }
        let client = crate::image_provider::http_client()?;
        let resp = client.get(url).send().map_err(|e| format!("fetch failed: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("fetch failed: HTTP {}", resp.status()));
        }
        if let Some(len) = resp.content_length() {
            if len > MAX_IMAGE_BYTES as u64 {
                return Err("image exceeds the 10 MB limit".to_string());
            }
        }
        let body = resp.bytes().map_err(|e| format!("fetch failed: {}", e))?;
        if body.len() > MAX_IMAGE_BYTES {
            return Err("image exceeds the 10 MB limit".to_string());
        }
        body.to_vec()
    };

    let Some(ext) = crate::commands::sniff_image_ext(&bytes) else {
        return Err("the fetched data is not a recognized image (png/jpg/gif/webp)".to_string());
    };

    // Any existing cover.* counts as a conflict, not just the same extension.
    let existing: Vec<PathBuf> = ["jpg", "jpeg", "png", "webp", "gif"]
        .iter()
        .map(|e| dest_dir.join(format!("cover.{}", e)))
        .filter(|p| p.exists())
        .collect();
    if !existing.is_empty() && !overwrite {
        return Err(format!(
            "{} already exists — pass overwrite=true to replace it (the old file goes to the trash)",
            existing[0].display()
        ));
    }
    for old in &existing {
        displace_existing(old)?;
    }

    let dest = dest_dir.join(format!("cover.{}", ext));
    std::fs::write(&dest, &bytes).map_err(|e| format!("failed to write {}: {}", dest.display(), e))?;
    Ok(serde_json::json!({
        "path": dest.to_string_lossy(),
        "bytes": bytes.len(),
        "replaced": !existing.is_empty(),
        "note": "the folder image provider discovers cover.* — re-resolve the album image (POST /v1/images/album) to refresh the app's cache",
    }))
}

// --- File moves ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveRequest {
    pub track_id: i64,
    /// New directory, relative to the track's own collection root. Omitted =
    /// keep the current directory (a pure rename).
    pub to_dir: Option<String>,
    /// New filename (extension must not change). Omitted = keep the name.
    pub new_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedMove {
    pub track_id: i64,
    pub title: String,
    pub from: String,
    pub to: String,
    #[serde(skip)]
    pub to_rel: String,
}

/// Validate every requested move against the DB and the filesystem and return
/// the exact rename list plus its hash. Nothing is touched. Errors are
/// all-or-nothing: one bad move fails the whole plan, because a partial plan
/// silently reordering a library is worse than asking the caller to fix it.
pub fn plan_moves(db: &Database, moves: &[MoveRequest]) -> Result<(Vec<PlannedMove>, String), String> {
    if moves.is_empty() {
        return Err("moves must not be empty".to_string());
    }
    if moves.len() > MAX_MOVES {
        return Err(format!("at most {} moves per call", MAX_MOVES));
    }
    let mut plan: Vec<PlannedMove> = Vec::with_capacity(moves.len());
    for m in moves {
        let track = db.get_track_by_id(m.track_id).map_err(|e| format!("track {}: {}", m.track_id, e))?;
        let src = local_file_of(&track)?;
        let Some(collection_id) = track.collection_id else {
            return Err(format!("track {} belongs to no collection", m.track_id));
        };
        let collection = db.get_collection_by_id(collection_id).map_err(|e| e.to_string())?;
        if collection.kind != "local" {
            return Err(format!(
                "track {} is in a {} collection — only local collections can be reorganized",
                m.track_id, collection.kind
            ));
        }
        let Some(root_str) = collection.path.as_deref() else {
            return Err(format!("collection \"{}\" has no root path", collection.name));
        };
        let root = Path::new(root_str);
        let cur_rel = src
            .strip_prefix(root)
            .map_err(|_| format!("track {} sits outside its collection root {}", m.track_id, root.display()))?;

        let dest_dir_rel = match m.to_dir.as_deref() {
            Some(d) => parse_relative_dir(d)?,
            None => cur_rel.parent().map(|p| p.to_path_buf()).unwrap_or_default(),
        };
        let name = match m.new_name.as_deref() {
            Some(n) => {
                validate_filename(n)?;
                let old_ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
                let new_ext = Path::new(n).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
                if old_ext != new_ext {
                    return Err(format!(
                        "renaming \"{}\" must keep the .{} extension (got \"{}\")",
                        track.title, old_ext, n
                    ));
                }
                n.to_string()
            }
            None => src
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .ok_or_else(|| "track file has no name".to_string())?,
        };

        let dest = root.join(&dest_dir_rel).join(&name);
        ensure_within_root(root, &dest)?;
        if dest == src {
            return Err(format!("move for track {} is a no-op (same source and destination)", m.track_id));
        }
        if dest.exists() {
            return Err(format!("{} already exists — moves never overwrite", dest.display()));
        }
        if plan.iter().any(|p| p.to == dest.to_string_lossy()) {
            return Err(format!("two moves target the same destination {}", dest.display()));
        }
        plan.push(PlannedMove {
            track_id: m.track_id,
            title: track.title.clone(),
            from: src.to_string_lossy().to_string(),
            to: dest.to_string_lossy().to_string(),
            to_rel: rel_to_string(&dest_dir_rel.join(&name)),
        });
    }
    let hash = plan_hash(&plan);
    Ok((plan, hash))
}

pub fn plan_hash(plan: &[PlannedMove]) -> String {
    let triples: Vec<(i64, &str, &str)> =
        plan.iter().map(|p| (p.track_id, p.from.as_str(), p.to.as_str())).collect();
    let encoded = serde_json::to_string(&triples).unwrap_or_default();
    let digest = Sha256::digest(encoded.as_bytes());
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Execute a verified plan. Each move is individually atomic: rename first,
/// then re-point the DB row; a DB failure renames the file back. Partial
/// outcomes are reported honestly rather than rolled back wholesale.
pub fn apply_moves(db: &Database, plan: &[PlannedMove]) -> Value {
    let mut moved = Vec::new();
    let mut failed = Vec::new();
    for p in plan {
        let from = Path::new(&p.from);
        let to = Path::new(&p.to);
        let result: Result<(), String> = (|| {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("failed to create {}: {}", parent.display(), e))?;
            }
            if to.exists() {
                return Err("destination appeared since the plan was made".to_string());
            }
            std::fs::rename(from, to).map_err(|e| format!("rename failed: {}", e))?;
            if let Err(e) = db.update_track_path(p.track_id, &p.to_rel) {
                // Put the file back so disk and DB never disagree.
                let restore = std::fs::rename(to, from);
                return Err(match restore {
                    Ok(_) => format!("database update failed (file restored): {}", e),
                    Err(re) => format!("database update failed AND restore failed ({}): {}", re, e),
                });
            }
            Ok(())
        })();
        match result {
            Ok(_) => moved.push(serde_json::json!({ "trackId": p.track_id, "from": p.from, "to": p.to })),
            Err(e) => failed.push(serde_json::json!({ "trackId": p.track_id, "title": p.title, "error": e })),
        }
    }
    serde_json::json!({
        "applied": true,
        "moved": moved,
        "failed": failed,
        "note": "live queue entries and .m3u playlist files still hold the old paths; library playlists (by id) follow automatically",
    })
}

// --- Source-faithful download ---

/// Sniff a downloaded audio file's container from its first bytes — used only
/// when a Subsonic "original" download has no stored format ("auto").
fn sniff_audio_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 12 {
        return None;
    }
    if &bytes[0..4] == b"fLaC" {
        return Some("flac");
    }
    if &bytes[0..4] == b"OggS" {
        return Some("ogg");
    }
    if &bytes[0..3] == b"ID3" || (bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0) {
        return Some("mp3");
    }
    if &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        return Some("wav");
    }
    if &bytes[4..8] == b"ftyp" {
        return Some("m4a");
    }
    None
}

/// Where the bytes of a landing download come from.
pub enum DownloadSource {
    /// A URL this side fetches itself (subsonic stream/download URL, direct
    /// http(s) source, or a plugin-resolved URL), with optional headers.
    Url(String, Option<std::collections::HashMap<String, String>>),
    /// A file already on disk — a plugin resolve that performed its own fetch
    /// (yt-dlp downloads + merges into a temp file and reports its path). The
    /// file is MOVED into the collection, so the temp copy doesn't linger.
    LocalFile(PathBuf),
}

/// Tag metadata a plugin resolve reported (`DownloadResolveResult.metadata`) —
/// written into the landed file best-effort, exactly as `download_to_path`
/// does for the modal (a raw yt-dlp download carries no tags otherwise).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LandTags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track_number: Option<u32>,
    pub year: Option<i32>,
    pub genre: Option<String>,
    pub cover_url: Option<String>,
}

/// Land one download into a local collection: validate the destination
/// (root-relative, symlink-checked), fetch/move the bytes, name the file
/// `Artist - Title.ext`, refuse conflicts outright, and index the result so it
/// becomes a library row. The shared tail of every assistant download —
/// source-faithful and plugin-resolved alike.
pub fn land_download(
    db: &Arc<Database>,
    collection_id: i64,
    subdir: &str,
    artist: &str,
    title: &str,
    ext_hint: &str,
    source: DownloadSource,
    tags: Option<LandTags>,
) -> Result<Value, String> {
    if title.trim().is_empty() {
        return Err("title must not be empty".to_string());
    }
    let collection = db.get_collection_by_id(collection_id).map_err(|e| e.to_string())?;
    if collection.kind != "local" || collection.path.is_none() {
        return Err(format!("collection \"{}\" is not a local folder", collection.name));
    }
    if !collection.enabled {
        return Err(format!("collection \"{}\" is disabled", collection.name));
    }
    let root_str = collection.path.clone().unwrap();
    let root = Path::new(&root_str);
    let dir_rel = parse_relative_dir(subdir)?;
    let dest_dir = root.join(&dir_rel);
    ensure_within_root(root, &dest_dir)?;

    let named_ext = match ext_hint {
        "auto" | "" => String::new(),
        e => e.trim_start_matches('.').to_ascii_lowercase(),
    };

    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("failed to create {}: {}", dest_dir.display(), e))?;
    let temp = dest_dir.join(format!(".viboplr-dl-{}.tmp", std::process::id()));
    match &source {
        DownloadSource::Url(url, headers) => {
            if let Err(e) = crate::downloader::download_file(url, headers.as_ref(), &temp, None, None) {
                let _ = std::fs::remove_file(&temp);
                return Err(format!("download failed: {}", e));
            }
        }
        DownloadSource::LocalFile(path) => {
            if !path.is_file() {
                return Err(format!("resolved file {} does not exist", path.display()));
            }
            // Same-volume rename first; a plugin's temp dir can sit on another
            // volume, where rename fails and a copy is the only way over.
            if std::fs::rename(path, &temp).is_err() {
                std::fs::copy(path, &temp).map_err(|e| {
                    let _ = std::fs::remove_file(&temp);
                    format!("failed to copy resolved file into the collection: {}", e)
                })?;
                let _ = std::fs::remove_file(path);
            }
        }
    }

    // Settle the extension: the hint (or the local file's own), else sniff the
    // bytes, else mp3.
    let file_ext = if named_ext.is_empty() {
        if let DownloadSource::LocalFile(path) = &source {
            path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
        } else {
            String::new()
        }
    } else {
        named_ext
    };
    let final_ext = if file_ext.is_empty() {
        let mut head = [0u8; 16];
        let read = std::fs::File::open(&temp)
            .and_then(|mut f| std::io::Read::read(&mut f, &mut head))
            .unwrap_or(0);
        sniff_audio_ext(&head[..read]).unwrap_or("mp3").to_string()
    } else {
        file_ext
    };
    let filename = crate::downloader::download_filename(artist, title, &final_ext);
    let dest = dest_dir.join(&filename);
    if dest.exists() {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("{} already exists — downloads never overwrite", dest.display()));
    }
    std::fs::rename(&temp, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("failed to move downloaded file into place: {}", e)
    })?;

    // Provider-reported metadata → file tags, best-effort (after the rename so
    // lofty sees the real extension; a tag-write failure must not fail a
    // completed download — same contract as the modal's download_to_path).
    if let Some(t) = &tags {
        if t.title.is_some() || t.artist.is_some() {
            let _ = crate::downloader::write_tags(
                &dest,
                t.title.as_deref().unwrap_or("Unknown"),
                t.artist.as_deref().unwrap_or("Unknown Artist"),
                t.album.as_deref().unwrap_or("Unknown Album"),
                t.track_number,
                t.year,
                t.genre.as_deref(),
                t.cover_url.as_deref(),
            );
        }
    }

    let file_size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let new_id = crate::scanner::process_media_file(db, &dest, Some(collection_id), Some(root_str.as_str()));
    if let Some(id) = new_id {
        let _ = db.refresh_track_after_ingest(id);
    }
    Ok(serde_json::json!({
        "path": dest.to_string_lossy(),
        "fileSize": file_size,
        "libraryTrackId": new_id,
        "indexed": new_id.is_some(),
    }))
}

/// Download a track's *own* source — `subsonic://` or a direct `http(s)://`
/// URL — into a local collection, then index the file so it becomes a library
/// row. Source-faithful by rule: this never resolves through a download
/// provider, never picks a different copy, and refuses every other scheme
/// (see conventions.md "Mixtape export is source-faithful" — same contract).
/// Plugin-scheme tracks download through `POST /v1/downloads/plugin`, where
/// the OWNING plugin resolves them (never a provider picked on the user's
/// behalf).
pub fn download_track_source(
    db: &Arc<Database>,
    track_id: i64,
    collection_id: i64,
    subdir: &str,
) -> Result<Value, String> {
    let track = db.get_track_by_id(track_id).map_err(|e| format!("track {}: {}", track_id, e))?;
    let (url, ext) = if track.path.starts_with("subsonic://") {
        let target = crate::commands::resolve_subsonic_download_target(db, &track.path, None)?;
        (target.url, target.ext)
    } else if track.path.starts_with("http://") || track.path.starts_with("https://") {
        (track.path.clone(), crate::commands::ext_from_direct_url(&track.path))
    } else if track.path.starts_with("file://") {
        return Err("this track is already a local file — nothing to download".to_string());
    } else {
        return Err(format!(
            "only a track's own subsonic:// or http(s):// source can be downloaded here (source-faithful); \
             a {} track is downloaded via POST /v1/downloads/plugin through its owning plugin",
            track.path.split("://").next().unwrap_or("plugin")
        ));
    };

    let artist = track.artist_name.as_deref().unwrap_or("Unknown Artist");
    let ext_hint = if ext == "auto" {
        track.format.clone().unwrap_or_default().to_ascii_lowercase()
    } else {
        ext
    };
    land_download(db, collection_id, subdir, artist, &track.title, &ext_hint, DownloadSource::Url(url, None), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_scopes_fail_closed_without_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let scopes = load_scopes(dir.path());
        assert_eq!(scopes, WriteScopes::default());
        assert!(!scopes.allows(Scope::ModifyTags));
        assert!(!scopes.allows(Scope::ManageFiles));
        assert!(!scopes.allows(Scope::Downloads));
    }

    #[test]
    fn test_scopes_fail_closed_on_garbage() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SCOPES_FILE), "not json").unwrap();
        assert_eq!(load_scopes(dir.path()), WriteScopes::default());
    }

    #[test]
    fn test_scopes_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let scopes = WriteScopes { modify_tags: true, manage_files: false, downloads: true };
        save_scopes(dir.path(), &scopes).unwrap();
        let loaded = load_scopes(dir.path());
        assert_eq!(loaded, scopes);
        assert!(loaded.allows(Scope::ModifyTags));
        assert!(!loaded.allows(Scope::ManageFiles));
        assert!(loaded.allows(Scope::Downloads));
    }

    #[test]
    fn test_audit_appends_and_tails() {
        let dir = tempfile::tempdir().unwrap();
        append_audit(dir.path(), "files.move", "moved 2 files", Some(json!({"n": 2})));
        append_audit(dir.path(), "tags.writeFiles", "tagged 5 tracks", None);
        let tail = read_audit_tail(dir.path(), 10);
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].verb, "files.move");
        assert_eq!(tail[1].verb, "tags.writeFiles");
        assert_eq!(tail[0].detail, Some(json!({"n": 2})));
        // Tail limit keeps the newest.
        let tail = read_audit_tail(dir.path(), 1);
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].verb, "tags.writeFiles");
    }

    #[test]
    fn test_audit_skips_unparseable_lines() {
        let dir = tempfile::tempdir().unwrap();
        append_audit(dir.path(), "a", "one", None);
        std::fs::OpenOptions::new()
            .append(true)
            .open(dir.path().join(AUDIT_FILE))
            .unwrap()
            .write_all(b"corrupt line\n")
            .unwrap();
        append_audit(dir.path(), "b", "two", None);
        let tail = read_audit_tail(dir.path(), 10);
        assert_eq!(tail.len(), 2);
    }

    #[test]
    fn test_parse_relative_dir_accepts_normal_nesting() {
        assert_eq!(parse_relative_dir("Artist/Album").unwrap(), PathBuf::from("Artist/Album"));
        assert_eq!(parse_relative_dir("").unwrap(), PathBuf::new());
        assert_eq!(parse_relative_dir("./Artist").unwrap(), PathBuf::from("Artist"));
    }

    #[test]
    fn test_parse_relative_dir_refuses_traversal_and_absolutes() {
        assert!(parse_relative_dir("../outside").is_err());
        assert!(parse_relative_dir("a/../../b").is_err());
        assert!(parse_relative_dir("/etc").is_err());
        assert!(parse_relative_dir("\\\\server\\share").is_err());
        assert!(parse_relative_dir("C:\\Music").is_err());
        assert!(parse_relative_dir("C:/Music").is_err());
    }

    #[test]
    fn test_ensure_within_root_allows_nonexistent_subdirs() {
        let dir = tempfile::tempdir().unwrap();
        let candidate = dir.path().join("New Artist").join("New Album").join("x.mp3");
        ensure_within_root(dir.path(), &candidate).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn test_ensure_within_root_catches_symlink_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        let candidate = link.join("escaped.mp3");
        assert!(ensure_within_root(root.path(), &candidate).is_err());
    }

    // --- Operation tests (in-memory DB + tempdir collection) ---

    fn seed_local(root: &Path) -> (Database, i64, i64) {
        let db = Database::new_in_memory().expect("in-memory db");
        let col = db
            .add_collection("local", "Test", Some(root.to_str().unwrap()), None, None, None, None, None)
            .unwrap();
        let artist = db.get_or_create_artist("Mover").unwrap();
        std::fs::write(root.join("a.mp3"), b"x").unwrap();
        let id = db
            .upsert_track("a.mp3", "Song A", Some(artist), None, None, Some(100.0), Some("mp3"), None, None, Some(col.id), None)
            .unwrap();
        (db, id, col.id)
    }

    #[test]
    fn test_plan_and_apply_move_updates_disk_and_db() {
        let root = tempfile::tempdir().unwrap();
        let (db, track_id, _col) = seed_local(root.path());

        let moves = vec![MoveRequest {
            track_id,
            to_dir: Some("Mover/Album".to_string()),
            new_name: Some("01 Song A.mp3".to_string()),
        }];
        let (plan, hash) = plan_moves(&db, &moves).unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(hash, plan_hash(&plan));
        assert!(plan[0].to.ends_with("Mover/Album/01 Song A.mp3"));
        // Planning touches nothing.
        assert!(root.path().join("a.mp3").exists());

        let result = apply_moves(&db, &plan);
        assert_eq!(result["failed"].as_array().unwrap().len(), 0);
        assert_eq!(result["moved"].as_array().unwrap().len(), 1);
        assert!(!root.path().join("a.mp3").exists());
        assert!(root.path().join("Mover/Album/01 Song A.mp3").exists());
        // The row kept its id and now computes the new URI.
        let track = db.get_track_by_id(track_id).unwrap();
        assert!(track.path.ends_with("Mover/Album/01 Song A.mp3"), "path was {}", track.path);
        assert!(track.path.starts_with("file://"));
    }

    #[test]
    fn test_plan_refuses_traversal_extension_change_and_overwrite() {
        let root = tempfile::tempdir().unwrap();
        let (db, track_id, _col) = seed_local(root.path());

        let escape = vec![MoveRequest { track_id, to_dir: Some("../out".into()), new_name: None }];
        assert!(plan_moves(&db, &escape).is_err());

        let ext_change = vec![MoveRequest { track_id, to_dir: None, new_name: Some("a.flac".into()) }];
        assert!(plan_moves(&db, &ext_change).unwrap_err().contains("extension"));

        std::fs::write(root.path().join("taken.mp3"), b"y").unwrap();
        let collide = vec![MoveRequest { track_id, to_dir: None, new_name: Some("taken.mp3".into()) }];
        assert!(plan_moves(&db, &collide).unwrap_err().contains("never overwrite"));

        let noop = vec![MoveRequest { track_id, to_dir: None, new_name: None }];
        assert!(plan_moves(&db, &noop).unwrap_err().contains("no-op"));
    }

    #[test]
    fn test_plan_refuses_non_local_collections() {
        let db = Database::new_in_memory().unwrap();
        let col = db
            .add_collection("subsonic", "Navi", None, Some("https://x"), Some("u"), Some("p"), None, None)
            .unwrap();
        let id = db
            .upsert_track("remote-1", "Remote", None, None, None, None, Some("mp3"), None, None, Some(col.id), None)
            .unwrap();
        let moves = vec![MoveRequest { track_id: id, to_dir: Some("x".into()), new_name: None }];
        assert!(plan_moves(&db, &moves).is_err());
    }

    #[test]
    fn test_write_lyrics_file_creates_and_respects_overwrite() {
        let root = tempfile::tempdir().unwrap();
        let (db, track_id, _col) = seed_local(root.path());

        let synced = "[00:01.00] hello\n[00:02.00] world";
        let out = write_lyrics_file(&db, track_id, synced, "auto", false).unwrap();
        assert_eq!(out["kind"], json!("synced"));
        let lrc = root.path().join("a.lrc");
        assert!(lrc.exists());

        // Existing file without overwrite is refused…
        let err = write_lyrics_file(&db, track_id, synced, "synced", false).unwrap_err();
        assert!(err.contains("already exists"));
        // …and plain lyrics land in .txt next to the same stem.
        let out = write_lyrics_file(&db, track_id, "just words", "plain", false).unwrap();
        assert_eq!(out["kind"], json!("plain"));
        assert!(root.path().join("a.txt").exists());
    }

    #[test]
    fn test_write_lyrics_rejects_empty_oversized_and_remote() {
        let root = tempfile::tempdir().unwrap();
        let (db, track_id, col) = seed_local(root.path());
        assert!(write_lyrics_file(&db, track_id, "   ", "auto", false).is_err());
        assert!(write_lyrics_file(&db, track_id, &"x".repeat(200_001), "auto", false).is_err());
        assert!(write_lyrics_file(&db, track_id, "x", "verse", false).is_err());

        let remote = db
            .upsert_track("r-1", "Remote", None, None, None, None, Some("mp3"), None, None, Some(col), None)
            .unwrap();
        // Same collection but the file doesn't exist on disk.
        assert!(write_lyrics_file(&db, remote, "x", "auto", false).is_err());
    }

    #[test]
    fn test_download_refuses_plugin_schemes_and_local_files() {
        let root = tempfile::tempdir().unwrap();
        let (db, local_id, col) = seed_local(root.path());
        let db = Arc::new(db);

        let err = download_track_source(&db, local_id, col, "").unwrap_err();
        assert!(err.contains("already a local file"));

        let plugin = db
            .upsert_track("ytdlp://abc", "Plugin Track", None, None, None, None, None, None, None, None, None)
            .unwrap();
        let err = download_track_source(&db, plugin, col, "").unwrap_err();
        assert!(err.contains("source-faithful"), "got: {}", err);
    }

    #[test]
    fn test_download_validates_destination_before_any_network() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::new_in_memory().unwrap());
        let col = db
            .add_collection("local", "Dest", Some(root.path().to_str().unwrap()), None, None, None, None, None)
            .unwrap();
        let artist = db.get_or_create_artist("Web Artist").unwrap();
        let remote = db
            .upsert_track(
                "https://example.com/media/song.flac", "Web Song", Some(artist),
                None, None, None, Some("flac"), None, None, None, None,
            )
            .unwrap();
        // Traversal in the subdir is refused before the URL is ever fetched.
        let err = download_track_source(&db, remote, col.id, "../evil").unwrap_err();
        assert!(err.contains(".."), "got: {}", err);
        // A disabled or non-local destination collection is refused too.
        let sub = db
            .add_collection("subsonic", "Navi", None, Some("https://x"), Some("u"), Some("p"), None, None)
            .unwrap();
        let err = download_track_source(&db, remote, sub.id, "").unwrap_err();
        assert!(err.contains("not a local folder"), "got: {}", err);
    }

    #[test]
    fn test_land_download_moves_a_resolved_local_file_and_indexes_it() {
        // The plugin-resolve path: the provider already fetched the file
        // (yt-dlp's temp output); landing moves it in, names it, indexes it.
        let staging = tempfile::tempdir().unwrap();
        let resolved = staging.path().join("dl-output.mp3");
        std::fs::write(&resolved, b"ID3fakebytes").unwrap();

        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::new_in_memory().unwrap());
        let col = db
            .add_collection("local", "Dest", Some(root.path().to_str().unwrap()), None, None, None, None, None)
            .unwrap();

        let out = land_download(
            &db, col.id, "Web Artist/Singles", "Web Artist", "Web Song", "",
            DownloadSource::LocalFile(resolved.clone()), None,
        )
        .unwrap();
        let dest = root.path().join("Web Artist/Singles/Web Artist - Web Song.mp3");
        assert!(dest.exists());
        assert!(!resolved.exists(), "the temp file is moved, not copied and left behind");
        assert_eq!(out["indexed"], json!(true));
        let id = out["libraryTrackId"].as_i64().unwrap();
        let track = db.get_track_by_id(id).unwrap();
        assert!(track.path.ends_with("Web Artist - Web Song.mp3"));

        // Landing the same name again is a conflict, never an overwrite.
        std::fs::write(&resolved, b"ID3other").unwrap();
        let err = land_download(
            &db, col.id, "Web Artist/Singles", "Web Artist", "Web Song", "mp3",
            DownloadSource::LocalFile(resolved), None,
        )
        .unwrap_err();
        assert!(err.contains("never overwrite"));
    }

    #[test]
    fn test_plan_hash_pins_the_exact_moves() {
        let a = PlannedMove { track_id: 1, title: "t".into(), from: "/a".into(), to: "/b".into(), to_rel: "b".into() };
        let b = PlannedMove { track_id: 1, title: "t".into(), from: "/a".into(), to: "/c".into(), to_rel: "c".into() };
        assert_ne!(plan_hash(&[a]), plan_hash(&[b]));
    }

    #[test]
    fn test_validate_filename() {
        assert!(validate_filename("cover.jpg").is_ok());
        assert!(validate_filename("Song Title.lrc").is_ok());
        assert!(validate_filename("").is_err());
        assert!(validate_filename(".hidden").is_err());
        assert!(validate_filename("a/b.txt").is_err());
        assert!(validate_filename("a\\b.txt").is_err());
        assert!(validate_filename("a..b").is_err());
        assert!(validate_filename(&"x".repeat(300)).is_err());
    }
}
