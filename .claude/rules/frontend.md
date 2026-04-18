# Frontend (src/)

## Core Files

- **App.tsx** — Single-file React app. All state, views, playback controls, context menu, sidebar. Views toggled via `View` union type: `"all" | "artists" | "albums" | "tags" | "liked" | "history" | "tidal" | "collections"`.
- **App.css** — All styles. CSS Grid layout, CSS custom properties for skinning, 7-level type scale (`--fs-2xs` through `--fs-2xl`). Shared keyframe animations: `fade-in`, `scale-in`, `glow-pulse`, `slide-text-in`, `equalizer-bar-{1,2,3}`, `waveform-grow-in`.
- **skinUtils.ts** — Skin validation, CSS generation, customCSS sanitization.
- **types.ts** — Core TypeScript types (Track, Artist, Album, Tag, etc.).
- **types/skin.ts** — Skin system types (SkinJson, SkinInfo, SkinColors, GallerySkinEntry).
- **types/plugin.ts** — Plugin types (PluginManifest, PluginState, PluginContextMenuTarget, PluginViewData, ViboplrPluginAPI).
- **types/informationTypes.ts** — InfoEntity, InfoFetchResult, InfoTypeDeclaration, DisplayKind.
- **skins/** — Built-in skin JSON files (8 skins) and index.

## Components (src/components/)

- **CaptionBar.tsx** — Custom caption bar: window controls, brand logo, back/forward nav, `CentralSearchDropdown`, mini player button. Full-width drag region (`data-tauri-drag-region`).
- **Sidebar.tsx** — Navigation sidebar with animated active indicator. Items: Tracks (Cmd+1), Artists (Cmd+2), Albums (Cmd+3), Tags (Cmd+4), Liked (Cmd+5), History (Cmd+6), Playlists, plugin sidebar items. Bottom: Collections, Settings (with update badge). Collapsible via Cmd+B.
- **TrackList.tsx** — Table/list/tile view for tracks with column sorting, multi-selection (Click, Cmd+Click, Shift+Click), and drag-to-queue.
- **NowPlayingBar.tsx** — Footer playback controls. Full mode: seek bar (waveform or segmented), track info with like/dislike, transport controls, queue mode, auto-continue, volume. Mini mode: compact draggable bar with art, title/artist, play controls. Rank badges for top-100 tracks. Scrobble indicator checkmark.
- **QueuePanel.tsx** — Right sidebar playlist panel. Drag-and-drop reorder, multi-select, duplicate detection banner (add all / add new / cancel with auto-approve countdown). Resizable width. Collapsed mode (40px strip).
- **HistoryView.tsx** — Tabbed history: All Time, Last 30 Days, Recent (relative timestamps), Artists. Ghost entry reconnection on double-click. Exposes `reload()` via imperative handle.
- **TidalView.tsx** — TIDAL search/browse (now powered by tidal-browse plugin).
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
- **AddServerModal.tsx, AddTidalModal.tsx, EditCollectionModal.tsx** — Collection modals.
- **TrackPropertiesModal.tsx** — Tabbed modal (Info, Tags, Similar, Artist, Album).
- **UpgradeTrackModal.tsx** — TIDAL track upgrade: search -> download preview -> compare -> confirm/cancel.
- **FullscreenControls.tsx** — Video fullscreen overlay.
- **StatusBar.tsx, Icons.tsx, WindowControls.tsx** — Utility components.

## Hooks (src/hooks/)

- **usePlayback.ts** — Dual A/B audio element architecture for gapless/crossfade. Preloads next track when remaining < `max(5, crossfadeSecs + 2)` seconds. Crossfade via requestAnimationFrame volume ramp. Video tracks don't crossfade.
- **useQueue.ts** — Queue management. `playTracks()` / `enqueueTracks()` / `playNextInQueue()`. Duplicate detection via `findDuplicates()`.
- **useLibrary.ts** — Library data queries, column configuration, view modes, sort/filter state.
- **usePlugins.ts** — Plugin discovery, loading (`new Function("api", code)`), activation, event dispatch, context menu dispatch, view data management, enable/disable, reload.
- **useEventListeners.ts** — Tauri backend event subscriptions for all `listen<T>()` events.
- **useImageCache.ts** — Entity image caching and on-demand fetching with dedup guards.
- **useAutoContinue.ts** — Auto-continue with 5 weighted strategies: Random (40%), Same Artist (20%), Same Tag (20%), Most Played (10%), Liked (10%). "Same format" filter option.
- **useMiniMode.ts** — Mini player (40px height, 280-550px auto-width). Always-on-top, no decorations. macOS transparent background via Cocoa APIs.
- **useVideoSplit.ts** — Resizable video splitter (default 300px, min 150px track list). Dock sides: top/bottom/left/right.
- **useWaveform.ts** — Waveform data caching and computation.
- **useGlobalShortcuts.ts** — Keyboard shortcuts (see below).
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
Cmd/Ctrl: 1-6 (views), K (search), F (fullscreen), L (like), P (playlist panel), M (mute), Shift+M (mini), B (sidebar), Left/Right (prev/next track).
Alt: Left/Right (nav history back/forward).
Track list: arrows (navigate), Enter (play), Shift+Enter (enqueue).

## State Persistence

UI state persisted via `tauri-plugin-store` to `app-state.json` in profile directory. Key states: view, selected entities, current track + position, queue (track IDs + index + mode), volume, window geometry (full + mini separately), crossfade, auto-continue weights, view modes per entity, skin, sort/filter per entity, section toggles, Last.fm session, sync-with-playing. Saves debounced at 500ms. A `restoredRef` guard prevents overwriting persisted data with defaults on startup.

## Scrobble Threshold

Play history / Last.fm scrobble recorded after 50% of duration or 4 minutes (whichever first). Tracks < 30 seconds are never recorded. Video tracks excluded unless "Track video history" is enabled.
