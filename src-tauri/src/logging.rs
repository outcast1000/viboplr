use log::{Level, LevelFilter, Log, Metadata, Record};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Where file log lines go. Starts `Pending` (buffered in memory) and becomes
/// `Open` only when `open_file_log` runs from the app's `setup` hook.
///
/// The split exists because `init` runs before the single-instance plugin.
/// A second launch (a shortcut click, a `viboplr://` link, `launch_app`)
/// forwards its argv and exits *inside* that plugin's setup, which Tauri runs
/// before ours — so `setup` is only ever reached by the instance that stays.
/// Rotating in `init` let every such launch move the running session's log
/// aside and truncate it, leaving a one-line file while the real instance
/// wrote on into an unlinked handle.
enum FileSink {
    Off,
    Pending { dir: PathBuf, lines: Vec<String> },
    Open(BufWriter<File>),
}

/// Bound on the lines buffered before the file opens. Startup logs a few dozen;
/// this only guards against `open_file_log` never being called.
const MAX_PENDING_LINES: usize = 2000;

impl FileSink {
    fn write_line(&mut self, line: &str) {
        match self {
            FileSink::Off => {}
            FileSink::Pending { lines, .. } => {
                if lines.len() < MAX_PENDING_LINES {
                    lines.push(line.to_string());
                }
            }
            FileSink::Open(w) => {
                let _ = w.write_all(line.as_bytes());
                let _ = w.flush();
            }
        }
    }

    /// Rotate the previous session's log, start a fresh one and flush what was
    /// buffered into it. A no-op unless `Pending`; on failure file logging is
    /// switched off (console output is unaffected).
    fn open(&mut self) {
        let FileSink::Pending { dir, lines } = std::mem::replace(self, FileSink::Off) else {
            return;
        };
        if let Err(e) = fs::create_dir_all(&dir) {
            eprintln!("Failed to create log directory: {}", e);
            return;
        }
        rotate_previous_log(&dir);
        let log_path = dir.join("viboplr.log");
        match File::create(&log_path) {
            Ok(file) => {
                eprintln!("Logging to: {}", log_path.display());
                let mut w = BufWriter::new(file);
                for line in &lines {
                    let _ = w.write_all(line.as_bytes());
                }
                let _ = w.flush();
                *self = FileSink::Open(w);
            }
            Err(e) => eprintln!("Failed to create log file: {}", e),
        }
    }

    fn flush(&mut self) {
        if let FileSink::Open(w) = self {
            let _ = w.flush();
        }
    }
}

static FILE_SINK: Mutex<FileSink> = Mutex::new(FileSink::Off);

pub struct CombinedLogger {
    env_logger: env_logger::Logger,
    file_enabled: bool,
}

impl Log for CombinedLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        self.env_logger.enabled(metadata) || self.file_enabled
    }

    fn log(&self, record: &Record) {
        if self.env_logger.enabled(record.metadata()) {
            self.env_logger.log(record);
        }

        if self.file_enabled {
            let now = chrono::Local::now();
            let level = match record.level() {
                Level::Error => "ERROR",
                Level::Warn => "WARN",
                Level::Info => "INFO",
                Level::Debug => "DEBUG",
                Level::Trace => "TRACE",
            };
            let line = format!(
                "[{}] [{}] {}: {}\n",
                now.format("%Y-%m-%dT%H:%M:%S%.3f"),
                level,
                record.target(),
                record.args()
            );
            if let Ok(mut sink) = FILE_SINK.lock() {
                sink.write_line(&line);
            }
        }
    }

    fn flush(&self) {
        self.env_logger.flush();
        if let Ok(mut sink) = FILE_SINK.lock() {
            sink.flush();
        }
    }
}

/// Name the previous session's log is kept under. The live log is truncated on
/// every launch, so without this a relaunch after a hang or crash erased the
/// only record of what the dead session was doing.
pub const PREV_LOG_NAME: &str = "viboplr.prev.log";

/// Move `viboplr.log` aside to `viboplr.prev.log` (replacing any older one),
/// keeping exactly one previous session.
fn rotate_previous_log(dir: &Path) {
    let current = dir.join("viboplr.log");
    if !current.exists() {
        return;
    }
    // fs::rename replaces an existing destination on both Windows and Unix.
    if let Err(e) = fs::rename(&current, dir.join(PREV_LOG_NAME)) {
        eprintln!("Failed to keep previous log: {}", e);
    }
}

/// Initialize the logging system.
/// If `log_dir` is Some, file log lines are buffered in memory until
/// `open_file_log` is called; nothing on disk is touched here. If None, uses
/// env_logger only (console output).
pub fn init(log_dir: Option<PathBuf>) {
    let env_logger = env_logger::Builder::from_default_env().build();
    let max_level = env_logger.filter();

    let file_enabled = log_dir.is_some();
    if let Some(dir) = log_dir {
        if let Ok(mut sink) = FILE_SINK.lock() {
            *sink = FileSink::Pending { dir, lines: Vec::new() };
        }
    }

    let file_level = if file_enabled {
        LevelFilter::Info
    } else {
        LevelFilter::Off
    };

    let combined = CombinedLogger {
        env_logger,
        file_enabled,
    };

    let effective_level = std::cmp::max(max_level, file_level);

    log::set_boxed_logger(Box::new(combined)).expect("Failed to set logger");
    log::set_max_level(effective_level);
}

/// Start this session's log file: keep the previous one as `viboplr.prev.log`,
/// then write out everything logged since `init`. Must be called from the
/// app's `setup` hook — only the surviving instance gets there (see
/// `FileSink`). A no-op when logging is off or the file is already open.
pub fn open_file_log() {
    if let Ok(mut sink) = FILE_SINK.lock() {
        sink.open();
    }
}

#[cfg(test)]
mod tests {
    use super::{rotate_previous_log, FileSink, PREV_LOG_NAME};

    #[test]
    fn test_rotate_keeps_previous_session_log() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("viboplr.log"), "session 2").unwrap();
        std::fs::write(dir.path().join(PREV_LOG_NAME), "session 1").unwrap();

        rotate_previous_log(dir.path());

        assert!(!dir.path().join("viboplr.log").exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(PREV_LOG_NAME)).unwrap(),
            "session 2"
        );
    }

    #[test]
    fn test_rotate_without_current_log_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        rotate_previous_log(dir.path());
        assert!(!dir.path().join(PREV_LOG_NAME).exists());
    }

    #[test]
    fn test_pending_sink_touches_nothing_on_disk() {
        // What a second launch does before the single-instance plugin exits it.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("viboplr.log"), "running session").unwrap();

        let mut sink = FileSink::Pending { dir: dir.path().to_path_buf(), lines: Vec::new() };
        sink.write_line("second launch\n");
        drop(sink);

        assert_eq!(
            std::fs::read_to_string(dir.path().join("viboplr.log")).unwrap(),
            "running session"
        );
        assert!(!dir.path().join(PREV_LOG_NAME).exists());
    }

    #[test]
    fn test_open_rotates_and_flushes_buffered_lines() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("viboplr.log"), "previous session").unwrap();

        let mut sink = FileSink::Pending { dir: dir.path().to_path_buf(), lines: Vec::new() };
        sink.write_line("before setup\n");
        sink.open();
        sink.write_line("after setup\n");

        assert_eq!(
            std::fs::read_to_string(dir.path().join(PREV_LOG_NAME)).unwrap(),
            "previous session"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("viboplr.log")).unwrap(),
            "before setup\nafter setup\n"
        );

        // A second open is a no-op, not a second rotation.
        sink.open();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(PREV_LOG_NAME)).unwrap(),
            "previous session"
        );
    }
}
