//! Windows native video surface for the mpv engine — `wid` embedding.
//!
//! Unlike the macOS render-API layer, on Windows mpv renders **itself**: we
//! create a disabled child HWND inside the Tauri window, push it to the BOTTOM
//! of the sibling z-order (below WebView2's own child HWND, so the transparent
//! webview + all DOM overlays composite above the video), and hand it to deck 0
//! via mpv's `wid` property with `vo=gpu`. No render thread on our side.
//!
//! Prior art: nini22P/tauri-plugin-libmpv uses exactly this shape and reports
//! Windows fully working. Enabled whenever the mpv engine is selected (PoC);
//! presentation must be bit-blt (`d3d11-flip=no`) — flip-model swapchains in
//! a child of our layered (transparent) top-level window aren't composited.
//!
//! VALIDATION LOGGING: every step logs with a `WINVIDEO:` prefix (visible in
//! the profile log when file logging is on). These logs are temporary scaffolding
//! for the first Windows validation session — remove once validated.

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
    fn SetLayeredWindowAttributes(hwnd: isize, cr_key: u32, b_alpha: u8, dw_flags: u32) -> i32;
}

const WS_CHILD: u32 = 0x4000_0000;
const WS_DISABLED: u32 = 0x0800_0000; // never takes input — clicks go to the webview
const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
const WS_EX_LAYERED: u32 = 0x0008_0000; // DWM-composited child (Win8+) — VIBOPLR_WIN_VIDEO_LAYERED=1
const LWA_ALPHA: u32 = 0x0000_0002;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_NOZORDER: u32 = 0x0004;
const HWND_BOTTOM: isize = 1;
const SW_HIDE: i32 = 0;
const SW_SHOWNA: i32 = 8; // show without activating
const BLACK_BRUSH: i32 = 4;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub struct VideoLayer {
    hwnd: isize,
    /// False in `mainwindow` wid mode: `hwnd` is the Tauri main window itself
    /// (mpv creates + owns its own render child), so we don't position or
    /// hide it — bounds/visibility are no-ops.
    owns_child: bool,
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

        // Validation scaffolding: VIBOPLR_WIN_WID_MODE=mainwindow hands mpv the
        // MAIN window HWND as wid (exact prior-art parity — mpv creates its own
        // render child, which may composite where our child doesn't). mpv then
        // fills the whole window, so bounds/visibility are no-ops and the UI is
        // hidden — this is purely a "does native video composite at all" probe.
        if std::env::var("VIBOPLR_WIN_WID_MODE").is_ok_and(|v| v == "mainwindow") {
            log::info!(
                "WINVIDEO: WID MODE mainwindow — handing MAIN window hwnd={parent:#x} to mpv (no child; bounds/visibility no-op; UI will be hidden)"
            );
            return Ok(VideoLayer { hwnd: parent, owns_child: false, app: app.clone() });
        }

        log::info!("WINVIDEO: creating child window, parent hwnd={parent:#x}");

        let (tx, rx) = mpsc::channel::<Result<isize, String>>();
        app.run_on_main_thread(move || {
            let _ = tx.send(unsafe { create_child_window(parent) });
        })
        .map_err(|e| format!("failed to reach main thread: {e}"))?;
        let hwnd = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "timed out creating the video child window".to_string())??;

        log::info!("WINVIDEO: child window created, hwnd={hwnd:#x} (hidden, bottom of z-order)");
        Ok(VideoLayer { hwnd, owns_child: true, app: app.clone() })
    }

    /// The window handle mpv renders into (`wid` property).
    pub fn wid(&self) -> i64 {
        self.hwnd as i64
    }

    /// Position the layer. `x`/`y`/`width`/`height` arrive in logical points
    /// (frontend pre-multiplies its zoom factor); Win32 child coordinates are
    /// physical pixels, so scale by the window's scale factor here.
    pub fn set_bounds(&self, x: f64, y: f64, width: f64, height: f64) {
        if !self.owns_child {
            return; // mainwindow wid mode — mpv fills the window itself
        }
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
            log::error!("WINVIDEO: SetWindowPos failed (err={err}) hwnd={:#x}", self.hwnd);
        } else {
            log::info!(
                "WINVIDEO: bounds logical=({x:.0},{y:.0} {width:.0}x{height:.0}) scale={scale} physical=({px},{py} {pw}x{ph})"
            );
        }
    }

    pub fn set_visible(&self, visible: bool) {
        if !self.owns_child {
            return; // mainwindow wid mode — never hide the app's own window
        }
        unsafe {
            ShowWindow(self.hwnd, if visible { SW_SHOWNA } else { SW_HIDE });
        }
        log::info!("WINVIDEO: set_visible({visible}) hwnd={:#x}", self.hwnd);
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
        log::info!("WINVIDEO: window class already registered");
    } else {
        log::info!("WINVIDEO: window class registered (atom={atom})");
    }

    // Validation scaffolding: VIBOPLR_WIN_VIDEO_LAYERED=1 adds WS_EX_LAYERED.
    // A layered child window (Win8+) is composited directly by DWM as its own
    // surface, bypassing the parent's redirection bitmap — the redirection
    // path is where every non-layered present model failed to show. Pair with
    // bit-blt (the default; don't set d3d11-flip in VIBOPLR_MPV_OPTS): flip
    // swapchains don't present into layered windows.
    let layered = std::env::var("VIBOPLR_WIN_VIDEO_LAYERED").is_ok_and(|v| v == "1");
    let ex_style = if layered { WS_EX_LAYERED } else { 0 };
    let hwnd = unsafe {
        CreateWindowExW(
            ex_style,
            class_name.as_ptr(),
            std::ptr::null(),
            WS_CHILD | WS_DISABLED | WS_CLIPSIBLINGS,
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
    if layered {
        // Fully opaque; DWM then composites the child's rendered pixels.
        let ok = unsafe { SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA) };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            log::error!("WINVIDEO: SetLayeredWindowAttributes failed (err={err})");
        } else {
            log::info!("WINVIDEO: child is WS_EX_LAYERED, opaque alpha (VIBOPLR_WIN_VIDEO_LAYERED=1)");
        }
    }

    // Validation scaffolding: VIBOPLR_WIN_VIDEO_ZORDER=top leaves the child at
    // the TOP of the sibling stack (where a freshly created window lands, and
    // where mpv's own wid-created child sits in the working prior art) — DOM
    // can't overlay the video there, but it bisects whether the child's
    // content composites at all. Default: bottom, below WebView2's child
    // HWND, so the transparent webview (and all DOM overlays) composite
    // above the video.
    let zorder = std::env::var("VIBOPLR_WIN_VIDEO_ZORDER").unwrap_or_default();
    if zorder == "top" {
        log::info!("WINVIDEO: leaving child at TOP of sibling z-order (VIBOPLR_WIN_VIDEO_ZORDER=top)");
    } else {
        let ok = unsafe { SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 1, 1, SWP_NOACTIVATE) };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            log::error!("WINVIDEO: initial HWND_BOTTOM SetWindowPos failed (err={err})");
        }
    }
    Ok(hwnd)
}
