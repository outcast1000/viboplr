use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use objc2_app_kit::{NSEvent, NSWindow};
use tauri::{AppHandle, Emitter, Manager};

const POLL_INTERVAL: Duration = Duration::from_millis(100);

pub fn run(active: Arc<AtomicBool>, app_handle: AppHandle) {
    let mut cursor_inside = false;

    loop {
        thread::sleep(POLL_INTERVAL);

        if !active.load(Ordering::Relaxed) {
            if cursor_inside {
                cursor_inside = false;
                let _ = app_handle.emit("mini-cursor-left", ());
            }
            continue;
        }

        let Some(inside) = cursor_in_main_window(&app_handle) else {
            continue;
        };

        if inside && !cursor_inside {
            cursor_inside = true;
            let _ = app_handle.emit("mini-cursor-entered", ());
        } else if !inside && cursor_inside {
            cursor_inside = false;
            let _ = app_handle.emit("mini-cursor-left", ());
        }
    }
}

/// Is the cursor over the main window? Compared in Cocoa points, where the
/// cursor and the frame share one coordinate space on every display.
/// (Tauri's `cursor_position()` scales by the *primary* monitor and
/// `outer_position()` by the *window's*, so on a Retina laptop with a 1×
/// external display the two disagree.) `NSWindow` is main-thread only, so the
/// read runs there; `None` when the window or the main thread can't answer.
fn cursor_in_main_window(app_handle: &AppHandle) -> Option<bool> {
    let window = app_handle.get_webview_window("main")?;
    let ns_window = window.ns_window().ok()? as usize;
    let (tx, rx) = mpsc::channel();
    app_handle
        .run_on_main_thread(move || {
            // SAFETY: tao owns this NSWindow for the app's lifetime, and we are
            // on the main thread, which is the only place it may be touched.
            let ns_window = unsafe { &*(ns_window as *const NSWindow) };
            let frame = ns_window.frame();
            let mouse = NSEvent::mouseLocation();
            let _ = tx.send(
                mouse.x >= frame.origin.x
                    && mouse.x <= frame.origin.x + frame.size.width
                    && mouse.y >= frame.origin.y
                    && mouse.y <= frame.origin.y + frame.size.height,
            );
        })
        .ok()?;
    rx.recv_timeout(Duration::from_secs(1)).ok()
}
