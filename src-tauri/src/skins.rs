use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn skins_dir(app_dir: &Path) -> PathBuf {
    let dir = app_dir.join("skins");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn slugify(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

pub fn list_skins_in_dir(dir: &Path) -> Result<Vec<Value>, String> {
    let mut skins = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(mut json) = serde_json::from_str::<Value>(&content) {
                    let id = path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("unknown")
                        .to_string();
                    json.as_object_mut().map(|o| o.insert("id".to_string(), Value::String(id)));
                    skins.push(json);
                }
            }
        }
    }
    Ok(skins)
}

pub fn read_skin_from_dir(dir: &Path, id: &str) -> Result<String, String> {
    let path = dir.join(format!("{}.json", id));
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read skin '{}': {}", id, e))
}

pub fn save_skin_to_dir(dir: &Path, skin_json: &str) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(skin_json)
        .map_err(|e| format!("Invalid JSON: {}", e))?;
    let name = parsed["name"].as_str().ok_or("Missing name field")?;
    let base_slug = slugify(name);

    let mut slug = base_slug.clone();
    let mut counter = 2;
    while dir.join(format!("{}.json", slug)).exists() {
        slug = format!("{}-{}", base_slug, counter);
        counter += 1;
    }

    let path = dir.join(format!("{}.json", slug));
    std::fs::write(&path, skin_json).map_err(|e| format!("Failed to write skin: {}", e))?;
    Ok(slug)
}

pub fn delete_skin_from_dir(dir: &Path, id: &str) -> Result<(), String> {
    let path = dir.join(format!("{}.json", id));
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete skin '{}': {}", id, e))
}

pub fn import_skin_from_path(dir: &Path, source_path: &str) -> Result<String, String> {
    let content = std::fs::read_to_string(source_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    save_skin_to_dir(dir, &content)
}

pub fn fetch_url(url: &str) -> Result<String, String> {
    let resp = reqwest::blocking::get(url)
        .map_err(|e| format!("HTTP error: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.text().map_err(|e| format!("Read error: {}", e))
}

pub fn update_skin_in_dir(dir: &Path, id: &str, skin_json: &str) -> Result<String, String> {
    let _: serde_json::Value = serde_json::from_str(skin_json)
        .map_err(|e| format!("Invalid JSON: {}", e))?;
    let path = dir.join(format!("{}.json", id));
    if !path.exists() {
        return Err(format!("Skin '{}' not found", id));
    }
    std::fs::write(&path, skin_json)
        .map_err(|e| format!("Failed to write skin: {}", e))?;
    Ok(id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_skin_json() -> String {
        r##"{"name":"Test","author":"dev","version":"1.0.0","type":"dark","colors":{"bg-primary":"#111"}}"##.to_string()
    }

    #[test]
    fn test_list_empty_dir() {
        let dir = TempDir::new().unwrap();
        let result = list_skins_in_dir(dir.path());
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn test_save_and_read_skin() {
        let dir = TempDir::new().unwrap();
        let id = save_skin_to_dir(dir.path(), &test_skin_json()).unwrap();
        assert_eq!(id, "test");
        let content = read_skin_from_dir(dir.path(), &id).unwrap();
        assert!(content.contains("\"name\":\"Test\""));
    }

    #[test]
    fn test_delete_skin() {
        let dir = TempDir::new().unwrap();
        let id = save_skin_to_dir(dir.path(), &test_skin_json()).unwrap();
        delete_skin_from_dir(dir.path(), &id).unwrap();
        assert!(read_skin_from_dir(dir.path(), &id).is_err());
    }

    #[test]
    fn test_slug_collision() {
        let dir = TempDir::new().unwrap();
        save_skin_to_dir(dir.path(), &test_skin_json()).unwrap();
        let id2 = save_skin_to_dir(dir.path(), &test_skin_json()).unwrap();
        assert_eq!(id2, "test-2");
    }

    #[test]
    fn test_update_skin_in_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        let skin_v1 = "{\"name\":\"Test Skin\",\"author\":\"Test\",\"version\":\"1.0.0\",\"type\":\"dark\",\"colors\":{\"bg-primary\":\"#000\"}}";
        let slug = save_skin_to_dir(dir, skin_v1).unwrap();

        let skin_v2 = "{\"name\":\"Test Skin\",\"author\":\"Test\",\"version\":\"2.0.0\",\"type\":\"dark\",\"colors\":{\"bg-primary\":\"#111\"}}";
        let new_slug = update_skin_in_dir(dir, &slug, skin_v2).unwrap();

        assert_eq!(new_slug, slug);
        let content = std::fs::read_to_string(dir.join(format!("{}.json", new_slug))).unwrap();
        assert!(content.contains("2.0.0"));
    }

    #[test]
    fn test_update_skin_invalid_json() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        let skin = "{\"name\":\"Test\",\"author\":\"A\",\"version\":\"1.0.0\",\"type\":\"dark\",\"colors\":{}}";
        let slug = save_skin_to_dir(dir, skin).unwrap();

        let result = update_skin_in_dir(dir, &slug, "not json");
        assert!(result.is_err());
        assert!(dir.join(format!("{}.json", slug)).exists());
    }
}
