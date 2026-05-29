# Frontend (src/)

## Core Files

- **App.tsx** — Root React component: owns app-wide state, hook composition, playback/stream-resolver wiring, context menu, sidebar, and the view render tree. Views toggled via `View` union type: `"search" | "artists" | "albums" | "tags" | "history" | "collections" | "playlists" | "settings" | "extensions" | plugin:${string}`. The unified Library is `"search"` (rendered by `SearchView`); `"artists"`, `"albums"`, `"tags"` are detail-page views reached by selecting an entity from the Library. Simple confirmation/error/loading modals are presentational leaf components in `components/modals/` (`ConfirmModals.tsx`, `YoutubeFeedbackModal.tsx`) — App.tsx owns their state and passes primitive props + callbacks; the components hold no app state. The native context-menu spec building lives in `contextMenu/buildContextMenuSpecs.tsx` — a pure `buildContextMenuSpecs(target, deps)` that returns the `MenuItemSpec[]` (or `null`) per `ContextMenuTarget` kind; App.tsx keeps a thin `buildAndShowNativeMenu` wrapper that owns `setContextMenu` + `showNativeMenu`.
- **App.css** — All styles. CSS Grid layout, CSS custom properties for skinning, 7-level type scale (`--fs-2xs` through `--fs-2xl`). Shared keyframe animations: `fade-in`, `scale-in`, `glow-pulse`, `slide-text-in`, `equalizer-bar-{1,2,3}`, `waveform-grow-in`.
- **skinUtils.ts** — Skin validation, CSS generation, customCSS sanitization.
- **types.ts** — Core TypeScript types (Track, QueueTrack, Artist, Album, Tag, etc.). `Track` is the full library type with DB IDs; `QueueTrack` is the ID-less metadata type used by queue/playback/playlists.
- **types/skin.ts** — Skin system types (SkinJson, SkinInfo, SkinColors, GallerySkinEntry).
- **types/plugin.ts** — Plugin types (PluginManifest, PluginState, PluginContextMenuTarget, PluginViewData, ViboplrPluginAPI).
- **types/informationTypes.ts** — InfoEntity, InfoFetchResult, InfoTypeDeclaration, DisplayKind.
- **skins/** — Built-in skin JSON files (8 skins) and index.

## Components (src/components/)

- **CaptionBar.tsx** — Custom caption bar: window controls, brand logo, back/forward nav, `CentralSearchDropdown`, mini player button. Full-width drag region (`data-tauri-drag-region`).
- **Sidebar.tsx** — Navigation sidebar with animated active indicator. Items: Library (Cmd+1), History (Cmd+2), Playlists, plugin sidebar items. Bottom: Collections, Extensions (with update count badge), Settings (with update badge). Collapsible via Cmd+B.
- **TrackList.tsx** — Table/list/tile view for tracks with column sorting, multi-selection (Click, Cmd+Click, Shift+Click), and drag-to-queue.
- **NowPlayingBar.tsx** — Footer playback controls. Full mode: seek bar (waveform or segmented), track info with like/dislike, transport controls, queue mode, auto-continue, volume. Mini mode: compact draggable bar with art, title/artist, play controls. Rank badges for top-100 tracks. Scrobble indicator checkmark. Album art resolved async via `currentTrack` effect in `App.tsx` — same priority chain as queue (see `queue.md` "Image Resolution" section).
- **QueuePanel.tsx** — Right sidebar playlist panel. Drag-and-drop reorder, multi-select, duplicate detection banner (add all / add new / cancel with auto-approve countdown). Resizable width. Collapsed mode (40px strip).
- **HistoryView.tsx** — Tabbed history: All Time, Last 30 Days, Recent (relative timestamps), Artists. Ghost entry reconnection on double-click. Exposes `reload()` via imperative handle.
- **CollectionsView.tsx** — Collection management with kind badges, resync, edit (name, enabled, auto-update, frequency).
- **PlaylistsView.tsx** — Saved playlists grid/detail.
- **ArtistDetailContent.tsx** — Circular avatar, like/hate, collapsible sections (Top Songs, About, Albums, Similar Artists), horizontal album scroll. Section toggles persisted as `artistSections`.
- **AlbumDetailHeader.tsx** — 240x240 cover, title, artist (clickable), year, count, play all, like/hate. Section toggles persisted as `albumSections`.
- **TrackDetailView.tsx** — Hero header with album art, quality stats (format, bitrate, sample rate, file size), Last.fm stats, inline tags. Sections: Scrobble History, Similar Tracks, Community Tags, Lyrics (LyricsPanel), Song Explanation (Genius). Section toggles persisted as `trackSections`.
- **InformationSections.tsx** — Tab-based interface for plugin-provided info. Drag-and-drop reorderable tabs, lazy-loaded with caching.
- **PluginViewRenderer.tsx** — Renders PluginViewData types: track-list, card-grid, track-row-list, text, stats-grid, buttons, toggles, tabs, layouts, search inputs, progress bars, settings rows.
- **Breadcrumb.tsx** — View title with play/queue all actions and `ViewModeToggle`.
- **ViewSearchBar.tsx** — Per-view search input with arrow key list navigation.
- **CentralSearchDropdown.tsx** — Global search (Cmd+K) with grouped results (Artists, Albums, Tracks), dynamic slot allocation (~7 items), 200ms debounce. Enter plays, Cmd+Enter enqueues.
- **ContextMenu.tsx** — Right-click context menu. Smart clamped positioning. Provider favicons.
- **ViewModeToggle.tsx** — Basic/list/tiles toggle.
- **WaveformSeekBar.tsx** — Waveform visualization via Web Audio API (RMS amplitude, 95th percentile normalization, 1/sec buckets capped at 400). Cached as `{app_dir}/waveforms/v2/{track_id}.json`.
- **LyricsPanel.tsx** — Synced lyrics with timed highlighting and auto-scroll (5s pause on manual scroll), plain lyrics display, edit mode with kind selector, provider badges.
- **AlbumCardArt.tsx, ArtistCardArt.tsx, TagCardArt.tsx** — Entity card images with lazy loading via IntersectionObserver.
- **AddServerModal.tsx, EditCollectionModal.tsx** — Collection modals.
- **TrackPropertiesModal.tsx** — Tabbed modal (Info, Tags, Similar, Artist, Album).
- **FullscreenControls.tsx** — Video fullscreen overlay.
- **StatusBar.tsx, Icons.tsx, WindowControls.tsx** — Utility components.

## Hooks (src/hooks/)

- **usePlayback.ts** — Dual A/B audio element architecture for gapless/crossfade. Preloads next track when remaining < `max(5, crossfadeSecs + 2)` seconds. Crossfade via requestAnimationFrame volume ramp. Video tracks don't crossfade. `currentTrack` is `QueueTrack | null`.
- **useQueue.ts** — Queue management using `QueueTrack[]`. `playTracks()` / `enqueueTracks()` / `playNextInQueue()`. Duplicate detection via `findDuplicates()`. Image stamping uses name-based lookup (no DB IDs).
- **useLibrary.ts** — Library data queries, column configuration, view modes, sort/filter state.
- **usePlugins.ts** — Plugin discovery, loading (`new Function("api", code)`), activation, event dispatch, context menu dispatch, view data management, enable/disable, reload.
- **useEventListeners.ts** — Tauri backend event subscriptions for all `listen<T>()` events.
- **useImageCache.ts** — Entity image caching and on-demand fetching with dedup guards.
- **useAutoContinue.ts** — Auto-continue with 5 weighted strategies: Random (40%), Same Artist (20%), Same Tag (20%), Most Played (10%), Liked (10%). "Same format" filter option.
- **useMiniMode.ts** — Mini player (40px height, 280-550px auto-width). Always-on-top, no decorations. macOS transparent background via Cocoa APIs.
- **useVideoSplit.ts** — Resizable video splitter (default 300px, min 150px track list). Dock sides: top/bottom/left/right.
- **useWaveform.ts** — Waveform data caching and computation.
- **useGlobalShortcuts.ts** — OS-level media keys (MediaPlayPause/Next/Previous/Stop) via Tauri's global-shortcut plugin.
- **useInAppKeyboardShortcuts.ts** — In-window keyboard shortcuts (the `window` keydown handler; see "Keyboard Shortcuts" below). Takes a single `deps` object refreshed into a ref each render, so its one installed listener never reads stale closures. App.tsx owns the deps; the hook owns the dispatch.
- **useViewSearchState.ts** — Per-view independent search state, persists across view switches.
- **useCentralSearch.ts** — Global search with parallel artist/album/track queries.
- **useNavigationHistory.ts** — Back/forward navigation with per-view search query persistence.
- **useSessionLog.ts** — Session logging via `addLog()`.
- **useAppUpdater.ts** — App update checking and installation.
- **usePasteImage.ts** — Clipboard image paste handling for entity images.
- **useSkins.ts** — Skin management: load/apply/import/delete, gallery browsing, CSS injection via `<style id="viboplr-skin">`.
- **useLikeActions.ts** — Like/unlike for tracks (tri-state: -1/0/1), artists, albums, tags (binary: 0/1).
- **useContextMenuActions.ts** — Context menu action handlers (delete, show in folder, YouTube, etc.).
- **useDownloads.ts** — Download management with progress tracking.

## Keyboard Shortcuts

No modifier (when not in text input): Space (play/pause), arrows (seek/volume).
Cmd/Ctrl: 1 (Library), 2 (History), K (search), F (fullscreen), L (like), P (playlist panel), M (mute), Shift+M (mini), B (sidebar), Left/Right (prev/next track).
Alt: Left/Right (nav history back/forward).
Track list: arrows (navigate), Enter (play), Shift+Enter (enqueue).

## State Persistence

UI state persisted via `tauri-plugin-store` to `app-state.json` in profile directory. Key states: current track + position, queue (track IDs + index + mode), volume, window geometry (full + mini separately), crossfade, auto-continue weights, view modes per entity, skin, sort/filter per entity, section toggles, sync-with-playing. (Last.fm session/auto-import state lives in plugin storage, owned by the lastfm plugin — not the app store.) Saves debounced at 500ms. A `restoredRef` guard prevents overwriting persisted data with defaults on startup. On mount, App.tsx's restore effect reads the primary settings via `startup/readPersistedSettings.ts` (`readPersistedSettings(store)` returns a named object — no positional tuple) and then applies them to its hooks/setters. `view` and selected-entity state are intentionally NOT read/restored — startup always lands on Home.

## Scrobble Threshold

Play history / Last.fm scrobble recorded after 50% of duration or 4 minutes (whichever first). Tracks < 30 seconds are never recorded. Video tracks excluded unless "Track video history" is enabled.
