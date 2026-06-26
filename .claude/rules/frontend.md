# Frontend (src/)

## Core Files

- **App.tsx** — Root React component: owns app-wide state, hook composition, playback/stream-resolver wiring, context menu, sidebar, and the view render tree. Views toggled via `View` union type: `"home" | "search" | "artists" | "albums" | "tags" | "history" | "collections" | "playlists" | "nowplaying" | "settings" | "extensions" | plugin:${string}`. The unified Library is `"search"` (rendered by `SearchView`); `"artists"`, `"albums"`, `"tags"` are detail-page views reached by selecting an entity from the Library. Simple confirmation/error/loading modals are presentational leaf components in `components/modals/` (`ConfirmModals.tsx`) — App.tsx owns their state and passes primitive props + callbacks; the components hold no app state. The native context-menu spec building lives in `contextMenu/buildContextMenuSpecs.tsx` — a pure `buildContextMenuSpecs(target, deps)` that returns the `MenuItemSpec[]` (or `null`) per `ContextMenuTarget` kind; App.tsx keeps a thin `buildAndShowNativeMenu` wrapper that owns `setContextMenu` + `showNativeMenu`.
- **App.css** — All styles. CSS Grid layout, CSS custom properties for skinning, 7-level type scale (`--fs-2xs` through `--fs-2xl`). Shared keyframe animations: `fade-in`, `scale-in`, `glow-pulse`, `slide-text-in`, `equalizer-bar-{1,2,3}`, `waveform-grow-in`.
- **skinUtils.ts** — Skin validation, CSS generation, customCSS sanitization.
- **types.ts** — Core TypeScript types (Track, QueueTrack, Artist, Album, Tag, etc.). `Track` is the full library type with DB IDs; `QueueTrack` is the ID-less metadata type used by queue/playback/playlists.
- **types/skin.ts** — Skin system types (SkinJson, SkinInfo, SkinColors, GallerySkinEntry).
- **types/plugin.ts** — Plugin types (PluginManifest, PluginState, PluginContextMenuTarget, PluginViewData, ViboplrPluginAPI).
- **types/informationTypes.ts** — InfoEntity, InfoFetchResult, InfoTypeDeclaration, DisplayKind.
- **skins/** — Built-in skin JSON files (8 skins) and index.

## Components (src/components/)

- **CaptionBar.tsx** — Custom caption bar: window controls, brand logo, `CentralSearchDropdown`, mini player button. Full-width drag region (`data-tauri-drag-region`).
- **Sidebar.tsx** — Navigation sidebar with animated active indicator. Items: Home (Cmd+0), Library (Cmd+1), History (Cmd+2), Now Playing (Cmd+3), Playlists, plugin sidebar items. Bottom: Collections, Extensions (with update count badge), Settings (with update badge). Collapsible via Cmd+B. The Now Playing icon is playback-aware: `SpinningDisc` for audio, `FilmReel` for video, both frozen when paused.
- **TrackList.tsx** — Table/list/tile view for tracks with column sorting, multi-selection (Click, Cmd+Click, Shift+Click), and drag-to-queue.
- **NowPlayingBar.tsx** — Footer playback controls. Full mode: seek bar (waveform or segmented), track info with like/dislike, transport controls, queue mode, auto-continue, volume. Mini mode: compact draggable bar with art, title/artist, play controls. Rank badges for top-100 tracks. Scrobble indicator checkmark. Album art resolved async via `currentTrack` effect in `App.tsx` — same priority chain as queue (see `queue.md` "Image Resolution" section). The **full bar** shows a static, clickable Artist · Album line under the title; the dynamic, cycling **Now Playing info** section (rendered by `NowPlayingInfoCycler`) is **mini-player only**.
- **NowPlayingInfoCycler.tsx** — Presentational cycling line for the Now Playing info section, used only by the mini player. Auto-rotates the host-resolved enabled items (5s) with the shared `slide-text-enter` animation; one item → static. Always rendered in `plain` mode (text only — no clickable links/rank badges). Items come from `useNowPlayingInfo`; selection is toggled via the mini player's native context menu (see `plugins.md` "api.nowPlayingInfo").
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
- **NowPlayingView.tsx** — Lean-back current-track view (the `nowplaying` main view). Audio: blurred-art backdrop + album art + centered lyrics (no up-next panel — the Queue Panel owns upcoming tracks). Video: shared `<video>` repositioned to fill the column (theater mode, `.video-container--theater`) with a `VideoAmbientOverlay`. Lyrics via `useLyrics`. See `ui.md` "Now Playing View".
- **VideoAmbientOverlay.tsx** — Ambient layers over the theater-mode video in NowPlayingView: sampled color glow (`extractDominantColor`), auto-hiding up-next chip, auto-hiding title/artist intro. Idle-timer visibility mirrors FullscreenControls. Pure helpers in `utils/videoOverlay.ts`.
- **FilmReel.tsx** — Animated film-reel icon (video counterpart to `SpinningDisc`) used by the playback-aware sidebar Now Playing icon.
- **HomeView.tsx, HomeHero.tsx, HomeShelf.tsx** — Home landing surface: `HomeView` composes the page and owns the inline shelf-visibility popover; radio-station hero carousel (`HomeHero`); horizontal shelves (`HomeShelf`, with the `resolveImagePath` helper). State owned by `useHome.ts`. See `ui.md` "Home View".
- **SearchView.tsx** — The unified Library view (the `search` view): tabbed Tracks/Artists/Albums/Tags, empty query shows the full library.
- **ExtensionsView.tsx** — Plugin/extension management (install from gallery, enable/disable, updates).
- **SettingsPanel.tsx** — Settings UI: providers ordering, dependencies, skins, profiles, toggles.
- **DetailHero.tsx, DetailHeroBackground.tsx, DetailHeroEffect.tsx** — Shared native detail hero (multi-image crossfade background, FX looks, square/circle art, play/enqueue + overflow). Used by all detail pages and the plugin `detail-header` display kind. Images via `useDetailHeroImages.ts`.
- **AlbumDetail.tsx, TagDetail.tsx** — Detail-page wrappers composing the hero + track list + information sections for albums/tags.
- **DownloadModal.tsx** — Unified download flow (provider-chain resolution, interactive manual search, progress). See conventions.md "Download Track".
- **BulkEditModal.tsx** — Multi-track tag/metadata bulk editor (`bulk_update_tracks`). Tag suggestions fold in Last.fm community tags via `useCommunityTags` + `appendCommunityTags` (artist-level tags only for multi-track selections).
- **LikeDislikeButtons.tsx** — Shared like (heart) / dislike (X) button pair, reused across surfaces.
- **SegmentedSeekBar.tsx** — Segmented (non-waveform) seek bar variant for the Now Playing bar.
- **AutoContinuePopover.tsx, EqPopover.tsx** — Popover controls for auto-continue strategy weights and the equalizer.
- **MiniSearchPanel.tsx** — Quick-search panel for mini mode (opened by typing when no input is focused).
- **TitleLineInfo.tsx** — Renders the `title_line` information display kind inline in detail headers.
- **VideoFilmstrip.tsx, VideoFrameCard.tsx, VideoRowThumb.tsx** — Video frame thumbnails (filmstrip + per-row/card art) backed by `useVideoFrames.ts` / `video_frames.rs`.
- **SpinningDisc.tsx** — Animated spinning-disc icon (audio counterpart to `FilmReel`).
- **AutocompleteInput.tsx, PromptModal.tsx, ConfirmModal.tsx, DeletePlaylistModal.tsx, SavePlaylistModal.tsx, DependencyModal.tsx, FirstRunPluginModal.tsx, MixtapeExportModal.tsx, MixtapePreviewModal.tsx, PlaybackErrorModal.tsx, PublishSourceModal.tsx, HeroOverflowMenu.tsx** — Supporting inputs/modals/menus (see conventions.md for native-menu and modal-dismiss rules).
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
- **useVideoLayout.ts** — Resizable video splitter / dock layout (default 300px, min 150px track list; dock sides top/bottom/left/right).
- **useWaveform.ts** — Waveform data caching and computation.
- **useGlobalShortcuts.ts** — OS-level media keys (MediaPlayPause/Next/Previous/Stop) via Tauri's global-shortcut plugin.
- **useInAppKeyboardShortcuts.ts** — In-window keyboard shortcuts (the `window` keydown handler; see "Keyboard Shortcuts" below). Takes a single `deps` object refreshed into a ref each render, so its one installed listener never reads stale closures. App.tsx owns the deps; the hook owns the dispatch.
- **useViewSearchState.ts** — Per-view independent search state, persists across view switches.
- **useCentralSearch.ts** — Global search with parallel artist/album/track queries.
- **useNavigationHistory.ts** — Single-direction back navigation (history stack only, no forward) with per-view search query persistence and scroll restoration. History is pushed **only on detail-page entry** — the `onBeforeNavigate` hook fired by `useLibrary`'s `handle*Click` / `navigateTo*ByName` paths (plus plugin navigate-to-entity). Top-level view switches (sidebar, Cmd+1/2/3) do **not** push. Because a detail page is only reachable through a push point, the top of the stack is always the page's immediate origin, so the first back is always correct. The only back affordance is the detail-page back button (`DetailHero` `onBack`, gated on `canGoBack`); there is no caption-bar back/forward UI and no global keyboard/mouse nav shortcuts.
- **useSessionLog.ts** — Session logging via `addLog()`.
- **useAppUpdater.ts** — App update checking and installation.
- **usePasteImage.ts** — Clipboard image paste handling for entity images.
- **useSkins.ts** — Skin management: load/apply/import/delete, gallery browsing, CSS injection via `<style id="viboplr-skin">`.
- **useLikeActions.ts** — Like/unlike for tracks (tri-state: -1/0/1), artists, albums, tags (binary: 0/1). Persists via `set_entity_like_state` (durable, ID-less `entity_likes` store) and propagates the new state to same-song copies in `currentTrack`/queue via the `sameSong()` predicate (key match, falling back to title+artist).
- **useContextMenuActions.ts** — Context menu action handlers (delete, show in folder, YouTube, queue ops, play/enqueue). Composes and re-exports `useQueueDragToInsert` (drag-to-queue) and `useDownloadActions` (download), and re-exports `playActions.startRadio`, so all of these stay reachable via `contextMenuActions.*` for existing consumers.
- **useQueueDragToInsert.ts** — Drag-to-queue: owns the `externalDropTarget` indicator and the raw mouse-listener / ghost-element DOM handshake; duplicate drops defer to the shared `pendingEnqueue` banner. (Split out of `useContextMenuActions`.)
- **useDownloadActions.ts** — Single + multi-track download actions; builds the `enqueue_download` payload via one `buildDownloadRequest()` helper and gates the re-download confirm on a `find_track_by_metadata` local-copy match. (Split out of `useContextMenuActions`.)
- **useCommunityTags.ts** — Fetches Last.fm community tags for a track via the `track_tags` information type (the same fetch `TrackDetailView` uses) so any tag-editing surface can suggest community tags, not just library tags. Returns merged track + artist tag names; `enabled` gates the network call (e.g. only while a popover is open), `includeTrackTags=false` returns artist-level tags only (used by multi-track bulk edit). Degrades to `[]` when the Last.fm plugin is absent. Consumed by `TagPopover` and `BulkEditModal`.
- **useLyrics.ts** — Fetches lyrics for the current track through the plugin info-type provider chain (scoped via the `include` filter on `useInformationTypes`). Used by `NowPlayingView`. Returns synced (LRC) or plain text.
- **useInformationTypes.ts** — Orchestrates plugin information-type fetching + caching for detail pages (cache decision logic, provider priority, in-flight dedup). Supports an `include` filter to scope fetches (used by `useLyrics`). See `plugins.md` "Information Sections".
- **useImageResolver.ts** — Bridge between the Rust image-download worker and JS plugin image providers (handles `image-resolve-request` events). See `plugins.md` "Image Provider Chain".
- **useHome.ts** — Home view state: built-in shelf resolvers, merged plugin shelves, radio-station selection (`pick_radio_seeds` + cover resolution), persisted snapshot + 24h refresh model. See `ui.md` "Home View".
- **useNowPlayingInfo.ts** — Resolves the cycling Now Playing info items for the current track: built-in resolvers (Artist · Album / Artist / Album / Plays · Rank / Source / Quality / Duration / Tags / Synced Lyrics / Plain Lyrics) merged with plugin items (`plugins.nowPlayingInfoItems`), fetched with a 5s timeout + generation guard. The two lyrics items resolve synchronously from cached lyrics (via `useLyrics`, fetched only when enabled) so the synced "current line" tracks playback position without re-running the async resolvers; they're merged back into the ordered list. Returns `availableItems` (context-menu checklist) + `resolvedItems` (display). Exports pure helpers `isNowPlayingItemSelected` / `formatPlays` / `formatSource` / `formatQuality` / `formatTags` / `nextCycleIndex` (unit-tested); lyrics line helpers live in `utils/lyrics.ts`. Selection persisted by App.tsx as `nowPlayingInfoSelection`.
- **useEntityDetail.ts** — Loads detail-page data (tracks/albums/sections) for a selected artist/album/tag.
- **useDetailHeroImages.ts** — Resolves the multi-image background set for `DetailHero`.
- **useArtistInfo.ts** — Artist metadata loading for the artist detail page.
- **usePlayActions.ts** — Shared play/enqueue action helpers routed through the canonical queue actions.
- **useCollectionActions.ts** — Collection CRUD/resync action handlers for `CollectionsView`.
- **useExtensions.ts** — Extension/plugin install, enable/disable, update checking for `ExtensionsView`.
- **useDependencies.ts** — External-binary dependency state (install/update/progress/check). See `backend.md` "External Binary Dependencies".
- **useVideoFrames.ts** — Video frame thumbnail caching/extraction bridge (`video_frames.rs`).
- **useMiniSearch.ts** — Mini-mode quick-search state for `MiniSearchPanel`.

## Keyboard Shortcuts

No modifier (when not in text input): Space (play/pause), arrows (seek/volume).
Cmd/Ctrl: 0 (Home), 1 (Library), 2 (History), 3 (Now Playing), K (search), F (fullscreen), L (like), P (playlist panel), M (mute), Shift+M (mini), B (sidebar), Left/Right (prev/next track).
Track list: a focusable ARIA listbox (`TrackList` — `role="listbox"`/`"option"` + `aria-activedescendant`). Tab to focus the list, then arrows / Home / End move the cursor (Shift+arrow extends selection), Space toggles selection, Enter plays, Shift+Enter enqueues. Cmd/Ctrl+A selects all, Delete removes (local), Escape clears selection.
Mini mode: any printable character (when no input is focused) opens the mini-player quick-search panel; Space/arrows remain player controls.

## State Persistence

UI state persisted via `tauri-plugin-store` to `app-state.json` in profile directory. Key states: current track + position, queue (track IDs + index + mode), volume, window geometry (full + mini separately), crossfade, auto-continue weights, view modes per entity, Extensions plugins layout (`pluginViewMode`: `"cards"` | `"list"`), skin, sort/filter per entity, section toggles, Now Playing info selection (`nowPlayingInfoSelection`). (Last.fm session/auto-import state lives in plugin storage, owned by the lastfm plugin — not the app store.) Saves debounced at 500ms. A `restoredRef` guard prevents overwriting persisted data with defaults on startup. On mount, App.tsx's restore effect reads the primary settings via `startup/readPersistedSettings.ts` (`readPersistedSettings(store)` returns a named object — no positional tuple) and then applies them to its hooks/setters. `view` and selected-entity state are intentionally NOT read/restored — startup always lands on Home.

## Scrobble Threshold

Play history / Last.fm scrobble recorded after 50% of duration or 4 minutes (whichever first). Tracks < 30 seconds are never recorded. Video tracks excluded unless "Track video history" is enabled.
