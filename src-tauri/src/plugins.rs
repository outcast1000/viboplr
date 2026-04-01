use std::path::{Path, PathBuf};

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
}
