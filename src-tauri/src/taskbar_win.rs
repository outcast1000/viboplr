//! Windows taskbar-button behaviour for the mini player.
//!
//! Windows owns the taskbar-button gesture: clicking the button of the
//! foreground window minimizes it, clicking the button of a background window
//! activates it. Neither is what we want while the mini player is up — the
//! mini player *is* the main window, shrunk and pinned on top, so both should
//! mean "give me the normal window back".
//!
//! There is no Tauri event for either gesture (a taskbar minimize arrives as
//! `WM_SYSCOMMAND`/`SC_MINIMIZE`, which the window proc consumes before any
//! resize event is produced), so we subclass the main window's proc and
//! intercept it:
//!
//! - `SC_MINIMIZE` while mini  → swallow, emit `restore-from-mini`.
//! - `SC_MINIMIZE` while normal → swallow and emit `minimize-to-mini` when the
//!   user asked for it in Settings ("Minimize to mini player"); otherwise fall
//!   through to the real minimize.
//! - `WM_ACTIVATE` while mini, with the cursor over the taskbar → the click
//!   came from the taskbar button of an unfocused mini player, so emit
//!   `restore-from-mini`. The cursor test is what keeps Alt-Tab and ordinary
//!   clicks on the mini player itself from restoring the full window.
//!
//! Both events are also emitted by other paths (the macOS dock reopen sends
//! `restore-from-mini`), and the frontend handlers are idempotent — they check
//! the live mini state before toggling.

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use tauri::{AppHandle, Emitter};

const WM_ACTIVATE: u32 = 0x0006;
const WM_SYSCOMMAND: u32 = 0x0112;
const SC_MINIMIZE: usize = 0xF020;
const GWLP_WNDPROC: i32 = -4;
const GA_ROOT: u32 = 2;

/// Entering mini mode is itself started by a taskbar click: the `SC_MINIMIZE`
/// we swallow is followed by the show/focus of the resized window, i.e. a
/// `WM_ACTIVATE` with the cursor still over the taskbar. Without this window
/// that would read as "restore me" and the mini player would flash open and
/// shut again.
const SUPPRESS_MS: u64 = 800;

static MINI_MODE: AtomicBool = AtomicBool::new(false);
static MINIMIZE_TO_MINI: AtomicBool = AtomicBool::new(false);
static ORIGINAL_PROC: AtomicIsize = AtomicIsize::new(0);
static SUPPRESS_UNTIL_MS: AtomicU64 = AtomicU64::new(0);

static APP: OnceLock<AppHandle> = OnceLock::new();
static EPOCH: OnceLock<Instant> = OnceLock::new();

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: i32,
    y: i32,
}

unsafe extern "system" {
    fn SetWindowLongPtrW(h_wnd: isize, n_index: i32, dw_new_long: isize) -> isize;
    fn CallWindowProcW(prev: isize, h_wnd: isize, msg: u32, w_param: usize, l_param: isize)
        -> isize;
    fn GetCursorPos(lp_point: *mut Point) -> i32;
    fn WindowFromPoint(point: Point) -> isize;
    fn GetAncestor(h_wnd: isize, ga_flags: u32) -> isize;
    fn GetClassNameW(h_wnd: isize, lp_class_name: *mut u16, n_max_count: i32) -> i32;
}

fn now_ms() -> u64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Mirror of the frontend's mini-mode / "minimize to mini player" state. The
/// window proc runs synchronously and has to decide whether to swallow a
/// minimize before it could ask anyone, so the answer has to already be here.
pub fn set_state(mini_mode: bool, minimize_to_mini: bool) {
    MINI_MODE.store(mini_mode, Ordering::Relaxed);
    MINIMIZE_TO_MINI.store(minimize_to_mini, Ordering::Relaxed);
}

/// True when the cursor sits over the shell's taskbar (primary or secondary
/// monitor), i.e. the activation we're looking at came from a taskbar click.
fn cursor_over_taskbar() -> bool {
    unsafe {
        let mut cursor = Point { x: 0, y: 0 };
        if GetCursorPos(&mut cursor) == 0 {
            return false;
        }
        let hwnd = WindowFromPoint(cursor);
        if hwnd == 0 {
            return false;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        let root = if root == 0 { hwnd } else { root };
        let mut buf = [0u16; 64];
        let len = GetClassNameW(root, buf.as_mut_ptr(), buf.len() as i32);
        if len <= 0 {
            return false;
        }
        let class = String::from_utf16_lossy(&buf[..len as usize]);
        class == "Shell_TrayWnd" || class == "Shell_SecondaryTrayWnd"
    }
}

fn emit(event: &str) {
    SUPPRESS_UNTIL_MS.store(now_ms() + SUPPRESS_MS, Ordering::Relaxed);
    if let Some(app) = APP.get() {
        let _ = app.emit(event, ());
    }
}

unsafe extern "system" fn wnd_proc(h_wnd: isize, msg: u32, w_param: usize, l_param: isize) -> isize {
    match msg {
        WM_SYSCOMMAND if (w_param & 0xFFF0) == SC_MINIMIZE => {
            if MINI_MODE.load(Ordering::Relaxed) {
                emit("restore-from-mini");
                return 0;
            }
            if MINIMIZE_TO_MINI.load(Ordering::Relaxed) {
                emit("minimize-to-mini");
                return 0;
            }
        }
        WM_ACTIVATE if (w_param & 0xFFFF) != 0 => {
            if MINI_MODE.load(Ordering::Relaxed)
                && now_ms() >= SUPPRESS_UNTIL_MS.load(Ordering::Relaxed)
                && cursor_over_taskbar()
            {
                emit("restore-from-mini");
            }
        }
        _ => {}
    }
    let prev = ORIGINAL_PROC.load(Ordering::Relaxed);
    unsafe { CallWindowProcW(prev, h_wnd, msg, w_param, l_param) }
}

/// Subclass the main window so taskbar clicks reach `wnd_proc`. Idempotent —
/// a second call is a no-op, so the original proc can never be lost.
pub fn install(hwnd: isize, app: AppHandle) {
    let _ = EPOCH.get_or_init(Instant::now);
    let _ = APP.set(app);
    if ORIGINAL_PROC.load(Ordering::Relaxed) != 0 {
        return;
    }
    let prev = unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, wnd_proc as *const () as isize) };
    if prev == 0 {
        log::warn!("taskbar_win: could not subclass the main window proc");
        return;
    }
    ORIGINAL_PROC.store(prev, Ordering::Relaxed);
}
