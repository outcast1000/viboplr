# Spec: Soulseek plugin (via slskd)

## Summary

Search and download from the **Soulseek** network inside Viboplr.

Viboplr cannot speak Soulseek — it is a custom binary TCP protocol, and the plugin
sandbox offers only HTTP. So the plugin drives **[slskd](https://slskd.com/)**, a
headless Soulseek daemon the user runs, over its REST API using `api.network.fetch`.
The user never opens slskd's own web UI.

**External plugin, own repo** (`outcast1000/viboplr-slskd`), released and installed
from the gallery exactly like `viboplr-ytdlp`. **Zero host changes** in v1: no new
Rust crates, no bundled binary, no `dependencies.rs` REGISTRY entry. The app binary
does not grow.

The one non-obvious architectural point: **the plugin owns the transfer lifecycle,
not the host download queue.** A Soulseek transfer can sit in a stranger's upload
queue for hours; every host resolver path is bounded at 60 s. So the plugin enqueues
in slskd and renders its own progress, and only touches `api.downloads.enqueue`
*after* a file is complete — at which point resolution is an instant local copy.

## Decisions (settled during design)

| Decision | Choice | Why |
|---|---|---|
| Transport | slskd REST via `api.network.fetch` | Only HTTP escapes the sandbox; `plugin_fetch` is reqwest-side so no CORS |
| Dependency notification | **Plugin-owned**, not `binaryDependencies` | `check_dependencies` iterates `REGISTRY` only (`commands/media.rs:85-91`) — a plugin-declared name outside it is silently dropped. slskd is also not a host-exec'd binary; it's a service |
| Registry entry for slskd | **Rejected** for v1 | Needs a host release, and `ManagedSource` expects one binary + a checksums asset; slskd ships 10 zips and no checksums file |
| Manifest `streamResolvers` | **Not declared** | That registers a *metadata* resolver in the global fallback chain — every unplayable track in the app would trigger a Soulseek search at 60 s a piece |
| Playback of completed files | `slsk://` scheme via `onResolveStreamByUri` → `file://` | `resolveUrlDetailed` maps `file://` to `convertFileSrc` + native `{kind:"file"}` (`useStreamResolution.ts:158-163`), so it plays on both engines |
| Download provider role | **Import a finished file**, not fetch from Soulseek | `download_file` copies `file://` paths (`downloader.rs:408-425`); the transfer itself is far outside the 60 s resolver budget |
| `onResolveByMetadata` | **Not registered** | Would put unbounded Soulseek waits in the app's automatic download fallback chain |
| Remote/Docker slskd | **Degraded tier, not blocked** | slskd is server-first by design; blocking it excludes the users who already have it running |
| Tier detection | URL heuristic + explicit user toggle | Plugins cannot stat an arbitrary host path — `plugin_files_exists` is rooted in the plugin dir (`commands/plugin_files.rs:245`) |
| Real-time progress | **Polling**, not SignalR | `WebSocket` is absent from the plugin sandbox (`usePlugins.ts:1425-1446`). Bare identifiers do escape to real globals, but relying on that is off-contract |
| Local path discovery | Plugin-chosen `Destination` + **Files API listing**, never derivation | `Transfer` exposes no local path, and slskd's destination pattern is user-configurable with `source_username`/`source_path` tokens — underivable in general |
| `stability` | `"experimental"` for v1 | External daemon dependency, one untested deployment shape |

## Goals

1. Search Soulseek and download results from inside Viboplr, with visible progress.
2. **Clearly notify when slskd is missing, unreachable, misconfigured, or logged
   out** — four distinct states, each with a specific repair action. Never a blank
   view or a silent failure.
3. Completed downloads become playable without the user hand-managing folders
   (local tier), and remain usable with one-time setup (remote tier).
4. Zero host changes. Ship entirely as a gallery plugin.
5. Never insert unbounded Soulseek waits into any host chain.

## Non-Goals

- Streaming or previewing before a transfer completes. Soulseek sends whole files.
- Chat rooms, private messages, or user-to-user social features.
- Managing the user's *shares* (slskd's own UI does this well).
- Installing, updating, launching, or supervising slskd.
- Auto-download / "find this track on Soulseek" as a background fallback.

## Constraints discovered in the host

These are load-bearing; the design is shaped around them.

| Constraint | Evidence |
|---|---|
| `plugin_fetch` is text-only — no bytes, no response headers, no streaming. Returns `{status, body}` | `commands/plugins.rs:427-459` |
| It accepts `insecure: true` — needed for slskd's default self-signed HTTPS cert | `commands/plugins.rs:429-432` |
| Methods limited to GET/POST/PUT/DELETE/PATCH | `commands/plugins.rs:436-442` |
| `file://` resolves to a playable local source on both engines | `useStreamResolution.ts:158-163` |
| `download_file` URL-decodes and `fs::copy`s `file://` | `downloader.rs:418-425` |
| Resolver budget is a hard 60 s | `useStreamResolution.ts:314` |
| Host dependency badge is driven only by REGISTRY names | `App.tsx:556-575`, `commands/media.rs:85-91` |
| Plugin sandbox has no `WebSocket`/`fetch`/`Map`/`Set` on `window` | `usePlugins.ts:1425-1446` |
| Plugin file I/O is rooted in the plugin dir | `commands/plugin_files.rs:245` |

## Repo layout

Mirrors `viboplr-ytdlp` exactly:

```
viboplr-slskd/
├── manifest.json          # zipped at ROOT — install_plugin_from_zip does not strip a wrapper dir
├── index.js               # ES5-ish, executed via new Function("api", code)
├── package.json           # private; { "test": "node --test" }
├── test/
│   ├── harness/           # fake `api` object + slskd response fixtures
│   ├── search-parse.test.js
│   ├── tier-detect.test.js
│   ├── readiness.test.js
│   └── path-map.test.js
├── scripts/package.sh     # builds slskd.zip + update.json from manifest.json
├── scripts/bump.sh
├── .github/workflows/ci.yml       # node --check index.js && node --test
├── .github/workflows/release.yml  # publishes slskd.zip + update.json
├── CHANGELOG.md
├── RELEASING.md
└── README.md
```

## Manifest

```json
{
  "id": "slskd",
  "name": "Soulseek",
  "version": "0.1.0",
  "author": "Viboplr",
  "description": "Search and download from the Soulseek network via a slskd daemon.",
  "minAppVersion": "1.0.10",
  "stability": "experimental",
  "homepage": "https://github.com/outcast1000/viboplr-slskd",
  "updateUrl": "https://github.com/outcast1000/viboplr-slskd/releases/latest/download/update.json",
  "icon": "<24x24 path>",
  "apiUsage": [
    { "api": "network.fetch", "reason": "Talk to your slskd daemon's REST API" },
    { "api": "storage", "reason": "Store the slskd URL, API key and transfer history" },
    { "api": "downloads.enqueue", "reason": "Import completed Soulseek files into a collection" }
  ],
  "contributes": {
    "sidebarItems": [{ "id": "slskd-browse", "label": "Soulseek", "icon": "<path>" }],
    "downloadProviders": [{ "id": "slskd-import", "name": "Soulseek" }],
    "contextMenuItems": [
      { "id": "slskd-search", "label": "Search on Soulseek", "targets": ["track", "album", "artist"] }
    ],
    "settingsPanel": { "id": "slskd-settings", "label": "Soulseek", "order": 55 }
  }
}
```

No `binaryDependencies` — see Decisions. No `streamResolvers`; the `slsk://` scheme
handler is registered at runtime via `api.playback.onResolveStreamByUri`.

## slskd API contract (verified against 0.26.0)

Every endpoint below is `[Authorize(Policy = AuthPolicy.Any)]`, so the `X-API-Key`
header is sufficient — no JWT login flow needed.

| Purpose | Endpoint | Returns |
|---|---|---|
| Readiness | `GET /api/v0/application` | `Core/State.cs::State` — `.server.state`, `.server.username`, `.version.current`, `.shares` |
| Downloads dir | `GET /api/v0/options` | `Options.Redact()`; `.directories.downloads` is `[AbsolutePath]`-validated and carries no `[Secret]`, so it survives redaction |
| Search | `POST /api/v0/searches` → `GET /api/v0/searches/{id}?includeResponses=true` | `Search` — live `responseCount`/`fileCount`, `responses` only at completion |
| Enqueue | `POST /api/v0/transfers/downloads/batches` | `{ Username, Files:[{Filename, Size}], Options:{ Destination, ExternalId } }` |
| Transfers | `GET /api/v0/transfers/downloads` | `Transfer[]` — **no local path**; `filename` is the remote path |
| Locate the file | `GET /api/v0/files/downloads/directories/{base64(subdir)}?recursive=true` | `FilesystemFile[]` — `name`, `fullName`, `length` |

**Parsing traps, all load-bearing** (every one confirmed against a live 0.26.0):

1. **Enums serialize as strings, and the interesting ones are `[Flags]`.**
   `Program.cs:980` registers `JsonStringEnumConverter`, so combined flags arrive
   comma-separated: `"Connected, LoggedIn"`, `"Completed, Succeeded"`. Always
   flag-test, never equality-compare. A signed-out daemon reports `"None"`.
2. **`length` means two different things.** In the **search** API (`File.length`)
   it is **duration in seconds**; in the **Files** API (`FilesystemFile.length`)
   it is **bytes**. Matching a completed transfer compares *bytes*; ranking a
   search result compares *seconds*.
3. **The recursive Files listing is FLAT.** `?recursive=true` returns every file
   at the root node with a full relative `fullName`, and lists nested directories
   as flat siblings that carry no files of their own. A walker must not assume
   files live inside their directory node.
4. **`fullName` is relative, not absolute.** `FileService.cs:341` strips the root.
   The absolute path is `options.directories.downloads + "/" + file.fullName` —
   the only reason the plugin needs `GET /api/v0/options` at all.
5. **Failures return a bare JSON string**, not a problem-details object — e.g.
   `"The server connection must be connected and logged in to perform a search
   (currently: Disconnected)"`. Surface it; it is far better than the status code.
   Searching while signed out is **409**, enqueueing is **500**.

**Correction to an earlier draft of this spec:** it claimed `GET /api/v0/application`
returns only the raw flags because it serializes the `Core/State.cs` record rather
than the DTO. That is **wrong** — the record carries expression-bodied computed
properties, so the payload does include `isConnected` / `isLoggedIn` /
`isConnecting` / `isLoggingIn` / `isTransitioning`. Prefer those booleans and keep
flag parsing as a fallback.

## Dependency notification

The host cannot help here, so this is the plugin's most important UI surface. It is
a **four-state readiness machine**, evaluated on activate, on settings save, on
manual "Test connection", and on a 60 s `api.scheduler` tick while the view is open.

A **single** `GET /api/v0/application` distinguishes all four states. All four
non-`ready` states are verified against a live slskd 0.26.0; `ready` needs a
Soulseek account.

| State | Detected by | Badge | View renders |
|---|---|---|---|
| `unconfigured` | No URL/API key in `api.storage` | `{type:"dot", variant:"muted"}` | First-run setup: what slskd is, per-OS install steps, a button to `api.network.openUrl("https://slskd.com/")`, then URL + API key fields |
| `unreachable` | `api.network.fetch` rejects | `{type:"dot", variant:"error", tooltip:"slskd isn't reachable"}` | "slskd isn't running or the address is wrong" + the configured URL + Retry + a link to the install steps |
| `unauthorized` | HTTP 401/403 | `{type:"dot", variant:"error", tooltip:"slskd rejected the API key"}` | "Your API key was rejected" + where to find it (slskd Settings → Options → Web) |
| `disconnected` | HTTP 200, but `server.state` lacks the `LoggedIn` flag | `{type:"dot", variant:"warning", tooltip:"slskd isn't logged in to Soulseek"}` | "slskd is running but not signed in to Soulseek" + link to open slskd's own UI. If `server.state` contains `Connecting`/`LoggingIn`, say "connecting…" and re-poll instead of alarming |
| `ready` | HTTP 200 and `server.state` contains `LoggedIn` | `null` | The search UI |

Rules:

- `api.ui.showNotification` fires **only on a state transition into a bad state**,
  once per state per session. Polling must never spam notifications.
- The badge is set via `api.ui.setBadge("slskd-browse", …)`. Host dependency dots
  win over plugin badges on conflict (`App.tsx:577-580`), but slskd is not a
  registry dep so there is no conflict.
- Every bad state renders a **repair action**, never just an error string.
- The settings panel shows the same state plus URL / API key / "slskd runs on this
  computer" / **Test connection**.

## Tiers: local vs remote

The split is one boolean and it only affects what happens *after* a transfer
completes. Search, enqueue, and progress are identical in both.

**Local** (slskd on the same machine as Viboplr):
- `slsk://<transferId>` resolves to `file://<absolute path>` → plays instantly.
- "Add to library" enqueues through the host downloader, which copies the file into
  the chosen collection with tag writing and cover embedding.

**Remote** (Docker / NAS / another host):
- Both of the above are unavailable — the host process cannot read the path.
- The plugin says so plainly in the transfers list and in settings, and tells the
  user to add slskd's downloads directory (or its mount) as a local collection.
- Search, enqueue, and progress remain fully functional.

**Detection:** default from the configured URL host — `localhost`, `127.0.0.1`,
`::1` → local, anything else → remote. A **"slskd runs on this computer"** toggle in
settings overrides it, because the heuristic is wrong for a bare LAN IP pointing at
the same box, and for a container with a matching bind mount.

**Self-correction:** the first time a `slsk://` resolve or an import fails with a
copy/not-found error, flip to remote, persist it, and surface the explanation once.
This catches every case the heuristic and the toggle both get wrong.

## Flows

### Search

1. `search-input` node (with `pasteButton`) submits a query.
2. `POST /api/v0/searches` → returns a search id.
3. Poll `GET /api/v0/searches/{id}?includeResponses=true` every ~1 s until
   `state` contains `Completed`, or a 30 s cap elapses.
   **Counts stream live; response bodies do not.** `responseCount`, `fileCount`,
   and `lockedFileCount` are updated on every incoming response and persisted
   during the search (`SearchService.cs:296-300`), but responses accumulate in a
   local list and are only assigned to the record at completion
   (`SearchService.cs:311`, `:361`). So the view shows a live
   **"412 files from 23 users…"** counter while waiting, then renders the list in
   one pass — not a content-free spinner.
4. Render into two tabs:
   - **Files** — `track-row-list`, one row per file: title = filename,
     subtitle = `user · bitrate · size · queue/slot status`.
   - **Folders** — `card-grid`, grouped by the file's parent directory, because
     Soulseek users mostly share whole albums. Each card downloads the whole folder.
5. Rank results — see below.

The `slskd-search` context-menu action prefills the query from the target's
metadata and calls `api.ui.navigateToView("slskd-browse")`.

### Ranking results

A search returns `Response[]`; **availability lives on the response and quality
lives on the file**, so the unit of ranking is a flattened `(response, file)`
candidate pair.

Field names, verified (`Search/Types/Response.cs`, `Search/Types/File.cs`):

| Response | | File | |
|---|---|---|---|
| `username` | string | `filename` | full remote path, backslash-separated |
| `hasFreeUploadSlot` | bool | `extension` | may be empty |
| `queueLength` | long | `size` | **bytes** |
| `uploadSpeed` | int (bytes/s) | `length` | **duration in seconds** |
| `fileCount` / `files[]` | downloadable | `bitRate` | nullable |
| `lockedFileCount` / `lockedFiles[]` | not downloadable | `bitDepth`, `sampleRate` | nullable |
| | | `isVariableBitRate` | nullable |

**Four traps:**

1. **`length` is duration, `size` is bytes.** Trivial to swap; the names invite it.
2. **`isLocked` is unreliable.** `File.FromSoulseekFile` never assigns it, so it
   deserializes `false` for locked files too. Use **collection membership** —
   anything from `lockedFiles` is not downloadable — never the flag.
3. **Every quality field is nullable.** Many Soulseek clients report no attributes
   at all. A ranking that treats missing bitrate as worst systematically hides good
   results, so `unknown` is slotted *below `high`, above `medium`* rather than last.
4. **`extension` can be empty.** Fall back to parsing the suffix off `filename`.

**Comparator** — bucketed and lexicographic, not a weighted float score, so it is
deterministic and each tier is independently testable:

```
rankResults(responses, prefs) -> Candidate[]

reject:  file ∈ lockedFiles
         size == 0
         extension ∉ audio set
         prefs.knownDurationSecs set && length && |length - known| > 5
dedupe:  on (username, filename)

sort by, in order:
  1. qualityTier      lossless(0) > high(1) > unknown(2) > medium(3) > low(4),
                      re-indexed against prefs.preferredFormats
  2. availabilityTier hasFreeUploadSlot ? 0 : queueLength <= 10 ? 1 : 2
  3. uploadSpeed      descending
  4. queueLength      ascending
  5. username, filename   ascending — pure tie-break, keeps tests stable
```

`qualityTier` derives from `extension` first (flac/wav/aiff/ape/wv ⇒ lossless,
corroborated by a non-null `bitDepth`), then `bitRate`: `>= 256` high, `>= 128`
medium, else low. `isVariableBitRate` promotes a VBR file one tier when
`bitRate >= 192`.

**Quality outranks availability deliberately.** If someone asks for FLAC, an
instantly-available 128 kbps MP3 is the wrong answer. Because tiers are coarse,
a 320 and a 256 land in the same bucket and availability breaks the tie — which is
the behaviour you actually want.

`prefs.knownDurationSecs` is set only when re-searching a known track (the
**Try another source** flow and the `slskd-search` context action). It catches
mislabeled files and wrong-track matches; it is unset for free-text search, where
there is no expected duration.

### Download

1. `POST /api/v0/transfers/downloads/batches` with:
   ```json
   { "Username": "...", "Files": [{ "Filename": "...", "Size": 123 }],
     "Options": { "Destination": "viboplr/<batchId>", "ExternalId": "<batchId>" } }
   ```
   **Always set `Destination`.** It is validated `[RelativePath]` +
   `[NonTraversingPath]` and makes the plugin own its own directory layout, instead
   of trying to reproduce slskd's user-configurable
   `Transfers.Download.Destination.Subdirectory` pattern.
2. Poll `GET /api/v0/transfers/downloads` every 3 s while the view is open, 30 s
   otherwise, and render a `progress-bar` per active transfer in a **Transfers** tab.
   Progress = `bytesTransferred / size`; queue position = `placeInQueue`.
3. Transfer states surface plainly: queued (with position), in progress, completed,
   failed, cancelled. `state` is a flags **string** — a finished file reads
   `"Completed, Succeeded"`, a failure `"Completed, Errored"`. Failures are the norm
   on Soulseek (users go offline), so a failed row offers **Retry** and
   **Try another source** (re-runs the search, picks the next-best result for the
   same filename). `exception`, `attempts`, and `nextAttemptAt` drive the detail text.
4. On `Succeeded`, resolve the real file (see below), then offer **Play** and
   **Add to library** (local tier only).

### Locating the finished file

`Transfer` carries no local path — only the remote `filename`. Resolution is two
reads, not a derivation:

1. `GET /api/v0/files/downloads/directories/{base64("viboplr/<batchId>")}?recursive=true`
   → `FilesystemFile[]`, each with `name`, `fullName`, `length`.
2. Absolute path = `options.directories.downloads` + `/` + `file.fullName`
   (`fullName` is relativized to the downloads root — `FileService.cs:341`).

Match by `length` against the transfer's `size`, falling back to basename. This
sidesteps the conflict strategies (`DestinationConflictStrategy` /
`DestinationExistsStrategy`) that can rename a file on collision: listing reports
whatever name actually landed on disk.

### Playback

`api.playback.onResolveStreamByUri("slsk", handler)`. The handler maps a transfer id
to its absolute local path and returns `"file://" + encodeURI(path)`. If the tier is
remote, or the transfer isn't complete, it returns `null` and the host surfaces its
normal "no playable source" path.

Play uses `api.playback.playTrack` with a `PluginTrack` carrying `path: "slsk://<id>"`
plus parsed title/artist so the now-playing bar and lyrics lookups work.

### Import into the library

`api.downloads.enqueue({ title, artistName, albumTitle, uri: "slsk://<id>", destCollectionId })`.
The host's `download-resolve-request` bridge calls the plugin's
`onResolveByUri("slskd-import", …)`, which returns `{ url: "file://…", ext }` —
an instant `fs::copy`, comfortably inside budget, and the user gets tag writing,
cover embedding, and progress for free.

## State

Persisted via `api.storage`:

| Key | Contents |
|---|---|
| `url` | e.g. `http://localhost:5030` |
| `apiKey` | slskd API key |
| `tierOverride` | `"local" \| "remote" \| null` (null = use heuristic) |
| `recentSearches` | Last 20 queries |
| `transfers` | Local mirror of transfer id → `{ batchId, destination, resolvedPath, parsed metadata }`, so rows and resolved paths survive a reload |
| `downloadsDir` | Cached `options.directories.downloads`, refreshed on each readiness probe |

**Security note:** `plugin_storage` is a plaintext SQLite table. The API key is
stored the same way other plugins store tokens. Say so in the README; do not imply
it is encrypted.

## Degradation chain (never a broken state)

1. slskd unreachable → setup/repair screen, error dot. Search UI hidden entirely.
2. Reachable, not logged in → warning dot, search disabled with the reason inline.
3. Search returns nothing → empty state suggesting broader terms, not an error.
4. All results from users with no free slot → results shown, queue positions
   labelled, with a "these will queue" note.
5. Transfer fails → retry + try-another-source on the row.
6. Remote tier → transfers complete and are listed; Play/Add-to-library are replaced
   by a one-line explanation and a pointer to add the downloads dir as a collection.

## Testing

`node --test` in the plugin repo, matching ytdlp's harness pattern (a fake `api`
object plus recorded slskd JSON fixtures). Pure functions to extract and test:

- `rankResults(responses, prefs)` — each tier independently: locked-file rejection
  via collection membership (not the flag), the `unknown`-bitrate slot, quality
  beating availability across tiers, availability breaking ties within one,
  duration rejection, `(username, filename)` dedupe, and stable ordering on a
  fully-tied input.
- `qualityTier(file)` — extension-first, bitrate fallback, VBR promotion, empty
  `extension`, and all-nulls.
- `groupByFolder(files)` — folder grouping and album detection, on
  backslash-separated remote paths.
- `parseTrackMeta(filename)` — artist/title/track-number from Soulseek paths.
- `detectTier(url, override)` — the heuristic and its override.
- `nextReadiness(probeResult, prev)` — the four-state machine, including
  "notify only on transition into a bad state", and the `Connecting`/`LoggingIn`
  transitional case.
- `hasFlag(stateString, flag)` — comma-separated flags parsing, covering
  `"Connected, LoggedIn"` and `"Completed, Succeeded"` vs `"Completed, Errored"`.
- `matchFile(transfer, listing)` — size-then-basename matching against the
  directory listing, including the renamed-on-conflict case.
- `absolutePath(downloadsDir, fullName)` — joining the relativized `fullName`, and
  `file://` encoding.

CI: `node --check index.js` + `node --test` on Node 24, per ytdlp's `ci.yml`.

Manual matrix before release: local slskd on macOS; slskd in Docker; slskd stopped
mid-transfer; wrong API key; correct key but Soulseek signed out.

**Verified against a live slskd 0.26.0 (macOS arm64), no Soulseek account:**
API-key auth (401 for absent *and* wrong key, 200 for correct); the `/application`
readiness payload incl. `shares.directories`; `/options` → an unredacted absolute
`directories.downloads`; the flat recursive Files listing; the full
locate chain (`flattenListing` → `matchFile` by bytes → `absolutePath`) resolving
to a path that **exists on disk**; `unreachable` via ECONNREFUSED; and the
signed-out error bodies for search (409) and enqueue (500). The enqueue payload
shape was accepted through model validation, reaching the connection check rather
than a 400 — so `destination` / `externalId` / `files[{filename,size}]` are right.

**Still unverified** (needs a Soulseek account): live search responses and
therefore `rankResults` against real data, a real transfer's state progression,
and the completed-download → play/import round trip.

## Release & gallery registration

1. `scripts/package.sh` → `slskd.zip` (manifest at zip root) + `update.json`.
2. `gh release create v0.1.0 slskd.zip update.json --repo outcast1000/viboplr-slskd`.
3. Add to `outcast1000/viboplr-plugins` `index.json`:
   ```json
   {
     "id": "slskd",
     "name": "Soulseek",
     "author": "Viboplr",
     "description": "Search and download from the Soulseek network via a slskd daemon.",
     "stability": "experimental",
     "updateUrl": "https://github.com/outcast1000/viboplr-slskd/releases/latest/download/update.json"
   }
   ```
   Omit `version`/`minAppVersion` — the reconcile bot backfills them.
4. Not in onboarding recommendations (`experimental` excludes it automatically).

## Resolved during design (was: open questions)

All five were settled by reading slskd 0.26.0 source. Kept here because each
changed the design.

1. **Readiness endpoint** — `GET /api/v0/application`, one call for all four
   states. Two traps: it returns the `Core/State.cs` record, *not* the DTO with
   `IsLoggedIn`; and `server.state` is a comma-separated flags string. See
   "slskd API contract".
2. **Downloads directory** — `GET /api/v0/options` → `directories.downloads`.
   No `[Secret]` attribute so redaction leaves it, and `[AbsolutePath]` validation
   guarantees it is absolute. Load-bearing, because of Q3.
3. **Completed-transfer path** — the original premise was wrong: `Transfer` has no
   local path at all, and slskd's destination pattern is user-configurable, so
   deriving it is not possible in general. Replaced with plugin-chosen
   `Options.Destination` at enqueue plus a Files API listing to read back the real
   name. `fullName` is relative to the downloads root, hence Q2.
4. **Search streaming** — counts stream live, response bodies don't. The wait now
   shows a real "N files from M users" counter instead of a bare spinner.
5. **Shares etiquette** — **yes, warn, once, non-blocking.** `state.shares` is in
   the same readiness payload, so it is free to check. A user sharing nothing gets
   deprioritized in every queue, and the resulting slowness reads as "this plugin is
   broken" rather than "Soulseek is reciprocal." Surface it as one informational
   line in settings plus a single first-search notification framed as *why
   downloads are slow* — not a badge, not a gate, and not a lecture.

## Open questions

1. **Retry semantics.** slskd already retries internally (`attempts`,
   `nextAttemptAt`, `RetryPartialStrategy`). The plugin's "Retry" button should
   defer to that rather than double-retrying; needs a read of the retry config.
2. **Whether to set `SearchId` on the batch.** The enqueue request accepts it and
   slskd uses it for destination tokens. Harmless, possibly useful for slskd-side
   bookkeeping — worth passing if it costs nothing.

## Out of scope / rejected

- **Native Rust Soulseek engine** in `src-tauri/src/` alongside `p2p/`. Full control
  and could progressive-download into playback, but it means implementing the
  protocol, login, and share-serving, plus ongoing maintenance against a network
  that changes without notice. Revisit only if slskd proves an unacceptable barrier.
- **`sldl`/slsk-batchdl via `api.system.exec`.** Needs a REGISTRY entry (host
  release) and still cannot stream. No advantage over slskd.
- **Adding slskd to `dependencies.rs`.** Blocked on packaging shape (zips, no
  checksums asset) and would not fit `ManagedSource` without installer work.
- **SignalR real-time events.** Reachable only by escaping the documented sandbox.
  If real-time proves necessary, add `WebSocket` to `pluginSandbox` deliberately in
  a host release rather than relying on scope-chain leakage.
- **A host `api.system.pathExists(path)`.** Would replace the tier heuristic with
  real detection. Worth doing eventually; not required for v1.
