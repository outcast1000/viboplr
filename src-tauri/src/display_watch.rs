//! macOS display-reconfiguration watcher.
//!
//! Emits a `monitors-changed` event to the webview whenever a display is
//! connected, disconnected, or rearranged, so the frontend can restore the
//! window geometry it saved for the new arrangement (`useMiniMode.ts` —
//! per-arrangement geometry, see `window_arrangement.rs`). Without this
//! signal the app only ever *reads* saved geometry at launch and on the
//! mini-mode toggle, so plugging the external screen back in restored
//! nothing.
//!
//! Uses `CGDisplayRegisterReconfigurationCallback` — a plain C callback, no
//! blocks and no extra crate. Callbacks are delivered on the run loop of the
//! registering thread, so `install` must be called from the main thread
//! (Tauri's `setup` closure qualifies). The callback fires once per display
//! per change, first with the begin flag and again with the result flags; the
//! begin pass is skipped and the frontend debounces the rest.

use tauri::{AppHandle, Emitter};

type CGDirectDisplayID = u32;
type CGDisplayChangeSummaryFlags = u32;

/// kCGDisplayBeginConfigurationFlag — the "about to change" pass.
const BEGIN_CONFIGURATION_FLAG: CGDisplayChangeSummaryFlags = 1;

type ReconfigurationCallback = extern "C" fn(
    display: CGDirectDisplayID,
    flags: CGDisplayChangeSummaryFlags,
    user_info: *mut std::ffi::c_void,
);

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGDisplayRegisterReconfigurationCallback(
        callback: ReconfigurationCallback,
        user_info: *mut std::ffi::c_void,
    ) -> i32;
}

extern "C" fn on_display_reconfigured(
    _display: CGDirectDisplayID,
    flags: CGDisplayChangeSummaryFlags,
    user_info: *mut std::ffi::c_void,
) {
    if flags & BEGIN_CONFIGURATION_FLAG != 0 {
        return;
    }
    // The handle was leaked by `install`, so this reference is always valid.
    let app = unsafe { &*(user_info as *const AppHandle) };
    if let Err(e) = app.emit("monitors-changed", ()) {
        log::warn!("Failed to emit monitors-changed: {}", e);
    }
}

/// Register the watcher. Call once from the main thread; the `AppHandle` is
/// leaked because the callback outlives everything short of the process.
pub fn install(app: AppHandle) {
    let leaked: &'static mut AppHandle = Box::leak(Box::new(app));
    let status = unsafe {
        CGDisplayRegisterReconfigurationCallback(
            on_display_reconfigured,
            leaked as *mut AppHandle as *mut std::ffi::c_void,
        )
    };
    if status != 0 {
        log::warn!("CGDisplayRegisterReconfigurationCallback failed: {}", status);
    }
}
