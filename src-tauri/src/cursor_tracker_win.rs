use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

const POLL_INTERVAL: Duration = Duration::from_millis(100);

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

unsafe extern "system" {
    fn GetCursorPos(lp_point: *mut Point) -> i32;
    fn GetWindowRect(h_wnd: isize, lp_rect: *mut Rect) -> i32;
}

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

        let hwnd = match window.hwnd() {
            Ok(h) => h.0 as isize,
            Err(_) => continue,
        };

        let inside = unsafe {
            let mut cursor = Point { x: 0, y: 0 };
            let mut rect = Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetCursorPos(&mut cursor) == 0 || GetWindowRect(hwnd, &mut rect) == 0 {
                continue;
            }
            cursor.x >= rect.left
                && cursor.x < rect.right
                && cursor.y >= rect.top
                && cursor.y < rect.bottom
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
