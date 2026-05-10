# FFmpeg Transcode Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable playback of MKV, AVI, and WMV video files by live-transcoding them to fragmented MP4 via a local ffmpeg-backed HTTP server.

**Architecture:** A Rust module (`transcode_server.rs`) runs an axum HTTP server on `127.0.0.1:0` at app startup. When the frontend encounters an unsupported video format, it requests a transcode session via a Tauri command and plays from the local HTTP stream. Seeking re-hits the endpoint with a `?seek=N` query param, which restarts ffmpeg with `-ss N` before `-i`.

**Tech Stack:** Rust (axum, tokio), ffmpeg CLI (spawned as child process), TypeScript/React frontend

---

### Task 1: Add axum/tokio dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add axum and tokio to dependencies**

In `src-tauri/Cargo.toml`, add to `[dependencies]`:

```toml
axum = "0.8"
tokio = { version = "1", features = ["rt-multi-thread", "sync", "process", "io-util"] }
```

Note: Tauri 2 already uses tokio internally, but we need the `process` and `io-util` features for child process stdout streaming. The `axum` crate pulls in `hyper` and `tower` for the HTTP server.

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully with the new dependencies.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(transcode): add axum and tokio dependencies for local transcode server"
```

---

### Task 2: Create the transcode server module

**Files:**
- Create: `src-tauri/src/transcode_server.rs`

This module defines the HTTP server, session management, and ffmpeg spawning. It exports a `start()` function that returns the port.

- [ ] **Step 1: Write the transcode server module**

Create `src-tauri/src/transcode_server.rs`:

```rust
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
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

struct TranscodeSession {
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

type Sessions = Arc<Mutex<HashMap<String, TranscodeSession>>>;

#[derive(Clone)]
struct ServerState {
    sessions: Sessions,
}

#[derive(serde::Deserialize)]
struct StreamQuery {
    seek: Option<f64>,
}

fn ffmpeg_command() -> Command {
    let mut cmd = Command::new("ffmpeg");
    #[cfg(target_os = "macos")]
    {
        let current = std::env::var_os("PATH").unwrap_or_default();
        let extra_dirs: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
        let mut new_path = std::ffi::OsString::from(&current);
        for dir in extra_dirs {
            if !current.to_string_lossy().contains(dir) {
                new_path.push(":");
                new_path.push(dir);
            }
        }
        cmd.env("PATH", new_path);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
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
pub async fn start(sessions: Sessions) -> u16 {
    let state = ServerState { sessions };

    let app = Router::new()
        .route("/stream/{session_id}", get(handle_stream))
        .with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("Failed to bind transcode server");

    let port = listener.local_addr().unwrap().port();
    log::info!("Transcode server listening on 127.0.0.1:{}", port);

    tokio::spawn(async move {
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles. Might need `tokio-util` — if so, add it in the next step.

- [ ] **Step 3: Add tokio-util if needed**

If Step 2 fails with `unresolved import tokio_util`, add to `Cargo.toml`:

```toml
tokio-util = { version = "0.7", features = ["io"] }
```

Re-run: `cd src-tauri && cargo check`
Expected: Compiles successfully.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/transcode_server.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(transcode): add transcode_server module with axum HTTP streaming"
```

---

### Task 3: Integrate server startup and Tauri commands

**Files:**
- Modify: `src-tauri/src/lib.rs` (add `mod transcode_server`, start server in setup, store port in AppState)
- Modify: `src-tauri/src/commands.rs` (add `start_transcode` and `stop_transcode` commands, add `transcode_port` and `transcode_sessions` to AppState)

- [ ] **Step 1: Add transcode fields to AppState**

In `src-tauri/src/commands.rs`, add the `transcode_server` import and fields to `AppState`:

At the top of the file, add the import (after the existing `use` block):
```rust
use crate::transcode_server;
```

Add to `AppState` struct (after `cursor_tracker_active`):
```rust
    pub transcode_port: u16,
    pub transcode_sessions: transcode_server::Sessions,
```

Where `Sessions` is the type alias — expose it from `transcode_server.rs` by making the type public. It's already defined as `type Sessions = Arc<Mutex<HashMap<String, TranscodeSession>>>`. Change `TranscodeSession` visibility to `pub(crate)` and add a public type alias:

In `transcode_server.rs`, change:
```rust
type Sessions = Arc<Mutex<HashMap<String, TranscodeSession>>>;
```
to:
```rust
pub type Sessions = Arc<Mutex<HashMap<String, TranscodeSession>>>;
```

- [ ] **Step 2: Add Tauri commands for start/stop transcode**

In `src-tauri/src/commands.rs`, add the two new commands (at the end of the file, before any closing braces):

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeInfo {
    pub url: String,
    pub session_id: String,
}

#[tauri::command]
pub async fn start_transcode(
    state: State<'_, AppState>,
    path: String,
) -> Result<TranscodeInfo, String> {
    // Check ffmpeg availability
    let check = ffmpeg_check().await;
    if check.is_none() {
        return Err("ffmpeg is not installed. Install ffmpeg to play MKV/AVI/WMV files.".to_string());
    }

    let session_id = transcode_server::create_session(&state.transcode_sessions, path).await;
    let url = format!("http://127.0.0.1:{}/stream/{}?seek=0", state.transcode_port, session_id);

    Ok(TranscodeInfo { url, session_id })
}

#[tauri::command]
pub async fn stop_transcode(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    transcode_server::remove_session(&state.transcode_sessions, &session_id).await;
    Ok(())
}
```

- [ ] **Step 3: Register commands in lib.rs**

In `src-tauri/src/lib.rs`:

1. Add `mod transcode_server;` after the other module declarations (e.g., after `mod video_frames;`)

2. In the `setup` closure, before `manage_app_state`, start the transcode server:

```rust
let transcode_sessions: transcode_server::Sessions =
    Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
let transcode_port = timer.time("start_transcode_server", || {
    tauri::async_runtime::block_on(transcode_server::start(transcode_sessions.clone()))
});
```

3. Add `transcode_port` and `transcode_sessions` to the `AppState` constructor:

```rust
app.manage(AppState {
    // ... existing fields ...
    transcode_port,
    transcode_sessions,
});
```

4. Add the commands to both `get_invoke_handler()` functions (debug and release):

```rust
commands::start_transcode,
commands::stop_transcode,
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/src/transcode_server.rs
git commit -m "feat(transcode): integrate server startup and Tauri commands"
```

---

### Task 4: Extend scanner to recognize MKV/AVI/WMV

**Files:**
- Modify: `src-tauri/src/scanner.rs` (add formats to `VIDEO_EXTENSIONS`)
- Modify: `src/utils.ts` (add formats to `VIDEO_FORMATS`)

- [ ] **Step 1: Add formats to Rust scanner**

In `src-tauri/src/scanner.rs`, change line 18-19 from:

```rust
const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "webm",
];
```

to:

```rust
const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv",
];
```

- [ ] **Step 2: Add formats to TypeScript utils**

In `src/utils.ts`, change line 2 from:

```typescript
const VIDEO_FORMATS = ["mp4", "m4v", "mov", "webm"];
```

to:

```typescript
const VIDEO_FORMATS = ["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv"];
```

- [ ] **Step 3: Verify both compile**

Run: `cd src-tauri && cargo check`
Run: `npx tsc --noEmit`
Expected: Both pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/scanner.rs src/utils.ts
git commit -m "feat(transcode): extend scanner to recognize mkv, avi, wmv formats"
```

---

### Task 5: Frontend integration — route transcoded formats through server

**Files:**
- Modify: `src/App.tsx` (update `resolveTrackSrcRef` to detect transcoded formats and use the transcode server)
- Modify: `src/hooks/usePlayback.ts` (override seek for transcoded videos)

- [ ] **Step 1: Add transcode format constants and state to App.tsx**

Near the top of `App.tsx` (in the imports area or with other constants), add:

```typescript
const TRANSCODE_VIDEO_FORMATS = ["mkv", "avi", "wmv"];

function needsTranscode(track: { format: string | null }): boolean {
  return TRANSCODE_VIDEO_FORMATS.includes(track.format?.toLowerCase() ?? "");
}
```

Add state for the active transcode session near other playback-related state (around where `resolveTrackSrcRef` is defined):

```typescript
const transcodeSessionRef = useRef<{ sessionId: string; baseUrl: string } | null>(null);
```

- [ ] **Step 2: Update resolveTrackSrcRef to handle transcoded formats**

In `App.tsx`, inside the `resolveTrackSrcRef.current = async (track) => { ... }` assignment (around line 1286), modify the native resolver entry for `file://` tracks to check if transcoding is needed.

Find the section that pushes the native resolver (around line 1317-1322):
```typescript
} else {
  chain.push({ name: nativeResolverName(url), id: null, sourceUrl: url, resolve: () => resolveUrl(url) });
}
```

Replace it with:
```typescript
} else {
  chain.push({
    name: nativeResolverName(url),
    id: null,
    sourceUrl: url,
    resolve: async () => {
      const parsed = parseUrlScheme(url);
      if (parsed.scheme === "file" && needsTranscode(track)) {
        // Stop any previous transcode session
        if (transcodeSessionRef.current) {
          invoke("stop_transcode", { sessionId: transcodeSessionRef.current.sessionId }).catch(console.error);
        }
        const result = await invoke<{ url: string; sessionId: string }>("start_transcode", { path: parsed.path });
        transcodeSessionRef.current = { sessionId: result.sessionId, baseUrl: result.url.replace(/\?seek=.*$/, "") };
        return result.url;
      }
      return resolveUrl(url);
    },
  });
}
```

- [ ] **Step 3: Clean up transcode session on track change**

In `App.tsx`, find where track changes are handled. The `playback.handlePlay` is called from `usePlayback`. We need to clean up the session when a non-transcoded track starts or playback stops.

Add a `useEffect` that cleans up the transcode session when `playback.currentTrack` changes away from a transcoded format:

```typescript
useEffect(() => {
  if (transcodeSessionRef.current && (!playback.currentTrack || !needsTranscode(playback.currentTrack))) {
    invoke("stop_transcode", { sessionId: transcodeSessionRef.current.sessionId }).catch(console.error);
    transcodeSessionRef.current = null;
  }
}, [playback.currentTrack]);
```

- [ ] **Step 4: Override seek for transcoded videos**

In `src/hooks/usePlayback.ts`, the `handleSeek` function (around line 493) needs to handle transcoded videos differently. Since `usePlayback` doesn't know about transcode state, we'll pass a ref from App.tsx.

Add a new parameter to `usePlayback`:
```typescript
export function usePlayback(
  restoredRef: React.RefObject<boolean>,
  peekNextRef: React.RefObject<() => QueueTrack | null>,
  crossfadeSecsRef: React.RefObject<number>,
  advanceIndexRef: React.RefObject<() => void>,
  trackVideoHistoryRef: React.RefObject<boolean>,
  resolveTrackSrcRef: React.RefObject<(track: QueueTrack) => Promise<string>>,
  prefetchNextRef: React.RefObject<() => void>,
  transcodeSessionRef: React.RefObject<{ sessionId: string; baseUrl: string } | null>,
) {
```

Then modify `handleSeek` (line 493):

```typescript
function handleSeek(secs: number) {
  const el = getMediaElement();
  if (!el) return;

  // For transcoded videos, re-set the source URL with the new seek position
  if (transcodeSessionRef.current && currentTrack && isVideoTrack(currentTrack)) {
    const url = `${transcodeSessionRef.current.baseUrl}?seek=${secs}`;
    (el as HTMLVideoElement).src = url;
    (el as HTMLVideoElement).play().catch(console.error);
    setPositionSecs(secs);
    return;
  }

  el.currentTime = secs;
  setPositionSecs(secs);
}
```

Update the call site in `App.tsx` to pass the new ref:
```typescript
const playback = usePlayback(restoredRef, peekNextRef, crossfadeSecsRef, advanceIndexRef, trackVideoHistoryRef, resolveTrackSrcRef, prefetchNextRef, transcodeSessionRef);
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Run: `cd src-tauri && cargo check`
Expected: Both pass.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/hooks/usePlayback.ts
git commit -m "feat(transcode): route transcoded video formats through local server with seek support"
```

---

### Task 6: Handle errors and graceful degradation

**Files:**
- Modify: `src/App.tsx` (add error handling for ffmpeg not installed)

- [ ] **Step 1: Surface transcode errors via addLog**

The `start_transcode` command already returns an error string if ffmpeg is missing. In the resolver chain in `App.tsx`, the error will propagate through the normal resolver chain fallback. But if it's the only resolver and it fails, `onMediaError` will fire.

Add specific handling for the ffmpeg error message. In the resolver chain's `resolve` function for the transcode path (added in Task 5 Step 2), wrap in try-catch:

```typescript
resolve: async () => {
  const parsed = parseUrlScheme(url);
  if (parsed.scheme === "file" && needsTranscode(track)) {
    if (transcodeSessionRef.current) {
      invoke("stop_transcode", { sessionId: transcodeSessionRef.current.sessionId }).catch(console.error);
    }
    try {
      const result = await invoke<{ url: string; sessionId: string }>("start_transcode", { path: parsed.path });
      transcodeSessionRef.current = { sessionId: result.sessionId, baseUrl: result.url.replace(/\?seek=.*$/, "") };
      return result.url;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(msg, "playback");
      throw e;
    }
  }
  return resolveUrl(url);
},
```

The `addLog` call surfaces the "ffmpeg is not installed" message to the user in the session log. The thrown error falls through to the next resolver in the chain (if any), or triggers the standard playback error UI.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: Passes.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(transcode): surface ffmpeg-not-installed error via session log"
```

---

### Task 7: Test manually

**Files:** None (manual testing)

- [ ] **Step 1: Start dev server**

Run: `npm run tauri dev`
Expected: App launches. Check console for "Transcode server listening on 127.0.0.1:XXXXX" log line.

- [ ] **Step 2: Add a collection with MKV/AVI/WMV files**

If you don't have test files, create one with ffmpeg:
```bash
ffmpeg -f lavfi -i testsrc=duration=10:size=320x240 -c:v libx264 -f matroska ~/Desktop/test.mkv
```

Add a collection pointing to the directory containing the test file. Verify the file appears in the track list with format "mkv".

- [ ] **Step 3: Test playback**

Double-click the MKV file. Expected: video plays after a brief (~200ms) delay while ffmpeg starts and produces the first frames.

- [ ] **Step 4: Test seeking**

Click on the seek bar to jump to a different position. Expected: video freezes briefly (~100-200ms), then resumes at the new position.

- [ ] **Step 5: Test track switching**

Switch to a regular MP4 file. Expected: transcode session is cleaned up (no leftover ffmpeg processes). Verify with `ps aux | grep ffmpeg`.

- [ ] **Step 6: Test ffmpeg not installed (optional)**

Temporarily rename/hide ffmpeg binary, try to play an MKV. Expected: session log shows "ffmpeg is not installed..." message, track skips to next.
