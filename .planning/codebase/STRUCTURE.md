# Codebase Structure

**Analysis Date:** 2026-08-14

## Directory Layout

```
viboplr/                                  # Project root
├── src/                                  # Frontend React/TypeScript
│   ├── App.tsx                           # Root component
│   ├── App.css                           # All styles (global + component-scoped)
│   ├── base.css                          # Global typography, motion tokens
│   ├── design-system.css                 # Design tokens, custom properties
│   ├── main.tsx                          # React entry point
│   ├── components/                       # React UI components
│   │   ├── Sidebar.tsx                   # Navigation sidebar
│   │   ├── NowPlayingBar.tsx             # Playback footer
│   │   ├── QueuePanel.tsx                # Right-side queue
│   │   ├── SearchView.tsx                # Unified library view
│   │   ├── HomeView.tsx                  # Landing surface + shelves
│   │   ├── TrackDetailView.tsx           # Track hero + sections
│   │   ├── ArtistDetail.tsx              # Artist detail page
│   │   ├── AlbumDetail.tsx               # Album detail page
│   │   ├── TagDetail.tsx                 # Tag detail page
│   │   ├── SettingsPanel.tsx             # Settings UI
│   │   ├── ExtensionsView.tsx            # Plugin management
│   │   ├── TrackList.tsx                 # Track table/grid
│   │   ├── DownloadModal.tsx             # Download flow
│   │   ├── BulkEditModal.tsx             # Multi-track tag editor
│   │   ├── EditTrackMetadataModal.tsx    # Per-entry metadata editor
│   │   ├── PlaybackErrorModal.tsx        # Playback failure UI
│   │   ├── ReportProblemModal.tsx        # Diagnostic bundle UI
│   │   ├── OnboardingWizard.tsx          # First-run setup
│   │   ├── modals/                       # Modal components
│   │   │   └── ConfirmModals.tsx         # Delete, error, confirm dialogs
│   │   ├── ContextMenu.tsx               # Right-click menu
│   │   ├── WaveformSeekBar.tsx           # Waveform-based seek bar
│   │   ├── SegmentedSeekBar.tsx          # Fallback seek bar (no waveform)
│   │   ├── NowPlayingView.tsx            # Lean-back current-track view
│   │   ├── AudioFullscreen.tsx           # Fullscreen audio visualizer
│   │   ├── VisualizerSlot.tsx            # Plugin visualizer host
│   │   ├── LyricsPanel.tsx               # Synced/plain lyrics display
│   │   ├── DetailHero.tsx                # Shared detail-page header
│   │   └── [140+ other components]       # Entity cards, menus, etc.
│   ├── hooks/                            # Custom React hooks
│   │   ├── usePlayback.ts                # Dual audio element + mpv session
│   │   ├── useQueue.ts                   # Queue state, play/enqueue
│   │   ├── useLibrary.ts                 # Library queries, sort/filter
│   │   ├── usePlugins.ts                 # Plugin discovery, loading
│   │   ├── useStreamResolution.ts        # Plugin stream resolvers
│   │   ├── useDownloadOrchestration.ts   # Download flow control
│   │   ├── usePlayActions.ts             # Play/enqueue/backfill helpers
│   │   ├── useLikeActions.ts             # Like/unlike handlers
│   │   ├── useContextMenuActions.ts      # Context menu dispatch
│   │   ├── useImageCache.ts              # Entity image caching
│   │   ├── useImageResolver.ts           # Plugin image provider bridge
│   │   ├── useNowPlayingInfo.ts          # Cycling now-playing line items
│   │   ├── useLyrics.ts                  # Lyric fetching + caching
│   │   ├── useInformationTypes.ts        # Plugin info sections (detail pages)
│   │   ├── useHome.ts                    # Home view shelves
│   │   ├── useSkins.ts                   # Skin load/apply/gallery
│   │   ├── useGlobalShortcuts.ts         # OS media keys
│   │   ├── useInAppKeyboardShortcuts.ts  # Window-level key handlers
│   │   ├── useToasts.ts                  # Toast notification state
│   │   ├── useAppUpdater.ts              # App update checking/install
│   │   ├── useEngineComponent.ts         # mpv component install state
│   │   ├── useDependencies.ts            # External binary state (ffmpeg, yt-dlp)
│   │   ├── useMiniMode.ts                # Mini player state
│   │   ├── usePersistedSetting.ts        # Abstraction for store-backed state
│   │   ├── useNavigationHistory.ts       # Back navigation + scroll restoration
│   │   ├── [20+ other hooks]             # Specialized state/logic hooks
│   ├── playback/                         # Playback engine & stream resolution
│   │   ├── nativeEngine.ts               # mpv bridge (invoke + listen)
│   │   ├── bufferState.ts                # PlaybackBuffer model + helpers
│   │   ├── progressMachine.ts            # Gapless/prefetch/crossfade decision logic
│   │   └── playbackErrors.ts             # Error classification
│   ├── contextMenu/                      # Context menu builders
│   │   ├── buildContextMenuSpecs.ts      # Pure builder (target → MenuItemSpec[])
│   │   ├── pluginMenuGroups.ts           # Plugin context menu groups
│   │   └── buildQueueHeaderMenuSpecs.ts  # Queue header menu builder
│   ├── types/                            # TypeScript type definitions
│   │   ├── types.ts                      # Track, QueueTrack, Artist, Album, etc.
│   │   ├── skin.ts                       # SkinJson, SkinColors
│   │   ├── plugin.ts                     # PluginManifest, ViboplrPluginAPI
│   │   ├── informationTypes.ts           # InfoEntity, DisplayKind
│   │   └── contextMenu.ts                # ContextMenuTarget, MenuItemSpec
│   ├── utils/                            # Utility functions
│   │   ├── likeReconcile.ts              # Like state merging on restore
│   │   ├── downloadPlan.ts               # Provider decision logic
│   │   ├── tagSuggestions.ts             # Tag pool building
│   │   ├── nowPlayingArt.ts              # Current-track art resolution
│   │   ├── deleteTracks.ts               # Delete confirmation logic
│   │   ├── errorKind.ts                  # Error bucketing for telemetry
│   │   ├── diagnosticReport.ts           # "Report a problem" bundle builder
│   │   ├── errorLog.ts                   # In-memory error ring buffer
│   │   ├── visualizerSlots.ts            # Visualizer picker + slot resolver
│   │   ├── zoom.ts                       # UI zoom helpers
│   │   ├── recentlyVisited.ts            # Recently visited entities
│   │   ├── recentPlays.ts                # Recent play session tracking
│   │   ├── lyrics.ts                     # LRC parsing, sync helpers
│   │   ├── resolveImageUrl.ts            # Image path → src with cache-bust
│   │   ├── resolveImagePath.ts           # Local path → asset:// URL
│   │   ├── videoOverlay.ts               # Video theater mode overlay
│   │   ├── rowDrag.ts                    # Drag-to-reorder utilities
│   │   └── [30+ other utilities]         # String, format, query helpers
│   ├── utils/ (continued)
│   │   ├── tauriEvents.ts                # Event listener helpers
│   │   ├── reducedMotion.ts              # prefers-reduced-motion gate
│   │   └── [Collections+, Colors, EQ, etc.]
│   ├── constants/                        # Exported constants
│   │   └── LINKS.ts                      # URLs to docs, issues, gallery
│   ├── contexts/                         # React Context providers
│   │   └── DetailViewContext.tsx         # Detail page state machine
│   ├── skins/                            # Built-in skin JSON files (8 skins)
│   │   ├── dark.json                     # Dark theme
│   │   ├── light.json                    # Light theme
│   │   └── [6 other skins]
│   ├── startup/                          # App initialization helpers
│   │   └── readPersistedSettings.ts      # Restore from store.json
│   ├── store.ts                          # Tauri store abstraction
│   ├── telemetry.ts                      # Analytics event tracking
│   ├── trackEvents.ts                    # Plugin event dispatch (track:played, etc.)
│   └── __tests__/                        # Vitest unit tests
│       └── [100+ test files]
│
├── src-tauri/                            # Rust backend
│   ├── src/
│   │   ├── lib.rs                        # App setup, command routing, invoke_handler! macro
│   │   ├── main.rs                       # Binary entry point
│   │   ├── commands/                     # Tauri command handlers (70+ handlers)
│   │   │   ├── mod.rs                    # AppState, re-exports all submodules
│   │   │   ├── app.rs                    # App info, paths, diagnostics
│   │   │   ├── library.rs                # Track/artist/album/tag queries
│   │   │   ├── collections.rs            # Collection management (add, resync, sync)
│   │   │   ├── downloads.rs              # Download queue + format/path/conflict checks
│   │   │   ├── media.rs                  # Stream resolution (yt-dlp, ffmpeg, transcode)
│   │   │   ├── images.rs                 # Entity image operations
│   │   │   ├── history.rs                # Play history + stats
│   │   │   ├── playlists.rs              # Playlist CRUD
│   │   │   ├── plugins.rs                # Plugin install/enable/update
│   │   │   ├── extensions.rs             # Extension (plugin) queries
│   │   │   ├── updates.rs                # App self-update + channel logic
│   │   │   ├── skins_cmd.rs              # Skin gallery + install
│   │   │   ├── plugin_files.rs           # Plugin file I/O with path safety
│   │   │   ├── main_playlist.rs          # Queue persistence (manifest I/O)
│   │   │   ├── mixtapes.rs               # Mixtape export/import
│   │   │   ├── publish.rs                # Music source publishing
│   │   │   ├── transcode.rs              # Transcode server control
│   │   │   ├── waveforms.rs              # Waveform computation/caching
│   │   │   ├── mpv_engine.rs             # Native engine commands
│   │   │   └── [additional modules]
│   │   ├── db/                           # Database layer (SQLite)
│   │   │   ├── mod.rs                    # Database struct, init_tables, migrations
│   │   │   ├── albums.rs                 # Album queries
│   │   │   ├── artists.rs                # Artist queries
│   │   │   ├── tracks.rs                 # Track queries (primary workhorse)
│   │   │   ├── tags.rs                   # Tag management
│   │   │   ├── likes.rs                  # Like state (entity_likes table)
│   │   │   ├── playlists.rs              # Playlist records + entries
│   │   │   ├── collections.rs            # Collection records
│   │   │   ├── history.rs                # Play history queries
│   │   │   ├── search.rs                 # FTS search (tracks_fts table)
│   │   │   ├── image_failures.rs         # Failed image fetches (backoff cache)
│   │   │   └── plugin_storage.rs         # Plugin persisted key-value storage
│   │   ├── scanner.rs                    # File tree walk + tag reading → track upsert
│   │   ├── sync.rs                       # Subsonic paginated album/track sync
│   │   ├── subsonic.rs                   # Subsonic/Navidrome API client
│   │   ├── manifest_sync.rs              # HTTP JSON manifest subscription sync
│   │   ├── music_publish.rs              # Export a collection as a shareable folder
│   │   ├── bundle_ref.rs                 # Manifest URL reference resolver (RFC-3986)
│   │   ├── downloader.rs                 # Download queue + format conversion
│   │   ├── downloader_*                  # (Separate modules for provider logic)
│   │   ├── lastfm.rs                     # Last.fm API client
│   │   ├── models.rs                     # Serde-serializable shared types
│   │   ├── plugins.rs                    # Plugin discovery, manifest loading, gallery
│   │   ├── image_provider/               # Trait-based image resolution
│   │   │   ├── mod.rs                    # Provider traits + setup
│   │   │   └── [provider implementations]
│   │   ├── lyric_provider/               # Trait-based lyric resolution
│   │   │   ├── mod.rs                    # LyricProvider trait
│   │   │   └── lrclib.rs                 # LRCLIB.net provider
│   │   ├── entity_image.rs               # Canonical slug generation for image paths
│   │   ├── composite_image.rs            # Tag composite image generation
│   │   ├── skins.rs                      # Skin file I/O + gallery fetching
│   │   ├── mixtape.rs                    # Mixtape format (JSON + file bundle)
│   │   ├── main_playlist.rs              # Queue persistence (manifest + thumbs)
│   │   ├── music_publish.rs              # Publish collection as downloadable source
│   │   ├── publish_server.rs             # Embedded HTTP server for published music
│   │   ├── video_frames.rs               # Video frame extraction (ffmpeg) + caching
│   │   ├── storyboard.rs                 # Video storyboard sheet generation
│   │   ├── transcode_server.rs           # Per-file HTTP transcode session (axum)
│   │   ├── mpv_engine/                   # Native audio/video playback engine
│   │   │   ├── mod.rs                    # EngineHandle, dual decks, events
│   │   │   ├── ffi.rs                    # dlopen/LoadLibraryW runtime loader
│   │   │   ├── api.rs                    # Safe libmpv wrapper
│   │   │   ├── component.rs              # Downloadable engine-component management
│   │   │   ├── af.rs                     # DSP (EQ, bass, treble, limiter)
│   │   │   ├── video_layer.rs            # macOS native video rendering
│   │   │   └── video_layer_win.rs        # Windows native video rendering
│   │   ├── dependencies.rs               # External binary (ffmpeg, yt-dlp) probing + install
│   │   ├── update_checker.rs             # Plugin/skin update checking + retry logic
│   │   ├── browse_window.rs              # Embedded browse window for plugins
│   │   ├── error_chain.rs                # Error cause flattening (for diagnostics)
│   │   ├── logging.rs                    # File-based logging setup
│   │   ├── telemetry.rs                  # Aptabase integration
│   │   ├── tag_writer.rs                 # Write metadata edits back to audio files
│   │   ├── profiles.rs                   # Profile isolation (Chrome-like)
│   │   ├── profile_shortcuts.rs          # Desktop shortcuts for profiles (Windows)
│   │   ├── cursor_tracker.rs             # Mini player cursor polling (macOS)
│   │   ├── cursor_tracker_win.rs         # Mini player cursor polling (Windows)
│   │   ├── timing.rs                     # Startup performance profiling
│   │   ├── seed.rs                       # Debug-only fake data
│   │   └── [conditional modules]
│   ├── Cargo.toml                        # Rust dependencies
│   ├── capabilities/                     # Tauri capability definitions
│   ├── build.rs                          # Build script (link search paths for libmpv)
│   ├── vendor/                           # Vendored libmpv binaries
│   │   └── libmpv/                       # Per-platform libmpv (macOS dylib, Windows DLL)
│   ├── icons/                            # App icons + Tauri resources
│   ├── plugins/                          # Built-in plugin sources (info providers)
│   │   ├── audiodb/                      # AudioDB (artist/album/track art)
│   │   ├── deezer/                       # Deezer stream resolver
│   │   ├── itunes/                       # iTunes local library integration
│   │   ├── lastfm/                       # Last.fm (scrobble, tags, info)
│   │   ├── lrclib/                       # LRCLIB.net (lyrics)
│   │   ├── lyrics-ovh/                   # Lyrics.ovh (lyrics)
│   │   ├── musicbrainz/                  # MusicBrainz (metadata)
│   │   ├── mock-download/                # Test/demo download provider
│   │   └── [custom plugins]
│   └── gen/                              # Generated Tauri bindings (ignore)
│
├── tests/                                # E2E tests
│   └── e2e/
│       ├── playwright.config.js          # Playwright configuration
│       └── specs/
│           ├── screenshots.test.js       # Visual regression (screenshot suite)
│           └── [other E2E specs]
│
├── scripts/                              # Utility scripts
│   ├── fetch-libmpv.mjs                  # Download + vendor pinned libmpv
│   ├── package-engine-component.mjs      # Package downloadable engine component
│   ├── bump.mjs                          # Release: version bump, changelog, LOC count
│   ├── loc.mjs                           # Code size counter (VS Code Counter port)
│   ├── perf-probe.mjs                    # macOS resource profiling (CPU, GPU, memory)
│   ├── convert-screenshots.mjs           # Screenshot conversion (for release notes)
│   ├── deploy-site-vps.ps1               # VPS deployment script
│   └── lib/                              # Shared script utilities
│       └── [helpers]
│
├── docs/                                 # Public website (docs/index.html)
│   ├── css/, js/, assets/                # Site assets
│   ├── features.json                     # Feature list (auto-gen from code)
│   ├── features.html                     # Rendered feature list
│   └── help.html                         # Help page (anchor destinations for HelpLink)
│
├── deploy/                               # Deployment configurations
│   ├── aptabase/                         # Self-hosted analytics
│   │   ├── compose.yml                   # Docker Compose for VPS
│   │   └── [config files]
│   └── viboplr-site/                     # Site hosting configs
│
├── benchmarks/                           # Performance data
│   ├── loc-history.json                  # Code size per release
│   └── resource-usage.json               # CPU/GPU/memory per scenario
│
├── public/                               # Vite public assets (bundled as-is)
│   └── [static files]
│
├── package.json                          # npm dependencies + scripts
├── tsconfig.json                         # TypeScript configuration
├── vite.config.ts                        # Vite bundler config
├── .env, .env.*.local                    # Environment variables (untracked)
├── CLAUDE.md                             # Project instructions (see above)
├── CONTRIBUTING.md, DEVELOPMENT.md       # Contributor guides
├── README.md                             # Public project README
└── [CI workflows, etc.]
```

## Directory Purposes

**`src/`:**
- React/TypeScript frontend source code
- Single-file components (`.tsx`) paired with styles (`.css` in App.css or component-scoped)
- Hooks, utilities, types, and contexts
- 100+ component files, 50+ hooks, 40+ utility modules
- Tests co-located in `__tests__/` (vitest)

**`src/components/`:**
- Pure React UI components (presentational + connected)
- Simple modals own their local state; complex ones take props from App.tsx
- CSS co-located in App.css (single file, scoped via BEM-like naming or `.component-name` class)
- No Redux/MobX — state from hooks

**`src/hooks/`:**
- Custom React hooks (state, side effects, business logic)
- `usePlayback`, `useQueue`, `useLibrary` are the core orchestrators
- Hooks take `restoredRef` (for app startup synchronization) or other refs to avoid stale closures
- Rarely nested; App.tsx composes all, passes deps down explicitly

**`src/playback/`:**
- Playback engine abstraction (browser audio elements + native mpv)
- Session management, gapless decision logic, buffer state normalization
- No components here — pure logic

**`src-tauri/src/`:**
- Rust backend source
- `lib.rs` is the single source of truth for command registration (via `invoke_handler!` macro)
- Every command implements `Result<T, String>` for error handling
- No build features (single flavor per platform)

**`src-tauri/src/commands/`:**
- One module per domain (library, downloads, images, etc.)
- Each function is a thin handler: validate → delegate to db/services → serialize response
- Async commands use `spawn_blocking` for I/O to avoid blocking the main thread

**`src-tauri/src/db/`:**
- SQLite wrapper, schema definition, migrations
- One module per entity (tracks, artists, albums, tags, likes, etc.)
- All queries use the `Database` struct (Arc<Mutex<Connection>>)
- Transactions are explicit (no autocommit)

**`src-tauri/src/mpv_engine/`:**
- Native playback via libmpv
- Runtime loader (dlopen/LoadLibraryW), dual-deck gapless, video layers (macOS/Windows)
- Vendored libmpv ships in every release; downloadable component is a runtime fallback

**`src-tauri/plugins/`:**
- Built-in plugin sources (information types: AudioDB, Last.fm, etc.)
- Each is a Rust → JS bridge, not a standalone plugin repo
- The app hosts these; plugin authors can fork and distribute their own

**`tests/e2e/`:**
- Playwright E2E tests (headless browser automation)
- CI runs them on every PR; local: `npm run test:e2e`

**`scripts/`:**
- Release automation, build helpers, profiling tools
- `fetch-libmpv.mjs` is required before `npm run tauri build`

**`docs/`:**
- Public website (site.md covers generation details)
- `features.json` auto-generated from code (see site.md)
- `help.html` anchor targets for in-app HelpLink components

**`.planning/codebase/`:**
- Generated codebase documentation (these files)

## Key File Locations

**Entry Points:**
- Frontend: `src/main.tsx` (React DOM bootstrap) → `src/App.tsx` (root component)
- Backend: `src-tauri/src/lib.rs::main()` (Tauri app setup)

**Configuration:**
- Frontend build: `vite.config.ts`
- TypeScript: `tsconfig.json`
- Backend: `src-tauri/Cargo.toml`
- Tauri app: `src-tauri/tauri.conf.json` (+ per-platform overlays)
- Dependencies: `package.json`, `Cargo.toml`

**Core Logic:**
- Playback: `src/hooks/usePlayback.ts` + `src/playback/`
- Queue: `src/hooks/useQueue.ts`
- Library: `src-tauri/src/db/tracks.rs`, `search.rs`
- Downloads: `src-tauri/src/downloader.rs` + `src-tauri/src/commands/downloads.rs`
- Collections: `src-tauri/src/sync.rs`, `manifest_sync.rs`
- Plugins: `src-tauri/src/plugins.rs` + `src/hooks/usePlugins.ts`
- Likes: `src-tauri/src/db/likes.rs` + `src/hooks/useLikeActions.ts`

**Testing:**
- Frontend unit: `src/__tests__/*.test.ts`
- Backend unit: `src-tauri/src/` (inline `#[cfg(test)] mod tests`)
- E2E: `tests/e2e/specs/`
- Config: `tests/e2e/playwright.config.js`

## Naming Conventions

**Files:**
- **Components:** PascalCase (`TrackList.tsx`, `NowPlayingBar.tsx`)
- **Hooks:** camelCase starting with `use` (`usePlayback.ts`, `useQueue.ts`)
- **Utilities:** camelCase (`errorKind.ts`, `resolveImageUrl.ts`)
- **Styles:** Paired with component or in App.css (BEM-style class names)
- **Tests:** `*.test.ts` or `*.spec.ts` (vitest auto-discovers)
- **Backend modules:** snake_case (`scanner.rs`, `image_provider.rs`)

**Variables/Functions:**
- **camelCase:** Functions, variables, hooks
- **PascalCase:** Types, components, classes
- **UPPER_SNAKE_CASE:** Constants (export const)

**React Patterns:**
- Refs: `*Ref` suffix (e.g., `contentRef`, `prefetchNextRef`)
- State setters: `set*` prefix (e.g., `setShowModal`, `setPlayback`)
- Handlers: `handle*` prefix (e.g., `handlePlay`, `handleDelete`)
- Computed values: return directly or via memo (no `get*` prefix)
- Import groups: React → Tauri → local types → local components/utils (alphabetical within groups)

**Database:**
- **Tables:** plural snake_case (`tracks`, `artists`, `collections`)
- **Columns:** snake_case (`track_count`, `artist_id`, `path`)
- **Indexes:** `idx_{table}_{column}` or semantic name
- **Queries:** Module names are singular entity (`tracks.rs` for the tracks table)

## Where to Add New Code

**New Feature (UI + Backend):**
1. **Component:** `src/components/` + `App.tsx` state/hook composition
2. **Hook (if stateful):** `src/hooks/` (state + effects)
3. **Backend command:** `src-tauri/src/commands/{domain}.rs` (new module if a new domain)
4. **Database query:** `src-tauri/src/db/{entity}.rs` (new module if a new entity)
5. **Tauri registration:** Add handler to `invoke_handler!` macro in `src-tauri/src/lib.rs`

**Example: "Add a user rating system"**
1. Create `src/components/RatingButtons.tsx`
2. Create `src/hooks/useRatingActions.ts` (invoke + state)
3. Add `set_track_rating` command in `src-tauri/src/commands/library.rs`
4. Create `src-tauri/src/db/ratings.rs` for the `track_ratings` table
5. Add migration in `db/mod.rs::run_migrations()` (if schema change)
6. Register command in `invoke_handler!` in `src-tauri/src/lib.rs`
7. Add tests in component and hook files

**New Component/Module:**
- **Presentational:** Place in `src/components/`, take props from parent
- **Stateful:** If complex, extract state to `src/hooks/`
- **Icon/helper:** `src/components/` if <50 LOC, otherwise `src/utils/`
- **CSS:** Inline in App.css with component-scoped class names (`.component-name`)

**Utilities:**
- **Formatting/parsing:** `src/utils/`
- **Type/model helpers:** `src/utils/` (e.g., `utils/likeReconcile.ts`)
- **Shared logic between hooks:** Extract to `src/utils/`
- **Shared Rust:** Create module in `src-tauri/src/` (no single "utils" module)

**Testing:**
- **Frontend unit:** `src/__tests__/{module}.test.ts` (vitest, testing-library)
- **Backend unit:** Inline `#[cfg(test)]` blocks in the same `.rs` file
- **E2E:** Add spec to `tests/e2e/specs/` (Playwright, headless automation)

## Special Directories

**`src-tauri/vendor/libmpv/`:**
- Purpose: Vendored libmpv binaries (macOS dylib, Windows DLL)
- Generated: Yes — run `node scripts/fetch-libmpv.mjs` to populate
- Committed: Gitignored (too large); in releases, bundled via `tauri.conf.json` overlays
- Per-platform: `{platform}/lib{mpv,mpv_core}.*` + headers

**`src-tauri/plugins/`:**
- Purpose: Built-in plugin sources (bridges to JS)
- Generated: No
- Committed: Yes — part of the core app
- Pattern: Each subdirectory is a plugin (e.g., `lastfm/src/lib.rs` + manifest)

**`src/.env`, `.env.local`, etc.:**
- Purpose: Environment variables (secrets, tokens)
- Generated: No
- Committed: Never (`.gitignore`)
- Content: API keys, Subsonic creds (not populated by default)

**`.planning/codebase/`:**
- Purpose: Generated codebase documentation (these files)
- Generated: Yes — via `/gsd-map-codebase` skill
- Committed: Yes — reference for future changes

**`dist/`:**
- Purpose: Built frontend bundle
- Generated: Yes — `npm run build`
- Committed: No

**`src-tauri/target/`:**
- Purpose: Rust build artifacts
- Generated: Yes — `cargo build`
- Committed: No

**`node_modules/`, `src-tauri/target/`:**
- Not committed; listed in `.gitignore`

---

*Structure analysis: 2026-08-14*
