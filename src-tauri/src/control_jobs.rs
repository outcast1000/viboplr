//! Background jobs for the control API's long calls.
//!
//! Five routes do work that takes minutes by nature: an extension install
//! (it waits for the user to answer Vibo's dialog), a plugin download, the
//! staging half of a file replace (it is a download), a track's own-source
//! download and a mixtape export. They are **async-only** (owner decision,
//! 2026-10-31): `control_api::start_job` registers the job, starts the work
//! and answers `202 { jobId }` at once — every time, so a caller only ever
//! sees one shape — and the result comes from `GET /v1/jobs/{id}?waitSecs=N`.
//! Holding the request open instead tied up the caller's turn, and an MCP
//! client that gave up on a long call left the work running while the
//! assistant believed it failed — and retried.
//!
//! The job is registered before its work starts, so a caller that hangs up
//! can still find it. This module is the registry and the view of a job;
//! nothing here knows what a job does — each carries only how to cancel it.
//!
//! Jobs live in memory only: they belong to this run of the app, and a restart
//! has killed the work they describe anyway.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;

/// Longest a single `GET /v1/jobs/{id}?waitSecs=` holds the request — short
/// enough for any MCP client's per-call limit.
pub const MAX_WAIT: Duration = Duration::from_secs(50);
/// How long a finished job stays readable, so a caller that comes back late
/// still gets the answer.
pub const KEEP_FINISHED: Duration = Duration::from_secs(30 * 60);
/// Finished jobs beyond this are dropped oldest first. Running ones never are.
pub const MAX_JOBS: usize = 50;

/// What a job's handler answered: the status and JSON body it would have
/// returned had the caller waited.
#[derive(Clone, Debug)]
pub struct Outcome {
    pub status: u16,
    pub body: Value,
    pub finished: Instant,
}

pub type OutcomeRx = watch::Receiver<Option<Outcome>>;

/// How `DELETE /v1/jobs/{id}` stops a job — exactly that job, never another.
#[derive(Clone)]
pub enum Cancel {
    /// Work in the webview's plugin resolve: `downloads.cancel` with this
    /// job's id, which the dispatcher honours only for the resolve carrying it.
    Resolve,
    /// Rust-side work polling this flag (the downloader, the mixtape export).
    Flag(Arc<AtomicBool>),
    /// Not the caller's to stop; the reason, as the refusal's text.
    Refuse(&'static str),
}

#[derive(Clone)]
pub struct Job {
    pub kind: &'static str,
    pub label: String,
    pub started: Instant,
    pub rx: OutcomeRx,
    pub cancel: Cancel,
}

#[derive(Default)]
pub struct Jobs {
    next: AtomicU64,
    map: Mutex<HashMap<String, Job>>,
}

/// A job label as it may appear in the app log and a listing: control
/// characters (a newline would forge a log line) become spaces, whitespace
/// collapses, and it stops at 80 characters. Labels quote the caller's input.
pub fn clean_label(raw: &str) -> String {
    let flat: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let words: Vec<&str> = flat.split_whitespace().collect();
    let joined = words.join(" ");
    if joined.chars().count() > 80 {
        format!("{}…", joined.chars().take(79).collect::<String>())
    } else {
        joined
    }
}

impl Jobs {
    pub fn insert(&self, kind: &'static str, label: String, started: Instant, rx: OutcomeRx, cancel: Cancel) -> String {
        let id = format!("j{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let mut map = self.map.lock().unwrap();
        prune(&mut map, Instant::now());
        map.insert(id.clone(), Job { kind, label, started, rx, cancel });
        id
    }

    pub fn get(&self, id: &str) -> Option<Job> {
        let mut map = self.map.lock().unwrap();
        prune(&mut map, Instant::now());
        map.get(id).cloned()
    }

    /// Every job still kept, oldest first.
    pub fn all(&self) -> Vec<(String, Job)> {
        let mut map = self.map.lock().unwrap();
        prune(&mut map, Instant::now());
        let mut jobs: Vec<(String, Job)> = map.iter().map(|(id, j)| (id.clone(), j.clone())).collect();
        jobs.sort_by_key(|(_, j)| j.started);
        jobs
    }
}

fn finished_at(job: &Job) -> Option<Instant> {
    job.rx.borrow().as_ref().map(|o| o.finished)
}

/// Drop finished jobs past `KEEP_FINISHED`, then the oldest finished ones past
/// `MAX_JOBS`. A running job is never dropped: its caller may still be waiting.
fn prune(map: &mut HashMap<String, Job>, now: Instant) {
    map.retain(|_, j| finished_at(j).is_none_or(|t| now.duration_since(t) < KEEP_FINISHED));
    if map.len() <= MAX_JOBS {
        return;
    }
    let mut finished: Vec<(String, Instant)> = map
        .iter()
        .filter_map(|(id, j)| finished_at(j).map(|t| (id.clone(), t)))
        .collect();
    finished.sort_by_key(|(_, t)| *t);
    let excess = map.len() - MAX_JOBS;
    for (id, _) in finished.into_iter().take(excess) {
        map.remove(&id);
    }
}

/// Wait until the job has an outcome. `false` when its task ended without one
/// (it panicked), so a caller doesn't wait forever on a dead job.
pub async fn wait_done(rx: &mut OutcomeRx) -> bool {
    loop {
        if rx.borrow().is_some() {
            return true;
        }
        if rx.changed().await.is_err() {
            return rx.borrow().is_some();
        }
    }
}

/// How a job reads to the caller. `status` is `running`, `done` (the handler
/// answered 2xx: `result` is its body) or `failed` (`error` says why, the way
/// the direct call would have).
pub fn view(id: &str, job: &Job, now: Instant) -> Value {
    let outcome = job.rx.borrow().clone();
    // `has_changed` errs once the job's task has gone without an outcome.
    let alive = job.rx.has_changed().is_ok() || outcome.is_some();
    let base = |status: &str, secs: f64| {
        json!({ "jobId": id, "kind": job.kind, "label": job.label, "status": status, "elapsedSecs": (secs * 10.0).round() / 10.0 })
    };
    match outcome {
        None if alive => base("running", now.duration_since(job.started).as_secs_f64()),
        None => {
            let mut v = base("failed", now.duration_since(job.started).as_secs_f64());
            v["error"] = json!("the job stopped without an answer");
            v
        }
        Some(o) => {
            let secs = o.finished.duration_since(job.started).as_secs_f64();
            if (200..300).contains(&o.status) {
                let mut v = base("done", secs);
                v["httpStatus"] = json!(o.status);
                v["result"] = o.body;
                v
            } else {
                let mut v = base("failed", secs);
                v["httpStatus"] = json!(o.status);
                v["error"] = o.body.get("error").cloned().unwrap_or_else(|| json!(o.body.to_string()));
                v
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(rx: OutcomeRx) -> Job {
        Job { kind: "download", label: "download a track".into(), started: Instant::now(), rx, cancel: Cancel::Resolve }
    }

    #[test]
    fn test_labels_cannot_carry_a_line_break_into_the_log_and_stay_short() {
        assert_eq!(clean_label("install x\nAssistant change [fake] done"), "install x Assistant change [fake] done");
        assert_eq!(clean_label("  Hey\t\tJude  "), "Hey Jude");
        let long = clean_label(&"a".repeat(200));
        assert_eq!(long.chars().count(), 80);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn test_a_running_job_reads_as_running() {
        let (_tx, rx) = watch::channel(None);
        let v = view("j1", &job(rx), Instant::now());
        assert_eq!(v["status"], json!("running"));
        assert_eq!(v["jobId"], json!("j1"));
        assert!(v.get("result").is_none());
    }

    #[test]
    fn test_a_2xx_outcome_is_done_with_the_handlers_body() {
        let (tx, rx) = watch::channel(None);
        tx.send(Some(Outcome { status: 200, body: json!({ "path": "/m/a.flac" }), finished: Instant::now() })).unwrap();
        let v = view("j1", &job(rx), Instant::now());
        assert_eq!(v["status"], json!("done"));
        assert_eq!(v["result"]["path"], json!("/m/a.flac"));
    }

    #[test]
    fn test_an_error_outcome_is_failed_with_the_handlers_error() {
        let (tx, rx) = watch::channel(None);
        tx.send(Some(Outcome { status: 400, body: json!({ "error": "cancelled" }), finished: Instant::now() })).unwrap();
        let v = view("j1", &job(rx), Instant::now());
        assert_eq!(v["status"], json!("failed"));
        assert_eq!(v["error"], json!("cancelled"));
        assert_eq!(v["httpStatus"], json!(400));
    }

    #[test]
    fn test_a_job_whose_task_died_reads_as_failed_not_running() {
        let (tx, rx) = watch::channel(None);
        drop(tx);
        assert_eq!(view("j1", &job(rx), Instant::now())["status"], json!("failed"));
    }

    #[tokio::test]
    async fn test_wait_done_returns_when_the_outcome_lands_or_the_task_dies() {
        let (tx, mut rx) = watch::channel(None);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            tx.send(Some(Outcome { status: 200, body: json!({}), finished: Instant::now() })).unwrap();
        });
        assert!(wait_done(&mut rx).await);
        let (tx, mut rx) = watch::channel::<Option<Outcome>>(None);
        drop(tx);
        assert!(!wait_done(&mut rx).await);
    }

    #[test]
    fn test_ids_are_unique_and_finished_jobs_past_the_cap_go_oldest_first() {
        let jobs = Jobs::default();
        let mut running = Vec::new();
        for _ in 0..3 {
            let (tx, rx) = watch::channel(None);
            running.push(tx);
            jobs.insert("install", "i".into(), Instant::now(), rx, Cancel::Refuse("no"));
        }
        let mut finished_ids = Vec::new();
        for _ in 0..MAX_JOBS {
            let (tx, rx) = watch::channel(None);
            tx.send(Some(Outcome { status: 200, body: json!({}), finished: Instant::now() })).unwrap();
            finished_ids.push(jobs.insert("download", "d".into(), Instant::now(), rx, Cancel::Resolve));
        }
        let all = jobs.all();
        assert_eq!(all.len(), MAX_JOBS);
        // The three running ones survive; the oldest finished ones made room.
        for id in ["j1", "j2", "j3"] {
            assert!(jobs.get(id).is_some(), "{id} is running and must be kept");
        }
        assert!(jobs.get(&finished_ids[0]).is_none());
        assert!(jobs.get(finished_ids.last().unwrap()).is_some());
        drop(running);
    }
}
