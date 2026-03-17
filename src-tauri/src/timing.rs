use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimingEntry {
    pub label: String,
    pub duration_ms: f64,
    pub offset_ms: f64,
}

pub struct StartupTimer {
    origin: Instant,
    entries: Mutex<Vec<TimingEntry>>,
}

impl StartupTimer {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
            entries: Mutex::new(Vec::new()),
        }
    }

    pub fn record(&self, label: &str, started_at: Instant) {
        let duration_ms = started_at.elapsed().as_secs_f64() * 1000.0;
        let offset_ms = started_at.duration_since(self.origin).as_secs_f64() * 1000.0;
        self.entries.lock().unwrap().push(TimingEntry {
            label: label.to_string(),
            duration_ms,
            offset_ms,
        });
    }

    pub fn time<T, F: FnOnce() -> T>(&self, label: &str, f: F) -> T {
        let start = Instant::now();
        let result = f();
        self.record(label, start);
        result
    }

    pub fn get_entries(&self) -> Vec<TimingEntry> {
        self.entries.lock().unwrap().clone()
    }
}

static TIMER: OnceLock<StartupTimer> = OnceLock::new();

pub fn init_timer() -> &'static StartupTimer {
    TIMER.get_or_init(StartupTimer::new)
}

pub fn timer() -> &'static StartupTimer {
    TIMER.get_or_init(StartupTimer::new)
}
