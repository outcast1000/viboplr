pub mod lrclib;

pub struct LyricResult {
    pub text: String,
    pub kind: LyricKind,
    pub provider_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LyricKind {
    Synced,
    Plain,
}

impl LyricKind {
    pub fn as_str(&self) -> &str {
        match self {
            LyricKind::Synced => "synced",
            LyricKind::Plain => "plain",
        }
    }
}

pub trait LyricProvider: Send + Sync {
    fn name(&self) -> &str;
    fn fetch_lyrics(
        &self,
        artist: &str,
        title: &str,
        duration_secs: Option<f64>,
    ) -> Result<LyricResult, String>;
}

pub struct LyricFallbackChain {
    providers: Vec<Box<dyn LyricProvider>>,
}

impl LyricFallbackChain {
    pub fn new(providers: Vec<Box<dyn LyricProvider>>) -> Self {
        Self { providers }
    }
}

impl LyricProvider for LyricFallbackChain {
    fn name(&self) -> &str {
        "FallbackChain"
    }

    fn fetch_lyrics(
        &self,
        artist: &str,
        title: &str,
        duration_secs: Option<f64>,
    ) -> Result<LyricResult, String> {
        let mut last_err = String::from("No lyric providers configured");
        for provider in &self.providers {
            match provider.fetch_lyrics(artist, title, duration_secs) {
                Ok(result) => return Ok(result),
                Err(e) => {
                    log::warn!(
                        "Lyric provider '{}' failed for '{}' - '{}': {}",
                        provider.name(),
                        artist,
                        title,
                        e
                    );
                    last_err = e;
                }
            }
        }
        Err(last_err)
    }
}
