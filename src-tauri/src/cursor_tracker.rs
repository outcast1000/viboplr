#![allow(deprecated)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use cocoa::appkit::NSWindow;
use cocoa::base::id;
use cocoa::foundation::NSPoint;
use objc::{class, msg_send, sel, sel_impl};
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

        let window = match app_handle.get_webview_window("main") {
            Some(w) => w,
            None => continue,
        };

        let inside = unsafe {
            #[allow(deprecated)]
            let ns_win = match window.ns_window() {
                Ok(ptr) => ptr as id,
                Err(_) => {
                    continue;
                }
            };
            let frame = NSWindow::frame(ns_win);
            let mouse_loc: NSPoint = msg_send![class!(NSEvent), mouseLocation];
            mouse_loc.x >= frame.origin.x
                && mouse_loc.x <= frame.origin.x + frame.size.width
                && mouse_loc.y >= frame.origin.y
                && mouse_loc.y <= frame.origin.y + frame.size.height
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
