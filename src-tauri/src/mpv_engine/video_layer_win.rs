//! Windows native video surface for the mpv engine — `wid` embedding.
//!
//! Unlike the macOS render-API layer, on Windows mpv renders **itself**: we
//! create a child HWND inside the Tauri window, position it over the video
//! container, and hand it to deck 0 via mpv's `wid` property (`vo=gpu`). No
//! render thread on our side.
//!
//! The child must mirror mpv's own embedded window to composite behind the
//! transparent (DWM blur-behind glass) main window: bare `WS_CHILD |
//! WS_VISIBLE` at the top of the sibling z-order. A disabled / clip-siblings /
//! bottom-z child never joined the composition (mpv nests its render window
//! inside ours; the middle layer stayed invisible). WebView2 composites its
//! own content above the child via DirectComposition, so the video shows
//! through the CSS hole, DOM overlays draw on top, and input reaches the
//! webview — no `WS_EX_TRANSPARENT` needed. Present model is mpv's default
//! (flip); a `d3d11-flip` entry in `VIBOPLR_MPV_OPTS` overrides.

use std::ffi::c_void;
use std::sync::mpsc;
use std::time::Duration;
use tauri::Manager;

#[repr(C)]
struct WndClassW {
    style: u32,
    lpfn_wnd_proc: Option<
        unsafe extern "system" fn(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize,
    >,
    cb_cls_extra: i32,
    cb_wnd_extra: i32,
    h_instance: isize,
    h_icon: isize,
    h_cursor: isize,
    hbr_background: isize,
    lpsz_menu_name: *const u16,
    lpsz_class_name: *const u16,
}

unsafe extern "system" {
    fn RegisterClassW(lp_wnd_class: *const WndClassW) -> u16;
    fn CreateWindowExW(
        dw_ex_style: u32,
        lp_class_name: *const u16,
        lp_window_name: *const u16,
        dw_style: u32,
        x: i32,
        y: i32,
        n_width: i32,
        n_height: i32,
        h_wnd_parent: isize,
        h_menu: isize,
        h_instance: isize,
        lp_param: *const c_void,
    ) -> isize;
    fn DefWindowProcW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn SetWindowPos(
        hwnd: isize,
        hwnd_insert_after: isize,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    fn ShowWindow(hwnd: isize, n_cmd_show: i32) -> i32;
    fn GetModuleHandleW(lp_module_name: *const u16) -> isize;
    fn GetStockObject(i: i32) -> isize;
    fn GetLastError() -> u32;
}

const WS_CHILD: u32 = 0x4000_0000;
const WS_VISIBLE: u32 = 0x1000_0000; // mpv's own embedded child is WS_CHILD | WS_VISIBLE
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_NOZORDER: u32 = 0x0004;
const SW_HIDE: i32 = 0;
const SW_SHOWNA: i32 = 8; // show without activating
const BLACK_BRUSH: i32 = 4;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub struct VideoLayer {
    hwnd: isize,
    app: tauri::AppHandle,
}

// The HWND is only touched via thread-safe Win32 calls (SetWindowPos/ShowWindow
// post to the owning thread's queue).
unsafe impl Send for VideoLayer {}
unsafe impl Sync for VideoLayer {}

impl VideoLayer {
    /// Create the child window on the main thread (the creating thread owns a
    /// Win32 window and must pump its messages — tao's loop does).
    pub fn create(app: &tauri::AppHandle) -> Result<Self, String> {
        let window = app
            .get_webview_window("main")
            .ok_or("main window not found")?;
        let parent = window.hwnd().map_err(|e| e.to_string())?.0 as isize;

        let (tx, rx) = mpsc::channel::<Result<isize, String>>();
        app.run_on_main_thread(move || {
            let _ = tx.send(unsafe { create_child_window(parent) });
        })
        .map_err(|e| format!("failed to reach main thread: {e}"))?;
        let hwnd = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "timed out creating the video child window".to_string())??;

        log::debug!("mpv-engine: video child window created (hwnd={hwnd:#x})");
        Ok(VideoLayer { hwnd, app: app.clone() })
    }

    /// The window handle mpv renders into (`wid` property).
    pub fn wid(&self) -> i64 {
        self.hwnd as i64
    }

    /// Position the layer. `x`/`y`/`width`/`height` arrive in logical points
    /// (frontend pre-multiplies its zoom factor); Win32 child coordinates are
    /// physical pixels, so scale by the window's scale factor here.
    pub fn set_bounds(&self, x: f64, y: f64, width: f64, height: f64) {
        let scale = self
            .app
            .get_webview_window("main")
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0);
        let px = (x * scale).round() as i32;
        let py = (y * scale).round() as i32;
        let pw = ((width * scale).round() as i32).max(1);
        let ph = ((height * scale).round() as i32).max(1);
        let ok = unsafe {
            SetWindowPos(self.hwnd, 0, px, py, pw, ph, SWP_NOACTIVATE | SWP_NOZORDER)
        };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            log::error!("mpv-engine: video SetWindowPos failed (err={err})");
        }
    }

    pub fn set_visible(&self, visible: bool) {
        unsafe {
            ShowWindow(self.hwnd, if visible { SW_SHOWNA } else { SW_HIDE });
        }
    }
}

unsafe fn create_child_window(parent: isize) -> Result<isize, String> {
    let class_name = wide("viboplr-mpv-video");
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };

    let class = WndClassW {
        style: 0,
        lpfn_wnd_proc: Some(DefWindowProcW),
        cb_cls_extra: 0,
        cb_wnd_extra: 0,
        h_instance: instance,
        h_icon: 0,
        h_cursor: 0,
        hbr_background: unsafe { GetStockObject(BLACK_BRUSH) },
        lpsz_menu_name: std::ptr::null(),
        lpsz_class_name: class_name.as_ptr(),
    };
    let atom = unsafe { RegisterClassW(&class) };
    if atom == 0 {
        let err = unsafe { GetLastError() };
        // 1410 = ERROR_CLASS_ALREADY_EXISTS — fine on re-entry, fatal otherwise.
        if err != 1410 {
            return Err(format!("RegisterClassW failed (err={err})"));
        }
    }

    // Bare WS_CHILD | WS_VISIBLE at the top of the sibling z-order — mpv's own
    // embedded-window shape, the one that composites behind the transparent
    // main window (see module docs).
    let hwnd = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            std::ptr::null(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            1,
            1,
            parent,
            0,
            instance,
            std::ptr::null(),
        )
    };
    if hwnd == 0 {
        let err = unsafe { GetLastError() };
        return Err(format!("CreateWindowExW failed (err={err})"));
    }
    Ok(hwnd)
}
