use serde::{Deserialize, Serialize};

pub struct GeniusClient {
    client: reqwest::blocking::Client,
}

// --- API response types (deserialization only) ---

#[derive(Deserialize)]
struct SearchResponse {
    response: SearchResponseInner,
}

#[derive(Deserialize)]
struct SearchResponseInner {
    sections: Vec<SearchSection>,
}

#[derive(Deserialize)]
struct SearchSection {
    hits: Vec<SearchHit>,
}

#[derive(Deserialize)]
struct SearchHit {
    #[serde(rename = "type")]
    hit_type: Option<String>,
    result: Option<SearchHitResult>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct SearchHitResult {
    id: u64,
    title: Option<String>,
    artist_names: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize)]
struct SongResponse {
    response: SongResponseInner,
}

#[derive(Deserialize)]
struct SongResponseInner {
    song: SongData,
}

#[derive(Deserialize)]
struct SongData {
    description_preview: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize)]
struct ReferentsResponse {
    response: ReferentsResponseInner,
}

#[derive(Deserialize)]
struct ReferentsResponseInner {
    referents: Vec<Referent>,
}

#[derive(Deserialize)]
struct Referent {
    fragment: Option<String>,
    annotations: Vec<Annotation>,
}

#[derive(Deserialize)]
struct Annotation {
    body: Option<AnnotationBody>,
}

#[derive(Deserialize)]
struct AnnotationBody {
    plain: Option<String>,
}

// --- Public output types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeniusExplanation {
    pub about: Option<String>,
    pub annotations: Vec<GeniusAnnotation>,
    pub song_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeniusAnnotation {
    pub fragment: String,
    pub explanation: String,
}

impl GeniusClient {
    pub fn new() -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        Self { client }
    }

    /// Search for a song on Genius, returning its ID and URL if found.
    pub fn search(&self, artist: &str, title: &str) -> Result<Option<(u64, String)>, String> {
        let query = format!("{} {}", title, artist);
        let encoded = urlencoding::encode(&query);
        let url = format!("https://genius.com/api/search/multi?q={}", encoded);

        let start = std::time::Instant::now();
        let resp = self.client
            .get(&url)
            .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .send()
            .map_err(|e| format!("Genius search failed: {}", e))?;
        log::info!("HTTP GET genius/search -> {} ({:.0}ms)", resp.status(), start.elapsed().as_secs_f64() * 1000.0);

        let data: SearchResponse = resp.json()
            .map_err(|e| format!("Failed to parse Genius search response: {}", e))?;

        // Find the first song-type hit across all sections
        let artist_lower = artist.to_lowercase();
        for section in &data.response.sections {
            for hit in &section.hits {
                if hit.hit_type.as_deref() != Some("song") {
                    continue;
                }
                if let Some(result) = &hit.result {
                    // Verify artist matches (loose check)
                    if let Some(hit_artist) = &result.artist_names {
                        if !hit_artist.to_lowercase().contains(&artist_lower)
                            && !artist_lower.contains(&hit_artist.to_lowercase())
                        {
                            continue;
                        }
                    }
                    if let Some(song_url) = &result.url {
                        return Ok(Some((result.id, song_url.clone())));
                    }
                }
            }
        }

        Ok(None)
    }

    /// Fetch the song description and annotations for a given song ID.
    pub fn get_explanation(&self, song_id: u64) -> Result<GeniusExplanation, String> {
        // 1. Fetch song description
        let song_url_api = format!("https://genius.com/api/songs/{}", song_id);
        let start = std::time::Instant::now();
        let resp = self.client
            .get(&song_url_api)
            .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .send()
            .map_err(|e| format!("Genius song fetch failed: {}", e))?;
        log::info!("HTTP GET genius/song/{} -> {} ({:.0}ms)", song_id, resp.status(), start.elapsed().as_secs_f64() * 1000.0);

        let song_data: SongResponse = resp.json()
            .map_err(|e| format!("Failed to parse Genius song response: {}", e))?;

        let about = song_data.response.song.description_preview
            .filter(|s| !s.is_empty() && s != "?");
        let song_url = song_data.response.song.url
            .unwrap_or_else(|| format!("https://genius.com/songs/{}", song_id));

        // 2. Fetch annotations (referents) with plain text format
        let refs_url = format!(
            "https://genius.com/api/referents?song_id={}&per_page=50&text_format=plain",
            song_id
        );
        let start = std::time::Instant::now();
        let resp = self.client
            .get(&refs_url)
            .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .send()
            .map_err(|e| format!("Genius referents fetch failed: {}", e))?;
        log::info!("HTTP GET genius/referents?song_id={} -> {} ({:.0}ms)", song_id, resp.status(), start.elapsed().as_secs_f64() * 1000.0);

        let refs_data: ReferentsResponse = resp.json()
            .map_err(|e| format!("Failed to parse Genius referents response: {}", e))?;

        let mut annotations = Vec::new();
        for referent in refs_data.response.referents {
            let fragment = match &referent.fragment {
                Some(f) if !f.is_empty() => f.clone(),
                _ => continue,
            };
            // Skip section header annotations like "[Verse 1]", "[Chorus]"
            if fragment.starts_with('[') && fragment.ends_with(']') {
                continue;
            }
            for ann in &referent.annotations {
                if let Some(body) = &ann.body {
                    if let Some(plain) = &body.plain {
                        if !plain.is_empty() {
                            annotations.push(GeniusAnnotation {
                                fragment: fragment.clone(),
                                explanation: plain.clone(),
                            });
                        }
                    }
                }
            }
        }

        Ok(GeniusExplanation {
            about,
            annotations,
            song_url,
        })
    }
}
