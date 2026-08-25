# Spec: Video Seek Previews (hover thumbnails on the seek bar)

## Summary

Hovering the seek bar on a **video** track shows a small thumbnail of that moment,
inside the time bubble that already appears there.

Two producers, **one data shape**:

- **Plugin sources (YouTube et al.)** → the source's own published storyboard
  sprites. YouTube already generates these; we download and render them. No decoding.
- **Local files** → one `ffmpeg` pass emits a sprite sheet (`fps=1/N,scale,tile=`).

Both produce the same `Storyboard` descriptor, so the seek bar has exactly **one**
renderer and the cache has exactly one entry type.

This is **not** a new decoder or a new player. Nothing decodes video in the app
process: tier 1 downloads finished JPEGs, tier 2 shells out to `ffmpeg` exactly as
`video_frames.rs` already does.

Once the sprite exists it also **supersedes most of the 4-frame capture**:
`video_frames.rs` drops to a single frame at 10% (the video's thumbnail, for queue
art and the hero), while the filmstrip and `VideoRowThumb` hover cycling migrate to
sprite tiles and gain 100 moments instead of 4. Net effect is *less* extraction work
than today — see "Reducing `FRAME_COUNT` to 1".

## Implementation status

**All three tiers are implemented**, across this repo and `outcast1000/viboplr-ytdlp`.

Backend (`src-tauri/`):
- `storyboard.rs` — `geometry()`, `tile_width()`, generation, path-keyed cache, `gc()`,
  `enforce_cap()`. 14 unit tests plus an `#[ignore]`d real-ffmpeg test covering 16:9
  *and* 4:3 (the latter is why `tileH` is read from the produced sheet).
- `commands::get_storyboard` (cache-only) / `commands::extract_storyboard` (generates)
  / `commands::cancel_storyboard` (withdraws one caller's interest — see
  "Switching it off, and stopping a pass" below).
- `db::get_all_track_paths()` — the liveness set for `gc`.
- Startup sweep (`gc` then `enforce_cap`) on a background thread; cache entries also
  dropped on track delete beside `delete_cached_frames`.
- `video_frames.rs` — `FRAME_COUNT` reduced to **1** at position `0.10`.

Frontend (`src/`):
- `utils/storyboard.ts` — `tileIndexAt` / `tileStartSecs` / `tileFitStyle` /
  `tileCoverStyle` / `spreadTileIndices` / `schemeOf`. 30 unit tests.
- `StoryboardTile.tsx` — the one renderer, in fit (percentage, scales to any box) or
  cover (pixel, self-measuring) mode.
- `useStoryboard.ts` routes by scheme and reports status.
- Consumers: seek bubble in `NowPlayingBar` **and** `FullscreenControls` (which gained
  a hover bubble it never had), `VideoFilmstrip` (8 moments, was 4 frames),
  `VideoFrameCard` (hero art, sharp poster + tile cycling), `VideoRowThumb` (sharp
  poster + tile cycling, sheet fetched lazily on first hover).

Plugin API (host side):
- `api.playback.onResolveStoryboard(scheme, handler)`, registered per-plugin and
  cleared on deactivate/reload. `resolveStoryboardByUri` bounded at 10 s; timeout,
  throw and `null` all mean "no preview".
- Documented in `.claude/rules/plugins.md` and `docs/plugin-dev.html`.

ytdlp plugin (`outcast1000/viboplr-ytdlp`, unreleased):
- `storyboardFromFormats()` picks a level from the `yt-dlp -j` output the resolver
  already fetches; `resolveStoryboard()` caches sheet **bytes** under plugin storage.
- 8 unit tests. Registration is **feature-detected**, so `minAppVersion` stays at
  1.0.3: on an older host the plugin omits this feature rather than being blocked.

Still open (product calls, not blockers): see "Open questions".

## Switching it off, and stopping a pass

Generation is a setting: **Settings → Playback → "Video seek previews"** (store key
`videoStoryboards`, default on). It gates **tier 2 only** — the local ffmpeg pass.
A sheet already on disk, and a sheet the source published itself (tier 1), cost
nothing to produce, so both are still served with the setting off; `useStoryboard`
reports `status: "off"` when a video has neither and nothing was decoded for it.
Gating the *renderers* instead would have thrown away previews that are free.

A pass in flight is **stopped**, not left to finish. The trigger is
`useStoryboard`'s effect cleanup — the track changed, the view closed, the setting
went off — which invokes `cancel_storyboard`; the poll loop in
`generate_with_progress` kills the ffmpeg child on its next 80 ms tick, cleans up the
scratch dir, and returns `CANCELLED` (a *status*, not an error to log). A full
keyframe decode for a video the user has already left is the exact cost this feature
was designed to keep small.

Cancellation is **ref counted per track path**, and has to be: generation is
single-flight but two surfaces routinely want the same sheet (the now-playing bar and
the track detail page), so a bare "cancel this path" would let one surface's teardown
kill the other's still-wanted pass. Each `extract_storyboard` carries its own request
id, registered by `storyboard::begin_request`; the pass dies only once a path's set of
ids empties. Two consequences worth knowing:

- A cancel can **overtake** the invoke it cancels (the invoke registers from a
  blocking thread), so `cancel_request` leaves a tombstone that makes the matching
  `begin_request` return false and bail before ffmpeg is spawned.
- A waiter that was sleeping on the single-flight condvar re-checks abandonment when
  it wakes: if the winner it waited on was killed there is no cache to serve, and
  without that check the loser would start the very pass the user just walked away
  from.

## Resuming a cancelled pass

A cancelled pass **keeps what it extracted**. It stitches the frames it had into a
short sheet — `cols` wide, only as many rows as are full — writes a `<hash>.part.jpg`
plus a `<hash>.part.json` sidecar recording how far it got, and the next pass seeks
straight to that point (`-ss`), decodes only the remainder (`-frames:v`), and composes
the two into the finished sheet. So a long source that is interrupted repeatedly makes
progress across plays instead of restarting from zero each time.

The short sheet is deliberately **the same shape as the finished one** — same tile
size, same column count — because that is what makes a resume a paste rather than a
re-layout, and it means `utils/storyboard.ts` needs no notion of a partial at all
(`locate()` assumes every sheet in a descriptor shares one `cols × rows`, so a
remainder appended as "sheet 1" would have broken every consumer).

Rules worth knowing before touching this:

- **`RESUME_MIN_ELAPSED` (1 s) is the whole gate on whether a partial is written.**
  What a resume saves is roughly the time already spent, and a typical music video's
  entire pass is 0.3–0.5 s — persisting a sheet to save that is churn. This is what
  confines partials to the sources where a skip actually throws work away.
- **`RESUME_RECIPE` must be bumped** whenever the tiles themselves change — the
  interval/grid maths, the scale filter, the encoder. A partial cut by an older recipe
  cannot be extended by a newer one and the seam would be the only symptom.
- **A partial that can't be trusted is deleted, not re-examined.** `read_partial`
  rejects a stale recipe, a geometry that no longer matches the source, and a sheet
  whose pixel dimensions disagree with the tile count it claims (a torn write) — each
  time removing both files, so a bad partial can't cost a validation on every play.
- **`gc` / `enforce_cap` group by `entry_key`, not `file_stem`.** `file_stem` reports
  `<hash>.part` for a partial, which matches no live track, so the startup sweep would
  delete every resumable partial on the next launch. That was a real bug in the first
  cut of this and it is what the `.part` strip exists for.
- **Composing re-encodes the carried-over tiles**, so a repeatedly interrupted video
  loses a little quality per cycle. `COMPOSE_QUALITY` (92, above ffmpeg's `-q:v 5`)
  makes the decay slow enough not to matter over the handful of cycles a real user
  produces. Don't lower it to save disk.
- **`start_index` on the progress event exists for this.** A resumed pass extracts the
  *tail* of the video, so its frame files start mid-way; a consumer reading them
  positionally would caption every one with the wrong timestamp. `partialStoryboard`
  pads the slots before it, which the existing "no sheet for this tile" guards already
  render as no tile.

`test_resume_extends_a_partial_and_lands_the_seam` (`#[ignore]`d, real ffmpeg) is what
pins the risky half — the `-ss` alignment. It builds a clip whose brightness rises with
time, so a tile's own pixels say which stretch of the source it came from, and it
**marks** the carried-over region (tile 0 painted magenta) so a run that quietly
re-decoded from zero instead of resuming fails rather than passing on a plausible-
looking sheet.

## Tiles follow the display aspect, not the stored one

The scale step is `scale={tile_w}:trunc({tile_w}/dar/2)*2,setsar=1` — height from the
source's **display** aspect ratio. It was `scale={tile_w}:-2`, which derives the height
from the stored width/height and therefore ignores the sample aspect ratio: an
anamorphic source (a DVD rip, a DVB capture, some phone video) stores non-square
pixels, so that faithfully reproduced the squeeze and every tile came out stretched
against the video the player was showing — mpv scales to `dar`. `setsar=1` then stops
the encoder recording a non-square ratio that nothing downstream reads (JPEG carries
no usable SAR, and neither the WebView nor the `image` crate would honour one).

`video_frames.rs` carries the same correction for the single large frame
(`thumbnail=50,scale=trunc(720*dar/2)*2:720,setsar=1`), so the queue art, the hero and
the strip all agree about a video's shape.

`tile_h` is still **read from the produced sheet** rather than computed here: the
expression rounds, and the sheet is the only thing that knows what actually came out.
Pinned by `test_anamorphic_tiles_follow_the_display_aspect` (`#[ignore]`d, real
ffmpeg), which encodes a 4:3 frame tagged for 16:9 display and asserts the tile follows
the 16:9.

## Decisions (settled during design)

| Decision | Choice | Why |
|---|---|---|
| Data shape | Sprite sheet + geometry descriptor | YouTube's storyboards already *are* this; ffmpeg `tile=` emits it natively |
| Local producer | **One** `ffmpeg` pass, keyframe-only | Measured cheaper than today's 4-frame path in time *and* memory, for 9× more frames |
| Local geometry | `interval = max(10 s, duration / 100)`, ≤ 100 tiles, single sheet | Single sheet removes all splitting logic. The 10 s floor is a product decision (see the trade below) |
| Tile width | **Adaptive**: `min(400, 2000 / cols)` | The budget is per *sheet*, so a short video (5×5) affords 400 px tiles while only a long one (10×10) is squeezed to 200. A fixed size would have softened hero art on every video to accommodate the rare long one |
| `FRAME_COUNT` | **4 → 1**, keeping position `0.10` | The sprite serves the filmstrip and hover cycling *better* than 4 files do. Cuts the concurrency-1 queue-art path 4× |
| Renderer | CSS `background-position` on a sprite | No canvas → no pixel reads → no cross-origin taint |
| Cache key | Scheme-prefixed **path/URI** | Metadata keys collide across different videos with equal title+duration |
| Cache geometry | **Self-describing** sidecar, not a version prefix | Old entries stay usable instead of needing invalidation |
| Plugin sheets cached | In **plugin** storage | The plugin owns yt-dlp and URL expiry; host caches only what it generated |
| Remote non-plugin video (Subsonic / manifest / P2P) | **No previews in v1** | No published storyboard, no local file; every hover would be network I/O |
| In-app decoding (canvas or a third mpv handle) | **Rejected** | Measured +276 MB (WebKit) / +283 MB (mpv), both retaining memory after use |

## Goals

1. A thumbnail in the seek-bar hover bubble for video tracks. Granularity is
   **source- and duration-determined, never fixed** — the renderer reads
   `intervalSecs` from the descriptor and assumes nothing. Plugin tier: whatever the
   source publishes (2–10 s for YouTube). Local tier: `max(10 s, duration / 100)`.
2. Zero new runtime dependencies and zero new decoders in-process.
3. Reuse the existing hover affordance (`seekHover` + `.now-seek-bubble`).
4. **Net-reduce** local video extraction cost. One frame plus a 100-tile sprite
   (0.45 s, ~243 KB) is cheaper than today's four frames (0.60 s, ~260 KB), and the
   queue-art path — `VideoFrameQueue` at concurrency 1, triggered per video row —
   gets 4× faster.
5. Bounded disk growth — unlike the waveform and video-frame caches today.

## Non-Goals

- Previews for Subsonic / manifest / P2P video (see Open Questions).
- Audio-track previews (the waveform already serves that surface).
- Frame-accurate previews. Keyframe-limited granularity is fine.
- Persisting anything derived from an expiring URL (we cache bytes, never URLs).
- Preserving the hero's 4-image crossfade for video tracks — see the trade in
  "Reducing `FRAME_COUNT` to 1".

## Measurements that drove the design

All measured during design on this machine (M-series, 10 cores, ffmpeg 8.0.1,
vendored libmpv, Playwright WebKit 26.4 / Chromium headless shell). Source clip:
5 min synthetic 1080p H.264, keyframes every ~8.3 s (x264 default `-g 250`).

**Why one ffmpeg pass, not N spawns:**

| Approach | Wall | Peak RSS | Frames |
|---|---|---|---|
| Today's 4-frame filmstrip path | 0.60 s | **290 MB** | 4 |
| 10 spawns (the obvious "just raise N") | ~1.5 s | 290 MB | 10 |
| **One `fps=1/5,tile=` keyframe pass** | **0.36 s** | **83 MB** | **36–60** |
| One full-decode `tile=` pass | 3.2 s | 161 MB | 60 |
| Single frame on demand, per hover | 0.10 s **each** | 155 MB **each** | 1 |

The 290 MB is `thumbnail=50` buffering 50 decoded 1080p frames. Tile density is
free once decoding: 60 tiles and 150 tiles both measured 3.2 s on the full-decode
path. Keyframe-only costs ~1/60th the CPU of full decode but yields keyframe
granularity (36 distinct of 60 grid slots on the test clip).

**Why not decode in-process:**

| Approach | Latency | Peak RSS | Released after? |
|---|---|---|---|
| Hidden `<video>` + canvas, WebKit | ~24 ms/seek | +276 MB | ❌ retains +85 MB |
| Hidden `<video>` + canvas, Chromium | ~0 ms/seek | +72 MB | ✅ |
| mpv thumbnailer, precise seek | 17 ms/frame | +283 MB | ❌ nothing released |
| mpv thumbnailer, keyframe seek | 5 ms/frame | +283 MB | ❌ |

Both in-process options are excellent on latency and unacceptable on memory for a
hover affordance. mpv also costs a 2.8 s handle creation that `config=no` /
`load-scripts=no` / `terminal=no` do **not** reduce. Canvas additionally can't
persist: `drawImage` succeeds on cross-origin video but `toDataURL` and
`getImageData` both throw `SecurityError` (verified in WebKit *and* Chromium).

**YouTube's published storyboards** (`dQw4w9WgXcQ`, 213 s) — plain JPEGs on
`i.ytimg.com`, discovered via yt-dlp as formats `sb0`–`sb3`:

| Level | Tile | Grid | Sheets | Thumbs | Bytes | Fetch |
|---|---|---|---|---|---|---|
| sb3 | 48×27 | 10×10 | 1 | 100 | 27 KB | 454 ms |
| **sb2** | **80×45** | 10×10 | 2 | 200 | **58 KB** | 654 ms |
| sb1 | 160×90 | 5×5 | 5 | 125 | 169 KB | 1668 ms |
| sb0 | 320×180 | 3×3 | 12 | 108 | — | — |

At a given duration all of `sb0`–`sb2` share the same **interval**; they differ in
tile resolution, and sheet count grows to compensate. `sb2` is the default choice.

**The interval scales with video length** — measured across a 585× range:

| Video length | `sb2` interval | Sheets | Tiles used |
|---|---|---|---|
| 19 s | *no storyboards offered* | — | — |
| 213 s | 1.97 s | 2 | ~108 |
| 473 s | 4.73 s | 1 | 100 |
| 600 s | 4.96 s | 2 | ~121 |
| 2451 s | 9.92 s | 3 | ~247 |
| 5021 s | 9.96 s | 6 | ~504 |
| 11138 s | 9.99 s | 12 | ~1115 |

Quantized to roughly **2 s / 5 s / 10 s** with thresholds near ~250 s and ~1000 s,
and **10 s is a ceiling** (1.4 h and 3.1 h both land at ~10 s). Values are fitted to
divide the duration evenly, hence 1.97 rather than 2.00. Capacity exceeds duration
whenever the fit isn't exact, so a partial, padded final sheet is the norm.

Two consequences for us:

- **`sb3` is not a seek-preview level.** It is always exactly one 10×10 sheet, so its
  interval is `duration / 100` — 2.13 s on a short video but **111 s/tile at 3 hours**.
  It is an overview strip. Level selection must consider the resulting interval, not
  just tile size, and should skip `sb3` for anything long.
- **Very short videos have no storyboards.** Tier 1 returns `null`; the bubble stays
  text-only. No special handling needed, but don't treat it as an error.

## Data model

One type, shared by both producers, the plugin API, and the cache sidecar:

```ts
interface Storyboard {
  sheets: string[];      // resolved image URLs (remote) or asset paths (local), in time order
  rows: number;
  cols: number;
  tileW: number;
  tileH: number;
  startSecs: number;     // timestamp of the first tile
  intervalSecs: number;  // seconds between consecutive tiles
}
```

Tiles are laid out row-major within a sheet, sheets consecutive in time. Total
capacity is `sheets.length * rows * cols`; a partial final sheet is expected and
padded tiles are simply never addressed.

Deliberately **not** in the descriptor: any recipe/version field. Geometry is the
only thing a renderer needs, so an entry written by an older producer stays
renderable. (Contrast `video_frames.rs`, which has no versioning *and* isn't
self-describing — changing `FRAME_POSITIONS` or `SCALE_FILTER` today silently
serves stale layouts.)

### Locating a tile

```ts
const i     = Math.floor((t - startSecs) / intervalSecs);
const per   = rows * cols;
const sheet = Math.floor(i / per);
const n     = i % per;
const col   = n % cols;
const row   = Math.floor(n / cols);
// background-position: -(col * tileW)px -(row * tileH)px
```

Clamp `i` into `[0, capacity - 1]`; return nothing when out of range so the bubble
falls back to text-only.

## Tier 1 — plugin-supplied storyboards

### API seam (new)

```ts
// api.playback
onResolveStoryboard(scheme: string, handler: (id: string) => Promise<Storyboard | null>)
```

Mirrors the existing `onResolveStreamByUri(scheme, handler)` contract: keyed by URL
scheme, returns `null` when unavailable. Host-side timeout **10 s** (a cold yt-dlp
run is slow; the host must not hang the seek bar waiting on it).

Registered handlers are dropped on plugin deactivate/reload, like every other
`usePlugins` registry.

### ytdlp plugin responsibilities

Lives in `outcast1000/viboplr-ytdlp` (per the plugin-first rule; the host gets no
YouTube-specific code).

1. **Capture storyboards in the existing resolve call.** `sb*` formats come from the
   same `-J` metadata that resolves the stream. Spawning yt-dlp a second time is the
   expensive part — seconds, and yt-dlp startup alone is ~16 s on some machines.
   This is the main reason to cache: the bytes are only 58 KB, the *discovery* is
   what costs.
2. **Pick a level** — default `sb2` (80×45); fall back to the next available level.
3. **Download the sheets and cache the bytes** via
   `api.storage.files.download(path, url)`, keyed by video id.
   URLs carry an expiring `sqp` signature (~6 h) while the content is permanent, so
   a cached URL is worthless tomorrow and cached pixels are forever.
4. Return a `Storyboard` whose `sheets` point at the cached files.

### Host responsibilities

Route by the current track's scheme, hand the result to the renderer, cache nothing
(the plugin owns its bytes). Bump the plugin's `minAppVersion` when this API lands.

## Tier 2 — local files

### Producer

One invocation, added alongside the existing frame pass (which is reduced to a single
frame once this ships — see "Reducing `FRAME_COUNT` to 1"):

```
ffmpeg -hide_banner -loglevel error -y -skip_frame nokey -i <file> -an \
  -filter_complex "fps=1/<interval>,scale=<tileW>:-2,split=2[strip][grid];[grid]tile=<cols>x<rows>[sheet]" \
  -map "[strip]" -c:v mjpeg -q:v 5 -pix_fmt yuvj420p <framesDir>/%03d.jpg \
  -map "[sheet]" -frames:v 1 -c:v mjpeg -q:v 5 -pix_fmt yuvj420p <sheet>
```

- `-skip_frame nokey` is what makes this cheap (83 MB / 0.36 s vs 161 MB / 3.2 s).
- The `[strip]` side output is **progress, not cache**: while ffmpeg runs, the backend
  polls the frames dir and streams the completed frames to the frontend as
  `storyboard-partial` events (cumulative, in time order), so the detail-page
  filmstrip fills in as moments land instead of sitting on placeholders. The frame
  files are scratch — deleted the moment the sheet exists, by which point the
  frontend has the real storyboard to switch to. The `[sheet]` output is byte-for-byte
  what the old single-output `-vf` pass produced.
- `fps=1/<interval>` puts tiles on a fixed grid so timestamps are computable without
  a second probe. This matters because **`ffprobe` is not available** — the
  `dependencies.rs` `REGISTRY` (which is also the exec allow-list) has only `ffmpeg`
  and `yt-dlp`.
- Emit **MJPEG unconditionally**, not WebP. `webp_supported()` probes for `libwebp`
  and homebrew's ffmpeg 8.0.1 does not have it, so the existing WebP path already
  silently falls back on at least one dev machine. Sprites are small; skip the branch.
Implemented in `src-tauri/src/storyboard.rs`:

- **`interval = max(MIN_INTERVAL_SECS, duration / MAX_TILES)`** with
  `MIN_INTERVAL_SECS = 10`, `MAX_TILES = 100`.
- **Tile width is adaptive**: `tile_width(cols) = min(MAX_TILE_WIDTH, MAX_SHEET_WIDTH / cols)`
  with `MAX_TILE_WIDTH = 400`, `MAX_SHEET_WIDTH = 2000`. Sheet pixel count — and so
  disk — stays roughly constant regardless of grid size.
- **Tile count** `= ceil(duration / interval)`, clamped to `[1, 100]`.
- **Grid** is the smallest near-square that holds the count (`cols = ceil(sqrt(n))`),
  so a 213 s video is 22 tiles in a 5×5 grid, and only videos ≥ 1000 s reach 10×10.
  ffmpeg's `tile` filter pads unused slots with black; `count` in the descriptor is
  what stops the renderer addressing them.
- **Always one sheet.** No splitting, no sheet-index arithmetic in the local path, one
  file per video. (`sheets` is still a list, so plugin-supplied multi-sheet
  storyboards share the type.)

Two consequences of the 10 s floor, recorded because they were measured rather than
assumed. On a 213 s 1080p clip the floor yields 22 tiles at **0.30 s / ~85 MB**;
dropping it for `duration/100` yields 100 tiles at **the same 0.30 s / ~86 MB**, since
tile density is free once decoding. So the floor trades **distinct previews (58 → 23)**
for **138 KB of disk**, and its real benefit is a coarser, more predictable grid rather
than any compute saving. Second: on long content the tile cap binds instead, giving
**~111 s/tile at 3 hours** — an overview strip rather than a seek preview. YouTube
avoids that by going multi-sheet (12 sheets at ~10 s); the single-sheet constraint is
what we trade for it, on the grounds that hour-plus video is rare in a music player.

Measured sheet sizes are smaller than first estimated because the floor caps tiles for
short videos: **46 KB** (720p 16:9, 22 tiles) and **64 KB** (480p 4:3, 22 tiles).
Only videos ≥ 1000 s reach 100 tiles and ~180 KB.

`geometry(duration_secs)` is the single pure helper, unit-tested across a 1 s–24 h
range for the invariants that matter: never zero tiles, never more than `MAX_TILES`,
grid always large enough, interval never below the floor, and the last tile always
landing inside the video.
- Duration comes from the existing `video_frames::get_video_duration()`.
- Keyframe-only decode yields ~58 distinct tiles of 100 on a typical 1080p clip
  (duplicates where the grid lands between keyframes). Rendering a duplicate is
  harmless. Full decode would give 100/100 for 2.0 s and 167 MB instead of 0.30 s and
  85 MB — affordable as a post-playback background job, and still under the 290 MB
  the existing filmstrip path already spikes. **Not in v1**; revisit if 58 distinct
  reads as mushy in practice.

### Scheduling

Reuse `VideoFrameQueue` (`src/videoFrameQueue.ts`) — FIFO, concurrency 1, cache
check on enqueue, `extract_*` on miss, referentially-stable
`useSyncExternalStore` snapshots. Add a storyboard entry kind rather than a second
queue, so sprite generation can never run concurrently with filmstrip extraction
and compete for CPU with the active decoder.

Enqueue when a video track **starts playing**, not on first hover — 0.36 s is fast
but the user hovering wants it now.

Gate on ffmpeg availability. It is `managed: None` (instruct-only — the app cannot
install it), so this tier is simply absent for users without it. Reuse the existing
"Install ffmpeg for video frame previews" affordance rather than inventing a new one.

## Cache

`{app_dir}/storyboards/` — flat and content-addressed, following the waveform cache
(`{app_dir}/waveforms/{md5(key)}.json`):

```
storyboards/{md5(key)}.json          # the Storyboard descriptor
storyboards/{md5(key)}.0.jpg         # sheet 0
storyboards/{md5(key)}.1.jpg         # sheet 1 …
storyboards/{md5(key)}.part.jpg      # a cancelled pass's short sheet (resume point)
storyboards/{md5(key)}.part.json     # …and how far it got
storyboards/{md5(key)}.frames/       # scratch frames, only while a pass is running
```

**Key = `md5("v2::" + the track's scheme-prefixed path/URI)`**, not metadata. The waveform cache
keys on `v3::artist::title::duration`, which is safe there because a song's waveform
is ~identical across encodings. Frames are not: two videos with equal title and
duration (a studio video and a live take) would collide and show the wrong footage.
The codebase already learned this — `shelfVideoKey`'s comment says keying by path
"stops two same-titled videos from sharing — and swapping — one frame."

The `v2::` prefix is a **recipe stamp**, the one the waveform cache's `v3::` already
demonstrated: bump it whenever the tiles change and every entry cut by the old recipe
becomes an orphan the startup `gc` sweeps. `v2` is the display-aspect scaling — a
cached sheet doesn't record whether its source was anamorphic, so there is no way to
invalidate only the wrong ones, and without the bump the fix would never reach anyone
who already had a cache. The cost is one re-decode per video, lazily, once.
`video_frames.rs` needed the same and got `FRAME_RECIPE` + a `recipe.json` marker
beside its frames (its cache is a directory per track, so a key change would have
leaked the old dirs instead of orphaning files a sweep already collects).

Local files key on `file://…`; plugin tracks key on their URI (`ytdlp://<id>` is a
stable, perfect identity).

### Garbage collection (new — neither existing cache does this)

A waveform is 2–4 KB of JSON, so unbounded growth is genuinely fine. Sprites are
larger, but bounded by construction — never more than 100 tiles on one sheet. Measured:
**46 KB** for a 213 s 16:9 clip (22 tiles) and **64 KB** for 4:3, rising to ~180 KB only
once a video is long enough to reach 100 tiles. Call it ~50 KB at typical music-video
lengths, so a 2,000-video library is ~100 MB. Plugin sheets vary by level (27–169 KB for
YouTube `sb3`–`sb1`) and grow with duration in sheet count.

Today `video_frames` is pruned only on explicit track delete
(`commands/library.rs:732` → `delete_cached_frames`), so anything removed by another
path leaks forever; waveforms leak unconditionally. Storyboards must not inherit that.

- `gc()` at startup, modelled on `main_playlist.rs::gc()` (diff on-disk files
  against live state, sweep orphans). Flat hashed filenames make this a set
  difference against live track paths.
- Hard ceiling with LRU eviction by mtime. Proposed default **256 MB**.
- Hook into the existing track-delete path alongside `delete_cached_frames`.

## Rendering

`NowPlayingBar.tsx` already has everything needed:

- `.now-seek-track`'s `onMouseMove` computes `seekHover: { pct, x }`.
- `.now-seek-bubble` renders at `left: seekHover.x` with the hover timestamp.
- For video, `waveformPeaks` is always `null` (the analyzability gate excludes
  video), so `SegmentedSeekBar` renders — no interaction with the waveform's hover tint.

The change is a `<div>` inside the bubble with the sprite as `background-image` and
a computed `background-position`. No canvas, no `<img>` per tile, no pixel reads.
Skin-safe: the tile is content, and the surrounding chrome reuses the bubble's
existing tokens.

`FullscreenControls.tsx` has the same seek-bar structure and should get the same
treatment; the tile-locating helper is shared and pure.

Degradation, in order: storyboard tile → nothing (text-only bubble, today's
behaviour). Explicitly **not** falling back to the 4 filmstrip frames — one preview
per ~50 s reads as a bug rather than a feature. (Revisit if v1 ships and the gap
is visible; the frames are already cached, so it stays cheap to add.)

## Per-source behaviour

| Source | Producer | Notes |
|---|---|---|
| Local `file://` | Tier 2 (ffmpeg sprite) | Requires ffmpeg; absent otherwise |
| `ytdlp://` (YouTube) | Tier 1 (`sb2`) | Best case: 58 KB, no decode, no extra bandwidth |
| Other plugin schemes | Tier 1 if the plugin implements the handler | Opt-in per plugin |
| `subsonic://`, manifest `http(s)://`, P2P | **None in v1** | No storyboard published, no local file |

## Reducing `FRAME_COUNT` to 1

Once the sprite exists, three of the four multi-frame consumers are better served by
it, so `video_frames.rs` drops from 4 frames to **1, at the existing `0.10`
position**. Keeping 0.10 rather than moving to 0.15 means every cached `frame_0.*`
stays valid — no invalidation, and `video_frames.rs` has no recipe versioning to
lean on anyway.

### Division of labour after the change

| Consumer | Source | Change |
|---|---|---|
| Queue / shelf art (`useQueueVideoFrames`) | the single 720p frame | none — `rebuildReadyFrameSnapshot()` already uses `entry.frames[0]` |
| Hero background (`useDetailHeroImages`) | the single 720p frame | **degrades**: `paths.slice(0, MAX_LAYERS)` yields 1 layer, so a static background instead of a 4-image crossfade |
| `VideoFilmstrip` | **sprite tiles** | migrate — gains 100 moments instead of 4, same timestamp + click-to-seek model |
| `VideoRowThumb` hover cycling | **sprite tiles** | migrate — cycle `background-position` every `HOVER_FRAME_INTERVAL_MS` over 100 tiles instead of 4 files |

The single frame keeps `thumbnail=50` and `scale=-2:720`. Curation matters *more*
when there's only one frame: it is the video's thumbnail everywhere and must not be
black. The sprite deliberately does **not** curate — a seek preview must show the
frame at the hovered timestamp, black or not.

### Accepted trade

Video-track detail heroes lose their multi-image crossfade and show a single static
background. The code already handles fewer frames (and `[]` falls back to the artist
image), so nothing breaks. If the crossfade turns out to matter, raise `FRAME_COUNT`
to 2–4 for the hero alone — the sprite consumers are unaffected either way.

### Ordering (load-bearing)

Reducing `FRAME_COUNT` before the sprite ships **breaks** the filmstrip and hover
cycling. Sequence:

1. Land tier 2 (sprite producer + cache).
2. Migrate `VideoFilmstrip` to render tiles from the sprite.
3. Migrate `VideoRowThumb` hover cycling to sprite tiles.
4. Only then set `FRAME_COUNT = 1`.

Steps 2–3 need no new extraction, so they can land behind the sprite in any order.

### Code details easy to miss

- `FRAME_POSITIONS` is `[f64; 4]` — becomes `[f64; 1]` (or a single const).
- `VideoFilmstrip.tsx:29` hardcodes `[0, 1, 2, 3].map` for its **loading skeleton**;
  it does not derive from frame count.
- `MAX_LAYERS = 4` in `useDetailHeroImages.ts` can stay — `slice` just returns fewer.
- The DB-id concern raised early in design is **already solved** and needs no work:
  `useShelfVideoFrames` keys candidates by path (`shelfVideoKey`) and resolves the
  library id via `find_track_id_by_path`. Storyboards should key by path directly and
  skip id resolution entirely.

## Testing

Rust (`cargo test --lib`):
- `geometry(durationSecs)`: the floor binding for short videos, the tile cap binding
  for long ones, their crossover at exactly 1000 s, and the invariants (≥ 1 tile,
  ≤ MAX_TILES, grid big enough, last tile inside the video) across 1 s–24 h.
- Cache key derivation and `gc()` orphan sweep (tempdir, no ffmpeg needed).
- Producer smoke test behind the existing self-skip pattern when ffmpeg is absent.

TypeScript (`npm test`):
- Tile locating (`t → {sheet, row, col}`): boundaries, before `startSecs`, past
  capacity, partial final sheet, single-sheet case.
- Storyboard descriptor validation (reject non-positive geometry, empty `sheets`).
- Filmstrip tile selection: choosing N evenly-spread tiles from a 100-tile sprite,
  and the hover-cycling index advance — both pure, so they're testable without the
  components (per `testing.md`).
- `videoFrameQueue.test.ts` already asserts on frame arrays; update its fixtures for
  a single-frame result and add a case proving queue art still resolves from
  `frames[0]` when only one frame exists.

Both helpers are pure and exported, per `testing.md`.

## Open questions

1. **Remote non-plugin video.** v1 gives Subsonic / manifest / P2P nothing. Acceptable,
   or is a Subsonic sprite worth server-side cost? Note transcoded Subsonic streams
   may not support reliable byte-range seeking at all, so even extraction is shaky.
2. **Cache ceiling.** Is 256 MB right? Should it be user-visible in Settings next to
   the other cache controls?
3. **Tile size.** `sb2`'s 80×45 is small; 160×90 (`sb1`) is crisper on retina but 3×
   the bytes and 5 requests. Pick per-level, or match the local tier's 160 px?
   Note sheet count also scales with duration, so `sb1` on a 3-hour video is 45
   sheets — level choice should probably depend on duration too.
4. **How many tiles should the filmstrip show?** It has 100 available where it used to
   have 4. More is not automatically better — the strip is a fixed-width row, and its
   CSS (`VideoFilmstrip.css`) currently lays out flex items at `width: 100%`. Needs a
   design pass, not just a number.
5. **Long-content granularity.** The tile cap makes the local tier ~111 s/tile at
   3 hours — coarser than the ~10 s YouTube serves, because we cap at one sheet. Allow
   multi-sheet for long local video, or accept overview-grade previews there?
6. **Windows/Linux.** Everything measured on macOS. The ffmpeg path should be
   portable; the local tier's 1600×900 sheet is well inside any plausible WebView2
   texture limit, but plugin tiers can supply larger sheets and should be sanity-checked.

## Out of scope / rejected

- **Hidden `<video>` + canvas** — +276 MB on WebKit, retains 85 MB, can't persist
  (tainted canvas), and limited to webview-decodable codecs (no MKV/AVI/WMV, no VP9
  on macOS). One measured caveat if this is ever revisited: only a single
  load/release cycle was measured, so whether the retained 85 MB accumulates across
  tracks or plateaus is unknown, and that's the number that would decide it.
- **A third mpv handle** — +283 MB never released, 2.8 s irreducible init. Would be
  the only way to preview formats the webview can't decode; revisit only if that
  turns out to matter.
- **Per-hover single-frame extraction** — 101 ms and 155 MB per frame, spawn-bound
  (`-noaccurate_seek` measured 107 ms, i.e. no help).
- **Raising `FRAME_COUNT` to 10** — costs more wall time and 3.5× the peak memory of
  a full sprite while delivering ~10× coarser granularity.

## Follow-up: the surviving frame pass is the memory hot spot

The existing frame extraction peaks at **290 MB per spawn** — the highest of anything
measured here — because `thumbnail=50` buffers 50 decoded 1080p frames (~155 MB of
YUV alone) and `scale` runs *after* the filter.

Reducing `FRAME_COUNT` to 1 cuts the number of spawns 4× but **not** the peak: it's
per-spawn, and today's four run sequentially. So after this change the single
remaining frame pass is still a 290 MB spike, and it is now the *only* frame pass —
which makes fixing it worth more, not less.

Two independent options, either of which should land alongside step 4:
- `thumbnail=10` instead of `50` — 5× less filter buffer. The frame is marginally less
  "representative"; with a 2 s window at 30 fps there are only ~60 candidates anyway.
- Move `scale=-2:720` **before** `thumbnail` in the filter chain, so the 50 buffered
  frames are 720p rather than full resolution. Preserves curation quality entirely
  and should be the bigger win. Verify `thumbnail`'s selection still behaves on
  downscaled input.

Not required for the feature to work, so it stays out of the critical path — but it's
cheap and the spike is large.
