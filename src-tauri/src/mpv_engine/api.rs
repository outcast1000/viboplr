//! Safe wrapper over the runtime-loaded libmpv (`ffi.rs`).
//!
//! Drop-in replacement for the subset of the `libmpv2` crate the engine used
//! before libmpv became a runtime-loaded component: `Mpv::with_initializer`,
//! typed property get/set, commands, property observation, the event loop,
//! and the OpenGL render context. Semantics deliberately mirror `libmpv2`
//! (e.g. `EndFile` with an error reason surfaces as `Err` from `wait_event`)
//! so the engine's behavioral contract is unchanged. Two deviations, both
//! fixes: FLAG properties use a real `c_int` (not a 1-byte bool slot), and
//! the FBO render param carries the full `mpv_opengl_fbo` layout.

use super::ffi;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::fmt;
use std::marker::PhantomData;
use std::ptr::NonNull;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// libmpv could not be resolved/loaded.
    Load(String),
    /// A string argument contained an interior NUL.
    Null,
    /// mpv returned non-UTF-8 text.
    InvalidUtf8,
    /// A raw mpv error code (`mpv_error`).
    Raw(i32),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Load(msg) => write!(f, "{msg}"),
            Error::Null => write!(f, "string contains an interior NUL"),
            Error::InvalidUtf8 => write!(f, "mpv returned invalid UTF-8"),
            Error::Raw(code) => {
                if let Some(lib) = ffi::loaded() {
                    let cstr = unsafe { CStr::from_ptr((lib.error_string)(*code)) };
                    write!(f, "{} ({code})", cstr.to_string_lossy())
                } else {
                    write!(f, "mpv error {code}")
                }
            }
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

fn mpv_err(code: c_int) -> Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(Error::Raw(code))
    }
}

/// Whether libmpv is currently loadable (loads it on success). The capability
/// probe and the tests' skip guard both go through this.
pub fn libmpv_available() -> bool {
    ffi::libmpv().is_ok()
}

// ---------------------------------------------------------------------------
// Typed property data
// ---------------------------------------------------------------------------

/// Property formats the engine observes with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    String,
    Flag,
    Int64,
    Double,
}

impl Format {
    fn as_mpv_format(self) -> ffi::mpv_format {
        match self {
            Format::String => ffi::MPV_FORMAT_STRING,
            Format::Flag => ffi::MPV_FORMAT_FLAG,
            Format::Int64 => ffi::MPV_FORMAT_INT64,
            Format::Double => ffi::MPV_FORMAT_DOUBLE,
        }
    }
}

/// Types accepted by `set_property`.
pub trait SetData {
    fn set_with(self, f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<()>;
}

impl SetData for f64 {
    fn set_with(mut self, f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<()> {
        f(ffi::MPV_FORMAT_DOUBLE, &mut self as *mut f64 as *mut c_void)
    }
}

impl SetData for i64 {
    fn set_with(mut self, f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<()> {
        f(ffi::MPV_FORMAT_INT64, &mut self as *mut i64 as *mut c_void)
    }
}

impl SetData for bool {
    fn set_with(self, f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<()> {
        let mut flag: c_int = if self { 1 } else { 0 };
        f(ffi::MPV_FORMAT_FLAG, &mut flag as *mut c_int as *mut c_void)
    }
}

impl SetData for &str {
    fn set_with(self, f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<()> {
        let cstr = CString::new(self).map_err(|_| Error::Null)?;
        let mut ptr = cstr.as_ptr();
        f(
            ffi::MPV_FORMAT_STRING,
            &mut ptr as *mut *const c_char as *mut c_void,
        )
    }
}

impl SetData for String {
    fn set_with(self, f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<()> {
        self.as_str().set_with(f)
    }
}

/// Types returned by `get_property`.
pub trait GetData: Sized {
    fn get_with(f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<Self>;
}

impl GetData for f64 {
    fn get_with(f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<Self> {
        let mut val: f64 = 0.0;
        f(ffi::MPV_FORMAT_DOUBLE, &mut val as *mut f64 as *mut c_void)?;
        Ok(val)
    }
}

impl GetData for i64 {
    fn get_with(f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<Self> {
        let mut val: i64 = 0;
        f(ffi::MPV_FORMAT_INT64, &mut val as *mut i64 as *mut c_void)?;
        Ok(val)
    }
}

impl GetData for bool {
    fn get_with(f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<Self> {
        let mut val: c_int = 0;
        f(ffi::MPV_FORMAT_FLAG, &mut val as *mut c_int as *mut c_void)?;
        Ok(val != 0)
    }
}

impl GetData for String {
    fn get_with(f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<Self> {
        let lib = ffi::libmpv().map_err(Error::Load)?;
        let mut ptr: *mut c_char = std::ptr::null_mut();
        f(
            ffi::MPV_FORMAT_STRING,
            &mut ptr as *mut *mut c_char as *mut c_void,
        )?;
        let out = unsafe { CStr::from_ptr(ptr) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| Error::InvalidUtf8);
        unsafe { (lib.free)(ptr as *mut c_void) };
        out
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[allow(non_upper_case_globals)]
pub mod mpv_end_file_reason {
    pub const Eof: u32 = 0;
    pub const Stop: u32 = 2;
    pub const Quit: u32 = 3;
    pub const Error: u32 = 4;
    pub const Redirect: u32 = 5;
}

/// Owned event data — copied out of mpv's per-handle event storage inside
/// `wait_event` (the raw struct is only valid until the next call).
#[derive(Debug)]
pub enum PropertyData {
    Str(String),
    OsdStr(String),
    Flag(bool),
    Int64(i64),
    Double(f64),
}

#[derive(Debug)]
pub enum Event {
    Shutdown,
    StartFile,
    FileLoaded,
    EndFile(u32),
    PropertyChange {
        name: String,
        change: PropertyData,
        #[allow(dead_code)]
        reply_userdata: u64,
    },
    /// Any event kind the engine doesn't consume.
    Other(i32),
}

// ---------------------------------------------------------------------------
// The mpv handle
// ---------------------------------------------------------------------------

pub struct Mpv {
    lib: &'static ffi::LibMpv,
    ctx: NonNull<ffi::mpv_handle>,
}

// The mpv client API is thread-safe; wait_event stays confined to the one
// event thread per deck (same contract libmpv2 relied on).
unsafe impl Send for Mpv {}
unsafe impl Sync for Mpv {}

impl Drop for Mpv {
    fn drop(&mut self) {
        unsafe { (self.lib.destroy)(self.ctx.as_ptr()) };
    }
}

/// Context passed to the `Mpv::with_initializer` closure — property writes
/// that happen before `mpv_initialize`.
pub struct MpvInitializer {
    lib: &'static ffi::LibMpv,
    ctx: *mut ffi::mpv_handle,
}

impl MpvInitializer {
    pub fn set_property<T: SetData>(&self, name: &str, data: T) -> Result<()> {
        set_property_raw(self.lib, self.ctx, name, data)
    }
}

fn set_property_raw<T: SetData>(
    lib: &'static ffi::LibMpv,
    ctx: *mut ffi::mpv_handle,
    name: &str,
    data: T,
) -> Result<()> {
    let cname = CString::new(name).map_err(|_| Error::Null)?;
    data.set_with(|format, ptr| {
        mpv_err(unsafe { (lib.set_property)(ctx, cname.as_ptr(), format, ptr) })
    })
}

impl Mpv {
    /// Create + initialize a handle, with options set by `initializer` before
    /// `mpv_initialize` runs. Loads libmpv on first use.
    pub fn with_initializer<F: FnOnce(&MpvInitializer) -> Result<()>>(
        initializer: F,
    ) -> Result<Mpv> {
        let lib = ffi::libmpv().map_err(Error::Load)?;
        let ctx = unsafe { (lib.create)() };
        let Some(ctx_nn) = NonNull::new(ctx) else {
            return Err(Error::Null);
        };
        let init = MpvInitializer { lib, ctx };
        if let Err(e) = initializer(&init).and_then(|_| mpv_err(unsafe { (lib.initialize)(ctx) }))
        {
            unsafe { (lib.terminate_destroy)(ctx) };
            return Err(e);
        }
        Ok(Mpv { lib, ctx: ctx_nn })
    }

    pub fn set_property<T: SetData>(&self, name: &str, data: T) -> Result<()> {
        set_property_raw(self.lib, self.ctx.as_ptr(), name, data)
    }

    pub fn get_property<T: GetData>(&self, name: &str) -> Result<T> {
        let cname = CString::new(name).map_err(|_| Error::Null)?;
        T::get_with(|format, ptr| {
            mpv_err(unsafe { (self.lib.get_property)(self.ctx.as_ptr(), cname.as_ptr(), format, ptr) })
        })
    }

    /// Send a command with the given arguments (input.conf names).
    pub fn command(&self, name: &str, args: &[&str]) -> Result<()> {
        let mut cstrs: Vec<CString> = Vec::with_capacity(args.len() + 1);
        cstrs.push(CString::new(name).map_err(|_| Error::Null)?);
        for arg in args {
            cstrs.push(CString::new(*arg).map_err(|_| Error::Null)?);
        }
        let mut ptrs: Vec<*const c_char> = cstrs.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        mpv_err(unsafe { (self.lib.command)(self.ctx.as_ptr(), ptrs.as_mut_ptr()) })
    }

    pub fn observe_property(&self, name: &str, format: Format, id: u64) -> Result<()> {
        let cname = CString::new(name).map_err(|_| Error::Null)?;
        mpv_err(unsafe {
            (self.lib.observe_property)(
                self.ctx.as_ptr(),
                id,
                cname.as_ptr(),
                format.as_mpv_format(),
            )
        })
    }

    /// Turn off deprecated events still delivered by default (`MPV_EVENT_IDLE`).
    pub fn disable_deprecated_events(&self) -> Result<()> {
        mpv_err(unsafe { (self.lib.request_event)(self.ctx.as_ptr(), ffi::MPV_EVENT_IDLE, 0) })
    }

    /// Wait up to `timeout` seconds for the next event. `None` means no event
    /// (timeout, or a property change that carried no data). Mirrors libmpv2:
    /// an event-level error — including `EndFile` with an error reason — is
    /// returned as `Some(Err(..))`.
    pub fn wait_event(&self, timeout: f64) -> Option<Result<Event>> {
        let raw = unsafe { &*(self.lib.wait_event)(self.ctx.as_ptr(), timeout) };
        if raw.event_id != ffi::MPV_EVENT_NONE && raw.error != 0 {
            return Some(Err(Error::Raw(raw.error)));
        }
        match raw.event_id {
            ffi::MPV_EVENT_NONE => None,
            ffi::MPV_EVENT_SHUTDOWN => Some(Ok(Event::Shutdown)),
            ffi::MPV_EVENT_START_FILE => Some(Ok(Event::StartFile)),
            ffi::MPV_EVENT_FILE_LOADED => Some(Ok(Event::FileLoaded)),
            ffi::MPV_EVENT_END_FILE => {
                let end = unsafe { &*(raw.data as *const ffi::mpv_event_end_file) };
                if end.error != 0 {
                    Some(Err(Error::Raw(end.error)))
                } else {
                    Some(Ok(Event::EndFile(end.reason as u32)))
                }
            }
            ffi::MPV_EVENT_PROPERTY_CHANGE => {
                let prop = unsafe { &*(raw.data as *const ffi::mpv_event_property) };
                // Format None = the property became unavailable (e.g. EOF
                // while observing) — not an event the engine consumes.
                if prop.format == ffi::MPV_FORMAT_NONE {
                    return None;
                }
                let name = unsafe { CStr::from_ptr(prop.name) };
                let Ok(name) = name.to_str() else {
                    return Some(Err(Error::InvalidUtf8));
                };
                let change = match unsafe { property_data(prop.format, prop.data) } {
                    Ok(change) => change,
                    Err(e) => return Some(Err(e)),
                };
                Some(Ok(Event::PropertyChange {
                    name: name.to_owned(),
                    change,
                    reply_userdata: raw.reply_userdata,
                }))
            }
            other => Some(Ok(Event::Other(other))),
        }
    }

    /// Create an OpenGL render context on this handle. Must be called with
    /// the target GL context current on the calling thread.
    pub fn create_render_context<C: 'static>(
        &self,
        params: Vec<render::RenderParam<C>>,
    ) -> Result<render::RenderContext<'_>> {
        render::create(self, params)
    }
}

/// Copy typed data out of an `mpv_event_property` payload.
unsafe fn property_data(format: ffi::mpv_format, data: *mut c_void) -> Result<PropertyData> {
    match format {
        ffi::MPV_FORMAT_FLAG => Ok(PropertyData::Flag(*(data as *const c_int) != 0)),
        ffi::MPV_FORMAT_INT64 => Ok(PropertyData::Int64(*(data as *const i64))),
        ffi::MPV_FORMAT_DOUBLE => Ok(PropertyData::Double(*(data as *const f64))),
        ffi::MPV_FORMAT_STRING | ffi::MPV_FORMAT_OSD_STRING => {
            let char_ptr = *(data as *const *const c_char);
            let s = CStr::from_ptr(char_ptr)
                .to_str()
                .map_err(|_| Error::InvalidUtf8)?
                .to_owned();
            if format == ffi::MPV_FORMAT_STRING {
                Ok(PropertyData::Str(s))
            } else {
                Ok(PropertyData::OsdStr(s))
            }
        }
        other => Err(Error::Raw(other)),
    }
}

// ---------------------------------------------------------------------------
// Render API (OpenGL)
// ---------------------------------------------------------------------------

pub mod render {
    use super::*;

    /// GL bootstrap for the render context. `get_proc_address` resolves GL
    /// symbols against `ctx` (the engine passes its dlopen'd OpenGL handle).
    pub struct OpenGLInitParams<C: 'static> {
        pub get_proc_address: fn(ctx: &C, name: &str) -> *mut c_void,
        pub ctx: C,
    }

    pub enum RenderParamApiType {
        OpenGl,
    }

    /// Only the two creation params the engine uses.
    pub enum RenderParam<C: 'static> {
        ApiType(RenderParamApiType),
        InitParams(OpenGLInitParams<C>),
    }

    pub struct RenderContext<'a> {
        lib: &'static ffi::LibMpv,
        ctx: *mut ffi::mpv_render_context,
        update_callback_cleanup: Option<Box<dyn FnOnce()>>,
        _marker: PhantomData<&'a Mpv>,
    }

    unsafe impl Send for RenderContext<'_> {}

    unsafe extern "C" fn gpa_wrapper<C: 'static>(
        ctx: *mut c_void,
        name: *const c_char,
    ) -> *mut c_void {
        let params = &*(ctx as *mut OpenGLInitParams<C>);
        let Ok(name) = CStr::from_ptr(name).to_str() else {
            return std::ptr::null_mut();
        };
        (params.get_proc_address)(&params.ctx, name)
    }

    unsafe extern "C" fn update_wrapper<F: Fn() + Send + 'static>(ctx: *mut c_void) {
        (*(ctx as *mut F))();
    }

    pub(super) fn create<C: 'static>(
        mpv: &Mpv,
        params: Vec<RenderParam<C>>,
    ) -> Result<RenderContext<'_>> {
        let lib = mpv.lib;
        let mut raw_params: Vec<ffi::mpv_render_param> = Vec::with_capacity(params.len() + 1);
        for p in params {
            match p {
                RenderParam::ApiType(RenderParamApiType::OpenGl) => {
                    raw_params.push(ffi::mpv_render_param {
                        type_: ffi::MPV_RENDER_PARAM_API_TYPE,
                        data: ffi::MPV_RENDER_API_TYPE_OPENGL.as_ptr() as *mut c_void,
                    });
                }
                RenderParam::InitParams(init) => {
                    // Leaked deliberately: mpv keeps get_proc_address_ctx and
                    // may resolve GL symbols after creation. One render
                    // context exists per app lifetime, so this never grows.
                    let init_ctx = Box::into_raw(Box::new(init)) as *mut c_void;
                    let raw_init = Box::into_raw(Box::new(ffi::mpv_opengl_init_params {
                        get_proc_address: Some(gpa_wrapper::<C>),
                        get_proc_address_ctx: init_ctx,
                    }));
                    raw_params.push(ffi::mpv_render_param {
                        type_: ffi::MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
                        data: raw_init as *mut c_void,
                    });
                }
            }
        }
        raw_params.push(ffi::mpv_render_param {
            type_: ffi::MPV_RENDER_PARAM_INVALID,
            data: std::ptr::null_mut(),
        });

        let mut ctx: *mut ffi::mpv_render_context = std::ptr::null_mut();
        mpv_err(unsafe {
            (lib.render_context_create)(&mut ctx, mpv.ctx.as_ptr(), raw_params.as_mut_ptr())
        })?;
        Ok(RenderContext {
            lib,
            ctx,
            update_callback_cleanup: None,
            _marker: PhantomData,
        })
    }

    impl RenderContext<'_> {
        /// Set the new-frame notification callback. Must not call mpv APIs.
        pub fn set_update_callback<F: Fn() + Send + 'static>(&mut self, callback: F) {
            let raw = Box::into_raw(Box::new(callback));
            unsafe {
                (self.lib.render_context_set_update_callback)(
                    self.ctx,
                    Some(update_wrapper::<F>),
                    raw as *mut c_void,
                );
            }
            if let Some(cleanup) = self.update_callback_cleanup.replace(Box::new(move || {
                drop(unsafe { Box::from_raw(raw) });
            })) {
                cleanup();
            }
        }

        /// Render the current frame into `fbo` at the given pixel size.
        pub fn render(&self, fbo: i32, width: i32, height: i32, flip: bool) -> Result<()> {
            let mut fbo_param = ffi::mpv_opengl_fbo {
                fbo,
                w: width,
                h: height,
                internal_format: 0,
            };
            let mut flip_param: c_int = if flip { 1 } else { 0 };
            let mut raw_params = [
                ffi::mpv_render_param {
                    type_: ffi::MPV_RENDER_PARAM_OPENGL_FBO,
                    data: &mut fbo_param as *mut ffi::mpv_opengl_fbo as *mut c_void,
                },
                ffi::mpv_render_param {
                    type_: ffi::MPV_RENDER_PARAM_FLIP_Y,
                    data: &mut flip_param as *mut c_int as *mut c_void,
                },
                ffi::mpv_render_param {
                    type_: ffi::MPV_RENDER_PARAM_INVALID,
                    data: std::ptr::null_mut(),
                },
            ];
            mpv_err(unsafe { (self.lib.render_context_render)(self.ctx, raw_params.as_mut_ptr()) })
        }
    }

    impl Drop for RenderContext<'_> {
        fn drop(&mut self) {
            unsafe {
                // Detach the callback before freeing its closure.
                (self.lib.render_context_set_update_callback)(self.ctx, None, std::ptr::null_mut());
                (self.lib.render_context_free)(self.ctx);
            }
            if let Some(cleanup) = self.update_callback_cleanup.take() {
                cleanup();
            }
        }
    }
}
