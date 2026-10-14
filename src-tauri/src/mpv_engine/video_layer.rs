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

//!
//! Apple deprecated OpenGL in macOS 10.14 and `objc2-app-kit` marks every
//! NSOpenGL item accordingly; mpv's render API still needs a GL context, so
//! the functions that touch one carry a scoped `#[allow(deprecated)]`.

use objc2::encode::{Encoding, RefEncode};
use objc2::{msg_send, AllocAnyThread, MainThreadMarker, MainThreadOnly};
#[allow(deprecated)] // NSOpenGL* — see the module doc.
use objc2_app_kit::{
    NSOpenGLContext, NSOpenGLContextParameter, NSOpenGLPixelFormat, NSView, NSWindow,
    NSWindowOrderingMode,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use std::ffi::{c_char, c_int, c_void, CString};
use std::ptr::NonNull;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
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

/// Opaque `CGLContextObject`, only ever handled by pointer. Declared with its
/// real encoding because objc2 checks a message's return type against the
/// method's in debug builds, and `void *` does not match
/// `^{_CGLContextObject=}`. (The typed `CGLContextObj()` binding needs the
/// `objc2-open-gl` crate, which nothing else here uses.)
#[repr(C)]
struct CGLContextObject {
    _private: [u8; 0],
}

unsafe impl RefEncode for CGLContextObject {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("_CGLContextObject", &[]));
}

/// The layer's view. `ptr` comes from `Retained::into_raw` in
/// `create_native_layer` and is never released, so it lives for the app's
/// lifetime. Main thread only.
unsafe fn view_at<'a>(ptr: usize) -> &'a NSView {
    &*(ptr as *const NSView)
}

/// The layer's GL context; same lifetime rule as `view_at`.
#[allow(deprecated)]
unsafe fn glctx_at<'a>(ptr: usize) -> &'a NSOpenGLContext {
    &*(ptr as *const NSOpenGLContext)
}

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
    /// Bumped by `set_bounds` when it needs a synchronous repaint at a new
    /// size; the render loop stores the serial it painted into
    /// `rendered_serial`, letting the resize path block until the surface
    /// actually holds content at the new size (see `set_bounds`).
    resize_serial: u64,
    rendered_serial: u64,
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
        #[allow(deprecated)] // NSOpenGLContext::update — see the module doc.
        let run = self.app.run_on_main_thread(move || unsafe {
            let Some(mtm) = MainThreadMarker::new() else {
                log::error!("mpv-engine: set_bounds ran off the main thread");
                return;
            };
            let view = view_at(ptrs.view);
            let Some(superview) = view.superview() else {
                return;
            };
            let bounds = superview.bounds();
            let frame = NSRect::new(
                NSPoint::new(x, bounds.size.height - y - height),
                NSSize::new(width.max(1.0), height.max(1.0)),
            );
            view.setFrame(frame);
            let scale = view.window().map_or(1.0, |win| win.backingScaleFactor());
            // `-[NSOpenGLContext update]` must run on the MAIN thread (it traps
            // off-main on modern AppKit — the binding takes a MainThreadMarker
            // for that reason); serialize against the render thread via the
            // CGL lock.
            CGLLockContext(ptrs.cgl as *mut c_void);
            glctx_at(ptrs.glctx).update(mtm);
            CGLUnlockContext(ptrs.cgl as *mut c_void);
            let (lock, cv) = &*state;
            let mut st = lock.lock().unwrap();
            st.width = (width.max(1.0) * scale) as i32;
            st.height = (height.max(1.0) * scale) as i32;
            st.frame_pending = true; // repaint at the new size
            st.resize_serial += 1;
            let want = st.resize_serial;
            cv.notify_all();
            // Block (briefly) until the render thread has drawn + flushed at
            // the NEW size. `[ctx update]` just reallocated the GL surface, so
            // it's momentarily black; AppKit composites the layer right after
            // this main-thread block returns, and the surface shows through a
            // transparent CSS hole — so returning before the repaint lands is
            // exactly what flashes black during a live window resize. Gating
            // here keeps a content-filled surface under the compositor. The
            // timeout means a stalled render can never hang the resize loop —
            // worst case degrades to the old behavior (a single flash).
            let deadline = Instant::now() + Duration::from_millis(120);
            while st.rendered_serial < want {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                let (guard, timeout) = cv.wait_timeout(st, remaining).unwrap();
                st = guard;
                if timeout.timed_out() {
                    break;
                }
            }
        });
        if let Err(e) = run {
            log::error!("mpv-engine: set_bounds main-thread dispatch failed: {e}");
        }
    }

    pub fn set_visible(&self, visible: bool) {
        let ptrs = self.ptrs;
        let run = self.app.run_on_main_thread(move || unsafe {
            view_at(ptrs.view).setHidden(!visible);
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
    /// `notify_all` (not `notify_one`) because `set_bounds` also parks on this
    /// condvar during the resize handshake — a lone wakeup could rouse that
    /// waiter and leave the render thread asleep on the pending frame.
    pub fn signal_frame(state: &Arc<(Mutex<RenderState>, Condvar)>) {
        let (lock, cv) = &**state;
        if let Ok(mut st) = lock.lock() {
            st.frame_pending = true;
            cv.notify_all();
        }
    }
}

#[allow(deprecated)] // NSOpenGL* — see the module doc.
unsafe fn create_native_layer(ns_window: usize) -> Result<NativePtrs, String> {
    let mtm = MainThreadMarker::new().ok_or("the video layer must be created on the main thread")?;
    let ns_window = &*(ns_window as *const NSWindow);
    let content_view = ns_window.contentView().ok_or("window has no content view")?;

    let attrs: [u32; 6] = [
        NSOPENGL_PFA_OPENGL_PROFILE,
        NSOPENGL_PROFILE_VERSION_3_2_CORE,
        NSOPENGL_PFA_DOUBLE_BUFFER,
        NSOPENGL_PFA_ACCELERATED,
        0,
        0,
    ];
    let pixfmt = NSOpenGLPixelFormat::initWithAttributes(
        NSOpenGLPixelFormat::alloc(),
        NonNull::from(&attrs).cast(),
    )
    .ok_or("failed to create NSOpenGLPixelFormat")?;
    // The context retains its pixel format, so `pixfmt` is released on return.
    let glctx = NSOpenGLContext::initWithFormat_shareContext(NSOpenGLContext::alloc(), &pixfmt, None)
        .ok_or("failed to create NSOpenGLContext")?;

    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0));
    let view = NSView::initWithFrame(NSView::alloc(mtm), frame);
    view.setWantsBestResolutionOpenGLSurface(true);
    view.setHidden(true);
    content_view.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, None);
    glctx.setView(Some(&view), mtm);
    // vsync. The parameter is an NSInteger: passing a bare `i32` here (as the
    // cocoa-era code did) leaves the upper half of the register unspecified
    // on arm64, so the swap interval could silently go unset.
    let swap: i32 = 1;
    let _: () = msg_send![
        &*glctx,
        setValues: &swap as *const i32,
        forParameter: NSOpenGLContextParameter::SwapInterval
    ];
    let cgl: *mut CGLContextObject = msg_send![&*glctx, CGLContextObj];
    if cgl.is_null() {
        return Err("NSOpenGLContext has no CGL context".into());
    }

    // Both live for the app's lifetime, as before: the view stays in the
    // window's hierarchy and the render thread addresses the context by
    // pointer (`view_at` / `glctx_at`), so hand our references over for good.
    Ok(NativePtrs {
        view: objc2::rc::Retained::into_raw(view) as usize,
        glctx: objc2::rc::Retained::into_raw(glctx) as usize,
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
    report_swap: impl Fn(),
) {
    unsafe {
        CGLSetCurrentContext(cgl as *mut c_void);
    }
    loop {
        let (width, height, serial) = {
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
            (st.width.max(1), st.height.max(1), st.resize_serial)
        };

        unsafe {
            CGLLockContext(cgl as *mut c_void);
        }
        if let Err(e) = render(width, height) {
            log::error!("mpv-engine: video render failed: {e}");
        }
        // `flushBuffer` is safe off the main thread (unlike `update`, its
        // binding takes no MainThreadMarker).
        #[allow(deprecated)]
        unsafe {
            glctx_at(glctx).flushBuffer();
            CGLUnlockContext(cgl as *mut c_void);
        }
        // The swap (flushBuffer, vsync'd) is done — tell mpv when it landed so
        // its audio-mastered A/V sync accounts for the display-pipeline latency
        // (otherwise video trails audio). Touches no GL, so it's outside the lock.
        report_swap();

        // Ack the resize serial we just presented so a `set_bounds` caller
        // blocked in the resize handshake can return now that the surface
        // holds content at the new size.
        let (lock, cv) = &*state;
        let mut st = lock.lock().unwrap();
        if serial > st.rendered_serial {
            st.rendered_serial = serial;
            cv.notify_all();
        }
    }
}
