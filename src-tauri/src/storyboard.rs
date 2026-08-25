// Seek-preview storyboards: one sprite sheet per video, holding many small
// thumbnails in a grid. The seek bar shows a single tile by offsetting the sheet
// (see `docs/seek-preview-spec.md`).
//
// Distinct from `video_frames.rs`, which produces a few LARGE, curated frames
// (queue art, hero background). This produces many small, literal frames — a seek
// preview must show the frame AT the hovered timestamp, so it deliberately does not
// use the `thumbnail` filter's "most representative frame" selection.
//
// One `ffmpeg` pass per video: `-skip_frame nokey` (decode keyframes only) keeps a
// 1080p 5-minute source at ~0.3 s / ~85 MB peak, versus ~3.2 s / ~161 MB for a full
// decode. The cost is granularity — grid slots that fall between keyframes repeat
// the previous frame, which is harmless to render.

use std::path::{Path, PathBuf};

use crate::dependencies;

/// Never generate tiles closer together than this, even for short videos.
pub const MIN_INTERVAL_SECS: f64 = 10.0;
/// Hard cap on tiles per video, so one sheet always suffices.
pub const MAX_TILES: usize = 100;
/// Sheet width budget. The single-sheet invariant means every tile must fit inside
/// one image, so this is the real constraint on tile size. 2000 keeps the worst case
/// (a 4:3 source at 10x10 => 2000x1500) comfortably inside desktop WebView texture
/// limits.
pub const MAX_SHEET_WIDTH: u32 = 2000;
/// Ceiling on tile width, so short videos don't produce needlessly large sheets.
/// 400 is set by the largest consumer: the detail-page hero art renders a tile
/// cover-cropped into a ~240 px square, i.e. ~480 device px on retina.
pub const MAX_TILE_WIDTH: u32 = 400;

/// Tile width for a grid of `cols` columns — as large as the sheet budget allows.
///
/// Deliberately adaptive rather than fixed: the budget is per *sheet*, so a short
/// video (5x5) affords 400 px tiles while only a long one (10x10) is squeezed to 200.
/// A fixed 200 would have softened hero art on every video to accommodate the rare
/// long one. Sheet pixel count — and so disk — stays roughly constant either way.
pub fn tile_width(cols: usize) -> u32 {
    (MAX_SHEET_WIDTH / cols.max(1) as u32).min(MAX_TILE_WIDTH)
}

/// Sheet geometry for a given duration. `count` is how many tiles actually carry a
/// frame — the grid may have more slots, and ffmpeg's `tile` filter pads the
/// remainder with black. Callers must not address slots at or beyond `count`.
#[derive(Debug, Clone, PartialEq)]
pub struct Geometry {
    pub interval_secs: f64,
    pub count: usize,
    pub cols: usize,
    pub rows: usize,
    pub tile_w: u32,
}

/// `interval = max(MIN_INTERVAL_SECS, duration / MAX_TILES)`, then the smallest
/// near-square grid that holds the resulting tile count.
pub fn geometry(duration_secs: f64) -> Geometry {
    let interval_secs = (duration_secs / MAX_TILES as f64).max(MIN_INTERVAL_SECS);
    // `fps=1/interval` emits a frame at 0, interval, 2*interval, … so the tile count
    // is the number of those positions that land inside the video.
    let count = ((duration_secs / interval_secs).ceil() as usize).clamp(1, MAX_TILES);
    let cols = (count as f64).sqrt().ceil() as usize;
    let rows = count.div_ceil(cols);
    Geometry { interval_secs, count, cols, rows, tile_w: tile_width(cols) }
}

/// What the frontend needs to render a tile. `sheets` is a Vec (not a single path)
/// so plugin-supplied storyboards, which are genuinely multi-sheet, share this type.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Storyboard {
    pub sheets: Vec<String>,
    pub cols: usize,
    pub rows: usize,
    pub count: usize,
    pub tile_w: u32,
    pub tile_h: u32,
    pub start_secs: f64,
    pub interval_secs: f64,
}

fn dir(app_dir: &Path) -> PathBuf {
    app_dir.join("storyboards")
}

/// Cache entries are keyed by the track's scheme-prefixed path, hashed — NOT by
/// metadata. Two different videos can share a title+artist+duration (a studio cut and
/// a live take) and would then swap frames; `shelfVideoKey` in the frontend already
/// keys by path for exactly this reason.
///
/// The `v2::` prefix is a recipe stamp, the same device the waveform cache uses:
/// **bump it whenever the tiles themselves change**, and every entry cut by the old
/// recipe becomes an orphan that the startup `gc` sweeps, rather than a wrong sheet
/// that outlives the fix. `v2` is the display-aspect scaling — `v1` sheets were cut
/// with `scale=W:-2`, which stretched anamorphic sources, and there is no way to tell
/// from a cached sheet whether its source was anamorphic.
fn key(track_path: &str) -> String {
    format!("{:x}", md5::compute(format!("v2::{}", track_path)))
}

fn sheet_path(app_dir: &Path, k: &str) -> PathBuf {
    dir(app_dir).join(format!("{}.jpg", k))
}

/// Scratch dir for the per-frame side output emitted while the sheet generates
/// (see `generate`). Removed when generation finishes either way; a leftover from
/// a crash is cleared at the start of the next generation for the same track.
fn frames_dir(app_dir: &Path, k: &str) -> PathBuf {
    dir(app_dir).join(format!("{}.frames", k))
}

fn meta_path(app_dir: &Path, k: &str) -> PathBuf {
    dir(app_dir).join(format!("{}.json", k))
}

/// Cache-only read; never generates. Returns None unless both the descriptor and its
/// sheet are on disk.
pub fn get_cached(app_dir: &Path, track_path: &str) -> Option<Storyboard> {
    let k = key(track_path);
    let data = std::fs::read_to_string(meta_path(app_dir, &k)).ok()?;
    let board: Storyboard = serde_json::from_str(&data).ok()?;
    if board.sheets.iter().any(|s| !Path::new(s).exists()) {
        return None;
    }
    Some(board)
}

pub fn delete_cached(app_dir: &Path, track_path: &str) {
    let k = key(track_path);
    let _ = std::fs::remove_file(sheet_path(app_dir, &k));
    let _ = std::fs::remove_file(meta_path(app_dir, &k));
    discard_partial(app_dir, &k);
}

/// Cache-entry key for a file in the storyboard dir. `<hash>.jpg`, `<hash>.json`,
/// `<hash>.part.jpg` and `<hash>.part.json` all describe the same track, so both
/// sweeps have to group them together — and `file_stem` alone reports `<hash>.part`
/// for a partial, which matches no live track, so the startup `gc` would delete
/// every resumable partial on the next launch.
fn entry_key(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    Some(stem.strip_suffix(".part").unwrap_or(stem).to_string())
}

// ---------------------------------------------------------------------------
// Resumable partials
//
// A cancelled pass used to be thrown away whole. For a long source (a concert film,
// a two-hour upload) that is many seconds of decoding discarded because the user
// skipped the track, and the next play paid it again from zero. So a cancelled pass
// now leaves what it had: the frames it did extract, stitched into a SHORT sheet
// (`cols` wide, only as many rows as are full) plus a sidecar recording how far it
// got. The next pass seeks to that point, decodes only the remainder, and composes
// the two into the final sheet.
//
// The short sheet is deliberately the same shape as the finished one — same tile
// size, same column count — because that is what makes "resume" a paste rather than
// a re-layout. Two things follow from it and both are checked before a partial is
// trusted: the recipe that cut it must match the recipe now (`RESUME_RECIPE`), and
// its pixel dimensions must be exactly what `tiles_done` implies.
// ---------------------------------------------------------------------------

/// Bump when anything about the tiles themselves changes — the interval/grid maths,
/// the scale filter, the encoder. A partial cut by an older recipe cannot be extended
/// by a newer one, and the seam would be the only symptom.
const RESUME_RECIPE: u32 = 1;

/// Only keep a partial when the pass had already been running this long. What a
/// resume saves is roughly the time already spent, and a typical music video's whole
/// pass is ~0.3-0.5s — persisting a sheet to save that is churn, not a saving. This
/// is what confines partials to the sources where a skip actually throws work away.
const RESUME_MIN_ELAPSED: std::time::Duration = std::time::Duration::from_secs(1);

/// JPEG quality for a sheet we compose ourselves, above ffmpeg's `-q:v 5` (~80) on
/// purpose: the tiles carried over from a partial are re-encoded on every
/// cancel/resume cycle, so the loss compounds. Higher quality makes that decay slow
/// enough not to matter over the handful of cycles a real user produces.
const COMPOSE_QUALITY: u8 = 92;

/// How far a cancelled pass got, and the sheet holding it. Sidecar to
/// `<hash>.part.jpg`; never read by the frontend.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialSheet {
    recipe: u32,
    /// Tiles the sheet actually carries, from tile 0. Always < `count`.
    tiles_done: usize,
    count: usize,
    cols: usize,
    rows: usize,
    tile_w: u32,
    tile_h: u32,
    interval_secs: f64,
    duration_secs: f64,
    sheet: String,
}

fn part_sheet_path(app_dir: &Path, k: &str) -> PathBuf {
    dir(app_dir).join(format!("{}.part.jpg", k))
}

fn part_meta_path(app_dir: &Path, k: &str) -> PathBuf {
    dir(app_dir).join(format!("{}.part.json", k))
}

pub fn discard_partial(app_dir: &Path, k: &str) {
    let _ = std::fs::remove_file(part_sheet_path(app_dir, k));
    let _ = std::fs::remove_file(part_meta_path(app_dir, k));
}

/// Rows a sheet needs to hold `tiles` tiles at `cols` per row.
fn rows_for(tiles: usize, cols: usize) -> usize {
    tiles.div_ceil(cols.max(1))
}

/// The partial for this track, if there is one this pass can actually extend.
///
/// Everything that could make the seam wrong is a rejection, and a rejected partial
/// is deleted rather than left to be re-examined every play: a stale recipe, a
/// geometry that no longer matches (the file was re-encoded to a different length),
/// or a sheet whose pixels disagree with the tile count it claims (a torn write).
fn read_partial(app_dir: &Path, k: &str, g: &Geometry, duration_secs: f64) -> Option<PartialSheet> {
    let reject = |why: &str| {
        log::debug!("Storyboard partial for {} discarded: {}", k, why);
        discard_partial(app_dir, k);
        None
    };
    let data = std::fs::read_to_string(part_meta_path(app_dir, k)).ok()?;
    let Ok(p) = serde_json::from_str::<PartialSheet>(&data) else {
        return reject("unreadable sidecar");
    };
    if p.recipe != RESUME_RECIPE {
        return reject("cut by an older tile recipe");
    }
    if p.cols != g.cols
        || p.rows != g.rows
        || p.count != g.count
        || p.tile_w != g.tile_w
        || (p.interval_secs - g.interval_secs).abs() > 1e-6
        || (p.duration_secs - duration_secs).abs() > 0.5
    {
        return reject("geometry no longer matches the source");
    }
    if p.tiles_done == 0 || p.tiles_done >= p.count || p.tile_h == 0 {
        return reject("claims no usable tiles");
    }
    let sheet = part_sheet_path(app_dir, k);
    let Ok((w, h)) = image::image_dimensions(&sheet) else {
        return reject("sheet missing or unreadable");
    };
    let expect_w = p.tile_w * p.cols as u32;
    let expect_h = p.tile_h * rows_for(p.tiles_done, p.cols) as u32;
    if (w, h) != (expect_w, expect_h) {
        return reject("sheet size disagrees with the tiles it claims");
    }
    Some(p)
}

/// Keep the work a cancelled pass had already done. `base` is the partial it was
/// itself resuming from (so a repeatedly-interrupted video still makes progress),
/// and `frames` are the newly extracted frame files paired with their tile index.
fn write_partial(
    app_dir: &Path,
    k: &str,
    g: &Geometry,
    duration_secs: f64,
    base: Option<&PartialSheet>,
    frames: &[(usize, PathBuf)],
) -> Result<(), String> {
    let Some(&(_, ref first)) = frames.first() else {
        return Err("no frames to keep".to_string());
    };
    // Tile size comes from the frames themselves, not from a computation: the scale
    // filter derives the height from the source's display aspect, so the pixels on
    // disk are the only thing that knows it.
    let (tile_w, tile_h) = match base {
        Some(b) => (b.tile_w, b.tile_h),
        None => image::image_dimensions(first)
            .map_err(|e| format!("Failed to read frame dimensions: {}", e))?,
    };
    let tiles_done = (base.map_or(0, |b| b.tiles_done) + frames.len()).min(g.count);
    if tiles_done >= g.count {
        // The pass was killed after the last frame landed but before the sheet was
        // written. Nothing to resume from, and a "partial" holding every tile would
        // fail its own `tiles_done < count` check on the way back in.
        return Err("nothing left to resume".to_string());
    }
    let rows_out = rows_for(tiles_done, g.cols);
    // Composed into a temp file first: the base sheet is one of the inputs, so
    // writing straight to its own path would destroy what we are reading.
    let tmp = dir(app_dir).join(format!("{}.part.tmp.jpg", k));
    compose_sheet(
        &tmp,
        g.cols,
        tile_w,
        tile_h,
        rows_out,
        base.map(|b| PathBuf::from(&b.sheet)).as_deref(),
        frames,
    )?;
    let sheet = part_sheet_path(app_dir, k);
    std::fs::rename(&tmp, &sheet).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to store partial sheet: {}", e)
    })?;
    let meta = PartialSheet {
        recipe: RESUME_RECIPE,
        tiles_done,
        count: g.count,
        cols: g.cols,
        rows: g.rows,
        tile_w,
        tile_h,
        interval_secs: g.interval_secs,
        duration_secs,
        sheet: sheet.to_string_lossy().to_string(),
    };
    let json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    std::fs::write(part_meta_path(app_dir, k), json)
        .map_err(|e| format!("Failed to write partial sidecar: {}", e))?;
    Ok(())
}

/// Paste tiles into a sheet: an optional base sheet at the top-left (its rows are
/// already laid out correctly, so it needs no per-tile work) plus individual frames
/// at the slot their tile index names. Slots nothing supplies stay black, matching
/// ffmpeg's own `tile` padding.
fn compose_sheet(
    dest: &Path,
    cols: usize,
    tile_w: u32,
    tile_h: u32,
    rows_out: usize,
    base: Option<&Path>,
    frames: &[(usize, PathBuf)],
) -> Result<(), String> {
    if cols == 0 || rows_out == 0 || tile_w == 0 || tile_h == 0 {
        return Err("cannot compose a zero-sized sheet".to_string());
    }
    let w = tile_w * cols as u32;
    let h = tile_h * rows_out as u32;
    let mut canvas: image::RgbImage = image::ImageBuffer::from_pixel(w, h, image::Rgb([0, 0, 0]));
    if let Some(base) = base {
        let img = image::open(base)
            .map_err(|e| format!("Failed to read partial sheet: {}", e))?
            .to_rgb8();
        if img.width() != w || img.height() > h {
            return Err(format!(
                "Partial sheet is {}x{}, which does not fit a {}x{} sheet",
                img.width(), img.height(), w, h
            ));
        }
        image::imageops::replace(&mut canvas, &img, 0, 0);
    }
    for (idx, path) in frames {
        if *idx >= cols * rows_out {
            continue;
        }
        let img = image::open(path)
            .map_err(|e| format!("Failed to read frame {}: {}", path.display(), e))?
            .to_rgb8();
        let img = if img.width() == tile_w && img.height() == tile_h {
            img
        } else {
            // Defensive: the pass scales every frame to the tile size, so this can
            // only fire if a recipe change slipped past `read_partial`.
            image::imageops::resize(&img, tile_w, tile_h, image::imageops::FilterType::Triangle)
        };
        let x = (*idx % cols) as i64 * tile_w as i64;
        let y = (*idx / cols) as i64 * tile_h as i64;
        image::imageops::replace(&mut canvas, &img, x, y);
    }
    let file = std::fs::File::create(dest)
        .map_err(|e| format!("Failed to create sheet {}: {}", dest.display(), e))?;
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
        std::io::BufWriter::new(file),
        COMPOSE_QUALITY,
    );
    encoder
        .encode_image(&canvas)
        .map_err(|e| format!("Failed to encode sheet: {}", e))
}

fn ffmpeg_command() -> std::process::Command {
    dependencies::command_with_path("ffmpeg")
}

/// The error `generate_with_progress` returns when its ffmpeg pass was killed
/// because nobody is waiting for it any more. Not a failure — callers report it as
/// its own status and stay quiet (see `commands::extract_storyboard`).
pub const CANCELLED: &str = "storyboard generation cancelled";

/// Live interest in a generation, and the running child it can kill.
///
/// A storyboard pass is worth stopping: it is a full ffmpeg keyframe decode, and a
/// user who skips the video — or turns the feature off mid-pass — has no use for the
/// sheet. It may only be stopped once the LAST interested caller has walked away,
/// though: generation is single-flight (see `inflight`) but two surfaces (the
/// now-playing bar and the track detail page) routinely want the same sheet, so a
/// bare "cancel this path" would let one surface's teardown kill the other's still
/// wanted pass. Hence the ref count: every `extract_storyboard` carries its own
/// request id, `cancel` drops one, and the pass dies only when a path's set empties.
struct Runs {
    /// track path -> request ids that still want it
    interest: std::collections::HashMap<String, std::collections::HashSet<String>>,
    /// track path -> the ffmpeg child of the pass currently running for it
    children: std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<std::process::Child>>>,
    /// Requests cancelled before their `begin` landed. The cancel IPC can overtake
    /// the invoke it cancels (the invoke registers from a blocking thread), and
    /// without this the pass would start anyway and run to completion unwatched.
    /// Each entry is consumed by the matching `begin`.
    stillborn: std::collections::HashSet<String>,
}

fn runs() -> &'static std::sync::Mutex<Runs> {
    static RUNS: std::sync::OnceLock<std::sync::Mutex<Runs>> = std::sync::OnceLock::new();
    RUNS.get_or_init(|| {
        std::sync::Mutex::new(Runs {
            interest: std::collections::HashMap::new(),
            children: std::collections::HashMap::new(),
            stillborn: std::collections::HashSet::new(),
        })
    })
}

/// Register a caller's interest in `track_path`'s storyboard. Returns false when this
/// request was cancelled before it got here, in which case the caller must not start.
pub fn begin_request(track_path: &str, request_id: &str) -> bool {
    let mut r = runs().lock().unwrap();
    if r.stillborn.remove(request_id) {
        return false;
    }
    r.interest.entry(track_path.to_string()).or_default().insert(request_id.to_string());
    true
}

/// Drop a caller's interest. Once a path has none left, the poll loop in
/// `generate_with_progress` kills its ffmpeg within one tick.
pub fn end_request(track_path: &str, request_id: &str) {
    let mut r = runs().lock().unwrap();
    if let Some(set) = r.interest.get_mut(track_path) {
        set.remove(request_id);
        if set.is_empty() {
            r.interest.remove(track_path);
        }
    }
}

/// `end_request` plus the pre-registration race: an id that was never registered is
/// remembered so the invoke it belongs to bails the moment it starts.
pub fn cancel_request(track_path: &str, request_id: &str) {
    let mut r = runs().lock().unwrap();
    let known = r.interest.get(track_path).is_some_and(|s| s.contains(request_id));
    if known {
        drop(r);
        end_request(track_path, request_id);
        return;
    }
    // Bounded: entries are consumed by `begin`, and the cap covers the pathological
    // case of a cancel whose invoke never arrives at all.
    if r.stillborn.len() >= 256 {
        r.stillborn.clear();
    }
    r.stillborn.insert(request_id.to_string());
}

/// True once every caller that asked for this path has gone away.
fn abandoned(track_path: &str) -> bool {
    !runs().lock().unwrap().interest.contains_key(track_path)
}

/// Publishes the running child so a cancel can reach it, and unpublishes on any exit
/// path (including an unwind).
struct ChildGuard(String);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        runs().lock().unwrap().children.remove(&self.0);
    }
}

/// Track paths with a generation in flight, plus the condvar waiters sleep on.
/// Generation must be single-flight per track: two frontend surfaces (the
/// now-playing bar and the track detail page) both extract on a cache miss, and
/// two concurrent runs sabotage each other — the second's scratch-dir reset kills
/// the first's ffmpeg mid-write, whose failure cleanup then deletes the sheet the
/// winner just cached, leaving a descriptor with no sheet (= "caching stopped
/// working"). The loser now waits and serves the winner's cache instead.
fn inflight() -> &'static (std::sync::Mutex<std::collections::HashSet<String>>, std::sync::Condvar) {
    static INFLIGHT: std::sync::OnceLock<(
        std::sync::Mutex<std::collections::HashSet<String>>,
        std::sync::Condvar,
    )> = std::sync::OnceLock::new();
    INFLIGHT.get_or_init(|| (std::sync::Mutex::new(std::collections::HashSet::new()), std::sync::Condvar::new()))
}

/// Removes the in-flight entry and wakes waiters even if generation unwinds.
struct InflightGuard(String);

impl Drop for InflightGuard {
    fn drop(&mut self) {
        let (lock, cv) = inflight();
        lock.lock().unwrap().remove(&self.0);
        cv.notify_all();
    }
}

/// Frames in `dir` that are safely complete. The image2 muxer writes files in
/// sequence and only opens frame N+1 after closing frame N, so while ffmpeg is
/// still running the highest-numbered file may be mid-write and is held back;
/// once it has exited (`finished`) everything on disk is complete.
fn completed_frames(dir: &Path, finished: bool) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            (p.extension().and_then(|x| x.to_str()) == Some("jpg"))
                .then(|| p.to_string_lossy().to_string())
        })
        .collect();
    // %03d names sort lexicographically in frame order.
    names.sort();
    if !finished {
        names.pop();
    }
    names
}

/// `completed_frames` paired with the tile index each file depicts. The pattern
/// numbers from 1 within a run, so on a resumed run file N is tile `start_tile + N-1`.
fn tile_frames(dir: &Path, finished: bool, start_tile: usize) -> Vec<(usize, PathBuf)> {
    completed_frames(dir, finished)
        .into_iter()
        .enumerate()
        .map(|(i, f)| (start_tile + i, PathBuf::from(f)))
        .collect()
}

/// Store what a cancelled pass had extracted, or throw it away when it isn't worth
/// keeping. Never fails the caller: this is a saving, and a video that can't be
/// resumed simply starts over next time.
fn keep_or_discard(
    app_dir: &Path,
    k: &str,
    g: &Geometry,
    duration_secs: f64,
    base: Option<&PartialSheet>,
    frames: &[(usize, PathBuf)],
    elapsed: std::time::Duration,
    video_path: &Path,
) {
    if frames.is_empty() || elapsed < RESUME_MIN_ELAPSED {
        // Nothing extracted, or the pass was short enough that re-running it costs
        // less than storing a sheet would. An existing partial is left alone — it is
        // still the best resume point anyone has, and `read_partial` has already
        // deleted any partial it wouldn't accept.
        return;
    }
    match write_partial(app_dir, k, g, duration_secs, base, frames) {
        Ok(()) => log::info!(
            "Storyboard for {}: kept {} of {} tiles to resume from",
            video_path.display(),
            base.map_or(0, |b| b.tiles_done) + frames.len(),
            g.count
        ),
        Err(e) => {
            log::debug!("Storyboard partial for {} not kept: {}", video_path.display(), e);
            // Leave any existing partial alone — a failed *extension* doesn't make
            // the base it was extending invalid.
            if base.is_none() {
                discard_partial(app_dir, k);
            }
        }
    }
}

/// Generate the sheet for `video_path` and cache it. `duration_secs` comes from the
/// caller (see `video_frames::get_video_duration`) so we don't probe twice.
///
/// Progress: `on_partial` is called with `(start_tile, frames)` — the cumulative list
/// of individual frame files extracted so far (time order) and the tile index the
/// first of them depicts, so a consumer can show the moments as they land instead of
/// a blank strip. `start_tile` is 0 for a fresh pass and non-zero when resuming a
/// cancelled one, where the frames on disk begin part-way into the video; a consumer
/// that ignored it would caption them with the wrong timestamps. The frame files are
/// scratch — deleted once the sheet exists, by which point the caller has the real
/// storyboard to switch to. Pass `|_, _| {}` when progress isn't wanted.
///
/// Resume: a pass cancelled part-way leaves a partial sheet behind (see
/// `write_partial`), and this picks it up — seeking to where it stopped and decoding
/// only the remainder. So an interrupted video makes progress across plays instead of
/// restarting from zero each time.
///
/// Cancellation: pass `Some(request_id)` for a request already registered with
/// `begin_request`, and the pass stops (returning `CANCELLED`) as soon as that path
/// has no interested caller left — see `Runs`. `None` opts out entirely, for callers
/// that are not driven by a UI surface and so can never be abandoned.
pub fn generate_with_progress(
    app_dir: &Path,
    track_path: &str,
    video_path: &Path,
    duration_secs: f64,
    request_id: Option<&str>,
    mut on_partial: impl FnMut(usize, &[String]),
) -> Result<Storyboard, String> {
    if duration_secs <= 0.0 {
        return Err("Video has zero duration".to_string());
    }

    // Single-flight per track (see `inflight`). A waiter that wakes to a cache hit
    // is the loser of the race — the winner generated while it slept.
    let _guard = {
        let (lock, cv) = inflight();
        let mut running = lock.lock().unwrap();
        while running.contains(track_path) {
            running = cv.wait(running).unwrap();
        }
        if let Some(cached) = get_cached(app_dir, track_path) {
            return Ok(cached);
        }
        running.insert(track_path.to_string());
        InflightGuard(track_path.to_string())
    };

    // A waiter can be abandoned while it sleeps — and if the winner it was waiting on
    // was itself cancelled there is no cache to serve, so without this check the
    // loser would start the very pass the user just walked away from.
    if request_id.is_some() && abandoned(track_path) {
        return Err(CANCELLED.to_string());
    }

    let g = geometry(duration_secs);
    let d = dir(app_dir);
    std::fs::create_dir_all(&d).map_err(|e| format!("Failed to create storyboard dir: {}", e))?;

    let k = key(track_path);
    let out = sheet_path(app_dir, &k);
    let out_str = out.to_string_lossy().to_string();
    let fdir = frames_dir(app_dir, &k);
    // Clear a leftover from a crashed run so stale frames can't be reported as live.
    let _ = std::fs::remove_dir_all(&fdir);
    std::fs::create_dir_all(&fdir).map_err(|e| format!("Failed to create frames dir: {}", e))?;
    let frame_pattern = fdir.join("%03d.jpg").to_string_lossy().to_string();

    // Pick up where a cancelled pass stopped, if it left anything usable.
    let resume = read_partial(app_dir, &k, &g, duration_secs);
    let start_tile = resume.as_ref().map_or(0, |p| p.tiles_done);
    let remaining = g.count.saturating_sub(start_tile);

    // Tile geometry follows the source's DISPLAY aspect (`dar`), not its stored
    // width/height. An anamorphic source — a DVD rip, a DVB capture, some phone
    // video — stores non-square pixels, so scaling by the stored ratio faithfully
    // reproduces the squeeze and every tile came out stretched against the video the
    // player was showing (mpv scales to `dar`). `trunc(w/dar/2)*2` is the height that
    // undoes it, rounded to even for yuvj420p; `setsar=1` then stops the encoder
    // recording a non-square ratio that nothing downstream reads anyway.
    let scale = format!("scale={w}:trunc({w}/dar/2)*2,setsar=1", w = g.tile_w);
    let mut cmd = ffmpeg_command();
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    let seek = format!("{:.4}", start_tile as f64 * g.interval_secs);
    if start_tile > 0 {
        // Input seek, so the skipped span is never decoded — that saving is the whole
        // point of resuming. Output timestamps restart at the seek point, so
        // `fps=1/interval` lands the remaining tiles on the same grid as a
        // straight-through pass.
        cmd.args(["-ss", &seek]);
    }
    cmd.args([
        // Keyframes only — this is what makes one pass cheap. Must precede -i.
        "-skip_frame", "nokey",
        "-i", &video_path.to_string_lossy(),
        "-an",
    ]);
    if start_tile > 0 {
        // Resuming: frames only. A `tile` filter here would build a grid of just the
        // remainder, so the finished sheet is composed from the partial plus these.
        cmd.args([
            "-filter_complex", &format!("fps=1/{:.4},{}[strip]", g.interval_secs, scale),
            "-map", "[strip]",
            // Stops the decode at the last tile we still need instead of running to EOF.
            "-frames:v", &remaining.to_string(),
            "-c:v", "mjpeg", "-q:v", "5", "-pix_fmt", "yuvj420p",
            &frame_pattern,
        ]);
    } else {
        cmd.args([
            // One decode pass, two outputs: the individual frames (progress, scratch)
            // and the tiled sheet (the cached artifact).
            "-filter_complex", &format!(
                "fps=1/{:.4},{},split=2[strip][grid];[grid]tile={}x{}[sheet]",
                g.interval_secs, scale, g.cols, g.rows
            ),
            // MJPEG unconditionally: `webp_supported()` is false on stock homebrew
            // ffmpeg, so the WebP path already falls back in practice. Sheets are small.
            "-map", "[strip]",
            "-c:v", "mjpeg", "-q:v", "5", "-pix_fmt", "yuvj420p",
            &frame_pattern,
            "-map", "[sheet]",
            "-frames:v", "1",
            "-c:v", "mjpeg", "-q:v", "5", "-pix_fmt", "yuvj420p",
            &out_str,
        ]);
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::piped());

    let cleanup = |ok: bool| {
        let _ = std::fs::remove_dir_all(&fdir);
        if !ok {
            let _ = std::fs::remove_file(&out);
        }
    };

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            cleanup(false);
            return Err(format!("Failed to run ffmpeg: {}", e));
        }
    };
    // Drained on a thread so a chatty stderr can't fill the pipe and block ffmpeg.
    let stderr_pipe = child.stderr.take();
    let stderr_handle = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut pipe) = stderr_pipe {
            use std::io::Read;
            let _ = pipe.read_to_string(&mut s);
        }
        s
    });

    // Published so `cancel_request` can reach this pass; unpublished on every exit.
    let child = std::sync::Arc::new(std::sync::Mutex::new(child));
    let _child_guard = {
        runs().lock().unwrap().children.insert(track_path.to_string(), child.clone());
        ChildGuard(track_path.to_string())
    };

    let started = std::time::Instant::now();
    let mut reported = 0usize;
    // `kill_child` and the poll below must each take the lock and give it back: a
    // guard created in a `match` scrutinee lives until the end of the whole `match`,
    // so locking again inside an arm deadlocks this thread against itself (it did —
    // the cancel path hung forever while ffmpeg ran to completion regardless).
    let kill_child = || {
        let mut c = child.lock().unwrap();
        let _ = c.kill();
        let _ = c.wait();
    };
    let status = loop {
        let polled = child.lock().unwrap().try_wait();
        match polled {
            Ok(Some(status)) => break status,
            Ok(None) => {
                // Nobody is waiting for this sheet any more (track skipped, view
                // closed, feature switched off): stop decoding rather than finish a
                // pass no one asked for. Checked before reporting progress so a
                // cancelled pass emits no further partials.
                if request_id.is_some() && abandoned(track_path) {
                    kill_child();
                    // The child is gone, so every frame on disk is complete.
                    let done = tile_frames(&fdir, true, start_tile);
                    keep_or_discard(
                        app_dir, &k, &g, duration_secs, resume.as_ref(), &done,
                        started.elapsed(), video_path,
                    );
                    cleanup(false);
                    log::debug!("Storyboard for {} cancelled", video_path.display());
                    return Err(CANCELLED.to_string());
                }
                let done = completed_frames(&fdir, false);
                if done.len() > reported {
                    reported = done.len();
                    on_partial(start_tile, &done);
                }
                // 80ms, not something lazier: a typical music video's keyframe pass
                // finishes in ~0.3-0.5s, so a slow poll would collapse the whole
                // progression into one late event.
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
            Err(e) => {
                kill_child();
                cleanup(false);
                return Err(format!("Failed to wait for ffmpeg: {}", e));
            }
        }
    };
    let stderr_text = stderr_handle.join().unwrap_or_default();

    if !status.success() {
        cleanup(false);
        return Err(format!("ffmpeg storyboard generation failed: {}", stderr_text));
    }
    if let Some(base) = resume.as_ref() {
        // Resumed run: ffmpeg produced only the remaining frames, so the finished
        // sheet is the partial with those pasted after it. A short tail is not an
        // error — `count` can over-claim the last tile by one, which the grid has
        // always padded with black.
        let tail = tile_frames(&fdir, true, start_tile);
        let composed = compose_sheet(
            &out, g.cols, base.tile_w, base.tile_h, g.rows,
            Some(Path::new(&base.sheet)), &tail,
        );
        if let Err(e) = composed {
            // The partial is the suspect (a torn or mismatched sheet), so drop it —
            // the next pass then starts clean rather than failing the same way.
            discard_partial(app_dir, &k);
            cleanup(false);
            return Err(format!("Failed to compose resumed storyboard: {}", e));
        }
        log::info!(
            "Storyboard for {}: resumed at tile {}/{}, {} new frame(s)",
            video_path.display(), start_tile, g.count, tail.len()
        );
    }
    if !out.exists() {
        cleanup(false);
        return Err(format!("ffmpeg storyboard generation failed: {}", stderr_text));
    }
    cleanup(true);
    // The sheet supersedes the partial it was built from.
    discard_partial(app_dir, &k);

    // Tile height follows the source's display aspect (see `scale` above), so it is
    // only knowable from the result — a 4:3 source yields 200x150, not 200x112. Read
    // it from the sheet header rather than assuming 16:9.
    let (sheet_w, sheet_h) = image::image_dimensions(&out)
        .map_err(|e| format!("Failed to read storyboard dimensions: {}", e))?;
    let board = Storyboard {
        sheets: vec![out_str],
        cols: g.cols,
        rows: g.rows,
        count: g.count,
        tile_w: sheet_w / g.cols as u32,
        tile_h: sheet_h / g.rows as u32,
        start_secs: 0.0,
        interval_secs: g.interval_secs,
    };

    let json = serde_json::to_string(&board).map_err(|e| e.to_string())?;
    std::fs::write(meta_path(app_dir, &k), json)
        .map_err(|e| format!("Failed to write storyboard meta: {}", e))?;

    log::info!(
        "Storyboard for {}: {} tiles ({}x{} grid, {}x{} px, every {:.1}s)",
        video_path.display(), g.count, g.cols, g.rows, board.tile_w, board.tile_h, g.interval_secs
    );
    Ok(board)
}

/// Sweep entries whose track is no longer live. Neither the waveform nor the
/// video-frame cache does this, and sheets are ~200 KB each, so an unbounded
/// storyboard cache would be the largest on disk. `live_paths` is every track path
/// still in the library.
pub fn gc(app_dir: &Path, live_paths: &[String]) -> Result<usize, String> {
    let d = dir(app_dir);
    if !d.exists() {
        return Ok(0);
    }
    let live: std::collections::HashSet<String> = live_paths.iter().map(|p| key(p)).collect();
    let mut removed = 0;
    for entry in std::fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        // A `.frames` scratch dir at gc time is a leftover from a generation the app
        // didn't live to finish (gc runs at startup, before anything can be playing —
        // an in-flight generation cannot exist yet). Liveness doesn't apply: the dir
        // is garbage even when its track is still in the library, and `remove_file`
        // below can't take a directory.
        if path.is_dir() {
            if path.extension().and_then(|x| x.to_str()) == Some("frames")
                && std::fs::remove_dir_all(&path).is_ok()
            {
                removed += 1;
            }
            continue;
        }
        // `<hash>.jpg`, `<hash>.json` and the `<hash>.part.*` pair all key off the
        // same hash — see `entry_key`.
        let Some(stem) = entry_key(&path) else { continue };
        if !live.contains(&stem) {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    if removed > 0 {
        log::info!("Storyboard gc: removed {} orphaned file(s)", removed);
    }
    Ok(removed)
}

/// Hard ceiling for the storyboard cache. Sheets are ~200 KB, so this holds roughly
/// 1300 videos before anything is evicted.
pub const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;

/// Evict least-recently-modified entries until the cache fits `max_bytes`. Runs after
/// `gc`, as the backstop for the case liveness can't catch: a library larger than the
/// budget. Sheet and descriptor are evicted together so `get_cached` never sees a
/// descriptor whose sheet is gone (it also guards against that independently).
pub fn enforce_cap(app_dir: &Path, max_bytes: u64) -> Result<u64, String> {
    let d = dir(app_dir);
    if !d.exists() {
        return Ok(0);
    }
    // stem -> (total bytes, newest mtime)
    let mut groups: std::collections::HashMap<String, (u64, std::time::SystemTime)> =
        std::collections::HashMap::new();
    let mut total: u64 = 0;
    for entry in std::fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let Some(stem) = entry_key(&path) else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        total += meta.len();
        let slot = groups.entry(stem).or_insert((0, std::time::UNIX_EPOCH));
        slot.0 += meta.len();
        if mtime > slot.1 {
            slot.1 = mtime;
        }
    }
    if total <= max_bytes {
        return Ok(0);
    }
    let mut ordered: Vec<_> = groups.into_iter().collect();
    ordered.sort_by_key(|(_, (_, mtime))| *mtime); // oldest first
    let mut freed = 0u64;
    for (stem, (bytes, _)) in ordered {
        if total - freed <= max_bytes {
            break;
        }
        let _ = std::fs::remove_file(d.join(format!("{}.jpg", stem)));
        let _ = std::fs::remove_file(d.join(format!("{}.json", stem)));
        discard_partial(app_dir, &stem);
        freed += bytes;
    }
    if freed > 0 {
        log::info!("Storyboard cache: evicted {} KB to fit cap", freed / 1024);
    }
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_geometry_short_video_hits_min_interval() {
        // 213s / 100 = 2.13s, below the 10s floor, so the floor wins.
        let g = geometry(213.0);
        assert_eq!(g.interval_secs, 10.0);
        assert_eq!(g.count, 22); // ceil(21.3)
        assert_eq!(g.cols, 5);
        assert_eq!(g.rows, 5); // 25 slots, 22 carry frames
    }

    #[test]
    fn test_geometry_long_video_hits_tile_cap() {
        // 3.1 hours: the cap binds and the interval stretches instead.
        let g = geometry(11138.0);
        assert_eq!(g.count, MAX_TILES);
        assert_eq!(g.cols, 10);
        assert_eq!(g.rows, 10);
        assert!((g.interval_secs - 111.38).abs() < 0.01);
    }

    #[test]
    fn test_geometry_crossover_is_exactly_max_tiles_seconds() {
        // Both constraints meet where duration = MIN_INTERVAL * MAX_TILES = 1000s.
        let g = geometry(1000.0);
        assert_eq!(g.interval_secs, MIN_INTERVAL_SECS);
        assert_eq!(g.count, MAX_TILES);
    }

    #[test]
    fn test_geometry_never_exceeds_tile_cap() {
        for secs in [1.0, 10.0, 213.0, 999.0, 1000.0, 1001.0, 5021.0, 86400.0] {
            let g = geometry(secs);
            assert!(g.count >= 1, "{secs}s produced zero tiles");
            assert!(g.count <= MAX_TILES, "{secs}s produced {} tiles", g.count);
            assert!(
                g.cols * g.rows >= g.count,
                "{secs}s grid {}x{} cannot hold {} tiles",
                g.cols, g.rows, g.count
            );
            assert!(g.interval_secs >= MIN_INTERVAL_SECS);
        }
    }

    #[test]
    fn test_geometry_very_short_video_yields_one_tile() {
        let g = geometry(5.0);
        assert_eq!(g.count, 1);
        assert_eq!(g.cols, 1);
        assert_eq!(g.rows, 1);
    }

    #[test]
    fn test_geometry_last_tile_lands_inside_the_video() {
        for secs in [30.0, 213.0, 1000.0, 5021.0, 11138.0] {
            let g = geometry(secs);
            let last = (g.count - 1) as f64 * g.interval_secs;
            assert!(last < secs, "{secs}s: last tile at {last}s is past the end");
        }
    }

    #[test]
    fn test_cache_key_is_path_based_not_metadata_based() {
        // Two videos that would collide under a title+duration key must not share.
        assert_ne!(key("file:///a/Song.mp4"), key("file:///b/Song.mp4"));
        assert_eq!(key("file:///a/Song.mp4"), key("file:///a/Song.mp4"));
    }

    #[test]
    fn test_completed_frames_holds_back_the_file_still_being_written() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        for n in ["001.jpg", "002.jpg", "003.jpg"] {
            std::fs::write(d.join(n), b"x").unwrap();
        }
        std::fs::write(d.join("notes.txt"), b"x").unwrap(); // non-jpg is ignored
        // While ffmpeg runs, the highest-numbered frame may be mid-write.
        let running = completed_frames(d, false);
        assert_eq!(running.len(), 2);
        assert!(running[0].ends_with("001.jpg"));
        assert!(running[1].ends_with("002.jpg"));
        // Once it exited, everything on disk is complete.
        assert_eq!(completed_frames(d, true).len(), 3);
    }

    #[test]
    fn test_completed_frames_empty_and_missing_dirs_are_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(completed_frames(dir.path(), false).is_empty());
        assert!(completed_frames(&dir.path().join("nope"), true).is_empty());
    }

    #[test]
    fn test_get_cached_is_none_without_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(get_cached(dir.path(), "file:///nope.mp4").is_none());
    }

    #[test]
    fn test_get_cached_rejects_meta_with_missing_sheet() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path();
        std::fs::create_dir_all(super::dir(app)).unwrap();
        let k = key("file:///x.mp4");
        let board = Storyboard {
            sheets: vec![app.join("gone.jpg").to_string_lossy().to_string()],
            cols: 5, rows: 5, count: 22, tile_w: 400, tile_h: 224,
            start_secs: 0.0, interval_secs: 10.0,
        };
        std::fs::write(meta_path(app, &k), serde_json::to_string(&board).unwrap()).unwrap();
        // Descriptor present but the sheet was swept — must not be served.
        assert!(get_cached(app, "file:///x.mp4").is_none());
    }

    #[test]
    fn test_delete_cached_removes_both_files() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path();
        std::fs::create_dir_all(super::dir(app)).unwrap();
        let k = key("file:///x.mp4");
        std::fs::write(sheet_path(app, &k), b"jpeg").unwrap();
        std::fs::write(meta_path(app, &k), b"{}").unwrap();
        delete_cached(app, "file:///x.mp4");
        assert!(!sheet_path(app, &k).exists());
        assert!(!meta_path(app, &k).exists());
    }

    #[test]
    fn test_gc_keeps_live_and_sweeps_orphans() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path();
        std::fs::create_dir_all(super::dir(app)).unwrap();
        let live = "file:///keep.mp4";
        let dead = "file:///gone.mp4";
        for p in [live, dead] {
            let k = key(p);
            std::fs::write(sheet_path(app, &k), b"jpeg").unwrap();
            std::fs::write(meta_path(app, &k), b"{}").unwrap();
        }
        // A scratch dir left by an interrupted generation — garbage even though its
        // track is live (the app died mid-run; nothing will ever finish it).
        let stale_frames = frames_dir(app, &key(live));
        std::fs::create_dir_all(&stale_frames).unwrap();
        std::fs::write(stale_frames.join("001.jpg"), b"jpeg").unwrap();

        let removed = gc(app, &[live.to_string()]).unwrap();
        assert_eq!(removed, 3, "both files of the dead entry + the scratch dir should go");
        assert!(sheet_path(app, &key(live)).exists());
        assert!(meta_path(app, &key(live)).exists());
        assert!(!sheet_path(app, &key(dead)).exists());
        assert!(!stale_frames.exists());
    }

    #[test]
    fn test_gc_on_missing_dir_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(gc(dir.path(), &[]).unwrap(), 0);
    }

    /// End-to-end generation against real ffmpeg. `#[ignore]`d because it encodes two
    /// test clips (~4 s); self-skips when ffmpeg is absent so it stays green anywhere.
    /// The 4:3 case is the point: `scale=160:-2` yields 160x120, not 160x90, which is
    /// why `tile_h` is read from the produced sheet instead of assumed.
    #[test]
    #[ignore]
    fn test_generate_against_real_ffmpeg() {
        if !crate::video_frames::is_ffmpeg_available() {
            eprintln!("[storyboard-test] SKIPPED — ffmpeg not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        // Aspect is asserted as a ratio, not a magic number: `scale=W:-2` rounds the
        // derived height to the nearest EVEN value (1280x720 at width 400 gives 226,
        // not 225), which is precisely why tile_h is read from the produced sheet.
        for (name, size, dur, src_w, src_h) in [
            ("v169.mp4", "1280x720", 213u32, 1280.0f64, 720.0f64),
            ("v43.mp4", "640x480", 213, 640.0, 480.0),
        ] {
            let f = dir.path().join(name);
            let ok = std::process::Command::new("ffmpeg")
                .args([
                    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                    &format!("testsrc2=size={}:rate=30:duration={}", size, dur),
                    "-c:v", "libx264", "-preset", "ultrafast", "-g", "250",
                    "-pix_fmt", "yuv420p", "-y",
                ])
                .arg(&f)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            assert!(ok, "failed to encode test clip {name}");

            let track_path = format!("file://{}", f.to_string_lossy());
            // Through the progress path, so partial reporting is exercised too. The
            // clip decodes fast, so zero callbacks is legal — but any that fire must
            // report cumulative, in-bounds frame lists.
            let mut partial_lens: Vec<usize> = Vec::new();
            let started = std::time::Instant::now();
            let b = generate_with_progress(dir.path(), &track_path, &f, dur as f64, None, |_, frames| {
                assert!(frames.len() <= 22, "partial reported more frames than tiles");
                assert!(
                    partial_lens.last().map_or(true, |&prev| frames.len() >= prev),
                    "partial frame count went backwards"
                );
                eprintln!(
                    "[storyboard-test] {name}: partial {} frames at {:?}",
                    frames.len(),
                    started.elapsed()
                );
                partial_lens.push(frames.len());
            })
            .expect("generate");
            eprintln!(
                "[storyboard-test] {name}: done in {:?}, {} partial callback(s)",
                started.elapsed(),
                partial_lens.len()
            );
            assert!(
                !frames_dir(dir.path(), &key(&track_path)).exists(),
                "scratch frames dir must be cleaned up after generation"
            );
            assert_eq!(b.count, 22, "213s at a 10s floor is 22 tiles");
            assert_eq!((b.cols, b.rows), (5, 5));
            assert_eq!(b.interval_secs, MIN_INTERVAL_SECS);
            assert_eq!(b.tile_w, tile_width(5), "22 tiles => 5 cols => 400px tiles");
            let expected_h = b.tile_w as f64 * (src_h / src_w);
            assert!(
                (b.tile_h as f64 - expected_h).abs() <= 2.0,
                "{size}: tile height {} should follow the source aspect (~{expected_h:.0})",
                b.tile_h
            );
            assert_eq!(b.sheets.len(), 1, "local tier is always single-sheet");
            assert!(std::fs::metadata(&b.sheets[0]).unwrap().len() > 0);

            let cached = get_cached(dir.path(), &track_path).expect("round-trips via cache");
            assert_eq!(cached.count, b.count);
            assert_eq!(cached.tile_h, b.tile_h);
            assert_eq!(cached.interval_secs, b.interval_secs);
        }
    }

    /// Two surfaces (now-playing bar + detail page) both extract on a cache miss.
    /// Without single-flight the loser's scratch reset killed the winner's ffmpeg,
    /// whose failure cleanup then deleted the cached sheet — one thread errored and
    /// `get_cached` stayed None forever after. Both must succeed and the cache must
    /// survive. `#[ignore]`d: encodes a clip; self-skips without ffmpeg.
    #[test]
    #[ignore]
    fn test_concurrent_generation_is_single_flight_and_keeps_the_cache() {
        if !crate::video_frames::is_ffmpeg_available() {
            eprintln!("[storyboard-test] SKIPPED — ffmpeg not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("race.mp4");
        let ok = std::process::Command::new("ffmpeg")
            .args([
                "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                "testsrc2=size=1280x720:rate=30:duration=213",
                "-c:v", "libx264", "-preset", "ultrafast", "-g", "250",
                "-pix_fmt", "yuv420p", "-y",
            ])
            .arg(&f)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "failed to encode test clip");

        let track_path = format!("file://{}", f.to_string_lossy());
        let results: Vec<Result<Storyboard, String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    scope.spawn(|| {
                        generate_with_progress(dir.path(), &track_path, &f, 213.0, None, |_, _| {})
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        for r in &results {
            let b = r.as_ref().expect("both concurrent generations must succeed");
            assert_eq!(b.count, 22);
        }
        let cached = get_cached(dir.path(), &track_path)
            .expect("the cache must survive concurrent generation");
        assert!(std::fs::metadata(&cached.sheets[0]).unwrap().len() > 0);
        assert!(!frames_dir(dir.path(), &key(&track_path)).exists());
    }

    /// Cancellation is ref counted: the now-playing bar and the detail page ask for
    /// the same sheet, so one surface's teardown must not kill the other's pass.
    #[test]
    fn test_interest_is_ref_counted_per_path() {
        let path = "file:///test/refcount.mp4";
        assert!(begin_request(path, "bar"));
        assert!(begin_request(path, "detail"));
        assert!(!abandoned(path));
        end_request(path, "bar");
        assert!(!abandoned(path), "the detail page still wants this sheet");
        end_request(path, "detail");
        assert!(abandoned(path), "nobody left => the pass may be killed");
    }

    /// The cancel IPC can overtake the invoke it cancels (the invoke registers from a
    /// blocking thread), which would otherwise leave a pass running unwatched.
    #[test]
    fn test_cancel_that_arrives_first_stops_the_request() {
        let path = "file:///test/stillborn.mp4";
        cancel_request(path, "early");
        assert!(!begin_request(path, "early"), "a pre-cancelled request must not start");
        // The tombstone is consumed, so the same id is usable again afterwards.
        assert!(begin_request(path, "early"));
        end_request(path, "early");
    }

    /// An abandoned request bails before ffmpeg is ever spawned, and leaves no cache
    /// entry behind. Needs no ffmpeg: the check precedes the spawn.
    #[test]
    fn test_generate_bails_before_spawning_when_abandoned() {
        let dir = tempfile::tempdir().unwrap();
        let track = "file:///test/abandoned.mp4";
        let err = generate_with_progress(
            dir.path(), track, Path::new("/test/abandoned.mp4"), 213.0, Some("gone"), |_, _| {},
        )
        .expect_err("an abandoned request must not generate");
        assert_eq!(err, CANCELLED);
        assert!(get_cached(dir.path(), track).is_none());
    }

    /// `None` opts out of cancellation entirely (non-UI callers can't be abandoned),
    /// so the same unregistered call proceeds to ffmpeg and fails on its own terms.
    #[test]
    fn test_generate_without_a_request_id_is_not_cancellable() {
        let dir = tempfile::tempdir().unwrap();
        let track = "file:///test/no-request-id.mp4";
        let err = generate_with_progress(
            dir.path(), track, Path::new("/test/no-request-id.mp4"), 213.0, None, |_, _| {},
        )
        .expect_err("a missing file cannot produce a sheet");
        assert_ne!(err, CANCELLED, "opted out of cancellation, so it must have tried");
    }

    /// Mid-pass cancellation against real ffmpeg: withdraw the only interest while
    /// frames are landing and the child must die, leaving no sheet and no scratch dir.
    /// A 20-minute clip guarantees the pass is long enough to catch in the act.
    /// `#[ignore]`d because it encodes a clip; self-skips when ffmpeg is absent.
    #[test]
    #[ignore]
    fn test_cancel_kills_ffmpeg_mid_pass() {
        if !crate::video_frames::is_ffmpeg_available() {
            eprintln!("[storyboard-test] SKIPPED — ffmpeg not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("long.mp4");
        let ok = std::process::Command::new("ffmpeg")
            .args([
                "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                "testsrc2=size=320x240:rate=10:duration=1200",
                "-c:v", "libx264", "-preset", "ultrafast", "-g", "30",
                "-pix_fmt", "yuv420p", "-y",
            ])
            .arg(&f)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "failed to encode test clip");

        let track_path = format!("file://{}", f.to_string_lossy());
        let k = key(&track_path);
        assert!(begin_request(&track_path, "req"));
        // Cancelled from the progress callback, so the pass is provably still running
        // when the interest is withdrawn; the poll loop notices on its next tick.
        let mut partials = 0usize;
        let started = std::time::Instant::now();
        let mut cancelled_at = std::time::Duration::ZERO;
        let res = generate_with_progress(
            dir.path(), &track_path, &f, 1200.0, Some("req"),
            |_, _| {
                partials += 1;
                if partials == 1 {
                    cancelled_at = started.elapsed();
                    cancel_request(&track_path, "req");
                }
            },
        );
        assert!(partials > 0, "no progress fired, so nothing was cancelled mid-pass");
        assert_eq!(res.unwrap_err(), CANCELLED);

        // Whether the work is worth keeping depends on how long the pass had run (see
        // RESUME_MIN_ELAPSED), which depends on the machine — so this asserts only
        // where the answer is unambiguous, rather than assuming a speed.
        let kept = part_meta_path(dir.path(), &k).exists();
        if cancelled_at < RESUME_MIN_ELAPSED.mul_f64(0.8) {
            assert!(!kept, "a pass this cheap ({cancelled_at:?}) must leave no partial");
        } else if cancelled_at > RESUME_MIN_ELAPSED.mul_f64(1.5) {
            assert!(kept, "a pass this expensive ({cancelled_at:?}) must be resumable");
        }
        assert!(
            get_cached(dir.path(), &track_path).is_none(),
            "a cancelled pass must not leave a half-written sheet cached"
        );
        assert!(
            !frames_dir(dir.path(), &k).exists(),
            "scratch frames dir must be cleaned up after cancellation"
        );
    }

    /// Tile size for the synthetic geometry below. Deliberately tiny: these tests are
    /// about where a tile lands in the sheet, not about picture quality, and a real
    /// 400px grid would make every canvas 2 megapixels.
    const T_W: u32 = 8;
    const T_H: u32 = 6;

    /// A 22-tile 5x5 board — the shape a 213s video produces — at test tile size.
    fn tiny_geometry() -> Geometry {
        Geometry { interval_secs: 10.0, count: 22, cols: 5, rows: 5, tile_w: T_W }
    }

    fn write_frame(path: &Path, rgb: [u8; 3]) {
        let img: image::RgbImage = image::ImageBuffer::from_pixel(T_W, T_H, image::Rgb(rgb));
        let file = std::fs::File::create(path).unwrap();
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(
            std::io::BufWriter::new(file), 100,
        );
        enc.encode_image(&img).unwrap();
    }

    /// `n` frames for tiles `from..from+n`, each a distinguishable shade so a paste at
    /// the wrong slot is visible rather than merely plausible.
    fn frames_in(dir: &Path, from: usize, n: usize) -> Vec<(usize, PathBuf)> {
        std::fs::create_dir_all(dir).unwrap();
        (0..n)
            .map(|i| {
                let idx = from + i;
                let p = dir.join(format!("{:03}.jpg", idx));
                write_frame(&p, [(10 + idx * 10) as u8, 40, 200]);
                (idx, p)
            })
            .collect()
    }

    /// Colour at the centre of tile `idx` in a composed sheet. JPEG is lossy, so
    /// callers compare with a tolerance rather than for equality.
    fn tile_pixel(sheet: &Path, cols: usize, idx: usize) -> [u8; 3] {
        let img = image::open(sheet).unwrap().to_rgb8();
        let x = (idx % cols) as u32 * T_W + T_W / 2;
        let y = (idx / cols) as u32 * T_H + T_H / 2;
        img.get_pixel(x, y).0
    }

    fn close(a: [u8; 3], b: [u8; 3]) -> bool {
        a.iter().zip(b.iter()).all(|(x, y)| (*x as i32 - *y as i32).abs() <= 8)
    }

    /// The round trip a resume depends on: what a cancelled pass wrote must come back
    /// describing the same tiles, in a sheet exactly as tall as those tiles need.
    #[test]
    fn test_partial_round_trips_with_the_rows_it_filled() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(super::dir(dir.path())).unwrap();
        let g = tiny_geometry();
        let frames = frames_in(&dir.path().join("scratch"), 0, 7);

        write_partial(dir.path(), "k", &g, 213.0, None, &frames).unwrap();
        let p = read_partial(dir.path(), "k", &g, 213.0).expect("partial must be accepted");
        assert_eq!(p.tiles_done, 7);
        assert_eq!((p.tile_w, p.tile_h), (T_W, T_H));
        // 7 tiles at 5 columns is two rows — the sheet is short, not a padded full grid.
        let (w, h) = image::image_dimensions(&p.sheet).unwrap();
        assert_eq!((w, h), (T_W * 5, T_H * 2));
    }

    /// Every tile has to land in the slot its index names, or the seek bar shows the
    /// wrong moment. Checked by colour, per tile, across a row boundary.
    #[test]
    fn test_composed_tiles_land_in_their_own_slot() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(super::dir(dir.path())).unwrap();
        let g = tiny_geometry();
        let frames = frames_in(&dir.path().join("scratch"), 0, 7);
        write_partial(dir.path(), "k", &g, 213.0, None, &frames).unwrap();
        let sheet = part_sheet_path(dir.path(), "k");
        for (idx, _) in &frames {
            let want = [(10 + idx * 10) as u8, 40, 200];
            let got = tile_pixel(&sheet, g.cols, *idx);
            assert!(close(got, want), "tile {idx} shows {got:?}, expected {want:?}");
        }
    }

    /// A video interrupted twice must make progress both times: the second cancel
    /// extends the first partial rather than replacing it, and the tiles already in it
    /// stay where they were.
    #[test]
    fn test_a_partial_extends_the_one_it_resumed_from() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(super::dir(dir.path())).unwrap();
        let g = tiny_geometry();
        let scratch = dir.path().join("scratch");
        write_partial(dir.path(), "k", &g, 213.0, None, &frames_in(&scratch, 0, 7)).unwrap();
        let first = read_partial(dir.path(), "k", &g, 213.0).unwrap();

        let more = frames_in(&scratch, 7, 4);
        write_partial(dir.path(), "k", &g, 213.0, Some(&first), &more).unwrap();
        let second = read_partial(dir.path(), "k", &g, 213.0).expect("extension must be accepted");
        assert_eq!(second.tiles_done, 11);
        let (_, h) = image::image_dimensions(&second.sheet).unwrap();
        assert_eq!(h, T_H * 3, "11 tiles at 5 columns needs three rows");
        let sheet = part_sheet_path(dir.path(), "k");
        // One carried-over tile and one new one, to prove the paste didn't shift.
        assert!(close(tile_pixel(&sheet, g.cols, 3), [40, 40, 200]));
        assert!(close(tile_pixel(&sheet, g.cols, 9), [100, 40, 200]));
    }

    /// Anything that could put the seam in the wrong place is a rejection, and a
    /// rejected partial is deleted rather than re-examined on every play.
    #[test]
    fn test_partial_is_rejected_when_it_cannot_be_trusted() {
        let g = tiny_geometry();
        let cases: Vec<(&str, Box<dyn Fn(&mut PartialSheet)>)> = vec![
            ("older recipe", Box::new(|p: &mut PartialSheet| p.recipe += 1)),
            ("different grid", Box::new(|p: &mut PartialSheet| p.cols += 1)),
            ("different tile size", Box::new(|p: &mut PartialSheet| p.tile_w += 2)),
            ("different interval", Box::new(|p: &mut PartialSheet| p.interval_secs += 1.0)),
            ("different source length", Box::new(|p: &mut PartialSheet| p.duration_secs += 30.0)),
            ("no usable tiles", Box::new(|p: &mut PartialSheet| p.tiles_done = 0)),
            ("every tile, so nothing to resume", Box::new(|p: &mut PartialSheet| p.tiles_done = p.count)),
            ("more tiles than the sheet holds", Box::new(|p: &mut PartialSheet| p.tiles_done = 20)),
        ];
        for (why, mutate) in cases {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(super::dir(dir.path())).unwrap();
            write_partial(
                dir.path(), "k", &g, 213.0, None, &frames_in(&dir.path().join("scratch"), 0, 7),
            ).unwrap();
            let mut p = read_partial(dir.path(), "k", &g, 213.0).unwrap();
            mutate(&mut p);
            std::fs::write(
                part_meta_path(dir.path(), "k"), serde_json::to_string(&p).unwrap(),
            ).unwrap();

            assert!(
                read_partial(dir.path(), "k", &g, 213.0).is_none(),
                "a partial with a {why} must be rejected"
            );
            assert!(
                !part_meta_path(dir.path(), "k").exists() && !part_sheet_path(dir.path(), "k").exists(),
                "a rejected partial ({why}) must be deleted, not left to be re-read"
            );
        }
    }

    /// The saving from resuming is roughly the time already spent, so a pass that was
    /// about to finish anyway leaves nothing behind.
    #[test]
    fn test_a_cheap_pass_is_not_worth_keeping() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(super::dir(dir.path())).unwrap();
        let g = tiny_geometry();
        let frames = frames_in(&dir.path().join("scratch"), 0, 7);
        let quick = std::time::Duration::from_millis(120);
        keep_or_discard(dir.path(), "k", &g, 213.0, None, &frames, quick, Path::new("x.mp4"));
        assert!(!part_meta_path(dir.path(), "k").exists());

        keep_or_discard(
            dir.path(), "k", &g, 213.0, None, &frames, RESUME_MIN_ELAPSED, Path::new("x.mp4"),
        );
        assert!(part_meta_path(dir.path(), "k").exists(), "an expensive pass must be kept");
    }

    /// `file_stem` reports `<hash>.part` for a partial, which matches no live track —
    /// so without `entry_key` the startup sweep deleted every resumable partial.
    #[test]
    fn test_gc_keeps_a_live_partial_and_sweeps_a_dead_one() {
        let dir = tempfile::tempdir().unwrap();
        let d = super::dir(dir.path());
        std::fs::create_dir_all(&d).unwrap();
        let live = "file:///music/live.mp4";
        let dead = "file:///music/dead.mp4";
        let g = tiny_geometry();
        for track in [live, dead] {
            write_partial(
                dir.path(), &key(track), &g, 213.0, None,
                &frames_in(&dir.path().join(format!("s{}", key(track))), 0, 7),
            ).unwrap();
        }

        gc(dir.path(), &[live.to_string()]).unwrap();
        assert!(part_sheet_path(dir.path(), &key(live)).exists(), "a live partial must survive gc");
        assert!(part_meta_path(dir.path(), &key(live)).exists());
        assert!(!part_sheet_path(dir.path(), &key(dead)).exists(), "an orphaned partial must be swept");
        assert!(!part_meta_path(dir.path(), &key(dead)).exists());
    }

    /// A clip whose brightness rises with the moment it is at: each `BLOCK_SECS` of
    /// video is a flat grey, one step lighter than the last. That makes a tile
    /// self-verifying — its centre pixel says which stretch of the source it came from
    /// — which is what a resume has to get right at the seam. Keyframes land on the
    /// block boundaries (`-g` = one GOP per block), so the frame a tile samples carries
    /// that block's own value rather than the tail of the previous one. The greys stay
    /// inside 16..235: the source is limited-range YUV and anything outside that clips
    /// on the way to RGB, which would flatten the very differences being measured.
    const BLOCK_SECS: u32 = 10;

    fn encode_block_clip(path: &Path, secs: u32, extra: &[&str]) -> bool {
        let src = format!(
            "color=c=black:s=64x48:r=5:d={},format=yuv420p,geq=lum='24+7*floor(T/{})':cb='128':cr='128'",
            secs, BLOCK_SECS
        );
        let mut cmd = std::process::Command::new("ffmpeg");
        cmd.args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", &src]);
        cmd.args(extra);
        cmd.args([
            "-c:v", "libx264", "-preset", "ultrafast",
            // One GOP per block, so every tile's sample is that block's first frame.
            "-g", &(5 * BLOCK_SECS).to_string(),
            "-pix_fmt", "yuv420p", "-y",
        ]);
        cmd.arg(path).status().map(|s| s.success()).unwrap_or(false)
    }

    /// Grey level at the centre of tile `idx`, as a rough integer.
    fn tile_luma(sheet: &Path, b: &Storyboard, idx: usize) -> i32 {
        let img = image::open(sheet).unwrap().to_rgb8();
        let x = (idx % b.cols) as u32 * b.tile_w + b.tile_w / 2;
        let y = (idx / b.cols) as u32 * b.tile_h + b.tile_h / 2;
        let p = img.get_pixel(x, y).0;
        ((p[0] as i32) + (p[1] as i32) + (p[2] as i32)) / 3
    }

    /// Tiles must be shaped like the video the PLAYER shows, not like the way the
    /// frame happens to be stored. This clip is stored 4:3 but flagged 16:9 (an
    /// anamorphic source — a DVD rip, a DVB capture, some phone video), which is
    /// exactly the case `scale=W:-2` got wrong: it reproduced the horizontal squeeze
    /// faithfully, so every tile came out stretched against the video beside it.
    /// `#[ignore]`d: encodes a clip; self-skips without ffmpeg.
    #[test]
    #[ignore]
    fn test_anamorphic_tiles_follow_the_display_aspect() {
        if !crate::video_frames::is_ffmpeg_available() {
            eprintln!("[storyboard-test] SKIPPED — ffmpeg not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("anamorphic.mp4");
        // 4:3 pixels, tagged for 16:9 display => SAR 4:3, DAR 16:9.
        assert!(encode_block_clip(&f, 60, &["-aspect", "16:9"]), "failed to encode test clip");

        let track_path = format!("file://{}", f.to_string_lossy());
        let b = generate_with_progress(dir.path(), &track_path, &f, 60.0, None, |_, _| {})
            .expect("generate");
        let want = (b.tile_w as f64 * 9.0 / 16.0).round();
        assert!(
            (b.tile_h as f64 - want).abs() <= 2.0,
            "tile is {}x{}; a 16:9 DISPLAY aspect wants a height near {} (the stored 4:3 \
             ratio would give {})",
            b.tile_w, b.tile_h, want, (b.tile_w as f64 * 3.0 / 4.0).round()
        );
    }

    /// End-to-end resume: a partial left by a cancelled pass is extended rather than
    /// re-decoded, and the tiles either side of the seam still depict their own moment.
    ///
    /// Two things make this airtight rather than merely plausible. The carried-over
    /// region is **marked** (tile 0 painted magenta), so a run that quietly started
    /// over instead of resuming fails — a full re-decode would put grey there. And the
    /// clip's brightness encodes its own timeline, so a seam that is off by even one
    /// tile shows up as the wrong grey. `#[ignore]`d: encodes a clip; self-skips
    /// without ffmpeg.
    #[test]
    #[ignore]
    fn test_resume_extends_a_partial_and_lands_the_seam() {
        if !crate::video_frames::is_ffmpeg_available() {
            eprintln!("[storyboard-test] SKIPPED — ffmpeg not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("blocks.mp4");
        let secs = 300u32;
        assert!(encode_block_clip(&f, secs, &[]), "failed to encode test clip");
        let track_path = format!("file://{}", f.to_string_lossy());
        let k = key(&track_path);
        let g = geometry(secs as f64);

        // 1. A straight-through pass — the baseline the resumed one must reproduce.
        //    Its own correctness is pinned by the greys rising tile by tile: that only
        //    holds if each tile sampled its own block, in order.
        let full = generate_with_progress(dir.path(), &track_path, &f, secs as f64, None, |_, _| {})
            .expect("straight-through generate");
        assert_eq!(full.count, g.count);
        let baseline: Vec<i32> = (0..full.count)
            .map(|i| tile_luma(&sheet_path(dir.path(), &k), &full, i))
            .collect();
        // `count` can over-claim the final tile by one — `fps=1/N` has no input frame
        // left to fill the last slot — and the grid pads it black. That is pre-existing
        // behaviour, so the ordering check covers the tiles that carry a frame.
        let filled = baseline.iter().take_while(|v| **v > 4).count();
        assert!(
            filled + 1 >= full.count,
            "only {filled} of {} tiles carry a frame; at most the last may be padding",
            full.count
        );
        for i in 1..filled {
            assert!(
                baseline[i] - baseline[i - 1] >= 4,
                "tile {i} ({}) should be a step lighter than tile {} ({}) — the clip \
                 encodes its own timeline, so this means the tiles are not in time order",
                baseline[i], i - 1, baseline[i - 1]
            );
        }

        // 2. Stand in for a pass cancelled after three rows: crop those rows out of the
        //    finished sheet (which is pixel-for-pixel what such a pass would have left),
        //    mark tile 0, and write the sidecar. Then remove the finished sheet, so the
        //    only way to a complete board is through the partial.
        let rows_keep = 3usize;
        let tiles_done = rows_keep * full.cols;
        let mut cropped = image::imageops::crop_imm(
            &image::open(sheet_path(dir.path(), &k)).unwrap().to_rgb8(),
            0, 0, full.tile_w * full.cols as u32, full.tile_h * rows_keep as u32,
        ).to_image();
        for y in 0..full.tile_h {
            for x in 0..full.tile_w {
                cropped.put_pixel(x, y, image::Rgb([255, 0, 255]));
            }
        }
        cropped.save(part_sheet_path(dir.path(), &k)).unwrap();
        let meta = PartialSheet {
            recipe: RESUME_RECIPE,
            tiles_done,
            count: g.count,
            cols: g.cols,
            rows: g.rows,
            tile_w: full.tile_w,
            tile_h: full.tile_h,
            interval_secs: g.interval_secs,
            duration_secs: secs as f64,
            sheet: part_sheet_path(dir.path(), &k).to_string_lossy().to_string(),
        };
        std::fs::write(part_meta_path(dir.path(), &k), serde_json::to_string(&meta).unwrap()).unwrap();
        std::fs::remove_file(sheet_path(dir.path(), &k)).unwrap();
        std::fs::remove_file(meta_path(dir.path(), &k)).unwrap();

        // 3. The resumed pass.
        let resumed = generate_with_progress(dir.path(), &track_path, &f, secs as f64, None, |_, _| {})
            .expect("resumed generate");
        let sheet = sheet_path(dir.path(), &k);
        assert_eq!((resumed.count, resumed.cols, resumed.rows), (full.count, full.cols, full.rows));
        assert_eq!(
            image::image_dimensions(&sheet).unwrap(),
            (full.tile_w * full.cols as u32, full.tile_h * full.rows as u32),
            "a resumed sheet must be the full grid, not the partial's height"
        );
        assert!(
            tile_luma(&sheet, &resumed, 0) > 150,
            "tile 0 lost the marker, so the pass re-decoded from zero instead of resuming"
        );
        // Every tile after the marker, on both sides of the seam, shows what the
        // straight-through pass put there. One tile of drift at the seam would read as
        // a whole step of grey.
        for i in 1..resumed.count {
            let got = tile_luma(&sheet, &resumed, i);
            let side = if i < tiles_done { "carried over" } else { "newly decoded" };
            assert!(
                (got - baseline[i]).abs() <= 5,
                "{side} tile {i} reads {got}, but a straight-through pass puts {} there \
                 (seam at {tiles_done})",
                baseline[i]
            );
        }
        assert!(
            !part_sheet_path(dir.path(), &k).exists() && !part_meta_path(dir.path(), &k).exists(),
            "the finished sheet supersedes the partial, which must not be left behind"
        );
    }

    #[test]
    fn test_tile_width_fills_the_sheet_budget() {
        // Short video (5x5) gets large tiles; only a long one (10x10) is squeezed.
        assert_eq!(tile_width(5), 400);
        assert_eq!(tile_width(10), 200);
        // Capped so a 1- or 2-tile video doesn't produce an oversized sheet.
        assert_eq!(tile_width(1), MAX_TILE_WIDTH);
        assert_eq!(tile_width(2), MAX_TILE_WIDTH);
        assert_eq!(tile_width(0), MAX_TILE_WIDTH); // guard against div-by-zero
    }

    #[test]
    fn test_sheet_never_exceeds_the_width_budget() {
        for secs in [1.0, 30.0, 213.0, 999.0, 1000.0, 5021.0, 11138.0, 86400.0] {
            let g = geometry(secs);
            let sheet_w = g.cols as u32 * g.tile_w;
            assert!(
                sheet_w <= MAX_SHEET_WIDTH,
                "{secs}s: {} cols x {}px = {}px exceeds the {}px budget",
                g.cols, g.tile_w, sheet_w, MAX_SHEET_WIDTH
            );
        }
    }
}
