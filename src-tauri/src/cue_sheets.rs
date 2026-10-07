// Cue sheets: timed text/image cues an assistant writes for a song, which
// the Now Playing view plays back over the art (`src/utils/cueSheet.ts`,
// `components/CueOverlay.tsx`). Keyed by metadata (the same
// `track:{artist}:{title}` entity key the likes store uses), never by a
// library id, so a cue sheet follows the song onto any copy of it — library,
// stream or a queue entry with no row at all.
//
// The sheet is authored by an LLM through the control API, so this module is
// also the trust boundary for its shape: `normalize_cue_sheet` rebuilds the
// sheet field by field (unknown fields dropped, lengths capped, cues sorted)
// rather than storing what arrived.
//
// Storage is one JSON file per song under `{profile}/cue-sheets/`, not a
// database table: the sheets are presentation content an assistant writes,
// nothing queries across them, and keeping them out of the schema means the
// feature ships no migration.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::db::likes::build_entity_key;

const DIR_NAME: &str = "cue-sheets";

/// Cues per sheet. A four-minute song with a cue every five seconds is ~50;
/// anything near this is a runaway generation, not a sheet.
pub const MAX_CUES: usize = 200;
pub const MAX_TEXT_CHARS: usize = 400;
pub const MAX_CAPTION_CHARS: usize = 200;
pub const MAX_LABEL_CHARS: usize = 40;
pub const MAX_URL_CHARS: usize = 2048;
pub const MAX_AUTHOR_CHARS: usize = 64;
pub const MAX_ALBUM_CHARS: usize = 512;
/// The stored file's layout. 1 = title/artist/sheet/source/updatedAt (no
/// field naming it); 2 adds the song's album + duration, `author` (was
/// `source`), `version` and `createdAt`. Bump on any change a reader must
/// know about.
pub const FORMAT_VERSION: u32 = 2;
/// No song runs a day; a cue past this is a unit mistake (milliseconds).
const MAX_AT_SECS: f64 = 86_400.0;

pub const CUE_KINDS: &[&str] = &["text", "quote", "image", "shape"];
/// `cards`: one captioned card at a time over the art column (the default).
/// `clip`: positioned, animated elements over the whole Now Playing view —
/// a text-and-image video clip. Mirrors `CueSheetMode` in src/utils/cueSheet.ts.
pub const SHEET_MODES: &[&str] = &["cards", "clip"];
/// How long a cue without `until` lasts — `DEFAULT_CUE_SECS` in cueSheet.ts.
const DEFAULT_CUE_SECS: f64 = 10.0;

// Clip-element vocabularies. Closed lists, so the overlay never turns a model's
// string into CSS: every value here maps to code in src/utils/cueClip.ts.
pub const ALIGNS: &[&str] = &["left", "center", "right"];
pub const VALIGNS: &[&str] = &["top", "middle", "bottom"];
pub const FITS: &[&str] = &["cover", "contain", "fill"];
pub const BACKGROUNDS: &[&str] = &["none", "scrim", "card", "solid"];
pub const WEIGHTS: &[&str] = &["regular", "bold"];
pub const CASES: &[&str] = &["normal", "upper"];
pub const COLOR_TOKENS: &[&str] = &["light", "dark", "accent", "muted"];
pub const ENTER_EFFECTS: &[&str] = &[
    "none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "zoom-in", "zoom-out", "blur",
    "typewriter", "words",
];
/// Exits can't "type out": a reveal has nothing to run backwards to.
pub const EXIT_EFFECTS: &[&str] = &[
    "none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "zoom-in", "zoom-out", "blur",
];
pub const DURING_EFFECTS: &[&str] = &[
    "none", "ken-burns", "drift-up", "drift-down", "drift-left", "drift-right", "zoom-slow", "pulse",
];
pub const EASES: &[&str] = &["linear", "in", "out", "in-out"];
pub const MAX_KEYFRAMES: usize = 32;
/// A transition longer than this is a unit mistake, not a slow fade.
const MAX_TRANSITION_SECS: f64 = 10.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueSheetRow {
    pub title: String,
    pub artist_name: Option<String>,
    /// The album of the copy the sheet was written against. Informational —
    /// never part of the key, so the sheet still follows the song everywhere.
    pub album_name: Option<String>,
    /// The length of the copy the cues were timed against. A different-length
    /// version of the song (live, edit, remaster) shares the key, so this is
    /// how a reader tells that the timing came from another cut.
    pub duration_secs: Option<f64>,
    /// Who wrote it (e.g. "Claude"); shown small on the cards / clip.
    pub author: Option<String>,
    /// Revision: 1 for the first save, +1 every time the sheet is replaced.
    pub version: u32,
    pub created_at: i64,
    pub updated_at: i64,
    /// The normalized sheet: `{ cues: [...] }`.
    pub sheet: Value,
    /// Save only: fields the normalizer dropped (`ignored_fields`). Not stored.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// What a save records about the sheet beside its cues. The caller resolves
/// album/duration (the app's own facts first); author is the writer's label.
#[derive(Default)]
pub struct CueSheetMeta<'a> {
    pub album_name: Option<&'a str>,
    pub duration_secs: Option<f64>,
    pub author: Option<&'a str>,
}

/// The on-disk form. Title/artist are kept as written (the filename is a hash
/// of the normalized key), so a read returns the spelling that was saved, and
/// the metadata makes a file self-describing without its name. Every field
/// added after format 1 is defaulted so an older file still reads.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSheet {
    #[serde(default = "legacy_format")]
    format_version: u32,
    title: String,
    artist_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    album_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_secs: Option<f64>,
    /// Format 1 called this `source`.
    #[serde(default, alias = "source")]
    author: Option<String>,
    #[serde(default = "first_version")]
    version: u32,
    /// Format 1 had no creation date; such a file reads it as `updatedAt`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_at: Option<i64>,
    updated_at: i64,
    sheet: Value,
}

fn legacy_format() -> u32 {
    1
}

fn first_version() -> u32 {
    1
}

impl From<StoredSheet> for CueSheetRow {
    fn from(s: StoredSheet) -> Self {
        CueSheetRow {
            title: s.title,
            artist_name: s.artist_name,
            album_name: s.album_name,
            duration_secs: s.duration_secs,
            author: s.author,
            version: s.version,
            created_at: s.created_at.unwrap_or(s.updated_at),
            updated_at: s.updated_at,
            sheet: s.sheet,
            warnings: Vec::new(),
        }
    }
}

const SHEET_FIELDS: &[&str] = &["mode", "cues"];
const CUE_FIELDS: &[&str] = &[
    "at", "until", "kind", "text", "caption", "label", "imageUrl", "box", "align", "valign", "size", "fit",
    "layer", "opacity", "color", "backgroundColor", "background", "weight", "italic", "case", "shadow", "dim",
    "enter", "exit", "during", "keyframes",
];
const BOX_FIELDS: &[&str] = &["x", "y", "w", "h"];
const KEYFRAME_FIELDS: &[&str] = &["t", "x", "y", "scale", "opacity", "rotate", "ease"];
const TRANSITION_FIELDS: &[&str] = &["effect", "duration"];

/// Every field in a (valid) sheet that the normalizer will drop, by path —
/// returned with a save as warnings. Unknown fields are dropped rather than
/// rejected (a model adding a harmless extra shouldn't fail the save), but a
/// silent drop looks exactly like success: the self-test's assistant asked
/// for precisely this after it couldn't tell whether its fields took effect.
pub fn ignored_fields(input: &Value) -> Vec<String> {
    fn unknown(o: &Map<String, Value>, known: &[&str], path: &str, out: &mut Vec<String>) {
        for k in o.keys() {
            if !known.contains(&k.as_str()) {
                out.push(format!("{path}{k} is not a field and was ignored"));
            }
        }
    }
    let mut out = Vec::new();
    let cues = match input {
        Value::Array(a) => a,
        Value::Object(o) => {
            unknown(o, SHEET_FIELDS, "sheet.", &mut out);
            match o.get("cues").and_then(Value::as_array) {
                Some(c) => c,
                None => return out,
            }
        }
        _ => return out,
    };
    for (i, cue) in cues.iter().enumerate() {
        let Some(c) = cue.as_object() else { continue };
        unknown(c, CUE_FIELDS, &format!("cues[{i}]."), &mut out);
        if let Some(b) = c.get("box").and_then(Value::as_object) {
            unknown(b, BOX_FIELDS, &format!("cues[{i}].box."), &mut out);
        }
        for t in ["enter", "exit"] {
            if let Some(o) = c.get(t).and_then(Value::as_object) {
                unknown(o, TRANSITION_FIELDS, &format!("cues[{i}].{t}."), &mut out);
            }
        }
        if let Some(frames) = c.get("keyframes").and_then(Value::as_array) {
            for (k, f) in frames.iter().enumerate() {
                if let Some(f) = f.as_object() {
                    unknown(f, KEYFRAME_FIELDS, &format!("cues[{i}].keyframes[{k}]."), &mut out);
                }
            }
        }
        if c.get("kind").and_then(Value::as_str) == Some("shape") && c.contains_key("color") && !c.contains_key("backgroundColor") {
            out.push(format!("cues[{i}].color colours text; a shape is filled with backgroundColor (used color as the fill)"));
        }
    }
    out
}

fn capped_string(cue: &Map<String, Value>, field: &str, max: usize, idx: usize) -> Result<Option<String>, String> {
    match cue.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                return Ok(None);
            }
            if t.chars().count() > max {
                return Err(format!("cues[{idx}].{field} is longer than {max} characters"));
            }
            Ok(Some(t.to_string()))
        }
        Some(_) => Err(format!("cues[{idx}].{field} must be a string")),
    }
}

fn seconds(cue: &Map<String, Value>, field: &str, idx: usize) -> Result<Option<f64>, String> {
    match cue.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let n = v.as_f64().ok_or_else(|| format!("cues[{idx}].{field} must be a number of seconds"))?;
            if !n.is_finite() || n < 0.0 || n > MAX_AT_SECS {
                return Err(format!("cues[{idx}].{field} must be between 0 and {MAX_AT_SECS} seconds"));
            }
            Ok(Some(n))
        }
    }
}

fn one_of<'a>(v: &'a Value, allowed: &[&str], what: &str) -> Result<&'a str, String> {
    let s = v.as_str().ok_or_else(|| format!("{what} must be a string"))?;
    if allowed.contains(&s) {
        Ok(s)
    } else {
        Err(format!("{what} must be one of {}", allowed.join(", ")))
    }
}

fn number_in(v: &Value, lo: f64, hi: f64, what: &str) -> Result<f64, String> {
    let n = v.as_f64().ok_or_else(|| format!("{what} must be a number"))?;
    if !n.is_finite() || n < lo || n > hi {
        return Err(format!("{what} must be between {lo} and {hi}"));
    }
    Ok(n)
}

/// A colour: one of the skin-safe tokens, or a `#rgb` / `#rrggbb` /
/// `#rrggbbaa` hex. Anything else (rgb(), names, url()) is refused, so a
/// colour can never smuggle CSS into the style it lands in.
fn color(v: &Value, what: &str) -> Result<String, String> {
    let s = v.as_str().ok_or_else(|| format!("{what} must be a string"))?;
    if COLOR_TOKENS.contains(&s) {
        return Ok(s.to_string());
    }
    let hex = s.strip_prefix('#').unwrap_or("");
    if matches!(hex.len(), 3 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(s.to_ascii_lowercase());
    }
    Err(format!("{what} must be one of {} or a hex colour like #ffcc00", COLOR_TOKENS.join(", ")))
}

/// `"fade"` or `{ effect: "fade", duration: 0.8 }` → the object form.
fn transition(v: &Value, allowed: &[&str], what: &str) -> Result<Value, String> {
    match v {
        Value::String(_) => Ok(json!({ "effect": one_of(v, allowed, what)? })),
        Value::Object(o) => {
            let effect = one_of(o.get("effect").unwrap_or(&Value::Null), allowed, &format!("{what}.effect"))?;
            let mut out = Map::new();
            out.insert("effect".into(), json!(effect));
            if let Some(d) = o.get("duration").filter(|d| !d.is_null()) {
                out.insert("duration".into(), json!(number_in(d, 0.0, MAX_TRANSITION_SECS, &format!("{what}.duration"))?));
            }
            Ok(Value::Object(out))
        }
        _ => Err(format!("{what} must be an effect name or {{ effect, duration }}")),
    }
}

/// The clip fields of one cue (position, style, motion), validated and copied
/// into `out`. Kept in either mode so a sheet can switch modes, but only the
/// clip overlay reads them. `life` is the cue's on-screen seconds, which
/// bounds keyframe times.
fn normalize_clip_fields(cue: &Map<String, Value>, idx: usize, life: f64, out: &mut Map<String, Value>) -> Result<(), String> {
    let p = |f: &str| format!("cues[{idx}].{f}");
    let get = |f: &str| cue.get(f).filter(|v| !v.is_null());

    if let Some(b) = get("box") {
        let b = b.as_object().ok_or_else(|| format!("{} must be {{ x, y, w, h }} in percent of the view", p("box")))?;
        let mut bo = Map::new();
        for (f, lo, hi) in [("x", -100.0, 200.0), ("y", -100.0, 200.0), ("w", 0.5, 300.0), ("h", 0.5, 300.0)] {
            let v = b.get(f).ok_or_else(|| format!("{} is required (percent of the view)", p(&format!("box.{f}"))))?;
            bo.insert(f.into(), json!(number_in(v, lo, hi, &p(&format!("box.{f}")))?));
        }
        out.insert("box".into(), Value::Object(bo));
    }
    for (f, allowed) in [
        ("align", ALIGNS), ("valign", VALIGNS), ("fit", FITS), ("background", BACKGROUNDS),
        ("weight", WEIGHTS), ("case", CASES), ("during", DURING_EFFECTS),
    ] {
        if let Some(v) = get(f) {
            out.insert(f.into(), json!(one_of(v, allowed, &p(f))?));
        }
    }
    for (f, lo, hi) in [("size", 0.5, 40.0), ("opacity", 0.0, 1.0), ("dim", 0.0, 0.95)] {
        if let Some(v) = get(f) {
            out.insert(f.into(), json!(number_in(v, lo, hi, &p(f))?));
        }
    }
    if let Some(v) = get("layer") {
        out.insert("layer".into(), json!(number_in(v, -10.0, 10.0, &p("layer"))?.round()));
    }
    for f in ["color", "backgroundColor"] {
        if let Some(v) = get(f) {
            out.insert(f.into(), json!(color(v, &p(f))?));
        }
    }
    for f in ["italic", "shadow"] {
        if let Some(v) = get(f) {
            out.insert(f.into(), json!(v.as_bool().ok_or_else(|| format!("{} must be true or false", p(f)))?));
        }
    }
    if let Some(v) = get("enter") {
        out.insert("enter".into(), transition(v, ENTER_EFFECTS, &p("enter"))?);
    }
    if let Some(v) = get("exit") {
        out.insert("exit".into(), transition(v, EXIT_EFFECTS, &p("exit"))?);
    }
    if let Some(v) = get("keyframes") {
        let frames = v.as_array().ok_or_else(|| format!("{} must be an array", p("keyframes")))?;
        if frames.len() > MAX_KEYFRAMES {
            return Err(format!("{} has {} entries; the limit is {MAX_KEYFRAMES}", p("keyframes"), frames.len()));
        }
        let mut outf: Vec<Value> = Vec::with_capacity(frames.len());
        for (k, raw) in frames.iter().enumerate() {
            let kp = |f: &str| p(&format!("keyframes[{k}].{f}"));
            let fr = raw.as_object().ok_or_else(|| format!("{} must be an object", p(&format!("keyframes[{k}]"))))?;
            let t = fr.get("t").ok_or_else(|| format!("{} is required (seconds after the cue's at)", kp("t")))?;
            let t = number_in(t, 0.0, life, &kp("t"))?;
            let mut fo = Map::new();
            fo.insert("t".into(), json!(t));
            for (f, lo, hi) in [("x", -300.0, 300.0), ("y", -300.0, 300.0), ("scale", 0.0, 10.0), ("opacity", 0.0, 1.0), ("rotate", -3600.0, 3600.0)] {
                if let Some(v) = fr.get(f).filter(|v| !v.is_null()) {
                    fo.insert(f.into(), json!(number_in(v, lo, hi, &kp(f))?));
                }
            }
            if let Some(v) = fr.get("ease").filter(|v| !v.is_null()) {
                fo.insert("ease".into(), json!(one_of(v, EASES, &kp("ease"))?));
            }
            outf.push(Value::Object(fo));
        }
        outf.sort_by(|a, b| a["t"].as_f64().partial_cmp(&b["t"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
        out.insert("keyframes".into(), Value::Array(outf));
    }
    Ok(())
}

/// Validate and rebuild a cue sheet. Accepts `{ cues: [...] }` or a bare
/// array. Every error names the offending cue, because the caller is an LLM
/// that will fix and resend — a vague "invalid sheet" just gets resent as is.
pub fn normalize_cue_sheet(input: &Value) -> Result<Value, String> {
    let cues_in = match input {
        Value::Array(a) => a,
        Value::Object(o) => o
            .get("cues")
            .and_then(Value::as_array)
            .ok_or("sheet.cues must be an array")?,
        _ => return Err("sheet must be an object with a cues array".into()),
    };
    let mode = match input.get("mode").filter(|v| !v.is_null()) {
        Some(v) => one_of(v, SHEET_MODES, "sheet.mode")?,
        None => "cards",
    };
    if cues_in.is_empty() {
        return Err("sheet.cues is empty — delete the sheet instead of saving an empty one".into());
    }
    if cues_in.len() > MAX_CUES {
        return Err(format!("sheet has {} cues; the limit is {MAX_CUES}", cues_in.len()));
    }

    let mut out: Vec<Value> = Vec::with_capacity(cues_in.len());
    for (idx, raw) in cues_in.iter().enumerate() {
        let cue = raw.as_object().ok_or_else(|| format!("cues[{idx}] must be an object"))?;
        let kind = cue.get("kind").and_then(Value::as_str).unwrap_or("text");
        if !CUE_KINDS.contains(&kind) {
            return Err(format!("cues[{idx}].kind must be one of {}", CUE_KINDS.join(", ")));
        }
        let at = seconds(cue, "at", idx)?.ok_or_else(|| format!("cues[{idx}].at is required"))?;
        let until = seconds(cue, "until", idx)?;
        if let Some(u) = until {
            if u <= at {
                return Err(format!("cues[{idx}].until must be after at"));
            }
        }
        let text = capped_string(cue, "text", MAX_TEXT_CHARS, idx)?;
        let caption = capped_string(cue, "caption", MAX_CAPTION_CHARS, idx)?;
        let label = capped_string(cue, "label", MAX_LABEL_CHARS, idx)?;
        let image_url = capped_string(cue, "imageUrl", MAX_URL_CHARS, idx)?;

        match kind {
            "text" | "quote" if text.is_none() => {
                return Err(format!("cues[{idx}] is a {kind} cue and needs text"));
            }
            "image" => {
                let url = image_url.as_deref().ok_or_else(|| format!("cues[{idx}] is an image cue and needs imageUrl"))?;
                // Remote images only: a file path or data URI from an LLM is
                // either a mistake or an attempt to read the disk through <img>.
                if !(url.starts_with("https://") || url.starts_with("http://")) {
                    return Err(format!("cues[{idx}].imageUrl must be an http(s) URL"));
                }
            }
            "shape" if mode != "clip" => {
                return Err(format!("cues[{idx}] is a shape cue, which only a clip sheet (mode: \"clip\") draws"));
            }
            _ => {}
        }

        let mut o = Map::new();
        normalize_clip_fields(cue, idx, until.unwrap_or(at + DEFAULT_CUE_SECS) - at, &mut o)?;
        o.insert("at".into(), json!(at));
        if let Some(u) = until {
            o.insert("until".into(), json!(u));
        }
        o.insert("kind".into(), json!(kind));
        if let Some(t) = text {
            o.insert("text".into(), json!(t));
        }
        if let Some(c) = caption {
            o.insert("caption".into(), json!(c));
        }
        if let Some(l) = label {
            o.insert("label".into(), json!(l));
        }
        if kind == "image" {
            o.insert("imageUrl".into(), json!(image_url));
        }
        out.push(Value::Object(o));
    }
    // Stable sort: two cues at the same second keep the author's order.
    out.sort_by(|a, b| {
        let fa = a["at"].as_f64().unwrap_or(0.0);
        let fb = b["at"].as_f64().unwrap_or(0.0);
        fa.partial_cmp(&fb).unwrap_or(std::cmp::Ordering::Equal)
    });
    // `mode` is written only for clips, so a cards sheet reads exactly as it
    // did before modes existed.
    Ok(if mode == "clip" { json!({ "mode": "clip", "cues": out }) } else { json!({ "cues": out }) })
}

/// Trim + cap the free-text "who wrote this" label (e.g. "Claude").
pub fn normalize_author(author: Option<&str>) -> Option<String> {
    capped_label(author, MAX_AUTHOR_CHARS)
}

/// Trim + cap the album name recorded with a sheet.
pub fn normalize_album(album: Option<&str>) -> Option<String> {
    capped_label(album, MAX_ALBUM_CHARS)
}

/// A usable track length, or none: a zero/negative/non-finite or day-long
/// figure is a unit mistake or an unknown duration, not a length to compare
/// against. Kept to a tenth of a second — nothing compares it more finely.
pub fn normalize_duration(secs: Option<f64>) -> Option<f64> {
    secs.filter(|d| d.is_finite() && *d > 0.0 && *d <= MAX_AT_SECS)
        .map(|d| (d * 10.0).round() / 10.0)
}

fn capped_label(value: Option<&str>, max: usize) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(max).collect())
}

/// Where a profile's sheets live: one JSON file per song, named by the md5 of
/// its entity key (the key holds `:` and arbitrary title text, neither of
/// which belongs in a filename on every platform).
pub fn dir(profile_dir: &Path) -> PathBuf {
    profile_dir.join(DIR_NAME)
}

fn file_for(profile_dir: &Path, title: &str, artist_name: Option<&str>) -> PathBuf {
    let key = build_entity_key("track", title, artist_name);
    dir(profile_dir).join(format!("{:x}.json", md5::compute(key)))
}

pub fn get_cue_sheet(profile_dir: &Path, title: &str, artist_name: Option<&str>) -> Result<Option<CueSheetRow>, String> {
    Ok(read_stored(&file_for(profile_dir, title, artist_name))?.map(CueSheetRow::from))
}

fn read_stored(path: &Path) -> Result<Option<StoredSheet>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read cue sheet: {e}")),
    };
    // A file is only ever written normalized, so a parse failure means a
    // hand-edited or truncated file; read it as no sheet rather than failing
    // the Now Playing view.
    match serde_json::from_slice::<StoredSheet>(&bytes) {
        Ok(s) => Ok(Some(s)),
        Err(e) => {
            log::warn!("Unreadable cue sheet {}: {e}", path.display());
            Ok(None)
        }
    }
}

/// Upsert; returns the stored row. `sheet` must already be normalized
/// (`normalize_cue_sheet`) and `meta` already trimmed (`normalize_*`).
/// Replacing a sheet bumps its `version` and keeps its `createdAt`; an
/// unreadable earlier file counts as no earlier sheet.
pub fn set_cue_sheet(
    profile_dir: &Path,
    title: &str,
    artist_name: Option<&str>,
    sheet: &Value,
    meta: &CueSheetMeta,
    updated_at: i64,
) -> Result<CueSheetRow, String> {
    std::fs::create_dir_all(dir(profile_dir)).map_err(|e| format!("create cue-sheets dir: {e}"))?;
    let path = file_for(profile_dir, title, artist_name);
    let previous = read_stored(&path)?;
    let stored = StoredSheet {
        format_version: FORMAT_VERSION,
        title: title.to_string(),
        artist_name: artist_name.map(str::to_string),
        album_name: meta.album_name.map(str::to_string),
        duration_secs: meta.duration_secs,
        author: meta.author.map(str::to_string),
        version: previous.as_ref().map_or(1, |p| p.version.saturating_add(1)),
        created_at: Some(previous.map_or(updated_at, |p| p.created_at.unwrap_or(p.updated_at))),
        updated_at,
        sheet: sheet.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&stored).map_err(|e| format!("serialize cue sheet: {e}"))?;
    atomic_write(&path, &bytes)?;
    Ok(stored.into())
}

/// Every stored sheet, newest first. Unreadable files are skipped (as
/// `get_cue_sheet` reads them as no sheet); a missing directory is no sheets.
pub fn list_cue_sheets(profile_dir: &Path) -> Result<Vec<CueSheetRow>, String> {
    let entries = match std::fs::read_dir(dir(profile_dir)) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("list cue sheets: {e}")),
    };
    let mut rows: Vec<CueSheetRow> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Some(stored) = read_stored(&path)? {
            rows.push(stored.into());
        }
    }
    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(rows)
}

/// Returns whether a sheet existed.
pub fn delete_cue_sheet(profile_dir: &Path, title: &str, artist_name: Option<&str>) -> Result<bool, String> {
    match std::fs::remove_file(file_for(profile_dir, title, artist_name)) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("delete cue sheet: {e}")),
    }
}

/// Write-then-rename, so a crash mid-write leaves the old sheet or the new
/// one, never half of either.
fn atomic_write(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut tmp_os = dest.as_os_str().to_owned();
    tmp_os.push(".tmp");
    let tmp = PathBuf::from(tmp_os);
    std::fs::write(&tmp, bytes).map_err(|e| format!("write cue sheet: {e}"))?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("write cue sheet: {e}")
    })
}

#[cfg(test)]
mod cue_tests {
    use super::*;

    #[test]
    fn normalize_sorts_drops_unknown_fields_and_defaults_kind() {
        let sheet = normalize_cue_sheet(&json!({ "cues": [
            { "at": 30, "text": "second", "evil": "<script>" },
            { "at": 5.5, "kind": "quote", "text": "first", "caption": "why", "until": 9 },
        ]}))
        .unwrap();
        let cues = sheet["cues"].as_array().unwrap();
        assert_eq!(cues[0]["text"], "first");
        assert_eq!(cues[0]["until"], 9.0);
        assert_eq!(cues[1]["kind"], "text");
        assert!(cues[1].get("evil").is_none());
    }

    #[test]
    fn normalize_accepts_a_bare_array() {
        assert!(normalize_cue_sheet(&json!([{ "at": 0, "text": "hi" }])).is_ok());
    }

    #[test]
    fn normalize_rejects_bad_cues_naming_the_index() {
        for (bad, needle) in [
            (json!({ "cues": [] }), "empty"),
            (json!({ "cues": [{ "text": "no time" }] }), "cues[0].at"),
            (json!({ "cues": [{ "at": -1, "text": "x" }] }), "cues[0].at"),
            (json!({ "cues": [{ "at": 1, "until": 1, "text": "x" }] }), "until"),
            (json!({ "cues": [{ "at": 1, "kind": "video", "text": "x" }] }), "kind"),
            (json!({ "cues": [{ "at": 1, "kind": "text" }] }), "needs text"),
            (json!({ "cues": [{ "at": 0, "text": "ok" }, { "at": 1, "kind": "image" }] }), "cues[1]"),
            (json!({ "cues": [{ "at": 1, "kind": "image", "imageUrl": "file:///etc/passwd" }] }), "http(s)"),
            (json!({ "cues": [{ "at": 1, "text": "x".repeat(MAX_TEXT_CHARS + 1) }] }), "longer"),
        ] {
            let err = normalize_cue_sheet(&bad).unwrap_err();
            assert!(err.contains(needle), "{bad} → {err}");
        }
        let too_many: Vec<Value> = (0..=MAX_CUES).map(|i| json!({ "at": i, "text": "x" })).collect();
        assert!(normalize_cue_sheet(&json!({ "cues": too_many })).is_err());
    }

    #[test]
    fn clip_fields_are_kept_validated_and_keyframes_sorted() {
        let sheet = normalize_cue_sheet(&json!({ "mode": "clip", "cues": [{
            "at": 4, "until": 12, "kind": "text", "text": "ROMAN HOLIDAY",
            "box": { "x": 5, "y": 60, "w": 90, "h": 30 }, "align": "left", "valign": "bottom",
            "size": 12, "color": "#FFCC00", "background": "solid", "backgroundColor": "dark",
            "weight": "bold", "case": "upper", "italic": false, "layer": 2.4, "dim": 0.5,
            "enter": "typewriter", "exit": { "effect": "fade", "duration": 1.5 }, "during": "drift-up",
            "keyframes": [{ "t": 6, "x": 10, "ease": "in-out" }, { "t": 0, "scale": 0.5 }],
            "style": "font-family: evil",
        }, { "at": 0, "until": 20, "kind": "shape", "box": { "x": 0, "y": 0, "w": 100, "h": 100 }, "backgroundColor": "#000" }]}))
        .unwrap();
        assert_eq!(sheet["mode"], "clip");
        let c = &sheet["cues"][1];
        assert_eq!(c["box"]["y"], 60.0);
        assert_eq!(c["color"], "#ffcc00");
        assert_eq!(c["layer"], 2.0);
        assert_eq!(c["enter"], json!({ "effect": "typewriter" }));
        assert_eq!(c["exit"], json!({ "effect": "fade", "duration": 1.5 }));
        assert_eq!(c["keyframes"][0]["t"], 0.0);
        assert_eq!(c["keyframes"][1]["ease"], "in-out");
        assert!(c.get("style").is_none());
        assert_eq!(sheet["cues"][0]["kind"], "shape");
        // A cards sheet stays as it always was: no mode key.
        assert!(normalize_cue_sheet(&json!([{ "at": 0, "text": "hi" }])).unwrap().get("mode").is_none());
    }

    #[test]
    fn clip_fields_reject_bad_values_naming_the_field() {
        let clip = |cue: Value| normalize_cue_sheet(&json!({ "mode": "clip", "cues": [cue] }));
        for (cue, needle) in [
            (json!({ "at": 0, "text": "x", "box": { "x": 0, "y": 0, "w": 50 } }), "cues[0].box.h"),
            (json!({ "at": 0, "text": "x", "align": "justify" }), "cues[0].align must be one of"),
            (json!({ "at": 0, "text": "x", "color": "red" }), "cues[0].color"),
            (json!({ "at": 0, "text": "x", "color": "#12345" }), "hex"),
            (json!({ "at": 0, "text": "x", "backgroundColor": "url(x)" }), "backgroundColor"),
            (json!({ "at": 0, "text": "x", "size": 90 }), "cues[0].size"),
            (json!({ "at": 0, "text": "x", "exit": "typewriter" }), "cues[0].exit"),
            (json!({ "at": 0, "text": "x", "enter": { "effect": "fade", "duration": 60 } }), "enter.duration"),
            (json!({ "at": 0, "until": 5, "text": "x", "keyframes": [{ "t": 8 }] }), "keyframes[0].t"),
            (json!({ "at": 0, "text": "x", "keyframes": [{ "x": 1 }] }), "keyframes[0].t is required"),
            (json!({ "at": 0, "text": "x", "keyframes": [{ "t": 1, "ease": "bounce" }] }), "keyframes[0].ease"),
        ] {
            let err = clip(cue.clone()).unwrap_err();
            assert!(err.contains(needle), "{cue} → {err}");
        }
        assert!(normalize_cue_sheet(&json!({ "mode": "movie", "cues": [{ "at": 0, "text": "x" }] })).unwrap_err().contains("sheet.mode"));
        // Shapes have nothing to show on a card.
        assert!(normalize_cue_sheet(&json!([{ "at": 0, "kind": "shape" }])).unwrap_err().contains("clip"));
    }

    #[test]
    fn ignored_fields_names_every_dropped_field_by_path() {
        let w = ignored_fields(&json!({ "mode": "clip", "title": "x", "cues": [
            { "at": 0, "text": "ok", "colour": "red", "box": { "x": 0, "y": 0, "w": 1, "h": 1, "z": 2 },
              "enter": { "effect": "fade", "speed": 2 }, "keyframes": [{ "t": 0, "skew": 3 }] },
            { "at": 1, "kind": "shape", "color": "#123456" },
        ]}));
        assert_eq!(w, vec![
            "sheet.title is not a field and was ignored",
            "cues[0].colour is not a field and was ignored",
            "cues[0].box.z is not a field and was ignored",
            "cues[0].enter.speed is not a field and was ignored",
            "cues[0].keyframes[0].skew is not a field and was ignored",
            "cues[1].color colours text; a shape is filled with backgroundColor (used color as the fill)",
        ]);
        assert!(ignored_fields(&json!([{ "at": 0, "text": "fine" }])).is_empty());
    }

    #[test]
    fn sheets_are_keyed_by_normalized_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let sheet = normalize_cue_sheet(&json!([{ "at": 0, "text": "hi" }])).unwrap();
        assert!(get_cue_sheet(dir, "Jóga", Some("Björk")).unwrap().is_none());
        let meta = CueSheetMeta { album_name: Some("Homogenic"), duration_secs: Some(305.2), author: Some("Claude") };
        set_cue_sheet(dir, "Jóga", Some("Björk"), &sheet, &meta, 10).unwrap();

        let row = get_cue_sheet(dir, "joga", Some("BJORK")).unwrap().unwrap();
        assert_eq!(row.title, "Jóga");
        assert_eq!(row.author.as_deref(), Some("Claude"));
        assert_eq!(row.album_name.as_deref(), Some("Homogenic"));
        assert_eq!(row.duration_secs, Some(305.2));
        assert_eq!((row.version, row.created_at, row.updated_at), (1, 10, 10));
        assert_eq!(row.sheet, sheet);

        // Upsert replaces, keeping one file — and counts the revision while
        // the creation date stays put.
        let sheet2 = normalize_cue_sheet(&json!([{ "at": 3, "text": "again" }])).unwrap();
        let saved = set_cue_sheet(dir, "Joga", Some("Bjork"), &sheet2, &CueSheetMeta::default(), 20).unwrap();
        let row = get_cue_sheet(dir, "Jóga", Some("Björk")).unwrap().unwrap();
        assert_eq!(row.sheet, sheet2);
        assert_eq!((row.version, row.created_at, row.updated_at), (2, 10, 20));
        assert_eq!((saved.version, saved.created_at), (2, 10));
        assert!(row.author.is_none() && row.duration_secs.is_none());
        assert_eq!(std::fs::read_dir(super::dir(dir)).unwrap().count(), 1);

        assert!(delete_cue_sheet(dir, "Jóga", Some("Björk")).unwrap());
        assert!(!delete_cue_sheet(dir, "Jóga", Some("Björk")).unwrap());
        assert!(get_cue_sheet(dir, "Jóga", Some("Björk")).unwrap().is_none());
    }

    #[test]
    fn list_returns_every_readable_sheet_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_cue_sheets(tmp.path()).unwrap().is_empty(), "no folder yet is no sheets");
        let sheet = normalize_cue_sheet(&json!([{ "at": 0, "text": "hi" }])).unwrap();
        set_cue_sheet(tmp.path(), "Old", Some("Band"), &sheet, &CueSheetMeta::default(), 1).unwrap();
        set_cue_sheet(tmp.path(), "New", Some("Band"), &sheet, &CueSheetMeta::default(), 9).unwrap();
        set_cue_sheet(tmp.path(), "Broken", None, &sheet, &CueSheetMeta::default(), 5).unwrap();
        std::fs::write(file_for(tmp.path(), "Broken", None), b"{ truncated").unwrap();
        std::fs::write(super::dir(tmp.path()).join("stray.json.tmp"), b"{}").unwrap();

        let titles: Vec<String> = list_cue_sheets(tmp.path()).unwrap().into_iter().map(|r| r.title).collect();
        assert_eq!(titles, ["New", "Old"]);
    }

    #[test]
    fn an_unreadable_file_reads_as_no_sheet() {
        let tmp = tempfile::tempdir().unwrap();
        let sheet = normalize_cue_sheet(&json!([{ "at": 0, "text": "hi" }])).unwrap();
        set_cue_sheet(tmp.path(), "Song", None, &sheet, &CueSheetMeta::default(), 1).unwrap();
        std::fs::write(file_for(tmp.path(), "Song", None), b"{ truncated").unwrap();
        assert!(get_cue_sheet(tmp.path(), "Song", None).unwrap().is_none());
        // Saving over it starts the count again rather than failing.
        let row = set_cue_sheet(tmp.path(), "Song", None, &sheet, &CueSheetMeta::default(), 5).unwrap();
        assert_eq!((row.version, row.created_at), (1, 5));
    }

    #[test]
    fn a_format_1_file_reads_with_its_source_as_author() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(super::dir(tmp.path())).unwrap();
        std::fs::write(
            file_for(tmp.path(), "Song", Some("Band")),
            br#"{ "title": "Song", "artistName": "Band", "sheet": { "cues": [] }, "source": "Claude", "updatedAt": 7 }"#,
        )
        .unwrap();
        let row = get_cue_sheet(tmp.path(), "Song", Some("Band")).unwrap().unwrap();
        assert_eq!(row.author.as_deref(), Some("Claude"));
        assert_eq!((row.version, row.created_at, row.updated_at), (1, 7, 7));
        assert!(row.album_name.is_none() && row.duration_secs.is_none());

        // The next save writes the current format, continuing the old file's history.
        let sheet = normalize_cue_sheet(&json!([{ "at": 0, "text": "hi" }])).unwrap();
        let meta = CueSheetMeta { author: Some("Claude"), ..Default::default() };
        set_cue_sheet(tmp.path(), "Song", Some("Band"), &sheet, &meta, 9).unwrap();
        let raw: Value = serde_json::from_slice(&std::fs::read(file_for(tmp.path(), "Song", Some("Band"))).unwrap()).unwrap();
        assert_eq!(raw["formatVersion"], FORMAT_VERSION);
        assert_eq!(raw["author"], "Claude");
        assert_eq!((raw["version"].as_u64(), raw["createdAt"].as_i64()), (Some(2), Some(7)));
        assert!(raw.get("source").is_none());
    }

    #[test]
    fn metadata_is_trimmed_and_bad_durations_dropped() {
        assert_eq!(normalize_author(Some("  Claude  ")).as_deref(), Some("Claude"));
        assert_eq!(normalize_author(Some("   ")), None);
        assert_eq!(normalize_author(Some(&"x".repeat(100))).map(|s| s.chars().count()), Some(MAX_AUTHOR_CHARS));
        assert_eq!(normalize_album(Some(" Homogenic ")).as_deref(), Some("Homogenic"));
        assert_eq!(normalize_duration(Some(305.24)), Some(305.2));
        for bad in [0.0, -3.0, f64::NAN, f64::INFINITY, 90_000.0] {
            assert_eq!(normalize_duration(Some(bad)), None, "{bad}");
        }
    }
}
