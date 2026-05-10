# FFmpeg Transcoding Server Design

## Problem

The WebView's `<video>` element only supports codecs native to the platform's browser engine. On macOS (WKWebView/WebKit), VP8/VP9/WebM and containers like MKV/AVI/WMV are unsupported. On Windows (WebView2/Chromium), MKV and AVI are unsupported. Users with video files in these formats cannot play them.

## Solution

A local HTTP server in Rust that spawns ffmpeg to transcode unsupported video files into fragmented MP4 (H.264 + AAC) on-the-fly, streamed directly to the `<video>` element via `http://localhost:<port>`. Files in natively-supported formats continue using `convertFileSrc()` as before.

Seeking uses fast input seek (`-ss` before `-i`) which restarts ffmpeg at the target position with ~100-200ms latency.

## Supported Formats

**Native (no transcoding):** mp4, m4v, mov, webm (Windows only for webm)

**Transcoded via ffmpeg:** mkv, avi, wmv

## Architecture

### Transcode Server (`src-tauri/src/transcode_server.rs`)

A local HTTP server using `axum` bound to `127.0.0.1:0` (OS assigns a free port). Started once at app launch from `lib.rs`. Port stored in `AppState`.

#### Endpoints

| Route | Purpose |
|-------|---------|
| `GET /stream/:session_id?seek=<secs>` | Streams transcoded fMP4. `seek` param (default 0) sets ffmpeg start position. |

#### Session Management

- `start_transcode(path: String) -> TranscodeInfo` Tauri command creates a session, returns `{ url, sessionId }`
- Sessions stored in `HashMap<String, TranscodeSession>` behind `Arc<Mutex<_>>`
- `TranscodeSession` holds: file path, current ffmpeg `Child` handle
- On each request to `/stream/:id?seek=N`: kills existing ffmpeg child (if any), spawns new one at position N, streams stdout as chunked response
- `stop_transcode(session_id: String)` Tauri command kills process and removes session

#### FFmpeg Command

```
ffmpeg -ss <seek_secs> -i <input_path> \
  -c:v libx264 -preset veryfast -crf 23 \
  -c:a aac -b:a 192k \
  -movflags frag_keyframe+empty_moov+default_base_moof \
  -f mp4 pipe:1
```

Key flags:
- `-ss` before `-i`: fast input seek (demuxer-level, jumps to nearest keyframe)
- `-preset veryfast`: low CPU encode latency
- `-movflags frag_keyframe+empty_moov+default_base_moof`: fragmented MP4 streamable from byte 0
- `pipe:1`: output to stdout for direct HTTP streaming

### Frontend Changes

#### URL Resolution (`resolveTrackSrcRef` in App.tsx)

For `file://` video tracks:
1. If format is in `NATIVE_VIDEO_FORMATS` → `convertFileSrc()` (unchanged)
2. If format is in `TRANSCODE_VIDEO_FORMATS` → `invoke("start_transcode", { path })` → use returned URL

Constant definitions:
```typescript
const NATIVE_VIDEO_FORMATS = ["mp4", "m4v", "mov"]; // + webm on Windows
const TRANSCODE_VIDEO_FORMATS = ["mkv", "avi", "wmv"];
```

#### Seek Behavior

For transcoded videos, seeking cannot use `video.currentTime` directly (the stream is not seekable by byte range). Instead:

1. User drags seek bar → compute target time in seconds
2. Re-set `video.src` to the same stream URL with `?seek=<targetSecs>`
3. Video element freezes on last frame during the ~100-200ms ffmpeg restart
4. Playback resumes automatically from the new position

Track whether the current video is transcoded via a ref (`isTranscodedRef`) set during URL resolution.

#### Cleanup

When the track changes away from a transcoded video or playback stops:
- Call `invoke("stop_transcode", { sessionId })`
- Clear `isTranscodedRef` and stored session ID

### Scanner Changes

**`src-tauri/src/scanner.rs`:** Add `"mkv"`, `"avi"`, `"wmv"` to `VIDEO_EXTENSIONS`. These are scanned with filename-based metadata parsing (same as existing video files — no tag reading via lofty).

**`src/utils.ts`:** Add `"mkv"`, `"avi"`, `"wmv"` to `VIDEO_FORMATS` so `isVideoTrack()` recognizes them.

### Graceful Degradation

The HTTP server always starts regardless of ffmpeg availability (it's near-zero cost when idle). The ffmpeg check happens at play time:

- `start_transcode` checks ffmpeg availability via `which ffmpeg` / `where ffmpeg`
- If ffmpeg is not found, returns an error
- Frontend surfaces: `addLog("ffmpeg required for MKV/AVI/WMV playback. Install ffmpeg to play this file.")`
- The track remains in the library but skips to the next track on play failure
- Native format videos are completely unaffected by ffmpeg availability

## Data Flow

```
User clicks play on .mkv file
  → resolveTrackSrcRef detects TRANSCODE_VIDEO_FORMATS
  → invoke("start_transcode", { path }) 
  → Rust creates session, returns { url: "http://127.0.0.1:PORT/stream/SESSION_ID", sessionId }
  → video.src = url (implicitly hits ?seek=0)
  → axum handler spawns ffmpeg, pipes stdout as chunked response
  → <video> plays fragmented MP4 stream

User seeks to 1:30
  → video.src = "http://127.0.0.1:PORT/stream/SESSION_ID?seek=90"
  → axum handler kills current ffmpeg, spawns new one with -ss 90
  → video freezes briefly, then resumes at 1:30

User switches to next track
  → invoke("stop_transcode", { sessionId })
  → Rust kills ffmpeg process, removes session
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| ffmpeg not installed | `addLog` warning, skip track |
| ffmpeg crashes mid-stream | `video.onerror` fires → `addLog("Transcoding failed")`, skip track |
| Corrupt/unreadable file | ffmpeg exits immediately → empty response → same as crash |
| Server port in use | OS assigns random port, not an issue with port 0 |

## Scope Boundaries

**In scope:**
- New Rust transcode server module
- Scanner extension for mkv/avi/wmv
- Frontend integration (URL resolution + seek override)
- Graceful ffmpeg detection

**Out of scope:**
- Subtitle extraction/rendering
- Audio-only transcoding (audio formats already handled)
- Quality/codec selection UI
- Pre-transcoding or caching transcoded output
- HLS/DASH segmentation
