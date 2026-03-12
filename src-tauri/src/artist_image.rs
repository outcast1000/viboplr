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

