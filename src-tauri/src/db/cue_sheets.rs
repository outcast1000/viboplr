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

pub const CUE_KINDS: &[&str] = &["text", "quote", "image"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueSheetRow {
    pub title: String,
    pub artist_name: Option<String>,
    /// The normalized sheet: `{ cues: [...] }`.
    pub sheet: Value,
    pub source: Option<String>,
    pub updated_at: i64,
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
            _ => {}
        }

        let mut o = Map::new();
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
    Ok(json!({ "cues": out }))
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
