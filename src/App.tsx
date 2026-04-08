import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrent as getDeepLinkCurrent } from "@tauri-apps/plugin-deep-link";
import { listen } from "@tauri-apps/api/event";
import "./base.css";
import "./App.css";

import type { Track, View, ViewMode, ColumnConfig, SortField, SortDir, ArtistSortField, AlbumSortField, TagSortField } from "./types";
import { isVideoTrack, parseSubsonicUrl, stripAccents } from "./utils";
import { store } from "./store";
import { parseUrlScheme, queueEntryToTrack, trackToQueueEntry, type QueueEntry } from "./queueEntry";
import type { SearchProviderConfig } from "./searchProviders";
import { DEFAULT_PROVIDERS, loadProviders, saveProviders } from "./searchProviders";
import { timeAsync, getTimingEntries, type TimingEntry } from "./startupTiming";

import { usePlayback } from "./hooks/usePlayback";
import { useQueue } from "./hooks/useQueue";
import { useLibrary, DEFAULT_TRACK_COLUMNS, ALBUM_DETAIL_COLUMNS, TAG_DETAIL_COLUMNS } from "./hooks/useLibrary";
import { useEventListeners } from "./hooks/useEventListeners";
import { useImageCache } from "./hooks/useImageCache";
import { useAutoContinue } from "./hooks/useAutoContinue";
import { usePasteImage } from "./hooks/usePasteImage";
import { useNavigationHistory, type NavState } from "./hooks/useNavigationHistory";
import { useSessionLog } from "./hooks/useSessionLog";
import { useAppUpdater } from "./hooks/useAppUpdater";
import { useMiniMode } from "./hooks/useMiniMode";
import { useVideoLayout } from "./hooks/useVideoLayout";
import type { VideoLayoutState } from "./hooks/useVideoLayout";
import { useWaveform } from "./hooks/useWaveform";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useSkins } from "./hooks/useSkins";
import { usePlugins, type PluginHostCallbacks } from "./hooks/usePlugins";

import { useDownloads } from "./hooks/useDownloads";
import { useLikeActions } from "./hooks/useLikeActions";
import { useCollectionActions } from "./hooks/useCollectionActions";
import { useArtistInfo } from "./hooks/useArtistInfo";
import { useContextMenuActions } from "./hooks/useContextMenuActions";
import type { TidalSearchTrackLike } from "./types/plugin";
import { useViewSearchState } from "./hooks/useViewSearchState";
import { useCentralSearch } from "./hooks/useCentralSearch";
import { CaptionBar } from "./components/CaptionBar";
import { ViewSearchBar } from "./components/ViewSearchBar";

import { Sidebar } from "./components/Sidebar";
import { TrackList } from "./components/TrackList";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { QueuePanel } from "./components/QueuePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { FullscreenControls } from "./components/FullscreenControls";
import { AddServerModal } from "./components/AddServerModal";
import { ContextMenu } from "./components/ContextMenu";
import { Breadcrumb } from "./components/Breadcrumb";
import { ArtistListView } from "./components/ArtistListView";
import { AlbumListView } from "./components/AlbumListView";
import { TagListView } from "./components/TagListView";
import { AllTracksView } from "./components/AllTracksView";
import { LikedTracksView } from "./components/LikedTracksView";
import { ArtistDetailContent } from "./components/ArtistDetailContent";
import { ViewModeToggle } from "./components/ViewModeToggle";
import { ImageActions } from "./components/ImageActions";
import { AlbumDetailHeader } from "./components/AlbumDetailHeader";
import { HistoryView } from "./components/HistoryView";
import type { HistoryViewHandle } from "./components/HistoryView";
import { CollectionsView } from "./components/CollectionsView";
import { EditCollectionModal } from "./components/EditCollectionModal";
import { PluginViewRenderer } from "./components/PluginViewRenderer";
import { TrackDetailView } from "./components/TrackDetailView";
import { UpgradeTrackModal } from "./components/UpgradeTrackModal";
import BulkEditModal from "./components/BulkEditModal";
import PlaybackErrorModal from "./components/PlaybackErrorModal";

import { StatusBar } from "./components/StatusBar";


function App() {
  const restoredRef = useRef(false);
  const [appRestoring, setAppRestoring] = useState(true);
  const [navError, setNavError] = useState<string | null>(null);
  const pendingRestoreTrackRef = useRef<Track | null>(null);
  const pendingRestoreQueueRef = useRef<{ tracks: Track[]; index: number } | null>(null);
  const trackListRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const getScrollEl = useCallback(() => {
    const el = contentRef.current;
    if (!el) return null;
    return el.querySelector<HTMLElement>('.track-list, .entity-list, .entity-table, .album-grid, .artist-detail, .history-view, .collections-view, .plugin-view');
  }, []);
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
  const [loggingEnabled, setLoggingEnabled] = useState(false);
  trackVideoHistoryRef.current = trackVideoHistory;
  const advanceIndexRef = useRef<() => void>(() => {});
  const resolveTrackSrcRef = useRef<(track: Track) => Promise<string>>(async (track) => {
    const parsed = parseUrlScheme(track.url ?? track.path);
    if (parsed.scheme === "file") return convertFileSrc(parsed.path);
    if (parsed.scheme === "tidal") return invoke<string>("tidal_get_stream_url", { tidalTrackId: parsed.id, quality: null });
    return invoke<string>("resolve_subsonic_location", { location: parsed.url });
  });
  const playback = usePlayback(restoredRef, peekNextRef, crossfadeSecsRef, advanceIndexRef, trackVideoHistoryRef, resolveTrackSrcRef);
  const waveformPeaks = useWaveform(
    playback.currentTrack?.id ?? null,
    playback.currentTrack?.file_size ?? null,
    playback.currentTrack ? playback.currentTrack.path.startsWith("subsonic://") || playback.currentTrack.path.startsWith("tidal://") : false,
    playback.currentTrack ? isVideoTrack(playback.currentTrack) : false,
    playback.currentAssetUrl,
  );
  const [trackRank, setTrackRank] = useState<number | null>(null);
  const [artistRank, setArtistRank] = useState<number | null>(null);

  useEffect(() => {
    setTrackRank(null);
    setArtistRank(null);
    const track = playback.currentTrack;
    if (!track) return;
    let cancelled = false;
    Promise.all([
      invoke<number | null>("get_track_rank", { trackId: track.id }),
      track.artist_id
        ? invoke<number | null>("get_artist_rank", { artistId: track.artist_id })
        : Promise.resolve(null),
    ]).then(([tRank, aRank]) => {
      if (!cancelled) { setTrackRank(tRank); setArtistRank(aRank); }
    }).catch(console.error);
    return () => { cancelled = true; };
  }, [playback.currentTrack]);

  useEffect(() => {
    if (!playback.scrobbled) return;
    const track = playback.currentTrack;
    if (!track) return;
    let cancelled = false;
    Promise.all([
      invoke<number | null>("get_track_rank", { trackId: track.id }),
      track.artist_id
        ? invoke<number | null>("get_artist_rank", { artistId: track.artist_id })
        : Promise.resolve(null),
    ]).then(([tRank, aRank]) => {
      if (!cancelled) { setTrackRank(tRank); setArtistRank(aRank); }
    }).catch(console.error);
    return () => { cancelled = true; };
  }, [playback.scrobbled]);

  const beforeNavRef = useRef<() => void>(() => {});
  const viewSearch = useViewSearchState();
  const [currentView, setCurrentView] = useState<View>("all");
  // Only pass debouncedTrackQuery for views that need server-side track search
  const needsServerSearch = currentView === "all" || currentView === "liked";

  // Need to initialize library first to get selection state, then artistInfo will compute popularity
  const [trackPopularityState, setTrackPopularityState] = useState<Record<number, number>>({});
  const library = useLibrary(restoredRef, () => beforeNavRef.current(), needsServerSearch ? viewSearch.getDebouncedQuery(currentView) : "", trackPopularityState, setNavError);

  const queueHook = useQueue(restoredRef, playback.handlePlay, library.collections);
  const autoContinue = useAutoContinue(restoredRef);
  const mini = useMiniMode(restoredRef, playback.currentTrack);
  const videoLayout = useVideoLayout(restoredRef);

  // Plugin system
  const pluginTrackRef = useRef<Track | null>(null);
  pluginTrackRef.current = playback.currentTrack;
  const pluginPlayingRef = useRef(false);
  pluginPlayingRef.current = playback.playing;
  const pluginPositionRef = useRef(0);
  pluginPositionRef.current = playback.positionSecs;
  const tidalIdCounterRef = useRef(-1);
  const tidalTrackToTrackFn = useCallback((info: TidalSearchTrackLike): Track => {
    const id = tidalIdCounterRef.current--;
    return {
      id,
      path: `tidal://${info.tidal_id}`,
      title: info.title,
      artist_id: null,
      artist_name: info.artist_name ?? null,
      album_id: null,
      album_title: info.album_title ?? null,
      year: null,
      track_number: info.track_number ?? null,
      duration_secs: info.duration_secs ?? null,
      format: null,
      file_size: null,
      collection_id: null,
      collection_name: null,
      liked: 0,
      youtube_url: null,
      added_at: null,
      modified_at: null,
      relative_path: null,
    };
  }, []);
  const downloadFormatRef = useRef("flac");
  const pluginPlaybackCallbacks = useMemo(() => ({
    playTidalTrack: (track: TidalSearchTrackLike) => {
      queueHook.playTracks([tidalTrackToTrackFn(track)], 0);
    },
    enqueueTidalTrack: (track: TidalSearchTrackLike) => {
      queueHook.enqueueTracks([tidalTrackToTrackFn(track)]);
    },
    playTidalTracks: (tracks: TidalSearchTrackLike[], startIndex?: number) => {
      queueHook.playTracks(tracks.map(tidalTrackToTrackFn), startIndex ?? 0);
    },
    getDownloadFormat: () => downloadFormatRef.current,
  }), [queueHook, tidalTrackToTrackFn]);
  const pluginHostCallbacksRef = useRef<PluginHostCallbacks | undefined>(undefined);
  const plugins = usePlugins(pluginTrackRef, pluginPlayingRef, pluginPositionRef, pluginPlaybackCallbacks, pluginHostCallbacksRef.current);

  const artistInfo = useArtistInfo({
    selectedArtist: library.selectedArtist,
    selectedAlbum: library.selectedAlbum,
    artists: library.artists,
    albums: library.albums,
    tracks: library.tracks,
    invokeInfoFetch: plugins.invokeInfoFetch,
  });

  // Update trackPopularity state when artistInfo changes
  useEffect(() => {
    setTrackPopularityState(artistInfo.trackPopularity);
  }, [artistInfo.trackPopularity]);

  // Plugin event: track started
  const prevTrackIdRef = useRef<number | null>(null);
  useEffect(() => {
    const track = playback.currentTrack;
    if (track && track.id !== prevTrackIdRef.current) {
      prevTrackIdRef.current = track.id;
      plugins.dispatchEvent("track:started", track);
    }
  }, [playback.currentTrack, plugins.dispatchEvent]);

  // Plugin event: track played (scrobble threshold) and scrobbled
  useEffect(() => {
    if (!playback.scrobbled) return;
    const track = playback.currentTrack;
    if (!track) return;
    plugins.dispatchEvent("track:played", track);
    plugins.dispatchEvent("track:scrobbled", track);
  }, [playback.scrobbled, playback.currentTrack, plugins.dispatchEvent]);

  // Sync currentView with library.view so debouncedTrackQuery stays up to date
  useEffect(() => { setCurrentView(library.view); }, [library.view]);

  // Reset scroll position when view or selections change
  const currentSearchQuery = viewSearch.getQuery(library.view);
  useEffect(() => {
    // Use rAF to ensure the new view's DOM has rendered
    requestAnimationFrame(() => {
      const sc = getScrollEl();
      if (sc) sc.scrollTop = 0;
    });
  }, [library.view, library.selectedArtist, library.selectedAlbum, library.selectedTag, library.selectedTrack, currentSearchQuery, getScrollEl]);

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
      library.setSelectedTrack(null);
      viewSearch.setQuery("all", query);
    },
    onNavigateToArtist: (artistId) => {
      library.handleArtistClick(artistId);
    },
    onNavigateToAlbum: (albumId, artistId) => {
      library.handleAlbumClick(albumId, artistId);
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
  const [artistSections, setArtistSections] = useState<Record<string, boolean>>({ topSongs: true, about: true, albums: true, similarArtists: true });
  const handleToggleArtistSection = (key: string) => {
    setArtistSections(prev => {
      const next = { ...prev, [key]: !prev[key] };
      store.set("artistSections", next);
      return next;
    });
  };
  const [albumDetailColumns, setAlbumDetailColumns] = useState(ALBUM_DETAIL_COLUMNS);
  const [tagDetailColumns, setTagDetailColumns] = useState(TAG_DETAIL_COLUMNS);
  const [trackSections, setTrackSections] = useState<Record<string, boolean>>({ lyrics: true, tags: true, scrobbleHistory: true, similar: true });
  const handleToggleTrackSection = (key: string) => {
    setTrackSections(prev => {
      const next = { ...prev, [key]: !prev[key] };
      store.set("trackSections", next);
      return next;
    });
  };
  const [detailTrack, setDetailTrack] = useState<Track | null>(null);
  const [syncWithPlaying, setSyncWithPlaying] = useState(false);
  const [showAddServer, setShowAddServer] = useState(false);
  const [deepLinkServer, setDeepLinkServer] = useState<{ url: string; username: string; password: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const { sessionLog, addLog } = useSessionLog();
  const [searchProviders, setSearchProviders] = useState<SearchProviderConfig[]>(DEFAULT_PROVIDERS);
  const [backendTimings, setBackendTimings] = useState<TimingEntry[]>([]);

  const [showHelp, setShowHelp] = useState(false);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const [queueWidth, setQueueWidth] = useState(300);

  // Updater
  const updater = useAppUpdater(addLog);

  // Skins
  const skins = useSkins();

  // Downloads
  const downloads = useDownloads(downloadFormatRef, addLog);

  // Like actions
  const likeActions = useLikeActions({
    library: {
      tracks: library.tracks,
      artists: library.artists,
      albums: library.albums,
      tags: library.tags,
      setTracks: library.setTracks,
      setArtists: library.setArtists,
      setAlbums: library.setAlbums,
      setTags: library.setTags,
    },
    playback: {
      currentTrack: playback.currentTrack,
      setCurrentTrack: playback.setCurrentTrack,
    },
    queueHook: {
      setQueue: queueHook.setQueue,
    },
    plugins: {
      dispatchEvent: plugins.dispatchEvent,
    },
  });

  // Collection actions
  const collectionActions = useCollectionActions({
    library: {
      loadLibrary: library.loadLibrary,
      loadTracks: library.loadTracks,
    },
    playback: {
      currentTrack: playback.currentTrack,
      handleStop: playback.handleStop,
    },
    queueHook: {
      setQueue: queueHook.setQueue,
    },
  });

  // Context menu actions
  const contextMenuActions = useContextMenuActions({
    library: {
      tracks: library.tracks,
      sortedTracks: library.sortedTracks,
      artists: library.artists,
      albums: library.albums,
      setTracks: library.setTracks,
    },
    queueHook: {
      playTracks: queueHook.playTracks,
      enqueueTracks: queueHook.enqueueTracks,
      findDuplicates: queueHook.findDuplicates,
      insertAtPosition: queueHook.insertAtPosition,
      removeMultiple: queueHook.removeMultiple,
      moveToTop: queueHook.moveToTop,
      moveToBottom: queueHook.moveToBottom,
      queue: queueHook.queue,
      addToQueue: queueHook.addToQueue,
    },
    playback: {
      currentTrack: playback.currentTrack,
      handleStop: playback.handleStop,
    },
    addLog,
    queueCollapsed,
    setQueueCollapsed,
  });

  const handleDeleteTracks = useCallback((trackIds: number[]) => {
    const idSet = new Set(trackIds);
    const selected = library.tracks.filter(t => idSet.has(t.id));
    const localIds = selected.filter(t => !t.path.startsWith("subsonic://") && !t.path.startsWith("tidal://")).map(t => t.id);
    if (localIds.length === 0) return;
    const title = localIds.length === 1
      ? (selected.find(t => t.id === localIds[0])?.title ?? "track")
      : `${localIds.length} tracks`;
    contextMenuActions.setDeleteConfirm({ trackIds: localIds, title });
  }, [library.tracks, contextMenuActions.setDeleteConfirm]);

  // Wire plugin host callbacks (uses addLog, library, contextMenuActions defined above)
  pluginHostCallbacksRef.current = {
    navigateToPluginView: (pluginId, viewId) => {
      library.setView(`plugin:${pluginId}:${viewId}`);
      library.setSelectedArtist(null);
      library.setSelectedAlbum(null);
      library.setSelectedTag(null);
    },
    requestAction: (_pluginId, action, payload) => {
      if (action === "upgrade-track") {
        const trackId = payload.trackId as number;
        if (trackId) {
          const track = library.tracks.find(t => t.id === trackId);
          if (track) contextMenuActions.setUpgradeTrack(track);
        }
      }
    },
    showNotification: (message) => {
      addLog(message);
    },
  };

  async function handleImportSkin() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Skin Files", extensions: ["json"] }],
    });
    if (selected) {
      const result = await skins.importSkin(selected as string);
      if (!result.ok) {
        console.error("Skin import failed:", result.error);
      }
    }
  }

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

  // Resolve a queue track's url to a playable source
  useEffect(() => {
    resolveTrackSrcRef.current = async (track: Track) => {
      const url = track.url!;
      const parsed = parseUrlScheme(url);

      if (parsed.scheme === "file") {
        return convertFileSrc(parsed.path);
      } else if (parsed.scheme === "tidal") {
        return invoke<string>("tidal_get_stream_url", {
          tidalTrackId: parsed.id,
          quality: null,
        });
      } else if (parsed.scheme === "subsonic") {
        return invoke<string>("resolve_subsonic_location", {
          location: url,
        });
      } else {
        const _exhaustive: never = parsed;
        throw new Error(`Unhandled scheme: ${(_exhaustive as any).scheme}`);
      }
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
    library.setSelectedTrack(s.selectedTrack ?? null);
    viewSearch.restore(s.viewSearchQueries);
    // Restore scroll position after React renders the new view
    requestAnimationFrame(() => {
      const sc = getScrollEl();
      if (sc) sc.scrollTop = s.scrollTop;
    });
  }, [library.setView, library.setSelectedArtist, library.setSelectedAlbum, library.setSelectedTag, library.setSelectedTrack, viewSearch.restore, getScrollEl]);

  const getScrollTop = useCallback(() => getScrollEl()?.scrollTop ?? 0, [getScrollEl]);

  const { pushState, goBack, goForward, canGoBack, canGoForward } = useNavigationHistory(
    {
      view: library.view,
      selectedArtist: library.selectedArtist,
      selectedAlbum: library.selectedAlbum,
      selectedTag: library.selectedTag,
      selectedTrack: library.selectedTrack,
      viewSearchQueries: viewSearch.snapshot(),
    },
    applyNavState,
    getScrollTop,
  );

  // Push history and reset scroll for the new view.
  // Used by all navigation triggers (sidebar, keyboard, click handlers).
  const pushAndScroll = useCallback(() => {
    pushState();
    const sc = getScrollEl();
    if (sc) sc.scrollTop = 0;
  }, [pushState, getScrollEl]);
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

  // Listen for deep link events
  useEffect(() => {
    const handled = new Set<string>();
    function handleDeepLink(urls: string[]) {
      for (const raw of urls) {
        if (handled.has(raw)) continue;
        handled.add(raw);
        console.log("[deep-link] received:", raw);
        // Handle Subsonic deep links
        const parsed = parseSubsonicUrl(raw);
        if (parsed) {
          setDeepLinkServer({ url: parsed.serverUrl, username: parsed.username, password: parsed.password });
          setShowAddServer(true);
          break;
        }
        // Forward viboplr:// deep links to plugins
        if (raw.startsWith("viboplr://")) {
          plugins.forwardDeepLink(raw);
        }
      }
    }
    const unlistenEvent = listen<string>("deep-link-received", (event) => {
      handleDeepLink([event.payload]);
    });
    // Check for URLs that arrived before listeners were registered
    getDeepLinkCurrent().then((urls) => {
      if (urls && urls.length > 0) handleDeepLink(urls);
    }).catch(() => {});
    return () => {
      unlistenEvent.then(f => f());
    };
  }, [plugins.forwardDeepLink]);

  // Restore persisted state on mount
  useEffect(() => {
    (async () => {
      try {
        await timeAsync("store.init", () => store.init());
        const [v, sa, sal, st, savedTrackEntry, vol, qEntries, qIdx, qMode, _pos, cf, savedTrackVideoHistory, wasMini, fww, fwh, fwx, fwy, tSortField, tSortDir, tCols, savedPlaylistName, savedArtistViewMode, savedAlbumViewMode, savedTagViewMode, savedTrackViewMode, savedLikedViewMode, savedVideoLayout, savedVideoSplitHeight, savedSidebarCollapsed, savedQueueCollapsed, savedQueueWidth, savedDownloadFormat, savedSortBarCollapsed, savedArtistSortField, savedArtistSortDir, savedArtistLikedFirst, savedAlbumSortField, savedAlbumSortDir, savedAlbumLikedFirst, savedTagSortField, savedTagSortDir, savedTagLikedFirst, savedFilterYoutubeOnly, savedMediaTypeFilter, savedTrackLikedFirst, savedSearchIncludeLyrics] = await timeAsync("store.restore (45 keys)", () => Promise.all([
          store.get<string>("view"),
          store.get<number | null>("selectedArtist"),
          store.get<number | null>("selectedAlbum"),
          store.get<number | null>("selectedTag"),
          store.get<QueueEntry | null>("currentTrackEntry"),
          store.get<number>("volume"),
          store.get<QueueEntry[]>("queueEntries"),
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
          store.get<string | null>("playlistName"),
          store.get<string | null>("artistViewMode"),
          store.get<string | null>("albumViewMode"),
          store.get<string | null>("tagViewMode"),
          store.get<string | null>("trackViewMode"),
          store.get<string | null>("likedViewMode"),
          store.get<VideoLayoutState | null>("videoLayout"),
          store.get<number | null>("videoSplitHeight"),
          store.get<boolean>("sidebarCollapsed"),
          store.get<boolean>("queueCollapsed"),
          store.get<number | null>("queueWidth"),
          store.get<string | null>("downloadFormat"),
          store.get<boolean>("sortBarCollapsed"),
          store.get<string | null>("artistSortField"),
          store.get<string>("artistSortDir"),
          store.get<boolean>("artistLikedFirst"),
          store.get<string | null>("albumSortField"),
          store.get<string>("albumSortDir"),
          store.get<boolean>("albumLikedFirst"),
          store.get<string | null>("tagSortField"),
          store.get<string>("tagSortDir"),
          store.get<boolean>("tagLikedFirst"),
          store.get<boolean>("filterYoutubeOnly"),
          store.get<string>("mediaTypeFilter"),
          store.get<boolean>("trackLikedFirst"),
          store.get<boolean | null>("searchIncludeLyrics"),
        ]));
        if (v && ["all", "artists", "albums", "tags", "liked", "history"].includes(v)) library.setView(v as View);
        if (sa !== undefined && sa !== null) {
          library.setSelectedArtist(sa);
        }
        if (sal !== undefined && sal !== null) library.setSelectedAlbum(sal);
        if (st !== undefined && st !== null) library.setSelectedTag(st);
        if (vol !== undefined && vol !== null) playback.setVolume(vol);
        if (cf !== undefined && cf !== null) setCrossfadeSecs(cf);
        if (savedTrackVideoHistory) setTrackVideoHistory(true);

        // One-time migration: move Last.fm session from app store to plugin storage
        const [migrateSessionKey, migrateUsername, migrateAutoEnabled, migrateAutoInterval, migrateLastImportAt] = await Promise.all([
          store.get<string | null>("lastfmSessionKey"),
          store.get<string | null>("lastfmUsername"),
          store.get<boolean>("lastfmAutoImportEnabled"),
          store.get<number>("lastfmAutoImportIntervalMins"),
          store.get<number | null>("lastfmLastImportAt"),
        ]);
        if (migrateSessionKey && migrateUsername) {
          invoke("plugin_storage_set", {
            pluginId: "lastfm",
            key: "lastfm_session",
            value: JSON.stringify({ sessionKey: migrateSessionKey, username: migrateUsername }),
          }).catch(console.error);
          if (migrateAutoEnabled || migrateAutoInterval || migrateLastImportAt) {
            invoke("plugin_storage_set", {
              pluginId: "lastfm",
              key: "lastfm_auto_import",
              value: JSON.stringify({
                enabled: !!migrateAutoEnabled,
                intervalMins: migrateAutoInterval || 60,
                lastImportAt: migrateLastImportAt ?? null,
              }),
            }).catch(console.error);
          }
          store.set("lastfmSessionKey", null);
          store.set("lastfmUsername", null);
          store.set("lastfmAutoImportEnabled", null);
          store.set("lastfmAutoImportIntervalMins", null);
          store.set("lastfmLastImportAt", null);
        }

        if (tSortField && ["num", "title", "artist", "album", "duration", "path", "year", "quality", "size", "collection", "added", "modified", "random"].includes(tSortField)) library.setSortField(tSortField as SortField);
        if (tSortDir && ["asc", "desc"].includes(tSortDir)) library.setSortDir(tSortDir as SortDir);
        if (tCols && Array.isArray(tCols) && tCols.length > 0) {
          // Merge in any new columns that weren't in the saved config
          const savedIds = new Set(tCols.map((c: ColumnConfig) => c.id));
          const missing = DEFAULT_TRACK_COLUMNS.filter(c => !savedIds.has(c.id));
          library.setTrackColumns([...tCols, ...missing]);
        }

        // Allow mutation for migration
        let queueEntries = qEntries;

        // Migration: if old queueTrackIds exists, convert to queueEntries
        if (!queueEntries) {
          const oldIds = await store.get<number[]>("queueTrackIds");
          if (oldIds?.length) {
            const oldTracks = await invoke<Track[]>("get_tracks_by_ids", { ids: oldIds }).catch(() => []);
            if (oldTracks.length) {
              const entries: QueueEntry[] = oldTracks.map(t => ({
                url: `file://${t.path}`,
                title: t.title,
                artist_name: t.artist_name,
                album_title: t.album_title,
                duration_secs: t.duration_secs,
                track_number: t.track_number,
                year: t.year,
                format: t.format,
              }));
              await store.set("queueEntries", entries);
              queueEntries = entries;
            }
          }
        }

        // Migration: rename old "location" field to "url" in persisted entries
        if (queueEntries?.length && "location" in (queueEntries as any[])[0] && !("url" in (queueEntries as any[])[0])) {
          queueEntries = (queueEntries as any[]).map(e => ({ ...e, url: e.location }));
          await store.set("queueEntries", queueEntries);
        }

        // Restore queue from QueueEntry[] — convert to Track[], re-resolve file:// from DB
        let restoredTracks: Track[] = [];
        if (queueEntries?.length) {
          const entries = queueEntries as QueueEntry[];
          const minimalTracks = entries.map(e => queueEntryToTrack(e));

          // Collect file:// and subsonic:// URIs for bulk DB lookup to get full metadata
          const libraryPaths = entries
            .filter(e => e.url.startsWith("file://") || e.url.startsWith("subsonic://"))
            .map(e => e.url);

          let dbTracks: Track[] = [];
          if (libraryPaths.length > 0) {
            dbTracks = await invoke<Track[]>("get_tracks_by_paths", { paths: libraryPaths }).catch(() => []);
          }
          const dbByPath = new Map(dbTracks.map(t => [t.path, t]));

          restoredTracks = minimalTracks.map((t, i) => {
            const entry = entries[i];
            const dbTrack = dbByPath.get(t.path);
            if (dbTrack) return { ...dbTrack, url: entry.url };
            return t; // tidal or not in library
          });
        }

        // Migrate savedTrackEntry from old "location" field to "url"
        let currentTrackEntry = savedTrackEntry;
        if (currentTrackEntry && "location" in (currentTrackEntry as any) && !("url" in (currentTrackEntry as any))) {
          currentTrackEntry = { ...currentTrackEntry, url: (currentTrackEntry as any).location } as QueueEntry;
        }

        // Restore current track from queue or saved entry (no DB ID lookup)
        const idx = qIdx ?? -1;
        const currentFromQueue = idx >= 0 && idx < restoredTracks.length ? restoredTracks[idx] : null;
        const restoredTrack = currentFromQueue ?? (currentTrackEntry ? queueEntryToTrack(currentTrackEntry) : null);

        // Store in refs — state will be applied in a separate effect after appRestoring flips
        if (restoredTrack) {
          pendingRestoreTrackRef.current = restoredTrack;
        }
        if (restoredTracks.length) {
          pendingRestoreQueueRef.current = { tracks: restoredTracks, index: idx >= 0 && idx < restoredTracks.length ? idx : -1 };
        }

        if (qMode && ["normal", "loop", "shuffle"].includes(qMode)) {
          queueHook.setQueueMode(qMode as "normal" | "loop" | "shuffle");
        }
        if (savedPlaylistName) queueHook.setPlaylistName(savedPlaylistName);
        if (savedArtistViewMode && ["basic", "list", "tiles"].includes(savedArtistViewMode)) library.setArtistViewMode(savedArtistViewMode as ViewMode);
        if (savedAlbumViewMode && ["basic", "list", "tiles"].includes(savedAlbumViewMode)) library.setAlbumViewMode(savedAlbumViewMode as ViewMode);
        if (savedTagViewMode && ["basic", "list", "tiles"].includes(savedTagViewMode)) library.setTagViewMode(savedTagViewMode as ViewMode);
        if (savedTrackViewMode && ["basic", "list", "tiles"].includes(savedTrackViewMode)) library.setTrackViewMode(savedTrackViewMode as ViewMode);
        if (savedLikedViewMode && ["basic", "list", "tiles"].includes(savedLikedViewMode)) library.setLikedViewMode(savedLikedViewMode as ViewMode);
        // Restore per-view sort & filter state
        if (savedArtistSortField && ["name", "tracks", "random"].includes(savedArtistSortField)) library.setArtistSortField(savedArtistSortField as ArtistSortField);
        if (savedArtistSortDir && ["asc", "desc"].includes(savedArtistSortDir)) library.setArtistSortDir(savedArtistSortDir as SortDir);
        if (savedArtistLikedFirst) library.setArtistLikedFirst(true);
        if (savedAlbumSortField && ["name", "artist", "year", "tracks", "random"].includes(savedAlbumSortField)) library.setAlbumSortField(savedAlbumSortField as AlbumSortField);
        if (savedAlbumSortDir && ["asc", "desc"].includes(savedAlbumSortDir)) library.setAlbumSortDir(savedAlbumSortDir as SortDir);
        if (savedAlbumLikedFirst) library.setAlbumLikedFirst(true);
        if (savedTagSortField && ["name", "tracks", "random"].includes(savedTagSortField)) library.setTagSortField(savedTagSortField as TagSortField);
        if (savedTagSortDir && ["asc", "desc"].includes(savedTagSortDir)) library.setTagSortDir(savedTagSortDir as SortDir);
        if (savedTagLikedFirst) library.setTagLikedFirst(true);
        if (savedFilterYoutubeOnly) library.setFilterYoutubeOnly(true);
        if (savedMediaTypeFilter && ["all", "audio", "video"].includes(savedMediaTypeFilter)) library.setMediaTypeFilter(savedMediaTypeFilter as "all" | "audio" | "video");
        if (savedTrackLikedFirst) library.setTrackLikedFirst(true);
        if (savedSearchIncludeLyrics === false) library.setSearchIncludeLyrics(false);
        if (savedVideoLayout) {
          videoLayout.restoreLayout(savedVideoLayout);
        } else if (savedVideoSplitHeight && savedVideoSplitHeight > 0) {
          videoLayout.migrateFromSplitHeight(savedVideoSplitHeight);
          store.set("videoSplitHeight", null);
        }
        if (savedSidebarCollapsed) setSidebarCollapsed(true);
        if (savedQueueCollapsed) setQueueCollapsed(true);
        if (savedQueueWidth && savedQueueWidth >= 200 && savedQueueWidth <= 600) setQueueWidth(savedQueueWidth);
        if (savedDownloadFormat && ["flac", "aac"].includes(savedDownloadFormat)) { downloads.setFormat(savedDownloadFormat, store); }
        if (savedSortBarCollapsed) library.setSortBarCollapsed(true);
        const savedLoggingEnabled = await store.get<boolean>("loggingEnabled");
        if (savedLoggingEnabled) setLoggingEnabled(true);
        const savedArtistSections = await store.get<Record<string, boolean>>("artistSections");
        if (savedArtistSections) setArtistSections(savedArtistSections);
        const savedTrackSections = await store.get<Record<string, boolean>>("trackSections");
        if (savedTrackSections) setTrackSections(savedTrackSections);
        const savedSyncWithPlaying = await store.get<boolean>("syncWithPlaying");
        if (savedSyncWithPlaying != null) setSyncWithPlaying(savedSyncWithPlaying);
        const savedSelectedTrack = await store.get<number | null>("selectedTrack");
        if (savedSelectedTrack != null) library.setSelectedTrack(savedSelectedTrack);
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

  // Apply pending restore state once appRestoring flips to false
  useEffect(() => {
    if (appRestoring) return;
    const track = pendingRestoreTrackRef.current;
    const queue = pendingRestoreQueueRef.current;
    if (track) {
      playback.setCurrentTrack(track);
      playback.setDurationSecs(track.duration_secs ?? 0);
      pendingRestoreTrackRef.current = null;
    }
    if (queue) {
      queueHook.setQueue(queue.tracks);
      queueHook.setQueueIndex(queue.index);
      pendingRestoreQueueRef.current = null;
    }
  }, [appRestoring]);

  // Persist current track as QueueEntry (location + metadata, no DB IDs)
  useEffect(() => {
    if (!restoredRef.current) return;
    if (playback.currentTrack) {
      store.set("currentTrackEntry", trackToQueueEntry(playback.currentTrack, library.collections));
    } else {
      store.set("currentTrackEntry", null);
    }
  }, [playback.currentTrack]);

  // Forward frontend errors to backend log file
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      invoke("write_frontend_log", { level: "error", message: `${e.message} at ${e.filename}:${e.lineno}` }).catch(() => {});
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      invoke("write_frontend_log", { level: "error", message: `Unhandled rejection: ${e.reason}` }).catch(() => {});
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
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

  // Resolve track for the detail view — try local lookups (sync), fall back to backend (async)
  const detailTrackLocal = useMemo(() => {
    if (library.selectedTrack === null) return null;
    return library.tracks.find(t => t.id === library.selectedTrack)
      ?? (playback.currentTrack?.id === library.selectedTrack ? playback.currentTrack : null)
      ?? null;
  }, [library.selectedTrack, library.tracks, playback.currentTrack]);

  useEffect(() => {
    if (library.selectedTrack === null) { setDetailTrack(null); return; }
    if (detailTrackLocal) { setDetailTrack(detailTrackLocal); return; }
    // Fetch from backend as last resort
    let cancelled = false;
    invoke<Track>("get_track_by_id", { trackId: library.selectedTrack })
      .then(t => { if (!cancelled) setDetailTrack(t); })
      .catch(() => { if (!cancelled) setDetailTrack(null); });
    return () => { cancelled = true; };
  }, [library.selectedTrack, detailTrackLocal]);

  // Sync detail view with currently playing track
  const syncRef = useRef(syncWithPlaying);
  syncRef.current = syncWithPlaying;
  useEffect(() => {
    if (!syncRef.current || !playback.currentTrack) return;
    const ct = playback.currentTrack;
    const inDetailView = library.selectedTrack !== null || library.selectedAlbum !== null
      || (library.selectedArtist !== null && library.view === "artists") || library.selectedTag !== null;
    if (!inDetailView) return;

    if (library.selectedTrack !== null) {
      // Track detail → follow to new track
      if (ct.id && ct.id !== library.selectedTrack) {
        library.setSelectedTrack(ct.id);
      }
    } else if (library.selectedAlbum !== null) {
      // Album detail → follow to new track's album
      if (ct.album_id && ct.album_id !== library.selectedAlbum) {
        library.handleAlbumClick(ct.album_id, ct.artist_id);
      }
    } else if (library.selectedArtist !== null) {
      // Artist detail → follow to new track's artist
      if (ct.artist_id && ct.artist_id !== library.selectedArtist) {
        library.handleArtistClick(ct.artist_id);
      }
    }
    // Tag detail: don't auto-navigate (ambiguous — track may have many tags)
  }, [playback.currentTrack?.id]);

  const handleToggleSync = useCallback(() => {
    setSyncWithPlaying(prev => {
      const next = !prev;
      store.set("syncWithPlaying", next);
      if (next && playback.currentTrack) {
        // Immediately sync to current track
        const ct = playback.currentTrack;
        if (library.selectedTrack !== null && ct.id && ct.id !== library.selectedTrack) {
          library.setSelectedTrack(ct.id);
        } else if (library.selectedAlbum !== null && ct.album_id && ct.album_id !== library.selectedAlbum) {
          library.handleAlbumClick(ct.album_id, ct.artist_id);
        } else if (library.selectedArtist !== null && ct.artist_id && ct.artist_id !== library.selectedArtist) {
          library.handleArtistClick(ct.artist_id);
        }
      }
      return next;
    });
  }, [playback.currentTrack, library.selectedTrack, library.selectedAlbum, library.selectedArtist]);

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
    getMediaElement: playback.getMediaElement,
    handleSeek: playback.handleSeek,
    currentTrack: playback.currentTrack,
  });
  shortcutStateRef.current = {
    volume: playback.volume,
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

      if (e.key === "Escape" && library.selectedTrack !== null) {
        library.setSelectedTrack(null);
        return;
      }

      // F12 or Ctrl+Shift+I: open devtools
      if (e.key === "F12" || (e.ctrlKey && e.shiftKey && e.key === "I")) {
        e.preventDefault();
        invoke("open_devtools");
        return;
      }

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
            playback.handleVolume(Math.min(1, s.volume + 0.05));
            return;
          case "ArrowDown":
            e.preventDefault();
            playback.handleVolume(Math.max(0, s.volume - 0.05));
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
          handleToggleQueueCollapsed();
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
  const playNextRef = useRef(queueHook.playNext);
  playNextRef.current = queueHook.playNext;
  const addToQueueAndPlayRef = useRef(queueHook.addToQueueAndPlay);
  addToQueueAndPlayRef.current = queueHook.addToQueueAndPlay;
  const queueRef = useRef(queueHook.queue);
  queueRef.current = queueHook.queue;

  const handleNext = useCallback(async () => {
    if (!playNextRef.current()) {
      const ac = autoContinueRef.current;
      const track = currentTrackRef.current;
      if (ac.enabled && track) {
        const excludeIds = queueRef.current.map(t => t.id);
        const next = await ac.fetchTrack(track, excludeIds);
        if (next) {
          addToQueueAndPlayRef.current(next);
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

  function handleLoggingEnabledChange(enabled: boolean) {
    setLoggingEnabled(enabled);
    store.set("loggingEnabled", enabled);
  }

  function handleOpenLogsFolder() {
    invoke("open_logs_folder").catch(console.error);
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

  function handleResizeQueueWidth(width: number) {
    setQueueWidth(width);
    store.set("queueWidth", width);
  }

  // Bridge for keyboard shortcuts
  handleToggleLikeRef.current = likeActions.handleToggleLike;

  const { view, selectedArtist, selectedAlbum, selectedTag, artists, albums, tags, tracks,
    sortedTracks, sortField, highlightedIndex, highlightedListIndex } = library;

  // Filtered lists for keyboard navigation
  const filteredArtists = (() => {
    if (view !== "artists" || selectedArtist !== null) return [];
    const q = viewSearch.getQuery("artists").trim().toLowerCase();
    const tokens = stripAccents(q).split(/[\s.,;:_\-\/\\]+/).filter(Boolean);
    return tokens.length ? library.sortedArtists.filter(a => { const name = stripAccents(a.name.toLowerCase()); return tokens.every(t => name.includes(t)); }) : library.sortedArtists;
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

  const localCollections = library.collections.filter(c => c.kind === "local" && c.enabled).map(c => ({ id: c.id, name: c.name, path: c.path ?? "" }));

  // Arrow key navigation helpers for search bars
  function scrollHighlightedIntoView(selector: string) {
    requestAnimationFrame(() => {
      const el = contentRef.current?.querySelector(selector + ' .highlighted') as HTMLElement | null;
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  function makeSearchNav(
    listLength: number,
    getIndex: () => number,
    setIndex: (i: number) => void,
    onEnter: (i: number) => void,
    scrollSelector: string,
  ) {
    return {
      onArrowDown: () => { const next = Math.min(getIndex() + 1, listLength - 1); setIndex(next); scrollHighlightedIntoView(scrollSelector); },
      onArrowUp: () => { const next = Math.max(getIndex() - 1, 0); setIndex(next); scrollHighlightedIntoView(scrollSelector); },
      onEnter: () => { const i = getIndex(); if (i >= 0 && i < listLength) onEnter(i); },
    };
  }

  const artistSearchNav = makeSearchNav(
    filteredArtists.length,
    () => highlightedListIndex,
    library.setHighlightedListIndex,
    (i) => library.handleArtistClick(filteredArtists[i].id),
    '.entity-table, .entity-list, .album-grid',
  );

  const albumSearchNav = makeSearchNav(
    filteredAlbums.length,
    () => highlightedListIndex,
    library.setHighlightedListIndex,
    (i) => library.handleAlbumClick(filteredAlbums[i].id),
    '.entity-table, .entity-list, .album-grid',
  );

  const tagSearchNav = makeSearchNav(
    filteredTags.length,
    () => highlightedListIndex,
    library.setHighlightedListIndex,
    (i) => { pushAndScroll(); library.setSelectedTag(filteredTags[i].id); library.setView("all"); },
    '.entity-table, .entity-list, .album-grid',
  );

  const trackSearchNav = makeSearchNav(
    sortedTracks.length,
    () => highlightedIndex,
    library.setHighlightedIndex,
    (i) => queueHook.playTracks(sortedTracks, i),
    '.track-list, .entity-list, .album-grid',
  );

  const likedSearchNav = makeSearchNav(
    sortedTracks.length,
    () => highlightedIndex,
    library.setHighlightedIndex,
    (i) => queueHook.playTracks(sortedTracks, i),
    '.track-list, .entity-list, .album-grid',
  );

  const historySearchNav = {
    onArrowDown: () => { const count = historyRef.current?.count ?? 0; if (count > 0) { const next = Math.min(highlightedListIndex + 1, count - 1); library.setHighlightedListIndex(next); scrollHighlightedIntoView('.history-content'); } },
    onArrowUp: () => { const next = Math.max(highlightedListIndex - 1, 0); library.setHighlightedListIndex(next); scrollHighlightedIntoView('.history-content'); },
    onEnter: () => { if (highlightedListIndex >= 0) historyRef.current?.playItem(highlightedListIndex); },
  };

  return (
    <div className={`app ${appRestoring ? "app-restoring" : ""} ${playback.currentTrack && isVideoTrack(playback.currentTrack) ? "video-mode" : ""} queue-open ${queueCollapsed ? "queue-collapsed" : ""} ${mini.miniMode ? "mini-mode" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} style={{ "--queue-width": `${queueWidth}px` } as React.CSSProperties} onClick={() => contextMenuActions.setContextMenu(null)}>
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
        selectedTag={selectedTag}
        selectedTrack={library.selectedTrack}
        collapsed={sidebarCollapsed}
        onShowAll={library.handleShowAll}
        onShowArtists={() => {
          pushAndScroll();
          library.setView("artists");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowAlbums={() => {
          pushAndScroll();
          library.setView("albums");
          library.setSelectedArtist(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowTags={() => {
          pushAndScroll();
          library.setView("tags");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowLiked={library.handleShowLiked}
        onShowHistory={() => {
          pushAndScroll();
          library.setView("history");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowCollections={() => {
          pushAndScroll();
          library.setView("collections");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowSettings={() => setShowSettings(true)}
        updateAvailable={updater.updateState.available !== null}
        pluginNavItems={plugins.sidebarItems}
        onPluginView={(pluginId, viewId) => {
          library.setView(`plugin:${pluginId}:${viewId}`);
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
        }}
      />
      <button
        className="g-btn g-btn-xs sidebar-collapse-btn"
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
          downloadFormat={downloads.downloadFormat}
          onDownloadFormatChange={(format) => downloads.setFormat(format, store)}
          activeSkinId={skins.activeSkinId}
          installedSkins={skins.installedSkins}
          onApplySkin={skins.applySkin}
          onImportSkin={handleImportSkin}
          onDeleteSkin={skins.deleteSkin}
          gallerySkins={skins.gallerySkins}
          galleryLoading={skins.galleryLoading}
          galleryError={skins.galleryError}
          onFetchGallery={skins.fetchGallery}
          onInstallFromGallery={skins.installFromGallery}
          pluginStates={plugins.pluginStates}
          onTogglePlugin={plugins.togglePlugin}
          onReloadPlugin={plugins.reloadPlugin}
          onReloadAllPlugins={plugins.reloadAllPlugins}
          onOpenPluginsFolder={async () => {
            const dir = await invoke<string>("plugin_get_dir");
            await invoke("open_folder", { folderPath: dir });
          }}
          onDeletePlugin={plugins.deletePlugin}
          galleryPlugins={plugins.galleryPlugins}
          galleryPluginsLoading={plugins.galleryLoading}
          galleryPluginsError={plugins.galleryError}
          onFetchPluginGallery={plugins.fetchPluginGallery}
          onInstallPluginFromGallery={plugins.installFromGallery}
          pluginSettingsPanels={plugins.settingsPanels}
          getPluginViewData={plugins.getViewData}
          onPluginAction={plugins.dispatchUIAction}
          loggingEnabled={loggingEnabled}
          onLoggingEnabledChange={handleLoggingEnabledChange}
          onOpenLogsFolder={handleOpenLogsFolder}
        />
      )}

      {/* Caption bar - full width */}
      <CaptionBar
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onGoBack={goBack}
        onGoForward={goForward}
        centralSearch={centralSearch}
        searchInputRef={searchInputRef}
        albumImages={albumImageCache.images}
        artistImages={artistImageCache.images}
        onFetchAlbumImage={albumImageCache.fetchOnDemand}
        onFetchArtistImage={artistImageCache.fetchOnDemand}
        onToggleMiniMode={mini.toggleMiniMode}
        onToggleHelp={() => setShowHelp(h => !h)}
      />

      {/* Main content */}
      <main className={`main${library.selectedTrack !== null && playback.currentTrack?.id === library.selectedTrack && isVideoTrack(playback.currentTrack) ? " video-detail" : ""}`} data-dock={playback.currentTrack && isVideoTrack(playback.currentTrack) ? videoLayout.dockSide : undefined}>
        {/* Content area */}
        <div className="content" ref={contentRef} style={playback.currentTrack && isVideoTrack(playback.currentTrack) ? (videoLayout.isHorizontal ? { minHeight: 150 } : { minWidth: 150 }) : undefined}>
          <Breadcrumb
            view={view}
            selectedArtist={selectedArtist}
            selectedAlbum={selectedAlbum}
            selectedTag={selectedTag}
            selectedTrack={library.selectedTrack}
            tracks={tracks}
            sortedTracks={sortedTracks}
            onPlayAll={queueHook.playTracks}
            onEnqueueAll={contextMenuActions.handleEnqueue}
          >
            {view === "all" && <ViewModeToggle mode={library.trackViewMode} onChange={library.setTrackViewMode} />}
            {view === "artists" && selectedArtist === null && <ViewModeToggle mode={library.artistViewMode} onChange={library.setArtistViewMode} />}
            {view === "albums" && <ViewModeToggle mode={library.albumViewMode} onChange={library.setAlbumViewMode} />}
            {view === "tags" && selectedTag === null && <ViewModeToggle mode={library.tagViewMode} onChange={library.setTagViewMode} />}
            {view === "liked" && <ViewModeToggle mode={library.likedViewMode} onChange={library.setLikedViewMode} />}
            {(view === "all" || view === "artists" || view === "albums" || view === "tags" || view === "liked") && !(view === "artists" && selectedArtist !== null) && !(view === "tags" && selectedTag !== null) && (
              <button className="sort-btn sort-bar-toggle" onClick={() => library.setSortBarCollapsed(v => !v)} title={library.sortBarCollapsed ? "Show sort bar" : "Hide sort bar"}>{library.sortBarCollapsed ? "\u25BC" : "\u25B2"}</button>
            )}
          </Breadcrumb>

          {/* Track detail view */}
          {library.selectedTrack !== null && (() => {
            const track = detailTrackLocal ?? detailTrack;
            if (!track) return null;
            const isCurrentTrack = playback.currentTrack?.id === library.selectedTrack;
            return (
              <TrackDetailView
                trackId={library.selectedTrack}
                track={track}
                albumImagePath={track.album_id ? albumImageCache.images[track.album_id] ?? null : null}
                positionSecs={isCurrentTrack ? playback.positionSecs : 0}
                isCurrentTrack={isCurrentTrack}
                sections={trackSections}
                onToggleSection={handleToggleTrackSection}
                onArtistClick={library.handleArtistClick}
                onAlbumClick={library.handleAlbumClick}
                onTagClick={(tagId) => { library.setSelectedTrack(null); library.setSelectedTag(tagId); library.setView("tags"); }}
                onPlay={() => queueHook.playTracks([track], 0)}
                onEnqueue={() => queueHook.enqueueTracks([track])}
                onPlayNext={() => queueHook.playNextInQueue(track)}
                onShowInFolder={() => invoke("show_in_folder", { trackId: library.selectedTrack })}
                collections={library.collections}
                providers={searchProviders}
                addLog={addLog}
                onUpdateTrack={(update) => library.setTracks(prev => prev.map(t => t.id === library.selectedTrack ? { ...t, ...update } : t))}
                invokeInfoFetch={plugins.invokeInfoFetch}
              />
            );
          })()}

          {library.selectedTrack === null && <>
          {/* Artist list */}
          {view === "artists" && selectedArtist === null && (
            <ArtistListView
              artists={filteredArtists}
              highlightedIndex={highlightedListIndex}
              viewMode={library.artistViewMode}
              sortField={library.artistSortField}
              sortDir={library.artistSortDir}
              sortBarCollapsed={library.sortBarCollapsed}
              likedFirst={library.artistLikedFirst}
              searchQuery={viewSearch.getQuery("artists")}
              artistImages={artistImageCache.images}
              onArtistClick={library.handleArtistClick}
              onToggleLike={likeActions.handleToggleArtistLike}
              onContextMenu={contextMenuActions.handleArtistContextMenu}
              onSort={library.handleArtistSort}
              onSetLikedFirst={library.setArtistLikedFirst}
              onSearchChange={(q) => viewSearch.setQuery("artists", q)}
              searchNav={artistSearchNav}
              onFetchImage={artistImageCache.fetchOnDemand}
            />
          )}

          {/* Artist detail view */}
          {view === "artists" && selectedArtist !== null && selectedAlbum === null && (() => {
            const artist = artists.find(a => a.id === selectedArtist);
            const artistImagePath = artistImageCache.images[selectedArtist] ?? null;
            return (
              <ArtistDetailContent
                selectedArtist={selectedArtist}
                artist={artist}
                artistImagePath={artistImagePath}
                artistTrackPopularity={artistInfo.artistTrackPopularity}
                sections={artistSections}
                onToggleSection={handleToggleArtistSection}
                sortedTracks={sortedTracks}
                artistAlbums={library.artistAlbums}
                artistImages={artistImageCache.images}
                albumImages={albumImageCache.images}
                onFetchAlbumImage={albumImageCache.fetchOnDemand}
                onSetArtistImage={artistImageCache.setImages}
                onForceFetchArtistImage={artistImageCache.forceFetchImage}
                currentTrack={playback.currentTrack}
                playing={playback.playing}
                highlightedIndex={highlightedIndex}
                sortField={sortField}
                trackListRef={trackListRef}
                onPlayTracks={queueHook.playTracks}
                onTrackContextMenu={contextMenuActions.handleTrackContextMenu}
                onArtistClick={library.handleArtistClick}
                onAlbumClick={library.handleAlbumClick}
                onSort={library.handleSort}
                sortIndicator={library.sortIndicator}
                onToggleLike={likeActions.handleToggleLike}
                onToggleDislike={likeActions.handleToggleDislike}
                onTrackDragStart={contextMenuActions.handleTrackDragStart}
                onDeleteTracks={handleDeleteTracks}
                onToggleArtistLike={likeActions.handleToggleArtistLike}
                onRefreshInfo={() => {
                  if (!artist) return;
                  artistInfo.refreshInfo();
                }}
                onAlbumContextMenu={contextMenuActions.handleAlbumContextMenu}
                searchProviders={searchProviders}
                artists={artists}
                invokeInfoFetch={plugins.invokeInfoFetch}
              />
            );
          })()}

          {/* All albums view */}
          {view === "albums" && (
            <AlbumListView
              albums={filteredAlbums}
              highlightedIndex={highlightedListIndex}
              viewMode={library.albumViewMode}
              sortField={library.albumSortField}
              sortDir={library.albumSortDir}
              sortBarCollapsed={library.sortBarCollapsed}
              likedFirst={library.albumLikedFirst}
              searchQuery={viewSearch.getQuery("albums")}
              albumImages={albumImageCache.images}
              onAlbumClick={library.handleAlbumClick}
              onToggleLike={likeActions.handleToggleAlbumLike}
              onContextMenu={contextMenuActions.handleAlbumContextMenu}
              onSort={library.handleAlbumSort}
              onSetLikedFirst={library.setAlbumLikedFirst}
              onSearchChange={(q) => viewSearch.setQuery("albums", q)}
              searchNav={albumSearchNav}
              onFetchImage={albumImageCache.fetchOnDemand}
            />
          )}

          {/* Tags list view */}
          {view === "tags" && selectedTag === null && (
            <TagListView
              tags={filteredTags}
              highlightedIndex={highlightedListIndex}
              viewMode={library.tagViewMode}
              sortField={library.tagSortField}
              sortDir={library.tagSortDir}
              sortBarCollapsed={library.sortBarCollapsed}
              likedFirst={library.tagLikedFirst}
              searchQuery={viewSearch.getQuery("tags")}
              tagImages={tagImageCache.images}
              onTagClick={(id) => { pushAndScroll(); library.setSelectedTag(id); library.setView("all"); }}
              onToggleLike={likeActions.handleToggleTagLike}
              onSort={library.handleTagSort}
              onSetLikedFirst={library.setTagLikedFirst}
              onSearchChange={(q) => viewSearch.setQuery("tags", q)}
              searchNav={tagSearchNav}
              onFetchImage={tagImageCache.fetchOnDemand}
            />
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
                      onClick={() => likeActions.handleToggleTagLike(selectedTag)}
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
              <AlbumDetailHeader
                selectedAlbum={selectedAlbum}
                album={album}
                albumImagePath={albumImagePath}
                sortedTracks={sortedTracks}
                searchProviders={searchProviders}
                onArtistClick={library.handleArtistClick}
                onToggleAlbumLike={likeActions.handleToggleAlbumLike}
                onPlayTracks={queueHook.playTracks}
                onImageSet={(id, path) => albumImageCache.setImages(prev => ({ ...prev, [id]: path }))}
                onImageRemoved={(id) => albumImageCache.setImages(prev => ({ ...prev, [id]: null }))}
                onRetrieveImage={() => {
                  if (!album) return;
                  albumImageCache.forceFetchImage({ id: selectedAlbum, title: album.title, artist_name: album.artist_name });
                }}
                onRetrieveInfo={() => {
                  if (!album) return;
                  artistInfo.refreshInfo();
                }}
                invokeInfoFetch={plugins.invokeInfoFetch}
              />
            );
          })()}

          {/* All tracks view */}
          {view === "all" && (
            <AllTracksView
              sortedTracks={sortedTracks}
              currentTrack={playback.currentTrack}
              playing={playback.playing}
              highlightedIndex={highlightedIndex}
              sortField={sortField}
              trackListRef={trackListRef}
              columns={selectedTag !== null ? tagDetailColumns : library.trackColumns}
              trackViewMode={library.trackViewMode}
              sortBarCollapsed={library.sortBarCollapsed}
              trackLikedFirst={library.trackLikedFirst}
              mediaTypeFilter={library.mediaTypeFilter}
              filterYoutubeOnly={library.filterYoutubeOnly}
              searchQuery={viewSearch.getQuery("all")}
              searchIncludeLyrics={library.searchIncludeLyrics}
              albumImages={albumImageCache.images}
              hasMore={library.hasMore}
              loadingMore={library.loadingMore}
              onColumnsChange={selectedTag !== null ? setTagDetailColumns : library.setTrackColumns}
              onDoubleClick={queueHook.playTracks}
              onContextMenu={contextMenuActions.handleTrackContextMenu}
              onArtistClick={library.handleArtistClick}
              onAlbumClick={library.handleAlbumClick}
              onSort={library.handleSort}
              sortIndicator={library.sortIndicator}
              onToggleLike={likeActions.handleToggleLike}
              onToggleDislike={likeActions.handleToggleDislike}
              onTrackDragStart={contextMenuActions.handleTrackDragStart}
              onDeleteTracks={handleDeleteTracks}
              onSearchChange={(q) => viewSearch.setQuery("all", q)}
              searchNav={trackSearchNav}
              onFetchAlbumImage={albumImageCache.fetchOnDemand}
              onLoadMore={library.loadMore}
              onSetTrackLikedFirst={library.setTrackLikedFirst}
              onSetMediaTypeFilter={library.setMediaTypeFilter}
              onSetFilterYoutubeOnly={library.setFilterYoutubeOnly}
              onSetSearchIncludeLyrics={library.setSearchIncludeLyrics}
            />
          )}

          {/* Artist album detail - always basic TrackList */}
          {(view === "artists" && selectedAlbum !== null) && (
            <>
              <TrackList
                tracks={sortedTracks}
                currentTrack={playback.currentTrack}
                playing={playback.playing}
                highlightedIndex={highlightedIndex}
                sortField={sortField}
                trackListRef={trackListRef}
                columns={albumDetailColumns}
                onColumnsChange={setAlbumDetailColumns}
                onDoubleClick={queueHook.playTracks}
                onContextMenu={contextMenuActions.handleTrackContextMenu}
                onArtistClick={library.handleArtistClick}
                onAlbumClick={library.handleAlbumClick}
                onSort={library.handleSort}
                sortIndicator={library.sortIndicator}
                onToggleLike={likeActions.handleToggleLike}
                onToggleDislike={likeActions.handleToggleDislike}
                onTrackDragStart={contextMenuActions.handleTrackDragStart}
                onDeleteTracks={handleDeleteTracks}
                trackPopularity={artistInfo.albumTrackPopularity}
                emptyMessage="No tracks found."
              />
            </>
          )}

          {/* Liked tracks view */}
          {view === "liked" && (
            <LikedTracksView
              sortedTracks={sortedTracks}
              currentTrack={playback.currentTrack}
              playing={playback.playing}
              highlightedIndex={highlightedIndex}
              sortField={sortField}
              trackListRef={trackListRef}
              columns={library.trackColumns}
              likedViewMode={library.likedViewMode}
              sortBarCollapsed={library.sortBarCollapsed}
              searchQuery={viewSearch.getQuery("liked")}
              searchIncludeLyrics={library.searchIncludeLyrics}
              albumImages={albumImageCache.images}
              onColumnsChange={library.setTrackColumns}
              onDoubleClick={queueHook.playTracks}
              onContextMenu={contextMenuActions.handleTrackContextMenu}
              onArtistClick={library.handleArtistClick}
              onAlbumClick={library.handleAlbumClick}
              onSort={library.handleSort}
              sortIndicator={library.sortIndicator}
              onToggleLike={likeActions.handleToggleLike}
              onToggleDislike={likeActions.handleToggleDislike}
              onTrackDragStart={contextMenuActions.handleTrackDragStart}
              onDeleteTracks={handleDeleteTracks}
              onSearchChange={(q) => viewSearch.setQuery("liked", q)}
              searchNav={likedSearchNav}
              onFetchAlbumImage={albumImageCache.fetchOnDemand}
              onSetSearchIncludeLyrics={library.setSearchIncludeLyrics}
            />
          )}

          {/* History view */}
          {view === "history" && (
            <>
              <ViewSearchBar
                query={viewSearch.getQuery("history")}
                onQueryChange={(q) => viewSearch.setQuery("history", q)}
                placeholder="Search history..."
                {...historySearchNav}
              />
              <HistoryView ref={historyRef} searchQuery={viewSearch.getQuery("history")} highlightedIndex={highlightedListIndex} onPlayTrack={queueHook.playTracks} onEnqueueTrack={contextMenuActions.handleEnqueue} addLog={addLog} onArtistClick={library.handleArtistClick} />
            </>
          )}



          {/* Collections view */}
          {view === "collections" && (
            <CollectionsView
              collections={library.collections.filter(c => c.kind !== "tidal")}
              onToggleEnabled={collectionActions.handleToggleCollectionEnabled}
              onCheckConnection={collectionActions.handleCheckConnection}
              onResync={collectionActions.handleResyncCollection}
              checkingConnectionId={collectionActions.checkingConnectionId}
              connectionResult={collectionActions.connectionResult}
              onEdit={(c) => collectionActions.setEditingCollection(c)}
              onRemove={(c) => collectionActions.setRemoveCollectionConfirm(c)}
              onAddFolder={handleAddFolder}
              onShowAddServer={() => setShowAddServer(true)}
              statsMap={new Map(library.collectionStats.map(s => [s.collection_id, s]))}
            />
          )}
          {typeof view === "string" && view.startsWith("plugin:") && (() => {
            const parts = view.slice("plugin:".length).split(":");
            const pluginId = parts[0];
            const viewId = parts.slice(1).join(":");
            const pluginState = plugins.pluginStates.find(p => p.id === pluginId);
            const data = plugins.getViewData(pluginId, viewId);
            return (
              <PluginViewRenderer
                pluginName={pluginState?.manifest.name ?? pluginId}
                data={data}
                currentTrack={playback.currentTrack}
                onPlayTrack={(track) => {
                  queueHook.playTracks([track], 0);
                }}
                onAction={(actionId, actionData) => {
                  plugins.dispatchUIAction(pluginId, actionId, actionData);
                }}
              />
            );
          })()}
          </>}
        </div>

        {/* Video splitter + player area (below content, above now-playing) */}
        {playback.currentTrack && isVideoTrack(playback.currentTrack) && (
          <div
            className={`video-splitter${videoLayout.isHorizontal ? "" : " vertical"}`}
            onMouseDown={videoLayout.onSplitterMouseDown}
          >
            <div className="splitter-handle" />
            <button
              className="splitter-collapse-btn"
              onClick={videoLayout.toggleCollapse}
              title={videoLayout.isCollapsed ? "Expand video" : "Collapse video"}
            >
              {videoLayout.isCollapsed
                ? (videoLayout.dockSide === "bottom" ? "\u25BC" : videoLayout.dockSide === "top" ? "\u25B2" : videoLayout.dockSide === "left" ? "\u25C0" : "\u25B6")
                : (videoLayout.dockSide === "bottom" ? "\u25B2" : videoLayout.dockSide === "top" ? "\u25BC" : videoLayout.dockSide === "left" ? "\u25B6" : "\u25C0")}
            </button>
          </div>
        )}
        <div
          className={`video-container${videoLayout.isCollapsed ? " collapsed" : ""}`}
          data-fit={videoLayout.fitMode}
          onContextMenu={(e) => {
            e.preventDefault();
            contextMenuActions.setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "video", dockSide: videoLayout.dockSide, fitMode: videoLayout.fitMode } });
          }}
          style={{
            display: playback.currentTrack && isVideoTrack(playback.currentTrack) ? undefined : 'none',
            ...(videoLayout.isHorizontal
              ? { height: videoLayout.isCollapsed ? 0 : videoLayout.videoSize }
              : { width: videoLayout.isCollapsed ? 0 : videoLayout.videoSize }),
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
              (playback.currentTrack?.album_id != null && albumImageCache.images[playback.currentTrack.album_id])
              || (playback.currentTrack?.artist_id != null && artistImageCache.images[playback.currentTrack.artist_id])
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
            onToggleLike={() => playback.currentTrack && likeActions.handleToggleLike(playback.currentTrack)}
            onToggleDislike={() => playback.currentTrack && likeActions.handleToggleDislike(playback.currentTrack)}
            onToggleFullscreen={playback.toggleFullscreen}
            showQueue={!queueCollapsed}
            onToggleQueue={handleToggleQueueCollapsed}
            onArtistClick={library.handleArtistClick}
            onAlbumClick={library.handleAlbumClick}
          />
        </div>
      </main>

      <QueuePanel
          queue={queueHook.queue}
          queueIndex={queueHook.queueIndex}
          queuePanelRef={queueHook.queuePanelRef}
          playlistName={queueHook.playlistName}
          pendingEnqueue={contextMenuActions.pendingEnqueue}
          onAllowAll={() => {
            if (contextMenuActions.pendingEnqueue) {
              if (contextMenuActions.pendingEnqueue.position != null) queueHook.insertAtPosition(contextMenuActions.pendingEnqueue.all, contextMenuActions.pendingEnqueue.position);
              else queueHook.enqueueTracks(contextMenuActions.pendingEnqueue.all);
            }
            contextMenuActions.setPendingEnqueue(null);
          }}
          onSkipDuplicates={() => {
            if (contextMenuActions.pendingEnqueue) {
              if (contextMenuActions.pendingEnqueue.position != null) queueHook.insertAtPosition(contextMenuActions.pendingEnqueue.unique, contextMenuActions.pendingEnqueue.position);
              else queueHook.enqueueTracks(contextMenuActions.pendingEnqueue.unique);
            }
            contextMenuActions.setPendingEnqueue(null);
          }}
          onCancelEnqueue={() => contextMenuActions.setPendingEnqueue(null)}
          onPlay={(track, index) => { queueHook.setQueueIndex(index); playback.handlePlay(track); }}
          onRemove={queueHook.removeFromQueue}
          onLocateTrack={(track) => {
            library.handleLocateTrack(track.title, track.artist_name, track.album_title, () => {
              library.setView("all");
              library.setSelectedArtist(null);
              library.setSelectedAlbum(null);
              library.setSelectedTag(null);
              viewSearch.setQuery("all", track.title);
            });
          }}
          onMoveMultiple={queueHook.moveMultiple}
          onClear={queueHook.clearQueue}
          onSavePlaylist={queueHook.savePlaylist}
          onLoadPlaylist={queueHook.loadPlaylist}
          onContextMenu={(e, indices) => {
            contextMenuActions.setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "queue-multi", indices } });
          }}
          externalDropTarget={contextMenuActions.externalDropTarget}
          collapsed={queueCollapsed}
          onToggleCollapsed={handleToggleQueueCollapsed}
          onResizeWidth={handleResizeQueueWidth}
        />
      {!queueCollapsed && (
        <button
          className="g-btn g-btn-xs queue-collapse-btn"
          onClick={handleToggleQueueCollapsed}
          title="Collapse playlist"
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </button>
      )}

      {contextMenuActions.contextMenu && (
        <ContextMenu
          menu={contextMenuActions.contextMenu}
          providers={searchProviders}
          onPlay={contextMenuActions.handleContextPlay}
          onEnqueue={contextMenuActions.handleContextEnqueue}
          onShowInFolder={contextMenuActions.handleShowInFolder}
          onWatchOnYoutube={contextMenuActions.handleWatchOnYoutube}
          onViewDetails={contextMenuActions.contextMenu.target.kind === "track" ? () => library.handleTrackClick(contextMenuActions.contextMenu!.target.kind === "track" ? contextMenuActions.contextMenu!.target.trackId : 0) : undefined}
          onBulkEdit={contextMenuActions.handleBulkEdit}
          onDelete={contextMenuActions.handleDeleteRequest}
          onRefreshImage={contextMenuActions.contextMenu.target.kind === "artist"
            ? () => { const t = contextMenuActions.contextMenu!.target; if (t.kind === "artist") artistImageCache.forceFetchImage({ id: t.artistId, name: t.name }); }
            : contextMenuActions.contextMenu.target.kind === "album"
            ? () => { const t = contextMenuActions.contextMenu!.target; if (t.kind === "album") albumImageCache.forceFetchImage({ id: t.albumId, title: t.title, artist_name: t.artistName }); }
            : undefined}
          onRemoveFromQueue={contextMenuActions.handleQueueRemove}
          onMoveToTop={contextMenuActions.handleQueueMoveToTop}
          onMoveToBottom={contextMenuActions.handleQueueMoveToBottom}
          onLocateTrack={contextMenuActions.contextMenu.target.kind === "queue-multi" && contextMenuActions.contextMenu.target.indices.length === 1 ? () => {
            const track = queueHook.queue[contextMenuActions.contextMenu!.target.kind === "queue-multi" ? contextMenuActions.contextMenu!.target.indices[0] : 0];
            if (track) {
              library.handleLocateTrack(track.title, track.artist_name, track.album_title, () => {
                library.setView("all");
                library.setSelectedArtist(null);
                library.setSelectedAlbum(null);
                library.setSelectedTag(null);
                viewSearch.setQuery("all", track.title);
              });
            }
          } : undefined}
          onDownload={contextMenuActions.contextMenu.target.kind === "track" ? (destId: number) => { const t = contextMenuActions.contextMenu!.target; if (t.kind === "track") downloads.downloadTrack(t.trackId, destId, library.tracks); } : undefined}
          localCollections={localCollections}
          onClose={() => contextMenuActions.setContextMenu(null)}
          pluginMenuItems={plugins.menuItems}
          onPluginAction={plugins.dispatchContextMenuAction}
          onSetDockSide={videoLayout.setDockSide}
          onSetFitMode={videoLayout.setFitMode}
        />
      )}

      {contextMenuActions.upgradeTrack && (
        <UpgradeTrackModal
          track={contextMenuActions.upgradeTrack}
          downloadFormat={downloads.downloadFormat}
          onClose={() => contextMenuActions.setUpgradeTrack(null)}
          onUpgraded={(msg) => { contextMenuActions.setUpgradeTrack(null); library.loadTracks(); addLog(msg); }}
        />
      )}

      {contextMenuActions.bulkEditTracks && (
        <BulkEditModal
          tracks={contextMenuActions.bulkEditTracks}
          onClose={() => contextMenuActions.setBulkEditTracks(null)}
        />
      )}

      {contextMenuActions.deleteConfirm && (
        <div className="modal-overlay" onClick={() => contextMenuActions.setDeleteConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete {contextMenuActions.deleteConfirm.title}?</h2>
            <p className="delete-confirm-warning">This will permanently delete the file{contextMenuActions.deleteConfirm.trackIds.length > 1 ? "s" : ""} from disk.</p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => contextMenuActions.setDeleteConfirm(null)}>Cancel</button>
              <button className="modal-btn modal-btn-danger" onClick={contextMenuActions.handleDeleteConfirm} autoFocus>Delete</button>
            </div>
          </div>
        </div>
      )}

      {contextMenuActions.deleteError && (
        <div className="modal-overlay" onClick={() => contextMenuActions.setDeleteError(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete Failed</h2>
            <p className="delete-confirm-warning">{contextMenuActions.deleteError.message}</p>
            <ul className="delete-failure-list">
              {contextMenuActions.deleteError.failures.map((f, i) => (
                <li key={i}>
                  <span className="delete-failure-title">{f.title}</span>
                  <span className="delete-failure-reason">{f.reason}</span>
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => contextMenuActions.setDeleteError(null)}>OK</button>
            </div>
          </div>
        </div>
      )}

      {collectionActions.editingCollection && (
        <EditCollectionModal
          collection={collectionActions.editingCollection}
          onSave={collectionActions.handleSaveCollection}
          onClose={() => collectionActions.setEditingCollection(null)}
        />
      )}

      {collectionActions.removeCollectionConfirm && (
        <div className="modal-overlay" onClick={() => collectionActions.setRemoveCollectionConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Remove &ldquo;{collectionActions.removeCollectionConfirm.name}&rdquo;?</h2>
            <p className="delete-confirm-warning">This will permanently remove this collection and all its tracks from the library.</p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => collectionActions.setRemoveCollectionConfirm(null)}>Cancel</button>
              <button className="modal-btn modal-btn-danger" onClick={collectionActions.handleRemoveCollectionConfirm}>Remove</button>
            </div>
          </div>
        </div>
      )}

      {playback.playbackError && (
        <PlaybackErrorModal
          error={playback.playbackError}
          trackTitle={playback.failedTrack?.title ?? null}
          onDismiss={playback.clearPlaybackError}
          onSkip={() => { playback.clearPlaybackError(); handleNext(); }}
        />
      )}

      {navError && (
        <div className="modal-overlay" onClick={() => setNavError(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Navigation Error</h2>
            <p>{navError}</p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-confirm" onClick={() => setNavError(null)}>OK</button>
            </div>
          </div>
        </div>
      )}

      <NowPlayingBar
        waveformPeaks={waveformPeaks}
        currentTrack={playback.currentTrack}
        playing={playback.playing}
        positionSecs={playback.positionSecs}
        durationSecs={playback.durationSecs}
        scrobbled={playback.scrobbled}
        trackRank={trackRank}
        artistRank={artistRank}
        volume={playback.volume}
        queueMode={queueHook.queueMode}
        autoContinueEnabled={autoContinue.enabled}
        autoContinueSameFormat={autoContinue.sameFormat}
        showAutoContinuePopover={autoContinue.showPopover}
        autoContinueWeights={autoContinue.weights}
        imagePath={
          (playback.currentTrack?.album_id != null && albumImageCache.images[playback.currentTrack.album_id])
          || (playback.currentTrack?.artist_id != null && artistImageCache.images[playback.currentTrack.artist_id])
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
        onToggleLike={() => playback.currentTrack && likeActions.handleToggleLike(playback.currentTrack)}
        onToggleDislike={() => playback.currentTrack && likeActions.handleToggleDislike(playback.currentTrack)}
        onTrackClick={(trackId) => { library.handleTrackClick(trackId); }}
        onArtistClick={library.handleArtistClick}
        onAlbumClick={library.handleAlbumClick}
        syncWithPlaying={syncWithPlaying}
        onToggleSync={handleToggleSync}
        showHelp={showHelp}
        onToggleHelp={() => setShowHelp(h => !h)}
      />

      <StatusBar
        sessionLog={sessionLog}
        activity={statusActivity}
        feedback={contextMenuActions.youtubeFeedback ? {
          message: `Was "${contextMenuActions.youtubeFeedback.videoTitle}" the right video?`,
          onYes: () => contextMenuActions.handleYoutubeFeedback(true),
          onNo: () => contextMenuActions.handleYoutubeFeedback(false),
        } : null}
        downloadStatus={downloads.downloadStatus}
        onCancelDownload={downloads.cancelDownload}
      />

    </div>
  );
}

export default App;
