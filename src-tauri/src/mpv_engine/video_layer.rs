//! macOS native video surface for the mpv engine.
//!
//! An `NSView` + `NSOpenGLContext` is inserted into the main window's content
//! view BELOW the WKWebView (the window is `transparent: true` and the
//! frontend punches a CSS hole over the video rect), and a dedicated render
//! thread drives `mpv_render_context_render` into the view's default
//! framebuffer whenever mpv signals a new frame. This is the render-API
//! pattern (IINA-style) — `--wid` embedding is unreliable on macOS.
//!
//! Threading: AppKit view work (create / setFrame / setHidden / insertion)
//! happens on the main thread via `AppHandle::run_on_main_thread`; all GL work
//! (context-current, render, flush, `[ctx update]` on resize) happens on the
//! render thread, serialized against AppKit's own use via `CGLLockContext`.
//! The `RenderContext` borrows the deck's `Mpv`, so the render thread owns it
//! outright — it is created inside the thread, which holds an `Arc<Engine>`
//! keeping the borrow valid for the thread's lifetime (see `Engine::
//! ensure_video_layer`).

use cocoa::base::{id, nil, NO, YES};
use cocoa::foundation::{NSPoint, NSRect, NSSize};
use objc::{class, msg_send, sel, sel_impl};
use std::ffi::{c_char, c_int, c_void, CString};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::Manager;

#[link(name = "OpenGL", kind = "framework")]
extern "C" {
    fn CGLLockContext(ctx: *mut c_void) -> i32;
    fn CGLUnlockContext(ctx: *mut c_void) -> i32;
    fn CGLSetCurrentContext(ctx: *mut c_void) -> i32;
}

extern "C" {
    fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

// NSOpenGLPixelFormat attribute constants (NSOpenGL.h).
const NSOPENGL_PFA_DOUBLE_BUFFER: u32 = 5;
const NSOPENGL_PFA_ACCELERATED: u32 = 73;
const NSOPENGL_PFA_OPENGL_PROFILE: u32 = 99;
const NSOPENGL_PROFILE_VERSION_3_2_CORE: u32 = 0x3200;
const NSOPENGL_CP_SWAP_INTERVAL: i32 = 222;
/// NSWindowOrderingMode: below all sibling views.
const NSWINDOW_BELOW: isize = -1;

/// The OpenGL framework handle `get_proc_address` resolves symbols from.
pub struct GlLibrary(*mut c_void);
unsafe impl Send for GlLibrary {}

pub fn get_proc_address(lib: &GlLibrary, name: &str) -> *mut c_void {
    let Ok(cname) = CString::new(name) else {
        return std::ptr::null_mut();
    };
    unsafe { dlsym(lib.0, cname.as_ptr()) }
}

/// Make the layer's GL context current on the calling thread (the render
/// thread does this once before creating the mpv render context).
pub fn make_context_current(cgl: usize) {
    unsafe {
        CGLSetCurrentContext(cgl as *mut c_void);
    }
}

pub fn open_gl_library() -> Result<GlLibrary, String> {
    const PATH: &[u8] = b"/System/Library/Frameworks/OpenGL.framework/Versions/Current/OpenGL\0";
    let handle = unsafe { dlopen(PATH.as_ptr() as *const c_char, 1 /* RTLD_LAZY */) };
    if handle.is_null() {
        return Err("failed to dlopen the OpenGL framework".into());
    }
    Ok(GlLibrary(handle))
}

/// Raw AppKit pointers, created and mutated only on the main thread; the
/// render thread touches GL exclusively through the CGL context object.
#[derive(Clone, Copy)]
struct NativePtrs {
    view: usize,
    glctx: usize,
    cgl: usize,
}
unsafe impl Send for NativePtrs {}

#[derive(Default)]
pub struct RenderState {
    /// Drawable size in PIXELS (points × backing scale).
    width: i32,
    height: i32,
    /// mpv reported a new frame.
    frame_pending: bool,
    shutdown: bool,
}

pub struct VideoLayer {
    ptrs: NativePtrs,
    state: Arc<(Mutex<RenderState>, Condvar)>,
    app: tauri::AppHandle,
}

impl VideoLayer {
    /// Create the NSView + GL context on the main thread and insert the view
    /// below the webview. Blocks (with timeout) until the main thread ran.
    pub fn create(app: &tauri::AppHandle) -> Result<Self, String> {
        let window = app
            .get_webview_window("main")
            .ok_or("main window not found")?;
        let ns_window = window.ns_window().map_err(|e| e.to_string())? as usize;

        let (tx, rx) = mpsc::channel::<Result<NativePtrs, String>>();
        app.run_on_main_thread(move || {
            let _ = tx.send(unsafe { create_native_layer(ns_window) });
        })
        .map_err(|e| format!("failed to reach main thread: {e}"))?;
        let ptrs = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "timed out creating the video layer on the main thread".to_string())??;

        Ok(VideoLayer {
            ptrs,
            state: Arc::new((Mutex::new(RenderState::default()), Condvar::new())),
            app: app.clone(),
        })
    }

    /// Position the layer. `x`/`y` are top-left-origin points within the
    /// window's content view (the webview fills it, so webview coordinates ×
    /// zoom factor map 1:1 — the frontend pre-multiplies zoom).
    pub fn set_bounds(&self, x: f64, y: f64, width: f64, height: f64) {
        let ptrs = self.ptrs;
        let state = self.state.clone();
        let run = self.app.run_on_main_thread(move || unsafe {
            let view = ptrs.view as id;
            let superview: id = msg_send![view, superview];
            if superview == nil {
                return;
            }
            let bounds: NSRect = msg_send![superview, bounds];
            let frame = NSRect::new(
                NSPoint::new(x, bounds.size.height - y - height),
                NSSize::new(width.max(1.0), height.max(1.0)),
            );
            let _: () = msg_send![view, setFrame: frame];
            let win: id = msg_send![view, window];
            let scale: f64 = if win != nil {
                msg_send![win, backingScaleFactor]
            } else {
                1.0
            };
            // `-[NSOpenGLContext update]` must run on the MAIN thread (it traps
            // off-main on modern AppKit); serialize against the render thread
            // via the CGL lock.
            CGLLockContext(ptrs.cgl as *mut c_void);
            let ctx = ptrs.glctx as id;
            let _: () = msg_send![ctx, update];
            CGLUnlockContext(ptrs.cgl as *mut c_void);
            let (lock, cv) = &*state;
            let mut st = lock.lock().unwrap();
            st.width = (width.max(1.0) * scale) as i32;
            st.height = (height.max(1.0) * scale) as i32;
            st.frame_pending = true; // repaint at the new size
            cv.notify_one();
        });
        if let Err(e) = run {
            log::error!("mpv-engine: set_bounds main-thread dispatch failed: {e}");
        }
    }

    pub fn set_visible(&self, visible: bool) {
        let ptrs = self.ptrs;
        let run = self.app.run_on_main_thread(move || unsafe {
            let view = ptrs.view as id;
            let _: () = msg_send![view, setHidden: if visible { NO } else { YES }];
        });
        if let Err(e) = run {
            log::error!("mpv-engine: set_visible main-thread dispatch failed: {e}");
        }
    }

    pub fn cgl_context(&self) -> usize {
        self.ptrs.cgl
    }

    pub fn glctx(&self) -> usize {
        self.ptrs.glctx
    }

    pub fn render_state(&self) -> Arc<(Mutex<RenderState>, Condvar)> {
        self.state.clone()
    }

    /// Wake the render thread with a new-frame signal (mpv update callback).
    pub fn signal_frame(state: &Arc<(Mutex<RenderState>, Condvar)>) {
        let (lock, cv) = &**state;
        if let Ok(mut st) = lock.lock() {
            st.frame_pending = true;
            cv.notify_one();
        }
    }
}

unsafe fn create_native_layer(ns_window: usize) -> Result<NativePtrs, String> {
    let ns_window = ns_window as id;
    let content_view: id = msg_send![ns_window, contentView];
    if content_view == nil {
        return Err("window has no content view".into());
    }

    let attrs: [u32; 6] = [
        NSOPENGL_PFA_OPENGL_PROFILE,
        NSOPENGL_PROFILE_VERSION_3_2_CORE,
        NSOPENGL_PFA_DOUBLE_BUFFER,
        NSOPENGL_PFA_ACCELERATED,
        0,
        0,
    ];
    let pixfmt: id = msg_send![class!(NSOpenGLPixelFormat), alloc];
    let pixfmt: id = msg_send![pixfmt, initWithAttributes: attrs.as_ptr()];
    if pixfmt == nil {
        return Err("failed to create NSOpenGLPixelFormat".into());
    }
    let glctx: id = msg_send![class!(NSOpenGLContext), alloc];
    let glctx: id = msg_send![glctx, initWithFormat: pixfmt shareContext: nil];
    if glctx == nil {
        return Err("failed to create NSOpenGLContext".into());
    }

    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0));
    let view: id = msg_send![class!(NSView), alloc];
    let view: id = msg_send![view, initWithFrame: frame];
    let _: () = msg_send![view, setWantsBestResolutionOpenGLSurface: YES];
    let _: () = msg_send![view, setHidden: YES];
    let _: () = msg_send![content_view, addSubview: view positioned: NSWINDOW_BELOW relativeTo: nil];
    let _: () = msg_send![glctx, setView: view];
    let swap: i32 = 1; // vsync
    let _: () = msg_send![glctx, setValues: &swap forParameter: NSOPENGL_CP_SWAP_INTERVAL];
    let cgl: *mut c_void = msg_send![glctx, CGLContextObj];
    if cgl.is_null() {
        return Err("NSOpenGLContext has no CGL context".into());
    }

    Ok(NativePtrs {
        view: view as usize,
        glctx: glctx as usize,
        cgl: cgl as usize,
    })
}

/// Body of the render thread. `render` draws one mpv frame at the given pixel
/// size into FBO 0; this loop owns making the context current, resize
/// (`[ctx update]`), vsync'd flushes, and CGL locking.
pub fn run_render_loop(
    state: Arc<(Mutex<RenderState>, Condvar)>,
    glctx: usize,
    cgl: usize,
    mut render: impl FnMut(i32, i32) -> Result<(), String>,
) {
    unsafe {
        CGLSetCurrentContext(cgl as *mut c_void);
    }
    loop {
        let (width, height) = {
            let (lock, cv) = &*state;
            let mut st = lock.lock().unwrap();
            loop {
                if st.shutdown {
                    return;
                }
                if st.frame_pending {
                    break;
                }
                let (guard, _timeout) = cv.wait_timeout(st, Duration::from_millis(250)).unwrap();
                st = guard;
            }
            st.frame_pending = false;
            (st.width.max(1), st.height.max(1))
        };

        unsafe {
            CGLLockContext(cgl as *mut c_void);
        }
        if let Err(e) = render(width, height) {
            log::error!("mpv-engine: video render failed: {e}");
        }
        unsafe {
            let ctx = glctx as id;
            let _: () = msg_send![ctx, flushBuffer];
            CGLUnlockContext(cgl as *mut c_void);
        }
    }
}
