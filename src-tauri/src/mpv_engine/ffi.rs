//! Runtime loader + raw FFI surface for libmpv.
//!
//! libmpv is NOT linked at build time — it is resolved and loaded once at
//! runtime (dlopen / LoadLibraryW), so every build carries the engine and the
//! library itself can come from the bundled Frameworks dir (Full build), the
//! managed engine-component dir (downloaded on demand, see `component.rs`),
//! the dev vendor dir, or a system install. The handle is never unloaded:
//! mpv spawns internal threads that live in the library's code.
//!
//! Only the ~17 client + render-API symbols the engine actually uses are
//! declared here; `api.rs` provides the safe wrapper over them.

// Types/constants intentionally mirror the C names in mpv/client.h.
#![allow(non_camel_case_types)]

use std::ffi::{c_char, c_double, c_int, c_ulong, c_void};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

// ---------------------------------------------------------------------------
// Raw C types (mpv/client.h + mpv/render_gl.h subsets)
// ---------------------------------------------------------------------------

/// Opaque `mpv_handle`.
#[repr(C)]
pub struct mpv_handle {
    _unused: [u8; 0],
}

/// Opaque `mpv_render_context`.
#[repr(C)]
pub struct mpv_render_context {
    _unused: [u8; 0],
}

pub type mpv_format = c_int;
pub const MPV_FORMAT_NONE: mpv_format = 0;
pub const MPV_FORMAT_STRING: mpv_format = 1;
pub const MPV_FORMAT_OSD_STRING: mpv_format = 2;
pub const MPV_FORMAT_FLAG: mpv_format = 3;
pub const MPV_FORMAT_INT64: mpv_format = 4;
pub const MPV_FORMAT_DOUBLE: mpv_format = 5;

pub type mpv_event_id = c_int;
pub const MPV_EVENT_NONE: mpv_event_id = 0;
pub const MPV_EVENT_SHUTDOWN: mpv_event_id = 1;
pub const MPV_EVENT_START_FILE: mpv_event_id = 6;
pub const MPV_EVENT_END_FILE: mpv_event_id = 7;
pub const MPV_EVENT_FILE_LOADED: mpv_event_id = 8;
/// Deprecated event still delivered by default; the engine turns it off.
pub const MPV_EVENT_IDLE: mpv_event_id = 11;
/// Playback (re)started after load/seek — mpv has decoded and is displaying the
/// first frame of the new content. Later than `time-pos`/video reconfig, so the
/// truest "frame is on screen" signal on self-presenting VOs (Windows `vo=gpu`);
/// the frontend reveals the native video hole on it.
pub const MPV_EVENT_PLAYBACK_RESTART: mpv_event_id = 21;
pub const MPV_EVENT_PROPERTY_CHANGE: mpv_event_id = 22;

#[repr(C)]
pub struct mpv_event {
    pub event_id: mpv_event_id,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct mpv_event_property {
    pub name: *const c_char,
    pub format: mpv_format,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct mpv_event_end_file {
    pub reason: c_int,
    pub error: c_int,
    pub playlist_entry_id: i64,
    pub playlist_insert_id: i64,
    pub playlist_insert_num_entries: c_int,
}

pub type mpv_render_param_type = c_int;
pub const MPV_RENDER_PARAM_INVALID: mpv_render_param_type = 0;
pub const MPV_RENDER_PARAM_API_TYPE: mpv_render_param_type = 1;
pub const MPV_RENDER_PARAM_OPENGL_INIT_PARAMS: mpv_render_param_type = 2;
pub const MPV_RENDER_PARAM_OPENGL_FBO: mpv_render_param_type = 3;
pub const MPV_RENDER_PARAM_FLIP_Y: mpv_render_param_type = 4;

pub const MPV_RENDER_API_TYPE_OPENGL: &[u8] = b"opengl\0";

#[repr(C)]
pub struct mpv_render_param {
    pub type_: mpv_render_param_type,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct mpv_opengl_init_params {
    pub get_proc_address:
        Option<unsafe extern "C" fn(ctx: *mut c_void, name: *const c_char) -> *mut c_void>,
    pub get_proc_address_ctx: *mut c_void,
}

/// Full C layout — `internal_format` included (the old `libmpv2` crate's FBO
/// struct omitted it, making mpv read past the allocation).
#[repr(C)]
pub struct mpv_opengl_fbo {
    pub fbo: c_int,
    pub w: c_int,
    pub h: c_int,
    pub internal_format: c_int,
}

// ---------------------------------------------------------------------------
// Symbol table
// ---------------------------------------------------------------------------

/// The loaded library: raw OS handle (kept forever) + resolved symbols.
pub struct LibMpv {
    /// Where the dylib/DLL was loaded from — for diagnostics/capability.
    pub path: PathBuf,
    /// Resolution origin: "env" | "bundled" | "managed" | "vendored" | "system".
    pub origin: &'static str,

    pub client_api_version: unsafe extern "C" fn() -> c_ulong,
    pub create: unsafe extern "C" fn() -> *mut mpv_handle,
    pub initialize: unsafe extern "C" fn(*mut mpv_handle) -> c_int,
    pub destroy: unsafe extern "C" fn(*mut mpv_handle),
    pub terminate_destroy: unsafe extern "C" fn(*mut mpv_handle),
    pub free: unsafe extern "C" fn(*mut c_void),
    pub error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    pub set_property:
        unsafe extern "C" fn(*mut mpv_handle, *const c_char, mpv_format, *mut c_void) -> c_int,
    pub get_property:
        unsafe extern "C" fn(*mut mpv_handle, *const c_char, mpv_format, *mut c_void) -> c_int,
    pub command: unsafe extern "C" fn(*mut mpv_handle, *mut *const c_char) -> c_int,
    pub observe_property:
        unsafe extern "C" fn(*mut mpv_handle, u64, *const c_char, mpv_format) -> c_int,
    pub request_event: unsafe extern "C" fn(*mut mpv_handle, mpv_event_id, c_int) -> c_int,
    pub wait_event: unsafe extern "C" fn(*mut mpv_handle, c_double) -> *mut mpv_event,
    pub render_context_create: unsafe extern "C" fn(
        *mut *mut mpv_render_context,
        *mut mpv_handle,
        *mut mpv_render_param,
    ) -> c_int,
    pub render_context_set_update_callback: unsafe extern "C" fn(
        *mut mpv_render_context,
        Option<unsafe extern "C" fn(*mut c_void)>,
        *mut c_void,
    ),
    pub render_context_render:
        unsafe extern "C" fn(*mut mpv_render_context, *mut mpv_render_param) -> c_int,
    pub render_context_free: unsafe extern "C" fn(*mut mpv_render_context),
}

// Fn pointers + PathBuf; the raw OS handle isn't stored (never unloaded).
unsafe impl Send for LibMpv {}
unsafe impl Sync for LibMpv {}

// ---------------------------------------------------------------------------
// OS dynamic loading (hand-rolled — matches the repo's existing style of raw
// dlopen/Win32 externs; no loader crate)
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod os {
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::path::Path;

    extern "C" {
        fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        fn dlerror() -> *mut c_char;
    }

    const RTLD_NOW: c_int = 2;

    pub fn open(path: &Path) -> Result<*mut c_void, String> {
        let cpath = CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| "library path contains NUL".to_string())?;
        unsafe {
            dlerror(); // clear any stale error
            let handle = dlopen(cpath.as_ptr(), RTLD_NOW);
            if handle.is_null() {
                let err = dlerror();
                let msg = if err.is_null() {
                    "unknown dlopen error".to_string()
                } else {
                    std::ffi::CStr::from_ptr(err).to_string_lossy().into_owned()
                };
                return Err(msg);
            }
            Ok(handle)
        }
    }

    pub fn symbol(handle: *mut c_void, name: &str) -> Result<*mut c_void, String> {
        let cname = CString::new(name).map_err(|_| "symbol name contains NUL".to_string())?;
        let ptr = unsafe { dlsym(handle, cname.as_ptr()) };
        if ptr.is_null() {
            return Err(format!("symbol {name} not found"));
        }
        Ok(ptr)
    }
}

#[cfg(windows)]
mod os {
    use std::ffi::{c_void, CString};
    use std::path::Path;

    unsafe extern "system" {
        fn LoadLibraryExW(lp_lib_file_name: *const u16, h_file: isize, dw_flags: u32) -> isize;
        fn GetProcAddress(h_module: isize, lp_proc_name: *const i8) -> *mut c_void;
        fn GetLastError() -> u32;
    }

    /// Dependent DLLs (none for the self-contained libmpv) resolve next to
    /// the loaded DLL rather than next to the exe.
    const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 0x0000_0008;

    pub fn open(path: &Path) -> Result<*mut c_void, String> {
        let wide: Vec<u16> = path
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let handle = unsafe { LoadLibraryExW(wide.as_ptr(), 0, LOAD_WITH_ALTERED_SEARCH_PATH) };
        if handle == 0 {
            let err = unsafe { GetLastError() };
            return Err(format!("LoadLibraryExW failed (err={err})"));
        }
        Ok(handle as *mut c_void)
    }

    pub fn symbol(handle: *mut c_void, name: &str) -> Result<*mut c_void, String> {
        let cname = CString::new(name).map_err(|_| "symbol name contains NUL".to_string())?;
        let ptr = unsafe { GetProcAddress(handle as isize, cname.as_ptr()) };
        if ptr.is_null() {
            return Err(format!("symbol {name} not found"));
        }
        Ok(ptr)
    }
}

// ---------------------------------------------------------------------------
// Library resolution
// ---------------------------------------------------------------------------

/// Directory the downloadable engine component installs into
/// (`{app_data_dir}/engine`, shared across profiles). Set once from lib.rs
/// setup, mirroring `dependencies::set_managed_bin_dir`.
static COMPONENT_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_component_dir(dir: PathBuf) {
    let _ = COMPONENT_DIR.set(dir);
}

pub fn component_dir() -> Option<PathBuf> {
    COMPONENT_DIR.get().cloned()
}

#[cfg(target_os = "macos")]
pub const LIB_FILENAME: &str = "libmpv.2.dylib";
#[cfg(windows)]
pub const LIB_FILENAME: &str = "libmpv-2.dll";
#[cfg(all(unix, not(target_os = "macos")))]
pub const LIB_FILENAME: &str = "libmpv.so.2";

/// `<os>-<arch>` key used by the vendor dir and the component lock file.
pub fn platform_key() -> String {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        std::env::consts::OS
    };
    let arch = std::env::consts::ARCH; // "aarch64" / "x86_64" match the lock keys
    format!("{os}-{arch}")
}

/// Candidate locations in priority order. First existing file wins.
pub fn candidate_paths() -> Vec<(PathBuf, &'static str)> {
    let mut out: Vec<(PathBuf, &'static str)> = Vec::new();

    if let Ok(p) = std::env::var("VIBOPLR_LIBMPV_PATH") {
        out.push((PathBuf::from(p), "env"));
    }

    // Bundled copy: Full-build macOS bundles into Frameworks/, the Windows
    // Full build drops the DLL next to the exe (tauri resources).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            #[cfg(target_os = "macos")]
            out.push((exe_dir.join("../Frameworks").join(LIB_FILENAME), "bundled"));
            #[cfg(windows)]
            out.push((exe_dir.join(LIB_FILENAME), "bundled"));
            #[cfg(all(unix, not(target_os = "macos")))]
            out.push((exe_dir.join(LIB_FILENAME), "bundled"));
        }
    }

    // Managed engine component ({app_data_dir}/engine), downloaded on demand.
    if let Some(dir) = COMPONENT_DIR.get() {
        out.push((dir.join(LIB_FILENAME), "managed"));
    }

    // Dev/test fallback: the vendored artifacts fetch-libmpv.mjs produces.
    // Compile-time path — only exists on the machine that built the binary,
    // so it's gated to debug builds (tests inherit debug_assertions).
    #[cfg(debug_assertions)]
    out.push((
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("vendor")
            .join("libmpv")
            .join(platform_key())
            .join("lib")
            .join(LIB_FILENAME),
        "vendored",
    ));

    // Well-known system install locations (homebrew etc.).
    #[cfg(target_os = "macos")]
    {
        out.push((PathBuf::from("/opt/homebrew/lib/libmpv.dylib"), "system"));
        out.push((PathBuf::from("/usr/local/lib/libmpv.dylib"), "system"));
    }

    out
}

/// The library file the loader would use, without loading it.
pub fn resolve_lib() -> Option<(PathBuf, &'static str)> {
    candidate_paths().into_iter().find(|(p, _)| p.is_file())
}

// ---------------------------------------------------------------------------
// One-shot loading (success cached forever; failure retried so an install
// mid-session becomes usable without a restart)
// ---------------------------------------------------------------------------

static LOADED: Mutex<Option<&'static LibMpv>> = Mutex::new(None);

macro_rules! resolve_symbols {
    ($handle:expr, $path:expr, $origin:expr, { $($field:ident : $sym:literal),+ $(,)? }) => {{
        LibMpv {
            path: $path,
            origin: $origin,
            $($field: unsafe { std::mem::transmute::<*mut c_void, _>(os::symbol($handle, $sym)?) },)+
        }
    }};
}

fn load_from(path: PathBuf, origin: &'static str) -> Result<LibMpv, String> {
    let handle =
        os::open(&path).map_err(|e| format!("failed to load {}: {e}", path.display()))?;
    let lib = resolve_symbols!(handle, path, origin, {
        client_api_version: "mpv_client_api_version",
        create: "mpv_create",
        initialize: "mpv_initialize",
        destroy: "mpv_destroy",
        terminate_destroy: "mpv_terminate_destroy",
        free: "mpv_free",
        error_string: "mpv_error_string",
        set_property: "mpv_set_property",
        get_property: "mpv_get_property",
        command: "mpv_command",
        observe_property: "mpv_observe_property",
        request_event: "mpv_request_event",
        wait_event: "mpv_wait_event",
        render_context_create: "mpv_render_context_create",
        render_context_set_update_callback: "mpv_render_context_set_update_callback",
        render_context_render: "mpv_render_context_render",
        render_context_free: "mpv_render_context_free",
    });
    let api = unsafe { (lib.client_api_version)() };
    if api >> 16 != 2 {
        return Err(format!(
            "libmpv at {} has client API {}.{} (need major version 2)",
            lib.path.display(),
            api >> 16,
            api & 0xffff
        ));
    }
    Ok(lib)
}

/// The loaded libmpv, loading it on first use. Errors are NOT cached — a
/// component installed mid-session is picked up by the next call.
pub fn libmpv() -> Result<&'static LibMpv, String> {
    let mut guard = LOADED.lock().unwrap();
    if let Some(lib) = *guard {
        return Ok(lib);
    }
    let (path, origin) = resolve_lib().ok_or_else(|| {
        "libmpv not found — install the engine component from Settings > Playback".to_string()
    })?;
    let lib: &'static LibMpv = Box::leak(Box::new(load_from(path, origin)?));
    log::info!(
        "mpv-engine: loaded libmpv from {} ({})",
        lib.path.display(),
        lib.origin
    );
    *guard = Some(lib);
    Ok(lib)
}

/// The already-loaded library, if any — never triggers a load.
pub fn loaded() -> Option<&'static LibMpv> {
    *LOADED.lock().unwrap()
}
