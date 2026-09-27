use log::{Level, LevelFilter, Log, Metadata, Record};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct CombinedLogger {
    env_logger: env_logger::Logger,
    file_writer: Option<Mutex<BufWriter<File>>>,
}

impl Log for CombinedLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        self.env_logger.enabled(metadata) || self.file_writer.is_some()
    }

    fn log(&self, record: &Record) {
        if self.env_logger.enabled(record.metadata()) {
            self.env_logger.log(record);
        }

        if let Some(ref writer) = self.file_writer {
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
            if let Ok(mut w) = writer.lock() {
                let _ = w.write_all(line.as_bytes());
                let _ = w.flush();
            }
        }
    }

    fn flush(&self) {
        self.env_logger.flush();
        if let Some(ref writer) = self.file_writer {
            if let Ok(mut w) = writer.lock() {
                let _ = w.flush();
            }
        }
    }
}

/// Name the previous session's log is kept under. The live log is truncated on
/// every launch, so without this a relaunch after a hang or crash erased the
/// only record of what the dead session was doing.
pub const PREV_LOG_NAME: &str = "viboplr.prev.log";

/// Move `viboplr.log` aside to `viboplr.prev.log` (replacing any older one),
/// keeping exactly one previous session.
fn rotate_previous_log(dir: &std::path::Path) {
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
/// If `log_dir` is Some, keeps the previous session's log as
/// `viboplr.prev.log` and starts a fresh log file in that directory.
/// If None, uses env_logger only (console output).
pub fn init(log_dir: Option<PathBuf>) {
    let env_logger = env_logger::Builder::from_default_env().build();
    let max_level = env_logger.filter();

    let file_writer = log_dir.and_then(|dir| {
        if let Err(e) = fs::create_dir_all(&dir) {
            eprintln!("Failed to create log directory: {}", e);
            return None;
        }

        rotate_previous_log(&dir);
        let log_path = dir.join("viboplr.log");

        match File::create(&log_path) {
            Ok(file) => {
                eprintln!("Logging to: {}", log_path.display());
                Some(Mutex::new(BufWriter::new(file)))
            }
            Err(e) => {
                eprintln!("Failed to create log file: {}", e);
                None
            }
        }
    });

    let file_level = if file_writer.is_some() {
        LevelFilter::Info
    } else {
        LevelFilter::Off
    };

    let combined = CombinedLogger {
        env_logger,
        file_writer,
    };

    let effective_level = std::cmp::max(max_level, file_level);

    log::set_boxed_logger(Box::new(combined)).expect("Failed to set logger");
    log::set_max_level(effective_level);
}

#[cfg(test)]
mod tests {
    use super::{rotate_previous_log, PREV_LOG_NAME};

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
}
