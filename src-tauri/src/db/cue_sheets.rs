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
// rather than storing what arrived. Shared types/helpers live in db/mod.rs;
// these are inherent impl Database methods.

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::*;

/// Cues per sheet. A four-minute song with a cue every five seconds is ~50;
/// anything near this is a runaway generation, not a sheet.
pub const MAX_CUES: usize = 200;
pub const MAX_TEXT_CHARS: usize = 400;
pub const MAX_CAPTION_CHARS: usize = 200;
pub const MAX_LABEL_CHARS: usize = 40;
pub const MAX_URL_CHARS: usize = 2048;
pub const MAX_SOURCE_CHARS: usize = 64;
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
    /// The normalized sheet: `{ cues: [...] }`.
    pub sheet: Value,
    pub source: Option<String>,
    pub updated_at: i64,
    /// Save only: fields the normalizer dropped (`ignored_fields`). Not stored.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
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
pub fn normalize_source(source: Option<&str>) -> Option<String> {
    source
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(MAX_SOURCE_CHARS).collect())
}

impl Database {
    pub fn get_cue_sheet(&self, title: &str, artist_name: Option<&str>) -> SqlResult<Option<CueSheetRow>> {
        let key = likes::build_entity_key("track", title, artist_name);
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT title, artist_name, sheet, source, updated_at FROM cue_sheets WHERE entity_key = ?1",
            params![key],
            |r| {
                let sheet: String = r.get(2)?;
                Ok(CueSheetRow {
                    title: r.get(0)?,
                    artist_name: r.get(1)?,
                    // A row is only ever written normalized, so a parse
                    // failure means a hand-edited DB; read it as no cues.
                    sheet: serde_json::from_str(&sheet).unwrap_or_else(|_| json!({ "cues": [] })),
                    source: r.get(3)?,
                    updated_at: r.get(4)?,
                    warnings: Vec::new(),
                })
            },
        )
        .optional()
    }

    /// Upsert. `sheet` must already be normalized (`normalize_cue_sheet`).
    pub fn set_cue_sheet(
        &self,
        title: &str,
        artist_name: Option<&str>,
        sheet: &Value,
        source: Option<&str>,
        updated_at: i64,
    ) -> SqlResult<()> {
        let key = likes::build_entity_key("track", title, artist_name);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO cue_sheets (entity_key, title, artist_name, sheet, source, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(entity_key) DO UPDATE SET
               title = excluded.title,
               artist_name = excluded.artist_name,
               sheet = excluded.sheet,
               source = excluded.source,
               updated_at = excluded.updated_at",
            params![key, title, artist_name, sheet.to_string(), source, updated_at],
        )?;
        Ok(())
    }

    /// Returns whether a sheet existed.
    pub fn delete_cue_sheet(&self, title: &str, artist_name: Option<&str>) -> SqlResult<bool> {
        let key = likes::build_entity_key("track", title, artist_name);
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute("DELETE FROM cue_sheets WHERE entity_key = ?1", params![key])? > 0)
    }
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
        let db = Database::new_in_memory().unwrap();
        let sheet = normalize_cue_sheet(&json!([{ "at": 0, "text": "hi" }])).unwrap();
        db.set_cue_sheet("Jóga", Some("Björk"), &sheet, Some("Claude"), 10).unwrap();

        let row = db.get_cue_sheet("joga", Some("BJORK")).unwrap().unwrap();
        assert_eq!(row.title, "Jóga");
        assert_eq!(row.source.as_deref(), Some("Claude"));
        assert_eq!(row.sheet, sheet);

        // Upsert replaces, keeping one row.
        let sheet2 = normalize_cue_sheet(&json!([{ "at": 3, "text": "again" }])).unwrap();
        db.set_cue_sheet("Joga", Some("Bjork"), &sheet2, None, 20).unwrap();
        let row = db.get_cue_sheet("Jóga", Some("Björk")).unwrap().unwrap();
        assert_eq!(row.sheet, sheet2);
        assert_eq!(row.updated_at, 20);

        assert!(db.delete_cue_sheet("Jóga", Some("Björk")).unwrap());
        assert!(!db.delete_cue_sheet("Jóga", Some("Björk")).unwrap());
        assert!(db.get_cue_sheet("Jóga", Some("Björk")).unwrap().is_none());
    }
}
