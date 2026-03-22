use std::path::{Path, PathBuf};

static EXTENSIONS: &[&str] = &["jpg", "jpeg", "png"];

pub fn image_dir(app_dir: &Path, kind: &str) -> PathBuf {
    app_dir.join(format!("{}_images", kind))
}

pub fn get_image_path(app_dir: &Path, kind: &str, id: i64) -> Option<PathBuf> {
    let dir = image_dir(app_dir, kind);
    for ext in EXTENSIONS {
        let path = dir.join(format!("{}.{}", id, ext));
        if path.exists() {
            return Some(path);
        }
    }
    None
}

pub fn remove_image(app_dir: &Path, kind: &str, id: i64) {
    let dir = image_dir(app_dir, kind);
    for ext in EXTENSIONS {
        let _ = std::fs::remove_file(dir.join(format!("{}.{}", id, ext)));
    }
}
