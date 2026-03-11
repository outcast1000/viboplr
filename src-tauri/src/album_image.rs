use std::path::{Path, PathBuf};

static EXTENSIONS: &[&str] = &["jpg", "jpeg", "png"];

pub fn get_image_path(app_dir: &Path, album_id: i64) -> Option<PathBuf> {
    let dir = app_dir.join("album_images");
    for ext in EXTENSIONS {
        let path = dir.join(format!("{}.{}", album_id, ext));
        if path.exists() {
            return Some(path);
        }
    }
    None
}

pub fn remove_image(app_dir: &Path, album_id: i64) {
    let dir = app_dir.join("album_images");
    for ext in EXTENSIONS {
        let path = dir.join(format!("{}.{}", album_id, ext));
        let _ = std::fs::remove_file(path);
    }
}

pub fn fetch_album_image(
    album_title: &str,
    artist_name: Option<&str>,
    dest_path: &Path,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("FastPlayer/0.1.0 (https://github.com/fastplayer)")
        .build()
        .map_err(|e| e.to_string())?;

    // Step 1: Search for release-group on MusicBrainz
    let query = match artist_name {
        Some(artist) => format!(
            "releasegroup:{} AND artist:{}",
            album_title, artist
        ),
        None => format!("releasegroup:{}", album_title),
    };
    let search_url = format!(
        "https://musicbrainz.org/ws/2/release-group/?query={}&limit=1&fmt=json",
        crate::artist_image::urlencoded(&query)
    );
    let search_resp: serde_json::Value = client
        .get(&search_url)
        .send()
        .map_err(|e| format!("MusicBrainz search failed: {}", e))?
        .json()
        .map_err(|e| format!("Failed to parse search response: {}", e))?;

    let release_group = search_resp["release-groups"]
        .as_array()
        .and_then(|a| a.first())
        .ok_or("No release group found on MusicBrainz")?;

    let score = release_group["score"].as_u64().unwrap_or(0);
    if score < 80 {
        return Err(format!("Best match score too low: {}", score));
    }

    let mbid = release_group["id"]
        .as_str()
        .ok_or("No MBID in response")?;

    // Step 2: Rate limit then fetch cover art from Cover Art Archive
    std::thread::sleep(std::time::Duration::from_secs(1));

    let cover_url = format!(
        "https://coverartarchive.org/release-group/{}/front-500",
        mbid
    );
    let resp = client
        .get(&cover_url)
        .send()
        .map_err(|e| format!("Cover Art Archive request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Cover Art Archive returned status {}",
            resp.status()
        ));
    }

    let bytes = resp
        .bytes()
        .map_err(|e| format!("Failed to read image bytes: {}", e))?;

    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(dest_path, &bytes).map_err(|e| format!("Failed to write image: {}", e))?;

    Ok(())
}
