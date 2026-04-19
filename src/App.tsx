import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrent as getDeepLinkCurrent } from "@tauri-apps/plugin-deep-link";
import { listen } from "@tauri-apps/api/event";
import "./base.css";
import "./design-system.css";
import "./App.css";

import type { Track, View, ViewMode, ColumnConfig, SortField, SortDir } from "./types";
import { isVideoTrack, parseSubsonicUrl, tidalCoverUrl } from "./utils";
import { store } from "./store";
import { parseUrlScheme, queueEntryToTrack, trackToQueueEntry, type QueueEntry } from "./queueEntry";
import type { SearchProviderConfig } from "./searchProviders";
import { DEFAULT_PROVIDERS, loadProviders, saveProviders } from "./searchProviders";
import { resolveFallback, type FallbackProvider } from "./fallbackProviders";
import { timeAsync, getTimingEntries, type TimingEntry } from "./startupTiming";

import { usePlayback } from "./hooks/usePlayback";
import { useQueue } from "./hooks/useQueue";
import { useLibrary, DEFAULT_TRACK_COLUMNS, ALBUM_DETAIL_COLUMNS } from "./hooks/useLibrary";
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
import { useImageResolver } from "./hooks/useImageResolver";

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
import { ArtistDetailContent } from "./components/ArtistDetailContent";
import { ImageActions } from "./components/ImageActions";
import { AlbumDetailHeader } from "./components/AlbumDetailHeader";
import { InformationSections } from "./components/InformationSections";
import { HistoryView } from "./components/HistoryView";
import type { HistoryViewHandle } from "./components/HistoryView";
import { PlaylistsView } from "./components/PlaylistsView";
import { SavePlaylistModal } from "./components/SavePlaylistModal";
import { CollectionsView } from "./components/CollectionsView";
import { EditCollectionModal } from "./components/EditCollectionModal";
import { PluginViewRenderer } from "./components/PluginViewRenderer";
import { TrackDetailView } from "./components/TrackDetailView";
import { TidalDownloadModal } from "./components/TidalDownloadModal";
import { TidalAlbumDownloadModal, type TidalAlbumDownloadInput } from "./components/TidalAlbumDownloadModal";
import BulkEditModal from "./components/BulkEditModal";
import PlaybackErrorModal from "./components/PlaybackErrorModal";
import { TapePreviewModal } from "./components/TapePreviewModal";
import { TapeExportModal } from "./components/TapeExportModal";
import type { ExportTrack } from "./components/TapeExportModal";

import { SearchView } from "./components/SearchView";
import { StatusBar } from "./components/StatusBar";
import { IconYoutube } from "./components/Icons";


function App() {
  const restoredRef = useRef(false);
  const [appRestoring, setAppRestoring] = useState(true);
  const [navError, setNavError] = useState<string | null>(null);
  const [showSavePlaylistModal, setShowSavePlaylistModal] = useState(false);
  const [pluginLoadingMessage, setPluginLoadingMessage] = useState<string | null>(null);
  const [tidalAlbumDownload, setTidalAlbumDownload] = useState<TidalAlbumDownloadInput | null>(null);
  const pendingRestoreTrackRef = useRef<Track | null>(null);
  const pendingRestoreQueueRef = useRef<{ tracks: Track[]; index: number } | null>(null);
  const trackListRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const getScrollEl = useCallback(() => {
    const el = contentRef.current;
    if (!el) return null;
    return el.querySelector<HTMLElement>('.track-list, .entity-list, .entity-table, .album-grid, .artist-detail, .album-detail, .history-view, .collections-view, .plugin-view, .settings-content-body');
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
  const [lastTidalDownloadDest, setLastTidalDownloadDest] = useState<string | null>(null);
  trackVideoHistoryRef.current = trackVideoHistory;
  const advanceIndexRef = useRef<() => void>(() => {});
  const resolveTrackSrcRef = useRef<(track: Track) => Promise<string>>(async (track) => {
    const url = track.url ?? track.path;
    if (!url) throw new Error("Track has no URL");
    const parsed = parseUrlScheme(url);
    if (parsed.scheme === "file") return convertFileSrc(parsed.path);
    if (parsed.scheme === "tidal") return invoke<string>("tidal_get_stream_url", { tidalTrackId: parsed.id, quality: null });
    if (parsed.scheme === "unknown") throw new Error(`Cannot play unknown URL scheme: ${parsed.url}`);
    return invoke<string>("resolve_subsonic_location", { location: parsed.url });
  });
  const fallbackProvidersRef = useRef<FallbackProvider[]>([]);
  const [fallbackOrderVersion, setFallbackOrderVersion] = useState(0);
  const playback = usePlayback(restoredRef, peekNextRef, crossfadeSecsRef, advanceIndexRef, trackVideoHistoryRef, resolveTrackSrcRef);
  const waveformPeaks = useWaveform(
    playback.currentTrack?.path ?? null,
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

  const { sessionLog, addLog } = useSessionLog();
  const albumImageCache = useImageCache("album", addLog);

  // Need to initialize library first to get selection state, then artistInfo will compute popularity
  const [trackPopularityState, setTrackPopularityState] = useState<Record<number, number>>({});
  const library = useLibrary(restoredRef, () => beforeNavRef.current(), viewSearch.getDebouncedQuery, trackPopularityState, setNavError);

  const queueHook = useQueue(restoredRef, playback.handlePlay, library.collections, albumImageCache.images);
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
      image_url: tidalCoverUrl(info.cover_id ?? null, 160) ?? undefined,
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
    playTidalTracks: (tracks: TidalSearchTrackLike[], startIndex?: number, context?: { name: string; coverUrl?: string | null }) => {
      queueHook.playTracks(tracks.map(tidalTrackToTrackFn), startIndex ?? 0, context ? { name: context.name, coverUrl: context.coverUrl } : undefined);
    },
    getDownloadFormat: () => downloadFormatRef.current,
  }), [queueHook, tidalTrackToTrackFn]);
  const pluginHostCallbacksRef = useRef<PluginHostCallbacks | undefined>(undefined);
  const plugins = usePlugins(pluginTrackRef, pluginPlayingRef, pluginPositionRef, pluginPlaybackCallbacks, pluginHostCallbacksRef.current);

  // Wire up image resolver to handle image-resolve-request events
  useImageResolver(plugins.invokeImageFetch);

  // Build ordered fallback provider list from built-in + plugins + user ordering
  useEffect(() => {
    const buildProviders = async () => {
      const builtinLibrary: FallbackProvider = {
        id: "built-in:library",
        name: "Library",
        source: "built-in",
        resolve: async (title, artistName, albumName) => {
          const track = await invoke<Track | null>("find_track_by_metadata", {
            title,
            artistName,
            albumName,
          });
          if (!track) return null;
          return { url: track.url ?? track.path, label: "Library" };
        },
      };

      // Collect plugin fallback providers from manifests
      const pluginProviders: FallbackProvider[] = [];
      for (const ps of plugins.pluginStates) {
        if (ps.status !== "active") continue;
        const fps = ps.manifest.contributes?.fallbackProviders;
        if (!fps) continue;
        for (const fp of fps) {
          pluginProviders.push({
            id: `${ps.id}:${fp.id}`,
            name: fp.name,
            source: ps.id,
            resolve: (title, artistName, albumName) =>
              plugins.invokeFallbackResolve(ps.id, fp.id, title, artistName, albumName),
          });
        }
      }

      // Apply user ordering from store
      const storedOrder = await store.get<Array<{ id: string; enabled: boolean }>>("fallbackProviderOrder");
      const allProviders = [builtinLibrary, ...pluginProviders];

      if (storedOrder) {
        const ordered: FallbackProvider[] = [];
        for (const entry of storedOrder) {
          if (!entry.enabled) continue;
          const provider = allProviders.find((p) => p.id === entry.id);
          if (provider) ordered.push(provider);
        }
        // Append any new providers not in stored order
        for (const provider of allProviders) {
          if (!ordered.some((p) => p.id === provider.id)) {
            ordered.push(provider);
          }
        }
        fallbackProvidersRef.current = ordered;
      } else {
        fallbackProvidersRef.current = allProviders;
      }
    };
    buildProviders();
  }, [plugins.pluginStates, plugins.invokeFallbackResolve, fallbackOrderVersion]);

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
      setSearchInitialQuery(query);
      setSearchQueryKey(k => k + 1);
      library.setView("search");
      library.setSelectedArtist(null);
      library.setSelectedAlbum(null);
      library.setSelectedTag(null);
      library.setSelectedTrack(null);
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
  const [albumBelowTabOrder, setAlbumBelowTabOrder] = useState<string[]>([]);
  useEffect(() => {
    store.get<string[]>("albumDetailBelowTabOrder").then(saved => {
      if (saved && saved.length > 0) setAlbumBelowTabOrder(saved);
    });
  }, []);
  const handleAlbumBelowTabOrderChange = useCallback((order: string[]) => {
    setAlbumBelowTabOrder(order);
    store.set("albumDetailBelowTabOrder", order);
  }, []);
  const [detailTrack, setDetailTrack] = useState<Track | null>(null);
  const [syncWithPlaying, setSyncWithPlaying] = useState(false);
  const [showAddServer, setShowAddServer] = useState(false);
  const [deepLinkServer, setDeepLinkServer] = useState<{ url: string; username: string; password: string } | null>(null);
  const [tapePreviewPath, setTapePreviewPath] = useState<string | null>(null);
  const [tapeExportTracks, setTapeExportTracks] = useState<ExportTrack[] | null>(null);
  const [tapeExportDefaultTitle, setTapeExportDefaultTitle] = useState<string>("");

  const [searchProviders, setSearchProviders] = useState<SearchProviderConfig[]>(DEFAULT_PROVIDERS);
  const [backendTimings, setBackendTimings] = useState<TimingEntry[]>([]);

  const [showHelp, setShowHelp] = useState(false);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const [queueWidth, setQueueWidth] = useState(300);
  const [searchViewModes, setSearchViewModes] = useState<{ tracks: ViewMode; albums: ViewMode; artists: ViewMode; tags: ViewMode }>({ tracks: "list", albums: "tiles", artists: "tiles", tags: "tiles" });
  const [searchInitialQuery, setSearchInitialQuery] = useState<string | null>(null);
  const [searchQueryKey, setSearchQueryKey] = useState(0);

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

  // Image caches (albumImageCache moved above useQueue for image_url stamping)
  const artistImageCache = useImageCache("artist", addLog);
  const tagImageCache = useImageCache("tag", addLog);

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
    albumImages: albumImageCache.images,
    artistImages: artistImageCache.images,
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
      if (action === "show-loading") {
        setPluginLoadingMessage((payload as { message?: string })?.message ?? "Loading...");
        return;
      } else if (action === "hide-loading") {
        setPluginLoadingMessage(null);
        return;
      } else if (action === "tidal-download-album") {
        setTidalAlbumDownload(payload as unknown as TidalAlbumDownloadInput);
        return;
      } else if (action === "tidal-download") {
        contextMenuActions.setTidalDownload(payload as { trackId: number | null; title: string; artistName: string | null });
      } else if (action === "play-tracks") {
        const tracks = (payload.tracks as Array<{ title: string; artist_name?: string | null; album_title?: string | null; duration_secs?: number | null; url?: string | null; path?: string; image_url?: string }>);
        const startIndex = (payload.startIndex as number) ?? 0;
        if (tracks?.length) {
          const playlistName = payload.playlistName as string | undefined;
          const coverUrl = payload.coverUrl as string | undefined;
          queueHook.playTracks(tracks.map(t => ({
            title: t.title,
            artist_name: t.artist_name ?? null,
            album_title: t.album_title ?? null,
            duration_secs: t.duration_secs ?? null,
            url: t.url ?? null,
            path: t.path ?? "external://",
            image_url: t.image_url,
          })) as Track[], startIndex, playlistName ? { name: playlistName, coverUrl: coverUrl ?? null } : null);
        }
      } else if (action === "enqueue-tracks") {
        const tracks = (payload.tracks as Array<{ title: string; artist_name?: string | null; album_title?: string | null; duration_secs?: number | null; url?: string | null; path?: string; image_url?: string }>);
        if (tracks?.length) {
          queueHook.enqueueTracks(tracks.map(t => ({
            title: t.title,
            artist_name: t.artist_name ?? null,
            album_title: t.album_title ?? null,
            duration_secs: t.duration_secs ?? null,
            url: t.url ?? null,
            path: t.path ?? "external://",
            image_url: t.image_url,
          })) as Track[]);
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
    const resolveViaFallback = async (track: Track): Promise<string> => {
      const result = await resolveFallback(
        fallbackProvidersRef.current,
        track.title,
        track.artist_name,
        track.album_title,
      );
      if (!result) throw new Error(`No playback source found for: ${track.title}`);
      addLog(`Playing from ${result.label} (original unavailable)`);
      const fallbackParsed = parseUrlScheme(result.url);
      if (fallbackParsed.scheme === "file") return convertFileSrc(fallbackParsed.path);
      if (fallbackParsed.scheme === "tidal") return invoke<string>("tidal_get_stream_url", { tidalTrackId: fallbackParsed.id, quality: null });
      if (fallbackParsed.scheme === "subsonic") return invoke<string>("resolve_subsonic_location", { location: result.url });
      throw new Error(`Fallback returned unplayable URL: ${result.url}`);
    };

    resolveTrackSrcRef.current = async (track: Track) => {
      const url = track.url ?? track.path;
      if (!url) return resolveViaFallback(track);
      const parsed = parseUrlScheme(url);

      if (parsed.scheme === "file") {
        return convertFileSrc(parsed.path);
      } else if (parsed.scheme === "tidal") {
        return invoke<string>("tidal_get_stream_url", { tidalTrackId: parsed.id, quality: null });
      } else if (parsed.scheme === "subsonic") {
        return invoke<string>("resolve_subsonic_location", { location: url });
      } else if (parsed.scheme === "unknown") {
        return resolveViaFallback(track);
      } else {
        const _exhaustive: never = parsed;
        throw new Error(`Unhandled scheme: ${(_exhaustive as any).scheme}`);
      }
    };
  }, [addLog]);

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
    }).catch(() => {}); // Fire-and-forget: deep link check on startup — no URLs is the common case
    return () => {
      unlistenEvent.then(f => f());
    };
  }, [plugins.forwardDeepLink]);

  // Listen for tape file opened events (from file association / CLI)
  useEffect(() => {
    const unlistenTapeOpen = listen<string>("tape-file-opened", (event) => {
      setTapePreviewPath(event.payload);
    });
    return () => {
      unlistenTapeOpen.then(f => f());
    };
  }, []);

  // Handle drag-and-drop of .tape files onto the window
  useEffect(() => {
    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const paths: string[] = event.payload.paths;
        const tapePath = paths.find(p => p.endsWith(".tape"));
        if (tapePath) {
          setTapePreviewPath(tapePath);
        }
      }
    });
    return () => {
      unlisten.then(f => f());
    };
  }, []);

  // Clean up temporary tape files on app startup
  useEffect(() => {
    invoke("cleanup_temp_tapes").catch(() => {});
  }, []);

  // Restore persisted state on mount
  useEffect(() => {
    (async () => {
      try {
        await timeAsync("store.init", () => store.init());
        const [v, sa, sal, st, savedTrackEntry, vol, qEntries, qIdx, qMode, _pos, cf, savedTrackVideoHistory, wasMini, fww, fwh, fwx, fwy, tSortField, tSortDir, tCols, savedPlaylistName, , , , savedTrackViewMode, , savedVideoLayout, savedVideoSplitHeight, savedSidebarCollapsed, savedQueueCollapsed, savedQueueWidth, savedDownloadFormat, , , , , , , , , , , savedFilterYoutubeOnly, savedMediaTypeFilter, savedTrackLikedFirst, savedLastTidalDownloadDest, savedSearchViewModes] = await timeAsync("store.restore", () => Promise.all([
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
          store.get<{ name: string; coverPath?: string | null; coverUrl?: string | null } | null>("playlistContext"),
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
          store.get<string | null>("lastTidalDownloadDest"),
          store.get<{ tracks: ViewMode; albums: ViewMode; artists: ViewMode } | null>("searchViewModes"),
        ]));
        if (v && ["search", "artists", "albums", "tags", "history"].includes(v)) library.setView(v as View);
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
        if (savedPlaylistName) {
          if (typeof savedPlaylistName === "string") {
            queueHook.setPlaylistContext({ name: savedPlaylistName });
          } else {
            queueHook.setPlaylistContext(savedPlaylistName as { name: string; coverPath?: string | null; coverUrl?: string | null });
          }
        }
        if (savedTrackViewMode && ["basic", "list", "tiles"].includes(savedTrackViewMode)) library.setTrackViewMode(savedTrackViewMode as ViewMode);
        if (savedFilterYoutubeOnly) library.setFilterYoutubeOnly(true);
        if (savedMediaTypeFilter && ["all", "audio", "video"].includes(savedMediaTypeFilter)) library.setMediaTypeFilter(savedMediaTypeFilter as "all" | "audio" | "video");
        if (savedTrackLikedFirst) library.setTrackLikedFirst(true);
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
        if (savedLastTidalDownloadDest !== undefined) setLastTidalDownloadDest(savedLastTidalDownloadDest ?? null);
        if (savedSearchViewModes) {
          const validModes = ["basic", "list", "tiles"];
          const s = savedSearchViewModes as { tracks: ViewMode; albums: ViewMode; artists: ViewMode; tags?: ViewMode };
          if (validModes.includes(s.tracks) && validModes.includes(s.albums) && validModes.includes(s.artists)) {
            setSearchViewModes({ tracks: s.tracks, albums: s.albums, artists: s.artists, tags: s.tags && validModes.includes(s.tags) ? s.tags : "tiles" });
          }
        }
        const savedLoggingEnabled = await store.get<boolean>("loggingEnabled");
        if (savedLoggingEnabled) setLoggingEnabled(true);
        const savedArtistSections = await store.get<Record<string, boolean>>("artistSections");
        if (savedArtistSections) setArtistSections(savedArtistSections);
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
      invoke("write_frontend_log", { level: "error", message: `${e.message} at ${e.filename}:${e.lineno}` }).catch(() => {}); // Fire-and-forget: avoid infinite loop if the error logger itself fails
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      invoke("write_frontend_log", { level: "error", message: `Unhandled rejection: ${e.reason}` }).catch(() => {}); // Fire-and-forget: avoid infinite loop if the error logger itself fails
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

  // Sync detail view with currently playing track — only on automatic track changes
  const syncRef = useRef(syncWithPlaying);
  syncRef.current = syncWithPlaying;
  useEffect(() => {
    if (!syncRef.current || !playback.currentTrack) return;
    if (playback.trackChangeSourceRef.current !== "auto") return;
    const ct = playback.currentTrack;
    if (ct.id && ct.id !== library.selectedTrack) {
      library.handleTrackClick(ct.id);
    }
  }, [playback.currentTrack?.id]);

  const handleToggleSync = useCallback(() => {
    setSyncWithPlaying(prev => {
      const next = !prev;
      store.set("syncWithPlaying", next);
      if (next && playback.currentTrack) {
        const ct = playback.currentTrack;
        if (ct.id) {
          library.handleTrackClick(ct.id);
        }
      }
      return next;
    });
  }, [playback.currentTrack]);

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
          pushStateRef.current();
          library.setView("search");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
          break;
        case "2":
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

  const handleNext = useCallback(async (source: "user" | "auto" = "user") => {
    if (!playNextRef.current(source)) {
      const ac = autoContinueRef.current;
      const track = currentTrackRef.current;
      if (ac.enabled && track) {
        const excludeIds = queueRef.current.map(t => t.id);
        const next = await ac.fetchTrack(track, excludeIds);
        if (next) {
          addToQueueAndPlayRef.current(next, source);
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
    handleNext("auto");
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

  function handleSearchViewModesChange(modes: { tracks: ViewMode; albums: ViewMode; artists: ViewMode; tags: ViewMode }) {
    setSearchViewModes(modes);
    store.set("searchViewModes", modes);
  }
  function handleSaveAsPlaylist() {
    if (queueHook.queue.length === 0) return;
    setShowSavePlaylistModal(true);
  }

  async function handleSavePlaylistConfirm(name: string, imagePath: string | null) {
    setShowSavePlaylistModal(false);
    const tracks = queueHook.queue.map((t) => ({
      title: t.title,
      artist_name: t.artist_name ?? null,
      album_name: t.album_title ?? null,
      duration_secs: t.duration_secs ?? null,
      source: t.url ?? t.path,
      image_url: null,
    }));
    try {
      const playlistId = await invoke<number>("save_playlist_record", {
        name,
        source: null,
        imageUrl: null,
        tracks,
      });
      if (imagePath) {
        await invoke("update_playlist_image", { playlistId, imagePath });
      }
      addLog("Playlist saved: " + name);
    } catch (err) {
      console.error("Failed to save playlist:", err);
      addLog(`Failed to save playlist: ${err}`);
    }
  }

  // Tape export trigger — fetches full track data and opens the export modal
  const handleExportAsTape = useCallback(async (trackIds: number[], defaultTitle?: string) => {
    try {
      const tracks = await invoke<Track[]>("get_tracks_by_ids", { ids: trackIds });
      setTapeExportTracks(tracks.map((t) => ({
        id: t.id,
        title: t.title,
        artistName: t.artist_name || undefined,
        albumTitle: t.album_title || undefined,
        durationSecs: t.duration_secs || undefined,
        fileSize: t.file_size || undefined,
      })));
      setTapeExportDefaultTitle(defaultTitle || "");
    } catch (e) {
      console.error("Failed to prepare tape export:", e);
    }
  }, []);

  // Queue handler for tape "Just Play" mode — replaces the queue with tape tracks
  const handleTapeQueueTracks = useCallback((tracks: Track[], context: { name: string; coverPath?: string | null }) => {
    queueHook.playTracks(tracks, 0, context);
  }, [queueHook.playTracks]);

  // Bridge for keyboard shortcuts
  handleToggleLikeRef.current = likeActions.handleToggleLike;

  const { view, selectedArtist, selectedAlbum, selectedTag, artists, albums, tags,
    sortedTracks, sortField, highlightedIndex, highlightedListIndex } = library;

  const localCollections = library.collections.filter(c => c.kind === "local" && c.enabled).map(c => ({ id: c.id, name: c.name, path: c.path ?? "" }));

  // Arrow key navigation helpers for search bars
  function scrollHighlightedIntoView(selector: string) {
    requestAnimationFrame(() => {
      const el = contentRef.current?.querySelector(selector + ' .highlighted') as HTMLElement | null;
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  const historySearchNav = {
    onArrowDown: () => { const count = historyRef.current?.count ?? 0; if (count > 0) { const next = Math.min(highlightedListIndex + 1, count - 1); library.setHighlightedListIndex(next); scrollHighlightedIntoView('.history-content'); } },
    onArrowUp: () => { const next = Math.max(highlightedListIndex - 1, 0); library.setHighlightedListIndex(next); scrollHighlightedIntoView('.history-content'); },
    onEnter: () => { if (highlightedListIndex >= 0) historyRef.current?.playItem(highlightedListIndex); },
  };

  const playlistsSearchNav = {
    onArrowDown: () => {},
    onArrowUp: () => {},
    onEnter: () => {},
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
        selectedTrack={library.selectedTrack}
        collapsed={sidebarCollapsed}
        onShowSearch={() => {
          pushAndScroll();
          library.setView("search");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowHistory={() => {
          pushAndScroll();
          library.setView("history");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowPlaylists={() => {
          pushAndScroll();
          library.setView("playlists");
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
        onShowSettings={() => {
          pushAndScroll();
          library.setView("settings");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        updateAvailable={updater.updateState.available !== null}
        pluginNavItems={plugins.sidebarItems}
        onPluginView={(pluginId, viewId) => {
          library.setView(`plugin:${pluginId}:${viewId}`);
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
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
                artistImagePath={track.artist_id ? artistImageCache.images[track.artist_id] ?? null : null}
                positionSecs={isCurrentTrack ? playback.positionSecs : 0}
                isCurrentTrack={isCurrentTrack}
                onArtistClick={library.handleArtistClick}
                onAlbumClick={library.handleAlbumClick}
                onTagClick={(tagId) => { library.setSelectedTrack(null); library.setSelectedTag(tagId); library.setView("tags"); }}
                onPlay={() => queueHook.playTracks([track], 0)}
                onPlayTrack={(t: Track) => queueHook.playTracks([t], 0)}
                onWatchOnYoutube={() => contextMenuActions.watchOnYoutube(track.id, track.title, track.artist_name, track.youtube_url)}
                onToggleLike={() => likeActions.handleToggleLike(track)}
                onToggleHate={() => likeActions.handleToggleDislike(track)}
                onShowInFolder={async () => { try { await invoke("show_in_folder", { trackId: library.selectedTrack }); } catch (e) { console.error("Failed to open containing folder:", e); contextMenuActions.setFolderError(String(e)); } }}
                collections={library.collections}
                searchProviders={searchProviders}
                onImageSet={(entityType, id, path) => {
                  if (entityType === "album") albumImageCache.setImages(prev => ({ ...prev, [id]: path }));
                  else artistImageCache.setImages(prev => ({ ...prev, [id]: path }));
                }}
                onImageRemoved={(entityType, id) => {
                  if (entityType === "album") albumImageCache.setImages(prev => ({ ...prev, [id]: null }));
                  else artistImageCache.setImages(prev => ({ ...prev, [id]: null }));
                }}
                onImageRefresh={(entityType, id, name) => {
                  if (entityType === "album") albumImageCache.forceFetchImage({ id, title: name, artist_name: track.artist_name });
                  else artistImageCache.forceFetchImage({ id, name });
                }}
                addLog={addLog}
                onUpdateTrack={(update) => library.setTracks(prev => prev.map(t => t.id === library.selectedTrack ? { ...t, ...update } : t))}
                invokeInfoFetch={plugins.invokeInfoFetch}
                pluginNames={plugins.pluginNames}
                onInfoTrackContextMenu={contextMenuActions.handleInfoTrackContextMenu}
                onEntityContextMenu={contextMenuActions.handleEntityContextMenu}
              />
            );
          })()}

          {library.selectedTrack === null && <>
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
                onToggleArtistHate={likeActions.handleToggleArtistHate}
                onAlbumContextMenu={contextMenuActions.handleAlbumContextMenu}
                searchProviders={searchProviders}
                artists={artists}
                invokeInfoFetch={plugins.invokeInfoFetch}
                pluginNames={plugins.pluginNames}
                onInfoTrackContextMenu={contextMenuActions.handleInfoTrackContextMenu}
                onEntityContextMenu={contextMenuActions.handleEntityContextMenu}
              />
            );
          })()}

          {/* Tag detail header */}
          {view === "tags" && selectedTag !== null && (() => {
            const tag = tags.find(t => t.id === selectedTag);
            const tagImagePath = tagImageCache.images[selectedTag] ?? null;
            return (
              <div
                className="album-detail-top"
                style={tagImagePath ? { '--artist-bg': `url(${convertFileSrc(tagImagePath)})` } as React.CSSProperties : undefined}
              >
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
                      <button
                        className={`detail-love-btn${tag?.liked === 1 ? " liked" : ""}`}
                        onClick={() => likeActions.handleToggleTagLike(selectedTag)}
                        title={tag?.liked === 1 ? "Unlike tag" : "Love tag"}
                      >
                        {tag?.liked === 1
                          ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                          : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>}
                      </button>
                      <button
                        className={`detail-hate-btn${tag?.liked === -1 ? " hated" : ""}`}
                        onClick={() => likeActions.handleToggleTagHate(selectedTag)}
                        title={tag?.liked === -1 ? "Remove hate" : "Hate tag"}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
                      </button>
                      {sortedTracks.length > 0 && (
                        <button
                          className="artist-play-btn"
                          title="Play All"
                          onClick={() => {
                            const tagImagePath = tagImageCache.images[selectedTag] ?? null;
                            queueHook.playTracks(sortedTracks.filter(t => t.liked !== -1), 0, tag ? { name: tag.name, coverPath: tagImagePath } : null);
                          }}
                        >&#9654;</button>
                      )}
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
              </div>
            );
          })()}

          {/* Album detail header (albums view only; artists view renders inside .album-detail below) */}
          {view === "albums" && selectedAlbum !== null && (() => {
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
                onToggleAlbumHate={likeActions.handleToggleAlbumHate}
                onPlayTracks={queueHook.playTracks}
                onImageSet={(id, path) => albumImageCache.setImages(prev => ({ ...prev, [id]: path }))}
                onImageRemoved={(id) => albumImageCache.setImages(prev => ({ ...prev, [id]: null }))}
                onRetrieveImage={() => {
                  if (!album) return;
                  albumImageCache.forceFetchImage({ id: selectedAlbum, title: album.title, artist_name: album.artist_name });
                }}
              />
            );
          })()}

          {/* Search view */}
          {view === "search" && (
            <SearchView
              initialQuery={searchInitialQuery}
              initialQueryKey={searchQueryKey}
              currentTrack={playback.currentTrack}
              playing={playback.playing}
              viewModes={searchViewModes}
              onViewModesChange={handleSearchViewModesChange}
              artistImages={artistImageCache.images}
              albumImages={albumImageCache.images}
              onPlayTracks={(tracks, index) => queueHook.playTracks(tracks, index)}
              onArtistClick={(id) => {
                library.setSelectedArtist(id);
                library.setView("artists");
              }}
              onAlbumClick={(id, artistId) => {
                library.setSelectedAlbum(id);
                if (artistId) library.setSelectedArtist(artistId);
                library.setView("albums");
              }}
              onTrackContextMenu={contextMenuActions.handleTrackContextMenu}
              onArtistContextMenu={contextMenuActions.handleArtistContextMenu}
              onAlbumContextMenu={contextMenuActions.handleAlbumContextMenu}
              onToggleLike={likeActions.handleToggleLike}
              onToggleDislike={likeActions.handleToggleDislike}
              onToggleArtistLike={likeActions.handleToggleArtistLike}
              onToggleAlbumLike={likeActions.handleToggleAlbumLike}
              onTrackDragStart={contextMenuActions.handleTrackDragStart}
              onTagClick={(id) => { library.setSelectedTag(id); library.setView("tags"); }}
              onToggleTagLike={likeActions.handleToggleTagLike}
              onFetchArtistImage={artistImageCache.fetchOnDemand}
              onFetchAlbumImage={albumImageCache.fetchOnDemand}
              onFetchTagImage={tagImageCache.fetchOnDemand}
              tagImages={tagImageCache.images}
              columns={library.trackColumns}
              onColumnsChange={library.setTrackColumns}
            />
          )}

          {/* Artist album detail — unified scrollable container like artist-detail */}
          {(view === "artists" && selectedAlbum !== null) && (() => {
            const album = albums.find(a => a.id === selectedAlbum);
            const albumImagePath = albumImageCache.images[selectedAlbum] ?? null;
            const albumEntity = album ? {
              kind: "album" as const,
              name: album.title,
              id: album.id,
              artistName: album.artist_name ?? undefined,
            } : null;
            return (
              <div className="album-detail">
                <AlbumDetailHeader
                  selectedAlbum={selectedAlbum}
                  album={album}
                  albumImagePath={albumImagePath}
                  sortedTracks={sortedTracks}
                  searchProviders={searchProviders}
                  onArtistClick={library.handleArtistClick}
                  onToggleAlbumLike={likeActions.handleToggleAlbumLike}
                  onToggleAlbumHate={likeActions.handleToggleAlbumHate}
                  onPlayTracks={queueHook.playTracks}
                  onImageSet={(id, path) => albumImageCache.setImages(prev => ({ ...prev, [id]: path }))}
                  onImageRemoved={(id) => albumImageCache.setImages(prev => ({ ...prev, [id]: null }))}
                  onRetrieveImage={() => {
                    if (!album) return;
                    albumImageCache.forceFetchImage({ id: selectedAlbum, title: album.title, artist_name: album.artist_name });
                  }}
                />
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
                {albumEntity && (
                  <div className="section-wide">
                    <InformationSections
                      entity={albumEntity}
                      exclude={[]}
                      placement="below"
                      invokeInfoFetch={plugins.invokeInfoFetch}
                      pluginNames={plugins.pluginNames}
                      tabOrder={albumBelowTabOrder}
                      onTabOrderChange={handleAlbumBelowTabOrderChange}
                      onAction={(actionId, payload) => {
                        if (actionId === "play-track") {
                          const t = payload as Track | undefined;
                          if (t) queueHook.playTracks([t], 0);
                        }
                      }}
                      onTrackContextMenu={contextMenuActions.handleInfoTrackContextMenu}
                      onEntityContextMenu={contextMenuActions.handleEntityContextMenu}
                    />
                  </div>
                )}
              </div>
            );
          })()}

          {/* Album detail "below" information sections (albums view only) */}
          {view === "albums" && selectedAlbum !== null && (() => {
            const album = albums.find(a => a.id === selectedAlbum);
            const albumEntity = album ? {
              kind: "album" as const,
              name: album.title,
              id: album.id,
              artistName: album.artist_name ?? undefined,
            } : null;
            return (
              <div className="section-wide">
                <InformationSections
                  entity={albumEntity}
                  exclude={[]}
                  placement="below"
                  invokeInfoFetch={plugins.invokeInfoFetch}
                  pluginNames={plugins.pluginNames}
                  tabOrder={albumBelowTabOrder}
                  onTabOrderChange={handleAlbumBelowTabOrderChange}
                  onAction={(actionId, payload) => {
                    if (actionId === "play-track") {
                      const t = payload as Track | undefined;
                      if (t) queueHook.playTracks([t], 0);
                    }
                  }}
                  onTrackContextMenu={contextMenuActions.handleInfoTrackContextMenu}
                  onEntityContextMenu={contextMenuActions.handleEntityContextMenu}
                />
              </div>
            );
          })()}

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

          {/* Playlists view */}
          {view === "playlists" && (
            <>
              <ViewSearchBar
                query={viewSearch.getQuery("playlists")}
                onQueryChange={(q) => viewSearch.setQuery("playlists", q)}
                placeholder="Search playlists..."
                {...playlistsSearchNav}
              />
              <PlaylistsView
                searchQuery={viewSearch.getQuery("playlists")}
                onPlayTracks={queueHook.playTracks}
                onEnqueueTracks={queueHook.enqueueTracks}
                onExportAsTape={handleExportAsTape}
                onOpenTape={setTapePreviewPath}
                pluginMenuItems={plugins.menuItems}
                onPluginAction={plugins.dispatchContextMenuAction}
              />
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
                onTrackContextMenu={(e, track) => {
                  contextMenuActions.setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "track", trackId: track.id, subsonic: track.path.startsWith("subsonic://"), title: track.title, artistName: track.artist_name } });
                }}
                onTrackRowContextMenu={(e, item) => {
                  contextMenuActions.setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "track", trackId: 0, subsonic: false, title: item.title, artistName: item.subtitle ?? null, external: true } });
                }}
                pluginMenuItems={plugins.menuItems}
                onPluginAction={plugins.dispatchContextMenuAction}
              />
            );
          })()}
          {/* Settings view */}
          {view === "settings" && (
            <SettingsPanel
              searchProviders={searchProviders}
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
              onFallbackOrderChanged={() => setFallbackOrderVersion(v => v + 1)}
            />
          )}
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
          playlistContext={queueHook.playlistContext}
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
            if (track.id) {
              library.handleTrackClick(track.id);
            }
          }}
          onMoveMultiple={queueHook.moveMultiple}
          onClear={queueHook.clearQueue}
          onSavePlaylist={queueHook.savePlaylist}
          onSaveAsPlaylist={handleSaveAsPlaylist}
          onLoadPlaylist={() => queueHook.loadPlaylist(setTapePreviewPath)}
          onContextMenu={(e, indices) => {
            const tracks = indices.map(i => queueHook.queue[i]).filter(Boolean);
            const first = tracks[0];
            contextMenuActions.setContextMenu({ x: e.clientX, y: e.clientY, target: {
              kind: "queue-multi", indices,
              trackIds: tracks.map(t => t.id),
              firstTrack: first ? { title: first.title, artistName: first.artist_name, subsonic: first.path.startsWith("subsonic://"), hasLocalPath: !first.path.startsWith("subsonic://") && !first.path.startsWith("tidal://") } : { title: "", artistName: null, subsonic: false },
            } });
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
          onViewDetails={contextMenuActions.contextMenu.target.kind === "track" && contextMenuActions.contextMenu.target.trackId ? () => library.handleTrackClick(contextMenuActions.contextMenu!.target.kind === "track" && contextMenuActions.contextMenu!.target.trackId ? contextMenuActions.contextMenu!.target.trackId : 0) : undefined}
          onBulkEdit={contextMenuActions.handleBulkEdit}
          onDelete={contextMenuActions.handleDeleteRequest}
          onRefreshImage={contextMenuActions.contextMenu.target.kind === "artist" && contextMenuActions.contextMenu.target.artistId
            ? () => { const t = contextMenuActions.contextMenu!.target; if (t.kind === "artist" && t.artistId) artistImageCache.forceFetchImage({ id: t.artistId, name: t.name }); }
            : contextMenuActions.contextMenu.target.kind === "album" && contextMenuActions.contextMenu.target.albumId
            ? () => { const t = contextMenuActions.contextMenu!.target; if (t.kind === "album" && t.albumId) albumImageCache.forceFetchImage({ id: t.albumId, title: t.title, artist_name: t.artistName }); }
            : undefined}
          onRemoveFromQueue={contextMenuActions.handleQueueRemove}
          onKeepOnly={contextMenuActions.handleQueueKeepOnly}
          onMoveToTop={contextMenuActions.handleQueueMoveToTop}
          onMoveToBottom={contextMenuActions.handleQueueMoveToBottom}
          onLocateTrack={contextMenuActions.contextMenu.target.kind === "queue-multi" && contextMenuActions.contextMenu.target.indices.length === 1 ? () => {
            const track = queueHook.queue[contextMenuActions.contextMenu!.target.kind === "queue-multi" ? contextMenuActions.contextMenu!.target.indices[0] : 0];
            if (track) {
              library.handleLocateTrack(track.title, track.artist_name, track.album_title, () => {
                setSearchInitialQuery(track.title);
                setSearchQueryKey(k => k + 1);
                library.setView("search");
                library.setSelectedArtist(null);
                library.setSelectedAlbum(null);
                library.setSelectedTag(null);
              });
            }
          } : undefined}
          onDownload={contextMenuActions.contextMenu.target.kind === "track" && contextMenuActions.contextMenu.target.trackId ? (destId: number) => { const t = contextMenuActions.contextMenu!.target; if (t.kind === "track" && t.trackId) downloads.downloadTrack(t.trackId, destId, library.tracks); } : undefined}
          localCollections={localCollections}
          onExportAsTape={handleExportAsTape}
          onClose={() => contextMenuActions.setContextMenu(null)}
          pluginMenuItems={plugins.menuItems}
          onPluginAction={plugins.dispatchContextMenuAction}
          onSetDockSide={videoLayout.setDockSide}
          onSetFitMode={videoLayout.setFitMode}
        />
      )}

      {tidalAlbumDownload && (
        <TidalAlbumDownloadModal
          input={tidalAlbumDownload}
          downloadFormat={downloads.downloadFormat}
          collections={localCollections}
          store={store}
          lastDest={lastTidalDownloadDest}
          onClose={() => setTidalAlbumDownload(null)}
          onComplete={(msg) => { setTidalAlbumDownload(null); addLog(msg); }}
        />
      )}

      {contextMenuActions.tidalDownload && (
        <TidalDownloadModal
          input={contextMenuActions.tidalDownload}
          libraryTrack={contextMenuActions.tidalDownload.trackId != null ? library.tracks.find(t => t.id === contextMenuActions.tidalDownload!.trackId) ?? null : null}
          downloadFormat={downloads.downloadFormat}
          collections={localCollections}
          store={store}
          lastDest={lastTidalDownloadDest}
          onClose={() => contextMenuActions.setTidalDownload(null)}
          onComplete={(msg) => { contextMenuActions.setTidalDownload(null); library.loadLibrary(); library.loadTracks(); addLog(msg); }}
        />
      )}

      {contextMenuActions.bulkEditTracks && (
        <BulkEditModal
          tracks={contextMenuActions.bulkEditTracks}
          onClose={() => contextMenuActions.setBulkEditTracks(null)}
        />
      )}

      {contextMenuActions.deleteConfirm && (
        <div className="ds-modal-overlay" onClick={() => contextMenuActions.setDeleteConfirm(null)}>
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete {contextMenuActions.deleteConfirm.title}?</h2>
            <p className="delete-confirm-warning">This will permanently delete the file{contextMenuActions.deleteConfirm.trackIds.length > 1 ? "s" : ""} from disk.</p>
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--ghost" onClick={() => contextMenuActions.setDeleteConfirm(null)}>Cancel</button>
              <button className="ds-btn ds-btn--danger" onClick={contextMenuActions.handleDeleteConfirm} autoFocus>Delete</button>
            </div>
          </div>
        </div>
      )}

      {contextMenuActions.deleteError && (
        <div className="ds-modal-overlay" onClick={() => contextMenuActions.setDeleteError(null)}>
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
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
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--ghost" onClick={() => contextMenuActions.setDeleteError(null)}>OK</button>
            </div>
          </div>
        </div>
      )}

      {contextMenuActions.folderError && (
        <div className="ds-modal-overlay" onClick={() => contextMenuActions.setFolderError(null)}>
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Open Containing Folder</h2>
            <p className="delete-confirm-warning">{contextMenuActions.folderError}</p>
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--ghost" onClick={() => contextMenuActions.setFolderError(null)}>OK</button>
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
        <div className="ds-modal-overlay" onClick={() => collectionActions.setRemoveCollectionConfirm(null)}>
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Remove &ldquo;{collectionActions.removeCollectionConfirm.name}&rdquo;?</h2>
            <p className="delete-confirm-warning">This will permanently remove this collection and all its tracks from the library.</p>
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--ghost" onClick={() => collectionActions.setRemoveCollectionConfirm(null)}>Cancel</button>
              <button className="ds-btn ds-btn--danger" onClick={collectionActions.handleRemoveCollectionConfirm}>Remove</button>
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

      {tapePreviewPath && (
        <TapePreviewModal
          tapePath={tapePreviewPath}
          onClose={() => setTapePreviewPath(null)}
          onQueueTracks={handleTapeQueueTracks}
        />
      )}
      {tapeExportTracks && (
        <TapeExportModal
          tracks={tapeExportTracks}
          defaultTitle={tapeExportDefaultTitle}
          onClose={() => setTapeExportTracks(null)}
        />
      )}

      {navError && (
        <div className="ds-modal-overlay" onClick={() => setNavError(null)}>
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Navigation Error</h2>
            <p>{navError}</p>
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--primary" onClick={() => setNavError(null)}>OK</button>
            </div>
          </div>
        </div>
      )}

      {pluginLoadingMessage && (
        <div className="ds-modal-overlay">
          <div className="loading-card">
            <div className="loading-card-icon">
              <div className="loading-card-spinner" />
            </div>
            <div className="loading-card-text">
              <div className="loading-card-title">Loading...</div>
              <div className="loading-card-sub">{pluginLoadingMessage}</div>
            </div>
          </div>
        </div>
      )}

      {showSavePlaylistModal && (
        <SavePlaylistModal
          defaultName={(() => {
            const date = new Date();
            const dateStr = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
            return queueHook.playlistContext?.name
              ? `${queueHook.playlistContext.name} ${dateStr}`
              : `Queue ${dateStr}`;
          })()}
          onSave={handleSavePlaylistConfirm}
          onClose={() => setShowSavePlaylistModal(false)}
        />
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

      {contextMenuActions.youtubeFeedback && (
        <div className="youtube-modal-overlay" onClick={() => contextMenuActions.handleYoutubeFeedback(false)}>
          <div className="youtube-modal" onClick={e => e.stopPropagation()}>
            <div className="youtube-modal-icon"><IconYoutube size={24} /></div>
            <div className="youtube-modal-text">
              Is this the right video for "<strong>{contextMenuActions.youtubeFeedback.videoTitle}</strong>"?<br />
              Save this link for future use?
            </div>
            <a className="youtube-modal-link" onClick={() => openUrl(contextMenuActions.youtubeFeedback!.url)}>{contextMenuActions.youtubeFeedback.url}</a>
            <div className="youtube-modal-actions">
              <button className="youtube-modal-btn" onClick={() => contextMenuActions.handleYoutubeFeedback(false)}>No</button>
              <button className="youtube-modal-btn yes" onClick={() => contextMenuActions.handleYoutubeFeedback(true)}>Yes</button>
            </div>
          </div>
        </div>
      )}

      <StatusBar
        sessionLog={sessionLog}
        activity={statusActivity}
        downloadStatus={downloads.downloadStatus}
        onCancelDownload={downloads.cancelDownload}
      />

    </div>
  );
}

export default App;
