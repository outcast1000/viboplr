use std::path::{Path, PathBuf};
use std::io::Read;

pub fn plugins_dir(app_dir: &Path) -> PathBuf {
    let dir = app_dir.join("plugins");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn sanitize_plugin_id(plugin_id: &str) -> Result<(), String> {
    if plugin_id.is_empty()
        || plugin_id.contains("..")
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
    {
        return Err("Invalid plugin ID".to_string());
    }
    Ok(())
}

pub fn delete_plugin(app_dir: &Path, plugin_id: &str) -> Result<(), String> {
    sanitize_plugin_id(plugin_id)?;
    let dir = plugins_dir(app_dir).join(plugin_id);
    if !dir.exists() {
        return Err(format!("Plugin '{}' not found", plugin_id));
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| format!("Failed to delete plugin '{}': {}", plugin_id, e))
}

pub fn install_gallery_plugin(
    app_dir: &Path,
    base_url: &str,
    plugin_id: &str,
    files: &[String],
) -> Result<String, String> {
    sanitize_plugin_id(plugin_id)?;
    if files.is_empty() {
        return Err("No files to install".to_string());
    }

    let plugins = plugins_dir(app_dir);
    let tmp_dir = plugins.join(format!(".tmp-{}", plugin_id));
    let final_dir = plugins.join(plugin_id);

    // Clean up any leftover temp dir
    if tmp_dir.exists() {
        std::fs::remove_dir_all(&tmp_dir).ok();
    }
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // Download each file
    for file in files {
        if file.contains("..") || file.contains('/') || file.contains('\\') {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Err(format!("Invalid file path: {}", file));
        }
        let url = format!("{}{}/{}", base_url, plugin_id, file);
        match crate::skins::fetch_url(&url) {
            Ok(content) => {
                let dest = tmp_dir.join(file);
                if let Err(e) = std::fs::write(&dest, &content) {
                    let _ = std::fs::remove_dir_all(&tmp_dir);
                    return Err(format!("Failed to write {}: {}", file, e));
                }
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err(format!("Failed to download {}: {}", file, e));
            }
        }
    }

    // Atomic swap: remove old, rename temp to final
    if final_dir.exists() {
        std::fs::remove_dir_all(&final_dir)
            .map_err(|e| format!("Failed to remove old plugin: {}", e))?;
    }
    std::fs::rename(&tmp_dir, &final_dir)
        .map_err(|e| format!("Failed to install plugin: {}", e))?;

    Ok(plugin_id.to_string())
}

pub fn install_plugin_from_zip(
    app_dir: &Path,
    plugin_id: &str,
    zip_bytes: &[u8],
) -> Result<(), String> {
    sanitize_plugin_id(plugin_id)?;

    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("Invalid zip: {}", e))?;

    let has_manifest = (0..archive.len()).any(|i| {
        archive.by_index(i).map(|f| f.name() == "manifest.json").unwrap_or(false)
    });
    if !has_manifest {
        return Err("Zip must contain manifest.json".to_string());
    }

    let plugins = plugins_dir(app_dir);
    let tmp_dir = plugins.join(format!(".tmp-{}", plugin_id));
    let final_dir = plugins.join(plugin_id);

    if tmp_dir.exists() {
        std::fs::remove_dir_all(&tmp_dir).ok();
    }
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| format!("Zip read error: {}", e))?;
        let name = file.name().to_string();

        if name.contains("..") || name.starts_with('/') {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Err(format!("Invalid path in zip: {}", name));
        }

        if file.is_dir() {
            std::fs::create_dir_all(tmp_dir.join(&name)).ok();
            continue;
        }

        if let Some(parent) = std::path::Path::new(&name).parent() {
            std::fs::create_dir_all(tmp_dir.join(parent)).ok();
        }

        let dest = tmp_dir.join(&name);
        let mut out = std::fs::File::create(&dest)
            .map_err(|e| format!("Failed to create {}: {}", name, e))?;
        std::io::copy(&mut file, &mut out)
            .map_err(|e| format!("Failed to write {}: {}", name, e))?;
    }

    if final_dir.exists() {
        std::fs::remove_dir_all(&final_dir)
            .map_err(|e| format!("Failed to remove old plugin: {}", e))?;
    }
    std::fs::rename(&tmp_dir, &final_dir)
        .map_err(|e| format!("Failed to install plugin: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_plugins_dir_creates_directory() {
        let tmp = TempDir::new().unwrap();
        let dir = plugins_dir(tmp.path());
        assert!(dir.is_dir());
        assert_eq!(dir, tmp.path().join("plugins"));
    }

    #[test]
    fn test_sanitize_rejects_invalid_ids() {
        assert!(sanitize_plugin_id("").is_err());
        assert!(sanitize_plugin_id("../evil").is_err());
        assert!(sanitize_plugin_id("foo/bar").is_err());
        assert!(sanitize_plugin_id("foo\\bar").is_err());
        assert!(sanitize_plugin_id("valid-id").is_ok());
    }

    #[test]
    fn test_delete_nonexistent_plugin() {
        let tmp = TempDir::new().unwrap();
        plugins_dir(tmp.path()); // ensure plugins/ exists
        let result = delete_plugin(tmp.path(), "nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn test_delete_plugin() {
        let tmp = TempDir::new().unwrap();
        let dir = plugins_dir(tmp.path()).join("test-plugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), "{}").unwrap();
        assert!(dir.exists());
        delete_plugin(tmp.path(), "test-plugin").unwrap();
        assert!(!dir.exists());
    }

    use std::io::Write;

    fn create_test_zip(dir: &Path, plugin_id: &str) -> PathBuf {
        let zip_path = dir.join(format!("{}.zip", plugin_id));
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();

        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(br#"{"id":"test-plugin","name":"Test","version":"1.0.0"}"#).unwrap();

        zip.start_file("index.js", options).unwrap();
        zip.write_all(b"function activate(api) {}").unwrap();

        zip.finish().unwrap();
        zip_path
    }

    #[test]
    fn test_install_plugin_from_zip() {
        let tmp = tempfile::tempdir().unwrap();
        let app_dir = tmp.path();
        let zip_path = create_test_zip(app_dir, "test-plugin");

        let zip_bytes = std::fs::read(&zip_path).unwrap();
        let result = install_plugin_from_zip(app_dir, "test-plugin", &zip_bytes);
        assert!(result.is_ok(), "install failed: {:?}", result);

        let plugin_dir = plugins_dir(app_dir).join("test-plugin");
        assert!(plugin_dir.join("manifest.json").exists());
        assert!(plugin_dir.join("index.js").exists());
    }

    #[test]
    fn test_install_plugin_from_zip_missing_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let app_dir = tmp.path();

        let zip_path = app_dir.join("bad.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("index.js", options).unwrap();
        zip.write_all(b"code").unwrap();
        zip.finish().unwrap();

        let zip_bytes = std::fs::read(&zip_path).unwrap();
        let result = install_plugin_from_zip(app_dir, "bad-plugin", &zip_bytes);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("manifest.json"));
    }

    #[test]
    fn test_install_plugin_from_zip_replaces_existing() {
        let tmp = tempfile::tempdir().unwrap();
        let app_dir = tmp.path();

        let zip_bytes1 = {
            let zip_path = app_dir.join("v1.zip");
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("manifest.json", options).unwrap();
            zip.write_all(br#"{"id":"test","name":"Test","version":"1.0.0"}"#).unwrap();
            zip.start_file("index.js", options).unwrap();
            zip.write_all(b"v1").unwrap();
            zip.finish().unwrap();
            std::fs::read(&zip_path).unwrap()
        };
        install_plugin_from_zip(app_dir, "test", &zip_bytes1).unwrap();

        let zip_bytes2 = {
            let zip_path = app_dir.join("v2.zip");
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("manifest.json", options).unwrap();
            zip.write_all(br#"{"id":"test","name":"Test","version":"2.0.0"}"#).unwrap();
            zip.start_file("index.js", options).unwrap();
            zip.write_all(b"v2").unwrap();
            zip.finish().unwrap();
            std::fs::read(&zip_path).unwrap()
        };
        install_plugin_from_zip(app_dir, "test", &zip_bytes2).unwrap();

        let content = std::fs::read_to_string(plugins_dir(app_dir).join("test/index.js")).unwrap();
        assert_eq!(content, "v2");
    }
}
