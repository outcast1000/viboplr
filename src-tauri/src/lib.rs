mod browse_window;
mod commands;
mod composite_image;
mod control_api;
mod db;
pub mod dependencies;
mod entity_image;
mod error_chain;
mod image_provider;
mod logging;
mod models;
mod profile_shortcuts;
mod profiles;
mod scanner;
#[cfg(debug_assertions)]
mod seed;
mod plugins;
mod skins;
mod subsonic;
mod sync;
mod manifest_sync;
mod bundle_ref;
mod music_publish;
mod publish_server;
mod tag_writer;
mod mixtape;
mod main_playlist;
mod mpv_engine;
mod timing;
mod telemetry;
mod downloader;
mod update_checker;
mod video_frames;
mod storyboard;
mod stream_relay;
mod transcode_server;
#[cfg(target_os = "macos")]
mod cursor_tracker;
#[cfg(target_os = "windows")]
mod cursor_tracker_win;
#[cfg(target_os = "windows")]
mod taskbar_win;

// Tauri's build script links this manifest resource into app binaries. The
// lib-test harness needs it too: rfd imports TaskDialogIndirect, which exists
// only when the Common Controls v6 activation context is available.
#[cfg(all(test, windows))]
#[link(name = "resource", kind = "static")]
unsafe extern "C" {}

use commands::{AppState, DownloadQueue, ImageDownloadRequest, ImageResolveRegistry, ImageResolveResult};
use db::Database;
use image_provider::AlbumImageProvider;
use std::sync::{Arc, Condvar, Mutex};
use tauri::{Emitter, Manager};

// Single source of truth for the IPC command registry. The common command list
// lives here once; build-profile-specific commands (e.g. the debug-only
// `clear_database`) are passed in as extra trailing paths so the two
// `get_invoke_handler` variants below can't drift apart.
macro_rules! invoke_handler {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![
            commands::get_profile_info,
            commands::list_profiles,
            commands::create_profile,
            commands::switch_profile,
            commands::get_pending_profile_switch,
            commands::create_profile_shortcut,
            commands::add_collection,
            commands::remove_collection,
            commands::update_collection,
            commands::get_collections,
            commands::get_collection_stats,
            commands::find_track_in_collection,
            commands::resync_collection,
            commands::export_music_source,
            commands::add_publish_server,
            commands::list_publish_servers,
            commands::remove_publish_server,
            commands::publish_to_server,
            commands::cancel_publish_to_server,
            commands::get_artists,
            commands::get_artist_by_id,
            commands::get_albums,
            commands::get_album_by_id,
            commands::get_tracks,
            commands::search_all,
            commands::search_entity,
            commands::search_information_values,
            commands::get_track_count,
            commands::get_track_by_id,
            commands::find_track_by_metadata,
            commands::find_tracks_by_metadata,
            commands::find_track_id_by_path,
            commands::find_duplicate_tracks,
            commands::find_artist_by_name,
            commands::find_album_by_name,
            commands::set_album_year,
            commands::get_tracks_by_ids,
            commands::get_tracks_by_paths,
            commands::resolve_dropped_paths,
            commands::get_tracks_by_artist,
            commands::get_track_path,
            commands::file_exists,
            commands::resolve_subsonic_location,
            commands::toggle_liked,
            commands::set_entity_like_state,
            commands::get_liked_tracks,
            commands::pick_liked_entities,
            commands::pick_never_played_tracks,
            commands::pick_forgotten_favorites,
            commands::get_track_like_states,
            commands::export_likes,
            commands::import_likes,
            commands::rebuild_search_index,
            commands::show_in_folder,
            commands::show_in_folder_path,
            commands::open_path_with_default_app,
            commands::open_folder,
            commands::delete_tracks,
            commands::bulk_update_tracks,
            commands::get_tags,
            commands::get_tag_by_id,
            commands::find_tag_by_name,
            commands::get_tags_for_track,
            commands::get_tag_counts_for_tracks,
            commands::apply_tag_to_tracks,
            commands::remove_tag_from_tracks,
            commands::get_tracks_by_tag,
            commands::get_top_artists_for_tag,
            commands::delete_tag,
            commands::get_entity_image,
            commands::set_entity_image,
            commands::paste_entity_image,
            commands::paste_entity_image_from_clipboard,
            commands::read_clipboard_text,
            commands::remove_entity_image,
            commands::fetch_artist_image,
            commands::fetch_album_image,
            commands::fetch_tag_image,
            commands::clear_image_failures,
            commands::save_entity_image_from_provider,
            commands::extract_embedded_album_image,
            commands::extract_folder_entity_image,
            commands::get_folder_image_patterns,
            commands::set_folder_image_patterns,
            commands::record_play,
            commands::get_history_recent,
            commands::get_history_play_count,
            commands::get_history_plays_page,
            commands::get_history_most_played,
            commands::get_history_most_played_since,
            commands::get_history_most_played_artists,
            commands::get_history_most_played_artists_since,
            commands::search_history_artists,
            commands::search_history_tracks,
            commands::reconnect_history_track,
            commands::reconnect_history_artist,
            commands::get_track_rank,
            commands::get_artist_rank,
            commands::get_track_play_history,
            commands::get_track_play_stats,
            commands::get_auto_continue_track,
            commands::build_radio_for_track,
            commands::pick_radio_seeds,
            commands::save_playlist_entries,
            commands::load_playlist,
            commands::save_playlist_record,
            commands::get_playlists,
            commands::get_playlist_tracks,
            commands::search_playlist_track_ids,
            commands::ensure_auto_playlists,
            commands::delete_playlist_record,
            commands::append_playlist_tracks,
            commands::remove_playlist_tracks,
            commands::reorder_playlist_tracks,
            commands::update_playlist_meta,
            commands::set_playlist_cover,
            commands::export_playlist_m3u,
            commands::update_playlist_image,
            commands::update_playlist_track_metadata,
            commands::paste_clipboard_to_playlist_images,
            commands::copy_to_playlist_images,
            commands::download_url_to_playlist_images,
            commands::generate_playlist_composite,
            commands::get_startup_timings,
            commands::write_probe_dump,
            commands::record_frontend_startup_timings,
            commands::test_collection_connection,
            commands::subsonic_test_connection,
            commands::check_dependencies,
            commands::dependency_install,
            commands::dependency_uninstall_managed,
            commands::dependency_check_updates,
            commands::plugin_exec,
            commands::plugin_exec_cancel,
            commands::yt_dlp_check,
            commands::ffmpeg_check,
            commands::yt_dlp_stream_audio,
            commands::ffmpeg_convert_audio,
            commands::get_video_frames,
            commands::extract_video_frames,
            commands::get_storyboard,
            commands::extract_storyboard,
            commands::cancel_storyboard,
            commands::get_track_audio_properties,
            commands::get_audio_properties_by_path,
            commands::read_file_tags,
            commands::get_file_size,
            commands::get_replaygain_by_path,
            commands::get_track_extra_tags,
            commands::replace_track_tags,
            commands::resolve_subsonic_download_url,
            commands::download_preview,
            commands::confirm_track_upgrade,
            commands::cancel_track_upgrade,
            commands::save_track_as_copy,
            commands::check_dest_conflict,
            commands::check_path_conflict,
            commands::cancel_direct_download,
            commands::download_to_path,
            commands::add_downloaded_track,
            commands::get_cached_waveform,
            commands::cache_waveform,
            commands::list_user_skins,
            commands::read_user_skin,
            commands::save_user_skin,
            commands::delete_user_skin,
            commands::import_skin_file,
            commands::open_skin_in_editor,
            commands::fetch_skin_gallery,
            commands::install_gallery_skin,
            commands::open_devtools,
            commands::open_devtools_for_window,
            commands::plugin_get_dir,
            commands::plugin_list_installed,
            commands::plugin_read_file,
            commands::plugin_storage_get,
            commands::plugin_storage_set,
            commands::plugin_storage_delete,
            commands::plugin_scheduler_register,
            commands::plugin_scheduler_unregister,
            commands::plugin_scheduler_complete,

            commands::plugin_getenv,
            commands::plugin_record_history_plays_batch,
            commands::plugin_set_track_likes_batch,
            commands::plugin_apply_tags,
            commands::plugin_apply_tags_bulk,
            commands::info_sync_types,
            commands::info_get_types_for_entity,
            commands::info_get_value,
            commands::info_get_values_for_entity,
            commands::info_upsert_value,
            commands::info_delete_value,
            commands::sync_image_providers,
            commands::get_image_providers,
            commands::get_all_provider_config,
            commands::update_image_provider_priority,
            commands::update_image_provider_active,
            commands::update_info_type_priority,
            commands::update_info_type_active,
            commands::reset_provider_priorities,
            commands::image_resolve_response,
            commands::plugin_fetch,
            commands::plugin_cache_image,
            commands::plugin_cache_get_path,
            commands::plugin_cache_delete_dir,
            commands::plugin_cache_list_dirs,
            commands::plugin_files_write_text,
            commands::plugin_files_read_text,
            commands::plugin_files_download,
            commands::plugin_files_get_path,
            commands::plugin_files_exists,
            commands::plugin_files_list,
            commands::plugin_files_remove,
            commands::plugin_files_copy,
            commands::plugin_files_move,
            commands::fetch_plugin_gallery,
            commands::install_gallery_plugin_by_update_url,
            commands::cancel_plugin_install,
            commands::delete_user_plugin,
            commands::open_profile_folder,
            commands::open_logs_folder,
            commands::get_app_paths,
            commands::write_frontend_log,
            commands::collect_diagnostics,
            commands::preview_mixtape,
            commands::export_mixtape_playlist_only,
            commands::export_mixtape_full,
            commands::import_mixtape,
            commands::cancel_mixtape_operation,
            commands::cleanup_temp_mixtapes,
            commands::main_playlist_write,
            commands::main_playlist_read,
            commands::main_playlist_clear,
            commands::main_playlist_gc,
            commands::main_playlist_set_cover,
            commands::main_playlist_set_thumb,
            commands::main_playlist_set_thumb_from_video,
            commands::main_playlist_remove_thumb,
            commands::main_playlist_dir,
            commands::check_for_extension_updates,
            commands::download_and_install_plugin_update,
            commands::download_and_install_skin_update,
            commands::install_plugin_from_url,
            commands::set_cursor_tracker,
            commands::set_window_behavior,
            browse_window::open_browse_window,
            browse_window::browse_window_eval,
            browse_window::close_browse_window,
            browse_window::browse_window_set_visible,
            browse_window::browse_window_send,
            commands::start_transcode,
            commands::stop_transcode,
            commands::register_stream_relay,
            commands::engine_capabilities,
            commands::engine_component_status,
            commands::engine_component_install,
            commands::engine_component_uninstall,
            commands::engine_play,
            commands::engine_preload,
            commands::engine_clear_preload,
            commands::engine_set_paused,
            commands::engine_stop,
            commands::engine_seek,
            commands::engine_set_volume,
            commands::engine_set_eq,
            commands::engine_set_speed,
            commands::engine_set_replaygain,
            commands::engine_start_crossfade,
            commands::engine_set_video_bounds,
            commands::engine_set_audio_exclusive,
            commands::engine_set_video_background,
            commands::engine_get_audio_info,
            commands::app_update_check,
            commands::app_update_install,
            commands::control_api_start,
            commands::control_api_stop,
            commands::control_api_status,
            commands::control_api_regenerate_token,
            commands::control_api_respond,
            commands::control_api_client_ready,
            $($extra,)*
        ]
    };
}

#[cfg(debug_assertions)]
fn get_invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    invoke_handler![commands::clear_database]
}

#[cfg(not(debug_assertions))]
fn get_invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    invoke_handler![]
}

pub(crate) fn download_image_from_url(
    url: &str,
    headers: Option<&std::collections::HashMap<String, String>>,
    dest: &std::path::Path,
) -> Result<(), String> {
    let client = image_provider::http_client()?;
    let mut req = client.get(url);
    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    let start = std::time::Instant::now();
    let resp = req.send().map_err(|e| e.to_string())?;
    let status = resp.status();
    log::info!("HTTP GET {} -> {} ({:.0}ms)", url, status, start.elapsed().as_secs_f64() * 1000.0);
    if !status.is_success() {
        return Err(format!("HTTP {} from {}", status, url));
    }
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    image_provider::write_image(dest, &bytes)
}

pub(crate) fn base64_decode_and_save(data: &str, dest: &std::path::Path) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    image_provider::write_image(dest, &bytes)
}


/// What the image worker is resolving, and how to talk about it: which entity
/// the `image_providers` rows belong to, how to name it in a log line, and the
/// JSON shapes the frontend listens for.
///
/// These per-entity differences used to be six closures threaded through the
/// resolver as arguments. As one type they sit together, and the resolver below
/// can be a plain loop over providers instead of a function with a
/// `#[allow(clippy::too_many_arguments)]` on it.
enum ImageTarget {
    Artist { name: String },
    Album { title: String, artist_name: Option<String> },
    Tag { name: String },
}

impl ImageTarget {
    fn entity(&self) -> &'static str {
        match self {
            ImageTarget::Artist { .. } => "artist",
            ImageTarget::Album { .. } => "album",
            ImageTarget::Tag { .. } => "tag",
        }
    }

    /// The name to print in logs — not necessarily unique, unlike the slug.
    fn label(&self) -> &str {
        match self {
            ImageTarget::Artist { name } | ImageTarget::Tag { name } => name,
            ImageTarget::Album { title, .. } => title,
        }
    }

    fn slug(&self) -> String {
        match self {
            ImageTarget::Album { title, artist_name } => {
                entity_image::entity_image_slug("album", title, artist_name.as_deref())
            }
            _ => entity_image::entity_image_slug(self.entity(), self.label(), None),
        }
    }

    fn ready_event(&self) -> &'static str {
        match self {
            ImageTarget::Artist { .. } => "artist-image-ready",
            ImageTarget::Album { .. } => "album-image-ready",
            ImageTarget::Tag { .. } => "tag-image-ready",
        }
    }

    fn error_event(&self) -> &'static str {
        match self {
            ImageTarget::Artist { .. } => "artist-image-error",
            ImageTarget::Album { .. } => "album-image-error",
            ImageTarget::Tag { .. } => "tag-image-error",
        }
    }

    /// Payload for `image-resolve-request`. Carries `plugin_id` because the
    /// bridge answers for **one** provider now — see `resolve_entity_image`.
    fn request_payload(&self, request_id: &str, plugin_id: &str) -> serde_json::Value {
        match self {
            ImageTarget::Album { title, artist_name } => serde_json::json!({
                "request_id": request_id, "plugin_id": plugin_id, "entity": "album",
                "title": title, "artist_name": artist_name,
            }),
            _ => serde_json::json!({
                "request_id": request_id, "plugin_id": plugin_id, "entity": self.entity(),
                "name": self.label(),
            }),
        }
    }

    fn ready_payload(&self, path: &str, source: &str) -> serde_json::Value {
        match self {
            ImageTarget::Album { title, artist_name } => serde_json::json!({
                "path": path, "title": title, "artist_name": artist_name, "source": source,
            }),
            _ => serde_json::json!({ "path": path, "name": self.label(), "source": source }),
        }
    }

    fn error_payload(&self, error: &str) -> serde_json::Value {
        match self {
            ImageTarget::Album { title, artist_name } => serde_json::json!({
                "title": title, "artist_name": artist_name, "error": error,
            }),
            _ => serde_json::json!({ "name": self.label(), "error": error }),
        }
    }
}

/// The collaborators one pass of the image worker needs. Bundled so the
/// resolver and its per-provider helpers take one reference instead of five.
struct ImageChain<'a> {
    app_handle: &'a tauri::AppHandle,
    db: &'a Database,
    registry: &'a ImageResolveRegistry,
    folder: &'a image_provider::folder::FolderImageProvider,
    embedded: &'a image_provider::embedded::EmbeddedArtworkProvider,
}

/// Per-provider ceiling for a bridge round-trip.
const PROVIDER_TIMEOUT_SECS: u64 = 20;
/// Ceiling for a whole chain's worth of *bridge* round-trips. The image worker
/// is a single thread, so a chain of wedged providers doesn't just delay its own
/// entity — it holds every thumbnail queued behind it. Local providers are
/// exempt: they can't hang on a network and skipping them would mean a slow
/// plugin ahead of `core:folder` could suppress art already on disk.
const CHAIN_BUDGET_SECS: u64 = 45;
/// How long the image worker waits after a resolve that reached a **remote**
/// provider, so a library-wide fill-in doesn't hammer somebody's API. Paid only
/// when `resolve_entity_image` reports it used the bridge — see the worker.
const REMOTE_IMAGE_THROTTLE: std::time::Duration = std::time::Duration::from_millis(1100);

/// Walk the user's configured provider chain for one entity and store the first
/// image that lands.
///
/// **The order comes entirely from `image_providers`** — the list the user drags
/// in Settings → Providers — and the built-in `core:*` providers are rows in that
/// same table, so this loop is the only thing deciding what wins.
///
/// It used to be split in two, and that split is what this replaces: embedded
/// artwork ran unconditionally here in Rust *before* the bridge was ever asked,
/// while the plugin order was walked in JS (`useImageResolver`). Embedded was
/// therefore unorderable by construction — the Settings row rendered it as a
/// locked "always first" pill because that was the literal truth — and there was
/// nowhere for a second local provider to sit at all.
///
/// Returns whether the walk ever reached the **plugin bridge** — i.e. whether it
/// may have talked to a remote API. The worker's inter-request throttle keys off
/// this: a chain satisfied by `core:folder` or `core:embedded` touched only the
/// local disk and has nobody to be polite to. See the call site.
fn resolve_entity_image(
    chain: &ImageChain,
    target: &ImageTarget,
    slug: &str,
    dest: &std::path::Path,
) -> bool {
    let entity = target.entity();
    let providers = chain.db.get_image_providers(entity).unwrap_or_default();
    if providers.is_empty() {
        log::info!("No active image providers for {} {}", entity, target.label());
        let _ = chain.db.record_image_failure(entity, slug);
        let _ = chain.app_handle.emit(
            target.error_event(),
            target.error_payload("No image providers enabled"),
        );
        return false;
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(CHAIN_BUDGET_SECS);
    let mut last_error = String::from("No provider had an image");
    let mut used_bridge = false;

    for (plugin_id, _priority, _id) in &providers {
        let outcome = if plugin_id == image_provider::CORE_FOLDER {
            resolve_from_folder(chain, target, dest)
        } else if plugin_id == image_provider::CORE_EMBEDDED {
            resolve_from_embedded(chain, target, dest)
        } else if image_provider::is_core_provider(plugin_id) {
            // A `core:*` row this build doesn't know — a row left behind by a
            // downgrade, say. It must fail its turn, not be handed to the
            // plugin bridge, which would go looking for a plugin by that id.
            Err(format!("Unknown built-in image provider: {}", plugin_id))
        } else if std::time::Instant::now() >= deadline {
            Err("chain time budget exhausted".to_string())
        } else {
            used_bridge = true;
            request_plugin_image(chain, target, plugin_id, slug)
                .and_then(|result| store_plugin_image(result, dest))
        };

        match outcome {
            Ok(path) => {
                let path = path.to_string_lossy().to_string();
                log::info!("{} image for {} from {}", entity, target.label(), plugin_id);
                let _ = chain
                    .app_handle
                    .emit(target.ready_event(), target.ready_payload(&path, plugin_id));
                return used_bridge;
            }
            Err(e) => {
                log::info!(
                    "{} provider {} did not resolve {}: {}",
                    entity, plugin_id, target.label(), e
                );
                last_error = e;
            }
        }
    }

    log::warn!(
        "All providers failed for {} {}: {}",
        entity, target.label(), last_error
    );
    let _ = chain.db.record_image_failure(entity, slug);
    let _ = chain
        .app_handle
        .emit(target.error_event(), target.error_payload(&last_error));
    used_bridge
}

/// `core:folder` — the sidecar image in the media folder.
fn resolve_from_folder(
    chain: &ImageChain,
    target: &ImageTarget,
    dest: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let found = match target {
        ImageTarget::Album { title, artist_name } => {
            chain.folder.find_album_image(title, artist_name.as_deref())?
        }
        ImageTarget::Artist { name } => chain.folder.find_artist_image(name)?,
        ImageTarget::Tag { .. } => return Err("Folder art does not apply to tags".into()),
    };
    image_provider::folder::store_discovered(&found, dest)
}

/// `core:embedded` — artwork in the audio file's own tags.
fn resolve_from_embedded(
    chain: &ImageChain,
    target: &ImageTarget,
    dest: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let ImageTarget::Album { title, artist_name } = target else {
        return Err("Embedded artwork only applies to albums".into());
    };
    AlbumImageProvider::fetch_album_image(
        chain.embedded,
        title,
        artist_name.as_deref(),
        dest,
    )?;
    // The provider swaps in the extension the picture's mime type calls for, so
    // the file it wrote is not necessarily the `dest` it was handed.
    written_image_path(dest).ok_or_else(|| "Embedded artwork vanished after write".to_string())
}

/// Which file a provider actually wrote, given the `.jpg` base path it was
/// handed. Safe against picking up a stale sibling because the worker only
/// resolves when no stored image exists (and a forced re-fetch deletes every
/// extension first — see `queue_image_fetch`).
fn written_image_path(dest: &std::path::Path) -> Option<std::path::PathBuf> {
    if dest.exists() {
        return Some(dest.to_path_buf());
    }
    for ext in ["png", "webp", "gif", "jpeg", "jpg"] {
        let candidate = dest.with_extension(ext);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Ask the JS plugin bridge for **one** provider's image: register a one-shot
/// channel, emit `image-resolve-request` naming the plugin, wait for the
/// matching `image_resolve_response`.
fn request_plugin_image(
    chain: &ImageChain,
    target: &ImageTarget,
    plugin_id: &str,
    slug: &str,
) -> Result<ImageResolveResult, String> {
    let request_id = format!(
        "{}-{}-{}-{}",
        target.entity(),
        slug,
        plugin_id,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let (tx, rx) = std::sync::mpsc::channel();
    chain
        .registry
        .pending
        .lock()
        .unwrap()
        .insert(request_id.clone(), tx);

    log::info!(
        "Requesting {} image resolve from {}: {}",
        target.entity(), plugin_id, target.label()
    );
    let _ = chain.app_handle.emit(
        "image-resolve-request",
        target.request_payload(&request_id, plugin_id),
    );

    let outcome = rx
        .recv_timeout(std::time::Duration::from_secs(PROVIDER_TIMEOUT_SECS))
        .map_err(|_| "Resolve timeout".to_string());
    chain.registry.pending.lock().unwrap().remove(&request_id);
    outcome
}

/// Persist whatever a plugin handed back (base64 bytes or a URL to fetch).
fn store_plugin_image(
    result: ImageResolveResult,
    dest: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    if let Some(error) = result.error {
        return Err(error);
    }
    if let Some(data) = result.data {
        base64_decode_and_save(&data, dest)?;
    } else if let Some(url) = result.url {
        download_image_from_url(&url, result.headers.as_ref(), dest)?;
    } else {
        return Err("Empty resolve result".into());
    }
    Ok(dest.to_path_buf())
}

/// One-time migration: web search moved from a core feature into the
/// `search-providers` plugin. Copy any customized legacy `searchProviders` list
/// from app-state.json into the plugin's storage so the user's custom providers
/// and enabled flags carry over. Read-only on the legacy side; guarded by a
/// marker row so it runs once and never resurrects a list the user later
/// cleared in-plugin.
fn seed_search_providers_from_legacy(db: &Database, app_dir: &std::path::Path) {
    let already = db
        .plugin_storage_get("__core__", "search_providers_migrated")
        .ok()
        .flatten()
        .is_some();
    if already {
        return;
    }
    let existing = db
        .plugin_storage_get("search-providers", "providers")
        .ok()
        .flatten();
    if existing.is_none() {
        let store_path = app_dir.join("app-state.json");
        if let Ok(data) = std::fs::read_to_string(&store_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&data) {
                if let Some(v) = json.get("searchProviders") {
                    if !v.is_null() {
                        if let Ok(s) = serde_json::to_string(v) {
                            let _ = db.plugin_storage_set("search-providers", "providers", &s);
                        }
                    }
                }
            }
        }
    }
    let _ = db.plugin_storage_set("__core__", "search_providers_migrated", "1");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let timer = timing::init_timer();

    // Parse optional profile name from env var or CLI argument
    // Usage: VIBOPLR_PROFILE=name or --profile name or --profile=name
    // Default profile is "default" when no profile is specified
    let profile_name: String = timer.time("parse_profile", || {
        let mut profile: Option<String> =
            std::env::var("VIBOPLR_PROFILE").ok();

        if profile.is_none() {
            let args: Vec<String> = std::env::args().collect();
            // profile_from_argv treats a dangling `--profile` as absent; at
            // startup that's a usage error the user should hear about.
            if args.last().is_some_and(|a| a == "--profile") {
                eprintln!("Error: --profile requires a name argument");
                std::process::exit(1);
            }
            profile = profiles::profile_from_argv(&args);
        }

        let name = profile.unwrap_or_else(|| {
            #[cfg(debug_assertions)]
            {
                let manifest_dir = env!("CARGO_MANIFEST_DIR");
                let worktree_name = std::path::Path::new(manifest_dir)
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .unwrap_or("dev");
                format!("dev-{}", worktree_name)
            }
            #[cfg(not(debug_assertions))]
            { "default".to_string() }
        });

        if let Err(e) = profiles::validate_profile_name(&name) {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }

        name
    });

    // Compute app_data_dir before Tauri starts, to read store settings for logging
    let pre_app_data_dir = timer.time("resolve_pre_app_data_dir", || {
        #[cfg(target_os = "macos")]
        {
            let home = std::env::var("HOME").expect("HOME not set");
            std::path::PathBuf::from(home)
                .join("Library/Application Support/com.alex.viboplr")
        }
        #[cfg(target_os = "windows")]
        {
            let appdata = std::env::var("APPDATA").expect("APPDATA not set");
            std::path::PathBuf::from(appdata).join("com.alex.viboplr")
        }
        #[cfg(target_os = "linux")]
        {
            let home = std::env::var("HOME").expect("HOME not set");
            std::path::PathBuf::from(home)
                .join(".local/share/com.alex.viboplr")
        }
    });

    // Resolve to an existing profile dir's casing before anything reads the
    // profile path (profile names are case-insensitive identities; without
    // this a cold `--profile Work` launch would create a case-variant
    // duplicate of profiles/work on case-sensitive filesystems — a state
    // create_profile_in rejects and listing would double-mark as current).
    let profile_name =
        profiles::canonical_profile_name(&pre_app_data_dir.join("profiles"), &profile_name);

    // Read loggingEnabled from the profile's store file
    let logging_enabled = timer.time("check_logging_enabled", || {
        let store_path = pre_app_data_dir
            .join("profiles")
            .join(&profile_name)
            .join("app-state.json");
        if let Ok(contents) = std::fs::read_to_string(&store_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) {
                return json.get("loggingEnabled").and_then(|v| v.as_bool()).unwrap_or(false);
            }
        }
        false
    });

    timer.time("logging::init", || {
        let log_dir = if logging_enabled {
            Some(pre_app_data_dir.join("profiles").join(&profile_name).join("logs"))
        } else {
            None
        };
        logging::init(log_dir);
    });

    log::info!("Using profile: {}", profile_name);

    // Managed before the single-instance plugin registers so its callback can
    // never observe unmanaged state (it can fire while setup is still running).
    let builder = tauri::Builder::default().manage(profiles::PendingProfileSwitch::default());
    #[cfg(not(debug_assertions))]
    let builder = timer.time("plugin: single_instance", || {
        let current_profile = profile_name.clone();
        builder.plugin(tauri_plugin_single_instance::init(move |app, argv, _cwd| {
            eprintln!("[single_instance] callback fired, argv={:?}", argv);
            // Focus existing window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // An explicit --profile for a different profile is a switch request
            // (e.g. a profile shortcut opened while running). Absent flag or the
            // current profile → focus only, never "switch to default". The
            // frontend consumes the stash via get_pending_profile_switch; the
            // event is only a nudge.
            if let Some(requested) = profiles::pending_switch_request(&argv, &current_profile) {
                let slot = app.state::<profiles::PendingProfileSwitch>();
                // Poison-tolerant: a panic elsewhere must not turn a shortcut
                // double-click into a crash of the running app.
                if let Ok(mut pending) = slot.0.lock() {
                    *pending = Some(requested.clone());
                }
                let _ = app.emit("profile-switch-requested", requested);
            }
            // Check argv for subsonic:// and viboplr:// deep link URLs
            for arg in &argv {
                if arg.starts_with("subsonic://") || arg.starts_with("viboplr://") {
                    eprintln!("[single_instance] emitting deep-link-received: {}", arg);
                    let _ = app.emit("deep-link-received", arg.clone());
                    break;
                }
            }
        }))
    });
    let builder = timer.time("plugin: deep_link", || builder.plugin(tauri_plugin_deep_link::init()));
    let builder = timer.time("plugin: opener", || builder.plugin(tauri_plugin_opener::init()));
    let builder = timer.time("plugin: dialog", || builder.plugin(tauri_plugin_dialog::init()));
    let builder = timer.time("plugin: store", || builder.plugin(tauri_plugin_store::Builder::new().build()));
    let builder = timer.time("plugin: updater", || builder.plugin(tauri_plugin_updater::Builder::new().build()));
    let builder = timer.time("plugin: process", || builder.plugin(tauri_plugin_process::init()));
    let builder = timer.time("plugin: global_shortcut", || builder.plugin(tauri_plugin_global_shortcut::Builder::new().build()));
    // Anonymous usage telemetry (self-hosted Aptabase). No-op unless an
    // APTABASE_APP_KEY was baked in at build time — see telemetry.rs.
    let builder = timer.time("plugin: aptabase", || telemetry::register(builder));

    // Evaluate the invoke handler + Tauri context up front so we can bracket the
    // otherwise-invisible gap between context generation and our setup body. That
    // interval lives entirely inside .build() — Tauri creating the webview window
    // and initializing plugin setups — and has historically been the single
    // largest (and completely unmeasured) chunk of backend startup.
    let invoke_handler = timer.time("invoke_handler", || get_invoke_handler());
    let context = timer.time("generate_context", || tauri::generate_context!());
    let build_start = std::time::Instant::now();

    // tauri-plugin-aptabase spawns its flush loop via `tokio::spawn` during
    // plugin setup and drives a final reqwest flush on `RunEvent::Exit` — both
    // need a Tokio reactor entered on the main thread, which Tauri does NOT do
    // for setup/run (hence the "there is no reactor running" panic). Enter the
    // shared async runtime here for the app's whole lifetime — equivalent to a
    // `#[tokio::main]` entry, and purely additive (nothing here block_on's on the
    // main thread). Harmless when telemetry is disabled. Both bindings must
    // outlive build() + run(); the handle is declared first so it outlives the
    // guard that borrows it.
    let tokio_rt_handle = tauri::async_runtime::handle();
    let _tokio_rt_guard = tokio_rt_handle.inner().enter();

    builder
        .setup(move |app| {
            // First line of setup: record how long .build() took to reach here
            // (webview creation + plugin setup init). duration = now - build_start.
            timing::timer().record("tauri_build_webview", build_start);

            // Register Rust-side deep link handler to ensure URLs reach the frontend
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    eprintln!("[on_open_url] deep link: {}", url);
                    let _ = handle.emit("deep-link-received", url.to_string());
                }
            });

            let timer = timing::timer();

            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");

            let app_dir = timer.time("resolve_app_dir", || {
                let dir = app_data_dir.join("profiles").join(&profile_name);
                std::fs::create_dir_all(&dir).expect("Failed to create profile directory");
                dir
            });

            // Managed binary copies (yt-dlp etc.) are shared across profiles.
            dependencies::set_managed_bin_dir(app_data_dir.join("bin"));
            // The downloadable libmpv engine component lives beside them.
            mpv_engine::set_component_dir(app_data_dir.join("engine"));

            // Migrate legacy data from root app_data_dir to profiles/default/.
            // Gated by a sentinel file so this is a true one-shot — once the
            // marker exists we skip every probe entirely on subsequent launches.
            if profile_name == "default" {
                let migrated_marker = app_dir.join(".legacy_migration_done");
                if !migrated_marker.exists() {
                    timer.time("migrate_legacy_data", || {
                        let legacy_db = app_data_dir.join("viboplr.db");
                        let profile_db = app_dir.join("viboplr.db");
                        if legacy_db.exists() && !profile_db.exists() {
                            log::info!("Migrating legacy data to profiles/default/");
                            let items = [
                                "viboplr.db", "viboplr.db-shm", "viboplr.db-wal",
                                "app-state.json",
                                "artist_images", "album_images", "tag_images", "waveforms",
                            ];
                            for item in &items {
                                let src = app_data_dir.join(item);
                                let dst = app_dir.join(item);
                                if src.exists() {
                                    if let Err(e) = std::fs::rename(&src, &dst) {
                                        log::warn!("Failed to migrate {}: {}", item, e);
                                    } else {
                                        log::info!("Migrated {} to profiles/default/", item);
                                    }
                                }
                            }
                        }
                        let _ = std::fs::write(&migrated_marker, b"");
                    });
                }
            }

            let db = Arc::new(timer.time("Database::new", || Database::new(&app_dir).expect("Failed to init database")));

            // One-time migration: web search moved from core into the
            // `search-providers` plugin (see seed_search_providers_from_legacy).
            timer.time("migrate_search_providers", || {
                seed_search_providers_from_legacy(&db, &app_dir);
            });

            timer.time("create_image_dirs", || {
                let _ = std::fs::create_dir_all(app_dir.join("artist_images"));
                let _ = std::fs::create_dir_all(app_dir.join("album_images"));
                let _ = std::fs::create_dir_all(app_dir.join("tag_images"));
            });

            timer.time("clean_legacy_waveforms", || {
                let waveforms_dir = app_dir.join("waveforms");
                let marker = waveforms_dir.join(".legacy_cleaned");
                if marker.exists() {
                    return;
                }
                // Remove legacy versioned subdirectories (v2, v3, v4)
                for sub in &["v2", "v3", "v4"] {
                    let dir = waveforms_dir.join(sub);
                    if dir.exists() {
                        let _ = std::fs::remove_dir_all(&dir);
                    }
                }
                let _ = std::fs::create_dir_all(&waveforms_dir);
                let _ = std::fs::write(&marker, b"");
            });

            // Defer yt_cache cleanup to a background thread so it never blocks
            // the setup path — directory walks and unlinks add up quickly when
            // the cache has accumulated stale entries.
            {
                let yt_cache = app_dir.join("yt_cache");
                std::thread::spawn(move || {
                    if yt_cache.is_dir() {
                        if let Ok(entries) = std::fs::read_dir(&yt_cache) {
                            for entry in entries.flatten() {
                                let _ = std::fs::remove_file(entry.path());
                            }
                        }
                    }
                });
            }

            let download_queue = timer.time("setup_download_queue", || Arc::new(DownloadQueue {
                queue: Mutex::new(Vec::new()),
                condvar: Condvar::new(),
            }));

            // Built-in image providers. Both are Rust-native (no bridge
            // round-trip) but neither is privileged: they take their turn in the
            // user's chain like any plugin — see `resolve_entity_image`.
            let folder_provider = image_provider::folder::FolderImageProvider::new(db.clone());
            let embedded_provider = image_provider::embedded::EmbeddedArtworkProvider::new(db.clone());

            // Spawn the image download worker thread
            let worker_queue = download_queue.clone();
            let worker_app_dir = app_dir.clone();
            let worker_db = db.clone();
            let app_handle = app.handle().clone();
            let worker_registry = Arc::new(ImageResolveRegistry {
                pending: Mutex::new(std::collections::HashMap::new()),
            });
            let worker_registry_for_state = worker_registry.clone();
            timer.time("spawn_image_worker", || { std::thread::spawn(move || {
                let chain = ImageChain {
                    app_handle: &app_handle,
                    db: &worker_db,
                    registry: &worker_registry,
                    folder: &folder_provider,
                    embedded: &embedded_provider,
                };
                loop {
                    let request = {
                        let mut queue = worker_queue.queue.lock().unwrap();
                        while queue.is_empty() {
                            queue = worker_queue.condvar.wait(queue).unwrap();
                        }
                        queue.pop().unwrap() // LIFO: pop from the end
                    };

                    let (target, force) = match request {
                        ImageDownloadRequest::Artist { name, force } => {
                            (ImageTarget::Artist { name }, force)
                        }
                        ImageDownloadRequest::Album { title, artist_name, force } => {
                            (ImageTarget::Album { title, artist_name }, force)
                        }
                        ImageDownloadRequest::Tag { name, force } => {
                            (ImageTarget::Tag { name }, force)
                        }
                    };

                    let entity = target.entity();
                    let slug = target.slug();

                    if !force && worker_db.is_image_failed(entity, &slug).unwrap_or(false) {
                        log::info!("Skipping previously failed {} image: {}", entity, target.label());
                        continue;
                    }
                    // `get_image_path` rather than `dest.exists()`: a stored
                    // image may carry any of the extensions a provider can
                    // produce, and the artist/album arms used to test only the
                    // `.jpg` name — so an album whose art came back as a PNG was
                    // re-resolved, through the whole provider chain, on every
                    // single request.
                    if !force && entity_image::get_image_path(&worker_app_dir, entity, &slug).is_some() {
                        log::info!("{} image already exists for {}, skipping", entity, target.label());
                        continue;
                    }

                    let dest = worker_app_dir
                        .join(format!("{}_images", entity))
                        .join(format!("{}.jpg", slug));
                    let used_bridge = resolve_entity_image(&chain, &target, &slug, &dest);

                    // Throttle **remote** work only. This worker is one serial
                    // thread, so a flat post-resolve sleep is paid by every
                    // entity in the queue behind it: a freshly scanned library
                    // whose art all came from `core:folder` spent a second per
                    // artist and per album doing nothing, and the grid took the
                    // best part of a minute to fill in for a 25-artist library
                    // that had every image sitting on disk next to the tracks
                    // (#126). Local providers have no API to be polite to, so
                    // the courtesy delay applies only when the chain actually
                    // went out over the plugin bridge.
                    if used_bridge {
                        std::thread::sleep(REMOTE_IMAGE_THROTTLE);
                    }
                }
            }); });

            let resyncing_collections: Arc<Mutex<std::collections::HashSet<i64>>> =
                Arc::new(Mutex::new(std::collections::HashSet::new()));

            // Plugin scheduler background thread
            {
                let app_handle = app.handle().clone();
                let db = Arc::clone(&db);
                std::thread::spawn(move || {
                    use std::collections::HashSet;
                    use std::time::{Duration, SystemTime, UNIX_EPOCH};

                    let mut dispatched: HashSet<(String, String)> = HashSet::new();

                    // Wait for frontend to be ready
                    std::thread::sleep(Duration::from_secs(5));

                    loop {
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as i64;

                        if let Ok(schedules) = db.plugin_scheduler_get_all() {
                            // Clean up dispatched set: remove entries whose last_run is now recent
                            dispatched.retain(|(pid, tid)| {
                                schedules.iter().any(|(p, t, interval, lr)| {
                                    p == pid && t == tid && match lr {
                                        Some(last) => (now - last) >= *interval,
                                        None => true,
                                    }
                                })
                            });

                            // Dispatch due tasks
                            for (plugin_id, task_id, interval_ms, last_run) in &schedules {
                                let key = (plugin_id.clone(), task_id.clone());
                                if dispatched.contains(&key) {
                                    continue;
                                }
                                let is_due = match last_run {
                                    None => true,
                                    Some(lr) => (now - lr) >= *interval_ms,
                                };
                                if is_due {
                                    dispatched.insert(key);
                                    let _ = app_handle.emit(
                                        "plugin-scheduler-due",
                                        serde_json::json!({
                                            "pluginId": plugin_id,
                                            "taskId": task_id,
                                        }),
                                    );
                                }
                            }
                        }

                        std::thread::sleep(Duration::from_secs(60));
                    }
                });
            }

            // Collection auto-update scheduler thread
            {
                let app_handle = app.handle().clone();
                let db = Arc::clone(&db);
                let resyncing = Arc::clone(&resyncing_collections);

                std::thread::spawn(move || {
                    use std::time::{Duration, SystemTime, UNIX_EPOCH};

                    std::thread::sleep(Duration::from_secs(10));

                    loop {
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs() as i64;

                        if let Ok(collections) = db.get_collections() {
                            for col in collections {
                                if !commands::is_collection_due_for_auto_update(&col, now) {
                                    continue;
                                }
                                if resyncing.lock().unwrap().contains(&col.id) {
                                    log::debug!("Skipping auto-update for '{}': already resyncing", col.name);
                                    continue;
                                }
                                log::info!("Auto-updating collection: {}", col.name);
                                commands::run_collection_resync(
                                    Arc::clone(&db),
                                    app_handle.clone(),
                                    col,
                                    Arc::clone(&resyncing),
                                    false,
                                );
                            }
                        }

                        std::thread::sleep(Duration::from_secs(60));
                    }
                });
            }

            // Restore window size/position from store before showing, to avoid IPC round-trips
            timer.time("restore_window", || {
                let window = app.get_webview_window("main").unwrap();

                // Force process exit when the main window closes. Covers two cases:
                // (1) on macOS, win.close() hides rather than terminates;
                // (2) on Windows, hidden plugin browse windows keep the process alive
                //     so RunEvent::ExitRequested never fires.
                window.on_window_event(|event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        std::process::exit(0);
                    }
                });

                // Taskbar-button clicks are an OS gesture with no Tauri event —
                // subclass the window proc so the mini player can answer them.
                #[cfg(target_os = "windows")]
                {
                    if let Ok(hwnd) = window.hwnd() {
                        taskbar_win::install(hwnd.0 as isize, app.handle().clone());
                    }
                }

                // Make window background transparent for rounded mini player corners
                #[cfg(target_os = "macos")]
                {
                    #[allow(deprecated)]
                    {
                        use cocoa::appkit::{NSColor, NSWindow};
                        use cocoa::base::{id, nil};
                        let ns_window = window.ns_window().unwrap() as id;
                        unsafe {
                            ns_window.setBackgroundColor_(NSColor::clearColor(nil));
                        }
                    }
                }

                // Read persisted window state from the store JSON file
                let store_path = app_dir.join("app-state.json");
                if let Ok(data) = std::fs::read_to_string(&store_path) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&data) {
                        // Collect monitor bounds for off-screen validation
                        let monitors: Vec<(f64, f64, f64, f64)> = window.available_monitors()
                            .unwrap_or_default()
                            .iter()
                            .filter_map(|m| {
                                let pos = m.position();
                                let size = m.size();
                                let scale = m.scale_factor();
                                Some((
                                    pos.x as f64 / scale,
                                    pos.y as f64 / scale,
                                    pos.x as f64 / scale + size.width as f64 / scale,
                                    pos.y as f64 / scale + size.height as f64 / scale,
                                ))
                            })
                            .collect();
                        let is_visible = |x: f64, y: f64| -> bool {
                            if monitors.is_empty() { return true; }
                            monitors.iter().any(|(mx, my, mx2, my2)| {
                                x >= *mx && x < *mx2 && y >= *my && y < *my2
                            })
                        };
                        // Find the monitor containing a point, or the first monitor as fallback
                        let monitor_at = |x: f64, y: f64| -> Option<(f64, f64, f64, f64)> {
                            monitors.iter()
                                .find(|(mx, my, mx2, my2)| x >= *mx && x < *mx2 && y >= *my && y < *my2)
                                .or(monitors.first())
                                .copied()
                        };

                        let is_mini = json.get("miniMode").and_then(|v| v.as_bool()).unwrap_or(false);
                        #[cfg(target_os = "windows")]
                        taskbar_win::set_state(
                            is_mini,
                            json.get("minimizeToMiniPlayer").and_then(|v| v.as_bool()).unwrap_or(false),
                        );
                        if is_mini {
                            let raw_resting = json.get("miniRestingSize").and_then(|v| v.as_str()).unwrap_or("normal");
                            let size_migrated = json.get("miniSizeMigrated").and_then(|v| v.as_bool()).unwrap_or(false);
                            let mini_height = match raw_resting {
                                "ultra" => 24.0,
                                "compact" if size_migrated => 24.0,
                                "compact" => 52.0, // pre-migration: old "compact" = 52px
                                _ => 52.0,
                            };
                            let mini_width = match json.get("miniWidthSize").and_then(|v| v.as_str()).unwrap_or("medium") {
                                "small" => 280.0,
                                "large" => 550.0,
                                _ => 400.0,
                            };
                            let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize { width: 280.0, height: mini_height })));
                            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: mini_width, height: mini_height }));
                            if let (Some(x), Some(y)) = (
                                json.get("miniWindowX").and_then(|v| v.as_f64()),
                                json.get("miniWindowY").and_then(|v| v.as_f64()),
                            ) {
                                if is_visible(x, y) {
                                    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
                                }
                            }
                            let _ = window.set_always_on_top(true);
                            let _ = window.set_resizable(false);
                            let _ = window.set_decorations(false);
                        } else {
                            let saved_w = json.get("windowWidth").and_then(|v| v.as_f64());
                            let saved_h = json.get("windowHeight").and_then(|v| v.as_f64());
                            let saved_x = json.get("windowX").and_then(|v| v.as_f64());
                            let saved_y = json.get("windowY").and_then(|v| v.as_f64());

                            // Determine target monitor from saved position, or use first monitor
                            let target = saved_x.zip(saved_y)
                                .and_then(|(x, y)| monitor_at(x, y))
                                .or(monitors.first().copied());

                            if let (Some(mut w), Some(mut h)) = (saved_w, saved_h) {
                                if w > 0.0 && h > 0.0 {
                                    // Clamp size to target monitor bounds
                                    if let Some((mx, my, mx2, my2)) = target {
                                        let mw = mx2 - mx;
                                        let mh = my2 - my;
                                        if w > mw { w = mw; }
                                        if h > mh { h = mh; }
                                    }
                                    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: w, height: h }));
                                }
                            }

                            if let (Some(mut x), Some(mut y)) = (saved_x, saved_y) {
                                if is_visible(x, y) {
                                    // Ensure the window doesn't extend beyond the monitor
                                    if let Some((mx, _my, mx2, my2)) = target {
                                        let w = saved_w.unwrap_or(800.0).min(mx2 - mx);
                                        let h = saved_h.unwrap_or(600.0).min(my2 - _my);
                                        if x + w > mx2 { x = (mx2 - w).max(mx); }
                                        if y + h > my2 { y = (my2 - h).max(_my); }
                                    }
                                    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
                                }
                            }
                        }
                    }
                }
            });

            // Set window title for named profiles (like Chrome)
            if profile_name != "default" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title(&format!("Viboplr [{}]", profile_name));
                }
            }

            let native_plugins_dir = timer.time("resolve_native_plugins_dir", || {
                // In dev mode, use the plugins dir next to Cargo.toml (src-tauri/plugins/)
                // In production, use the bundled resources directory
                let candidates: Vec<std::path::PathBuf> = {
                    let mut c = Vec::new();
                    #[cfg(debug_assertions)]
                    c.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("plugins"));
                    if let Ok(res) = app.path().resource_dir() {
                        c.push(res.join("plugins"));
                    }
                    c
                };
                for dir in candidates {
                    if dir.is_dir() {
                        log::info!("Native plugins dir: {}", dir.display());
                        return Some(dir);
                    }
                }
                log::info!("No native plugins dir found");
                None
            });

            // Cursor tracker for mini mode hover-expand without focus
            let cursor_tracker_active = Arc::new(std::sync::atomic::AtomicBool::new(false));
            #[cfg(target_os = "macos")]
            {
                let tracker_flag = Arc::clone(&cursor_tracker_active);
                let tracker_handle = app.handle().clone();
                std::thread::spawn(move || {
                    crate::cursor_tracker::run(tracker_flag, tracker_handle);
                });
            }
            #[cfg(target_os = "windows")]
            {
                let tracker_flag = Arc::clone(&cursor_tracker_active);
                let tracker_handle = app.handle().clone();
                std::thread::spawn(move || {
                    crate::cursor_tracker_win::run(tracker_flag, tracker_handle);
                });
            }

            // Sweep the storyboard cache off the startup path: drop entries whose track
            // is gone, then evict oldest-first if the rest still exceeds the cap. Sheets
            // are ~200 KB each, so unlike the waveform cache this one has to be bounded.
            {
                let sb_dir = app_dir.clone();
                let sb_db = db.clone();
                std::thread::spawn(move || {
                    match sb_db.get_all_track_uris() {
                        Ok(mut live) => {
                            // The persisted queue is a liveness source too: external
                            // tracks (a video played off a share, a plugin result)
                            // have no library row, and sweeping their storyboards
                            // meant every restart regenerated exactly the tracks
                            // that auto-resume at startup.
                            live.extend(crate::main_playlist::track_paths(&sb_dir));
                            if let Err(e) = crate::storyboard::gc(&sb_dir, &live) {
                                log::warn!("Storyboard gc failed: {}", e);
                            }
                        }
                        // Without a liveness set, skip the orphan sweep but still cap.
                        Err(e) => log::warn!("Storyboard gc: could not read track paths: {}", e),
                    }
                    if let Err(e) =
                        crate::storyboard::enforce_cap(&sb_dir, crate::storyboard::MAX_CACHE_BYTES)
                    {
                        log::warn!("Storyboard cap enforcement failed: {}", e);
                    }
                });
            }

            let transcode_sessions: transcode_server::Sessions =
                Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
            let stream_relays: stream_relay::Relays = Default::default();
            let transcode_port = timer.time("start_transcode_server", || {
                transcode_server::start_sync(transcode_sessions.clone(), stream_relays.clone())
            });

            // Clone values before moving into AppState, for use in update checker
            let checker_app_dir = app_dir.clone();
            let checker_native_dir = native_plugins_dir.clone();
            let dep_cache = Arc::new(dependencies::DepCache::new());
            let dep_updater_cache = Arc::clone(&dep_cache);
            let dep_updater_store_path = app_dir.join("app-state.json");

            // Localhost control API (AI remote control). The state object always
            // exists; the server starts only when the profile's store enables it.
            let control_api_state = Arc::new(control_api::ControlApi::default());
            let control_api_enabled = {
                let store_path = app_dir.join("app-state.json");
                std::fs::read_to_string(&store_path)
                    .ok()
                    .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                    .and_then(|j| j.get("controlApiEnabled").and_then(|v| v.as_bool()))
                    .unwrap_or(false)
            };
            if control_api_enabled {
                timer.time("start_control_api", || {
                    if let Err(e) = control_api::start(
                        &control_api_state,
                        db.clone(),
                        app.handle().clone(),
                        &app_dir,
                        &profile_name,
                        &app.package_info().version.to_string(),
                    ) {
                        log::error!("Control API failed to start: {}", e);
                    }
                });
            }

            timer.time("manage_app_state", || {
                app.manage(AppState {
                    db,
                    app_dir,
                    profile_name,
                    download_queue,
                    native_plugins_dir,
                    image_resolve_registry: worker_registry_for_state,
                    plugin_execs: Arc::new(commands::PluginExecRegistry::new()),
                    direct_download_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    mixtape_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    publish_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    plugin_install_cancel: Arc::new(std::sync::Mutex::new(
                        std::collections::HashSet::new(),
                    )),
                    resyncing_collections: Arc::clone(&resyncing_collections),
                    cursor_tracker_active: Arc::clone(&cursor_tracker_active),
                    transcode_port,
                    transcode_sessions,
                    stream_relays,
                    dep_cache,
                    pending_app_update: tokio::sync::Mutex::new(None),
                    mpv_engine: Default::default(),
                    control_api: control_api_state,
                });
            });

            // Auto-update app-managed dependency copies (e.g. yt-dlp, which
            // breaks against YouTube within weeks when stale). Only touches
            // binaries in the managed bin dir — never package-manager installs.
            {
                let updater_app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    loop {
                        // Let startup settle before any network traffic.
                        std::thread::sleep(std::time::Duration::from_secs(30));
                        dependencies::auto_update_managed(
                            &dep_updater_cache,
                            &dep_updater_store_path,
                            |event, payload| {
                                let _ = updater_app_handle.emit(event, payload);
                            },
                        );
                        // Re-run daily; the latest-version TTL cache makes
                        // earlier wakeups free anyway.
                        std::thread::sleep(std::time::Duration::from_secs(24 * 60 * 60 - 30));
                    }
                });
            }

            // Spawn the update checker thread
            {
                let checker_app_handle = app.handle().clone();
                let checker_app_version = app.package_info().version.to_string();
                let checker_cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
                crate::update_checker::spawn_update_checker(
                    checker_app_handle,
                    checker_app_dir,
                    checker_native_dir.unwrap_or_default(),
                    checker_app_version,
                    checker_cancel,
                );
            }

            // Dump startup timings to log file
            for entry in timing::timer().get_entries() {
                log::info!(
                    "Startup: {} \u{2014} {:.1}ms (offset {:.1}ms)",
                    entry.label,
                    entry.duration_ms,
                    entry.offset_ms
                );
            }

            Ok(())
        })
        .invoke_handler(invoke_handler)
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            match &event {
                tauri::RunEvent::Exit => {
                    // Courtesy cleanup: without it the discovery file merely goes
                    // stale, which consumers must handle anyway (health probe).
                    if let Some(state) = app.try_state::<AppState>() {
                        control_api::remove_discovery_file(&state.app_dir);
                    }
                    std::process::exit(0);
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    eprintln!("[RunEvent::Opened] urls: {:?}", urls);
                    for url in urls {
                        let url_str = url.to_string();
                        if url_str.ends_with(".mixtape") {
                            let path = url_str.strip_prefix("file://").unwrap_or(&url_str);
                            eprintln!("[RunEvent::Opened] mixtape file: {}", path);
                            let _ = app.emit("mixtape-file-opened", path.to_string());
                        } else {
                            eprintln!("[RunEvent::Opened] emitting deep-link-received: {}", url);
                            let _ = app.emit("deep-link-received", url.to_string());
                        }
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                    eprintln!("[RunEvent::Reopen] has_visible_windows={}", has_visible_windows);
                    if !has_visible_windows {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    } else {
                        let _ = app.emit("restore-from-mini", ());
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_state(dir: &std::path::Path, json: &str) {
        std::fs::write(dir.join("app-state.json"), json).unwrap();
    }

    #[test]
    fn test_seed_migrates_legacy_search_providers() {
        let db = Database::new_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        write_state(
            dir.path(),
            r#"{"searchProviders":[{"id":"custom-1","name":"Mine","enabled":true,"trackUrl":"https://x/{title}"}]}"#,
        );

        seed_search_providers_from_legacy(&db, dir.path());

        let stored = db
            .plugin_storage_get("search-providers", "providers")
            .unwrap();
        assert!(stored.is_some());
        assert!(stored.unwrap().contains("Mine"));
        // marker is set so a second run is a no-op
        assert!(db
            .plugin_storage_get("__core__", "search_providers_migrated")
            .unwrap()
            .is_some());
    }

    #[test]
    fn test_seed_is_skipped_when_already_migrated() {
        let db = Database::new_in_memory().unwrap();
        db.plugin_storage_set("__core__", "search_providers_migrated", "1")
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        write_state(
            dir.path(),
            r#"{"searchProviders":[{"id":"x","name":"Y","enabled":true}]}"#,
        );

        seed_search_providers_from_legacy(&db, dir.path());

        // marker present from the start → never copies
        assert!(db
            .plugin_storage_get("search-providers", "providers")
            .unwrap()
            .is_none());
    }

    #[test]
    fn test_seed_skips_null_legacy_but_sets_marker() {
        let db = Database::new_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        write_state(dir.path(), r#"{"searchProviders":null}"#);

        seed_search_providers_from_legacy(&db, dir.path());

        assert!(db
            .plugin_storage_get("search-providers", "providers")
            .unwrap()
            .is_none());
        // marker still set so it does not re-run on every startup
        assert!(db
            .plugin_storage_get("__core__", "search_providers_migrated")
            .unwrap()
            .is_some());
    }
}
