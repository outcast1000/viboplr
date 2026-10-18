//! Start, find and stop a program as an **independent** process.
//!
//! A plugin's program (slskd) is meant to outlive Vibo — Soulseek transfers
//! take hours — so nothing here ties the child's lifetime to ours: no pipes are
//! held, unix children get their own session (`setsid`), Windows children get a
//! hidden console of their own. Liveness is "is that pid alive **and** running a
//! binary out of the expected folder", so a recycled pid never reads as ours.
//!
//! Stopping is a ladder: a signal (SIGTERM / Ctrl-Break), then a hard kill. A
//! program with a graceful stop of its own (slskd's API) is stopped that way by
//! its plugin first; this is the part only the host can do.
//!
//! Also used by `roadie_cleanup`, which stops a slskd that Roadie started.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Everything a detached start needs. `log` receives stdout and stderr and is
/// truncated per start, so it always holds the latest run's output.
pub struct SpawnPlan {
    pub exe: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    pub log: PathBuf,
}

/// Start the program detached from this process. Returns its pid.
pub fn spawn_detached(p: &SpawnPlan) -> Result<u32, String> {
    if let Some(parent) = p.log.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let log = std::fs::File::create(&p.log).map_err(|e| format!("Couldn't open {}: {e}", p.log.display()))?;
    let log_err = log.try_clone().map_err(|e| format!("Log handle error: {e}"))?;

    let mut cmd = std::process::Command::new(&p.exe);
    cmd.args(&p.args)
        .envs(p.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .current_dir(&p.cwd)
        .stdin(std::process::Stdio::null())
        .stdout(log)
        .stderr(log_err);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // New session: own process group, no controlling terminal. Neither
        // Vibo's exit nor a terminal hangup reaches the program.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A *hidden* console rather than DETACHED_PROCESS: the Ctrl-Break stop
        // needs a console to attach to. Its own process group, so that event
        // cannot reach anything else.
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start {}: {e}", p.exe.display()))?;
    let pid = child.id();
    // Reap it if it exits before we do; if we exit first the OS adopts it.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}

// --- Liveness ---

pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        if unsafe { libc::kill(pid as i32, 0) } == 0 {
            return true;
        }
        // EPERM: the process exists but belongs to someone else.
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    unsafe {
        win::pid_alive(pid)
    }
}

pub fn pid_exe(pid: u32) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    unsafe {
        let mut buf = vec![0u8; 4096];
        let n = libc::proc_pidpath(pid as i32, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32);
        if n <= 0 {
            return None;
        }
        buf.truncate(n as usize);
        Some(PathBuf::from(String::from_utf8_lossy(&buf).into_owned()))
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/exe")).ok()
    }
    #[cfg(windows)]
    unsafe {
        win::pid_exe(pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = pid;
        None
    }
}

/// Alive **and** running a binary from inside `root`. A recycled pid, or the
/// user's own copy of the same program, never counts. An exe that can't be
/// read (permissions) doesn't count either: a stop must never be aimed at a
/// process we can't identify.
pub fn is_ours(pid: u32, root: &Path) -> bool {
    if !pid_alive(pid) {
        return false;
    }
    let Some(exe) = pid_exe(pid) else { return false };
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    exe.starts_with(root)
}

// --- Stop ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StopMethod {
    /// It had already exited.
    NotRunning,
    Signal,
    Forced,
}

fn wait_gone(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !pid_alive(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// Signal, wait up to `grace`, then force. The caller has already checked the
/// pid is ours.
pub fn stop(pid: u32, grace: Duration) -> Result<StopMethod, String> {
    if !pid_alive(pid) {
        return Ok(StopMethod::NotRunning);
    }
    if send_terminate(pid) && wait_gone(pid, grace) {
        return Ok(StopMethod::Signal);
    }
    log::warn!("plugin programs: forcing pid {pid} to exit");
    force_kill(pid);
    if wait_gone(pid, Duration::from_secs(5)) {
        Ok(StopMethod::Forced)
    } else {
        Err(format!("The program (pid {pid}) could not be stopped"))
    }
}

pub fn send_terminate(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM) == 0
    }
    #[cfg(windows)]
    unsafe {
        win::send_ctrl_break(pid)
    }
}

pub fn force_kill(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    unsafe {
        win::terminate(pid);
    }
}

// --- Windows FFI (hand-declared; no crate, like display_watch.rs) ---
#[cfg(windows)]
mod win {
    use std::path::PathBuf;

    type HANDLE = *mut std::ffi::c_void;
    type BOOL = i32;
    type DWORD = u32;

    const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;
    const PROCESS_TERMINATE: DWORD = 0x0001;
    const STILL_ACTIVE: DWORD = 259;
    const CTRL_BREAK_EVENT: DWORD = 1;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: DWORD, inherit: BOOL, pid: DWORD) -> HANDLE;
        fn CloseHandle(h: HANDLE) -> BOOL;
        fn GetExitCodeProcess(h: HANDLE, code: *mut DWORD) -> BOOL;
        fn QueryFullProcessImageNameW(h: HANDLE, flags: DWORD, name: *mut u16, size: *mut DWORD) -> BOOL;
        fn TerminateProcess(h: HANDLE, code: u32) -> BOOL;
        fn FreeConsole() -> BOOL;
        fn AttachConsole(pid: DWORD) -> BOOL;
        fn SetConsoleCtrlHandler(handler: *const std::ffi::c_void, add: BOOL) -> BOOL;
        fn GenerateConsoleCtrlEvent(event: DWORD, group: DWORD) -> BOOL;
    }

    pub unsafe fn pid_alive(pid: u32) -> bool {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code: DWORD = 0;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        ok && code == STILL_ACTIVE
    }

    pub unsafe fn pid_exe(pid: u32) -> Option<PathBuf> {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 32768];
        let mut len: DWORD = buf.len() as DWORD;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len) != 0;
        CloseHandle(h);
        if !ok {
            return None;
        }
        buf.truncate(len as usize);
        Some(PathBuf::from(String::from_utf16_lossy(&buf)))
    }

    pub unsafe fn terminate(pid: u32) {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if h.is_null() {
            return;
        }
        TerminateProcess(h, 1);
        CloseHandle(h);
    }

    /// Deliver Ctrl-Break to the program's hidden console. Vibo is a GUI
    /// subsystem process with no console of its own, so attaching is clean.
    ///
    /// The event is aimed at the program's **own process group** (it was
    /// started with `CREATE_NEW_PROCESS_GROUP`, so the group id is its pid),
    /// never group 0: group 0 is every process attached to the console — Vibo
    /// included while it is attached — and `SetConsoleCtrlHandler(NULL, TRUE)`
    /// only makes us ignore Ctrl+C, not Ctrl-Break, whose default handler
    /// would exit Vibo.
    pub unsafe fn send_ctrl_break(pid: u32) -> bool {
        FreeConsole();
        if AttachConsole(pid) == 0 {
            return false;
        }
        SetConsoleCtrlHandler(std::ptr::null(), 1);
        let ok = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) != 0;
        // Give the event a moment to be dispatched before detaching.
        std::thread::sleep(std::time::Duration::from_millis(200));
        FreeConsole();
        SetConsoleCtrlHandler(std::ptr::null(), 0);
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_a_dead_or_zero_pid_is_not_alive() {
        assert!(!pid_alive(0));
        // Far above any real pid range on the platforms we ship.
        assert!(!pid_alive(0x7fff_fff0));
    }

    #[test]
    fn test_our_own_process_is_ours_only_inside_its_own_folder() {
        let me = std::process::id();
        let exe = std::env::current_exe().unwrap();
        assert!(is_ours(me, exe.parent().unwrap()));
        let elsewhere = tempfile::tempdir().unwrap();
        assert!(!is_ours(me, elsewhere.path()));
    }

    #[cfg(unix)]
    #[test]
    fn test_a_detached_program_starts_logs_and_stops() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("prog.sh");
        std::fs::write(&script, "#!/bin/sh\necho \"hello $GREETING\"\nexec sleep 30\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let plan = SpawnPlan {
            exe: script.clone(),
            args: vec![],
            env: vec![("GREETING".into(), "world".into())],
            cwd: dir.path().to_path_buf(),
            log: dir.path().join("logs").join("prog.log"),
        };
        let pid = spawn_detached(&plan).unwrap();
        assert!(pid_alive(pid));
        let deadline = Instant::now() + Duration::from_secs(5);
        while std::fs::read_to_string(&plan.log).unwrap_or_default().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(std::fs::read_to_string(&plan.log).unwrap().trim(), "hello world");
        assert_eq!(stop(pid, Duration::from_secs(5)).unwrap(), StopMethod::Signal);
        assert!(!pid_alive(pid));
        assert_eq!(stop(pid, Duration::from_secs(1)).unwrap(), StopMethod::NotRunning);
    }
}
