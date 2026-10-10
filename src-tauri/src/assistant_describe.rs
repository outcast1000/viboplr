//! One readable line for what an assistant call actually did.
//!
//! `assistant_activity::classify` says *what kind* of call it was ("Add to the
//! queue"); this says *to what* ("3 tracks at the end: “So What” – Miles
//! Davis, “Blue in Green” – Miles Davis +1 more"). It is what makes the pill,
//! the Settings log and the app log worth reading: a label alone never named
//! the track, the playlist or the tag.
//!
//! Everything here is pure. The one thing it needs from outside, track and
//! playlist **names** for ids, is passed in as [`Names`], which the middleware
//! fills from the database (`subjects` says which ids to look up), so the
//! wording is testable without a database and the lookup stays in one place.
//!
//! The request body comes from the caller, so nothing is echoed raw: strings
//! are truncated, arrays become counts, and keys that look like credentials
//! are masked.

use serde_json::Value;
use std::collections::HashMap;

/// Track names shown before "+N more".
const NAMED_TRACKS: usize = 3;
/// Longest single string echoed into a detail line.
const MAX_STR: usize = 60;
/// Longest whole detail line.
const MAX_DETAIL: usize = 240;

/// What the middleware should look up before describing.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Subjects {
    /// The first few track ids the call names, in order.
    pub track_ids: Vec<i64>,
    pub playlist_id: Option<i64>,
}

/// Names for the ids [`subjects`] asked about. Missing entries are fine — the
/// description falls back to a count.
#[derive(Debug, Default)]
pub struct Names {
    /// id → `Title – Artist`
    pub tracks: HashMap<i64, String>,
    pub playlist: Option<String>,
}

fn as_i64_list(v: &Value) -> Vec<i64> {
    v.as_array()
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}

/// The numeric segment right after `collection` in a concrete path
/// (`/v1/tracks/123/tags`, `"tracks"` → 123).
fn path_id(path: &str, collection: &str) -> Option<i64> {
    let mut segs = path.split('/');
    segs.find(|s| *s == collection)?;
    segs.next()?.parse().ok()
}

/// The non-numeric segment after `collection` (`/v1/extensions/ytdlp/enabled`).
fn path_name<'a>(path: &'a str, collection: &str) -> Option<&'a str> {
    let mut segs = path.split('/');
    segs.find(|s| *s == collection)?;
    segs.next().filter(|s| !s.is_empty())
}

/// Which ids to resolve to names for this call.
pub fn subjects(path: &str, req: &Value) -> Subjects {
    let mut track_ids: Vec<i64> = as_i64_list(&req["trackIds"]);
    if let Some(id) = req["trackId"].as_i64() {
        track_ids.push(id);
    }
    if let Some(id) = path_id(path, "tracks") {
        track_ids.push(id);
    }
    track_ids.truncate(NAMED_TRACKS);
    Subjects {
        track_ids,
        playlist_id: path_id(path, "playlists"),
    }
}

fn trunc(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

fn quote(s: &str) -> String {
    format!("“{}”", trunc(s, MAX_STR))
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v[key].as_str().map(str::trim).filter(|s| !s.is_empty())
}

/// `“Title” – Artist` from a body's own fields.
fn titled(v: &Value, title_key: &str) -> Option<String> {
    let title = str_of(v, title_key)?;
    Some(match str_of(v, "artistName") {
        Some(a) => format!("{} – {}", quote(title), trunc(a, MAX_STR)),
        None => quote(title),
    })
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{} {}", n, if n == 1 { one } else { many })
}

/// "“A” – X, “B” – Y +1 more", or "3 tracks" when names are unavailable.
fn tracks_phrase(req: &Value, path: &str, names: &Names) -> Option<String> {
    let all = as_i64_list(&req["trackIds"]);
    let total = if !all.is_empty() {
        all.len()
    } else if req["trackId"].is_i64() || path_id(path, "tracks").is_some() {
        1
    } else {
        return None;
    };
    let ids = subjects(path, req).track_ids;
    let named: Vec<String> = ids
        .iter()
        .filter_map(|id| names.tracks.get(id).map(|n| trunc_name(n)))
        .collect();
    if named.is_empty() {
        return Some(plural(total, "track", "tracks"));
    }
    let shown = named.len();
    let more = total.saturating_sub(shown);
    let list = named.join(", ");
    Some(if more > 0 {
        format!("{} +{} more", list, more)
    } else {
        list
    })
}

/// A looked-up `Title – Artist` becomes `“Title” – Artist`.
fn trunc_name(n: &str) -> String {
    match n.split_once(" – ") {
        Some((t, a)) => format!("{} – {}", quote(t), trunc(a, MAX_STR)),
        None => quote(n),
    }
}

fn playlist_phrase(names: &Names, path: &str) -> String {
    match (&names.playlist, path_id(path, "playlists")) {
        (Some(n), _) => format!("playlist {}", quote(n)),
        (None, Some(id)) => format!("playlist #{}", id),
        _ => "a playlist".to_string(),
    }
}

fn on_off(v: &Value) -> Option<&'static str> {
    v.as_bool().map(|b| if b { "on" } else { "off" })
}

fn is_secretish(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["token", "secret", "password", "passwd", "auth", "cookie", "apikey", "api_key", "key"]
        .iter()
        .any(|w| k.contains(w))
}

/// `key=value` pairs for a body nobody wrote a description for (plugin tool
/// arguments above all). Scalars only; arrays and objects become counts, long
/// strings are cut, credential-looking keys are masked.
pub fn summarize_args(v: &Value) -> Option<String> {
    let obj = v.as_object()?;
    let parts: Vec<String> = obj
        .iter()
        .filter(|(_, val)| !val.is_null())
        .take(6)
        .map(|(k, val)| {
            let shown = if is_secretish(k) {
                "…".to_string()
            } else {
                match val {
                    Value::String(s) => format!("“{}”", trunc(s, 40)),
                    Value::Array(a) => format!("[{}]", a.len()),
                    Value::Object(o) => format!("{{{}}}", o.len()),
                    other => other.to_string(),
                }
            };
            format!("{}={}", k, shown)
        })
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}

fn cap(s: String) -> String {
    trunc(&s, MAX_DETAIL)
}

/// What the call was asked to do, in one line. `route` is the router pattern,
/// `path` the concrete path (for ids), `req` the parsed request body.
pub fn describe(route: &str, path: &str, req: &Value, names: &Names) -> Option<String> {
    let tracks = || tracks_phrase(req, path, names);
    let out = match route {
        "/v1/likes" => {
            let verb = match req["likeState"].as_i64() {
                Some(1) => "Liked",
                Some(-1) => "Disliked",
                _ => "Cleared the like on",
            };
            let kind = str_of(req, "kind").unwrap_or("item");
            let subject = if kind == "track" || kind == "album" {
                titled(req, "title")
            } else {
                str_of(req, "name").map(quote)
            };
            format!("{} {} {}", verb, kind, subject.unwrap_or_default()).trim().to_string()
        }
        "/v1/tracks/{id}/tags" => {
            let mut changes: Vec<String> = Vec::new();
            for (key, sign) in [("add", "+"), ("remove", "−")] {
                if let Some(a) = req[key].as_array() {
                    changes.extend(a.iter().filter_map(Value::as_str).map(|t| format!("{}{}", sign, trunc(t, 30))));
                }
            }
            format!("{}: {}", tracks()?, changes.join(", "))
        }
        "/v1/tracks/file-tags" => {
            let mut parts: Vec<String> = Vec::new();
            for key in ["title", "artistName", "albumArtistName", "albumTitle", "year", "trackNumber"] {
                if let Some(v) = req.get(key) {
                    let shown = match v {
                        Value::Null => "cleared".to_string(),
                        Value::String(s) => quote(s),
                        other => other.to_string(),
                    };
                    parts.push(format!("{} {}", key, shown));
                }
            }
            if let Some(tags) = req["tagNames"].as_array() {
                let mode = str_of(req, "tagMode").unwrap_or("add");
                let list: Vec<&str> = tags.iter().filter_map(Value::as_str).take(5).collect();
                parts.push(format!("tags {} [{}]", mode, list.join(", ")));
            }
            format!("Into the files of {}: {}", tracks()?, parts.join("; "))
        }
        "/v1/queue/tracks" => {
            if req.get("indices").is_some() {
                format!("Remove {}", plural(as_i64_list(&req["indices"]).len(), "row", "rows"))
            } else {
                let place = if str_of(req, "mode") == Some("next") { "next" } else { "at the end" };
                format!("{} ({})", tracks()?, place)
            }
        }
        "/v1/queue/play" => tracks()?,
        "/v1/queue/jump" => format!("Row {}", req["index"].as_i64().map(|i| i + 1).unwrap_or(0)),
        "/v1/playback" => {
            let mut parts: Vec<String> = Vec::new();
            if let Some(a) = str_of(req, "action") {
                parts.push(a.to_string());
            }
            if let Some(p) = req["play"].as_bool() {
                parts.push(if p { "play" } else { "pause" }.to_string());
            }
            if let Some(v) = req["volume"].as_f64() {
                parts.push(format!("volume {}%", (v.clamp(0.0, 1.0) * 100.0).round() as i64));
            }
            if let Some(s) = req["seekSecs"].as_f64() {
                let s = s.max(0.0) as i64;
                parts.push(format!("seek to {}:{:02}", s / 60, s % 60));
            }
            if let Some(m) = str_of(req, "mode") {
                parts.push(format!("queue mode {}", m));
            }
            parts.join(", ")
        }
        "/v1/radio" => titled(req, "title").or_else(tracks)?,
        "/v1/playlists" => {
            let name = str_of(req, "name").map(quote).unwrap_or_default();
            match as_i64_list(&req["trackIds"]).len() {
                0 => format!("New playlist {}", name),
                n => format!("New playlist {} with {}", name, plural(n, "track", "tracks")),
            }
        }
        "/v1/playlists/{id}/tracks" => {
            let pl = playlist_phrase(names, path);
            if req.get("playlistTrackIds").is_some() {
                format!("{}: remove {}", pl, plural(as_i64_list(&req["playlistTrackIds"]).len(), "row", "rows"))
            } else {
                format!("{}: add {}", pl, tracks()?)
            }
        }
        "/v1/playlists/{id}/order" => format!("Reorder {}", playlist_phrase(names, path)),
        "/v1/playlists/{id}/play" | "/v1/playlists/{id}/enqueue" => playlist_phrase(names, path),
        "/v1/playlists/{id}" => format!(
            "{} → {}",
            playlist_phrase(names, path),
            str_of(req, "name").map(quote).unwrap_or_else(|| "(unchanged)".to_string())
        ),
        "/v1/collections/{id}/rescan" => format!(
            "Collection #{}{}",
            path_id(path, "collections").unwrap_or(0),
            if req["full"].as_bool() == Some(true) { " (full rescan)" } else { "" }
        ),
        "/v1/history/rename" => {
            let from = match str_of(req, "fromTitle") {
                Some(t) => format!("{} – {}", quote(t), str_of(req, "fromArtist").unwrap_or("?")),
                None => format!("artist {}", quote(str_of(req, "fromArtist").unwrap_or("?"))),
            };
            let to = [str_of(req, "toArtist"), str_of(req, "toTitle")]
                .into_iter()
                .flatten()
                .map(quote)
                .collect::<Vec<_>>()
                .join(" / ");
            let dry = if req["dryRun"].as_bool() == Some(true) { " (preview only)" } else { "" };
            format!("{} → {}{}", from, to, dry)
        }
        "/v1/tracks/{id}/lyrics-file" | "/v1/tracks/{id}/download" => tracks()?,
        "/v1/tracks/{id}/replace-file" => {
            let step = if req["discard"].as_bool() == Some(true) {
                "discard the staged copy"
            } else if req.get("stageId").is_some() {
                "confirm the replacement"
            } else {
                "stage a replacement"
            };
            format!("{}: {}", tracks()?, step)
        }
        "/v1/albums/{id}/cover-file" => format!("Album #{}", path_id(path, "albums").unwrap_or(0)),
        "/v1/cues" => {
            let song = titled(req, "title").or_else(|| titled(&req["track"], "title"))?;
            match req["sheet"]["cues"].as_array().or_else(|| req["cues"].as_array()) {
                Some(c) => format!("{} · {}", song, plural(c.len(), "cue", "cues")),
                None => song,
            }
        }
        "/v1/logs" => {
            let mut parts = Vec::new();
            if let Some(s) = on_off(&req["enabled"]) {
                parts.push(format!("logging {}", s));
            }
            if let Some(s) = on_off(&req["debug"]) {
                parts.push(format!("debug logging {}", s));
            }
            parts.join(", ")
        }
        "/v1/extensions/{id}/enabled" => format!(
            "{} → {}",
            path_name(path, "extensions").unwrap_or("?"),
            on_off(&req["enabled"]).unwrap_or("?")
        ),
        "/v1/extensions/{id}/install" => path_name(path, "extensions").unwrap_or("?").to_string(),
        "/v1/skins/apply" => str_of(req, "id").or_else(|| str_of(req, "name"))?.to_string(),
        "/v1/actions/invoke" => {
            let action = str_of(req, "actionId")?;
            match str_of(req, "pluginId") {
                Some(p) => format!("{} ({})", action, p),
                None => action.to_string(),
            }
        }
        "/v1/assistant/invoke" => summarize_args(&req["args"])?,
        "/v1/plugins/{id}/deep-link" => format!(
            "{} {}",
            path_name(path, "plugins").unwrap_or("?"),
            summarize_args(req).unwrap_or_default()
        )
        .trim()
        .to_string(),
        _ => summarize_args(req)?,
    };
    let out = out.trim().to_string();
    if out.is_empty() { None } else { Some(cap(out)) }
}

/// What came back, when it adds something the request didn't say.
pub fn describe_result(route: &str, res: &Value) -> Option<String> {
    let out = match route {
        "/v1/queue/tracks" => {
            let added = res["added"].as_i64()?;
            match res["skippedDuplicates"].as_i64().unwrap_or(0) {
                0 => format!("added {}", added),
                d => format!("added {}, skipped {} {}", added, d, if d == 1 { "duplicate" } else { "duplicates" }),
            }
        }
        "/v1/queue/play" | "/v1/radio" => format!("queued {}", res["queued"].as_i64()?),
        "/v1/queue/randomize" => format!("{} in the queue", res["queueLength"].as_i64()?),
        "/v1/queue/jump" => format!("playing {}", quote(res["title"].as_str()?)),
        "/v1/playlists" => format!("playlist #{}, {} added", res["playlistId"].as_i64()?, res["added"].as_i64().unwrap_or(0)),
        "/v1/tracks/{id}/tags" => {
            let tags: Vec<&str> = res["tags"].as_array()?.iter().filter_map(Value::as_str).take(8).collect();
            format!("tags now: {}", if tags.is_empty() { "none".to_string() } else { tags.join(", ") })
        }
        "/v1/tracks/file-tags" => {
            let (n, failed) = (res["requested"].as_i64()?, res["failed"].as_i64().unwrap_or(0));
            if failed == 0 { format!("{} written", n) } else { format!("{} of {} failed", failed, n) }
        }
        "/v1/history/rename" => {
            let moved = res["playsMoved"].as_i64().or_else(|| res["plays"].as_i64())?;
            format!("{} plays re-filed", moved)
        }
        _ => return None,
    };
    Some(cap(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn names(pairs: &[(i64, &str)]) -> Names {
        Names {
            tracks: pairs.iter().map(|(i, n)| (*i, n.to_string())).collect(),
            playlist: None,
        }
    }

    #[test]
    fn test_a_like_names_the_song_and_the_direction() {
        let n = Names::default();
        let d = describe("/v1/likes", "/v1/likes", &json!({"kind":"track","title":"So What","artistName":"Miles Davis","likeState":1}), &n);
        assert_eq!(d.as_deref(), Some("Liked track “So What” – Miles Davis"));
        let d = describe("/v1/likes", "/v1/likes", &json!({"kind":"artist","name":"Björk","likeState":-1}), &n);
        assert_eq!(d.as_deref(), Some("Disliked artist “Björk”"));
        let d = describe("/v1/likes", "/v1/likes", &json!({"kind":"tag","name":"jazz","likeState":0}), &n);
        assert_eq!(d.as_deref(), Some("Cleared the like on tag “jazz”"));
    }

    #[test]
    fn test_tag_edit_names_the_track_from_the_path_and_shows_the_changes() {
        let n = names(&[(48, "Blue in Green – Miles Davis")]);
        let d = describe("/v1/tracks/{id}/tags", "/v1/tracks/48/tags", &json!({"add":["modal jazz","1959"],"remove":["jazz"]}), &n);
        assert_eq!(d.as_deref(), Some("“Blue in Green” – Miles Davis: +modal jazz, +1959, −jazz"));
    }

    #[test]
    fn test_queue_add_names_a_few_tracks_and_counts_the_rest() {
        let n = names(&[(1, "A – X"), (2, "B – Y"), (3, "C – Z")]);
        let req = json!({"trackIds":[1,2,3,4,5],"mode":"next"});
        let d = describe("/v1/queue/tracks", "/v1/queue/tracks", &req, &n).unwrap();
        assert_eq!(d, "“A” – X, “B” – Y, “C” – Z +2 more (next)");
        // Without names it still says how many.
        let d = describe("/v1/queue/tracks", "/v1/queue/tracks", &req, &Names::default()).unwrap();
        assert_eq!(d, "5 tracks (next)");
    }

    #[test]
    fn test_subjects_ask_only_for_the_first_few_ids() {
        let s = subjects("/v1/playlists/7/tracks", &json!({"trackIds":[1,2,3,4,5,6]}));
        assert_eq!(s, Subjects { track_ids: vec![1, 2, 3], playlist_id: Some(7) });
        let s = subjects("/v1/tracks/9/tags", &json!({}));
        assert_eq!(s.track_ids, vec![9]);
    }

    #[test]
    fn test_playback_and_playlist_calls_read_as_sentences() {
        let n = Names::default();
        let d = describe("/v1/playback", "/v1/playback", &json!({"volume":0.4,"seekSecs":80,"play":false}), &n);
        assert_eq!(d.as_deref(), Some("pause, volume 40%, seek to 1:20"));
        let n = Names { tracks: HashMap::new(), playlist: Some("Late night".into()) };
        let d = describe("/v1/playlists/{id}/tracks", "/v1/playlists/3/tracks", &json!({"playlistTrackIds":[1,2]}), &n);
        assert_eq!(d.as_deref(), Some("playlist “Late night”: remove 2 rows"));
        let d = describe("/v1/playlists/{id}", "/v1/playlists/3", &json!({"name":"Winter"}), &n);
        assert_eq!(d.as_deref(), Some("playlist “Late night” → “Winter”"));
    }

    #[test]
    fn test_plugin_tool_arguments_are_summarised_and_secrets_masked() {
        let req = json!({"pluginId":"spotify","tool":"push_playlist","args":{
            "name":"Road trip","trackIds":[1,2,3],"apiToken":"abc123","note":"x".repeat(200),
        }});
        let d = describe("/v1/assistant/invoke", "/v1/assistant/invoke", &req, &Names::default()).unwrap();
        assert!(d.contains("name=“Road trip”"), "{d}");
        assert!(d.contains("trackIds=[3]"), "{d}");
        assert!(d.contains("apiToken=…") && !d.contains("abc123"), "{d}");
        assert!(d.chars().count() <= MAX_DETAIL);
    }

    #[test]
    fn test_unknown_routes_fall_back_to_the_generic_summary_and_empty_bodies_say_nothing() {
        let d = describe("/v1/brand-new", "/v1/brand-new", &json!({"thing":"x","count":2}), &Names::default());
        assert_eq!(d.as_deref(), Some("count=2, thing=“x”"));
        assert_eq!(describe("/v1/brand-new", "/v1/brand-new", &json!({}), &Names::default()), None);
    }

    #[test]
    fn test_results_report_counts_the_request_did_not_know() {
        let r = describe_result("/v1/queue/tracks", &json!({"added":2,"skippedDuplicates":1}));
        assert_eq!(r.as_deref(), Some("added 2, skipped 1 duplicate"));
        let r = describe_result("/v1/tracks/{id}/tags", &json!({"tags":["a","b"]}));
        assert_eq!(r.as_deref(), Some("tags now: a, b"));
        assert_eq!(describe_result("/v1/likes", &json!({"ok":true})), None);
    }

    #[test]
    fn test_long_titles_are_cut() {
        let long = "x".repeat(300);
        let d = describe("/v1/likes", "/v1/likes", &json!({"kind":"track","title":long,"likeState":1}), &Names::default()).unwrap();
        assert!(d.chars().count() < 100, "{d}");
        assert!(d.contains('…'));
    }
}
