// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

// --- Profile commands ---

/// Build flavor for anonymous telemetry: "full" (the mpv-engine build) vs
/// "lean". Compile-time constant, no side effects — deliberately NOT part of
/// `engine_capabilities` (which loads libmpv on first probe).
#[tauri::command]
pub fn app_build_flavor() -> &'static str {
    if cfg!(feature = "mpv-engine") {
        "full"
    } else {
        "lean"
    }
}

#[tauri::command]
pub fn get_profile_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "profileName": state.profile_name,
        "storePath": format!("profiles/{}/app-state.json", state.profile_name),
    }))
}

/// The profiles/ dir is the parent of the current profile's data dir.
fn profiles_dir(state: &AppState) -> Result<std::path::PathBuf, String> {
    state
        .app_dir
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Cannot resolve profiles directory".to_string())
}

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Result<Vec<crate::profiles::ProfileEntry>, String> {
    crate::profiles::list_profiles_in(&profiles_dir(&state)?, &state.profile_name)
}

#[tauri::command]
pub fn create_profile(state: State<'_, AppState>, name: String) -> Result<(), String> {
    crate::profiles::create_profile_in(&profiles_dir(&state)?, name.trim())
}

/// Relaunch the app into another profile: validate → resolve binary → drain
/// in-flight DB writes → release the single-instance lock → spawn → exit.
/// The frontend flushes its debounced state (store + queue) *before* invoking
/// this. `allow_create` is set only by the shortcut-handoff consumer so a warm
/// shortcut to a deleted profile gets cold-start parity (recreate empty); the
/// Settings path keeps existence validation.
#[tauri::command]
pub fn switch_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    allow_create: Option<bool>,
) -> Result<(), String> {
    let name = name.trim().to_string();
    crate::profiles::validate_profile_name(&name)?;
    if crate::profiles::same_profile_name(&name, &state.profile_name) {
        return Err(format!("'{}' is already the active profile.", name));
    }
    let profiles_root = profiles_dir(&state)?;
    if !profiles_root.join(&name).is_dir() {
        if allow_create.unwrap_or(false) {
            // Cold-start parity for warm shortcuts: recreate the deleted
            // profile through the same helper create_profile uses.
            crate::profiles::create_profile_in(&profiles_root, &name)?;
        } else {
            return Err(format!("Profile '{}' no longer exists.", name));
        }
    }

    // Resolve and existence-check the binary before anything destructive
    // (post-destroy failure would leave the session without single-instance
    // protection). AppImage-safe: current_binary returns $APPIMAGE when set,
    // never the mount point — but that file can have been moved since launch.
    let env = app.env();
    let bin = tauri::process::current_binary(&env)
        .map_err(|e| format!("Failed to resolve app binary: {}", e))?;
    if !bin.exists() {
        return Err(format!(
            "App binary not found at {} — was it moved? Restart the app manually.",
            bin.display()
        ));
    }

    // Drain any in-flight DB write (e.g. a like invoked moments ago) so the
    // exit below can't cut a statement off mid-write.
    state.db.write_barrier();

    // Release the single-instance lock before spawning — otherwise the child
    // forwards-and-exits against the still-live parent. Release builds only
    // (the plugin is not registered in debug).
    #[cfg(not(debug_assertions))]
    tauri_plugin_single_instance::destroy(&app);

    // env_remove: env takes precedence over argv at startup and the child
    // inherits our env — an inherited VIBOPLR_PROFILE would silently override
    // the new --profile.
    let spawned = std::process::Command::new(&bin)
        .args(["--profile", &name])
        .env_remove("VIBOPLR_PROFILE")
        .spawn();
    if let Err(e) = spawned {
        log::error!(
            "Profile switch spawn failed (single-instance protection is disabled for the rest of this session): {}",
            e
        );
        return Err(format!("Failed to launch profile '{}': {}", name, e));
    }
    app.exit(0);
    Ok(())
}

/// Consume a switch request stashed by the single-instance callback before the
/// frontend was ready to receive the live event. Pull-once semantics.
#[tauri::command]
pub fn get_pending_profile_switch(
    pending: State<'_, crate::profiles::PendingProfileSwitch>,
) -> Option<String> {
    pending.0.lock().ok()?.take()
}

/// Write a double-clickable Desktop launcher that opens the app in `name`
/// (.lnk / wrapper .app / .desktop per platform). Returns the written path.
#[tauri::command]
pub fn create_profile_shortcut(app: AppHandle, name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    crate::profiles::validate_profile_name(&name)?;
    let desktop = app
        .path()
        .desktop_dir()
        .map_err(|e| format!("Failed to resolve the Desktop directory: {}", e))?;
    let env = app.env();
    let bin = tauri::process::current_binary(&env)
        .map_err(|e| format!("Failed to resolve app binary: {}", e))?;
    #[cfg(target_os = "linux")]
    let appimage = env.appimage.clone().map(std::path::PathBuf::from);
    #[cfg(not(target_os = "linux"))]
    let appimage: Option<std::path::PathBuf> = None;
    crate::profile_shortcuts::create_shortcut_on(
        &desktop,
        &name,
        &app.config().identifier,
        &bin,
        appimage.as_deref(),
    )
    .map(|p| p.to_string_lossy().to_string())
}

// --- Debug commands ---

#[tauri::command]
pub fn open_devtools(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
    }
}

#[tauri::command]
pub fn open_devtools_for_window(app: AppHandle, label: String) {
    if let Some(window) = app.get_webview_window(&label) {
        window.open_devtools();
    }
}

#[tauri::command]
pub fn open_folder(folder_path: String) -> Result<(), String> {
    let path = std::path::Path::new(&folder_path);
    if !path.exists() {
        return Err(format!("Folder not found: {}", folder_path));
    }
    tauri_plugin_opener::open_path(folder_path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_profile_folder(state: State<'_, AppState>) -> Result<(), String> {
    open_folder(state.app_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn open_logs_folder(state: State<'_, AppState>) -> Result<(), String> {
    let logs_dir = state.app_dir.join("logs");
    std::fs::create_dir_all(&logs_dir).map_err(|e| e.to_string())?;
    open_folder(logs_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_app_paths(state: State<'_, AppState>) -> Result<(String, String), String> {
    let logs_dir = state.app_dir.join("logs");
    Ok((
        state.app_dir.to_string_lossy().to_string(),
        logs_dir.to_string_lossy().to_string(),
    ))
}

#[tauri::command]
pub fn write_frontend_log(level: String, message: String, section: Option<String>) -> Result<(), String> {
    let target = section.unwrap_or_else(|| "frontend".to_string());
    match level.as_str() {
        "error" => log::log!(target: &target, log::Level::Error, "{}", message),
        "warn" => log::log!(target: &target, log::Level::Warn, "{}", message),
        _ => log::log!(target: &target, log::Level::Info, "{}", message),
    }
    Ok(())
}

#[tauri::command]
pub fn get_startup_timings() -> Vec<crate::timing::TimingEntry> {
    crate::timing::timer().get_entries()
}

/// Persist the frontend startup timings to the on-disk log. They otherwise live
/// only in Settings → Startup Timings and vanish when the app closes, so cold
/// starts leave no cross-session record of the perceived-startup path (the
/// window stays hidden until the frontend restore chain calls window.show()).
/// The frontend clock (performance.now) is a different origin from the backend
/// Instant clock, so these are logged as their own timeline, not summed with it.
#[tauri::command]
pub fn record_frontend_startup_timings(entries: Vec<crate::timing::TimingEntry>) {
    let mut total = 0.0;
    for e in &entries {
        log::info!(
            "Startup[fe]: {} \u{2014} {:.1}ms (offset {:.1}ms)",
            e.label,
            e.duration_ms,
            e.offset_ms
        );
        total += e.duration_ms;
    }
    // window.restore ends the moment getCurrentWindow().show() resolves, so its
    // offset+duration is the time-to-visible-window on the frontend clock.
    if let Some(visible) = entries
        .iter()
        .find(|e| e.label == "window.restore")
        .map(|e| e.offset_ms + e.duration_ms)
    {
        log::info!(
            "Startup[fe]: time-to-window-visible \u{2014} {:.1}ms (frontend clock)",
            visible
        );
    }
    log::info!("Startup[fe]: frontend work total \u{2014} {:.1}ms", total);
}

/// Determines if a collection is due for an auto-update based on its settings and last sync time.
///
/// Returns true if:
/// - The collection is enabled and has auto_update enabled
/// - The collection kind is "local" or "subsonic"
/// - Either the collection has never been synced (last_synced_at is None)
///   OR the configured interval has elapsed since the last sync
///
/// Note: Error backoff is handled naturally through last_synced_at updates.
/// When a sync fails, update_collection_sync_error sets last_synced_at to the current time,
/// so the full interval must elapse before the next retry.
#[tauri::command]
pub fn set_cursor_tracker(state: State<'_, AppState>, active: bool) {
    state.cursor_tracker_active.store(active, Ordering::Relaxed);
}
