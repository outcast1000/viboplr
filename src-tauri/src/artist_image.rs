use std::path::{Path, PathBuf};

static EXTENSIONS: &[&str] = &["jpg", "jpeg", "png"];

pub fn get_image_path(app_dir: &Path, artist_id: i64) -> Option<PathBuf> {
    let dir = app_dir.join("artist_images");
    for ext in EXTENSIONS {
        let path = dir.join(format!("{}.{}", artist_id, ext));
        if path.exists() {
            return Some(path);
        }
    }
    None
}

pub fn remove_image(app_dir: &Path, artist_id: i64) {
    let dir = app_dir.join("artist_images");
    for ext in EXTENSIONS {
        let path = dir.join(format!("{}.{}", artist_id, ext));
        let _ = std::fs::remove_file(path);
    }
}

pub fn fetch_artist_image(artist_name: &str, dest_path: &Path) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("FastPlayer/0.1.0 (https://github.com/fastplayer)")
        .build()
        .map_err(|e| e.to_string())?;

    // Step 1: Search for artist on MusicBrainz
    let search_url = format!(
        "https://musicbrainz.org/ws/2/artist/?query=artist:{}&limit=1&fmt=json",
        urlencoded(artist_name)
    );
    let search_resp: serde_json::Value = client
        .get(&search_url)
        .send()
        .map_err(|e| format!("MusicBrainz search failed: {}", e))?
        .json()
        .map_err(|e| format!("Failed to parse search response: {}", e))?;

    let artist = search_resp["artists"]
        .as_array()
        .and_then(|a| a.first())
        .ok_or("No artist found on MusicBrainz")?;

    let score = artist["score"].as_u64().unwrap_or(0);
    if score < 80 {
        return Err(format!("Best match score too low: {}", score));
    }

    let mbid = artist["id"]
        .as_str()
        .ok_or("No MBID in response")?;

    // Step 2: Rate limit
    std::thread::sleep(std::time::Duration::from_secs(1));

    // Step 3: Get artist relations
    let artist_url = format!(
        "https://musicbrainz.org/ws/2/artist/{}?inc=url-rels&fmt=json",
        mbid
    );
    let artist_resp: serde_json::Value = client
        .get(&artist_url)
        .send()
        .map_err(|e| format!("MusicBrainz artist lookup failed: {}", e))?
        .json()
        .map_err(|e| format!("Failed to parse artist response: {}", e))?;

    let relations = artist_resp["relations"]
        .as_array()
        .ok_or("No relations found")?;

    let image_url = relations
        .iter()
        .find(|r| r["type"].as_str() == Some("image"))
        .and_then(|r| r["url"]["resource"].as_str())
        .ok_or("No image relation found")?
        .to_string();

    // Step 4: If Wikimedia Commons URL, get direct thumbnail
    let direct_url = if image_url.contains("commons.wikimedia.org") {
        std::thread::sleep(std::time::Duration::from_secs(1));
        resolve_wikimedia_thumbnail(&client, &image_url)?
    } else {
        image_url
    };

    // Step 5: Download image
    std::thread::sleep(std::time::Duration::from_secs(1));
    let bytes = client
        .get(&direct_url)
        .send()
        .map_err(|e| format!("Image download failed: {}", e))?
        .bytes()
        .map_err(|e| format!("Failed to read image bytes: {}", e))?;

    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(dest_path, &bytes).map_err(|e| format!("Failed to write image: {}", e))?;

    Ok(())
}

fn resolve_wikimedia_thumbnail(
    client: &reqwest::blocking::Client,
    commons_url: &str,
) -> Result<String, String> {
    // Extract filename from URL like https://commons.wikimedia.org/wiki/File:Example.jpg
    let filename = commons_url
        .rsplit("File:")
        .next()
        .ok_or("Could not extract filename from Commons URL")?;

    let api_url = format!(
        "https://en.wikipedia.org/w/api.php?action=query&titles=File:{}&prop=imageinfo&iiprop=url&iiurlwidth=500&format=json",
        urlencoded(filename)
    );

    let resp: serde_json::Value = client
        .get(&api_url)
        .send()
        .map_err(|e| format!("Wikimedia API failed: {}", e))?
        .json()
        .map_err(|e| format!("Failed to parse Wikimedia response: {}", e))?;

    let pages = resp["query"]["pages"]
        .as_object()
        .ok_or("No pages in Wikimedia response")?;

    let page = pages.values().next().ok_or("Empty pages")?;
    let thumb_url = page["imageinfo"][0]["thumburl"]
        .as_str()
        .ok_or("No thumbnail URL found")?;

    Ok(thumb_url.to_string())
}

pub fn urlencoded(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                String::from(b as char)
            }
            b' ' => "+".to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}
