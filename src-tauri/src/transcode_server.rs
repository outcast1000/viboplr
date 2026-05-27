use axum::{
    Router,
    extract::{Path, Query, State as AxumState},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::get,
};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub struct TranscodeSession {
    file_path: String,
    child: Option<Child>,
}

impl TranscodeSession {
    fn kill(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
        }
        self.child = None;
    }
}

impl Drop for TranscodeSession {
    fn drop(&mut self) {
        self.kill();
    }
}

pub type Sessions = Arc<Mutex<HashMap<String, TranscodeSession>>>;

#[derive(Clone)]
struct ServerState {
    sessions: Sessions,
}

#[derive(serde::Deserialize)]
struct StreamQuery {
    seek: Option<f64>,
}

fn ffmpeg_command() -> Command {
    crate::dependencies::tokio_command_with_path("ffmpeg")
}

fn spawn_ffmpeg(file_path: &str, seek_secs: f64) -> Result<Child, String> {
    let mut cmd = ffmpeg_command();

    if seek_secs > 0.0 {
        cmd.arg("-ss").arg(format!("{:.3}", seek_secs));
    }

    cmd.arg("-i")
        .arg(file_path)
        .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"])
        .args(["-c:a", "aac", "-b:a", "192k"])
        .args(["-movflags", "frag_keyframe+empty_moov+default_base_moof"])
        .args(["-f", "mp4"])
        .arg("pipe:1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    cmd.spawn().map_err(|e| format!("Failed to spawn ffmpeg: {}", e))
}

async fn handle_stream(
    AxumState(state): AxumState<ServerState>,
    Path(session_id): Path<String>,
    Query(query): Query<StreamQuery>,
) -> impl IntoResponse {
    let seek_secs = query.seek.unwrap_or(0.0);

    let mut sessions = state.sessions.lock().await;
    let session = match sessions.get_mut(&session_id) {
        Some(s) => s,
        None => return (StatusCode::NOT_FOUND, "Session not found").into_response(),
    };

    // Kill any existing ffmpeg process for this session
    session.kill();

    // Spawn new ffmpeg at the requested position
    let child = match spawn_ffmpeg(&session.file_path, seek_secs) {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };

    session.child = Some(child);

    // Take stdout from the child — we need to release the lock before streaming
    let stdout = session.child.as_mut().unwrap().stdout.take();
    drop(sessions);

    let stdout = match stdout {
        Some(s) => s,
        None => return (StatusCode::INTERNAL_SERVER_ERROR, "No stdout").into_response(),
    };

    let stream = tokio_util::io::ReaderStream::new(stdout);
    let body = axum::body::Body::from_stream(stream);

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "video/mp4"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

/// Start the transcode HTTP server. Returns the port it's listening on.
/// Synchronous, non-blocking startup. Binds a port via std and hands the
/// listener over to a spawned tokio task — avoids `block_on` in the Tauri
/// setup path so window paint isn't gated on TCP bind latency.
pub fn start_sync(sessions: Sessions) -> u16 {
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0")
        .expect("Failed to bind transcode server");
    std_listener.set_nonblocking(true).ok();
    let port = std_listener.local_addr().unwrap().port();
    log::info!("Transcode server listening on 127.0.0.1:{}", port);

    let state = ServerState { sessions };
    let app = Router::new()
        .route("/stream/{session_id}", get(handle_stream))
        .with_state(state);

    tauri::async_runtime::spawn(async move {
        let listener = TcpListener::from_std(std_listener)
            .expect("Failed to convert std listener to tokio");
        axum::serve(listener, app).await.ok();
    });

    port
}

/// Create a new transcode session. Returns the session ID.
pub async fn create_session(sessions: &Sessions, file_path: String) -> String {
    let session_id = format!(
        "ts-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    let session = TranscodeSession {
        file_path,
        child: None,
    };

    sessions.lock().await.insert(session_id.clone(), session);
    session_id
}

/// Stop and remove a transcode session.
pub async fn remove_session(sessions: &Sessions, session_id: &str) {
    if let Some(mut session) = sessions.lock().await.remove(session_id) {
        session.kill();
    }
}
