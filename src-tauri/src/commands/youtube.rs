// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

// --- YouTube search command ---

#[tauri::command]
pub fn search_youtube(title: String, artist_name: Option<String>, duration_secs: Option<f64>) -> Result<YouTubeResult, String> {
    let query = match &artist_name {
        Some(artist) => format!("{} {}", title, artist),
        None => title,
    };
    let encoded = urlencoding::encode(&query);
    let url = format!("https://www.youtube.com/results?search_query={}", encoded);

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let start = std::time::Instant::now();
    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .send()
        .map_err(|e| format!("HTTP request failed: {}", e))?;
    log::info!("HTTP GET youtube/search -> {} ({:.0}ms)", resp.status(), start.elapsed().as_secs_f64() * 1000.0);

    let body = resp.text().map_err(|e| format!("Failed to read response: {}", e))?;

    let re = regex::Regex::new(r"var ytInitialData = (\{.*?\});</script>")
        .map_err(|e| e.to_string())?;

    let json_str = re
        .captures(&body)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str())
        .ok_or("Could not find ytInitialData in page")?;

    let data: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("Failed to parse ytInitialData: {}", e))?;

    let candidates = extract_video_candidates(&data, 7);
    if candidates.is_empty() {
        return Err("No video found in search results".into());
    }

    let best = if let Some(target) = duration_secs {
        candidates.iter()
            .find(|c| c.duration_secs.map_or(false, |d| (d - target).abs() <= 3.0))
            .unwrap_or(&candidates[0])
    } else {
        &candidates[0]
    };

    Ok(YouTubeResult {
        url: format!("https://www.youtube.com/watch?v={}", best.video_id),
        video_title: best.title.clone(),
    })
}
