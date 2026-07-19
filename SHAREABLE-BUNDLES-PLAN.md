# Shareable Bundles — Implementation Plan (Option C)

## Overview

Unify the app's two track-sharing formats — **mixtapes** (`mixtape.rs`, a
self-contained `.mixtape` ZIP) and **published music sources**
(`music_publish.rs`, a hostable folder subscribed via `manifest_sync.rs`) — onto
**one versioned manifest schema** with **one reference model**: each track names
its audio via a `src` that is either a **relative path** (resolved against the
bundle's container base) or an **absolute URL**. A *reader* resolves either kind;
container (ZIP vs folder) and lifecycle (import vs subscribe) become strategies
layered on top of the single format.

This is "Option C" from the design discussion. The two formats already share a
concept — *a named set of tracks + art, bundled from the library, with a
`tracks/` dir of slugified copies and a `manifest.json` track list* — but the
build/read logic is written twice and the schemas have drifted. C collapses them.

We are still in **PoC mode**: no installed base to protect, no migration burden
(the DB already squashes its migration history into the `init_tables` baseline).
Adopting the unified design is cheapest now, before more code piles onto two
divergent formats.

## Implementation Status

**Landed (Option C behavior, end-to-end):**
- `bundle_ref.rs` — the shared reference-resolution module: scheme detection
  (`is_absolute_ref`), relative-vs-absolute resolution against the manifest URL
  (`resolve_subscribe_ref`), and the http(s)-only reader guardrail. Unit-tested.
- **Subscriber** (`manifest_sync.rs`) accepts `src` (aliases `url`/`file`),
  resolves relative refs against the fetched manifest URL, keys/stores the
  resolved absolute URL, and drops disallowed refs (`file://`, private schemes).
  `ingest_manifest` gained a `base_url` param; both callers thread it through.
- **Publisher** (`music_publish.rs`) emits **relative** `src` (`tracks/<file>`),
  so the manifest is portable and re-hosting needs no rebuild. Base URL is now
  only used for the shareable manifest URL / deep link / landing page.
- **Mixtapes** are already offline+relative: the frontend already uses the
  materializing `export_mixtape_full` path (remote tracks are fetched and
  embedded via the download-resolve registry), and in-archive `file` refs are
  already relative. No change needed to satisfy the "always offline" invariant.
- **Frontend**: the queue **Share** button now opens a native two-mode menu —
  *Publish hosted source…* / *Save as file (.mixtape)…* — the single Share
  surface. `PublishSourceModal` copy updated to reflect relative/portable refs.
- Docs updated (`backend.md` manifest + publishing paragraphs).

**Deliberately NOT done (see Non-Goals + Open Questions):**
- The cosmetic `BundleManifest`/`BundleTrack` struct merge (§2) and the shared
  ZIP+folder `build_bundle` (§5). The two manifest structs stay separate: merging
  them risks the delicate mixtape import/export roundtrip for zero behavioral
  gain. The load-bearing shared logic (reference resolution) *is* unified in
  `bundle_ref`. This remains a clean follow-up refactor.
- Hosted **remote pass-through** (writer emitting guarded public absolute URLs).
  The reader accepts absolute refs; the writer still bundles local-only.

## Goals

1. One versioned, typed manifest struct (`BundleManifest`) backs both containers.
2. One reference model: `src` is a relative path **or** an absolute URL; readers
   resolve both against a well-defined container base.
3. One shared builder (`bundle.rs`) — copy / slug / dedup / manifest logic lives
   once; `mixtape.rs` and `music_publish.rs` become thin callers.
4. **Mixtape creation always materializes to offline + relative**: every track's
   bytes are embedded and every `src` is relative — invariant, not a toggle.
   Un-fetchable tracks are skipped and reported.
5. Security guardrails baked into resolution: no credential leakage, no
   `file://` resolution on a subscriber, http/https only for remote fetch.
6. Keep the two delivery mechanisms intact — offline single-file ZIP and live
   hosted+subscribe — as containers over the one format.

## Non-Goals

- Merging the two **delivery contracts**. A `.mixtape` stays a single offline
  file; a hosted source stays loose files served over HTTP with a landing page
  and daily auto-update. C unifies the *format*, not the *runtime*.
- Stable cross-host track identity. With relative refs, a subscribed track's
  identity is its *resolved* URL, so re-hosting looks like new tracks
  (prune + re-add). A dedicated stable `id` field is out of scope (see Open
  Questions).
- Hosted **remote pass-through** as a required feature. Emitting absolute `src`
  for a remote library track (instead of skipping it) is optional and deferred —
  it carries the credential-leak risk (#5) and isn't needed to land C. The
  *reader* accepting absolute URLs (so a human can author one) **is** in scope.
- Any DB schema change. Subscribed tracks still store their resolved URL as
  `tracks.path`; mixtape import is unchanged at the DB layer.

## Current State (for orientation)

- **Mixtape** — `src-tauri/src/mixtape.rs` (`build_mixtape`,
  `build_playlist_mixtape`, `read_mixtape`, `extract_mixtape`) + `MixtapeManifest`
  / `MixtapeTrack` in `models.rs` (`version: 1`, `type`, `created_at`,
  `created_by`, `cover`; per-track `file` = in-archive path, `thumb`). ZIP,
  stored (uncompressed). Commands in `commands/mixtapes.rs`; frontend
  `MixtapeExportModal.tsx` / `MixtapePreviewModal.tsx`; queue entry
  `handleQueueExportAsMixtape` in `App.tsx`. Builder currently only accepts
  **local** audio paths (`MixtapeTrackSource.audio_path`).
- **Publish** — `src-tauri/src/music_publish.rs` (`export_music_source`,
  `render_index_html`, `render_publish_md`) + the `export_music_source` command
  in `commands/collections.rs`. Untyped `serde_json::json!` manifest
  `{ name, tracks[] }`; per-track `url` = **absolute** `{base}/tracks/{file}`,
  `format`, optional `track`/`tags`. Emits a plain folder (`index.html` +
  `manifest.json` + `tracks/` + `PUBLISH.md`). **Local files only** — remote
  tracks skipped + reported. Frontend `PublishSourceModal.tsx`; entry points:
  Collections → Publish, the "Publish as music source…" context action, and the
  queue **Share** button (`handlePublishQueue` in `App.tsx`).
- **Subscribe** — `src-tauri/src/manifest_sync.rs` (`fetch_manifest`,
  `ingest_manifest`, `sync_manifest`) + `Manifest` / `ManifestTrack`. Already a
  **forgiving superset** of the publisher: reads `name`, default `artist`,
  `image`, and per-track `title`, **required** `url`, `album`, `artist`,
  `duration_secs` (alias `duration`), `track_number` (alias `track`), `format`,
  `year`, `tags`, `cover` — all `#[serde(default)]`. Keys/prunes tracks by `url`,
  stores it verbatim as `tracks.path`. Reached via `add_collection { kind:
  "manifest", url }` and the `viboplr://add-collection?kind=manifest&url=…` deep
  link.

## Design

### 1. The unified concept: a "Shareable Bundle"

> A **Shareable Bundle** is a `manifest.json` (versioned, typed) plus a set of
> track files, where each track references its audio by a `src` resolved against
> the bundle's **container base**. It ships in one of two **containers** and is
> consumed by one of two **lifecycles**:

| | Container | Base for relative `src` | Lifecycle | `src` kinds |
|---|---|---|---|---|
| **Mixtape** | one `.mixtape` ZIP | archive root | import (extract → local collection) | **relative only** (always materialized) |
| **Source** | folder over HTTP | manifest URL's directory | subscribe (live `manifest` collection) | relative **or** absolute |

### 2. Unified manifest schema (`BundleManifest` / `BundleTrack`)

One typed, versioned struct in `models.rs`, replacing `MixtapeManifest` and the
publisher's ad-hoc `json!`. Field aliases keep old `.mixtape` (v1, `file`) and
existing hosted manifests (`url`) parseable — cheap insurance, not required in
PoC.

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleManifest {
    #[serde(default = "one")]           // absent (old hosted manifest) → treat as v1-shaped
    pub version: u32,                   // unified schema = 2
    pub name: String,                   // was mixtape `title` / source `name`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<BundleKind>,       // "mixtape" | "source"; advisory, container is authoritative
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_type: Option<MixtapeType>, // custom | album | best_of_artist (mixtapes)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,         // default artist for tracks lacking their own
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,          // source/collection avatar (ref)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,          // cover art (ref); "cover.jpg" in a ZIP
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,     // rfc3339
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    pub tracks: Vec<BundleTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleTrack {
    pub title: String,
    /// THE reference. Relative in-archive path (mixtape) or relative-to-manifest
    /// path / absolute URL (source). Unifies mixtape `file` + source `url`.
    #[serde(alias = "file", alias = "url")]
    pub src: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(default, alias = "duration", skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    #[serde(default, alias = "track", skip_serializing_if = "Option::is_none")]
    pub track_number: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,          // per-track thumbnail (ref)
}
```

Notes:
- `artist` becomes optional (was required on `MixtapeTrack`) — matches the
  subscriber's lenient shape and lets `image_url`-only external tracks round-trip.
- The reader tolerates unknown fields (serde default), so future additions don't
  break older apps.

### 3. Reference resolution (the core of C)

A pure, unit-tested module (`bundle_ref.rs` or in `bundle.rs`). Resolution has
three parts.

**a. Relative vs absolute.**
`src` is **absolute** iff it carries a URL scheme (`scheme:` / `scheme://`).
Otherwise it is a **relative** path resolved against the container base.

- `tracks/01-x.flac` → relative
- `https://cdn.example.com/x.mp3` → absolute
- Root-relative (`/tracks/x`) and protocol-relative (`//host/x`) are **rejected
  by the writer** (never emitted) and **treated as relative** by the reader only
  under the ZIP base (a leading `/` is stripped before the archive-root join);
  under the hosted base they'd RFC-3986-resolve against the host root, which we
  don't want to encourage — flag such refs in `ingest` diagnostics.

**b. Base, per container.**

- **ZIP (mixtape):** relative `src` → path under the archive root. Reject `..`
  and absolute-looking segments (no traversal out of the archive).
- **Folder (hosted source):** relative `src` → **RFC 3986 URL join** against the
  *fetched manifest URL* (e.g. `https://h/a/manifest.json` + `tracks/x.mp3` =
  `https://h/a/tracks/x.mp3`). Use a real URL join, never string concat, so query
  strings / missing trailing slashes behave.

**c. Identity key (subscriber).**
`ingest_manifest` keys upsert/prune by the **resolved absolute URL**, not the raw
`src`. Consequence to accept deliberately: a relative `src` makes identity
**base-dependent** — re-hosting the manifest at a new URL resolves to new URLs, so
the old tracks prune and new ones add. Correct (the bytes moved), but noted; a
stable `id` field is the future escape hatch (Open Questions).

### 4. Security guardrails

- **Reader / subscriber:** only `http`/`https` `src` values are fetched for
  bytes. **Never** resolve a relative `src` into a `file://` on the subscriber's
  disk, and **ignore/reject** `file://` (and other local schemes) that appear in a
  *subscribed* manifest — a malicious manifest naming `file:///etc/passwd` must
  not read local files.
- **Writer (hosted remote pass-through — deferred/optional):** only ever emit an
  absolute `src` for a genuinely public `http(s)` URL, and **strip or refuse** any
  URL carrying auth. This matters because a resolved Subsonic stream URL is
  `{server}/rest/stream.view?id=…&u=…&t=…&s=…` — publishing it hands your server
  credentials to every reader. If a remote track can't be made safe-absolute, it
  is skipped + reported (hosted sources don't materialize).
- **Mixtape materialization dissolves this risk entirely** (see §6): bytes are
  fetched at build time and embedded, so the auth'd URL is used transiently and
  never persisted into the manifest.

### 5. Shared builder (`bundle.rs`)

```rust
pub enum BundleContainer { Zip, Folder }
pub enum ReferenceMode { RelativeOnly, RelativeOrAbsolute }  // Zip → RelativeOnly
pub enum FilenameScheme { Positional, HumanReadable }        // "NN-title" vs "artist-title"

pub struct BundleOptions {
    pub container: BundleContainer,
    pub reference_mode: ReferenceMode,
    pub filename_scheme: FilenameScheme,
    pub include_art: bool,        // cover + per-track thumbs
    pub materialize_remote: bool, // Zip → true (mandatory); Folder → false
}

/// One resolved track handed to the builder. `source` says where the bytes are.
pub struct BundleInput {
    pub meta: BundleTrackMeta,       // title/artist/album/duration/track/format/year/tags
    pub thumb_path: Option<String>,
    pub source: TrackByteSource,     // Local(path) | Remote(uri) | PublicUrl(url)
}

pub fn build_bundle<F>(dest: &Path, opts: BundleOptions, name: &str,
                       inputs: &[BundleInput], resolve: R, on_progress: F)
    -> Result<BundleResult, String>;
```

The builder owns the logic that's currently duplicated: create `tracks/`,
slugify + dedup filenames, place/copy/fetch bytes, build `BundleTrack` entries,
write `manifest.json` (pretty). `mixtape.rs` and `music_publish.rs` become thin
callers that set `BundleOptions` and (for Folder) additionally write `index.html`
+ `PUBLISH.md`. Slug drift is unified behind `FilenameScheme` (mixtape keeps
`Positional` `NN-title` for stable order; source keeps `HumanReadable`
`artist-title` for readable URLs).

### 6. Mixtape writer — materialize to offline + relative (invariant)

Mixtape creation is **always** fully self-contained: `container: Zip`,
`reference_mode: RelativeOnly`, `materialize_remote: true`. There is **no user
toggle** — self-containment is the mixtape's defining property.

- **Local** tracks: copied into `tracks/` (as today).
- **Remote** tracks (`subsonic://`, `http(s)://`, plugin schemes): **fetched at
  build time** through the existing resolver chain — `get_track_path` for
  Subsonic (→ authed stream URL), a direct GET for `http(s)`, the stream-resolver
  chain for plugin schemes (e.g. YouTube via `yt-dlp`) — and their bytes written
  into `tracks/`. The `src` in the manifest is the resulting **relative** path.
- **Un-fetchable** tracks (live radio/ICY, DRM, unresolvable, plugin scheme with
  no downloadable bytes): **skipped and reported**, exactly like the publisher's
  local-only skip. "All files offline" means "all *includable* files."
- **Progress** distinguishes *downloading* (slow — `yt-dlp` especially) from
  *copying*; the resulting archive grows with embedded remote audio (inherent).
- The playlist-only mixtape (`build_playlist_mixtape`, no audio) remains as a
  distinct, explicit mode — it is *not* the same as a materialized mixtape.

### 7. Readers

- **Mixtape extractor** (`extract_mixtape` / `read_mixtape`): `src` is always
  relative → in-archive path (already the case). Accept the `BundleManifest`
  struct; bump the accepted version set to `{1, 2}` (v1 `file` still deserializes
  via the `src` alias).
- **Subscriber** (`manifest_sync`): resolve each `src` per §3 (absolute → as-is;
  relative → RFC-3986 against the manifest URL), key by the resolved URL, store it
  as `tracks.path`. `ManifestTrack` collapses into `BundleTrack`. `url`-required
  becomes `src`-required (alias-compatible).

### 8. Frontend — one Share surface

Collapse the two entry points into a single **Share** sheet with two modes:

- **Save as file (`.mixtape`)** → mixtape writer (always materialized offline).
- **Publish hosted source** → folder writer (`PublishSourceModal`'s current flow).

The queue **Share** button (`handlePublishQueue`, already wired) opens this sheet
instead of going straight to publish. The context menu's "Export as Tape" +
"Publish as music source…" collapse into one "Share…" that opens the same sheet
(keep both labels as deep links into the two modes if desired). No change to the
subscribe/add-source side beyond what §7 requires.

## Backward Compatibility (PoC)

- No DB migration. No installed base to protect.
- Field aliases (`src` ← `file`/`url`; `duration_secs` ← `duration`;
  `track_number` ← `track`) keep existing `.mixtape` files and any already-hosted
  manifests parseable under the new struct — near-free, so we keep it.
- Version bumps to `2`; readers accept `{1, 2}`. Absent `version` (old hosted
  manifest) defaults to v1-shaped and still parses.

## Steps

1. **`models.rs`** — add `BundleManifest` / `BundleTrack` (+ `BundleKind`), with
   aliases. Keep `MixtapeType`. Unit-test round-trip + alias deserialization.
2. **`bundle_ref`** — reference-resolution module (scheme detection, ZIP/host
   base join, identity key, guardrails). Pure, heavily unit-tested (edge cases in
   Testing below).
3. **`bundle.rs`** — shared builder (`build_bundle`, `BundleOptions`,
   `FilenameScheme`, slug/dedup/place-bytes/manifest). Unit-test both filename
   schemes + dedup.
4. **`music_publish.rs`** — reimplement over the builder (Folder container).
   Behavior-preserving; remote pass-through stays *out* (still skip remote) for
   now.
5. **`mixtape.rs`** — reimplement build over the builder (Zip container,
   `materialize_remote: true`); add the fetch-via-resolver step + skip-and-report;
   update `read`/`extract` to `BundleManifest`. Progress reflects download vs copy.
6. **`manifest_sync.rs`** — resolve relative/absolute `src`, key by resolved URL,
   apply reader guardrails. Fold `ManifestTrack` into `BundleTrack`.
7. **Frontend** — unified Share sheet; point the queue Share button + context
   menu at it.
8. **Docs** — update `.claude/rules/backend.md` (Collections/Publishing +
   mixtape) and `queue.md` where the Share button is described; update the public
   `docs/` only if the marketing copy references the formats.

Steps 1–4 are a behavior-preserving refactor (safe to land first). Step 5 is the
one that adds new behavior (materialization). Step 6 changes the subscribe
contract (relative support). Land in that order.

## Testing

Rust (`cargo test --lib`), extending the existing `mixtape.rs` tests:

- **Round-trip, both containers:** build → read/subscribe → identical track set.
- **Reference resolution:**
  - relative under ZIP base → in-archive path; `..` rejected (no traversal).
  - relative under host base → correct RFC-3986 join (with/without trailing
    slash, with query string on the manifest URL).
  - absolute `src` passes through unchanged.
  - `file://` in a subscribed manifest is ignored/rejected.
- **Identity:** re-hosting a relative-ref manifest prunes old + adds new;
  absolute-ref manifest is stable across re-host.
- **Mixtape materialization:** a mix of local + fetchable-remote embeds all;
  un-fetchable remote is skipped + reported; manifest is 100% relative.
- **Credential safety:** an authed Subsonic URL never appears in *any* emitted
  manifest (materialized in ZIP; skipped in Folder).
- **Alias/compat:** a v1 `.mixtape` (`file`, `version:1`) and a legacy hosted
  manifest (`url`, no `version`) both deserialize into `BundleManifest`.

## Open Questions

1. **Stable track identity** across re-hosting — add an explicit `id` on
   `BundleTrack` (keyed for prune instead of the resolved URL)? Deferred; note the
   base-dependent-identity consequence until then.
2. **Hosted remote pass-through** — do we ever want the Folder writer to emit
   guarded public absolute URLs (blend local + public streams in one source), or
   is "local-only, skip remote" the permanent hosted contract? Reader support is
   in regardless; the writer feature is the open call.
3. **Filename scheme** — keep per-container (`Positional` vs `HumanReadable`) or
   standardize on one? Per-container preserves both current outputs; standardizing
   is simpler but changes hosted URLs.
