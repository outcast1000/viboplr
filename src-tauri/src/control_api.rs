//! Localhost control API for AI assistants (and any local automation).
//!
//! A small axum server bound to `127.0.0.1:0`, started only when the user
//! enables Settings → General → "AI control" (`controlApiEnabled`).
//! Clients discover it through `control-api.json` in the profile directory
//! (port + bearer token) and must probe `GET /v1/health` before trusting the
//! file — a crash leaves a stale one behind.
//!
//! ## Security model
//!
//! - **Bind:** `127.0.0.1` only; the network never sees it.
//! - **Auth:** every route requires `Authorization: Bearer <token>`. The token
//!   is compared via SHA-256 digests so comparison time is independent of any
//!   matching prefix, and it is never logged.
//! - **No CORS, ever.** A malicious webpage can *send* requests at localhost,
//!   but it cannot attach an `Authorization` header cross-origin without a
//!   passed CORS preflight — and this server never answers one (`OPTIONS` →
//!   405, no `Access-Control-*` headers anywhere). So the token gate holds
//!   against browser-origin attacks and the bind against the network.
//! - The discovery file is `0o600` on unix; on Windows the profile dir's
//!   per-user ACLs are the boundary. Any same-user local process can read it —
//!   the same trust model as Chrome DevTools' or Discord's local endpoints;
//!   the off-by-default toggle is the mitigation.
//!
//! ## Two kinds of routes
//!
//! Pure DB reads (search, playlists, history, tags) are answered here
//! directly. Everything else — playback, the live queue, and *all* mutations —
//! is bridged into the webview: the handler emits a `control-api-request`
//! event, the frontend dispatcher (`useControlApi.ts`) runs the canonical
//! action hooks and replies via the `control_api_respond` command, completing
//! a oneshot this side awaits with a timeout. Mutations go through the
//! frontend even when a backend command exists, so React state, plugin events
//! and the UI stay in sync — the same path a human's click takes.

use axum::{
    Router,
    body::Bytes,
    extract::{Path as AxumPath, Query, Request, State as AxumState},
    http::{header, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

use crate::db::Database;
use crate::models::TrackQuery;

/// Fixed name of the discovery file, written into the profile directory.
/// The skill (`skills/viboplr-control/SKILL.md`) reads the same name.
pub const DISCOVERY_FILE: &str = "control-api.json";

/// How long a bridged request waits for the webview before answering 504.
/// Nothing the dispatcher runs does network I/O, so a healthy webview answers
/// in milliseconds; 10s only papers over GC pauses and startup contention.
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(10);

type PendingSender = oneshot::Sender<Result<Value, String>>;

struct Running {
    port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

/// Shared control-API state, held in `AppState` for the whole app lifetime
/// (the server itself starts and stops with the Settings toggle).
pub struct ControlApi {
    running: Mutex<Option<Running>>,
    /// Bridged requests awaiting a `control_api_respond` from the webview.
    pending: Mutex<HashMap<u64, PendingSender>>,
    next_id: AtomicU64,
    /// Set by `control_api_client_ready`; bridged routes answer 503 before it.
    webview_ready: AtomicBool,
    /// Session token. Reused from the discovery file across restarts so a
    /// configured client keeps working; regenerated only on demand.
    token: Mutex<Option<String>>,
}

impl Default for ControlApi {
    fn default() -> Self {
        Self {
            running: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            webview_ready: AtomicBool::new(false),
            token: Mutex::new(None),
        }
    }
}

impl ControlApi {
    pub fn port(&self) -> Option<u16> {
        self.running.lock().unwrap().as_ref().map(|r| r.port)
    }

    pub fn token(&self) -> Option<String> {
        self.token.lock().unwrap().clone()
    }

    pub fn mark_webview_ready(&self) {
        self.webview_ready.store(true, Ordering::Release);
    }

    /// Forget the session token so the next `start` generates a fresh one
    /// (the caller removes the discovery file by stopping first).
    pub fn clear_token(&self) {
        *self.token.lock().unwrap() = None;
    }

    /// Complete a bridged request. A late respond (after the HTTP side timed
    /// out and removed the entry) is a silent no-op.
    pub fn respond(&self, id: u64, ok: bool, result: Value) {
        let sender = self.pending.lock().unwrap().remove(&id);
        if let Some(tx) = sender {
            let outcome = if ok {
                Ok(result)
            } else {
                Err(result.as_str().map(str::to_string).unwrap_or_else(|| result.to_string()))
            };
            let _ = tx.send(outcome);
        }
    }

    /// Compare a presented token against the current one, timing-independent
    /// of any matching prefix (digests of both are compared, and digest bits
    /// are unpredictable for any candidate).
    fn token_matches(&self, candidate: &str) -> bool {
        let Some(token) = self.token.lock().unwrap().clone() else {
            return false;
        };
        Sha256::digest(candidate.as_bytes()) == Sha256::digest(token.as_bytes())
    }
}

/// Everything an axum handler needs. `emit` abstracts `AppHandle::emit` so the
/// router is testable without a Tauri app.
#[derive(Clone)]
pub(crate) struct ServerState {
    db: Arc<Database>,
    api: Arc<ControlApi>,
    emit: Arc<dyn Fn(&ControlRequest) + Send + Sync>,
    bridge_timeout: Duration,
    version: String,
    profile: String,
    /// Profile dir — where entity images live (`{kind}_images/`).
    app_dir: PathBuf,
}

/// Payload of the `control-api-request` event the frontend dispatcher handles.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub id: u64,
    pub verb: String,
    pub payload: Value,
}

// --- Token + discovery file ---

fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("Failed to gather entropy: {}", e))?;
    Ok(bytes.iter().map(|b| format!("{:02x}", b)).collect())
}

pub fn discovery_path(app_dir: &Path) -> PathBuf {
    app_dir.join(DISCOVERY_FILE)
}

fn read_discovery_token(app_dir: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(discovery_path(app_dir)).ok()?;
    let json: Value = serde_json::from_str(&contents).ok()?;
    let token = json.get("token")?.as_str()?;
    // 64 lowercase hex chars — anything else is not ours; regenerate.
    (token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())).then(|| token.to_string())
}

fn write_discovery_file(app_dir: &Path, port: u16, token: &str, profile: &str) -> Result<(), String> {
    let path = discovery_path(app_dir);
    let contents = serde_json::to_string_pretty(&json!({
        "version": 1,
        "port": port,
        "pid": std::process::id(),
        "token": token,
        "profile": profile,
        "startedAt": chrono::Utc::now().to_rfc3339(),
    }))
    .map_err(|e| e.to_string())?;
    std::fs::write(&path, contents)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn remove_discovery_file(app_dir: &Path) {
    let _ = std::fs::remove_file(discovery_path(app_dir));
}

// --- Lifecycle ---

/// Start the server (idempotent — returns the existing port when already
/// running). Same non-blocking std-bind → tokio handoff as the transcode
/// server, so this is safe on the Tauri setup path.
pub fn start(
    api: &Arc<ControlApi>,
    db: Arc<Database>,
    app: tauri::AppHandle,
    app_dir: &Path,
    profile: &str,
    version: &str,
) -> Result<u16, String> {
    {
        let running = api.running.lock().unwrap();
        if let Some(r) = running.as_ref() {
            return Ok(r.port);
        }
    }

    // Reuse the token across restarts (in-memory first, then the previous
    // discovery file) so a configured client keeps working.
    let token = {
        let mut slot = api.token.lock().unwrap();
        match slot.clone() {
            Some(t) => t,
            None => {
                let t = read_discovery_token(app_dir)
                    .map(Ok)
                    .unwrap_or_else(generate_token)?;
                *slot = Some(t.clone());
                t
            }
        }
    };

    let std_listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind control API: {}", e))?;
    std_listener.set_nonblocking(true).ok();
    let port = std_listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    let emit_handle = app.clone();
    let state = ServerState {
        db,
        api: Arc::clone(api),
        emit: Arc::new(move |req: &ControlRequest| {
            use tauri::Emitter;
            let _ = emit_handle.emit("control-api-request", req.clone());
        }),
        bridge_timeout: BRIDGE_TIMEOUT,
        version: version.to_string(),
        profile: profile.to_string(),
        app_dir: app_dir.to_path_buf(),
    };
    let router = build_router(state);

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                log::error!("Control API: listener handoff failed: {}", e);
                return;
            }
        };
        let serve = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(e) = serve.await {
            log::error!("Control API server error: {}", e);
        }
    });

    write_discovery_file(app_dir, port, &token, profile)?;
    log::info!("Control API listening on 127.0.0.1:{}", port);

    *api.running.lock().unwrap() = Some(Running {
        port,
        shutdown: Some(shutdown_tx),
    });
    Ok(port)
}

/// Stop the server and remove the discovery file. Idempotent.
pub fn stop(api: &Arc<ControlApi>, app_dir: &Path) {
    if let Some(mut running) = api.running.lock().unwrap().take() {
        if let Some(tx) = running.shutdown.take() {
            let _ = tx.send(());
        }
        log::info!("Control API stopped");
    }
    remove_discovery_file(app_dir);
}

// --- Router ---

fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    (status, axum::Json(json!({ "error": message.into() }))).into_response()
}

pub(crate) fn build_router(state: ServerState) -> Router {
    let auth_state = state.clone();
    Router::new()
        // Backend-direct reads (pure DB).
        .route("/v1/health", get(handle_health))
        .route("/v1/search", get(handle_search))
        .route("/v1/tracks/{id}", get(handle_get_track))
        .route("/v1/playlists", get(handle_get_playlists).post(|s, b| handle_bridge_body(s, "playlists.create", json!({}), b)))
        .route("/v1/playlists/{id}/tracks", get(handle_get_playlist_tracks)
            .post(|s, p, b| handle_playlist_bridge(s, p, "playlists.append", b))
            .delete(|s, p, b| handle_playlist_bridge(s, p, "playlists.removeTracks", b)))
        .route("/v1/playlists/{id}/order", put(|s, p, b| handle_playlist_bridge(s, p, "playlists.reorder", b)))
        .route("/v1/playlists/{id}/play", post(|s, p, b| handle_playlist_bridge(s, p, "playlists.play", b)))
        .route("/v1/playlists/{id}/enqueue", post(|s, p, b| handle_playlist_bridge(s, p, "playlists.enqueue", b)))
        .route("/v1/playlists/{id}", patch(|s, p, b| handle_playlist_bridge(s, p, "playlists.rename", b)))
        .route("/v1/collections", get(handle_get_collections))
        .route("/v1/collections/{id}/rescan", post(|s, p, b| handle_collection_bridge(s, p, "collections.rescan", b)))
        .route("/v1/history", get(handle_history))
        .route("/v1/tags", get(handle_tags))
        .route("/v1/info/search", get(handle_info_search))
        .route("/v1/logs", get(handle_logs).post(|s, b| handle_bridge_body(s, "logs.set", json!({}), b)))
        .route("/v1/logs/frontend", get(|s| handle_bridge_get(s, "logs.frontend")))
        .route("/v1/window", get(|s| handle_bridge_get(s, "window.get"))
            .post(|s, b| handle_bridge_body(s, "window.set", json!({}), b)))
        // GET serves the cached entity image's bytes; POST (bridged) asks the
        // image worker to resolve one through the provider chain.
        .route("/v1/images/{kind}", get(handle_image).post(handle_image_fetch))
        .route("/v1/info/entity", get(|s, q| handle_bridge_query(s, "info.get", q)))
        .route("/v1/info/fetch", post(|s, b| handle_bridge_body_slow(s, "info.fetch", b)))
        .route("/v1/lyrics", get(|s, q| handle_bridge_query_slow(s, "lyrics.get", q)))
        .route("/v1/artists/{id}/tracks", get(handle_artist_tracks))
        .route("/v1/artists/{id}/albums", get(handle_artist_albums))
        .route("/v1/albums/{id}/tracks", get(handle_album_tracks))
        .route("/v1/tags/{id}/tracks", get(handle_tag_tracks))
        .route("/v1/picks", get(handle_picks))
        // Frontend-bridged (live queue / playback / mutations).
        .route("/v1/status", get(|s| handle_bridge_get(s, "status")))
        .route("/v1/search/providers", get(|s| handle_bridge_get(s, "search.providers")))
        .route("/v1/search/plugin", post(|s, b| handle_bridge_body_slow(s, "search.plugin", b)))
        .route("/v1/home/shelves", get(|s| handle_bridge_get(s, "home.shelves")))
        .route("/v1/home/shelf", post(|s, b| handle_bridge_body_slow(s, "home.shelf", b)))
        .route("/v1/home/play", post(|s, b| handle_bridge_body_slow(s, "home.play", b)))
        .route("/v1/actions", get(|s, q| handle_bridge_query(s, "actions.list", q)))
        .route("/v1/actions/invoke", post(|s, b| handle_bridge_body(s, "actions.invoke", json!({}), b)))
        .route("/v1/plugins/{id}/deep-link", post(|s, p, b| handle_extension_bridge(s, p, "plugins.deepLink", b)))
        .route("/v1/queue/play-search", post(|s, b| handle_bridge_body(s, "queue.playSearch", json!({}), b)))
        .route("/v1/queue", get(|s| handle_bridge_get(s, "queue.get")))
        .route("/v1/playback", post(|s, b| handle_bridge_body(s, "playback.set", json!({}), b)))
        .route("/v1/queue/play", post(|s, b| handle_bridge_body(s, "queue.play", json!({}), b)))
        .route("/v1/queue/tracks", post(|s, b| handle_bridge_body(s, "queue.add", json!({}), b))
            .delete(|s, b| handle_bridge_body(s, "queue.remove", json!({}), b)))
        .route("/v1/queue/clear", post(|s, b| handle_bridge_body(s, "queue.clear", json!({}), b)))
        .route("/v1/queue/jump", post(|s, b| handle_bridge_body(s, "queue.jump", json!({}), b)))
        .route("/v1/queue/randomize", post(|s, b| handle_bridge_body(s, "queue.randomize", json!({}), b)))
        .route("/v1/radio", post(|s, b| handle_bridge_body(s, "radio.start", json!({}), b)))
        .route("/v1/likes", post(|s, b| handle_bridge_body(s, "likes.set", json!({}), b)))
        .route("/v1/tracks/{id}/tags", post(|s, p, b| handle_track_bridge(s, p, "tags.edit", b)))
        // Extensions & skins: list / enable-disable / update check / apply skin.
        // Install and delete are deliberate NON-goals — see the module doc.
        .route("/v1/extensions", get(|s| handle_bridge_get(s, "extensions.list")))
        // Static before param: matchit gives "gallery" priority over "{id}".
        .route("/v1/extensions/gallery", get(|s| handle_bridge_get_slow(s, "extensions.gallery")))
        .route("/v1/extensions/check-updates", post(|s, b| handle_bridge_body(s, "extensions.checkUpdates", json!({}), b)))
        .route("/v1/extensions/{id}", get(|s, p| handle_extension_get(s, p, "extensions.get")))
        .route("/v1/extensions/{id}/enabled", post(|s, p, b| handle_extension_bridge(s, p, "extensions.setEnabled", b)))
        .route("/v1/skins/apply", post(|s, b| handle_bridge_body(s, "skins.apply", json!({}), b)))
        .layer(middleware::from_fn_with_state(auth_state, auth_middleware))
        .with_state(state)
}

/// Bearer-token gate on every route. `OPTIONS` is refused outright and no
/// `Access-Control-*` header is ever emitted — see the module doc.
async fn auth_middleware(
    AxumState(state): AxumState<ServerState>,
    req: Request,
    next: Next,
) -> Response {
    if req.method() == Method::OPTIONS {
        return error_response(StatusCode::METHOD_NOT_ALLOWED, "no preflight");
    }
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let authorized = presented.map(|t| state.api.token_matches(t)).unwrap_or(false);
    if !authorized {
        // The token itself is never logged.
        log::warn!("Control API: unauthorized request to {}", req.uri().path());
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    next.run(req).await
}

// --- Backend-direct handlers ---

/// Run a blocking DB read off the async worker and serialize the result.
async fn db_read<T, F>(db: Arc<Database>, f: F) -> Response
where
    T: Serialize + Send + 'static,
    F: FnOnce(&Database) -> Result<T, String> + Send + 'static,
{
    let outcome = tokio::task::spawn_blocking(move || f(&db)).await;
    match outcome {
        Ok(Ok(value)) => axum::Json(value).into_response(),
        Ok(Err(e)) => error_response(StatusCode::BAD_REQUEST, e),
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn handle_health(AxumState(state): AxumState<ServerState>) -> Response {
    axum::Json(json!({
        "ok": true,
        "version": state.version,
        "profile": state.profile,
        "pid": std::process::id(),
    }))
    .into_response()
}

#[derive(serde::Deserialize)]
struct SearchParams {
    q: String,
    #[serde(rename = "type")]
    kind: Option<String>,
    limit: Option<i64>,
}

async fn handle_search(
    AxumState(state): AxumState<ServerState>,
    Query(params): Query<SearchParams>,
) -> Response {
    let limit = params.limit.unwrap_or(20).clamp(1, 200);
    let kind = params.kind.unwrap_or_else(|| "all".to_string());
    let query = params.q;
    match kind.as_str() {
        "all" => {
            db_read(state.db.clone(), move |db| {
                db.search_all(&query, limit, limit, limit).map_err(|e| e.to_string())
            })
            .await
        }
        "track" | "artist" | "album" | "tag" => {
            // The DB layer addresses entities by their plural table-ish names.
            let entity = format!("{}s", kind);
            db_read(state.db.clone(), move |db| {
                let opts = TrackQuery { limit: Some(limit), ..Default::default() };
                db.search_entity(&query, &entity, &opts).map_err(|e| e.to_string())
            })
            .await
        }
        other => error_response(
            StatusCode::BAD_REQUEST,
            format!("unknown search type \"{}\" (use all|track|artist|album|tag)", other),
        ),
    }
}

async fn handle_get_track(
    AxumState(state): AxumState<ServerState>,
    AxumPath(id): AxumPath<i64>,
) -> Response {
    db_read(state.db.clone(), move |db| {
        db.get_track_by_id(id).map_err(|e| e.to_string())
    })
    .await
}

async fn handle_get_playlists(AxumState(state): AxumState<ServerState>) -> Response {
    db_read(state.db.clone(), |db| db.get_playlists().map_err(|e| e.to_string())).await
}

async fn handle_get_playlist_tracks(
    AxumState(state): AxumState<ServerState>,
    AxumPath(id): AxumPath<i64>,
) -> Response {
    db_read(state.db.clone(), move |db| {
        db.get_playlist_tracks(id).map_err(|e| e.to_string())
    })
    .await
}

async fn handle_artist_tracks(
    AxumState(state): AxumState<ServerState>,
    AxumPath(id): AxumPath<i64>,
) -> Response {
    db_read(state.db.clone(), move |db| {
        db.get_tracks_by_artist(id).map_err(|e| e.to_string())
    })
    .await
}

async fn handle_artist_albums(
    AxumState(state): AxumState<ServerState>,
    AxumPath(id): AxumPath<i64>,
) -> Response {
    db_read(state.db.clone(), move |db| {
        db.get_albums_sorted(Some(id), None, false, None, None).map_err(|e| e.to_string())
    })
    .await
}

/// The album's tracks in stored (track-number) order — the same query the
/// album detail page runs (`get_tracks { albumId }` with the default sort).
async fn handle_album_tracks(
    AxumState(state): AxumState<ServerState>,
    AxumPath(id): AxumPath<i64>,
) -> Response {
    db_read(state.db.clone(), move |db| {
        let opts = TrackQuery { album_id: Some(id), ..Default::default() };
        db.get_tracks(&opts).map_err(|e| e.to_string())
    })
    .await
}

async fn handle_tag_tracks(
    AxumState(state): AxumState<ServerState>,
    AxumPath(id): AxumPath<i64>,
) -> Response {
    db_read(state.db.clone(), move |db| {
        db.get_tracks_by_tag(id).map_err(|e| e.to_string())
    })
    .await
}

/// Collections with their stats, minus credentials: `username` is dropped (and
/// the password fields are never selected by `get_collections` at all) — a
/// caller picking a collection to rescan needs identity and freshness, not the
/// server login.
async fn handle_get_collections(AxumState(state): AxumState<ServerState>) -> Response {
    db_read(state.db.clone(), |db| {
        let collections = db.get_collections().map_err(|e| e.to_string())?;
        let stats = db.get_collection_stats().map_err(|e| e.to_string())?;
        Ok(collections
            .into_iter()
            .map(|c| {
                let s = stats.iter().find(|s| s.collection_id == c.id);
                json!({
                    "id": c.id,
                    "kind": c.kind,
                    "name": c.name,
                    "path": c.path,
                    "url": c.url,
                    "enabled": c.enabled,
                    "auto_update": c.auto_update,
                    "auto_update_interval_mins": c.auto_update_interval_mins,
                    "last_synced_at": c.last_synced_at,
                    "last_sync_duration_secs": c.last_sync_duration_secs,
                    "last_sync_error": c.last_sync_error,
                    "track_count": s.map(|s| s.track_count).unwrap_or(0),
                    "video_count": s.map(|s| s.video_count).unwrap_or(0),
                    "total_size": s.map(|s| s.total_size).unwrap_or(0),
                    "total_duration_secs": s.map(|s| s.total_duration).unwrap_or(0.0),
                })
            })
            .collect::<Vec<_>>())
    })
    .await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InfoSearchParams {
    q: String,
    type_id: Option<String>,
    display_kind: Option<String>,
    entity: Option<String>,
    resolve_tracks: Option<bool>,
    limit: Option<i64>,
}

/// Substring search across the CACHED plugin info values (lyrics, bios,
/// reviews, similar lists…) — the same store `api.informationTypes.searchValues`
/// serves. Cached-only: nothing here triggers a live provider fetch.
async fn handle_info_search(
    AxumState(state): AxumState<ServerState>,
    Query(params): Query<InfoSearchParams>,
) -> Response {
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    db_read(state.db.clone(), move |db| {
        db.search_information_values(
            &params.q,
            params.type_id.as_deref(),
            params.display_kind.as_deref(),
            params.entity.as_deref(),
            None,
            params.resolve_tracks.unwrap_or(false),
            limit,
        )
        .map_err(|e| e.to_string())
    })
    .await
}

#[derive(serde::Deserialize)]
struct PicksParams {
    kind: String,
    limit: Option<i64>,
}

/// Curated track lists the Home surface already draws from: the durable liked
/// set, never-played tracks, and often-played-but-not-recently favorites.
async fn handle_picks(
    AxumState(state): AxumState<ServerState>,
    Query(params): Query<PicksParams>,
) -> Response {
    let limit = params.limit.unwrap_or(50).clamp(1, 500);
    match params.kind.as_str() {
        "liked" => {
            db_read(state.db.clone(), move |db| {
                db.get_liked_tracks().map(|mut t| {
                    t.truncate(limit as usize);
                    t
                }).map_err(|e| e.to_string())
            })
            .await
        }
        "never_played" => {
            db_read(state.db.clone(), move |db| {
                db.pick_never_played_tracks(limit as u32).map_err(|e| e.to_string())
            })
            .await
        }
        "forgotten_favorites" => {
            db_read(state.db.clone(), move |db| {
                db.pick_forgotten_favorites(limit as u32).map_err(|e| e.to_string())
            })
            .await
        }
        other => error_response(
            StatusCode::BAD_REQUEST,
            format!("unknown picks kind \"{}\" (use liked|never_played|forgotten_favorites)", other),
        ),
    }
}

#[derive(serde::Deserialize)]
struct HistoryParams {
    kind: Option<String>,
    limit: Option<i64>,
}

async fn handle_history(
    AxumState(state): AxumState<ServerState>,
    Query(params): Query<HistoryParams>,
) -> Response {
    let limit = params.limit.unwrap_or(20).clamp(1, 200);
    match params.kind.as_deref().unwrap_or("recent") {
        "recent" => {
            db_read(state.db.clone(), move |db| {
                db.get_history_recent(limit).map_err(|e| e.to_string())
            })
            .await
        }
        "most_played" => {
            db_read(state.db.clone(), move |db| {
                db.get_history_most_played(limit).map_err(|e| e.to_string())
            })
            .await
        }
        other => error_response(
            StatusCode::BAD_REQUEST,
            format!("unknown history kind \"{}\" (use recent|most_played)", other),
        ),
    }
}

#[derive(serde::Deserialize)]
struct TagsParams {
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn handle_tags(
    AxumState(state): AxumState<ServerState>,
    Query(params): Query<TagsParams>,
) -> Response {
    db_read(state.db.clone(), move |db| {
        db.get_tags(params.limit, params.offset).map_err(|e| e.to_string())
    })
    .await
}

// --- Bridged handlers ---

/// Parse an optional JSON request body. Empty body → the provided base, so
/// `curl -X POST` with no `-d` works for verbs that take no arguments.
fn parse_body(base: Value, body: &Bytes) -> Result<Value, String> {
    if body.is_empty() {
        return Ok(base);
    }
    let parsed: Value =
        serde_json::from_slice(body).map_err(|e| format!("invalid JSON body: {}", e))?;
    if !parsed.is_object() {
        return Err("request body must be a JSON object".to_string());
    }
    // Body fields win over the base; path-derived fields are merged by callers
    // after this, so a body can never spoof a path parameter.
    Ok(parsed)
}

async fn handle_bridge_get(state: AxumState<ServerState>, verb: &'static str) -> Response {
    let timeout = state.0.bridge_timeout;
    bridge(&state.0, verb, json!({}), timeout).await
}

/// GET bridge with the long wait — for verbs whose cold path is a network
/// fetch (the extension galleries; TTL-cached, so usually instant).
async fn handle_bridge_get_slow(state: AxumState<ServerState>, verb: &'static str) -> Response {
    let timeout = state.0.bridge_timeout.saturating_mul(7);
    bridge(&state.0, verb, json!({}), timeout).await
}

async fn handle_bridge_body(
    state: AxumState<ServerState>,
    verb: &'static str,
    base: Value,
    body: Bytes,
) -> Response {
    let timeout = state.0.bridge_timeout;
    match parse_body(base, &body) {
        Ok(payload) => bridge(&state.0, verb, payload, timeout).await,
        Err(e) => error_response(StatusCode::BAD_REQUEST, e),
    }
}

/// Body-bridge with the long wait (7× the base — 70s in production, scaled the
/// same way under test) for verbs that legitimately run for tens of seconds:
/// plugin catalog search (the host's own `invokePluginSearch` allows 60s), an
/// info fetch walking a provider chain, a home-shelf resolve that scrapes.
async fn handle_bridge_body_slow(
    state: AxumState<ServerState>,
    verb: &'static str,
    body: Bytes,
) -> Response {
    let timeout = state.0.bridge_timeout.saturating_mul(7);
    match parse_body(json!({}), &body) {
        Ok(payload) => bridge(&state.0, verb, payload, timeout).await,
        Err(e) => error_response(StatusCode::BAD_REQUEST, e),
    }
}

/// Bridge a GET's query params as the verb payload (all values arrive as
/// strings; the dispatcher validates semantics).
fn query_payload(params: HashMap<String, String>) -> Value {
    let mut payload = serde_json::Map::new();
    for (k, v) in params {
        payload.insert(k, Value::String(v));
    }
    Value::Object(payload)
}

async fn handle_bridge_query(
    state: AxumState<ServerState>,
    verb: &'static str,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let timeout = state.0.bridge_timeout;
    bridge(&state.0, verb, query_payload(params), timeout).await
}

/// Query-param bridge with the long wait — for GET verbs that may walk a
/// provider chain (lyrics on a cache miss).
async fn handle_bridge_query_slow(
    state: AxumState<ServerState>,
    verb: &'static str,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let timeout = state.0.bridge_timeout.saturating_mul(7);
    bridge(&state.0, verb, query_payload(params), timeout).await
}

/// The backend log tail (same reader "Report a problem" uses), home directory
/// scrubbed to `~` — usernames leak into every path in a log, and an assistant
/// may relay these lines into an issue or a chat.
async fn handle_logs(AxumState(state): AxumState<ServerState>) -> Response {
    let log_path = state.app_dir.join("logs").join("viboplr.log");
    let logging_enabled = log_path.exists();
    let lines = if logging_enabled {
        tokio::task::spawn_blocking(move || crate::commands::read_log_tail(&log_path))
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok();
    let scrubbed: Vec<String> = match home.as_deref().filter(|h| !h.is_empty()) {
        Some(h) => lines.into_iter().map(|l| l.replace(h, "~")).collect(),
        None => lines,
    };
    axum::Json(json!({
        "loggingEnabled": logging_enabled,
        "note": if logging_enabled { "log file is truncated on every app launch" }
                else { "file logging is off — POST /v1/logs {\"enabled\": true} (takes effect on the next app launch)" },
        "lines": scrubbed,
    }))
    .into_response()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageParams {
    name: String,
    artist_name: Option<String>,
}

/// Serve the cached entity image's bytes. The path is resolved from backend
/// state (slug + image dir) — the caller never names a filesystem path.
async fn handle_image(
    AxumState(state): AxumState<ServerState>,
    AxumPath(kind): AxumPath<String>,
    Query(params): Query<ImageParams>,
) -> Response {
    if !matches!(kind.as_str(), "artist" | "album" | "tag") {
        return error_response(StatusCode::BAD_REQUEST, "kind must be artist, album or tag");
    }
    let slug = crate::entity_image::entity_image_slug(&kind, &params.name, params.artist_name.as_deref());
    let Some(path) = crate::entity_image::get_image_path(&state.app_dir, &kind, &slug) else {
        return error_response(
            StatusCode::NOT_FOUND,
            "no cached image — POST /v1/images/{kind} to resolve one, then retry",
        );
    };
    let content_type = match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        _ => "application/octet-stream",
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, content_type), (header::CACHE_CONTROL, "no-cache")],
            bytes,
        )
            .into_response(),
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, format!("failed to read image: {}", e)),
    }
}

/// Ask the image worker to resolve an image through the provider chain
/// (bridged — the frontend invokes the same fetch commands the UI buttons do).
async fn handle_image_fetch(
    state: AxumState<ServerState>,
    AxumPath(kind): AxumPath<String>,
    body: Bytes,
) -> Response {
    let timeout = state.0.bridge_timeout;
    match parse_body(json!({}), &body) {
        Ok(mut payload) => {
            payload["kind"] = json!(kind);
            bridge(&state.0, "images.fetch", payload, timeout).await
        }
        Err(e) => error_response(StatusCode::BAD_REQUEST, e),
    }
}

async fn handle_playlist_bridge(
    state: AxumState<ServerState>,
    path: AxumPath<i64>,
    verb: &'static str,
    body: Bytes,
) -> Response {
    let timeout = state.0.bridge_timeout;
    match parse_body(json!({}), &body) {
        Ok(mut payload) => {
            payload["playlistId"] = json!(path.0);
            bridge(&state.0, verb, payload, timeout).await
        }
        Err(e) => error_response(StatusCode::BAD_REQUEST, e),
    }
}

async fn handle_collection_bridge(
    state: AxumState<ServerState>,
    path: AxumPath<i64>,
    verb: &'static str,
    body: Bytes,
) -> Response {
    let timeout = state.0.bridge_timeout;
    match parse_body(json!({}), &body) {
        Ok(mut payload) => {
            payload["collectionId"] = json!(path.0);
            bridge(&state.0, verb, payload, timeout).await
        }
        Err(e) => error_response(StatusCode::BAD_REQUEST, e),
    }
}

async fn handle_track_bridge(
    state: AxumState<ServerState>,
    path: AxumPath<i64>,
    verb: &'static str,
    body: Bytes,
) -> Response {
    let timeout = state.0.bridge_timeout;
    match parse_body(json!({}), &body) {
        Ok(mut payload) => {
            payload["trackId"] = json!(path.0);
            bridge(&state.0, verb, payload, timeout).await
        }
        Err(e) => error_response(StatusCode::BAD_REQUEST, e),
    }
}

/// Plugin ids are directory names (strings); the dispatcher validates against
/// the installed set, this only bounds the obvious junk.
/// GET counterpart of `handle_extension_bridge` — the path parameter is the
/// whole payload (`{pluginId}`), no body to parse.
async fn handle_extension_get(
    state: AxumState<ServerState>,
    path: AxumPath<String>,
    verb: &'static str,
) -> Response {
    if path.0.is_empty() || path.0.len() > 200 {
        return error_response(StatusCode::BAD_REQUEST, "invalid extension id");
    }
    let timeout = state.0.bridge_timeout;
    bridge(&state.0, verb, json!({ "pluginId": path.0 }), timeout).await
}

async fn handle_extension_bridge(
    state: AxumState<ServerState>,
    path: AxumPath<String>,
    verb: &'static str,
    body: Bytes,
) -> Response {
    if path.0.is_empty() || path.0.len() > 200 {
        return error_response(StatusCode::BAD_REQUEST, "invalid extension id");
    }
    let timeout = state.0.bridge_timeout;
    match parse_body(json!({}), &body) {
        Ok(mut payload) => {
            payload["pluginId"] = json!(path.0);
            bridge(&state.0, verb, payload, timeout).await
        }
        Err(e) => error_response(StatusCode::BAD_REQUEST, e),
    }
}

/// Round-trip one request through the webview dispatcher. `timeout` is the
/// route's wait budget — `state.bridge_timeout` for everything except the
/// long-running plugin search (see `handle_search_plugin`).
async fn bridge(state: &ServerState, verb: &str, payload: Value, timeout: Duration) -> Response {
    if !state.api.webview_ready.load(Ordering::Acquire) {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "app still starting");
    }
    let id = state.api.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    state.api.pending.lock().unwrap().insert(id, tx);

    (state.emit)(&ControlRequest {
        id,
        verb: verb.to_string(),
        payload,
    });

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(Ok(result))) => axum::Json(result).into_response(),
        Ok(Ok(Err(message))) => error_response(StatusCode::BAD_REQUEST, message),
        // Sender dropped without answering — shouldn't happen, but don't hang.
        Ok(Err(_)) => error_response(StatusCode::INTERNAL_SERVER_ERROR, "dispatcher dropped the request"),
        Err(_) => {
            state.api.pending.lock().unwrap().remove(&id);
            error_response(StatusCode::GATEWAY_TIMEOUT, "app did not respond")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    const TEST_TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn test_state(emit: Arc<dyn Fn(&ControlRequest) + Send + Sync>) -> ServerState {
        let api = Arc::new(ControlApi::default());
        *api.token.lock().unwrap() = Some(TEST_TOKEN.to_string());
        api.mark_webview_ready();
        ServerState {
            db: Arc::new(Database::new_in_memory().expect("in-memory db")),
            api,
            emit,
            bridge_timeout: Duration::from_millis(50),
            version: "0.0.0-test".to_string(),
            profile: "test".to_string(),
            app_dir: std::env::temp_dir(),
        }
    }

    fn noop_emit() -> Arc<dyn Fn(&ControlRequest) + Send + Sync> {
        Arc::new(|_| {})
    }

    fn request(method: &str, path: &str, token: Option<&str>) -> HttpRequest<Body> {
        let mut builder = HttpRequest::builder().method(method).uri(path);
        if let Some(t) = token {
            builder = builder.header("Authorization", format!("Bearer {}", t));
        }
        builder.body(Body::empty()).unwrap()
    }

    async fn body_json(response: Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn test_health_answers_with_token() {
        let router = build_router(test_state(noop_emit()));
        let res = router
            .oneshot(request("GET", "/v1/health", Some(TEST_TOKEN)))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let json = body_json(res).await;
        assert_eq!(json["ok"], json!(true));
        assert_eq!(json["profile"], json!("test"));
    }

    #[tokio::test]
    async fn test_missing_or_wrong_token_is_401() {
        let router = build_router(test_state(noop_emit()));
        let res = router
            .clone()
            .oneshot(request("GET", "/v1/health", None))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let res = router
            .oneshot(request("GET", "/v1/health", Some("wrong")))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_options_is_refused_with_no_cors_headers() {
        let router = build_router(test_state(noop_emit()));
        let res = router
            .oneshot(request("OPTIONS", "/v1/health", None))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert!(res
            .headers()
            .iter()
            .all(|(name, _)| !name.as_str().starts_with("access-control-")));
    }

    #[tokio::test]
    async fn test_search_hits_the_db() {
        let state = test_state(noop_emit());
        state.db.get_or_create_artist("Bridge Artist").unwrap();
        let col = state
            .db
            .add_collection("local", "Test", Some("/test"), None, None, None, None, None)
            .unwrap();
        let artist_id = state.db.get_or_create_artist("Bridge Artist").unwrap();
        state
            .db
            .upsert_track(
                "a.mp3", "Bridge Song", Some(artist_id), None, None,
                Some(200.0), Some("mp3"), None, None, Some(col.id), None,
            )
            .unwrap();
        state.db.rebuild_fts().unwrap();

        let router = build_router(state);
        let res = router
            .oneshot(request("GET", "/v1/search?q=Bridge&type=track", Some(TEST_TOKEN)))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let json = body_json(res).await;
        let tracks = json["tracks"].as_array().expect("tracks array");
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0]["title"], json!("Bridge Song"));
    }

    #[tokio::test]
    async fn test_collections_list_never_carries_credentials() {
        let state = test_state(noop_emit());
        state
            .db
            .add_collection(
                "subsonic",
                "Navi",
                None,
                Some("https://music.example"),
                Some("alex"),
                Some("secret-token"),
                Some("salt"),
                None,
            )
            .expect("seed collection");
        let router = build_router(state);
        let res = router
            .oneshot(request("GET", "/v1/collections", Some(TEST_TOKEN)))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let json = body_json(res).await;
        let row = &json[0];
        assert_eq!(row["name"], json!("Navi"));
        assert_eq!(row["kind"], json!("subsonic"));
        assert_eq!(row["track_count"], json!(0));
        // The whole reason this endpoint maps fields by hand:
        assert!(row.get("username").is_none(), "username must not be exposed");
        let raw = serde_json::to_string(&json).unwrap();
        assert!(!raw.contains("secret-token"), "credentials must not be exposed");
    }

    #[tokio::test]
    async fn test_collection_rescan_bridges_with_the_path_id() {
        let api_slot: Arc<Mutex<Option<Arc<ControlApi>>>> = Arc::new(Mutex::new(None));
        let responder_slot = Arc::clone(&api_slot);
        let state = test_state(Arc::new(move |req: &ControlRequest| {
            if let Some(api) = responder_slot.lock().unwrap().clone() {
                api.respond(req.id, true, json!({ "verb": req.verb, "payload": req.payload }));
            }
        }));
        *api_slot.lock().unwrap() = Some(Arc::clone(&state.api));

        let router = build_router(state);
        let res = router
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/v1/collections/7/rescan")
                    .header("Authorization", format!("Bearer {}", TEST_TOKEN))
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"full":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let json = body_json(res).await;
        assert_eq!(json["verb"], json!("collections.rescan"));
        assert_eq!(json["payload"]["collectionId"], json!(7));
        assert_eq!(json["payload"]["full"], json!(true));
    }

    #[tokio::test]
    async fn test_bridged_route_times_out_as_504_when_nothing_responds() {
        let router = build_router(test_state(noop_emit()));
        let res = router
            .oneshot(request("GET", "/v1/status", Some(TEST_TOKEN)))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::GATEWAY_TIMEOUT);
    }

    #[tokio::test]
    async fn test_bridged_route_returns_the_dispatchers_answer() {
        // Fake frontend: answer every emitted request immediately.
        let api_slot: Arc<Mutex<Option<Arc<ControlApi>>>> = Arc::new(Mutex::new(None));
        let responder_slot = Arc::clone(&api_slot);
        let state = test_state(Arc::new(move |req: &ControlRequest| {
            if let Some(api) = responder_slot.lock().unwrap().clone() {
                api.respond(req.id, true, json!({ "echo": req.verb }));
            }
        }));
        *api_slot.lock().unwrap() = Some(Arc::clone(&state.api));

        let router = build_router(state);
        let res = router
            .oneshot(request("GET", "/v1/queue", Some(TEST_TOKEN)))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await, json!({ "echo": "queue.get" }));
    }

    #[tokio::test]
    async fn test_bridged_route_is_503_before_the_webview_is_ready() {
        let state = test_state(noop_emit());
        state.api.webview_ready.store(false, Ordering::Release);
        let router = build_router(state);
        let res = router
            .oneshot(request("GET", "/v1/status", Some(TEST_TOKEN)))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn test_dispatcher_error_surfaces_as_400() {
        let api_slot: Arc<Mutex<Option<Arc<ControlApi>>>> = Arc::new(Mutex::new(None));
        let responder_slot = Arc::clone(&api_slot);
        let state = test_state(Arc::new(move |req: &ControlRequest| {
            if let Some(api) = responder_slot.lock().unwrap().clone() {
                api.respond(req.id, false, json!("bad indices"));
            }
        }));
        *api_slot.lock().unwrap() = Some(Arc::clone(&state.api));

        let router = build_router(state);
        let res = router
            .oneshot(request("GET", "/v1/status", Some(TEST_TOKEN)))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(res).await, json!({ "error": "bad indices" }));
    }

    #[test]
    fn test_late_respond_after_timeout_is_a_noop() {
        let api = ControlApi::default();
        // No pending entry with this id — must not panic or insert anything.
        api.respond(42, true, json!({}));
        assert!(api.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn test_path_param_cannot_be_spoofed_by_the_body() {
        // parse_body keeps body fields, then the caller overwrites the path
        // param — simulate that order here.
        let body = Bytes::from(r#"{"playlistId": 999, "trackIds": [1]}"#);
        let mut payload = parse_body(json!({}), &body).unwrap();
        payload["playlistId"] = json!(7);
        assert_eq!(payload["playlistId"], json!(7));
        assert_eq!(payload["trackIds"], json!([1]));
    }

    #[test]
    fn test_empty_body_falls_back_to_base() {
        assert_eq!(parse_body(json!({}), &Bytes::new()).unwrap(), json!({}));
        assert!(parse_body(json!({}), &Bytes::from("not json")).is_err());
        assert!(parse_body(json!({}), &Bytes::from("[1,2]")).is_err());
    }

    #[test]
    fn test_discovery_token_roundtrip_and_validation() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_discovery_token(dir.path()).is_none());

        write_discovery_file(dir.path(), 1234, TEST_TOKEN, "default").unwrap();
        assert_eq!(read_discovery_token(dir.path()), Some(TEST_TOKEN.to_string()));

        // A malformed token in the file is rejected (forces regeneration).
        std::fs::write(
            discovery_path(dir.path()),
            r#"{"token": "short"}"#,
        )
        .unwrap();
        assert!(read_discovery_token(dir.path()).is_none());

        remove_discovery_file(dir.path());
        assert!(read_discovery_token(dir.path()).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn test_discovery_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        write_discovery_file(dir.path(), 1234, TEST_TOKEN, "default").unwrap();
        let mode = std::fs::metadata(discovery_path(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn test_token_matches_rejects_absent_token() {
        let api = ControlApi::default();
        assert!(!api.token_matches("anything"));
        *api.token.lock().unwrap() = Some(TEST_TOKEN.to_string());
        assert!(api.token_matches(TEST_TOKEN));
        assert!(!api.token_matches("aaaa"));
    }
}
