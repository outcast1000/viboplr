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

