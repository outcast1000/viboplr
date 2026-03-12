use std::path::Path;

use super::{http_client, urlencoded, write_image, AlbumImageProvider, ArtistImageProvider};

pub struct MusicBrainzArtistProvider;

impl ArtistImageProvider for MusicBrainzArtistProvider {
    fn name(&self) -> &str {
        "MusicBrainz"
    }

    fn fetch_artist_image(&self, artist_name: &str, dest_path: &Path) -> Result<(), String> {
        let client = http_client()?;

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

        let mbid = artist["id"].as_str().ok_or("No MBID in response")?;

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

        write_image(dest_path, &bytes)
    }
}

pub struct MusicBrainzAlbumProvider;

impl AlbumImageProvider for MusicBrainzAlbumProvider {
    fn name(&self) -> &str {
        "MusicBrainz"
    }

    fn fetch_album_image(
        &self,
        album_title: &str,
        artist_name: Option<&str>,
        dest_path: &Path,
    ) -> Result<(), String> {
        let client = http_client()?;

        // Step 1: Search for release-group on MusicBrainz
        let query = match artist_name {
            Some(artist) => format!("releasegroup:{} AND artist:{}", album_title, artist),
            None => format!("releasegroup:{}", album_title),
        };
        let search_url = format!(
            "https://musicbrainz.org/ws/2/release-group/?query={}&limit=1&fmt=json",
            urlencoded(&query)
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

        let mbid = release_group["id"].as_str().ok_or("No MBID in response")?;

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

        write_image(dest_path, &bytes)
    }
}

fn resolve_wikimedia_thumbnail(
    client: &reqwest::blocking::Client,
    commons_url: &str,
) -> Result<String, String> {
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
