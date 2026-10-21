//! Asking plugins to stop their services before Vibo quits.
//!
//! A plugin's background program registered with `outliveApp: false` is meant
//! to stop with Vibo. Stopping it is the plugin's job (it knows the program's
//! clean shutdown — slskd's API, say — where the host only has a signal), so a
//! quit is held while the webview runs each plugin's
//! `api.system.programs.onAppQuitting` handler, then answers `app_quit_ready`.
//! The host waits at most `WAIT`, then stops whatever is still running itself
//! (`plugin_programs::stop_tied_to_app`) and exits.
//!
//! Nothing is held when no such program runs, so an ordinary quit stays
//! instant. Every route goes through here: the window's close button, Cmd-Q /
//! the OS (`ExitRequested`, no code), `AppHandle::exit` (probe quit, a profile
//! switch) and the relaunch after an app update (`relaunch_app`, which holds
//! before calling `AppHandle::restart` — Tauri ignores `prevent_exit` for a
//! restart, so `ExitRequested` can't).
//!
//! The wait runs on its own thread: the main thread has to stay free, or the
//! webview could never run the handlers it is waiting for.

use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// How long plugins get to stop their services before the host steps in.
const WAIT: Duration = Duration::from_secs(5);

struct State {
    in_progress: bool,
    done: bool,
    ready: bool,
}

static STATE: Mutex<State> = Mutex::new(State { in_progress: false, done: false, ready: false });
static READY: Condvar = Condvar::new();

/// Should this quit be held? True while a handshake is under way (a second
/// request during it is held too) or when one must start; false once it has
/// run, or when there is nothing for a plugin to stop.
pub fn should_hold(app_dir: &Path) -> bool {
    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if state.done {
        return false;
    }
    state.in_progress || crate::plugin_programs::has_running_tied_to_app(app_dir)
}

/// Run the handshake (once), then `finish`. A call while one is under way
/// returns at once: the first one will finish the quit.
pub fn run(app: AppHandle, app_dir: PathBuf, finish: impl FnOnce(&AppHandle) + Send + 'static) {
    {
        let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
        if state.in_progress || state.done {
            return;
        }
        state.in_progress = true;
        state.ready = false;
    }
    std::thread::spawn(move || {
        log::info!("Exit: asking plugins to stop their services");
        let _ = app.emit("app-quitting", ());
        if !wait_for_ready(WAIT) {
            log::warn!("Exit: plugins didn't answer within {}s; stopping their services", WAIT.as_secs());
        }
        crate::plugin_programs::stop_tied_to_app(&app_dir);
        {
            let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
            state.in_progress = false;
            state.done = true;
        }
        finish(&app);
    });
}

/// Wait until `ready` is called or `timeout` passes; true when it was called.
fn wait_for_ready(timeout: Duration) -> bool {
    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let (_state, waited) = READY
        .wait_timeout_while(state, timeout, |s| !s.ready)
        .unwrap_or_else(|e| e.into_inner());
    !waited.timed_out()
}

/// The quit the handshake held didn't happen after all (a profile switch whose
/// new instance failed to start): the next quit asks the plugins again.
pub fn reset() {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    state.in_progress = false;
    state.done = false;
    state.ready = false;
}

/// The webview ran every plugin's quit handler (`app_quit_ready`).
pub fn ready() {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    state.ready = true;
    READY.notify_all();
}

// `run` needs an AppHandle and ends the process, so it isn't exercised here;
// these cover the decision and the wait it is built on.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nothing_running_means_no_hold() {
        let profile = tempfile::tempdir().unwrap();
        assert!(!should_hold(profile.path()));
    }

    #[test]
    fn test_the_wait_ends_on_ready_or_at_the_timeout() {
        STATE.lock().unwrap().ready = false;
        let started = std::time::Instant::now();
        assert!(!wait_for_ready(Duration::from_millis(100)), "nobody answered");
        assert!(started.elapsed() >= Duration::from_millis(100));

        let waiter = std::thread::spawn(|| wait_for_ready(Duration::from_secs(10)));
        std::thread::sleep(Duration::from_millis(50));
        ready();
        assert!(waiter.join().unwrap(), "ready() releases the wait");
        STATE.lock().unwrap().ready = false;
    }
}
