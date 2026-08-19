//! Chunked HTTP relay for streams whose CDN refuses ordinary player requests.
//!
//! googlevideo URLs with `rqh=1` (all yt-dlp streams as of Aug 2026) 403 any
//! request that isn't a *bounded* `Range` — measured live: a no-`Range` GET
//! and the `<audio>` element's open-ended `bytes=0-` are refused outright,
//! while bounded chunks are served. The accepted chunk size and whether a
//! cold mid-file offset is allowed depend on the player client the URL was
//! minted for (VISIONOS URLs take 10 MiB chunks at any offset; the older
//! ANDROID_VR ones cap near 1 MiB and only ever serve a window advancing
//! from byte 0 at media pace — on those, deep seeks are impossible for
//! anyone, including yt-dlp itself).
//!
//! Engines therefore play `http://127.0.0.1/relay/{id}`: each request is
//! forwarded upstream as a run of bounded chunks starting at the client's
//! own offset, so seeks map to seeks. The chunk size steps down when the CDN
//! refuses one (1 MiB → 256 KiB → 64 KiB, remembered per session); a refusal
//! at the floor *after* progress is treated as pacing and waited out, while
//! a first-chunk refusal fails fast so the engine's retry ladder can act.
//! Nothing is buffered beyond the chunk in flight.

use axum::{
    Router,
    body::Body,
    extract::{Path, State as AxumState},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::AsyncWriteExt;

/// Chunk-size ladder. VISIONOS URLs take ≥10 MiB but the older client caps
/// near 1 MiB, so 1 MiB is the largest size that works everywhere observed;
/// 64 KiB was never refused anywhere.
const CHUNK_LADDER: [u64; 3] = [1024 * 1024, 256 * 1024, 64 * 1024];
/// Mid-stream refusals at the floor size are pacing (the CDN meters some URLs
/// to media rate): retry on this cadence for up to the stall cap, which is
/// what a paced-but-alive stream needs and short enough that a dead URL
/// (signed-URL expiry) still surfaces as a stream error promptly.
const PACING_RETRY: std::time::Duration = std::time::Duration::from_secs(2);
const PACING_STALL_CAP: std::time::Duration = std::time::Duration::from_secs(60);
/// Live relays kept around: current track + preload + crossfade + a video's
/// split audio, with slack. Sessions are just URL + headers; in-flight
/// readers hold the session `Arc` and finish unharmed after eviction.
const MAX_SESSIONS: usize = 6;

pub struct RelaySession {
    url: String,
    headers: Vec<(String, String)>,
    /// Ladder index that last worked — later requests skip rediscovery.
    chunk_idx: AtomicU64,
}

#[derive(Default)]
pub struct RelayMap {
    map: HashMap<String, Arc<RelaySession>>,
    order: VecDeque<String>,
    counter: u64,
}

pub type Relays = Arc<Mutex<RelayMap>>;

/// Register a stream and return the relay id for `/relay/{id}`.
pub fn register(relays: &Relays, url: String, headers: Vec<(String, String)>) -> String {
    let mut m = relays.lock().unwrap();
    m.counter += 1;
    let id = format!("rl-{}", m.counter);
    while m.order.len() >= MAX_SESSIONS {
        if let Some(old) = m.order.pop_front() {
            m.map.remove(&old);
        }
    }
    m.order.push_back(id.clone());
    m.map.insert(
        id.clone(),
        Arc::new(RelaySession {
            url,
            headers,
            chunk_idx: AtomicU64::new(0),
        }),
    );
    id
}

pub fn router(relays: Relays) -> Router {
    Router::new()
        .route("/relay/{id}", get(handle_relay))
        .with_state(relays)
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// `"bytes a-b/total"` → total.
fn parse_content_range_total(v: &str) -> Option<u64> {
    v.rsplit('/').next()?.trim().parse().ok()
}

/// Parse a client `Range` header. Supports the forms players send:
/// `bytes=a-`, `bytes=a-b`. Anything else (multi-range, suffix) is treated as
/// "no range" — the full 200 response is always a correct answer.
fn parse_range(v: &str) -> Option<(u64, Option<u64>)> {
    let spec = v.strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let end = end.trim();
    if end.is_empty() {
        Some((start, None))
    } else {
        Some((start, end.parse().ok()))
    }
}

struct Chunk {
    bytes: Vec<u8>,
    /// Total upstream size, when the response carried `Content-Range`.
    total: Option<u64>,
    content_type: Option<String>,
}

enum ChunkError {
    /// The CDN answered but refused the range (403/416/…): the request shape
    /// or position is the problem, not the network.
    Refused(StatusCode),
    Failed(String),
}

/// Fetch one bounded chunk `[pos, pos+len)` with the session's headers.
async fn fetch_chunk(sess: &RelaySession, pos: u64, len: u64) -> Result<Chunk, ChunkError> {
    let mut req = http_client()
        .get(&sess.url)
        .header(header::RANGE, format!("bytes={}-{}", pos, pos + len - 1));
    for (k, v) in &sess.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let resp = req
        .send()
        .await
        .map_err(|e| ChunkError::Failed(format!("chunk at {pos}: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(ChunkError::Refused(status));
    }
    // A 200 to a mid-file range request means the server ignored the header
    // and is sending the whole file — wrong bytes for this position.
    if status != StatusCode::PARTIAL_CONTENT && pos > 0 {
        return Err(ChunkError::Failed(format!(
            "server ignored range at {pos} (HTTP {status})"
        )));
    }
    let total = resp
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_content_range_total)
        .or_else(|| {
            // Plain 200 from position 0: the body is the file.
            (status != StatusCode::PARTIAL_CONTENT).then(|| resp.content_length()).flatten()
        });
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| ChunkError::Failed(format!("chunk body at {pos}: {e}")))?
        .to_vec();
    Ok(Chunk { bytes, total, content_type })
}

/// Fetch a chunk, stepping down the size ladder on refusal. Returns the
/// chunk and remembers the ladder rung that worked on the session.
async fn fetch_chunk_adaptive(sess: &RelaySession, pos: u64) -> Result<Chunk, ChunkError> {
    let mut idx = sess.chunk_idx.load(Ordering::Relaxed) as usize;
    loop {
        match fetch_chunk(sess, pos, CHUNK_LADDER[idx]).await {
            Ok(c) => {
                sess.chunk_idx.store(idx as u64, Ordering::Relaxed);
                return Ok(c);
            }
            Err(ChunkError::Refused(status)) if idx + 1 < CHUNK_LADDER.len() => {
                log::debug!(
                    "stream-relay: {}-byte chunk at {pos} refused (HTTP {status}), stepping down",
                    CHUNK_LADDER[idx]
                );
                idx += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

async fn handle_relay(
    AxumState(relays): AxumState<Relays>,
    Path(id): Path<String>,
    req_headers: HeaderMap,
) -> Response {
    let sess = match relays.lock().unwrap().map.get(&id) {
        Some(s) => Arc::clone(s),
        None => return (StatusCode::NOT_FOUND, "Relay not found").into_response(),
    };

    let range = req_headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_range);
    let (start, req_end) = range.unwrap_or((0, None));

    // First chunk before the response headers: it proves the position is
    // servable and carries the total size everything else needs. Failing
    // fast here (no pacing wait) is deliberate — an unservable position
    // should bounce to the engine's retry ladder, not hang the player.
    let first = match fetch_chunk_adaptive(&sess, start).await {
        Ok(c) => c,
        Err(ChunkError::Refused(status)) => {
            log::warn!("stream-relay: position {start} refused upstream (HTTP {status})");
            return (StatusCode::BAD_GATEWAY, format!("Upstream refused: HTTP {status}"))
                .into_response();
        }
        Err(ChunkError::Failed(msg)) => {
            log::warn!("stream-relay: {msg}");
            return (StatusCode::BAD_GATEWAY, format!("Upstream failed: {msg}")).into_response();
        }
    };
    let Some(total) = first.total else {
        return (StatusCode::BAD_GATEWAY, "Upstream reported no size").into_response();
    };
    if start >= total {
        return (
            StatusCode::RANGE_NOT_SATISFIABLE,
            [(header::CONTENT_RANGE, format!("bytes */{total}"))],
        )
            .into_response();
    }
    let end = req_end.map_or(total - 1, |e| e.min(total - 1));

    // Stream the first chunk plus however many follow-ups the span needs
    // through a pipe. A refusal at the ladder floor after progress is pacing:
    // wait it out (bounded), since a paced window advances at media rate and
    // the player consumes at media rate. A dropped client ends the task via
    // the write error.
    let (mut writer, reader) = tokio::io::duplex(64 * 1024);
    let task_sess = Arc::clone(&sess);
    let first_bytes = first.bytes;
    tokio::spawn(async move {
        let mut pos = start;
        let mut pending = Some(first_bytes);
        let mut stalled_for = std::time::Duration::ZERO;
        loop {
            let bytes = match pending.take() {
                Some(b) => b,
                None => match fetch_chunk_adaptive(&task_sess, pos).await {
                    Ok(c) => {
                        stalled_for = std::time::Duration::ZERO;
                        c.bytes
                    }
                    Err(ChunkError::Refused(_)) if stalled_for < PACING_STALL_CAP => {
                        tokio::time::sleep(PACING_RETRY).await;
                        stalled_for += PACING_RETRY;
                        continue;
                    }
                    Err(_) => return, // truncate; the player surfaces it
                },
            };
            if bytes.is_empty() {
                return;
            }
            let want = ((end + 1 - pos) as usize).min(bytes.len());
            if writer.write_all(&bytes[..want]).await.is_err() {
                return; // client hung up
            }
            pos += want as u64;
            if pos > end {
                return;
            }
        }
    });

    let mut resp = Response::builder()
        .status(if range.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(
            header::CONTENT_TYPE,
            first.content_type.unwrap_or_else(|| "application/octet-stream".into()),
        )
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, (end - start + 1).to_string())
        .header(header::CACHE_CONTROL, "no-store");
    if range.is_some() {
        resp = resp.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"));
    }
    resp.body(Body::from_stream(tokio_util::io::ReaderStream::new(reader)))
        .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_content_range_total() {
        assert_eq!(parse_content_range_total("bytes 0-262143/2520176"), Some(2520176));
        assert_eq!(parse_content_range_total("garbage"), None);
    }

    #[test]
    fn parses_client_ranges() {
        assert_eq!(parse_range("bytes=0-"), Some((0, None)));
        assert_eq!(parse_range("bytes=100-200"), Some((100, Some(200))));
        assert_eq!(parse_range("bytes=-500"), None); // suffix form → full response
        assert_eq!(parse_range("items=0-1"), None);
    }

    /// A fake CDN enforcing the observed googlevideo contract: bounded Range
    /// requests only, capped at `max_chunk` bytes; optionally refusing any
    /// start beyond `frontier` (the stale-client sequential rule).
    fn fake_cdn(
        data: Arc<Vec<u8>>,
        max_chunk: u64,
        sequential_only: bool,
    ) -> Router {
        let frontier = Arc::new(Mutex::new(0u64));
        Router::new().route(
            "/file",
            get(move |headers: HeaderMap| {
                let data = Arc::clone(&data);
                let frontier = Arc::clone(&frontier);
                async move {
                    let range = headers
                        .get(header::RANGE)
                        .and_then(|v| v.to_str().ok())
                        .and_then(parse_range);
                    let Some((start, Some(end))) = range else {
                        return StatusCode::FORBIDDEN.into_response();
                    };
                    if end - start + 1 > max_chunk {
                        return StatusCode::FORBIDDEN.into_response();
                    }
                    let mut fr = frontier.lock().unwrap();
                    if sequential_only && start > *fr {
                        return StatusCode::FORBIDDEN.into_response();
                    }
                    let end = end.min(data.len() as u64 - 1);
                    *fr = (*fr).max(end + 1);
                    (
                        StatusCode::PARTIAL_CONTENT,
                        [(header::CONTENT_RANGE, format!("bytes {start}-{end}/{}", data.len()))],
                        data[start as usize..=end as usize].to_vec(),
                    )
                        .into_response()
                }
            }),
        )
    }

    async fn serve(router: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await });
        format!("http://{addr}")
    }

    /// End-to-end over a modern (VISIONOS-like) fake: any offset, ≤1 MiB
    /// chunks. Plain GET (mpv's shape) gets the full body; a mid-file seek
    /// gets the correct 206 slice without downloading what precedes it.
    #[test]
    fn relays_and_seeks_a_chunk_gated_upstream() {
        const TOTAL: usize = 3 * 1024 * 1024;
        let data: Arc<Vec<u8>> = Arc::new((0..TOTAL).map(|i| (i % 251) as u8).collect());

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let upstream = serve(fake_cdn(Arc::clone(&data), 1024 * 1024, false)).await;
            let relays: Relays = Arc::new(Mutex::new(RelayMap::default()));
            let id = register(&relays, format!("{upstream}/file"), Vec::new());
            let relay = serve(router(relays)).await;
            let client = reqwest::Client::new();

            // Plain GET (mpv's request shape) → full body.
            let resp = client.get(format!("{relay}/relay/{id}")).send().await.unwrap();
            assert_eq!(resp.status().as_u16(), 200);
            assert_eq!(
                resp.headers().get(header::CONTENT_LENGTH).unwrap(),
                &TOTAL.to_string()
            );
            assert_eq!(resp.bytes().await.unwrap().as_ref(), &data[..]);

            // Mid-file seek → correct 206 slice.
            let resp = client
                .get(format!("{relay}/relay/{id}"))
                .header(header::RANGE, "bytes=2097152-2098175")
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status().as_u16(), 206);
            assert_eq!(
                resp.headers().get(header::CONTENT_RANGE).unwrap(),
                &format!("bytes 2097152-2098175/{TOTAL}")
            );
            assert_eq!(resp.bytes().await.unwrap().as_ref(), &data[2097152..=2098175]);

            // Open-ended seek (the <audio> element's shape) → 206 to EOF.
            let resp = client
                .get(format!("{relay}/relay/{id}"))
                .header(header::RANGE, "bytes=3145000-")
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status().as_u16(), 206);
            assert_eq!(resp.bytes().await.unwrap().as_ref(), &data[3145000..]);

            // Unknown id → 404.
            let resp = client.get(format!("{relay}/relay/rl-nope")).send().await.unwrap();
            assert_eq!(resp.status().as_u16(), 404);
        });
    }

    /// A CDN whose chunk cap is below the ladder's top rungs: the relay must
    /// step down to 64 KiB and still deliver, and remember the rung.
    #[test]
    fn steps_down_the_chunk_ladder() {
        const TOTAL: usize = 256 * 1024;
        let data: Arc<Vec<u8>> = Arc::new((0..TOTAL).map(|i| (i % 199) as u8).collect());

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let upstream = serve(fake_cdn(Arc::clone(&data), 64 * 1024, false)).await;
            let relays: Relays = Arc::new(Mutex::new(RelayMap::default()));
            let id = register(&relays, format!("{upstream}/file"), Vec::new());
            let sess = Arc::clone(relays.lock().unwrap().map.get(&id).unwrap());
            let relay = serve(router(relays)).await;

            let resp = reqwest::Client::new()
                .get(format!("{relay}/relay/{id}"))
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status().as_u16(), 200);
            assert_eq!(resp.bytes().await.unwrap().as_ref(), &data[..]);
            assert_eq!(sess.chunk_idx.load(Ordering::Relaxed), 2, "floor rung remembered");
        });
    }

    /// A stale-client CDN (sequential-from-0 only): a cold mid-file seek must
    /// fail FAST with 502 — bouncing to the engine's retry ladder — never
    /// hang the player waiting for an offset that can't be served.
    #[test]
    fn cold_seek_on_sequential_only_upstream_fails_fast() {
        const TOTAL: usize = 2 * 1024 * 1024;
        let data: Arc<Vec<u8>> = Arc::new(vec![7u8; TOTAL]);

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let upstream = serve(fake_cdn(Arc::clone(&data), 1024 * 1024, true)).await;
            let relays: Relays = Arc::new(Mutex::new(RelayMap::default()));
            let id = register(&relays, format!("{upstream}/file"), Vec::new());
            let relay = serve(router(relays)).await;
            let client = reqwest::Client::new();

            // From 0: sequential works.
            let resp = client.get(format!("{relay}/relay/{id}")).send().await.unwrap();
            assert_eq!(resp.status().as_u16(), 200);
            assert_eq!(resp.bytes().await.unwrap().len(), TOTAL);

            // Fresh upstream (frontier back at 0), cold mid-file seek:
            // refused upstream → immediate 502.
            let relays2: Relays = Arc::new(Mutex::new(RelayMap::default()));
            let upstream2 = serve(fake_cdn(Arc::clone(&data), 1024 * 1024, true)).await;
            let id2 = register(&relays2, format!("{upstream2}/file"), Vec::new());
            let relay2 = serve(router(relays2)).await;
            let started = std::time::Instant::now();
            let resp = client
                .get(format!("{relay2}/relay/{id2}"))
                .header(header::RANGE, "bytes=1500000-")
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status().as_u16(), 502);
            assert!(started.elapsed().as_secs() < 5, "must fail fast, not wait out pacing");
        });
    }

    #[test]
    fn register_evicts_oldest_beyond_cap() {
        let relays: Relays = Arc::new(Mutex::new(RelayMap::default()));
        let ids: Vec<String> = (0..MAX_SESSIONS + 2)
            .map(|_| register(&relays, "http://x".into(), Vec::new()))
            .collect();
        let m = relays.lock().unwrap();
        assert_eq!(m.map.len(), MAX_SESSIONS);
        assert!(!m.map.contains_key(&ids[0]));
        assert!(!m.map.contains_key(&ids[1]));
        assert!(m.map.contains_key(&ids[MAX_SESSIONS + 1]));
    }
}
