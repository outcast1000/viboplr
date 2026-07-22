// Publishing side of music sources: turn a set of local tracks into a
// self-contained, hostable bundle —
//
//   <dest>/
//     index.html      landing page (Add-to-Viboplr deep link + copy-paste URL)
//     manifest.json   { name, tracks[] with <baseUrl>/tracks/<file> URLs }
//     tracks/<files>  the copied audio
//     PUBLISH.md      how to host it (web server or GitHub)
//
// The user hosts the folder anywhere (their web server, or `git push` to a
// GitHub Pages repo); the manifest URL is then added via the subscribe flow.
// This generator is DB-free (takes pre-resolved tracks) so it unit-tests cleanly.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

/// One track to publish, already resolved to a local file + metadata.
#[derive(Debug)]
pub struct PublishTrack {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_secs: Option<f64>,
    pub track_number: Option<i32>,
    pub format: Option<String>,
    /// Absolute filesystem path to the source audio file.
    pub src_path: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub dest: String,
    pub manifest_url: String,
    pub deep_link: String,
    pub exported: u32,
    /// Titles of tracks that couldn't be copied (e.g. missing file).
    pub skipped: Vec<String>,
}

/// ASCII-safe, lowercase, hyphenated slug for filenames. Non-ASCII-alphanumeric
/// runs collapse to a single dash; empty input falls back to "track".
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(c.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    if out.is_empty() {
        "track".to_string()
    } else {
        out
    }
}

/// Percent-encode for a URL value (used to embed the manifest URL in the deep
/// link, here and in the publish-to-server command).
pub(crate) fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Minimal HTML-escaping for text interpolated into the landing page.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn extension_for(src_path: &str, format: &Option<String>) -> String {
    Path::new(src_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .or_else(|| format.as_ref().map(|f| f.to_lowercase()))
        .unwrap_or_else(|| "mp3".to_string())
}

/// Generate the publishable bundle at `dest_dir`. `base_url` is where the bundle
/// will be hosted (trailing slash optional); track URLs and the deep link are
/// built from it. Returns the resulting URLs + counts.
pub fn export_music_source(
    dest_dir: &str,
    name: &str,
    base_url: &str,
    tracks: &[PublishTrack],
) -> Result<ExportResult, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("A base URL (where the bundle will be hosted) is required".to_string());
    }

    let dest = Path::new(dest_dir);
    let tracks_dir = dest.join("tracks");
    std::fs::create_dir_all(&tracks_dir).map_err(|e| format!("Couldn't create {}: {}", tracks_dir.display(), e))?;

    let mut used_names: HashSet<String> = HashSet::new();
    let mut manifest_tracks: Vec<serde_json::Value> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    for t in tracks {
        let ext = extension_for(&t.src_path, &t.format);
        let stem = match &t.artist {
            Some(a) if !a.is_empty() => format!("{}-{}", slugify(a), slugify(&t.title)),
            _ => slugify(&t.title),
        };
        // Ensure a unique filename within the bundle.
        let mut filename = format!("{}.{}", stem, ext);
        let mut n = 2;
        while used_names.contains(&filename) {
            filename = format!("{}-{}.{}", stem, n, ext);
            n += 1;
        }

        let dst = tracks_dir.join(&filename);
        if let Err(e) = std::fs::copy(&t.src_path, &dst) {
            log::warn!("Skipping '{}' — copy failed: {}", t.title, e);
            skipped.push(t.title.clone());
            continue;
        }
        used_names.insert(filename.clone());

        let mut entry = serde_json::Map::new();
        entry.insert("title".into(), serde_json::Value::String(t.title.clone()));
        // Option C: emit a **relative** ref (resolved by subscribers against the
        // manifest URL). This keeps the manifest portable — re-hosting at a new
        // base needs no rebuild — and no per-track absolute URL is baked in.
        entry.insert("src".into(), serde_json::Value::String(format!("tracks/{}", filename)));
        if let Some(a) = &t.artist {
            entry.insert("artist".into(), serde_json::Value::String(a.clone()));
        }
        if let Some(al) = &t.album {
            entry.insert("album".into(), serde_json::Value::String(al.clone()));
        }
        if let Some(d) = t.duration_secs {
            entry.insert("duration_secs".into(), serde_json::json!(d));
        }
        if let Some(tn) = t.track_number {
            entry.insert("track".into(), serde_json::json!(tn));
        }
        entry.insert("format".into(), serde_json::Value::String(ext));
        if !t.tags.is_empty() {
            entry.insert("tags".into(), serde_json::json!(t.tags));
        }
        manifest_tracks.push(serde_json::Value::Object(entry));
    }

    let manifest = serde_json::json!({
        "name": name,
        "tracks": manifest_tracks,
    });
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(dest.join("manifest.json"), manifest_json)
        .map_err(|e| format!("Couldn't write manifest.json: {}", e))?;

    let manifest_url = format!("{}/manifest.json", base);
    let deep_link = format!("viboplr://add-collection?kind=manifest&url={}", percent_encode(&manifest_url));

    std::fs::write(dest.join("index.html"), render_index_html(name, &manifest_url, &deep_link, tracks))
        .map_err(|e| format!("Couldn't write index.html: {}", e))?;
    std::fs::write(dest.join("PUBLISH.md"), render_publish_md(&manifest_url))
        .map_err(|e| format!("Couldn't write PUBLISH.md: {}", e))?;

    Ok(ExportResult {
        dest: dest.to_string_lossy().to_string(),
        manifest_url,
        deep_link,
        exported: manifest_tracks.len() as u32,
        skipped,
    })
}

fn render_index_html(name: &str, manifest_url: &str, deep_link: &str, tracks: &[PublishTrack]) -> String {
    let rows: String = tracks
        .iter()
        .map(|t| {
            let sub = t.artist.as_deref().unwrap_or("");
            format!("    <li>{}{}</li>\n", html_escape(&t.title), if sub.is_empty() { String::new() } else { format!(" — {}", html_escape(sub)) })
        })
        .collect();
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{name} — Viboplr music source</title>
  <style>
    body {{ font-family: system-ui, sans-serif; max-width: 640px; margin: 64px auto; padding: 0 20px; line-height: 1.5; }}
    a.add {{ display: inline-block; margin: 24px 0; padding: 12px 20px;
      background: linear-gradient(90deg, #ff5fa2, #c032e0); color: #fff;
      text-decoration: none; border-radius: 8px; font-weight: 600; }}
    code {{ background: #f3f3f3; padding: 2px 6px; border-radius: 4px; word-break: break-all; }}
  </style>
</head>
<body>
  <h1>{name}</h1>
  <p>A Viboplr music source.</p>

  <a class="add" href="{deep_link_attr}">▶ Add to Viboplr</a>

  <p><strong>If the button does nothing</strong>, open Viboplr → <em>Collections</em> →
    <em>+ Add Music Source</em> and paste this manifest URL:</p>
  <p><code>{manifest_url}</code></p>

  <h3>Tracks</h3>
  <ul>
{rows}  </ul>

  <p style="color:#999;font-size:13px">Only publish audio you have the right to share.</p>
</body>
</html>
"#,
        name = html_escape(name),
        deep_link_attr = html_escape(deep_link),
        manifest_url = html_escape(manifest_url),
        rows = rows,
    )
}

fn render_publish_md(manifest_url: &str) -> String {
    format!(
        r#"# Publishing this music source

This folder is a self-contained Viboplr music source: `index.html`, `manifest.json`,
and a `tracks/` folder. Host it so the files are reachable at the base URL you chose,
then share the manifest URL or the landing page.

The manifest URL listeners add in Viboplr:

    {manifest_url}

## Option A — any web server

Upload this whole folder so it's served at your base URL. Done.

## Option B — GitHub Pages

    gh repo create <your-repo> --public --source=. --remote=origin --push
    # then enable Pages (Settings → Pages → Branch: main / root), or:
    gh api -X POST repos/<you>/<your-repo>/pages -f 'source[branch]=main' -f 'source[path]=/'

Note: GitHub has a 100 MB/file limit and is not ideal for serving large audio.
Only publish audio you have the right to share.
"#,
        manifest_url = manifest_url,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_src(dir: &Path, name: &str) -> String {
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(b"fake audio bytes").unwrap();
        p.to_string_lossy().to_string()
    }

    #[test]
    fn test_slugify() {
        assert_eq!(slugify("Bloc Party"), "bloc-party");
        assert_eq!(slugify("Positive Tension!"), "positive-tension");
        assert_eq!(slugify("  Hello / World  "), "hello-world");
        assert_eq!(slugify("***"), "track");
    }

    #[test]
    fn test_percent_encode() {
        assert_eq!(
            percent_encode("https://h.com/m.json"),
            "https%3A%2F%2Fh.com%2Fm.json"
        );
    }

    #[test]
    fn test_export_writes_bundle() {
        let tmp = tempfile::tempdir().unwrap();
        let src_dir = tmp.path().join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        let dest = tmp.path().join("out");

        let tracks = vec![
            PublishTrack {
                title: "Positive Tension".into(),
                artist: Some("Bloc Party".into()),
                album: Some("Silent Alarm".into()),
                duration_secs: Some(235.9),
                track_number: Some(1),
                format: Some("m4a".into()),
                src_path: make_src(&src_dir, "a.m4a"),
                tags: vec!["rock".into()],
            },
            PublishTrack {
                title: "Paravasi".into(),
                artist: Some("Nikos Papazoglou".into()),
                album: None,
                duration_secs: None,
                track_number: None,
                format: None,
                src_path: make_src(&src_dir, "b.mp3"),
                tags: vec![],
            },
        ];

        let res = export_music_source(
            dest.to_str().unwrap(),
            "My Mix",
            "https://me.example.com/music/", // trailing slash should be trimmed
            &tracks,
        )
        .unwrap();

        assert_eq!(res.exported, 2);
        assert!(res.skipped.is_empty());
        assert_eq!(res.manifest_url, "https://me.example.com/music/manifest.json");
        assert_eq!(
            res.deep_link,
            "viboplr://add-collection?kind=manifest&url=https%3A%2F%2Fme.example.com%2Fmusic%2Fmanifest.json"
        );

        // Files copied with slugged names.
        assert!(dest.join("tracks/bloc-party-positive-tension.m4a").exists());
        assert!(dest.join("tracks/nikos-papazoglou-paravasi.mp3").exists());
        assert!(dest.join("index.html").exists());
        assert!(dest.join("PUBLISH.md").exists());

        // Manifest is valid, names the source, and refs are relative + portable
        // (Option C — no base URL baked into per-track refs).
        let m: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dest.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(m["name"], "My Mix");
        assert_eq!(m["tracks"].as_array().unwrap().len(), 2);
        assert_eq!(
            m["tracks"][0]["src"],
            "tracks/bloc-party-positive-tension.m4a"
        );
        assert!(m["tracks"][0].get("url").is_none());
        assert_eq!(m["tracks"][0]["artist"], "Bloc Party");
        // Optional fields omitted when absent.
        assert!(m["tracks"][1].get("album").is_none());
    }

    #[test]
    fn test_export_dedupes_filenames_and_skips_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let src_dir = tmp.path().join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        let dest = tmp.path().join("out");

        let tracks = vec![
            PublishTrack {
                title: "Song".into(), artist: Some("A".into()), album: None,
                duration_secs: None, track_number: None, format: Some("mp3".into()),
                src_path: make_src(&src_dir, "1.mp3"), tags: vec![],
            },
            // Same artist+title → filename collision, must be de-duped.
            PublishTrack {
                title: "Song".into(), artist: Some("A".into()), album: None,
                duration_secs: None, track_number: None, format: Some("mp3".into()),
                src_path: make_src(&src_dir, "2.mp3"), tags: vec![],
            },
            // Missing source file → skipped, not fatal.
            PublishTrack {
                title: "Gone".into(), artist: None, album: None,
                duration_secs: None, track_number: None, format: Some("mp3".into()),
                src_path: src_dir.join("does-not-exist.mp3").to_string_lossy().to_string(), tags: vec![],
            },
        ];

        let res = export_music_source(dest.to_str().unwrap(), "Mix", "https://h/x", &tracks).unwrap();
        assert_eq!(res.exported, 2);
        assert_eq!(res.skipped, vec!["Gone".to_string()]);
        assert!(dest.join("tracks/a-song.mp3").exists());
        assert!(dest.join("tracks/a-song-2.mp3").exists());
    }

    #[test]
    fn test_export_requires_base_url() {
        let tmp = tempfile::tempdir().unwrap();
        let err = export_music_source(tmp.path().to_str().unwrap(), "M", "  ", &[]).unwrap_err();
        assert!(err.contains("base URL"));
    }
}
