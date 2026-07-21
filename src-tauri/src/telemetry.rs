//! Anonymous usage telemetry via a self-hosted [Aptabase](https://aptabase.com)
//! instance (`tauri-plugin-aptabase`).
//!
//! The Aptabase App Key is injected **at build time** from the
//! `APTABASE_APP_KEY` env var (`option_env!`). When it is absent or malformed
//! the plugin is **not registered at all** — telemetry becomes a complete
//! no-op, and the frontend's `plugin:aptabase|track_event` invoke simply errors
//! and is swallowed. This keeps the repo shippable with no live key baked in and
//! means telemetry stays dark until a real self-hosted instance + key exist.
//!
//! Consent model: the plugin only *sends* what the frontend enqueues via
//! `track_event`. The frontend gates every call behind the user's
//! `telemetryEnabled` setting (default on / opt-out, Settings > General). We do
//! **not** install a Rust-side panic hook precisely because it would fire
//! regardless of that opt-out. Aptabase is anonymous by design (no cookies, no
//! persistent device id; only an ephemeral session id + coarse system props
//! such as OS name/version, app version and locale — never PII).

/// Self-hosted Aptabase ingestion host. Point this at your own instance (or an
/// Aptabase cloud region host if you migrate off self-hosting). Only consulted
/// for `A-SH-…` (self-hosted) keys; ignored for `A-EU-…` / `A-US-…` keys.
const APTABASE_HOST: &str = "https://analytics.viboplr.com";

/// Build-time Aptabase App Key, e.g. `A-SH-1234567890`. Provided via the
/// `APTABASE_APP_KEY` env var at compile time. `None` (unset) → telemetry
/// disabled. The key is a *public* ingestion key, not a secret — it is meant to
/// ship inside the client binary.
const APTABASE_APP_KEY: Option<&str> = option_env!("APTABASE_APP_KEY");

/// Registers the Aptabase plugin on `builder` when a self-hosted App Key is
/// baked in, otherwise returns the builder untouched (telemetry off).
///
/// Registering the plugin does not by itself send anything: the background
/// flusher only ships events the frontend actually enqueues via `track_event`.
pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    match APTABASE_APP_KEY {
        Some(key) if !key.is_empty() => builder.plugin(
            tauri_plugin_aptabase::Builder::new(key)
                .with_options(tauri_plugin_aptabase::InitOptions {
                    host: Some(APTABASE_HOST.to_string()),
                    flush_interval: None,
                })
                .build(),
        ),
        _ => builder,
    }
}
