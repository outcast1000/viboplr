# Main Playlist Folder — Design

## Problem

The live playlist (queue + playlist context) is currently stored as a set of keys in `app-state.json` via `tauri-plugin-store`: `queueEntries`, `queueIndex`, `queueMode`, `playlistContext`. This has two user-visible problems:

1. **Broken images when remote sources disappear.** If a Spotify playlist is loaded and later removed from Spotify, the cover and track thumbnails in the live queue point at URLs that now 404. Nothing in Viboplr owns a local copy.
2. **Mixtape export duplicates logic.** The mixtape format already defines a standard folder layout (`manifest.json`, `cover.jpg`, `thumbs/NN.jpg`, `tracks/NN-slug.ext`). The live playlist stores the same conceptual data in a different shape, so "export playlist as mixtape" has to translate instead of copy.

## Goal

Move the live playlist's state out of `app-state.json` and into a dedicated folder at `{profile_dir}/main-playlist/`. The folder's shape mirrors an uncompressed mixtape: a `manifest.json` that *is* a valid mixtape manifest, a local `cover.jpg`, and a `thumbs/` directory for remote-sourced playlists. A sibling `state.json` holds the live-only queue playback state (index, mode, shuffle order) that mixtapes don't care about. Exporting as a mixtape becomes "zip the folder plus audio if requested".

Images are downloaded or copied once at the moment a playlist context or track is added, so they remain valid even after the source disappears.

## Non-goals

- No plural/named live playlists. There is exactly one `main-playlist/` folder.
- No migration from the old `app-state.json` keys. Upgrading users' queues become empty once; this is acceptable because queues are transient.
- No plugin API to read/write the folder directly.
- No audio copying. Tracks are referenced by their `path`/URI in the manifest; resolution happens through the existing playback chain.

## Folder layout

```
{profile_dir}/main-playlist/
├── manifest.json   mixtape-compatible manifest (version 1, type: "custom")
├── state.json      live playback state (queueIndex, queueMode, shuffleOrder, shufflePosition)
├── cover.jpg       downloaded/copied from playlistContext on context change
└── thumbs/
    ├── {key}.jpg   per-track thumbnails, keyed by a stable queue-entry key (see below)
    └── …
```

### `manifest.json`

Identical schema to `MixtapeManifest` (`version: 1`, `type: "custom"`):

```jsonc
{
  "version": 1,
  "title": "<playlistContext.name or 'Main Playlist'>",
  "type": "custom",
  "metadata": { /* PlaylistContext.metadata merged in */ },
  "created_at": "<ISO>",
  "created_by": null,
  "cover": "cover.jpg",           // or omitted if no cover
  "tracks": [
    {
      "title": "...",
      "artist": "...",
      "album": "...",
      "duration_secs": 217.5,
      "file": "file:///…" | "subsonic://…" | "tidal://…" | "spotify://…" | "http(s)://…",
      "thumb": "thumbs/{key}.jpg" // or null
    }
  ]
}
```

`PlaylistContext.source` is stored in the manifest's `metadata` as a regular key so it round-trips through the mixtape shape. `PlaylistContext.remote` is the authoritative signal for whether thumbs get cached; callers set it explicitly. If `remote` is `undefined` on restore, it is inferred from `source` (non-library source → `true`). An explicit `remote` always wins over inference.

### `state.json`

Small and live-only. Never included in a mixtape export.

```jsonc
{
  "queueIndex": 3,
  "queueMode": "normal" | "loop" | "shuffle",
  "shuffleOrder": [0, 5, 2, 1, …],
  "shufflePosition": 2
}
```

### `thumbs/` keying

Thumbnails use a **stable per-track key**, not a positional filename. This means reordering the queue never rewrites thumbnail files — only `manifest.json` updates. The key is derived from the `QueueEntry.key` field (which is already stable: `lib:<id>` for library tracks, `ext:<n>` for externals). Filenames are sanitized via `canonical_slug` applied to the key.

### Cover policy

On any new `playlistContext`:
- Remote URL (`http(s)://`) → backend downloads into `cover.jpg`.
- Local path (`imagePath`) → backend copies into `cover.jpg`.
- No image → `cover.jpg` is removed; manifest's `cover` field is omitted.

Cover writes go through `resize_image_to_jpeg` with max dimension 800 (matching mixtape export).

### Thumb policy

Trigger rule: **when the playlist is sourced remotely, every track gets a local thumbnail copy**. A playlist is "remote-sourced" when `PlaylistContext.source` is set to anything other than a library source (album / artist / tag / local playlist).

- Local-library playlists (Play All on an album, artist, or tag): no thumbs written. The existing image resolution chain (`useImageCache`, `albumImages` / `artistImages` maps) still renders them, and the library already owns those images permanently.
- Remote-sourced playlists (Spotify playlists, Tidal browse results, plugin-contributed playlist views, etc.): every track's thumbnail is downloaded or copied into `thumbs/{key}.jpg`. Tracks whose art was resolved through the library cache are *still* copied in — the point is that the folder remains self-contained if the remote source later disappears.

Thumb writes use max dimension 150 (matching mixtape export).

## Backend (Rust)

New module `src-tauri/src/main_playlist.rs` exposing a small set of Tauri commands. It reuses `resize_image_to_jpeg` from `mixtape.rs` and the existing HTTP client used for image downloads.

### Commands

| Command | Purpose |
|---|---|
| `main_playlist_write(manifest, state)` | Atomic writer. Serializes each to `*.tmp` then renames. Both files are written every call; the frontend's debounce is the only rate limiter. |
| `main_playlist_read() -> { manifest: MixtapeManifest \| null, state: MainPlaylistState \| null }` | Reads both files. Each field is explicitly `null` (never omitted) if the corresponding file is missing or fails to parse. Parse errors are logged, not propagated. |
| `main_playlist_clear()` | Removes every file inside the folder (not the folder itself). |
| `main_playlist_set_cover(source)` where `source = { path?: string, url?: string } \| null` | Copies local path or downloads URL into `cover.jpg`. `null` removes the cover. |
| `main_playlist_set_thumb(key, source)` | Writes `thumbs/{sanitized_key}.jpg` from local path or remote URL. |
| `main_playlist_remove_thumb(key)` | Deletes a single thumb file. No error if already absent. |
| `main_playlist_gc()` | Deletes orphan thumb files not referenced by the current manifest. Called once on startup. |

### Atomicity

Each write uses the same tmp-then-rename pattern as `mixtape.rs` (`with_extension("tmp")` then `std::fs::rename`). A crash mid-write leaves the prior file intact. Cover and thumb writes are individually atomic; there is no cross-file transaction (none is needed — the manifest points at filenames, and a missing thumb file is simply rendered as a placeholder).

### Startup sweep

A separate `main_playlist_gc()` command, invoked once by the frontend after `main_playlist_read` resolves, deletes any file under `thumbs/` whose name doesn't match a `thumb` referenced in the manifest. Kept out of `read` so reads are pure. This is a safety net against orphan files from prior crashed writes.

### Mixtape export integration

A later refactor can reuse this folder directly when the user exports the live playlist as a mixtape: the manifest is already valid, the cover is already there, the thumbs are already there. The only added step is copying audio files for library tracks into `tracks/` and zipping. This is out of scope for the initial implementation — the existing `build_playlist_mixtape` path continues to work — but the shapes are designed to converge.

## Frontend (`useQueue.ts`)

### Type changes

`PlaylistContext` gains:

```ts
export interface PlaylistContext {
  name: string;
  imagePath?: string | null;
  coverUrl?: string | null;
  source?: string | null;      // existing
  metadata?: Record<string, string> | null;  // existing
  remote?: boolean;            // new — default false for library-sourced, true otherwise
}
```

Callers that play from library entities (album, artist, tag, local saved playlist) set `remote: false` or omit it. Plugin-driven playback via `requestAction("play-tracks", …)` defaults to `remote: true`.

### Write path

The four existing persistence effects (`queueEntries`, `queueIndex`, `queueMode`, `playlistContext` written to `tauri-plugin-store`) are replaced by a single debounced effect:

```ts
useEffect(() => {
  if (!restoredRef.current) return;
  const t = setTimeout(() => {
    invoke("main_playlist_write", {
      manifest: buildManifest(queue, playlistContext),
      state: buildState(queueIndex, queueMode, shuffleOrder, shufflePosition),
    }).catch(console.error);
  }, 500);
  return () => clearTimeout(t);
}, [queue, playlistContext, queueIndex, queueMode, shuffleOrder, shufflePosition]);
```

`buildManifest` and `buildState` are pure, testable helpers.

### Cover/thumb side-effects

Separate from the main debounced write:

- **Cover.** A `useEffect` watching `playlistContext` sends one `main_playlist_set_cover(source)` when the context changes. `null` context sends `null` source, which clears `cover.jpg`.
- **Thumbs.** A `useEffect` diffing the previous queue against the current queue:
  - For `playlistContext.remote === true` (or inferred remote): every newly-added track triggers `main_playlist_set_thumb(key, source)` where `source` resolves through the same image chain used in `QueuePanel.getTrackImage`. Local-library image paths are copied as files; remote `image_url`s are downloaded.
  - Removed tracks trigger `main_playlist_remove_thumb(key)`.
  - Local-sourced playlists (`remote === false`) skip this effect entirely.

These calls are not debounced. The backend must skip the write when the incoming source is identical to what produced the existing destination file — for local paths this is a path-equality check; for remote URLs the backend stores the source URL in a sidecar (`{key}.jpg.src`) so repeat calls with the same URL no-op without re-downloading.

### Startup restore

On mount:

```ts
const { manifest, state } = await invoke("main_playlist_read");
if (manifest) {
  setQueue(tracksFromManifest(manifest));
  setPlaylistContext(contextFromManifest(manifest));
}
if (state) {
  setQueueIndex(state.queueIndex);
  setQueueMode(state.queueMode);
  setShuffleOrder(state.shuffleOrder);
  setShufflePosition(state.shufflePosition);
}
restoredRef.current = true;
```

If `manifest` is `null` (fresh install or post-upgrade), the queue starts empty.

### UI impact — `QueuePanel`

No behavioral change. Two small adjustments:

- `playlistContext.imagePath` is rewritten during restore to point at `{profile_dir}/main-playlist/cover.jpg` when a cover file exists.
- `getTrackImage` gains a first-choice lookup into `{profile_dir}/main-playlist/thumbs/{key}.jpg` when that file exists, before falling back to the existing chain.

Both paths are resolved via `convertFileSrc` like every other local image.

### What goes away

- `queueEntries`, `queueIndex`, `queueMode`, `playlistContext` keys in `tauri-plugin-store`. The keys are simply no longer read or written; existing entries in user `app-state.json` files are left as dead data (harmless, small).
- `trackToQueueEntry` / `queueEntryToTrack` are no longer used for the main queue. They may remain in `queueEntry.ts` if other call sites depend on them (to be audited during implementation).

## Edge cases

- **Profile switch.** Folder is profile-scoped, so switching profiles reads a different `main-playlist/`. No cross-profile leakage.
- **Concurrent writes.** The debounced effect cancels the prior timer, so only the latest state writes. Cover/thumb writes are per-call, atomic, and independently keyed.
- **Corrupt files.** `main_playlist_read` logs and returns `null` for a malformed file; the other file is still honored. A corrupt manifest means the queue starts empty; a corrupt `state.json` means index/mode reset to defaults (0, "normal") but the queue survives.
- **Orphan thumbs.** Cleaned on startup by the sweep described above.
- **Reorder.** Because thumb filenames key on the stable queue-entry key, reorder only rewrites `manifest.json`. No thumb I/O.
- **Clear playlist.** One `main_playlist_clear` call; both files and the thumbs directory contents go away.
- **Disk errors.** Writes log via `console.error`. In-memory state remains authoritative for the session; only persistence across restart is lost.

## Testing

### Rust (`src-tauri/src/main_playlist.rs`)

`cargo test` coverage using `tempfile`:

- `write` + `read` roundtrip for manifest and state.
- `write` with invalid JSON target directory (permission failure) surfaces an error.
- `read` with a missing folder returns `{ manifest: null, state: null }`.
- `read` with a corrupt `manifest.json` returns `{ manifest: null, state: <parsed> }` and logs.
- `set_cover` with a local file copies and resizes.
- `set_cover` with a remote URL — mocked HTTP.
- `set_cover(null)` removes an existing cover.
- `set_thumb` + `remove_thumb` roundtrip.
- `main_playlist_gc` removes thumb files not referenced by the current manifest.
- `set_thumb` called twice with the same remote URL downloads only once (sidecar-URL check).
- `set_thumb` called twice with the same local source path copies only once.

### TypeScript

- `buildManifest(queue, context)` — pure function; test track shape, manifest metadata passthrough, cover field presence.
- `buildState(...)` — pure; trivial roundtrip.
- `diffThumbs(prevQueue, nextQueue)` — pure function returning `{ toAdd, toRemove }` by key; test add, remove, reorder (no-op), replace.
- `contextFromManifest(manifest)` — pure; test cover-path rewrite.

No UI tests needed beyond these. Existing E2E tests continue to pass with no-op mocks for the new commands.

## Risks and open points

- **`QueueEntry` usage audit.** Before removing conversion helpers, verify no other call sites depend on them (history reconstruction, plugin event payloads).
- **Plugin-signaled remoteness.** Plugins using `requestAction("play-tracks", …)` must be treated as remote-sourced so thumbs are cached. The `remote` default for plugin play actions lands in `App.tsx` where that action is handled.
- **Fresh-install empty queue on upgrade.** Acceptable per Q7 of the brainstorm.
- **Manifest schema drift.** The manifest is pinned to `version: 1` matching the mixtape format. If mixtape schema evolves, `main_playlist_read` must handle older versions gracefully.
