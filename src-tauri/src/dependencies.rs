use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallInstructions {
    pub macos: &'static str,
    pub windows: &'static str,
    pub linux: &'static str,
    pub url: &'static str,
}

#[derive(Debug, Clone)]
pub struct DependencyDef {
    pub name: &'static str,
    pub description: &'static str,
    pub version_args: &'static [&'static str],
    pub parse_version: fn(&str) -> Option<String>,
    pub install: InstallInstructions,
    pub internal_consumers: &'static [&'static str],
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DepStatus {
    Installed { version: String },
    NotFound,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInfo {
    pub name: String,
    pub description: String,
    #[serde(flatten)]
    pub status: DepStatus,
    pub internal_consumers: Vec<String>,
    pub plugin_consumers: Vec<String>,
    pub install: InstallInstructions,
}

fn parse_ffmpeg_version(output: &str) -> Option<String> {
    output.lines().next().and_then(|line| {
        line.strip_prefix("ffmpeg version ")
            .map(|rest| rest.split_whitespace().next().unwrap_or("unknown").to_string())
    })
}

fn parse_ytdlp_version(output: &str) -> Option<String> {
    output.lines().next().map(|l| l.trim().to_string())
}

fn parse_fictional_version(output: &str) -> Option<String> {
    output.lines().next().map(|l| l.trim().to_string())
}

pub static REGISTRY: &[DependencyDef] = &[
    DependencyDef {
        name: "ffmpeg",
        description: "Audio/video transcoding and format conversion",
        version_args: &["-version"],
        parse_version: parse_ffmpeg_version,
        install: InstallInstructions {
            macos: "brew install ffmpeg",
            windows: "winget install Gyan.FFmpeg",
            linux: "sudo apt install ffmpeg",
            url: "https://ffmpeg.org/download.html",
        },
        internal_consumers: &["Video playback", "Video frame preview", "Audio format conversion"],
    },
    DependencyDef {
        name: "yt-dlp",
        description: "YouTube video/audio downloading",
        version_args: &["--version"],
        parse_version: parse_ytdlp_version,
        install: InstallInstructions {
            macos: "brew install yt-dlp",
            windows: "winget install yt-dlp.yt-dlp",
            linux: "sudo apt install yt-dlp",
            url: "https://github.com/yt-dlp/yt-dlp#installation",
        },
        internal_consumers: &[],
    },
    #[cfg(debug_assertions)]
    DependencyDef {
        name: "fictional-tool",
        description: "A fake dependency for testing the dependency UI (debug only)",
        version_args: &["--version"],
        parse_version: parse_fictional_version,
        install: InstallInstructions {
            macos: "brew install fictional-tool",
            windows: "winget install Fictional.Tool",
            linux: "sudo apt install fictional-tool",
            url: "https://example.com/fictional-tool",
        },
        internal_consumers: &["Test feature"],
    },
];

pub struct DepCache {
    entries: Mutex<HashMap<String, DepStatus>>,
}

impl DepCache {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(&self, name: &str) -> Option<DepStatus> {
        self.entries.lock().unwrap().get(name).cloned()
    }

    pub fn set(&self, name: &str, status: DepStatus) {
        self.entries.lock().unwrap().insert(name.to_string(), status);
    }

    pub fn invalidate(&self, name: &str) {
        self.entries.lock().unwrap().remove(name);
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
    }
}

#[cfg(target_os = "macos")]
pub fn augmented_path() -> std::ffi::OsString {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let current = std::env::var_os("PATH").unwrap_or_default();
    let extra_dirs: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
    let mut new_path = Vec::new();
    new_path.extend_from_slice(current.as_encoded_bytes());
    for dir in extra_dirs {
        if !current.to_string_lossy().contains(dir) {
            new_path.push(b':');
            new_path.extend_from_slice(dir.as_bytes());
        }
    }
    OsString::from_vec(new_path)
}

pub fn command_with_path(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(target_os = "macos")]
    cmd.env("PATH", augmented_path());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

pub fn tokio_command_with_path(program: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(target_os = "macos")]
    cmd.env("PATH", augmented_path());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

pub fn check_single(name: &str, cache: &DepCache) -> DepStatus {
    if let Some(cached) = cache.get(name) {
        return cached;
    }

    let def = match REGISTRY.iter().find(|d| d.name == name) {
        Some(d) => d,
        None => {
            let status = DepStatus::Error {
                message: format!("Unknown dependency: {}", name),
            };
            cache.set(name, status.clone());
            return status;
        }
    };

    let mut cmd = command_with_path(def.name);
    cmd.args(def.version_args);

    let status = match cmd.output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let version = (def.parse_version)(&stdout)
                .unwrap_or_else(|| "unknown".to_string());
            DepStatus::Installed { version }
        }
        Ok(_) => DepStatus::NotFound,
        Err(_) => DepStatus::NotFound,
    };

    cache.set(name, status.clone());
    status
}

pub fn is_available(name: &str, cache: &DepCache) -> bool {
    matches!(check_single(name, cache), DepStatus::Installed { .. })
}

pub fn allowed_names() -> Vec<&'static str> {
    REGISTRY.iter().map(|d| d.name).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ffmpeg_version_standard() {
        let output = "ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers\nbuilt with Apple clang\n";
        assert_eq!(parse_ffmpeg_version(output), Some("7.1".to_string()));
    }

    #[test]
    fn test_parse_ffmpeg_version_nightly() {
        let output = "ffmpeg version N-12345-gabcdef0 Copyright (c) 2000-2024\n";
        assert_eq!(parse_ffmpeg_version(output), Some("N-12345-gabcdef0".to_string()));
    }

    #[test]
    fn test_parse_ffmpeg_version_no_prefix() {
        let output = "not ffmpeg output\n";
        assert_eq!(parse_ffmpeg_version(output), None);
    }

    #[test]
    fn test_parse_ffmpeg_version_empty() {
        assert_eq!(parse_ffmpeg_version(""), None);
    }

    #[test]
    fn test_parse_ytdlp_version() {
        let output = "2024.10.22\n";
        assert_eq!(parse_ytdlp_version(output), Some("2024.10.22".to_string()));
    }

    #[test]
    fn test_parse_ytdlp_version_with_whitespace() {
        let output = "  2024.10.22  \n";
        assert_eq!(parse_ytdlp_version(output), Some("2024.10.22".to_string()));
    }

    #[test]
    fn test_cache_get_set() {
        let cache = DepCache::new();
        assert!(cache.get("ffmpeg").is_none());

        cache.set("ffmpeg", DepStatus::Installed { version: "7.1".to_string() });
        let status = cache.get("ffmpeg").unwrap();
        assert!(matches!(status, DepStatus::Installed { version } if version == "7.1"));
    }

    #[test]
    fn test_cache_invalidate() {
        let cache = DepCache::new();
        cache.set("ffmpeg", DepStatus::NotFound);
        assert!(cache.get("ffmpeg").is_some());

        cache.invalidate("ffmpeg");
        assert!(cache.get("ffmpeg").is_none());
    }

    #[test]
    fn test_cache_clear() {
        let cache = DepCache::new();
        cache.set("ffmpeg", DepStatus::NotFound);
        cache.set("yt-dlp", DepStatus::Installed { version: "1.0".to_string() });

        cache.clear();
        assert!(cache.get("ffmpeg").is_none());
        assert!(cache.get("yt-dlp").is_none());
    }

    #[test]
    fn test_check_single_unknown_dep() {
        let cache = DepCache::new();
        let status = check_single("nonexistent-program-xyz", &cache);
        assert!(matches!(status, DepStatus::Error { .. }));
    }

    #[test]
    fn test_check_single_not_found() {
        let cache = DepCache::new();
        // fictional-tool doesn't exist on any system
        let status = check_single("fictional-tool", &cache);
        assert!(matches!(status, DepStatus::NotFound));
        // Verify it was cached
        assert!(cache.get("fictional-tool").is_some());
    }

    #[test]
    fn test_check_single_uses_cache() {
        let cache = DepCache::new();
        cache.set("ffmpeg", DepStatus::Installed { version: "cached-version".to_string() });

        let status = check_single("ffmpeg", &cache);
        // Should return cached value without running the binary
        assert!(matches!(status, DepStatus::Installed { version } if version == "cached-version"));
    }

    #[test]
    fn test_is_available_with_cached_installed() {
        let cache = DepCache::new();
        cache.set("ffmpeg", DepStatus::Installed { version: "7.1".to_string() });
        assert!(is_available("ffmpeg", &cache));
    }

    #[test]
    fn test_is_available_with_cached_not_found() {
        let cache = DepCache::new();
        cache.set("ffmpeg", DepStatus::NotFound);
        assert!(!is_available("ffmpeg", &cache));
    }

    #[test]
    fn test_allowed_names_contains_known_deps() {
        let names = allowed_names();
        assert!(names.contains(&"ffmpeg"));
        assert!(names.contains(&"yt-dlp"));
    }

    #[test]
    fn test_allowed_names_includes_fictional_in_debug() {
        let names = allowed_names();
        assert!(names.contains(&"fictional-tool"));
    }

    #[test]
    fn test_registry_has_install_instructions() {
        for def in REGISTRY.iter() {
            assert!(!def.install.macos.is_empty(), "{} missing macos install", def.name);
            assert!(!def.install.windows.is_empty(), "{} missing windows install", def.name);
            assert!(!def.install.linux.is_empty(), "{} missing linux install", def.name);
            assert!(!def.install.url.is_empty(), "{} missing install url", def.name);
        }
    }
}
