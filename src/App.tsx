import { useEffect, useState, useCallback, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

import type { Album, Collection, Track, View, ViewMode, ColumnConfig, SortField, SortDir } from "./types";
import { isVideoTrack, getInitials, parseSubsonicUrl, formatDuration } from "./utils";
import { store } from "./store";
import type { SearchProviderConfig } from "./searchProviders";
import { DEFAULT_PROVIDERS, loadProviders, saveProviders } from "./searchProviders";
import { timeAsync, getTimingEntries, type TimingEntry } from "./startupTiming";

import { usePlayback } from "./hooks/usePlayback";
import { useQueue } from "./hooks/useQueue";
import { useLibrary, DEFAULT_TRACK_COLUMNS } from "./hooks/useLibrary";
import { useEventListeners } from "./hooks/useEventListeners";
import { useImageCache } from "./hooks/useImageCache";
import { useAutoContinue } from "./hooks/useAutoContinue";
import { usePasteImage } from "./hooks/usePasteImage";
import { useNavigationHistory, type NavState } from "./hooks/useNavigationHistory";
import { useSessionLog } from "./hooks/useSessionLog";
import { useAppUpdater } from "./hooks/useAppUpdater";
import { useMiniMode } from "./hooks/useMiniMode";
import { useVideoSplit } from "./hooks/useVideoSplit";
import { useWaveform } from "./hooks/useWaveform";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { WindowControls } from "./components/WindowControls";
import { useViewSearchState } from "./hooks/useViewSearchState";
import { useCentralSearch } from "./hooks/useCentralSearch";
import { CentralSearchDropdown } from "./components/CentralSearchDropdown";
import { ViewSearchBar } from "./components/ViewSearchBar";

import { Sidebar } from "./components/Sidebar";
import { TrackList } from "./components/TrackList";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { QueuePanel } from "./components/QueuePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { FullscreenControls } from "./components/FullscreenControls";
import { AddServerModal } from "./components/AddServerModal";
import { ContextMenu } from "./components/ContextMenu";
import type { ContextMenuState } from "./components/ContextMenu";
import { Breadcrumb } from "./components/Breadcrumb";
import { AlbumCardArt } from "./components/AlbumCardArt";
import { ArtistCardArt } from "./components/ArtistCardArt";
import { TagCardArt } from "./components/TagCardArt";
import { ViewModeToggle } from "./components/ViewModeToggle";
import { ImageActions } from "./components/ImageActions";
import { HistoryView } from "./components/HistoryView";
import type { HistoryViewHandle } from "./components/HistoryView";
import { TidalView } from "./components/TidalView";
import type { TidalSearchTrack } from "./types";
import { CollectionsView } from "./components/CollectionsView";
import { EditCollectionModal } from "./components/EditCollectionModal";
import { TrackPropertiesModal } from "./components/TrackPropertiesModal";
import { UpgradeTrackModal } from "./components/UpgradeTrackModal";
import { StatusBar } from "./components/StatusBar";

const stripAccents = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function App() {
  const restoredRef = useRef(false);
  const [appRestoring, setAppRestoring] = useState(true);
  const trackListRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<HistoryViewHandle>(null);
  const previousVolumeRef = useRef(1.0);

  // Core hooks
  const peekNextRef = useRef<() => Track | null>(() => null);
  const crossfadeSecsRef = useRef(3);
  const [crossfadeSecs, setCrossfadeSecs] = useState(3);
  crossfadeSecsRef.current = crossfadeSecs;
  const trackVideoHistoryRef = useRef(false);
  const [trackVideoHistory, setTrackVideoHistory] = useState(false);
  trackVideoHistoryRef.current = trackVideoHistory;
  const advanceIndexRef = useRef<() => void>(() => {});
  const playback = usePlayback(restoredRef, peekNextRef, crossfadeSecsRef, advanceIndexRef, trackVideoHistoryRef);
  const waveformPeaks = useWaveform(
    playback.currentTrack?.id ?? null,
    playback.currentTrack?.file_size ?? null,
    playback.currentTrack?.subsonic_id ?? null,
    playback.currentTrack ? isVideoTrack(playback.currentTrack) : false,
    playback.currentAssetUrl,
  );
  const tidalStreamUrls = useRef<Map<number, string>>(new Map());
  const handlePlayWithTidal = useCallback((track: Track) => {
    const url = tidalStreamUrls.current.get(track.id);
    if (url) {
      playback.handlePlayUrl(track, url);
    } else {
      playback.handlePlay(track);
    }
  }, [playback.handlePlay, playback.handlePlayUrl]);
  const beforeNavRef = useRef<() => void>(() => {});
  const viewSearch = useViewSearchState();
  const [currentView, setCurrentView] = useState<View>("all");
  // Only pass debouncedTrackQuery for views that need server-side track search
  const needsServerSearch = currentView === "all" || currentView === "liked";
  const library = useLibrary(restoredRef, () => beforeNavRef.current(), needsServerSearch ? viewSearch.getDebouncedQuery(currentView) : "");
  const queueHook = useQueue(restoredRef, handlePlayWithTidal);
  const autoContinue = useAutoContinue(restoredRef);
  const mini = useMiniMode(restoredRef, playback.currentTrack);
  const videoSplit = useVideoSplit(restoredRef);
  // Sync currentView with library.view so debouncedTrackQuery stays up to date
  useEffect(() => { setCurrentView(library.view); }, [library.view]);

  const centralSearch = useCentralSearch({
    onPlayTrack: (track) => {
      queueHook.playTracks([track], 0);
    },
    onEnqueueTrack: (track) => {
      queueHook.enqueueTracks([track]);
    },
    onCommitSearch: (query) => {
      library.setView("all");
      library.setSelectedArtist(null);
      library.setSelectedAlbum(null);
      library.setSelectedTag(null);
      viewSearch.setQuery("all", query);
    },
  });

  peekNextRef.current = queueHook.peekNext;
  advanceIndexRef.current = queueHook.advanceIndex;

  // UI state
  const [scanning, setScanning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [scanProgress, setScanProgress] = useState({ scanned: 0, total: 0 });
  const [syncProgress, setSyncProgress] = useState({ synced: 0, total: 0, collection: "" });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showAddServer, setShowAddServer] = useState(false);
  const [deepLinkServer, setDeepLinkServer] = useState<{ url: string; username: string; password: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const { sessionLog, addLog } = useSessionLog();
  const [searchProviders, setSearchProviders] = useState<SearchProviderConfig[]>(DEFAULT_PROVIDERS);
  const [backendTimings, setBackendTimings] = useState<TimingEntry[]>([]);
  const [youtubeFeedback, setYoutubeFeedback] = useState<{
    trackId: number; url: string; videoTitle: string;
  } | null>(null);
  const [propertiesTrack, setPropertiesTrack] = useState<Track | null>(null);
  const [upgradeTrack, setUpgradeTrack] = useState<Track | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ trackIds: number[]; title: string } | null>(null);
  const [pendingEnqueue, setPendingEnqueue] = useState<{ all: Track[]; duplicates: Track[]; unique: Track[]; position?: number } | null>(null);
  const [externalDropTarget, setExternalDropTarget] = useState<number | null>(null);
  const [checkingConnectionId, setCheckingConnectionId] = useState<number | null>(null);
  const [connectionResult, setConnectionResult] = useState<{ collectionId: number; ok: boolean; message: string } | null>(null);
  const [editingCollection, setEditingCollection] = useState<Collection | null>(null);
  const [removeCollectionConfirm, setRemoveCollectionConfirm] = useState<Collection | null>(null);
  const [lastfmConnected, setLastfmConnected] = useState(false);
  const [lastfmUsername, setLastfmUsername] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const [downloadFormat, setDownloadFormat] = useState("flac");
  const [tidalEnabled, setTidalEnabled] = useState(false);
  const [tidalOverrideUrl, setTidalOverrideUrl] = useState("");
  const [downloadStatus, setDownloadStatus] = useState<{
    active: { id: number; track_title: string; artist_name: string; progress_pct: number } | null;
    queued: { id: number; track_title: string; artist_name: string }[];
    completed: { id: number; track_title: string; status: string; error?: string }[];
  } | null>(null);

  // Updater
  const updater = useAppUpdater(addLog);

  // Image caches
  const artistImageCache = useImageCache("artist", addLog);
  const albumImageCache = useImageCache("album", addLog);
  const tagImageCache = useImageCache("tag", addLog);

  // Event listeners
  useEventListeners({
    loadLibrary: library.loadLibrary,
    loadTracks: library.loadTracks,
    addLog,
    setScanning, setScanProgress,
    setSyncing, setSyncProgress,
  });

  // Download event listeners
  useEffect(() => {
    const unlisten1 = listen<{ id: number; track_title: string; artist_name: string; progress_pct: number }>(
      "download-progress",
      () => { invoke<typeof downloadStatus>("get_download_status").then(setDownloadStatus); }
    );
    const unlisten2 = listen<{ id: number; trackTitle: string; destPath: string }>(
      "download-complete",
      (event) => {
        addLog(`Downloaded: ${event.payload.trackTitle}`);
        invoke<typeof downloadStatus>("get_download_status").then(setDownloadStatus);
      }
    );
    const unlisten3 = listen<{ id: number; trackTitle: string; error: string }>(
      "download-error",
      (event) => {
        addLog(`Download error: ${event.payload.trackTitle} - ${event.payload.error}`);
        invoke<typeof downloadStatus>("get_download_status").then(setDownloadStatus);
      }
    );
    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
      unlisten3.then((f) => f());
    };
  }, []);

  const statusActivity = scanning
    ? (scanProgress.total > 0 ? `Scanning... ${scanProgress.scanned}/${scanProgress.total}` : "Scanning... preparing")

    : syncing
    ? `Syncing ${syncProgress.collection}... ${syncProgress.synced}/${syncProgress.total} albums`
    : null;

  // Paste image onto artist/album
  usePasteImage({
    view: library.view,
    selectedArtist: library.selectedArtist,
    selectedAlbum: library.selectedAlbum,
    selectedTag: library.selectedTag,
    searchQuery: viewSearch.getQuery(library.view),
    artists: library.artists,
    albums: library.albums,
    tags: library.tags,
    setArtistImages: artistImageCache.setImages,
    setAlbumImages: albumImageCache.setImages,
    setTagImages: tagImageCache.setImages,
    addLog,
  });

  const applyNavState = useCallback((s: NavState) => {
    library.setView(s.view);
    library.setSelectedArtist(s.selectedArtist);
    library.setSelectedAlbum(s.selectedAlbum);
    library.setSelectedTag(s.selectedTag);
    viewSearch.restore(s.viewSearchQueries);
    // Restore scroll position after React renders the new view
    requestAnimationFrame(() => {
      if (contentRef.current) contentRef.current.scrollTop = s.scrollTop;
    });
  }, [library.setView, library.setSelectedArtist, library.setSelectedAlbum, library.setSelectedTag, viewSearch.restore]);

  const getScrollTop = useCallback(() => contentRef.current?.scrollTop ?? 0, []);

  const { pushState, goBack, goForward, canGoBack, canGoForward } = useNavigationHistory(
    {
      view: library.view,
      selectedArtist: library.selectedArtist,
      selectedAlbum: library.selectedAlbum,
      selectedTag: library.selectedTag,
      viewSearchQueries: viewSearch.snapshot(),
    },
    applyNavState,
    getScrollTop,
  );

  // Push history and reset scroll for the new view.
  // Used by all navigation triggers (sidebar, keyboard, click handlers).
  const pushAndScroll = useCallback(() => {
    pushState();
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [pushState]);
  beforeNavRef.current = pushAndScroll;

  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;
  const goForwardRef = useRef(goForward);
  goForwardRef.current = goForward;
  const pushStateRef = useRef(pushAndScroll);
  pushStateRef.current = pushAndScroll;

  // Disable default browser context menu globally
  useEffect(() => {
    const handler = (e: MouseEvent) => { e.preventDefault(); };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  // Listen for deep link events (subsonic:// URLs)
  useEffect(() => {
    function handleDeepLink(urls: string[]) {
      for (const raw of urls) {
        // Handle Last.fm callback
        if (raw.startsWith("viboplr://lastfm-callback")) {
          try {
            const url = new URL(raw);
            const token = url.searchParams.get("token");
            if (token) {
              invoke<[{ connected: boolean; username: string | null }, string]>("lastfm_authenticate", { token })
                .then(async ([status, sessionKey]) => {
                  setLastfmConnected(status.connected);
                  setLastfmUsername(status.username ?? null);
                  await store.set("lastfmSessionKey", sessionKey);
                  await store.set("lastfmUsername", status.username);
                })
                .catch((e: unknown) => console.error("Last.fm auth failed:", e));
            }
          } catch (e) {
            console.error("Failed to parse Last.fm callback URL:", e);
          }
          break;
        }
        // Handle Subsonic deep links
        const parsed = parseSubsonicUrl(raw);
        if (parsed) {
          setDeepLinkServer({ url: parsed.serverUrl, username: parsed.username, password: parsed.password });
          setShowAddServer(true);
          break;
        }
      }
    }
    const unlistenOpen = onOpenUrl(handleDeepLink);
    const unlistenEvent = listen<string>("deep-link-received", (event) => {
      handleDeepLink([event.payload]);
    });
    return () => {
      unlistenOpen.then(f => f());
      unlistenEvent.then(f => f());
    };
  }, []);

  // Restore persisted state on mount
  useEffect(() => {
    (async () => {
      try {
        await timeAsync("store.init", () => store.init());
        const [v, sa, sal, st, tid, vol, qIds, qIdx, qMode, pos, cf, savedTrackVideoHistory, wasMini, fww, fwh, fwx, fwy, tSortField, tSortDir, tCols, wasShowQueue, savedPlaylistName, savedArtistViewMode, savedAlbumViewMode, savedTagViewMode, savedTrackViewMode, savedLikedViewMode, savedVideoSplitHeight, savedLastfmSessionKey, savedLastfmUsername, savedSidebarCollapsed, savedQueueCollapsed, savedDownloadFormat, savedTidalEnabled, savedTidalOverrideUrl, savedSortBarCollapsed] = await timeAsync("store.restore (36 keys)", () => Promise.all([
          store.get<string>("view"),
          store.get<number | null>("selectedArtist"),
          store.get<number | null>("selectedAlbum"),
          store.get<number | null>("selectedTag"),
          store.get<number | null>("currentTrackId"),
          store.get<number>("volume"),
          store.get<number[]>("queueTrackIds"),
          store.get<number>("queueIndex"),
          store.get<string>("queueMode"),
          store.get<number>("positionSecs"),
          store.get<number>("crossfadeSecs"),
          store.get<boolean>("trackVideoHistory"),
          store.get<boolean>("miniMode"),
          store.get<number | null>("fullWindowWidth"),
          store.get<number | null>("fullWindowHeight"),
          store.get<number | null>("fullWindowX"),
          store.get<number | null>("fullWindowY"),
          store.get<string | null>("trackSortField"),
          store.get<string>("trackSortDir"),
          store.get<ColumnConfig[] | null>("trackColumns"),
          store.get<boolean>("showQueue"),
          store.get<string | null>("playlistName"),
          store.get<string | null>("artistViewMode"),
          store.get<string | null>("albumViewMode"),
          store.get<string | null>("tagViewMode"),
          store.get<string | null>("trackViewMode"),
          store.get<string | null>("likedViewMode"),
          store.get<number | null>("videoSplitHeight"),
          store.get<string | null>("lastfmSessionKey"),
          store.get<string | null>("lastfmUsername"),
          store.get<boolean>("sidebarCollapsed"),
          store.get<boolean>("queueCollapsed"),
          store.get<string | null>("downloadFormat"),
          store.get<boolean>("tidalEnabled"),
          store.get<string | null>("tidalOverrideUrl"),
          store.get<boolean>("sortBarCollapsed"),
        ]));
        if (v && ["all", "artists", "albums", "tags", "liked", "history", "tidal"].includes(v)) library.setView(v as View);
        if (sa !== undefined && sa !== null) {
          library.setSelectedArtist(sa);
        }
        if (sal !== undefined && sal !== null) library.setSelectedAlbum(sal);
        if (st !== undefined && st !== null) library.setSelectedTag(st);
        if (vol !== undefined && vol !== null) playback.setVolume(vol);
        if (cf !== undefined && cf !== null) setCrossfadeSecs(cf);
        if (savedTrackVideoHistory) setTrackVideoHistory(true);
        if (savedLastfmSessionKey && savedLastfmUsername) {
          setLastfmConnected(true);
          setLastfmUsername(savedLastfmUsername);
          invoke("lastfm_set_session", { sessionKey: savedLastfmSessionKey, username: savedLastfmUsername }).catch(console.error);
        }
        if (tSortField && ["num", "title", "artist", "album", "duration", "path", "year", "quality", "size", "collection", "added", "modified", "random"].includes(tSortField)) library.setSortField(tSortField as SortField);
        if (tSortDir && ["asc", "desc"].includes(tSortDir)) library.setSortDir(tSortDir as SortDir);
        if (tCols && Array.isArray(tCols) && tCols.length > 0) {
          // Merge in any new columns that weren't in the saved config
          const savedIds = new Set(tCols.map((c: ColumnConfig) => c.id));
          const missing = DEFAULT_TRACK_COLUMNS.filter(c => !savedIds.has(c.id));
          library.setTrackColumns([...tCols, ...missing]);
        }
        const [restoredTrack, restoredTracks, trackPath] = await timeAsync("restore IPC (track/queue/path)", () => Promise.all([
          tid ? invoke<Track>("get_track_by_id", { trackId: tid }).catch(() => null) : Promise.resolve(null),
          qIds?.length ? invoke<Track[]>("get_tracks_by_ids", { ids: qIds }).catch(() => []) : Promise.resolve([]),
          tid ? invoke<string>("get_track_path", { trackId: tid }).catch(() => null) : Promise.resolve(null),
        ]));
        if (restoredTrack && trackPath) await timeAsync("playback.handleRestore", () => playback.handleRestore(restoredTrack, pos ?? 0, trackPath));
        if (restoredTracks && restoredTracks.length) {
          queueHook.setQueue(restoredTracks);
          const idx = qIdx ?? -1;
          queueHook.setQueueIndex(idx >= 0 && idx < restoredTracks.length ? idx : -1);
        }
        if (qMode && ["normal", "loop", "shuffle"].includes(qMode)) {
          queueHook.setQueueMode(qMode as "normal" | "loop" | "shuffle");
        }
        if (wasShowQueue) queueHook.setShowQueue(true);
        if (savedPlaylistName) queueHook.setPlaylistName(savedPlaylistName);
        if (savedArtistViewMode && ["basic", "list", "tiles"].includes(savedArtistViewMode)) library.setArtistViewMode(savedArtistViewMode as ViewMode);
        if (savedAlbumViewMode && ["basic", "list", "tiles"].includes(savedAlbumViewMode)) library.setAlbumViewMode(savedAlbumViewMode as ViewMode);
        if (savedTagViewMode && ["basic", "list", "tiles"].includes(savedTagViewMode)) library.setTagViewMode(savedTagViewMode as ViewMode);
        if (savedTrackViewMode && ["basic", "list", "tiles"].includes(savedTrackViewMode)) library.setTrackViewMode(savedTrackViewMode as ViewMode);
        if (savedLikedViewMode && ["basic", "list", "tiles"].includes(savedLikedViewMode)) library.setLikedViewMode(savedLikedViewMode as ViewMode);
        if (savedVideoSplitHeight && savedVideoSplitHeight > 0) videoSplit.setVideoHeight(savedVideoSplitHeight);
        if (savedSidebarCollapsed) setSidebarCollapsed(true);
        if (savedQueueCollapsed) setQueueCollapsed(true);
        if (savedDownloadFormat && ["flac", "aac", "mp3"].includes(savedDownloadFormat)) setDownloadFormat(savedDownloadFormat);
        if (savedTidalEnabled) setTidalEnabled(true);
        if (savedTidalOverrideUrl) setTidalOverrideUrl(savedTidalOverrideUrl);
        if (savedSortBarCollapsed) library.setSortBarCollapsed(true);
        await timeAsync("window.restore", async () => {
          // Size/position already restored by Rust setup — just set React state and show
          if (wasMini) {
            if (fww && fwh) mini.fullSizeRef.current = { w: fww, h: fwh, x: fwx ?? 0, y: fwy ?? 0 };
            mini.setMiniMode(true);
            mini.miniModeRef.current = true;
          }
          await getCurrentWindow().show();
        });
      } catch (e) {
        console.error("Failed to restore state:", e);
        await getCurrentWindow().show();
      }
      await timeAsync("loadProviders", () => loadProviders(store).then(setSearchProviders));
      restoredRef.current = true;
      setAppRestoring(false);
      await timeAsync("loadLibrary", () => library.loadLibrary());
    })();
  }, []);

  useEffect(() => {
    const unlisten = listen("lastfm-auth-error", async () => {
      setLastfmConnected(false);
      setLastfmUsername(null);
      await store.set("lastfmSessionKey", null);
      await store.set("lastfmUsername", null);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  // Fetch images for selected entities
  useEffect(() => {
    if (library.selectedArtist === null) return;
    const artist = library.artists.find(a => a.id === library.selectedArtist);
    if (artist) artistImageCache.fetchOnDemand(artist);
  }, [library.selectedArtist, library.artists]);

  useEffect(() => {
    if (library.selectedAlbum === null) return;
    const album = library.albums.find(a => a.id === library.selectedAlbum);
    if (album) albumImageCache.fetchOnDemand(album);
  }, [library.selectedAlbum, library.albums]);

  useEffect(() => {
    if (library.selectedTag === null) return;
    tagImageCache.fetchOnDemand({ id: library.selectedTag });
  }, [library.selectedTag]);

  // Fetch album/artist image when current track changes (for Now Playing bar)
  useEffect(() => {
    const track = playback.currentTrack;
    if (!track) return;
    if (track.album_id) albumImageCache.fetchOnDemand({ id: track.album_id, title: track.album_title ?? "", artist_name: track.artist_name });
    if (track.artist_id) artistImageCache.fetchOnDemand({ id: track.artist_id, name: track.artist_name ?? "Unknown" });
  }, [playback.currentTrack]);

  // Ref for keyboard shortcut handler to avoid stale closures
  const shortcutStateRef = useRef({
    volume: playback.volume,
    showQueue: queueHook.showQueue,
    getMediaElement: playback.getMediaElement,
    handleSeek: playback.handleSeek,
    currentTrack: playback.currentTrack,
  });
  shortcutStateRef.current = {
    volume: playback.volume,
    showQueue: queueHook.showQueue,
    getMediaElement: playback.getMediaElement,
    handleSeek: playback.handleSeek,
    currentTrack: playback.currentTrack,
  };
  const handleToggleLikeRef = useRef((_track: Track) => {});

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const s = shortcutStateRef.current;
      const isInput = (e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA";

      // Alt+Arrow: navigation history
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === "ArrowLeft") { e.preventDefault(); goBackRef.current(); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); goForwardRef.current(); return; }
      }

      // Non-modifier shortcuts (only when not typing in an input)
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !isInput) {
        switch (e.key) {
          case " ":
            e.preventDefault();
            playback.handlePause();
            return;
          case "ArrowLeft": {
            e.preventDefault();
            const el = s.getMediaElement();
            if (el) s.handleSeek(Math.max(0, el.currentTime - 15));
            return;
          }
          case "ArrowRight": {
            e.preventDefault();
            const el = s.getMediaElement();
            if (el) s.handleSeek(Math.min(el.duration || 0, el.currentTime + 15));
            return;
          }
          case "ArrowUp":
            e.preventDefault();
            playback.handleVolume(Math.min(1, s.volume + 0.1));
            return;
          case "ArrowDown":
            e.preventDefault();
            playback.handleVolume(Math.max(0, s.volume - 0.1));
            return;
          case "/":
            e.preventDefault();
            searchInputRef.current?.focus();
            return;
        }
      }

      if (!(e.ctrlKey || e.metaKey)) return;

      // Cmd/Ctrl+K: focus central search
      if (e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      switch (e.key) {
        case "1":
          e.preventDefault();
          library.handleShowAll();
          break;
        case "2":
          e.preventDefault();
          pushStateRef.current();
          library.setView("artists");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          break;
        case "3":
          e.preventDefault();
          pushStateRef.current();
          library.setView("albums");
          library.setSelectedArtist(null);
          library.setSelectedTag(null);
          break;
        case "4":
          e.preventDefault();
          pushStateRef.current();
          library.setView("tags");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          break;
        case "5":
          e.preventDefault();
          library.handleShowLiked();
          break;
        case "6":
          e.preventDefault();
          pushStateRef.current();
          library.setView("history");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          break;
        case "f":
          if (s.currentTrack && isVideoTrack(s.currentTrack)) {
            e.preventDefault();
            playback.toggleFullscreen();
          }
          break;
        case "l":
          e.preventDefault();
          if (s.currentTrack) handleToggleLikeRef.current(s.currentTrack);
          break;
        case "p":
          e.preventDefault();
          queueHook.setShowQueue(!s.showQueue);
          break;
        case "m":
          e.preventDefault();
          if (s.volume > 0) {
            previousVolumeRef.current = s.volume;
            playback.handleVolume(0);
          } else {
            playback.handleVolume(previousVolumeRef.current || 1.0);
          }
          break;
        case "M":
          e.preventDefault();
          mini.toggleMiniMode();
          break;
        case "ArrowLeft":
          e.preventDefault();
          queueHook.playPrevious();
          break;
        case "ArrowRight":
          e.preventDefault();
          handleNext();
          break;
        case "b":
          e.preventDefault();
          handleToggleSidebar();
          break;
        case "[":
          e.preventDefault();
          goBackRef.current();
          break;
        case "]":
          e.preventDefault();
          goForwardRef.current();
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Mouse side buttons for navigation history
  useEffect(() => {
    function handleMouseUp(e: MouseEvent) {
      if (e.button === 3) { e.preventDefault(); goBackRef.current(); }
      if (e.button === 4) { e.preventDefault(); goForwardRef.current(); }
    }
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  // onEnded handler — uses refs to avoid stale closures from useCallback([])
  const autoContinueRef = useRef(autoContinue);
  autoContinueRef.current = autoContinue;
  const currentTrackRef = useRef(playback.currentTrack);
  currentTrackRef.current = playback.currentTrack;
  const handleStopRef = useRef(playback.handleStop);
  handleStopRef.current = playback.handleStop;

  const handleNext = useCallback(async () => {
    if (!queueHook.playNext()) {
      const ac = autoContinueRef.current;
      const track = currentTrackRef.current;
      if (ac.enabled && track) {
        const next = await ac.fetchTrack(track);
        if (next) {
          queueHook.addToQueueAndPlay(next);
          return;
        }
      }
      handleStopRef.current();
    }
  }, []);

  useGlobalShortcuts({
    togglePlayPause: playback.handlePause,
    playNext: () => handleNext(),
    playPrevious: () => queueHook.playPrevious(),
    stop: playback.handleStop,
  });

  const onEnded = useCallback(async () => {
    if (playback.handleGaplessNext()) {
      queueHook.advanceIndex();
      return;
    }
    handleNext();
  }, []);

  useEffect(() => {
    const video = playback.videoRef.current;
    if (video) {
      video.addEventListener("ended", onEnded);
    }
    return () => {
      if (video) video.removeEventListener("ended", onEnded);
    };
  }, [onEnded]);

  // Action handlers
  function handleTrackContextMenu(e: React.MouseEvent, track: Track, selectedTrackIds: Set<number>) {
    e.preventDefault();
    if (selectedTrackIds.size > 1) {
      setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "multi-track", trackIds: [...selectedTrackIds] } });
    } else {
      setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "track", trackId: track.id, subsonic: !!track.subsonic_id, title: track.title, artistName: track.artist_name } });
    }
  }

  function handleAlbumContextMenu(e: React.MouseEvent, albumId: number) {
    e.preventDefault();
    const album = albums.find(a => a.id === albumId);
    setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "album", albumId, title: album?.title ?? "", artistName: album?.artist_name ?? null } });
  }

  function handleArtistContextMenu(e: React.MouseEvent, artistId: number) {
    e.preventDefault();
    const artist = artists.find(a => a.id === artistId);
    setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "artist", artistId, name: artist?.name ?? "" } });
  }

  async function handleContextPlay() {
    if (!contextMenu) return;
    const { target } = contextMenu;
    if (target.kind === "track") {
      const track = tracks.find(t => t.id === target.trackId);
      if (track) queueHook.playTracks([track], 0);
    } else if (target.kind === "album") {
      const albumTracks = await invoke<Track[]>("get_tracks", { albumId: target.albumId });
      if (albumTracks.length > 0) queueHook.playTracks(albumTracks, 0);
    } else if (target.kind === "artist") {
      const artistTracks = await invoke<Track[]>("get_tracks_by_artist", { artistId: target.artistId });
      if (artistTracks.length > 0) queueHook.playTracks(artistTracks, 0);
    } else if (target.kind === "multi-track") {
      const idSet = new Set(target.trackIds);
      const selected = sortedTracks.filter(t => idSet.has(t.id));
      if (selected.length > 0) queueHook.playTracks(selected, 0);
    } else if (target.kind === "queue-multi") {
      const selected = target.indices.map(i => queueHook.queue[i]).filter(Boolean);
      if (selected.length > 0) queueHook.playTracks(selected, 0);
    }
  }

  function handleEnqueue(tracks: Track[]) {
    if (tracks.length === 0) return;
    const { duplicates, unique } = queueHook.findDuplicates(tracks);
    if (duplicates.length > 0) {
      setPendingEnqueue({ all: tracks, duplicates, unique });
      if (!queueHook.showQueue) queueHook.setShowQueue(true);
    } else {
      queueHook.enqueueTracks(tracks);
    }
  }

  async function handleContextEnqueue() {
    if (!contextMenu) return;
    const { target } = contextMenu;
    if (target.kind === "track") {
      const track = tracks.find(t => t.id === target.trackId);
      if (track) handleEnqueue([track]);
    } else if (target.kind === "album") {
      const albumTracks = await invoke<Track[]>("get_tracks", { albumId: target.albumId });
      handleEnqueue(albumTracks);
    } else if (target.kind === "artist") {
      const artistTracks = await invoke<Track[]>("get_tracks_by_artist", { artistId: target.artistId });
      handleEnqueue(artistTracks);
    } else if (target.kind === "multi-track") {
      const idSet = new Set(target.trackIds);
      const selected = sortedTracks.filter(t => idSet.has(t.id));
      handleEnqueue(selected);
    }
  }

  function handleQueueRemove() {
    if (!contextMenu || contextMenu.target.kind !== "queue-multi") return;
    queueHook.removeMultiple(contextMenu.target.indices);
  }

  function handleQueueMoveToTop() {
    if (!contextMenu || contextMenu.target.kind !== "queue-multi") return;
    queueHook.moveToTop(contextMenu.target.indices);
  }

  function handleQueueMoveToBottom() {
    if (!contextMenu || contextMenu.target.kind !== "queue-multi") return;
    queueHook.moveToBottom(contextMenu.target.indices);
  }

  function handleTrackDragStart(dragTracks: Track[]) {
    let ghost: HTMLDivElement | null = null;
    const dropTargetRef = { current: null as number | null };

    function findQueueIndex(el: Element | null): number | null {
      while (el) {
        const idx = el.getAttribute("data-queue-index");
        if (idx !== null) return parseInt(idx, 10);
        el = el.parentElement;
      }
      return null;
    }

    function onMouseMove(ev: MouseEvent) {
      if (!ghost) {
        ghost = document.createElement("div");
        ghost.className = "queue-drag-ghost";
        ghost.textContent = `${dragTracks.length} track${dragTracks.length > 1 ? "s" : ""}`;
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${ev.clientX + 12}px`;
      ghost.style.top = `${ev.clientY - 10}px`;

      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const queuePanel = target?.closest(".queue-panel");
      if (queuePanel) {
        const overIndex = findQueueIndex(target);
        if (overIndex !== null) {
          const el = target!.closest("[data-queue-index]") as HTMLElement | null;
          if (el) {
            const rect = el.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const dt = ev.clientY < midY ? overIndex : overIndex + 1;
            dropTargetRef.current = dt;
            setExternalDropTarget(dt);
          }
        } else {
          // Over queue panel but not on an item — drop at end
          dropTargetRef.current = queueHook.queue.length;
          setExternalDropTarget(queueHook.queue.length);
        }
      } else {
        dropTargetRef.current = null;
        setExternalDropTarget(null);
      }
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (ghost) { ghost.remove(); ghost = null; }

      if (dropTargetRef.current !== null) {
        const pos = dropTargetRef.current;
        const { duplicates, unique } = queueHook.findDuplicates(dragTracks);
        if (duplicates.length > 0) {
          setPendingEnqueue({ all: dragTracks, duplicates, unique, position: pos });
          if (!queueHook.showQueue) queueHook.setShowQueue(true);
        } else {
          queueHook.insertAtPosition(dragTracks, pos);
          if (!queueHook.showQueue) queueHook.setShowQueue(true);
        }
      }

      setExternalDropTarget(null);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  function handleShowInFolder() {
    if (contextMenu && contextMenu.target.kind === "track") {
      invoke("show_in_folder", { trackId: contextMenu.target.trackId });
      setContextMenu(null);
    }
  }

  function handleShowProperties() {
    if (!contextMenu || contextMenu.target.kind !== "track") return;
    const { trackId } = contextMenu.target;
    const track = library.tracks.find(t => t.id === trackId);
    if (track) setPropertiesTrack(track);
    setContextMenu(null);
  }

  function handleDeleteRequest() {
    if (!contextMenu) return;
    const { target } = contextMenu;
    if (target.kind === "track" && !target.subsonic) {
      setDeleteConfirm({ trackIds: [target.trackId], title: target.title });
    } else if (target.kind === "multi-track") {
      setDeleteConfirm({ trackIds: target.trackIds, title: `${target.trackIds.length} tracks` });
    }
    setContextMenu(null);
  }

  async function handleDeleteConfirm() {
    if (!deleteConfirm) return;
    try {
      const deletedIds: number[] = await invoke("delete_tracks", { trackIds: deleteConfirm.trackIds });
      const deletedSet = new Set(deletedIds);
      library.setTracks(prev => prev.filter(t => !deletedSet.has(t.id)));
      if (playback.currentTrack && deletedSet.has(playback.currentTrack.id)) {
        playback.handleStop();
      }
    } catch (e) {
      console.error("Failed to delete tracks:", e);
    }
    setDeleteConfirm(null);
  }

  async function handleWatchOnYoutube() {
    if (!contextMenu || contextMenu.target.kind !== "track") return;
    const { trackId, title, artistName } = contextMenu.target;

    // Use saved URL if available
    const track = tracks.find(t => t.id === trackId);
    if (track?.youtube_url) {
      await openUrl(track.youtube_url);
      addLog(`Opened YouTube: ${title}`);
      return;
    }

    addLog("Searching YouTube...");
    try {
      const result = await invoke<{ url: string; video_title: string | null }>(
        "search_youtube", { title, artistName }
      );
      await openUrl(result.url);
      addLog(`Opened YouTube: ${result.video_title ?? title}`);
      setYoutubeFeedback({ trackId, url: result.url, videoTitle: result.video_title ?? title });
    } catch {
      const q = encodeURIComponent(`${title} ${artistName ?? ""}`);
      await openUrl(`https://www.youtube.com/results?search_query=${q}`);
      addLog("YouTube search failed, opened search results");
    }
  }

  async function handleYoutubeFeedback(correct: boolean) {
    if (!youtubeFeedback) return;
    if (correct) {
      await invoke("set_track_youtube_url", {
        trackId: youtubeFeedback.trackId,
        url: youtubeFeedback.url,
      });
      library.setTracks(prev => prev.map(t => t.id === youtubeFeedback.trackId ? { ...t, youtube_url: youtubeFeedback.url } : t));
      addLog("Saved YouTube link for future use");
    }
    setYoutubeFeedback(null);
  }

  async function handleAddFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      const folderName = selected.split("/").pop() || selected.split("\\").pop() || selected;
      setScanning(true);
      setScanProgress({ scanned: 0, total: 0 });
      addLog("Adding folder: " + folderName);
      await invoke("add_collection", { kind: "local", name: folderName, path: selected });
      library.loadLibrary();
    }
  }


  async function handleSeedDatabase() {
    try {
      await invoke("add_collection", { kind: "seed", name: "Test Data" });
      await library.loadLibrary();
      await library.loadTracks();
    } catch (e) {
      console.error("Seed error:", e);
    }
  }

  async function handleClearDatabase() {
    setClearing(true);
    try {
      await invoke("clear_database", {});
      await library.loadLibrary();
      await library.loadTracks();
    } catch (e) {
      console.error("Clear database error:", e);
    } finally {
      setClearing(false);
    }
  }

  async function handleClearImageFailures() {
    try {
      await invoke("clear_image_failures");
      artistImageCache.clearAllFailures();
      albumImageCache.clearAllFailures();
      addLog("Cleared image fetch failures");
    } catch (e) {
      console.error("Failed to clear image failures:", e);
    }
  }

  function handleSaveProviders(providers: SearchProviderConfig[]) {
    setSearchProviders(providers);
    saveProviders(store, providers);
  }

  function handleCrossfadeChange(secs: number) {
    setCrossfadeSecs(secs);
    store.set("crossfadeSecs", secs);
  }

  function handleTrackVideoHistoryChange(enabled: boolean) {
    setTrackVideoHistory(enabled);
    store.set("trackVideoHistory", enabled);
  }

  function handleDownloadFormatChange(format: string) {
    setDownloadFormat(format);
    store.set("downloadFormat", format);
  }

  function handleTidalEnabledChange(enabled: boolean) {
    setTidalEnabled(enabled);
    store.set("tidalEnabled", enabled);
  }

  function handleTidalOverrideUrlChange(url: string) {
    setTidalOverrideUrl(url);
    store.set("tidalOverrideUrl", url);
  }

  async function handleDownloadAlbum(albumId: string, destCollectionId: number) {
    try {
      const ids = await invoke<number[]>("download_album", {
        overrideUrl: tidalOverrideUrl || null,
        albumId,
        destCollectionId,
        format: downloadFormat,
      });
      addLog(`Queued ${ids.length} tracks for download`);
    } catch (e) {
      addLog(`Album download failed: ${e}`);
    }
  }

  async function handleTidalDownloadTrack(tidalTrackId: string, destCollectionId: number) {
    try {
      await invoke<number>("tidal_save_track", {
        overrideUrl: tidalOverrideUrl || null,
        tidalTrackId,
        destCollectionId,
        format: downloadFormat,
      });
      addLog(`Queued track for download`);
    } catch (e) {
      addLog(`Track download failed: ${e}`);
    }
  }

  const tidalIdCounter = useRef(-1);

  function tidalTrackToTrack(info: TidalSearchTrack): Track {
    const id = tidalIdCounter.current--;
    return {
      id,
      path: "",
      title: info.title,
      artist_id: null,
      artist_name: info.artist_name,
      album_id: null,
      album_title: info.album_title,
      year: null,
      track_number: info.track_number,
      duration_secs: info.duration_secs,
      format: null,
      file_size: null,
      collection_id: null,
      collection_name: null,
      subsonic_id: info.tidal_id,
      liked: 0,
      youtube_url: null,
      added_at: null,
      modified_at: null,
    };
  }

  async function handleTidalPlay(tidalTrackId: string, trackInfo: TidalSearchTrack) {
    try {
      const streamUrl = await invoke<string>("tidal_get_stream_url", {
        overrideUrl: tidalOverrideUrl || null,
        tidalTrackId,
        quality: null,
      });
      const track = tidalTrackToTrack(trackInfo);
      tidalStreamUrls.current.set(track.id, streamUrl);
      queueHook.playTracks([track], 0);
    } catch (e) {
      addLog(`TIDAL playback failed: ${e}`);
    }
  }

  async function handleTidalEnqueue(tidalTrackId: string, trackInfo: TidalSearchTrack) {
    try {
      const streamUrl = await invoke<string>("tidal_get_stream_url", {
        overrideUrl: tidalOverrideUrl || null,
        tidalTrackId,
        quality: null,
      });
      const track = tidalTrackToTrack(trackInfo);
      tidalStreamUrls.current.set(track.id, streamUrl);
      queueHook.enqueueTracks([track]);
    } catch (e) {
      addLog(`TIDAL enqueue failed: ${e}`);
    }
  }

  async function handleDownloadTrack(trackId: number, destCollectionId: number) {
    const track = tracks.find(t => t.id === trackId);
    if (!track?.subsonic_id || !track.collection_id) return;
    try {
      await invoke("download_track", {
        sourceCollectionId: track.collection_id,
        remoteTrackId: track.subsonic_id,
        destCollectionId,
        format: downloadFormat,
      });
      addLog(`Downloading: ${track.title}`);
    } catch (e) {
      addLog(`Download failed: ${e}`);
    }
  }

  function handleCaptionDoubleClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input")) return;
    getCurrentWindow().toggleMaximize();
  }

  function handleToggleSidebar() {
    setSidebarCollapsed(prev => {
      const next = !prev;
      store.set("sidebarCollapsed", next);
      return next;
    });
  }

  function handleToggleQueueCollapsed() {
    setQueueCollapsed(prev => {
      const next = !prev;
      store.set("queueCollapsed", next);
      return next;
    });
  }

  async function handleLastfmConnect() {
    try {
      const url = await invoke<string>("lastfm_get_auth_url");
      await openUrl(url);
    } catch (e) {
      console.error("Failed to get Last.fm auth URL:", e);
    }
  }

  async function handleLastfmDisconnect() {
    await invoke("lastfm_disconnect").catch(console.error);
    setLastfmConnected(false);
    setLastfmUsername(null);
    await store.set("lastfmSessionKey", null);
    await store.set("lastfmUsername", null);
  }

  async function handleResyncCollection(collectionId: number) {
    await invoke("resync_collection", { collectionId });
  }

  async function handleToggleCollectionEnabled(collection: Collection) {
    await invoke("update_collection", {
      collectionId: collection.id,
      name: collection.name,
      autoUpdate: collection.auto_update,
      autoUpdateIntervalMins: collection.auto_update_interval_mins,
      enabled: !collection.enabled,
    });
    library.loadLibrary();
    library.loadTracks();
  }

  async function handleCheckConnection(collectionId: number) {
    setCheckingConnectionId(collectionId);
    setConnectionResult(null);
    try {
      const msg = await invoke<string>("test_collection_connection", { collectionId });
      setConnectionResult({ collectionId, ok: true, message: msg });
    } catch (e) {
      setConnectionResult({ collectionId, ok: false, message: String(e) });
    } finally {
      setCheckingConnectionId(null);
      library.loadLibrary();
      setTimeout(() => setConnectionResult(null), 5000);
    }
  }

  async function handleSaveCollection(id: number, name: string, autoUpdate: boolean, autoUpdateIntervalMins: number, enabled: boolean) {
    await invoke("update_collection", {
      collectionId: id,
      name,
      autoUpdate,
      autoUpdateIntervalMins,
      enabled,
    });
    setEditingCollection(null);
    library.loadLibrary();
    library.loadTracks();
  }

  async function handleRemoveCollectionConfirm() {
    if (!removeCollectionConfirm) return;
    try {
      await invoke("remove_collection", { collectionId: removeCollectionConfirm.id });
      if (playback.currentTrack && playback.currentTrack.collection_id === removeCollectionConfirm.id) {
        playback.handleStop();
      }
      queueHook.setQueue(prev => prev.filter(t => t.collection_id !== removeCollectionConfirm.id));
      library.loadLibrary();
      library.loadTracks();
    } catch (e) {
      console.error("Failed to remove collection:", e);
    }
    setRemoveCollectionConfirm(null);
  }

  async function handleToggleLike(track: Track) {
    const newLiked = track.liked === 1 ? 0 : 1;
    try {
      await invoke("toggle_liked", { kind: "track", id: track.id, liked: newLiked });
      library.setTracks(prev => prev.map(t => t.id === track.id ? { ...t, liked: newLiked } : t));
      if (playback.currentTrack?.id === track.id) {
        playback.setCurrentTrack({ ...playback.currentTrack, liked: newLiked });
      }
      queueHook.setQueue(prev => prev.map(t => t.id === track.id ? { ...t, liked: newLiked } : t));
    } catch (e) {
      console.error("Failed to toggle like:", e);
    }
  }

  async function handleToggleDislike(track: Track) {
    const newLiked = track.liked === -1 ? 0 : -1;
    try {
      await invoke("toggle_liked", { kind: "track", id: track.id, liked: newLiked });
      library.setTracks(prev => prev.map(t => t.id === track.id ? { ...t, liked: newLiked } : t));
      if (playback.currentTrack?.id === track.id) {
        playback.setCurrentTrack({ ...playback.currentTrack, liked: newLiked });
      }
      queueHook.setQueue(prev => prev.map(t => t.id === track.id ? { ...t, liked: newLiked } : t));
    } catch (e) {
      console.error("Failed to toggle dislike:", e);
    }
  }
  handleToggleLikeRef.current = handleToggleLike;

  async function handleToggleArtistLike(artistId: number) {
    const artist = artists.find(a => a.id === artistId);
    if (!artist) return;
    const newLiked = artist.liked === 1 ? 0 : 1;
    try {
      await invoke("toggle_liked", { kind: "artist", id: artistId, liked: newLiked });
      library.setArtists(prev => prev.map(a => a.id === artistId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle artist like:", e);
    }
  }

  async function handleToggleAlbumLike(albumId: number) {
    const album = albums.find(a => a.id === albumId);
    if (!album) return;
    const newLiked = album.liked === 1 ? 0 : 1;
    try {
      await invoke("toggle_liked", { kind: "album", id: albumId, liked: newLiked });
      library.setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle album like:", e);
    }
  }

  async function handleToggleTagLike(tagId: number) {
    const tag = tags.find(t => t.id === tagId);
    if (!tag) return;
    const newLiked = tag.liked === 1 ? 0 : 1;
    try {
      await invoke("toggle_liked", { kind: "tag", id: tagId, liked: newLiked });
      library.setTags(prev => prev.map(t => t.id === tagId ? { ...t, liked: newLiked } : t));
    } catch (e) {
      console.error("Failed to toggle tag like:", e);
    }
  }

  const { view, selectedArtist, selectedAlbum, selectedTag, artists, albums, tags, tracks,
    sortedTracks, sortField, highlightedIndex, highlightedListIndex } = library;

  // Filtered lists for keyboard navigation
  const filteredArtists = (() => {
    if (view !== "artists" || selectedArtist !== null) return [];
    const q = viewSearch.getQuery("artists").trim().toLowerCase();
    return q ? library.sortedArtists.filter(a => stripAccents(a.name.toLowerCase()).includes(stripAccents(q))) : library.sortedArtists;
  })();

  const filteredAlbums = (() => {
    if (view !== "albums") return [];
    const q = viewSearch.getQuery("albums").trim().toLowerCase();
    if (!q) return library.sortedAlbums;
    const sq = stripAccents(q);
    return library.sortedAlbums.filter(a =>
      stripAccents(a.title.toLowerCase()).includes(sq) ||
      (a.artist_name ? stripAccents(a.artist_name.toLowerCase()).includes(sq) : false)
    );
  })();

  const filteredTags = (() => {
    if (view !== "tags" || selectedTag !== null) return [];
    const q = viewSearch.getQuery("tags").trim().toLowerCase();
    return q ? library.sortedTags.filter(t => stripAccents(t.name.toLowerCase()).includes(stripAccents(q))) : library.sortedTags;
  })();

  const hasTidal = tidalEnabled;
  const localCollections = library.collections.filter(c => c.kind === "local" && c.enabled).map(c => ({ id: c.id, name: c.name }));

  return (
    <div className={`app ${appRestoring ? "app-restoring" : ""} ${playback.currentTrack && isVideoTrack(playback.currentTrack) ? "video-mode" : ""} ${queueHook.showQueue ? "queue-open" : ""} ${queueCollapsed ? "queue-collapsed" : ""} ${mini.miniMode ? "mini-mode" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} onClick={() => setContextMenu(null)}>
      {/* Hidden audio elements (A/B for gapless playback) */}
      <audio
        ref={playback.audioRefA}
        onTimeUpdate={playback.onTimeUpdate}
        onLoadedMetadata={playback.onLoadedMetadata}
        onPlay={playback.onPlaySlotA}
        onPause={playback.onPauseSlotA}
        onEnded={() => playback.onEndedSlotA(onEnded)}
        onError={playback.onMediaError}
      />
      <audio
        ref={playback.audioRefB}
        onTimeUpdate={playback.onTimeUpdate}
        onLoadedMetadata={playback.onLoadedMetadata}
        onPlay={playback.onPlaySlotB}
        onPause={playback.onPauseSlotB}
        onEnded={() => playback.onEndedSlotB(onEnded)}
        onError={playback.onMediaError}
      />

      <Sidebar
        view={view}
        selectedAlbum={selectedAlbum}
        selectedArtist={selectedArtist}
        hasTidal={hasTidal}
        collapsed={sidebarCollapsed}
        onShowAll={library.handleShowAll}
        onShowArtists={() => {
          pushAndScroll();
          library.setView("artists");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
        }}
        onShowAlbums={() => {
          pushAndScroll();
          library.setView("albums");
          library.setSelectedArtist(null);
          library.setSelectedTag(null);
        }}
        onShowTags={() => {
          pushAndScroll();
          library.setView("tags");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
        }}
        onShowLiked={library.handleShowLiked}
        onShowHistory={() => {
          pushAndScroll();
          library.setView("history");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
        }}
        onShowTidal={() => {
          pushAndScroll();
          library.setView("tidal");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
        }}
        onShowCollections={() => {
          pushAndScroll();
          library.setView("collections");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
        }}
        onShowSettings={() => setShowSettings(true)}
        updateAvailable={updater.updateState.available !== null}
      />
      <button
        className="sidebar-collapse-btn"
        onClick={handleToggleSidebar}
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          {sidebarCollapsed
            ? <polyline points="9 6 15 12 9 18" />
            : <polyline points="15 18 9 12 15 6" />
          }
        </svg>
      </button>

      {showAddServer && (
        <AddServerModal
          onAdded={() => {
            setShowAddServer(false);
            setDeepLinkServer(null);
            library.loadLibrary();
          }}
          onClose={() => { setShowAddServer(false); setDeepLinkServer(null); }}
          initialUrl={deepLinkServer?.url}
          initialUsername={deepLinkServer?.username}
          initialPassword={deepLinkServer?.password}
        />
      )}

      {showSettings && (
        <SettingsPanel
          searchProviders={searchProviders}
          onClose={() => setShowSettings(false)}
          onSeedDatabase={handleSeedDatabase}
          onClearDatabase={handleClearDatabase}
          clearing={clearing}
          onClearImageFailures={handleClearImageFailures}
          onSaveProviders={handleSaveProviders}
          crossfadeSecs={crossfadeSecs}
          onCrossfadeChange={handleCrossfadeChange}
          trackVideoHistory={trackVideoHistory}
          onTrackVideoHistoryChange={handleTrackVideoHistoryChange}
          appVersion={updater.appVersion}
          updateState={updater.updateState}
          onCheckForUpdates={updater.handleCheckForUpdates}
          onInstallUpdate={updater.handleInstallUpdate}
          backendTimings={backendTimings}
          frontendTimings={getTimingEntries()}
          onFetchBackendTimings={() => invoke<TimingEntry[]>("get_startup_timings").then(setBackendTimings)}
          lastfmConnected={lastfmConnected}
          lastfmUsername={lastfmUsername}
          onLastfmConnect={handleLastfmConnect}
          onLastfmDisconnect={handleLastfmDisconnect}
          downloadFormat={downloadFormat}
          onDownloadFormatChange={handleDownloadFormatChange}
          tidalEnabled={tidalEnabled}
          onTidalEnabledChange={handleTidalEnabledChange}
          tidalOverrideUrl={tidalOverrideUrl}
          onTidalOverrideUrlChange={handleTidalOverrideUrlChange}
        />
      )}

      {/* Caption bar - full width */}
      <div className="search-bar" data-tauri-drag-region onDoubleClick={handleCaptionDoubleClick}>
        <WindowControls position="left" />
          <button
            className="nav-history-btn"
            disabled={!canGoBack}
            onClick={goBack}
            title="Go back (Alt+Left)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            className="nav-history-btn"
            disabled={!canGoForward}
            onClick={goForward}
            title="Go forward (Alt+Right)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </button>
          <div className="caption-spacer" />
          <CentralSearchDropdown
            query={centralSearch.query}
            onQueryChange={centralSearch.setQuery}
            results={centralSearch.results}
            isOpen={centralSearch.isOpen}
            highlightedIndex={centralSearch.highlightedIndex}
            onKeyDown={centralSearch.handleKeyDown}
            onResultClick={centralSearch.handleResultClick}
            onClose={centralSearch.close}
            inputRef={searchInputRef}
            albumImages={albumImageCache.images}
            artistImages={artistImageCache.images}
            onFetchAlbumImage={albumImageCache.fetchOnDemand}
            onFetchArtistImage={artistImageCache.fetchOnDemand}
          />
          <div className="caption-spacer" />
          <button
            className="caption-mini-player-btn"
            onClick={mini.toggleMiniMode}
            title="Mini Player"
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="14" width="10" height="8" rx="1" />
              <path d="M12 8h8a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2" />
            </svg>
            <span>Mini Player</span>
          </button>
          <WindowControls position="right" />
        </div>

      {/* Main content */}
      <main className="main">
        {/* Content area */}
        <div className="content" ref={contentRef} style={{ minHeight: playback.currentTrack && isVideoTrack(playback.currentTrack) ? 150 : undefined }}>
          <Breadcrumb
            view={view}
            selectedArtist={selectedArtist}
            selectedAlbum={selectedAlbum}
            selectedTag={selectedTag}
            artists={artists}
            albums={albums}
            tags={tags}
            tracks={tracks}
            sortedTracks={sortedTracks}
            onSetSelectedArtist={library.setSelectedArtist}
            onSetSelectedAlbum={library.setSelectedAlbum}
            onSetSelectedTag={library.setSelectedTag}
            onSetView={library.setView}
            onPlayAll={queueHook.playTracks}
            onEnqueueAll={handleEnqueue}
          />

          {/* Artist list */}
          {view === "artists" && selectedArtist === null && (
            <>
              <ViewSearchBar
                query={viewSearch.getQuery("artists")}
                onQueryChange={(q) => viewSearch.setQuery("artists", q)}
                placeholder="Search artists..."
              />
              <div className={`sort-bar${library.sortBarCollapsed ? " sort-bar-collapsed" : ""}`}>
                {!library.sortBarCollapsed && (
                <div className="sort-bar-row">
                  <span className="sort-bar-label">Sort:</span>
                  <div className="sort-bar-group">
                    <button className={`sort-btn${library.artistSortField === "name" ? " active" : ""}`} onClick={() => library.handleArtistSort("name")}>
                      Name{library.artistSortField === "name" ? (library.artistSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </button>
                    <button className={`sort-btn${library.artistSortField === "tracks" ? " active" : ""}`} onClick={() => library.handleArtistSort("tracks")}>
                      Tracks{library.artistSortField === "tracks" ? (library.artistSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </button>
                    <button className={`sort-btn${library.artistSortField === "random" ? " active" : ""}`} onClick={() => library.handleArtistSort("random")}>
                      Shuffle
                    </button>
                    <button
                      className={`sort-btn liked-first-btn${library.artistLikedFirst ? " active" : ""}`}
                      onClick={() => library.setArtistLikedFirst(v => !v)}
                      title="Liked first"
                    >{"\u2665"} Liked first</button>
                  </div>
                </div>
                )}
                <div className="sort-bar-right">
                  <ViewModeToggle mode={library.artistViewMode} onChange={library.setArtistViewMode} />
                  <button className="sort-btn sort-bar-toggle" onClick={() => library.setSortBarCollapsed(v => !v)} title={library.sortBarCollapsed ? "Show sort bar" : "Hide sort bar"}>{library.sortBarCollapsed ? "\u25BC" : "\u25B2"}</button>
                </div>
              </div>

              {/* Artists: Basic view */}
              {library.artistViewMode === "basic" && (
                <div className="entity-table">
                  <div className="entity-table-header">
                    <span className="entity-table-like"></span>
                    <span className={`entity-table-name sortable${library.artistSortField === "name" ? " sorted" : ""}`} onClick={() => library.handleArtistSort("name")}>
                      Name{library.artistSortField === "name" ? (library.artistSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </span>
                    <span className={`entity-table-count sortable${library.artistSortField === "tracks" ? " sorted" : ""}`} onClick={() => library.handleArtistSort("tracks")}>
                      Tracks{library.artistSortField === "tracks" ? (library.artistSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </span>
                  </div>
                  {filteredArtists.map((a, i) => (
                    <div
                      key={a.id}
                      className={`entity-table-row${i === highlightedListIndex ? " highlighted" : ""}`}
                      onClick={() => library.handleArtistClick(a.id)}
                      onContextMenu={(e) => handleArtistContextMenu(e, a.id)}
                    >
                      <span
                        className="entity-table-like"
                        onClick={(e) => { e.stopPropagation(); handleToggleArtistLike(a.id); }}
                      >{a.liked === 1 ? "\u2665" : "\u2661"}</span>
                      <span className="entity-table-name">{a.name}</span>
                      <span className="entity-table-count">{a.track_count}</span>
                    </div>
                  ))}
                  {filteredArtists.length === 0 && (
                    <div className="empty">{viewSearch.getQuery("artists").trim() ? `No artists matching "${viewSearch.getQuery("artists")}"` : "No artists found. Add a folder or server to get started."}</div>
                  )}
                </div>
              )}

              {/* Artists: List view */}
              {library.artistViewMode === "list" && (
                <div className="entity-list">
                  {filteredArtists.map((a, i) => (
                    <div
                      key={a.id}
                      className={`entity-list-item${i === highlightedListIndex ? " highlighted" : ""}`}
                      onClick={() => library.handleArtistClick(a.id)}
                      onContextMenu={(e) => handleArtistContextMenu(e, a.id)}
                    >
                      <span
                        className="entity-list-like"
                        onClick={(e) => { e.stopPropagation(); handleToggleArtistLike(a.id); }}
                      >{a.liked === 1 ? "\u2665" : "\u2661"}</span>
                      <ArtistCardArt artist={a} imagePath={artistImageCache.images[a.id]} onVisible={artistImageCache.fetchOnDemand} className="entity-list-img circular" />
                      <span className="entity-list-name">{a.name}</span>
                      <span className="entity-list-count">{a.track_count} tracks</span>
                    </div>
                  ))}
                  {filteredArtists.length === 0 && (
                    <div className="empty">{viewSearch.getQuery("artists").trim() ? `No artists matching "${viewSearch.getQuery("artists")}"` : "No artists found. Add a folder or server to get started."}</div>
                  )}
                </div>
              )}

              {/* Artists: Tiles view */}
              {library.artistViewMode === "tiles" && (
                <div className="album-grid" style={{ padding: 16 }}>
                  {filteredArtists.map((a, i) => (
                    <div
                      key={a.id}
                      className={`artist-card${i === highlightedListIndex ? " highlighted" : ""}`}
                      onClick={() => library.handleArtistClick(a.id)}
                      onContextMenu={(e) => handleArtistContextMenu(e, a.id)}
                    >
                      <ArtistCardArt artist={a} imagePath={artistImageCache.images[a.id]} onVisible={artistImageCache.fetchOnDemand} />
                      <div
                        className={`artist-card-like${a.liked === 1 ? " liked" : ""}`}
                        onClick={(e) => { e.stopPropagation(); handleToggleArtistLike(a.id); }}
                      >{a.liked === 1 ? "\u2665" : "\u2661"}</div>
                      <div className="artist-card-body">
                        <div className="artist-card-name" title={a.name}>{a.name}</div>
                        <div className="artist-card-info">{a.track_count} tracks</div>
                      </div>
                    </div>
                  ))}
                  {filteredArtists.length === 0 && (
                    <div className="empty">{viewSearch.getQuery("artists").trim() ? `No artists matching "${viewSearch.getQuery("artists")}"` : "No artists found. Add a folder or server to get started."}</div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Artist detail view */}
          {view === "artists" && selectedArtist !== null && selectedAlbum === null && (() => {
            const artist = artists.find(a => a.id === selectedArtist);
            const artistImagePath = artistImageCache.images[selectedArtist] ?? null;
            return (
              <div className="artist-detail">
                <div className="artist-header">
                  <div className="artist-avatar">
                    {artistImagePath ? (
                      <img className="artist-avatar-img" src={convertFileSrc(artistImagePath)} alt={artist?.name} />
                    ) : (
                      artist ? getInitials(artist.name) : "?"
                    )}
                  </div>
                  <div className="artist-header-info">
                    <h2>
                      {artist?.name ?? "Unknown"}
                      <span
                        className={`detail-like-btn${artist?.liked === 1 ? " liked" : ""}`}
                        onClick={() => handleToggleArtistLike(selectedArtist)}
                        title={artist?.liked === 1 ? "Unlike artist" : "Like artist"}
                      >{artist?.liked === 1 ? "\u2665" : "\u2661"}</span>
                    </h2>
                    <span className="artist-meta">{artist?.track_count ?? 0} tracks</span>
                    <ImageActions
                      entityId={selectedArtist}
                      entityType="artist"
                      imagePath={artistImagePath}
                      onImageSet={(id, path) => artistImageCache.setImages(prev => ({ ...prev, [id]: path }))}
                      onImageRemoved={(id) => {
                        artistImageCache.setImages(prev => ({ ...prev, [id]: null }));
                      }}
                    />
                  </div>
                </div>

                {library.artistAlbums.length > 0 && (
                  <div className="artist-section">
                    <div className="section-title">Albums</div>
                    <div className="album-grid">
                      {library.artistAlbums.map((a) => (
                        <div key={a.id} className="album-card" onClick={() => library.handleAlbumClick(a.id)} onContextMenu={(e) => handleAlbumContextMenu(e, a.id)}>
                          <AlbumCardArt album={a} imagePath={albumImageCache.images[a.id]} onVisible={albumImageCache.fetchOnDemand} />
                          <div className="album-card-body">
                            <div className="album-card-title" title={a.title}>{a.title}</div>
                            <div className="album-card-info">
                              {a.year ? `${a.year} \u00B7 ` : ""}{a.track_count} tracks
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="artist-section">
                  <div className="section-title">All Tracks</div>
                  <TrackList
                    tracks={sortedTracks}
                    currentTrack={playback.currentTrack}
                    highlightedIndex={highlightedIndex}
                    sortField={sortField}
                    trackListRef={trackListRef}
                    columns={library.trackColumns}
                    onColumnsChange={library.setTrackColumns}
                    onDoubleClick={queueHook.playTracks}
                    onContextMenu={handleTrackContextMenu}
                    onArtistClick={library.handleArtistClick}
                    onAlbumClick={library.handleAlbumClick}
                    onSort={library.handleSort}
                    sortIndicator={library.sortIndicator}
                    onToggleLike={handleToggleLike}
                    onToggleDislike={handleToggleDislike}
                    onTrackDragStart={handleTrackDragStart}
                    emptyMessage="No tracks found for this artist."
                  />
                </div>
              </div>
            );
          })()}

          {/* All albums view */}
          {view === "albums" && (
            <>
              <ViewSearchBar
                query={viewSearch.getQuery("albums")}
                onQueryChange={(q) => viewSearch.setQuery("albums", q)}
                placeholder="Search albums..."
              />
              <div className={`sort-bar${library.sortBarCollapsed ? " sort-bar-collapsed" : ""}`}>
                {!library.sortBarCollapsed && (
                <div className="sort-bar-row">
                  <span className="sort-bar-label">Sort:</span>
                  <div className="sort-bar-group">
                    <button className={`sort-btn${library.albumSortField === "name" ? " active" : ""}`} onClick={() => library.handleAlbumSort("name")}>
                      Name{library.albumSortField === "name" ? (library.albumSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </button>
                    <button className={`sort-btn${library.albumSortField === "artist" ? " active" : ""}`} onClick={() => library.handleAlbumSort("artist")}>
                      Artist{library.albumSortField === "artist" ? (library.albumSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </button>
                    <button className={`sort-btn${library.albumSortField === "year" ? " active" : ""}`} onClick={() => library.handleAlbumSort("year")}>
                      Year{library.albumSortField === "year" ? (library.albumSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </button>
                    <button className={`sort-btn${library.albumSortField === "tracks" ? " active" : ""}`} onClick={() => library.handleAlbumSort("tracks")}>
                      Tracks{library.albumSortField === "tracks" ? (library.albumSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </button>
                    <button className={`sort-btn${library.albumSortField === "random" ? " active" : ""}`} onClick={() => library.handleAlbumSort("random")}>
                      Shuffle
                    </button>
                    <button
                      className={`sort-btn liked-first-btn${library.albumLikedFirst ? " active" : ""}`}
                      onClick={() => library.setAlbumLikedFirst(v => !v)}
                      title="Liked first"
                    >{"\u2665"} Liked first</button>
                  </div>
                </div>
                )}
                <div className="sort-bar-right">
                  <ViewModeToggle mode={library.albumViewMode} onChange={library.setAlbumViewMode} />
                  <button className="sort-btn sort-bar-toggle" onClick={() => library.setSortBarCollapsed(v => !v)} title={library.sortBarCollapsed ? "Show sort bar" : "Hide sort bar"}>{library.sortBarCollapsed ? "\u25BC" : "\u25B2"}</button>
                </div>
              </div>

              {/* Albums: Basic view */}
              {library.albumViewMode === "basic" && (
                <div className="entity-table">
                  <div className="entity-table-header">
                    <span className="entity-table-like"></span>
                    <span className={`entity-table-name sortable${library.albumSortField === "name" ? " sorted" : ""}`} onClick={() => library.handleAlbumSort("name")}>
                      Name{library.albumSortField === "name" ? (library.albumSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </span>
                    <span className={`entity-table-secondary sortable${library.albumSortField === "artist" ? " sorted" : ""}`} onClick={() => library.handleAlbumSort("artist")}>
                      Artist{library.albumSortField === "artist" ? (library.albumSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </span>
                    <span className={`entity-table-year sortable${library.albumSortField === "year" ? " sorted" : ""}`} onClick={() => library.handleAlbumSort("year")}>
                      Year{library.albumSortField === "year" ? (library.albumSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </span>
                    <span className={`entity-table-count sortable${library.albumSortField === "tracks" ? " sorted" : ""}`} onClick={() => library.handleAlbumSort("tracks")}>
                      Tracks{library.albumSortField === "tracks" ? (library.albumSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </span>
                  </div>
                  {filteredAlbums.map((a, i) => (
                    <div
                      key={a.id}
                      className={`entity-table-row${i === highlightedListIndex ? " highlighted" : ""}`}
                      onClick={() => library.handleAlbumClick(a.id)}
                      onContextMenu={(e) => handleAlbumContextMenu(e, a.id)}
                    >
                      <span
                        className="entity-table-like"
                        onClick={(e) => { e.stopPropagation(); handleToggleAlbumLike(a.id); }}
                      >{a.liked === 1 ? "\u2665" : "\u2661"}</span>
                      <span className="entity-table-name">{a.title}</span>
                      <span className="entity-table-secondary">{a.artist_name ?? ""}</span>
                      <span className="entity-table-year">{a.year ?? ""}</span>
                      <span className="entity-table-count">{a.track_count}</span>
                    </div>
                  ))}
                  {filteredAlbums.length === 0 && (
                    <div className="empty">{viewSearch.getQuery("albums").trim() ? `No albums matching "${viewSearch.getQuery("albums")}"` : "No albums found."}</div>
                  )}
                </div>
              )}

              {/* Albums: List view */}
              {library.albumViewMode === "list" && (
                <div className="entity-list">
                  {filteredAlbums.map((a, i) => (
                    <div
                      key={a.id}
                      className={`entity-list-item${i === highlightedListIndex ? " highlighted" : ""}`}
                      onClick={() => library.handleAlbumClick(a.id)}
                      onContextMenu={(e) => handleAlbumContextMenu(e, a.id)}
                    >
                      <span
                        className="entity-list-like"
                        onClick={(e) => { e.stopPropagation(); handleToggleAlbumLike(a.id); }}
                      >{a.liked === 1 ? "\u2665" : "\u2661"}</span>
                      <AlbumCardArt album={a} imagePath={albumImageCache.images[a.id]} onVisible={albumImageCache.fetchOnDemand} />
                      <span className="entity-list-name">{a.title}</span>
                      <span className="entity-list-secondary">
                        {a.artist_name && <>{a.artist_name} {"\u00B7"} </>}
                        {a.year ? `${a.year} \u00B7 ` : ""}{a.track_count} tracks
                      </span>
                    </div>
                  ))}
                  {filteredAlbums.length === 0 && (
                    <div className="empty">{viewSearch.getQuery("albums").trim() ? `No albums matching "${viewSearch.getQuery("albums")}"` : "No albums found."}</div>
                  )}
                </div>
              )}

              {/* Albums: Tiles view */}
              {library.albumViewMode === "tiles" && (
                <div className="album-grid" style={{ padding: 16 }}>
                  {filteredAlbums.map((a, i) => (
                    <div key={a.id} className={`album-card${i === highlightedListIndex ? " highlighted" : ""}`} onClick={() => library.handleAlbumClick(a.id)} onContextMenu={(e) => handleAlbumContextMenu(e, a.id)}>
                      <AlbumCardArt album={a} imagePath={albumImageCache.images[a.id]} onVisible={albumImageCache.fetchOnDemand} />
                      <div
                        className={`album-card-like${a.liked === 1 ? " liked" : ""}`}
                        onClick={(e) => { e.stopPropagation(); handleToggleAlbumLike(a.id); }}
                      >{a.liked === 1 ? "\u2665" : "\u2661"}</div>
                      <div className="album-card-body">
                        <div className="album-card-title" title={a.title}>{a.title}</div>
                        <div className="album-card-info">
                          {a.artist_name && <>{a.artist_name} {"\u00B7"} </>}
                          {a.year ? `${a.year} \u00B7 ` : ""}{a.track_count} tracks
                        </div>
                      </div>
                    </div>
                  ))}
                  {filteredAlbums.length === 0 && (
                    <div className="empty">{viewSearch.getQuery("albums").trim() ? `No albums matching "${viewSearch.getQuery("albums")}"` : "No albums found."}</div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Tags list view */}
          {view === "tags" && selectedTag === null && (
            <>
              <ViewSearchBar
                query={viewSearch.getQuery("tags")}
                onQueryChange={(q) => viewSearch.setQuery("tags", q)}
                placeholder="Search tags..."
              />
              <div className={`sort-bar${library.sortBarCollapsed ? " sort-bar-collapsed" : ""}`}>
                {!library.sortBarCollapsed && (
                <div className="sort-bar-row">
                  <span className="sort-bar-label">Sort:</span>
                  <div className="sort-bar-group">
                    <button className={`sort-btn${library.tagSortField === "name" ? " active" : ""}`} onClick={() => library.handleTagSort("name")}>
                      Name{library.tagSortField === "name" ? (library.tagSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </button>
                    <button className={`sort-btn${library.tagSortField === "tracks" ? " active" : ""}`} onClick={() => library.handleTagSort("tracks")}>
                      Tracks{library.tagSortField === "tracks" ? (library.tagSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </button>
                    <button className={`sort-btn${library.tagSortField === "random" ? " active" : ""}`} onClick={() => library.handleTagSort("random")}>
                      Shuffle
                    </button>
                    <button
                      className={`sort-btn liked-first-btn${library.tagLikedFirst ? " active" : ""}`}
                      onClick={() => library.setTagLikedFirst(v => !v)}
                      title="Liked first"
                    >{"\u2665"} Liked first</button>
                  </div>
                </div>
                )}
                <div className="sort-bar-right">
                  <ViewModeToggle mode={library.tagViewMode} onChange={library.setTagViewMode} />
                  <button className="sort-btn sort-bar-toggle" onClick={() => library.setSortBarCollapsed(v => !v)} title={library.sortBarCollapsed ? "Show sort bar" : "Hide sort bar"}>{library.sortBarCollapsed ? "\u25BC" : "\u25B2"}</button>
                </div>
              </div>

              {/* Tags: Basic view */}
              {library.tagViewMode === "basic" && (
                <div className="entity-table">
                  <div className="entity-table-header">
                    <span className="entity-table-like"></span>
                    <span className={`entity-table-name sortable${library.tagSortField === "name" ? " sorted" : ""}`} onClick={() => library.handleTagSort("name")}>
                      Name{library.tagSortField === "name" ? (library.tagSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </span>
                    <span className={`entity-table-count sortable${library.tagSortField === "tracks" ? " sorted" : ""}`} onClick={() => library.handleTagSort("tracks")}>
                      Tracks{library.tagSortField === "tracks" ? (library.tagSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </span>
                  </div>
                  {filteredTags.map((t, i) => (
                    <div
                      key={t.id}
                      className={`entity-table-row${i === highlightedListIndex ? " highlighted" : ""}`}
                      onClick={() => { pushAndScroll(); library.setSelectedTag(t.id); library.setView("all"); }}
                    >
                      <span
                        className="entity-table-like"
                        onClick={(e) => { e.stopPropagation(); handleToggleTagLike(t.id); }}
                      >{t.liked === 1 ? "\u2665" : "\u2661"}</span>
                      <span className="entity-table-name">{t.name}</span>
                      <span className="entity-table-count">{t.track_count}</span>
                    </div>
                  ))}
                  {filteredTags.length === 0 && (
                    <div className="empty">{viewSearch.getQuery("tags").trim() ? `No tags matching "${viewSearch.getQuery("tags")}"` : "No tags found. Add a folder or server to get started."}</div>
                  )}
                </div>
              )}

              {/* Tags: List view */}
              {library.tagViewMode === "list" && (
                <div className="entity-list">
                  {filteredTags.map((t, i) => (
                    <div
                      key={t.id}
                      className={`entity-list-item${i === highlightedListIndex ? " highlighted" : ""}`}
                      onClick={() => { pushAndScroll(); library.setSelectedTag(t.id); library.setView("all"); }}
                    >
                      <span
                        className="entity-list-like"
                        onClick={(e) => { e.stopPropagation(); handleToggleTagLike(t.id); }}
                      >{t.liked === 1 ? "\u2665" : "\u2661"}</span>
                      <TagCardArt tag={t} imagePath={tagImageCache.images[t.id]} onVisible={tagImageCache.fetchOnDemand} className="entity-list-img" />
                      <span className="entity-list-name">{t.name}</span>
                      <span className="entity-list-count">{t.track_count} tracks</span>
                    </div>
                  ))}
                  {filteredTags.length === 0 && (
                    <div className="empty">{viewSearch.getQuery("tags").trim() ? `No tags matching "${viewSearch.getQuery("tags")}"` : "No tags found. Add a folder or server to get started."}</div>
                  )}
                </div>
              )}

              {/* Tags: Tiles view */}
              {library.tagViewMode === "tiles" && (
                <div className="album-grid" style={{ padding: 16 }}>
                  {filteredTags.map((t, i) => (
                    <div
                      key={t.id}
                      className={`tag-card${i === highlightedListIndex ? " highlighted" : ""}`}
                      onClick={() => { pushAndScroll(); library.setSelectedTag(t.id); library.setView("all"); }}
                    >
                      <TagCardArt tag={t} imagePath={tagImageCache.images[t.id]} onVisible={tagImageCache.fetchOnDemand} />
                      <div
                        className={`artist-card-like${t.liked === 1 ? " liked" : ""}`}
                        onClick={(e) => { e.stopPropagation(); handleToggleTagLike(t.id); }}
                      >{t.liked === 1 ? "\u2665" : "\u2661"}</div>
                      <div className="tag-card-body">
                        <div className="tag-card-name" title={t.name}>{t.name}</div>
                        <div className="tag-card-info">{t.track_count} tracks</div>
                      </div>
                    </div>
                  ))}
                  {filteredTags.length === 0 && (
                    <div className="empty">{viewSearch.getQuery("tags").trim() ? `No tags matching "${viewSearch.getQuery("tags")}"` : "No tags found. Add a folder or server to get started."}</div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Tag detail header */}
          {view === "all" && selectedTag !== null && !viewSearch.getQuery("all").trim() && (() => {
            const tag = tags.find(t => t.id === selectedTag);
            const tagImagePath = tagImageCache.images[selectedTag] ?? null;
            return (
              <div className="album-detail-header">
                <div className="album-detail-art">
                  {tagImagePath ? (
                    <img className="album-detail-art-img" src={convertFileSrc(tagImagePath)} alt={tag?.name} />
                  ) : (
                    tag?.name[0]?.toUpperCase() ?? "#"
                  )}
                </div>
                <div className="album-detail-info">
                  <h2>
                    {tag?.name ?? "Unknown"}
                    <span
                      className={`detail-like-btn${tag?.liked === 1 ? " liked" : ""}`}
                      onClick={() => handleToggleTagLike(selectedTag)}
                      title={tag?.liked === 1 ? "Unlike tag" : "Like tag"}
                    >{tag?.liked === 1 ? "\u2665" : "\u2661"}</span>
                  </h2>
                  <span className="artist-meta">{tag?.track_count ?? 0} tracks</span>
                  <ImageActions
                    entityId={selectedTag}
                    entityType="tag"
                    imagePath={tagImagePath}
                    onImageSet={(id, path) => tagImageCache.setImages(prev => ({ ...prev, [id]: path }))}
                    onImageRemoved={(id) => {
                      tagImageCache.setImages(prev => ({ ...prev, [id]: null }));
                    }}
                  />
                </div>
              </div>
            );
          })()}

          {/* Album detail header */}
          {(view === "all" || view === "artists") && selectedAlbum !== null && !viewSearch.getQuery(view).trim() && (() => {
            const album = albums.find(a => a.id === selectedAlbum);
            const albumImagePath = albumImageCache.images[selectedAlbum] ?? null;
            return (
              <div className="album-detail-header">
                <div className="album-detail-art">
                  {albumImagePath ? (
                    <img className="album-detail-art-img" src={convertFileSrc(albumImagePath)} alt={album?.title} />
                  ) : (
                    album?.title[0]?.toUpperCase() ?? "?"
                  )}
                </div>
                <div className="album-detail-info">
                  <h2>
                    {album?.title ?? "Unknown"}
                    <span
                      className={`detail-like-btn${album?.liked === 1 ? " liked" : ""}`}
                      onClick={() => handleToggleAlbumLike(selectedAlbum)}
                      title={album?.liked === 1 ? "Unlike album" : "Like album"}
                    >{album?.liked === 1 ? "\u2665" : "\u2661"}</span>
                  </h2>
                  <span className="artist-meta">
                    {album?.artist_name && <>{album.artist_name} {"\u00B7"} </>}
                    {album?.year && <>{album.year} {"\u00B7"} </>}
                    {album?.track_count ?? 0} tracks
                  </span>
                  <ImageActions
                    entityId={selectedAlbum}
                    entityType="album"
                    imagePath={albumImagePath}
                    onImageSet={(id, path) => albumImageCache.setImages(prev => ({ ...prev, [id]: path }))}
                    onImageRemoved={(id) => {
                      albumImageCache.setImages(prev => ({ ...prev, [id]: null }));
                    }}
                  />
                </div>
              </div>
            );
          })()}

          {/* All tracks view */}
          {view === "all" && (
            <>
              <ViewSearchBar
                query={viewSearch.getQuery("all")}
                onQueryChange={(q) => viewSearch.setQuery("all", q)}
                placeholder="Search tracks..."
              />
              <div className={`sort-bar${library.sortBarCollapsed ? " sort-bar-collapsed" : ""}`}>
                {!library.sortBarCollapsed && (
                <>
                <div className="sort-bar-row">
                  <span className="sort-bar-label">Sort:</span>
                  <div className="sort-bar-group">
                    <button className={`sort-btn${library.sortField === "title" ? " active" : ""}`} onClick={() => library.handleSort("title")}>
                      Title{library.sortIndicator("title")}
                    </button>
                    <button className={`sort-btn${library.sortField === "artist" ? " active" : ""}`} onClick={() => library.handleSort("artist")}>
                      Artist{library.sortIndicator("artist")}
                    </button>
                    <button className={`sort-btn${library.sortField === "album" ? " active" : ""}`} onClick={() => library.handleSort("album")}>
                      Album{library.sortIndicator("album")}
                    </button>
                    <button className={`sort-btn${library.sortField === "year" ? " active" : ""}`} onClick={() => library.handleSort("year")}>
                      Year{library.sortIndicator("year")}
                    </button>
                    <button className={`sort-btn${library.sortField === "duration" ? " active" : ""}`} onClick={() => library.handleSort("duration")}>
                      Duration{library.sortIndicator("duration")}
                    </button>
                    <button className={`sort-btn${library.sortField === "added" ? " active" : ""}`} onClick={() => library.handleSort("added")}>
                      Added{library.sortIndicator("added")}
                    </button>
                    <button className={`sort-btn${library.sortField === "modified" ? " active" : ""}`} onClick={() => library.handleSort("modified")}>
                      Modified{library.sortIndicator("modified")}
                    </button>
                    <button className={`sort-btn${library.sortField === "random" ? " active" : ""}`} onClick={() => library.handleSort("random")}>
                      Shuffle
                    </button>
                    <button
                      className={`sort-btn liked-first-btn${library.trackLikedFirst ? " active" : ""}`}
                      onClick={() => library.setTrackLikedFirst(v => !v)}
                      title="Liked first"
                    >{"\u2665"} Liked first</button>
                  </div>
                </div>
                <div className="sort-bar-row">
                  <span className="sort-bar-label">Filter:</span>
                  <div className="sort-bar-group sort-bar-group-filter">
                    <button className={`sort-btn${library.mediaTypeFilter === "all" ? " active" : ""}`} onClick={() => library.setMediaTypeFilter("all")}>
                      All
                    </button>
                    <button className={`sort-btn${library.mediaTypeFilter === "audio" ? " active" : ""}`} onClick={() => library.setMediaTypeFilter("audio")}>
                      Audio
                    </button>
                    <button className={`sort-btn${library.mediaTypeFilter === "video" ? " active" : ""}`} onClick={() => library.setMediaTypeFilter("video")}>
                      Video
                    </button>
                    <button className={`sort-btn${library.filterYoutubeOnly ? " active" : ""}`} onClick={() => library.setFilterYoutubeOnly(v => !v)}>
                      YouTube
                    </button>
                  </div>
                </div>
                </>
                )}
                <div className="sort-bar-right">
                  <ViewModeToggle mode={library.trackViewMode} onChange={library.setTrackViewMode} />
                  <button className="sort-btn sort-bar-toggle" onClick={() => library.setSortBarCollapsed(v => !v)} title={library.sortBarCollapsed ? "Show sort bar" : "Hide sort bar"}>{library.sortBarCollapsed ? "\u25BC" : "\u25B2"}</button>
                </div>
              </div>

              {/* Tracks: Basic view */}
              {library.trackViewMode === "basic" && (
                <TrackList
                  tracks={sortedTracks}
                  currentTrack={playback.currentTrack}
                  highlightedIndex={highlightedIndex}
                  sortField={sortField}
                  trackListRef={trackListRef}
                  columns={library.trackColumns}
                  onColumnsChange={library.setTrackColumns}
                  onDoubleClick={queueHook.playTracks}
                  onContextMenu={handleTrackContextMenu}
                  onArtistClick={library.handleArtistClick}
                  onAlbumClick={library.handleAlbumClick}
                  onSort={library.handleSort}
                  sortIndicator={library.sortIndicator}
                  onToggleLike={handleToggleLike}
                    onToggleDislike={handleToggleDislike}
                  onTrackDragStart={handleTrackDragStart}
                  emptyMessage="No tracks found. Add a folder or server to start building your library."
                  hasMore={library.hasMore}
                  loadingMore={library.loadingMore}
                  onLoadMore={library.loadMore}
                />
              )}

              {/* Tracks: List view */}
              {library.trackViewMode === "list" && (
                <div className="entity-list">
                  {sortedTracks.map((t, i) => (
                    <div
                      key={t.id}
                      className={`entity-list-item${playback.currentTrack?.id === t.id ? " playing" : ""}${i === highlightedIndex ? " highlighted" : ""}`}
                      onDoubleClick={() => queueHook.playTracks(sortedTracks, i)}
                      onContextMenu={(e) => handleTrackContextMenu(e, t, new Set())}
                    >
                      <span className="entity-list-like-group">
                        <span
                          className={`entity-list-like${t.liked === 1 ? " active" : ""}`}
                          onClick={(e) => { e.stopPropagation(); handleToggleLike(t); }}
                        >{t.liked === 1 ? "\u2665" : "\u2661"}</span>
                        <span
                          className={`entity-list-dislike${t.liked === -1 ? " active" : ""}`}
                          onClick={(e) => { e.stopPropagation(); handleToggleDislike(t); }}
                        >{t.liked === -1 ? "\u2716" : "\u2298"}</span>
                      </span>
                      {t.album_id ? (
                        <AlbumCardArt album={{ id: t.album_id, title: t.album_title ?? "", artist_name: t.artist_name } as Album} imagePath={albumImageCache.images[t.album_id]} onVisible={albumImageCache.fetchOnDemand} />
                      ) : (
                        <div className="entity-list-img">{t.title[0]?.toUpperCase() ?? "?"}</div>
                      )}
                      <div className="entity-list-info">
                        <span className="entity-list-name">{t.title}</span>
                        <span className="entity-list-secondary">
                          {t.artist_name && <>{t.artist_name}</>}
                          {t.album_title && <> {"\u00B7"} {t.album_title}</>}
                        </span>
                      </div>
                      <span className="entity-list-count">{formatDuration(t.duration_secs)}</span>
                    </div>
                  ))}
                  {sortedTracks.length === 0 && (
                    <div className="empty">No tracks found. Add a folder or server to start building your library.</div>
                  )}
                </div>
              )}

              {/* Tracks: Tiles view */}
              {library.trackViewMode === "tiles" && (
                <div className="album-grid" style={{ padding: 16 }}>
                  {sortedTracks.map((t, i) => (
                    <div
                      key={t.id}
                      className={`album-card${playback.currentTrack?.id === t.id ? " playing" : ""}${i === highlightedIndex ? " highlighted" : ""}`}
                      onDoubleClick={() => queueHook.playTracks(sortedTracks, i)}
                      onContextMenu={(e) => handleTrackContextMenu(e, t, new Set())}
                    >
                      {t.album_id ? (
                        <AlbumCardArt album={{ id: t.album_id, title: t.album_title ?? "", artist_name: t.artist_name } as Album} imagePath={albumImageCache.images[t.album_id]} onVisible={albumImageCache.fetchOnDemand} />
                      ) : (
                        <div className="album-card-art">{t.title[0]?.toUpperCase() ?? "?"}</div>
                      )}
                      <div className="album-card-like-group">
                        <div
                          className={`album-card-like${t.liked === 1 ? " liked" : ""}`}
                          onClick={(e) => { e.stopPropagation(); handleToggleLike(t); }}
                        >{t.liked === 1 ? "\u2665" : "\u2661"}</div>
                        <div
                          className={`album-card-dislike${t.liked === -1 ? " disliked" : ""}`}
                          onClick={(e) => { e.stopPropagation(); handleToggleDislike(t); }}
                        >{t.liked === -1 ? "\u2716" : "\u2298"}</div>
                      </div>
                      <div className="album-card-body">
                        <div className="album-card-title" title={t.title}>{t.title}</div>
                        <div className="album-card-info">
                          {t.artist_name && <>{t.artist_name} {"\u00B7"} </>}
                          {formatDuration(t.duration_secs)}
                        </div>
                      </div>
                    </div>
                  ))}
                  {sortedTracks.length === 0 && (
                    <div className="empty">No tracks found. Add a folder or server to start building your library.</div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Artist album detail - always basic TrackList */}
          {(view === "artists" && selectedAlbum !== null) && (
            <TrackList
              tracks={sortedTracks}
              currentTrack={playback.currentTrack}
              highlightedIndex={highlightedIndex}
              sortField={sortField}
              trackListRef={trackListRef}
              columns={library.trackColumns}
              onColumnsChange={library.setTrackColumns}
              onDoubleClick={queueHook.playTracks}
              onContextMenu={handleTrackContextMenu}
              onArtistClick={library.handleArtistClick}
              onAlbumClick={library.handleAlbumClick}
              onSort={library.handleSort}
              sortIndicator={library.sortIndicator}
              onToggleLike={handleToggleLike}
                    onToggleDislike={handleToggleDislike}
              onTrackDragStart={handleTrackDragStart}
              emptyMessage="No tracks found."
            />
          )}

          {/* Liked tracks view */}
          {view === "liked" && (
            <>
              <ViewSearchBar
                query={viewSearch.getQuery("liked")}
                onQueryChange={(q) => viewSearch.setQuery("liked", q)}
                placeholder="Search liked tracks..."
              />
              <div className={`sort-bar${library.sortBarCollapsed ? " sort-bar-collapsed" : ""}`}>
                {!library.sortBarCollapsed && (
                <div className="sort-bar-row">
                  <span className="sort-bar-label">Sort:</span>
                  <div className="sort-bar-group">
                    <button className={`sort-btn${library.sortField === "title" ? " active" : ""}`} onClick={() => library.handleSort("title")}>
                      Title{library.sortIndicator("title")}
                    </button>
                    <button className={`sort-btn${library.sortField === "artist" ? " active" : ""}`} onClick={() => library.handleSort("artist")}>
                      Artist{library.sortIndicator("artist")}
                    </button>
                    <button className={`sort-btn${library.sortField === "album" ? " active" : ""}`} onClick={() => library.handleSort("album")}>
                      Album{library.sortIndicator("album")}
                    </button>
                    <button className={`sort-btn${library.sortField === "year" ? " active" : ""}`} onClick={() => library.handleSort("year")}>
                      Year{library.sortIndicator("year")}
                    </button>
                    <button className={`sort-btn${library.sortField === "duration" ? " active" : ""}`} onClick={() => library.handleSort("duration")}>
                      Duration{library.sortIndicator("duration")}
                    </button>
                    <button className={`sort-btn${library.sortField === "added" ? " active" : ""}`} onClick={() => library.handleSort("added")}>
                      Added{library.sortIndicator("added")}
                    </button>
                    <button className={`sort-btn${library.sortField === "modified" ? " active" : ""}`} onClick={() => library.handleSort("modified")}>
                      Modified{library.sortIndicator("modified")}
                    </button>
                    <button className={`sort-btn${library.sortField === "random" ? " active" : ""}`} onClick={() => library.handleSort("random")}>
                      Shuffle
                    </button>
                  </div>
                </div>
                )}
                <div className="sort-bar-right">
                  <ViewModeToggle mode={library.likedViewMode} onChange={library.setLikedViewMode} />
                  <button className="sort-btn sort-bar-toggle" onClick={() => library.setSortBarCollapsed(v => !v)} title={library.sortBarCollapsed ? "Show sort bar" : "Hide sort bar"}>{library.sortBarCollapsed ? "\u25BC" : "\u25B2"}</button>
                </div>
              </div>

              {/* Liked: Basic view */}
              {library.likedViewMode === "basic" && (
                <TrackList
                  tracks={sortedTracks}
                  currentTrack={playback.currentTrack}
                  highlightedIndex={highlightedIndex}
                  sortField={sortField}
                  trackListRef={trackListRef}
                  columns={library.trackColumns}
                  onColumnsChange={library.setTrackColumns}
                  onDoubleClick={queueHook.playTracks}
                  onContextMenu={handleTrackContextMenu}
                  onArtistClick={library.handleArtistClick}
                  onAlbumClick={library.handleAlbumClick}
                  onSort={library.handleSort}
                  sortIndicator={library.sortIndicator}
                  onToggleLike={handleToggleLike}
                    onToggleDislike={handleToggleDislike}
                  onTrackDragStart={handleTrackDragStart}
                  emptyMessage="No liked tracks yet. Click the heart icon on any track to like it."
                />
              )}

              {/* Liked: List view */}
              {library.likedViewMode === "list" && (
                <div className="entity-list">
                  {sortedTracks.map((t, i) => (
                    <div
                      key={t.id}
                      className={`entity-list-item${playback.currentTrack?.id === t.id ? " playing" : ""}${i === highlightedIndex ? " highlighted" : ""}`}
                      onDoubleClick={() => queueHook.playTracks(sortedTracks, i)}
                      onContextMenu={(e) => handleTrackContextMenu(e, t, new Set())}
                    >
                      <span className="entity-list-like-group">
                        <span
                          className={`entity-list-like${t.liked === 1 ? " active" : ""}`}
                          onClick={(e) => { e.stopPropagation(); handleToggleLike(t); }}
                        >{t.liked === 1 ? "\u2665" : "\u2661"}</span>
                        <span
                          className={`entity-list-dislike${t.liked === -1 ? " active" : ""}`}
                          onClick={(e) => { e.stopPropagation(); handleToggleDislike(t); }}
                        >{t.liked === -1 ? "\u2716" : "\u2298"}</span>
                      </span>
                      {t.album_id ? (
                        <AlbumCardArt album={{ id: t.album_id, title: t.album_title ?? "", artist_name: t.artist_name } as Album} imagePath={albumImageCache.images[t.album_id]} onVisible={albumImageCache.fetchOnDemand} />
                      ) : (
                        <div className="entity-list-img">{t.title[0]?.toUpperCase() ?? "?"}</div>
                      )}
                      <div className="entity-list-info">
                        <span className="entity-list-name">{t.title}</span>
                        <span className="entity-list-secondary">
                          {t.artist_name && <>{t.artist_name}</>}
                          {t.album_title && <> {"\u00B7"} {t.album_title}</>}
                        </span>
                      </div>
                      <span className="entity-list-count">{formatDuration(t.duration_secs)}</span>
                    </div>
                  ))}
                  {sortedTracks.length === 0 && (
                    <div className="empty">No liked tracks yet. Click the heart icon on any track to like it.</div>
                  )}
                </div>
              )}

              {/* Liked: Tiles view */}
              {library.likedViewMode === "tiles" && (
                <div className="album-grid" style={{ padding: 16 }}>
                  {sortedTracks.map((t, i) => (
                    <div
                      key={t.id}
                      className={`album-card${playback.currentTrack?.id === t.id ? " playing" : ""}${i === highlightedIndex ? " highlighted" : ""}`}
                      onDoubleClick={() => queueHook.playTracks(sortedTracks, i)}
                      onContextMenu={(e) => handleTrackContextMenu(e, t, new Set())}
                    >
                      {t.album_id ? (
                        <AlbumCardArt album={{ id: t.album_id, title: t.album_title ?? "", artist_name: t.artist_name } as Album} imagePath={albumImageCache.images[t.album_id]} onVisible={albumImageCache.fetchOnDemand} />
                      ) : (
                        <div className="album-card-art">{t.title[0]?.toUpperCase() ?? "?"}</div>
                      )}
                      <div className="album-card-like-group">
                        <div
                          className={`album-card-like${t.liked === 1 ? " liked" : ""}`}
                          onClick={(e) => { e.stopPropagation(); handleToggleLike(t); }}
                        >{t.liked === 1 ? "\u2665" : "\u2661"}</div>
                        <div
                          className={`album-card-dislike${t.liked === -1 ? " disliked" : ""}`}
                          onClick={(e) => { e.stopPropagation(); handleToggleDislike(t); }}
                        >{t.liked === -1 ? "\u2716" : "\u2298"}</div>
                      </div>
                      <div className="album-card-body">
                        <div className="album-card-title" title={t.title}>{t.title}</div>
                        <div className="album-card-info">
                          {t.artist_name && <>{t.artist_name} {"\u00B7"} </>}
                          {formatDuration(t.duration_secs)}
                        </div>
                      </div>
                    </div>
                  ))}
                  {sortedTracks.length === 0 && (
                    <div className="empty">No liked tracks yet. Click the heart icon on any track to like it.</div>
                  )}
                </div>
              )}
            </>
          )}

          {/* History view */}
          {view === "history" && (
            <>
              <ViewSearchBar
                query={viewSearch.getQuery("history")}
                onQueryChange={(q) => viewSearch.setQuery("history", q)}
                placeholder="Search history..."
              />
              <HistoryView ref={historyRef} searchQuery={viewSearch.getQuery("history")} highlightedIndex={highlightedListIndex} onPlayTrack={queueHook.playTracks} onEnqueueTrack={handleEnqueue} addLog={addLog} onArtistClick={library.handleArtistClick} />
            </>
          )}

          {/* TIDAL view */}
          {view === "tidal" && tidalEnabled && (
            <>
              <ViewSearchBar
                query={viewSearch.getQuery("tidal")}
                onQueryChange={(q) => viewSearch.setQuery("tidal", q)}
                placeholder="Search TIDAL..."
              />
              <TidalView
                searchQuery={viewSearch.getQuery("tidal")}
                overrideUrl={tidalOverrideUrl || undefined}
                onPlayTrack={handleTidalPlay}
                onEnqueueTrack={handleTidalEnqueue}
                onDownloadAlbum={handleDownloadAlbum}
                onDownloadTrack={handleTidalDownloadTrack}
                localCollections={localCollections}
              />
            </>
          )}

          {/* Collections view */}
          {view === "collections" && (
            <CollectionsView
              collections={library.collections.filter(c => c.kind !== "tidal")}
              onToggleEnabled={handleToggleCollectionEnabled}
              onCheckConnection={handleCheckConnection}
              onResync={handleResyncCollection}
              checkingConnectionId={checkingConnectionId}
              connectionResult={connectionResult}
              onEdit={(c) => setEditingCollection(c)}
              onRemove={(c) => setRemoveCollectionConfirm(c)}
              onAddFolder={handleAddFolder}
              onShowAddServer={() => setShowAddServer(true)}
            />
          )}
        </div>

        {/* Video splitter + player area (below content, above now-playing) */}
        {playback.currentTrack && isVideoTrack(playback.currentTrack) && (
          <div className="video-splitter" onMouseDown={videoSplit.onSplitterMouseDown}>
            <div className="splitter-handle" />
            <button
              className="splitter-collapse-btn"
              onClick={videoSplit.toggleCollapse}
              title={videoSplit.isCollapsed ? "Expand video" : "Collapse video"}
            >
              {videoSplit.isCollapsed ? "\u25BC" : "\u25B2"}
            </button>
          </div>
        )}
        <div
          className={`video-container${videoSplit.isCollapsed ? " collapsed" : ""}`}
          style={{
            display: playback.currentTrack && isVideoTrack(playback.currentTrack) ? undefined : 'none',
            height: videoSplit.isCollapsed ? 0 : videoSplit.videoHeight,
          }}
        >
          <video
            ref={playback.videoRef}
            onTimeUpdate={playback.onTimeUpdate}
            onLoadedMetadata={playback.onLoadedMetadata}
            onPlay={playback.onPlay}
            onPause={playback.onPause}
            onError={playback.onMediaError}
            onClick={playback.handlePause}
            onDoubleClick={playback.toggleFullscreen}
          />
          <FullscreenControls
            waveformPeaks={waveformPeaks}
            currentTrack={playback.currentTrack}
            playing={playback.playing}
            positionSecs={playback.positionSecs}
            durationSecs={playback.durationSecs}
            scrobbled={playback.scrobbled}
            volume={playback.volume}
            queueMode={queueHook.queueMode}
            autoContinueEnabled={autoContinue.enabled}
            autoContinueSameFormat={autoContinue.sameFormat}
            showAutoContinuePopover={autoContinue.showPopover}
            autoContinueWeights={autoContinue.weights}
            imagePath={
              (playback.currentTrack?.album_id && albumImageCache.images[playback.currentTrack.album_id])
              || (playback.currentTrack?.artist_id && artistImageCache.images[playback.currentTrack.artist_id])
              || null
            }
            onPause={playback.handlePause}
            onStop={playback.handleStop}
            onNext={handleNext}
            onPrevious={queueHook.playPrevious}
            onSeek={playback.handleSeek}
            onVolume={playback.handleVolume}
            onMute={() => {
              if (playback.volume > 0) {
                previousVolumeRef.current = playback.volume;
                playback.handleVolume(0);
              } else {
                playback.handleVolume(previousVolumeRef.current || 1.0);
              }
            }}
            onToggleQueueMode={queueHook.toggleQueueMode}
            onToggleAutoContinue={() => autoContinue.setEnabled(!autoContinue.enabled)}
            onToggleAutoContinueSameFormat={() => autoContinue.setSameFormat(!autoContinue.sameFormat)}
            onToggleAutoContinuePopover={() => autoContinue.setShowPopover(!autoContinue.showPopover)}
            onAdjustAutoContinueWeight={autoContinue.adjustWeight}
            onToggleLike={() => playback.currentTrack && handleToggleLike(playback.currentTrack)}
            onToggleDislike={() => playback.currentTrack && handleToggleDislike(playback.currentTrack)}
            onToggleFullscreen={playback.toggleFullscreen}
            showQueue={queueHook.showQueue}
            onToggleQueue={() => queueHook.setShowQueue(!queueHook.showQueue)}
            onArtistClick={library.handleArtistClick}
            onAlbumClick={library.handleAlbumClick}
          />
        </div>
      </main>

      {queueHook.showQueue && (
        <QueuePanel
          queue={queueHook.queue}
          queueIndex={queueHook.queueIndex}
          queuePanelRef={queueHook.queuePanelRef}
          playlistName={queueHook.playlistName}
          pendingEnqueue={pendingEnqueue}
          onAllowAll={() => {
            if (pendingEnqueue) {
              if (pendingEnqueue.position != null) queueHook.insertAtPosition(pendingEnqueue.all, pendingEnqueue.position);
              else queueHook.enqueueTracks(pendingEnqueue.all);
            }
            setPendingEnqueue(null);
          }}
          onSkipDuplicates={() => {
            if (pendingEnqueue) {
              if (pendingEnqueue.position != null) queueHook.insertAtPosition(pendingEnqueue.unique, pendingEnqueue.position);
              else queueHook.enqueueTracks(pendingEnqueue.unique);
            }
            setPendingEnqueue(null);
          }}
          onCancelEnqueue={() => setPendingEnqueue(null)}
          onPlay={(track, index) => { queueHook.setQueueIndex(index); playback.handlePlay(track); }}
          onRemove={queueHook.removeFromQueue}
          onMoveMultiple={queueHook.moveMultiple}
          onClear={queueHook.clearQueue}
          onSavePlaylist={queueHook.savePlaylist}
          onLoadPlaylist={queueHook.loadPlaylist}
          onContextMenu={(e, indices) => {
            setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "queue-multi", indices } });
          }}
          externalDropTarget={externalDropTarget}
          collapsed={queueCollapsed}
          onToggleCollapsed={handleToggleQueueCollapsed}
        />
      )}

      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          providers={searchProviders}
          onPlay={handleContextPlay}
          onEnqueue={handleContextEnqueue}
          onShowInFolder={handleShowInFolder}
          onWatchOnYoutube={handleWatchOnYoutube}
          onShowProperties={handleShowProperties}
          onDelete={handleDeleteRequest}
          onRemoveFromQueue={handleQueueRemove}
          onMoveToTop={handleQueueMoveToTop}
          onMoveToBottom={handleQueueMoveToBottom}
          onLocateTrack={contextMenu.target.kind === "queue-multi" && contextMenu.target.indices.length === 1 ? () => {
            const track = queueHook.queue[contextMenu.target.kind === "queue-multi" ? contextMenu.target.indices[0] : 0];
            if (track?.artist_id) library.handleLocateTrack(track.id, track.artist_id, track.album_id);
          } : undefined}
          onDownload={contextMenu.target.kind === "track" ? (destId: number) => { const t = contextMenu.target; if (t.kind === "track") handleDownloadTrack(t.trackId, destId); } : undefined}
          onUpgradeViaTidal={tidalEnabled && contextMenu.target.kind === "track" && !contextMenu.target.subsonic ? () => {
            const t = contextMenu.target;
            if (t.kind === "track") {
              const track = tracks.find(tr => tr.id === t.trackId);
              if (track) setUpgradeTrack(track);
            }
          } : undefined}
          localCollections={localCollections}
          onClose={() => setContextMenu(null)}
        />
      )}

      {upgradeTrack && (
        <UpgradeTrackModal
          track={upgradeTrack}
          tidalOverrideUrl={tidalOverrideUrl}
          downloadFormat={downloadFormat}
          onClose={() => setUpgradeTrack(null)}
          onUpgraded={() => { setUpgradeTrack(null); library.loadTracks(); }}
        />
      )}

      {propertiesTrack && (
        <TrackPropertiesModal
          track={propertiesTrack}
          collections={library.collections}
          onClose={() => setPropertiesTrack(null)}
          onYoutubeUrlChange={(trackId, url) => {
            library.setTracks(prev => prev.map(t => t.id === trackId ? { ...t, youtube_url: url } : t));
            setPropertiesTrack(prev => prev && prev.id === trackId ? { ...prev, youtube_url: url } : prev);
          }}
        />
      )}

      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete {deleteConfirm.title}?</h2>
            <p className="delete-confirm-warning">This will permanently delete the file{deleteConfirm.trackIds.length > 1 ? "s" : ""} from disk.</p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className="modal-btn modal-btn-danger" onClick={handleDeleteConfirm}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {editingCollection && (
        <EditCollectionModal
          collection={editingCollection}
          onSave={handleSaveCollection}
          onClose={() => setEditingCollection(null)}
        />
      )}

      {removeCollectionConfirm && (
        <div className="modal-overlay" onClick={() => setRemoveCollectionConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Remove &ldquo;{removeCollectionConfirm.name}&rdquo;?</h2>
            <p className="delete-confirm-warning">This will permanently remove this collection and all its tracks from the library.</p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => setRemoveCollectionConfirm(null)}>Cancel</button>
              <button className="modal-btn modal-btn-danger" onClick={handleRemoveCollectionConfirm}>Remove</button>
            </div>
          </div>
        </div>
      )}

      {playback.playbackError && (
        <div className="playback-error-banner">
          <span>{playback.playbackError}</span>
          <button onClick={playback.clearPlaybackError}>{"\u2715"}</button>
        </div>
      )}

      <NowPlayingBar
        waveformPeaks={waveformPeaks}
        currentTrack={playback.currentTrack}
        playing={playback.playing}
        positionSecs={playback.positionSecs}
        durationSecs={playback.durationSecs}
        scrobbled={playback.scrobbled}
        volume={playback.volume}
        queueMode={queueHook.queueMode}
        autoContinueEnabled={autoContinue.enabled}
        autoContinueSameFormat={autoContinue.sameFormat}
        showAutoContinuePopover={autoContinue.showPopover}
        autoContinueWeights={autoContinue.weights}
        imagePath={
          (playback.currentTrack?.album_id && albumImageCache.images[playback.currentTrack.album_id])
          || (playback.currentTrack?.artist_id && artistImageCache.images[playback.currentTrack.artist_id])
          || null
        }
        miniMode={mini.miniMode}
        onToggleMiniMode={mini.toggleMiniMode}
        onClose={() => getCurrentWindow().close()}
        onPause={playback.handlePause}
        onStop={playback.handleStop}
        onNext={handleNext}
        onPrevious={queueHook.playPrevious}
        onSeek={playback.handleSeek}
        onVolume={playback.handleVolume}
        onMute={() => {
          if (playback.volume > 0) {
            previousVolumeRef.current = playback.volume;
            playback.handleVolume(0);
          } else {
            playback.handleVolume(previousVolumeRef.current || 1.0);
          }
        }}
        onToggleQueueMode={queueHook.toggleQueueMode}
        onToggleAutoContinue={() => autoContinue.setEnabled(!autoContinue.enabled)}
        onToggleAutoContinueSameFormat={() => autoContinue.setSameFormat(!autoContinue.sameFormat)}
        onToggleAutoContinuePopover={() => autoContinue.setShowPopover(!autoContinue.showPopover)}
        onAdjustAutoContinueWeight={autoContinue.adjustWeight}
        onToggleLike={() => playback.currentTrack && handleToggleLike(playback.currentTrack)}
        onToggleDislike={() => playback.currentTrack && handleToggleDislike(playback.currentTrack)}
        onArtistClick={library.handleArtistClick}
        onAlbumClick={library.handleAlbumClick}
      />

      <StatusBar
        sessionLog={sessionLog}
        activity={statusActivity}
        feedback={youtubeFeedback ? {
          message: `Was "${youtubeFeedback.videoTitle}" the right video?`,
          onYes: () => handleYoutubeFeedback(true),
          onNo: () => handleYoutubeFeedback(false),
        } : null}
        downloadStatus={downloadStatus}
        onCancelDownload={async (id) => { await invoke("cancel_download", { downloadId: id }); invoke<typeof downloadStatus>("get_download_status").then(setDownloadStatus); }}
      />

    </div>
  );
}

export default App;
