import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { exit } from "@tauri-apps/plugin-process";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrent as getDeepLinkCurrent } from "@tauri-apps/plugin-deep-link";
import { listen } from "@tauri-apps/api/event";
import "./base.css";
import "./design-system.css";
import "./App.css";

import type { Track, QueueTrack, ViewMode, ColumnConfig, SortField, SortDir, Collection, ResolvedTrackSource } from "./types";
import { isVideoTrack, parseSubsonicUrl, trashLabel } from "./utils";

import { store } from "./store";
import { readPersistedSettings } from "./startup/readPersistedSettings";
import { parseUrlScheme, trackToQueueEntry, nextExternalKey, parseLibraryId, isLocalTrack, isNetworkSharePath } from "./queueEntry";
import { tracksFromManifest, contextFromManifest, contextToExportMetadata, contextFromMixtapeMetadata, type Manifest, type MainPlaylistState } from "./mainPlaylist";
import { recordVisit, type RecentlyVisitedEntry } from "./utils/recentlyVisited";
import { resolveImageUrl } from "./utils/resolveImageUrl";
import { buildTagSuggestionPool } from "./utils/tagSuggestions";
import { resolveShelfPlayAction } from "./utils/homeShelfPlay";
import { builtinQualityOptions } from "./utils/builtinDownloadQualities";
import type { SearchProviderConfig } from "./searchProviders";
import { DEFAULT_PROVIDERS, loadProviders, saveProviders } from "./searchProviders";
import { type StreamResolver, stripRemasterSuffix } from "./streamResolvers";
import { BUILTIN_PRESETS, presetForGains } from "./eqPresets";
import { timeAsync, getTimingEntries, type TimingEntry } from "./startupTiming";

import { usePlayback } from "./hooks/usePlayback";
import { useStreamResolution } from "./hooks/useStreamResolution";
import { useDownloadOrchestration } from "./hooks/useDownloadOrchestration";
import { useQueue } from "./hooks/useQueue";
import { usePlayActions } from "./hooks/usePlayActions";
import { useToasts } from "./hooks/useToasts";
import { Toasts } from "./components/Toasts";
import { useLibrary, DEFAULT_TRACK_COLUMNS } from "./hooks/useLibrary";
import { useEventListeners } from "./hooks/useEventListeners";
import { useImageCache } from "./hooks/useImageCache";
import { useAutoContinue } from "./hooks/useAutoContinue";
import { usePasteImage } from "./hooks/usePasteImage";
import { useNavigationHistory, type NavState } from "./hooks/useNavigationHistory";
import { useAppUpdater } from "./hooks/useAppUpdater";
import { useMiniMode, cycleRestingSize, cycleMiniWidth } from "./hooks/useMiniMode";
import { useVideoLayout } from "./hooks/useVideoLayout";
import { useWaveform } from "./hooks/useWaveform";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useInAppKeyboardShortcuts } from "./hooks/useInAppKeyboardShortcuts";
import { useSkins } from "./hooks/useSkins";
import { usePlugins, type PluginHostCallbacks } from "./hooks/usePlugins";
import { useImageResolver } from "./hooks/useImageResolver";
import { useRetrieveModal } from "./hooks/useRetrieveModal";
import { RetrieveModal } from "./components/RetrieveModal";
import { useExtensions } from "./hooks/useExtensions";

import { useLikeActions } from "./hooks/useLikeActions";
import { useCollectionActions } from "./hooks/useCollectionActions";
import { useContextMenuActions } from "./hooks/useContextMenuActions";
import type { PluginTrack, PluginBadge } from "./types/plugin";
import { useViewSearchState } from "./hooks/useViewSearchState";
import { useCentralSearch } from "./hooks/useCentralSearch";
import { useMiniSearch } from "./hooks/useMiniSearch";
import { VideoFrameQueueProvider, useVideoFrameQueue } from "./hooks/useVideoFrameQueueContext";
import { DetailViewProvider, type DetailViewActions, type DetailViewState } from "./contexts/DetailViewContext";
import type { VideoFrameQueue } from "./videoFrameQueue";
import { CaptionBar } from "./components/CaptionBar";
import { ViewSearchBar } from "./components/ViewSearchBar";

import { Sidebar } from "./components/Sidebar";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { QueuePanel } from "./components/QueuePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import ExtensionsView from "./components/ExtensionsView";
import { FullscreenControls } from "./components/FullscreenControls";
import { VideoAmbientOverlay } from "./components/VideoAmbientOverlay";
import { AddServerModal } from "./components/AddServerModal";
import { showNativeMenu, type MenuItemSpec } from "./nativeMenu";
import { buildContextMenuSpecs } from "./contextMenu/buildContextMenuSpecs";
import { ArtistDetailContent } from "./components/ArtistDetailContent";
import { AlbumDetail } from "./components/AlbumDetail";
import { TagDetail } from "./components/TagDetail";
import { HistoryView } from "./components/HistoryView";
import type { HistoryViewHandle } from "./components/HistoryView";
import { PlaylistsView } from "./components/PlaylistsView";
import { SavePlaylistModal } from "./components/SavePlaylistModal";
import { CollectionsView } from "./components/CollectionsView";
import { EditCollectionModal } from "./components/EditCollectionModal";
import {
  DeleteTracksModal,
  DeleteTagsModal,
  DeleteErrorModal,
  FolderErrorModal,
  DownloadAgainModal,
  RemoveCollectionModal,
  NavErrorModal,
  PluginLoadingModal,
  DeepLinkInstallModal,
} from "./components/modals/ConfirmModals";
import { PluginViewRenderer } from "./components/PluginViewRenderer";
import { TrackDetailView } from "./components/TrackDetailView";
import { DownloadModal } from "./components/DownloadModal";
import { FirstRunPluginModal } from "./components/FirstRunPluginModal";
import BulkEditModal from "./components/BulkEditModal";
import PlaybackErrorModal from "./components/PlaybackErrorModal";
import { PromptModal } from "./components/PromptModal";
import { MixtapePreviewModal } from "./components/MixtapePreviewModal";
import { MixtapeExportModal } from "./components/MixtapeExportModal";
import type { ExportTrack } from "./components/MixtapeExportModal";

import { SearchView } from "./components/SearchView";
import { HomeView } from "./components/HomeView";
import { NowPlayingView } from "./components/NowPlayingView";
import { useLyrics } from "./hooks/useLyrics";
import type { ResolvedShelf } from "./hooks/useHome";
import type { HomeShelfItem } from "./types/plugin";
import { useDependencies } from "./hooks/useDependencies";
import { DependencyModal } from "./components/DependencyModal";


function VideoFrameQueueRefBridge({ refOut }: { refOut: React.MutableRefObject<VideoFrameQueue | null> }) {
  const queue = useVideoFrameQueue();
  useEffect(() => { refOut.current = queue; }, [queue, refOut]);
  return null;
}

function App() {
  const restoredRef = useRef(false);
  const handleEnqueueRef = useRef<(tracks: Track[]) => void>(() => {});
  const videoFrameQueueRef = useRef<VideoFrameQueue | null>(null);
  const [appRestoring, setAppRestoring] = useState(true);
  const [navError, setNavError] = useState<string | null>(null);
  const [showSavePlaylistModal, setShowSavePlaylistModal] = useState(false);
  const [showFirstRunPluginModal, setShowFirstRunPluginModal] = useState(false);
  const [editPlaylistMode, setEditPlaylistMode] = useState(false);
  const [pluginLoadingMessage, setPluginLoadingMessage] = useState<string | null>(null);
  const pendingRestoreTrackRef = useRef<QueueTrack | null>(null);
  const pendingRestoreQueueRef = useRef<{ tracks: QueueTrack[]; index: number } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const getScrollEl = useCallback(() => {
    const el = contentRef.current;
    if (!el) return null;
    return el.querySelector<HTMLElement>('.track-list, .entity-list, .entity-table, .entity-grid, .artist-detail, .album-detail, .history-view, .collections-view, .plugin-view, .settings-content-body');
  }, []);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<HistoryViewHandle>(null);
  // Set by applyNavState (back/forward) so the scroll-reset effect skips one run
  // and lets the nav restore set the saved scroll position instead.
  const suppressScrollResetRef = useRef(false);

  // Core hooks
  const peekNextRef = useRef<() => QueueTrack | null>(() => null);
  const prefetchNextRef = useRef<() => void>(() => {});
  const crossfadeSecsRef = useRef(3);
  const [crossfadeSecs, setCrossfadeSecs] = useState(3);
  crossfadeSecsRef.current = crossfadeSecs;
  const trackVideoHistoryRef = useRef(true);
  const [trackVideoHistory, setTrackVideoHistory] = useState(true);
  const [loggingEnabled, setLoggingEnabled] = useState(false);
  // Default ON — stale yt-dlp breaks against YouTube and the failure looks
  // like an app bug to users. See MANAGED-DEPENDENCIES-PLAN.md.
  const [autoUpdateManagedDeps, setAutoUpdateManagedDeps] = useState(true);
  const [minimizeToMiniPlayer, setMinimizeToMiniPlayer] = useState(false);
  const [eqCustomPresets, setEqCustomPresets] = useState<{ id: string; name: string; gains: number[] }[]>([]);
  const [eqShowBarControlSimple, setEqShowBarControlSimple] = useState(true);
  const [eqShowBarControlAdvanced, setEqShowBarControlAdvanced] = useState(false);
  const [eqSaveAsOpen, setEqSaveAsOpen] = useState(false);
  const [debugLogging, setDebugLogging] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [devPluginPath, setDevPluginPath] = useState<string | null>(null);
  const [lastDownloadDest, setLastDownloadDest] = useState<string | null>(null);
  const [downloadsCollectionId, setDownloadsCollectionId] = useState<number | null>(null);
  const [mainPlaylistDir, setMainPlaylistDir] = useState<string | null>(null);
  const downloadsCollectionIdRef = useRef<number | null>(null);
  trackVideoHistoryRef.current = trackVideoHistory;
  downloadsCollectionIdRef.current = downloadsCollectionId;
  const advanceIndexRef = useRef<() => void>(() => {});
  const resolveStreamByUriRef = useRef<(scheme: string, id: string, quality?: string | null) => Promise<string>>(
    async () => { throw new Error("Stream URI resolver not ready"); }
  );
  const resolveTrackSrcRef = useRef<(track: QueueTrack) => Promise<ResolvedTrackSource>>(async (track) => {
    const url = track.path;
    if (!url) throw new Error("Track has no URL");
    const parsed = parseUrlScheme(url);
    if (parsed.scheme === "file") return { src: convertFileSrc(parsed.path) };
    if (parsed.scheme === "plugin") {
      const resolved = await resolveStreamByUriRef.current(parsed.protocol, parsed.id, null);
      if (resolved.startsWith("file://")) return { src: convertFileSrc(resolved.substring(7)) };
      return { src: resolved };
    }
    if (parsed.scheme === "external") throw new Error("Cannot play external track directly — requires stream resolver");
    return { src: await invoke<string>("resolve_subsonic_location", { location: parsed.url }) };
  });
  const streamResolversRef = useRef<StreamResolver[]>([]);
  const [streamResolverOrderVersion, setStreamResolverOrderVersion] = useState(0);
  const transcodeSessionRef = useRef<{ sessionId: string; baseUrl: string; durationSecs: number | null; seekOffset: number } | null>(null);
  const playback = usePlayback(restoredRef, peekNextRef, crossfadeSecsRef, advanceIndexRef, trackVideoHistoryRef, resolveTrackSrcRef, prefetchNextRef, transcodeSessionRef);
  const waveformPeaks = useWaveform(
    playback.currentTrack?.path ?? null,
    playback.currentTrack?.title ?? null,
    playback.currentTrack?.artist_name ?? null,
    playback.currentTrack?.duration_secs ?? null,
    null,
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
      invoke<number | null>("get_track_rank", { title: track.title, artistName: track.artist_name }),
      track.artist_name
        ? invoke<number | null>("get_artist_rank", { artistName: track.artist_name })
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
      invoke<number | null>("get_track_rank", { title: track.title, artistName: track.artist_name }),
      track.artist_name
        ? invoke<number | null>("get_artist_rank", { artistName: track.artist_name })
        : Promise.resolve(null),
    ]).then(([tRank, aRank]) => {
      if (!cancelled) { setTrackRank(tRank); setArtistRank(aRank); }
    }).catch(console.error);
    return () => { cancelled = true; };
  }, [playback.scrobbled]);

  const beforeNavRef = useRef<() => void>(() => {});
  const viewSearch = useViewSearchState();

  const debugLoggingRef = useRef(false);
  const setDebugLoggingRef = useCallback((enabled: boolean) => {
    debugLoggingRef.current = enabled;
  }, []);
  const albumImageCache = useImageCache("album");

  const library = useLibrary(restoredRef, () => beforeNavRef.current(), viewSearch.getDebouncedQuery, undefined, setNavError);
  const downloadsCollection = useMemo(() => downloadsCollectionId != null ? library.collections.find(c => c.id === downloadsCollectionId) ?? null : null, [downloadsCollectionId, library.collections]);

  const queueHook = useQueue(restoredRef, playback.handlePlay);
  const autoContinue = useAutoContinue(restoredRef);
  const mini = useMiniMode(restoredRef);
  const videoLayout = useVideoLayout(restoredRef);

  // Plugin system
  const pluginTrackRef = useRef<QueueTrack | null>(null);
  pluginTrackRef.current = playback.currentTrack;
  const pluginPlayingRef = useRef(false);
  pluginPlayingRef.current = playback.playing;
  const pluginPositionRef = useRef(0);
  pluginPositionRef.current = playback.positionSecs;
  const pluginTrackToQueueTrack = useCallback((info: PluginTrack): QueueTrack => {
    return {
      key: nextExternalKey(),
      path: info.path ?? null,
      title: info.title,
      artist_name: info.artist_name ?? null,
      album_title: info.album_title ?? null,
      duration_secs: info.duration_secs ?? null,
      format: null,
      liked: 0,
      image_url: info.image_url ?? undefined,
    };
  }, []);
  const pluginPlaybackCallbacks = useMemo(() => ({
    playTrack: (track: PluginTrack) => {
      queueHook.playTracks([pluginTrackToQueueTrack(track)], 0);
    },
    playTracks: (tracks: PluginTrack[], startIndex?: number, context?: { name?: string; playlistName?: string; coverUrl?: string | null; source?: string | null; description?: string | null; metadata?: Record<string, string> | null }) => {
      const displayName = context?.playlistName || context?.name || "";
      const cleanName = context?.name || context?.playlistName || "";
      const meta = { ...(context?.metadata ?? {}) };
      if (cleanName && cleanName !== displayName) meta.playlistName = cleanName;
      queueHook.playTracks(tracks.map(pluginTrackToQueueTrack), startIndex ?? 0, context && displayName ? { name: displayName, source: context.source ?? null, description: context.description ?? null, metadata: Object.keys(meta).length > 0 ? meta : null, remote: true, imagePath: context.coverUrl ?? null } : undefined);
    },
    insertTrack: (track: PluginTrack, position: number) => {
      const converted = [pluginTrackToQueueTrack(track)];
      if (position === -1) {
        queueHook.enqueueTracks(converted);
      } else {
        queueHook.insertAtPosition(converted, position);
      }
    },
    insertTracks: (tracks: PluginTrack[], position: number) => {
      const converted = tracks.map(pluginTrackToQueueTrack);
      if (position === -1) {
        queueHook.enqueueTracks(converted);
      } else {
        queueHook.insertAtPosition(converted, position);
      }
    },
  }), [queueHook, pluginTrackToQueueTrack]);
  const pluginHostCallbacksRef = useRef<PluginHostCallbacks | undefined>(undefined);
  // Defer plugin loading until the cold-start critical path has settled
  // (window shown + state restored). `!appRestoring` flips true at that point;
  // plugins then load in the background without contending with startup on the
  // single IPC channel. debugMode/devPluginPath are restored before this flips,
  // so the deferred first load already sees their final values.
  const plugins = usePlugins(pluginTrackRef, pluginPlayingRef, pluginPositionRef, pluginPlaybackCallbacks, pluginHostCallbacksRef.current, debugMode, devPluginPath, !appRestoring);
  const dependencies = useDependencies(plugins.pluginStates);
  if (import.meta.env.DEV) (window as any).__dependencies = dependencies;

  // Host-owned "missing required dependency" indicator: cross-reference each
  // enabled plugin's manifest binaryDependencies (required) against the host's
  // dependency status, and put an error dot on that plugin's sidebar item(s).
  // The plugins themselves no longer check — they only declare in the manifest.
  const depBadgeMap = useMemo(() => {
    const m = new Map<string, PluginBadge>();
    if (dependencies.deps.length === 0) return m;
    const installed = new Set(
      dependencies.deps.filter((d) => d.status === "installed").map((d) => d.name),
    );
    for (const ps of plugins.pluginStates) {
      if (!ps.enabled) continue;
      const missing = (ps.manifest.binaryDependencies ?? []).some(
        (bd) => bd.required && !installed.has(bd.name),
      );
      if (!missing) continue;
      for (const item of plugins.sidebarItems) {
        if (item.pluginId === ps.id) {
          m.set(`${item.pluginId}:${item.id}`, { type: "dot", variant: "error", tooltip: "Missing required dependency — open Settings → Dependencies" });
        }
      }
    }
    return m;
  }, [dependencies.deps, plugins.pluginStates, plugins.sidebarItems]);

  // Merge host dependency dots over plugin-set badges (host dot wins on conflict).
  const mergedBadgeMap = useMemo(() => {
    if (depBadgeMap.size === 0) return plugins.badgeMap;
    const m = new Map(plugins.badgeMap);
    for (const [k, v] of depBadgeMap) m.set(k, v);
    return m;
  }, [plugins.badgeMap, depBadgeMap]);

  // Populate host dependency status once, after startup settles and plugins have
  // loaded (so every enabled plugin's declarations are included). Cache-only and
  // off the critical path — drives the sidebar dot + Settings "needed by" list.
  const depsCheckedRef = useRef(false);
  useEffect(() => {
    if (appRestoring || !plugins.pluginsLoaded || depsCheckedRef.current) return;
    depsCheckedRef.current = true;
    dependencies.checkAll().catch(console.error);
  }, [appRestoring, plugins.pluginsLoaded, dependencies]);

  // Playback source-resolution engine. The refs it drives are created above (so
  // usePlayback can consume them); this wires the resolver chain + transcode
  // lifecycle and exposes the render-facing resolution state.
  const { resolvingStatus, resolveFailures, resolvedSource } = useStreamResolution({
    resolveTrackSrcRef,
    transcodeSessionRef,
    resolveStreamByUriRef,
    streamResolversRef,
    resolveStreamByUri: plugins.resolveStreamByUri,
    requireDep: dependencies.requireDep,
    queue: queueHook.queue,
    currentTrack: playback.currentTrack,
  });

  // Centered, cancelable "Retrieve" modal for user-triggered image/info fetches
  // (preview → Apply). Automatic background image fetching is unaffected.
  const retrieve = useRetrieveModal(plugins.invokeImageFetch, plugins.invokeInfoFetch);

  // Wire up image resolver to handle image-resolve-request events (automatic
  // background fetching). User-triggered retrieval goes through `retrieve`.
  useImageResolver(plugins.invokeImageFetch);

  // Open the Retrieve modal for an entity image: gather the active providers
  // (priority order) and hand them to the modal for preview-then-apply.
  const beginRetrieveImage = useCallback(async (kind: "artist" | "album" | "tag", name: string, artistName?: string | null) => {
    try {
      const providers = await invoke<Array<[string, number, number]>>("get_image_providers", { entity: kind });
      retrieve.openImage({ kind, name, artistName: artistName ?? null, providers, pluginNames: plugins.pluginNames });
    } catch (e) {
      console.error("Failed to load image providers:", e);
      retrieve.openImage({ kind, name, artistName: artistName ?? null, providers: [], pluginNames: plugins.pluginNames });
    }
  }, [retrieve, plugins.pluginNames]);

  // Build ordered stream resolver list from built-in + plugins + user ordering
  useEffect(() => {
    const buildResolvers = async () => {
      const builtinLibrary: StreamResolver = {
        id: "built-in:library",
        name: "Library",
        source: "built-in",
        resolve: async (title, artistName, albumName) => {
          const track = await invoke<Track | null>("find_track_by_metadata", {
            title: stripRemasterSuffix(title) ?? title,
            artistName,
            albumName: stripRemasterSuffix(albumName),
          });
          if (!track || !track.path) return null;
          const filePath = track.path.startsWith("file://") ? track.path.substring(7) : track.path;
          return { url: track.path, label: "Library", sourceUrl: filePath };
        },
      };

      // Collect plugin stream resolvers from manifests
      const pluginResolvers: StreamResolver[] = [];
      for (const ps of plugins.pluginStates) {
        if (ps.status !== "active") continue;
        const srs = ps.manifest.contributes?.streamResolvers;
        if (!srs) continue;
        for (const sr of srs) {
          pluginResolvers.push({
            id: `${ps.id}:${sr.id}`,
            name: sr.name,
            source: ps.id,
            resolve: (title, artistName, albumName, durationSecs) =>
              plugins.invokeStreamResolve(ps.id, sr.id, title, artistName, albumName, durationSecs),
          });
        }
      }

      // Apply user ordering from store
      const storedOrder = await store.get<Array<{ id: string; enabled: boolean }>>("streamResolverOrder");
      const allResolvers = [builtinLibrary, ...pluginResolvers];

      if (storedOrder) {
        const ordered: StreamResolver[] = [];
        for (const entry of storedOrder) {
          if (!entry.enabled) continue;
          const resolver = allResolvers.find((r) => r.id === entry.id);
          if (resolver) ordered.push(resolver);
        }
        for (const resolver of allResolvers) {
          if (!ordered.some((r) => r.id === resolver.id)) {
            ordered.push(resolver);
          }
        }
        streamResolversRef.current = ordered;
      } else {
        streamResolversRef.current = allResolvers;
      }
    };
    buildResolvers();
  }, [plugins.pluginStates, plugins.invokeStreamResolve, streamResolverOrderVersion]);


  // Plugin event: track started
  const prevTrackKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const track = playback.currentTrack;
    if (track && track.key !== prevTrackKeyRef.current) {
      prevTrackKeyRef.current = track.key;
      plugins.dispatchEvent("track:started", track);
    }
  }, [playback.currentTrack, plugins.dispatchEvent]);

  useEffect(() => {
    const track = playback.currentTrack;
    if (track) {
      const parts = [track.artist_name, track.title].filter(Boolean);
      document.title = parts.length ? parts.join(" — ") : "Viboplr";
    } else {
      document.title = "Viboplr";
    }
  }, [playback.currentTrack]);

  const mediaSessionNextRef = useRef<() => void>(() => {});

  // Plugin event: track played (scrobble threshold) and scrobbled
  useEffect(() => {
    if (!playback.scrobbled) return;
    const track = playback.currentTrack;
    if (!track) return;
    plugins.dispatchEvent("track:scrobbled", track);
  }, [playback.scrobbled, playback.currentTrack, plugins.dispatchEvent]);

  // Reset scroll position when view or selections change
  const currentSearchQuery = viewSearch.getQuery(library.view);
  useEffect(() => {
    // Skip when this change came from a back/forward nav restore — applyNavState
    // restores the saved scroll position itself, and resetting would clobber it.
    if (suppressScrollResetRef.current) {
      suppressScrollResetRef.current = false;
      return;
    }
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
  const [, setScanning] = useState(false);
  const [, setSyncing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [, setScanProgress] = useState({ scanned: 0, total: 0 });
  const [, setSyncProgress] = useState({ synced: 0, total: 0, collection: "" });
  const [resyncProgress, setResyncProgress] = useState<{
    collectionId: number;
    collectionName: string;
    kind: "scan" | "sync";
    scanned: number;
    total: number;
  } | null>(null);
  const [resyncComplete, setResyncComplete] = useState<{
    collectionId: number;
    collectionName: string;
    newTracks: number;
    removedTracks: number;
    error?: string;
  } | null>(null);
  const [detailTrack, setDetailTrack] = useState<Track | null>(null);
  const [showAddServer, setShowAddServer] = useState(false);
  const [deepLinkServer, setDeepLinkServer] = useState<{ name?: string; url: string; username: string; password: string } | null>(null);
  const [deepLinkInstall, setDeepLinkInstall] = useState<{ kind: "plugin" | "skin"; url: string } | null>(null);
  const [mixtapePreviewPath, setMixtapePreviewPath] = useState<string | null>(null);
  const [mixtapeExportTracks, setMixtapeExportTracks] = useState<ExportTrack[] | null>(null);
  const [mixtapeExportDefaultTitle, setMixtapeExportDefaultTitle] = useState<string>("");
  const [mixtapeExportDefaultCover, setMixtapeExportDefaultCover] = useState<string | null>(null);
  const [mixtapeExportDefaultMetadata, setMixtapeExportDefaultMetadata] = useState<Record<string, string> | null>(null);
  const [mixtapeExportDefaultType, setMixtapeExportDefaultType] = useState<"custom" | "album" | "best_of_artist">("custom");

  const [deleteTagConfirm, setDeleteTagConfirm] = useState<{ id: number; name: string }[] | null>(null);

  const [searchProviders, setSearchProviders] = useState<SearchProviderConfig[]>(DEFAULT_PROVIDERS);
  const [backendTimings, setBackendTimings] = useState<TimingEntry[]>([]);

  const [showHelp, setShowHelp] = useState(false);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const [queueWidth, setQueueWidth] = useState(300);
  const [searchViewModes, setSearchViewModes] = useState<{ tracks: ViewMode; albums: ViewMode; artists: ViewMode; tags: ViewMode }>({ tracks: "list", albums: "tiles", artists: "tiles", tags: "tiles" });
  const [searchInitialQuery, setSearchInitialQuery] = useState<string | null>(null);
  const [searchQueryKey, setSearchQueryKey] = useState(0);
  const [searchDeletedBatch, setSearchDeletedBatch] = useState<{ ids: number[]; key: number }>({ ids: [], key: 0 });
  const [searchDeletedTagBatch, setSearchDeletedTagBatch] = useState<{ ids: number[]; key: number }>({ ids: [], key: 0 });
  const [searchBulkEditKey, setSearchBulkEditKey] = useState(0);

  // Updater
  const updater = useAppUpdater(playback.handleStop);

  // Skins
  const skins = useSkins();

  // Extensions
  const extensionsHook = useExtensions({
    pluginStates: plugins.pluginStates,
    installedSkins: skins.installedSkins,
    activeSkinId: skins.activeSkinId,
    gallerySkins: skins.gallerySkins,
    galleryPlugins: plugins.galleryPlugins || [],
    onTogglePlugin: (id: string) => {
      const plugin = plugins.pluginStates.find(p => p.id === id);
      if (plugin) {
        return plugins.togglePlugin(id, plugin.status !== "active");
      }
    },
    onReloadPlugin: plugins.reloadPlugin,
    onDeletePlugin: plugins.deletePlugin,
    onInstallPluginFromGallery: plugins.installFromGallery,
    onInstallSkinFromGallery: skins.installFromGallery,
    onDeleteSkin: skins.deleteSkin,
    onApplySkin: skins.applySkin,
    onFetchPluginGallery: plugins.fetchPluginGallery,
    onFetchSkinGallery: skins.fetchGallery,
    onReloadAllPlugins: plugins.reloadAllPlugins,
  });

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
    collections: library.collections,
  });

  // Image caches
  const artistImageCache = useImageCache("artist");
  const tagImageCache = useImageCache("tag");

  // After the Retrieve modal applies a new image, drop the cached entry so the
  // displayed art (cards, hero, now-playing) re-resolves from disk.
  useEffect(() => {
    const onApplied = (e: Event) => {
      const detail = (e as CustomEvent).detail as { kind: "artist" | "album" | "tag"; name: string; artistName?: string | null };
      if (detail.kind === "artist") artistImageCache.invalidate(detail.name);
      else if (detail.kind === "album") albumImageCache.invalidate(detail.name, detail.artistName ?? null);
      else tagImageCache.invalidate(detail.name);
    };
    window.addEventListener("retrieve:image-applied", onApplied);
    return () => window.removeEventListener("retrieve:image-applied", onApplied);
  }, [artistImageCache, albumImageCache, tagImageCache]);

  const { toasts, notify, dismiss: dismissToast } = useToasts();

  const playActions = usePlayActions({
    playTracks: queueHook.playTracks,
    enqueueTracks: (tracks: Track[]) => handleEnqueueRef.current(tracks),
    setPlaylistContext: queueHook.setPlaylistContext,
    albums: library.albums,
    artists: library.artists,
    tags: library.tags,
    getAlbumImage: albumImageCache.getImage,
    getArtistImage: artistImageCache.getImage,
    getTagImage: tagImageCache.getImage,
    notify,
  });

  // Mini search drives both useMiniMode's window resize (via onOpen/ClosePanel)
  // and the keyboard trigger's "already open?" guard (via miniSearch.isOpen).
  const miniSearch = useMiniSearch({
    onPlayTrack: (track) => { queueHook.playTracks([track], 0); },
    onEnqueueTrack: (track) => { queueHook.enqueueTracks([track]); },
    playAlbum: (albumId) => { playActions.playAlbum(albumId); },
    enqueueAlbum: (albumId) => { playActions.enqueueAlbum(albumId); },
    playArtist: (artistId) => { playActions.playArtist(artistId); },
    enqueueArtist: (artistId) => { playActions.enqueueArtist(artistId); },
    onOpenPanel: () => { mini.openSearchPanel(); },
    onClosePanel: () => { mini.closeSearchPanel(); },
  });

  // Leaving mini mode must clear any open search panel, otherwise a stale
  // miniSearch.isOpen renders the panel clipped inside the resting-height
  // window on the next mini-mode entry.
  useEffect(() => {
    if (!mini.miniMode && miniSearch.isOpen) miniSearch.close();
  }, [mini.miniMode, miniSearch.isOpen, miniSearch.close]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const track = playback.currentTrack;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    const artSrc = resolveImageUrl(track.image_url ?? null);
    const artwork: MediaImage[] = artSrc ? [{ src: artSrc }] : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist_name ?? undefined,
      album: track.album_title ?? undefined,
      artwork,
    });
  }, [playback.currentTrack]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => {
      playback.getMediaElement()?.play().catch(console.error);
    });
    navigator.mediaSession.setActionHandler("pause", () => playback.handlePause());
    navigator.mediaSession.setActionHandler("previoustrack", () => queueHook.playPrevious());
    navigator.mediaSession.setActionHandler("nexttrack", () => mediaSessionNextRef.current());
    navigator.mediaSession.setActionHandler("stop", () => playback.handleStop());
  }, [playback.handlePause, playback.handleStop, queueHook.playPrevious]);

  // Context menu actions
  const showNativeMenuRef = useRef<((state: import("./types/contextMenu").ContextMenuState) => void) | null>(null);
  const handleExportAsMixtapeRef = useRef<((trackIds: number[], defaultTitle?: string) => void) | null>(null);
  // Assigned after handleNext/refs are defined; the wrapper below keeps the deps
  // object stable while reaching the live implementation.
  const currentTrackDeletedRef = useRef<(indices: number[]) => void>(() => {});

  const contextMenuActions = useContextMenuActions({
    library: {
      tracks: library.tracks,
      artists: library.artists,
      albums: library.albums,
      setTracks: library.setTracks,
      loadLibrary: library.loadLibrary,
      loadTracks: library.loadTracks,
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
    playActions,
    queueCollapsed,
    setQueueCollapsed,
    onTracksDeleted: (deletedIds: number[]) => {
      setSearchDeletedBatch(prev => ({ ids: deletedIds, key: prev.key + 1 }));
      for (const id of deletedIds) {
        videoFrameQueueRef.current?.evict(id);
      }
    },
    onCurrentTrackDeleted: (indices) => currentTrackDeletedRef.current(indices),
    onShowMenu: (state) => showNativeMenuRef.current?.(state),
  });

  // playActions is constructed before contextMenuActions, so the enqueue-entity
  // actions reach the dedup-aware handleEnqueue through this ref (updated each render).
  handleEnqueueRef.current = contextMenuActions.handleEnqueue;

  // Download-orchestration engine: ordered provider list, priorities, the backend
  // resolve-request bridge, the download modal, and every download trigger.
  const {
    downloadModal,
    setDownloadModal,
    downloadProviders,
    downloadProviderEntries,
    handleDownloadFromProvider,
    openDownloadForCurrentTrack,
  } = useDownloadOrchestration({
    plugins,
    contextMenu: contextMenuActions.contextMenu,
    libraryTracks: library.tracks,
    queue: queueHook.queue,
    handleDownloadTrackFallback: contextMenuActions.handleDownloadTrack,
  });

  const handleDeleteTracks = useCallback((trackIds: number[]) => {
    const idSet = new Set(trackIds);
    const selected = library.tracks.filter(t => t.id != null && idSet.has(t.id));
    const localIds = selected.filter(t => t.id != null && isLocalTrack(t)).map(t => t.id!);
    if (localIds.length === 0) return;
    const title = localIds.length === 1
      ? (selected.find(t => t.id != null && t.id === localIds[0])?.title ?? "track")
      : `${localIds.length} tracks`;
    const network = selected.some(t => t.id != null && localIds.includes(t.id) && isNetworkSharePath(t.path));
    contextMenuActions.setDeleteConfirm({ trackIds: localIds, title, network });
  }, [library.tracks, contextMenuActions.setDeleteConfirm]);

  const buildAndShowNativeMenu = useCallback((cm: { x: number; y: number; target: import("./types/contextMenu").ContextMenuTarget }) => {
    contextMenuActions.setContextMenu(cm);
    const specs = buildContextMenuSpecs(cm.target, {
      contextMenuActions, videoLayout, queueHook, library, downloadProviderEntries,
      plugins, searchProviders, handleDownloadFromProvider, artistImageCache,
      albumImageCache, tagImageCache, beginRetrieveImage,
      setSearchInitialQuery, setSearchQueryKey,
      setDeleteTagConfirm, trashLabel, handleExportAsMixtapeRef,
    });
    if (!specs) {
      contextMenuActions.setContextMenu(null);
      return;
    }
    showNativeMenu(cm.x, cm.y, specs);
  }, [contextMenuActions, videoLayout, queueHook, library, downloadProviderEntries, plugins, searchProviders, handleDownloadFromProvider, artistImageCache, albumImageCache, tagImageCache, beginRetrieveImage, setSearchInitialQuery, setSearchQueryKey, setDeleteTagConfirm, trashLabel, handleExportAsMixtapeRef]);
  showNativeMenuRef.current = buildAndShowNativeMenu;

  // Wire plugin host callbacks (uses library, contextMenuActions defined above)
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
      } else if (action === "download-album") {
        const albumPayload = payload as { title: string; artistName: string | null; providerId: string; providerName: string; tracks: Array<{ title: string; artist_name: string | null; uri: string }> };
        if (albumPayload.tracks && albumPayload.tracks.length > 0) {
          setDownloadModal({
            tracks: albumPayload.tracks.map(t => ({
              title: t.title,
              artistName: t.artist_name,
              albumTitle: albumPayload.title,
              uri: t.uri,
            })),
            providerId: albumPayload.providerId,
            providerName: albumPayload.providerName,
            confirmed: true,
          });
        }
        return;
      } else if (action === "download-track") {
        const p = payload as { trackId: number | null; title: string; artistName: string | null; providerId?: string; providerName?: string };
        if (p.providerId) {
          setDownloadModal({
            tracks: [{
              title: p.title,
              artistName: p.artistName,
              trackId: p.trackId,
            }],
            providerId: p.providerId,
            providerName: p.providerName ?? p.providerId,
          });
        }
      } else if (action === "download-tracks") {
        // Generic track download: opens the standard modal. One track renders the
        // single-track flow (direct-URI configure when a uri + provider resolver
        // exist); multiple tracks render the multi-track batch flow. Either way the
        // user gets a destination/quality step and per-track progress + errors.
        const p = payload as { tracks: Array<{ title: string; artist_name: string | null; album_title?: string | null; uri?: string | null; durationSecs?: number | null }>; providerId: string; providerName: string };
        if (p.providerId && p.tracks && p.tracks.length > 0) {
          const provider = downloadProviders.find(dp => dp.id === p.providerId);
          const isSingle = p.tracks.length === 1;
          setDownloadModal({
            tracks: p.tracks.map(t => ({
              title: t.title,
              artistName: t.artist_name ?? null,
              albumTitle: t.album_title ?? null,
              uri: t.uri ?? null,
              durationSecs: t.durationSecs ?? null,
            })),
            providerId: p.providerId,
            providerName: p.providerName,
            // Multi-track: skip the resolve/search step and resolve each uri directly.
            confirmed: !isSingle,
            // Single-track with a known uri: go straight to the configure step.
            resolveByUri: isSingle && p.tracks[0].uri ? provider?.resolveByUri : undefined,
          });
        }
      } else if (action === "navigate-to-artist") {
        pushStateRef.current();
        library.navigateToArtistByName(payload.name as string);
      } else if (action === "navigate-to-album") {
        pushStateRef.current();
        library.navigateToAlbumByName(payload.name as string, payload.artistName as string | undefined);
      } else if (action === "navigate-to-track") {
        pushStateRef.current();
        library.navigateToTrackByName(payload.name as string, payload.artistName as string | undefined, payload.albumTitle as string | undefined);
      } else if (action === "refresh-library") {
        library.loadLibrary();
        library.loadTracks();
      } else if (action === "require-dependency") {
        // A plugin asks the host to surface its platform-aware install modal for a
        // binary dependency (e.g. YouTube → yt-dlp). The modal pulls the correct
        // command per OS (brew / winget / apt) from the Rust dependency registry.
        const p = payload as { name?: string; feature?: string };
        if (p.name) {
          dependencies.promptDep(p.name, p.feature ?? _pluginId).catch(console.error);
        }
      }
    },
    showNotification: (message) => {
      console.debug("[plugin]", message);
      notify(message);
    },
  };

  // Event listeners
  useEventListeners({
    loadLibrary: library.loadLibrary,
    loadTracks: library.loadTracks,
    setScanning, setScanProgress,
    setSyncing, setSyncProgress,
    onResyncDone: collectionActions.clearResyncingState,
    resyncingCollectionName: collectionActions.resyncingCollection?.name ?? null,
    setResyncProgress,
    setResyncComplete,
    onBulkEditComplete: () => setSearchBulkEditKey(k => k + 1),
    dispatchPluginEvent: plugins.dispatchEvent as (event: string, ...args: unknown[]) => void,
  });

  useEffect(() => {
    if (playback.playbackError && playback.failedTrack) {
      const t = playback.failedTrack;
      const src = t.path?.startsWith("subsonic://") ? "Subsonic" : isLocalTrack(t) ? "Local" : "Remote";
      console.debug(`Playback failed (${src}): ${t.artist_name ? t.artist_name + " — " : ""}${t.title}: ${playback.playbackError}`);
    }
  }, [playback.playbackError, playback.failedTrack]);


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
    invalidateArtistImage: (name: string) => artistImageCache.invalidate(name),
    invalidateAlbumImage: (name: string, artistName?: string) => albumImageCache.invalidate(name, artistName),
    invalidateTagImage: (name: string) => tagImageCache.invalidate(name),
  });

  const applyNavState = useCallback((s: NavState) => {
    // This nav restore sets its own scroll position below — suppress the
    // "reset to 0 on view/selection change" effect so it doesn't clobber it.
    suppressScrollResetRef.current = true;
    library.setView(s.view);
    library.setSelectedArtist(s.selectedArtist);
    library.setSelectedAlbum(s.selectedAlbum);
    library.setSelectedTag(s.selectedTag);
    library.setSelectedTrack(s.selectedTrack ?? null);
    library.setFallbackArtistName(s.fallbackArtistName ?? null);
    library.setFallbackAlbumName(s.fallbackAlbumName ?? null);
    library.setFallbackTrackName(s.fallbackTrackName ?? null);
    viewSearch.restore(s.viewSearchQueries);
    // Restore scroll position after React renders the new view
    requestAnimationFrame(() => {
      const sc = getScrollEl();
      if (sc) sc.scrollTop = s.scrollTop;
    });
  }, [library.setView, library.setSelectedArtist, library.setSelectedAlbum, library.setSelectedTag, library.setSelectedTrack, library.setFallbackArtistName, library.setFallbackAlbumName, library.setFallbackTrackName, viewSearch.restore, getScrollEl]);

  const getScrollTop = useCallback(() => getScrollEl()?.scrollTop ?? 0, [getScrollEl]);

  const { pushState, goBack, canGoBack } = useNavigationHistory(
    {
      view: library.view,
      selectedArtist: library.selectedArtist,
      selectedAlbum: library.selectedAlbum,
      selectedTag: library.selectedTag,
      selectedTrack: library.selectedTrack,
      fallbackArtistName: library.fallbackArtistName,
      fallbackAlbumName: library.fallbackAlbumName,
      fallbackTrackName: library.fallbackTrackName,
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
  const pushStateRef = useRef(pushAndScroll);
  pushStateRef.current = pushAndScroll;

  // Helper for playing playlist items (with optional radio seed sentinel)
  const playShelfPlaylistItem = useCallback((it: { name: string; coverUrl?: string | null; tracks: PluginTrack[] }) => {
    const first = it.tracks[0] as unknown as { __radioSeed?: Track } | undefined;
    if (first?.__radioSeed) {
      const seed = first.__radioSeed;
      contextMenuActions.startRadio({
        title: seed.title,
        artistName: seed.artist_name,
        coverPath: seed.image_url ?? it.coverUrl ?? null,
      });
      return;
    }
    const queueTracks = it.tracks.map(pluginTrackToQueueTrack);
    queueHook.playTracks(queueTracks, 0, { name: it.name, imagePath: it.coverUrl ?? null, source: "playlist" });
  }, [contextMenuActions, pluginTrackToQueueTrack, queueHook]);

  // Home shelf item click handler
  const handleHomeShelfItemClick = useCallback((shelf: ResolvedShelf, item: HomeShelfItem) => {
    // A plugin shelf can take over its own card-clicks (e.g. Spotify navigates
    // into its playlist view). If a handler is registered, let it win.
    if (shelf.pluginId && plugins.invokeHomeShelfItemClick(shelf.pluginId, shelf.id.slice(shelf.pluginId.length + 1), item)) {
      return;
    }
    // Clicking a card body navigates to the entity's detail page (the play
    // button on the card handles playing). Name-based navigation falls back to
    // a synthetic detail page when the entity isn't in the library.
    if (shelf.displayKind === "album-cards") {
      const it = item as { libraryId?: number; name: string; artistName?: string };
      if (it.libraryId) {
        // Route through the canonical handler so the view switches to the
        // detail page (it also pushes nav history + clears other selections).
        library.handleAlbumClick(it.libraryId, undefined, it.name, it.artistName);
      } else {
        library.navigateToAlbumByName(it.name, it.artistName).catch(console.error);
      }
      return;
    }
    if (shelf.displayKind === "artist-cards") {
      const it = item as { libraryId?: number; name: string };
      if (it.libraryId) {
        // Canonical handler switches view + pushes nav history; setting the
        // selected id alone leaves the view on Home (the detail render is gated on view).
        library.handleArtistClick(it.libraryId, it.name);
      } else {
        library.navigateToArtistByName(it.name).catch(console.error);
      }
      return;
    }
    if (shelf.displayKind === "playlist-cards") {
      // Plugin playlist shelves have no detail page — clicking plays them.
      playShelfPlaylistItem(item as { name: string; coverUrl?: string; tracks: PluginTrack[] });
      return;
    }
    // track-rows — open the track detail page (synthetic if not in library)
    const it = item as { track: PluginTrack };
    library.navigateToTrackByName(it.track.title, it.track.artist_name ?? undefined, it.track.album_title ?? undefined).catch(console.error);
  }, [library, playShelfPlaylistItem, plugins]);

  const handleHomeShelfItemPlay = useCallback((shelf: ResolvedShelf, item: HomeShelfItem) => {
    const action = resolveShelfPlayAction(shelf.displayKind, item);
    switch (action.kind) {
      case "album-id":
        playActions.playAlbum(action.id);
        return;
      case "artist-id":
        playActions.playArtist(action.id);
        return;
      case "radio":
        contextMenuActions.startRadio({
          title: action.seed.title,
          artistName: action.seed.artist_name,
          coverPath: action.seed.image_url ?? action.coverUrl ?? null,
        });
        return;
      case "tracks": {
        const ctx = action.context ? { name: action.context.name, imagePath: action.context.imagePath ?? null, source: action.context.source ?? null } : undefined;
        if (action.tracks.length > 0) {
          queueHook.playTracks(action.tracks.map(pluginTrackToQueueTrack), 0, ctx);
          return;
        }
        // Empty tracks: a lazy plugin card. If the plugin registered a resolver,
        // await it (behind a loading modal) and play the result.
        if (shelf.pluginId) {
          const shelfId = shelf.id.slice(shelf.pluginId.length + 1);
          const resolved = plugins.invokeHomeShelfResolvePlay(shelf.pluginId, shelfId, item);
          if (resolved) {
            const label = (item as { name?: string }).name ?? "tracks";
            setPluginLoadingMessage("Loading " + label + "…");
            resolved.then((tracks) => {
              if (tracks && tracks.length > 0) {
                queueHook.playTracks(tracks.map(pluginTrackToQueueTrack), 0, ctx);
              }
            }).catch((e) => {
              console.error("[home] resolve-play failed:", e);
            }).finally(() => {
              setPluginLoadingMessage(null);
            });
          }
        }
        return;
      }
      case "none":
        return;
    }
  }, [playActions, contextMenuActions, pluginTrackToQueueTrack, queueHook]);

  const handleHomeShelfItemContextMenu = useCallback((_shelf: ResolvedShelf, _item: HomeShelfItem, e: React.MouseEvent) => {
    e.preventDefault();
    // TODO(home): wire into existing context menu builder once metadata-only target adapter is added.
    // For now, right-click on Home shelf items is a no-op; play / queue actions still work via left click.
  }, []);

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
        // Handle viboplr:// install deep links
        if (raw.startsWith("viboplr://install-plugin?") || raw.startsWith("viboplr://install-plugin/?")) {
          const params = new URLSearchParams(raw.split("?")[1]);
          const url = params.get("url");
          if (url) setDeepLinkInstall({ kind: "plugin", url });
          break;
        }
        if (raw.startsWith("viboplr://install-skin?") || raw.startsWith("viboplr://install-skin/?")) {
          const params = new URLSearchParams(raw.split("?")[1]);
          const url = params.get("url");
          if (url) setDeepLinkInstall({ kind: "skin", url });
          break;
        }
        // Handle viboplr://add-collection (e.g. from the server-directory site)
        if (raw.startsWith("viboplr://add-collection?") || raw.startsWith("viboplr://add-collection/?")) {
          const params = new URLSearchParams(raw.split("?")[1]);
          const kind = params.get("kind") || "subsonic";
          const url = params.get("url");
          if (kind === "subsonic" && url) {
            setDeepLinkServer({
              name: params.get("name") || "",
              url,
              username: params.get("username") || "",
              password: params.get("password") || "",
            });
            setShowAddServer(true);
            break;
          }
          // Non-subsonic kinds fall through to plugin-registered collection handlers
        }
        // Forward other viboplr:// deep links to plugins
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

  // Listen for mixtape file opened events (from file association / CLI) — play immediately
  useEffect(() => {
    const unlistenMixtapeOpen = listen<string>("mixtape-file-opened", (event) => {
      invoke("import_mixtape", { path: event.payload, mode: "just_play", destDir: null })
        .catch(err => console.error("Failed to play mixtape:", err));
    });

    const unlistenJustPlay = listen<{ tracks: Track[]; coverPath?: string | null; title?: string; metadata?: Record<string, string> | null }>("mixtape-just-play", (event) => {
      if (mixtapePreviewPath) return;
      const { tracks, coverPath, title, metadata } = event.payload;
      const queueTracks: QueueTrack[] = tracks.map(t => ({
        key: nextExternalKey(),
        path: t.path ?? null,
        title: t.title,
        artist_name: t.artist_name ?? null,
        album_title: t.album_title ?? null,
        duration_secs: t.duration_secs ?? null,
        format: t.format ?? null,
        image_url: t.image_url,
        liked: 0,
      }));
      const name = title || "Mixtape";
      queueHook.playTracks(queueTracks, 0, contextFromMixtapeMetadata(name, coverPath ?? null, metadata ?? null));
    });

    return () => {
      unlistenMixtapeOpen.then(f => f());
      unlistenJustPlay.then(f => f());
    };
  }, [mixtapePreviewPath, queueHook.playTracks]);

  // Handle drag-and-drop of .mixtape files onto the window — play immediately
  useEffect(() => {
    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const paths: string[] = event.payload.paths;
        const mixtapePath = paths.find(p => p.endsWith(".mixtape"));
        if (mixtapePath) {
          invoke("import_mixtape", { path: mixtapePath, mode: "just_play", destDir: null })
            .catch(err => console.error("Failed to play mixtape:", err));
        }
      }
    });
    return () => {
      unlisten.then(f => f());
    };
  }, []);

  // Clean up temporary mixtape files on app startup (deferred so it doesn't
  // contend with the initial paint or other startup IPCs).
  useEffect(() => {
    const t = setTimeout(() => {
      invoke("cleanup_temp_mixtapes").catch(() => {});
    }, 3000);
    return () => clearTimeout(t);
  }, []);

  // Restore persisted state on mount
  useEffect(() => {
    (async () => {
      try {
        await timeAsync("store.init", () => store.init());
        // Startup always lands on Home; `view` and selected-entity state are
        // intentionally not restored (see readPersistedSettings).
        const {
          vol, crossfadeSecs: cf, trackVideoHistory: savedTrackVideoHistory, miniMode: wasMini,
          fullWindowWidth: fww, fullWindowHeight: fwh, fullWindowX: fwx, fullWindowY: fwy,
          trackSortField: tSortField, trackSortDir: tSortDir, trackColumns: tCols, trackViewMode: savedTrackViewMode,
          videoLayout: savedVideoLayout,
          sidebarCollapsed: savedSidebarCollapsed, queueCollapsed: savedQueueCollapsed, queueWidth: savedQueueWidth,
          mediaTypeFilter: savedMediaTypeFilter, trackLikedFirst: savedTrackLikedFirst,
          lastDownloadDest: savedLastDownloadDest, searchViewModes: savedSearchViewModes,
          downloadsCollectionId: savedDownloadsCollectionId,
          minimizeToMiniPlayer: savedMinimizeToMiniPlayer,
        } = await timeAsync("store.restore", () => readPersistedSettings(store));
        if (vol !== undefined && vol !== null) playback.setVolume(vol);
        if (cf !== undefined && cf !== null) setCrossfadeSecs(cf);
        if (savedTrackVideoHistory !== undefined && savedTrackVideoHistory !== null) setTrackVideoHistory(savedTrackVideoHistory);
        if (savedDownloadsCollectionId != null) setDownloadsCollectionId(savedDownloadsCollectionId);
        if (savedMinimizeToMiniPlayer) setMinimizeToMiniPlayer(true);

        const [savedEqEnabled, savedEqMode, savedEqPreset, savedEqGains, savedEqCustomPresets, savedEqPreGainDb, savedEqBassDb, savedEqTrebleDb, savedEqShowBarSimple, savedEqShowBarAdvanced] = await Promise.all([
          store.get<boolean>("eqEnabled"),
          store.get<string>("eqMode"),
          store.get<string>("eqPreset"),
          store.get<number[]>("eqGains"),
          store.get<{ id: string; name: string; gains: number[] }[]>("eqCustomPresets"),
          store.get<number>("eqPreGainDb"),
          store.get<number>("eqBassDb"),
          store.get<number>("eqTrebleDb"),
          store.get<boolean>("eqShowBarControlSimple"),
          store.get<boolean>("eqShowBarControlAdvanced"),
        ]);
        if (typeof savedEqEnabled === "boolean") playback.setEqEnabled(savedEqEnabled);
        if (savedEqMode === "simple" || savedEqMode === "advanced") playback.setEqMode(savedEqMode);
        if (typeof savedEqPreset === "string") playback.setEqPreset(savedEqPreset);
        if (Array.isArray(savedEqGains) && savedEqGains.length === 10 && savedEqGains.every(n => typeof n === "number")) {
          playback.setEqGains(savedEqGains);
        }
        if (Array.isArray(savedEqCustomPresets)) setEqCustomPresets(savedEqCustomPresets);
        if (typeof savedEqPreGainDb === "number" && Number.isFinite(savedEqPreGainDb)) {
          playback.setEqPreGainDb(savedEqPreGainDb);
        }
        if (typeof savedEqBassDb === "number" && Number.isFinite(savedEqBassDb)) {
          playback.setEqBassDb(savedEqBassDb);
        }
        if (typeof savedEqTrebleDb === "number" && Number.isFinite(savedEqTrebleDb)) {
          playback.setEqTrebleDb(savedEqTrebleDb);
        }
        if (typeof savedEqShowBarSimple === "boolean") setEqShowBarControlSimple(savedEqShowBarSimple);
        if (typeof savedEqShowBarAdvanced === "boolean") setEqShowBarControlAdvanced(savedEqShowBarAdvanced);

        if (tSortField && ["num", "title", "artist", "album", "duration", "path", "year", "quality", "size", "collection", "added", "modified", "random"].includes(tSortField)) library.setSortField(tSortField as SortField);
        if (tSortDir && ["asc", "desc"].includes(tSortDir)) library.setSortDir(tSortDir as SortDir);
        if (tCols && Array.isArray(tCols) && tCols.length > 0) {
          // Merge in any new columns that weren't in the saved config
          const savedIds = new Set(tCols.map((c: ColumnConfig) => c.id));
          const missing = DEFAULT_TRACK_COLUMNS.filter(c => !savedIds.has(c.id));
          library.setTrackColumns([...tCols, ...missing]);
        }

        // Restore queue from main-playlist folder (replaces tauri-store queue keys)
        try {
          const [{ manifest, state: mpState }, dir] = await Promise.all([
            invoke<{ manifest: Manifest | null; state: MainPlaylistState | null }>("main_playlist_read"),
            invoke<string>("main_playlist_dir"),
          ]);
          if (manifest) {
            const tracks = tracksFromManifest(manifest);
            const ctx = contextFromManifest(manifest, dir);
            if (tracks.length > 0) {
              // tracksFromManifest seeds liked: 0 (QueueTracks carry no DB id).
              // Reconcile against the durable entity_likes store so a like set
              // before restart survives — keyed by metadata, works for
              // non-library tracks too. Best-effort: on failure leave neutral.
              try {
                const states = await invoke<number[]>("get_track_like_states", {
                  tracks: tracks.map(t => ({ title: t.title, artistName: t.artist_name })),
                });
                for (let i = 0; i < tracks.length && i < states.length; i++) {
                  tracks[i].liked = states[i];
                }
              } catch (e) {
                console.error("Failed to reconcile restored like states:", e);
              }
              const idx = mpState?.queueIndex != null && mpState.queueIndex >= 0 && mpState.queueIndex < tracks.length ? mpState.queueIndex : -1;
              pendingRestoreQueueRef.current = { tracks, index: idx };
              if (idx >= 0) {
                pendingRestoreTrackRef.current = tracks[idx];
              }
            }
            if (ctx) queueHook.setPlaylistContext(ctx);
          }
          if (mpState) {
            // Migrate legacy persisted modes: "loop" → "repeat-all", "shuffle" → "normal".
            const raw = mpState.queueMode as string | undefined;
            const mode =
              raw === "repeat-all" || raw === "repeat-one" || raw === "normal" ? raw :
              raw === "loop" ? "repeat-all" :
              "normal";
            queueHook.setQueueMode(mode);
          }
          // Fire-and-forget gc; not awaited so it never blocks startup.
          invoke("main_playlist_gc").catch(e => console.error("main_playlist_gc failed:", e));
        } catch (e) {
          console.error("Failed to restore main playlist:", e);
        }
        if (savedTrackViewMode && ["basic", "list", "tiles"].includes(savedTrackViewMode)) library.setTrackViewMode(savedTrackViewMode as ViewMode);
        if (savedMediaTypeFilter && ["all", "audio", "video"].includes(savedMediaTypeFilter)) library.setMediaTypeFilter(savedMediaTypeFilter as "all" | "audio" | "video");
        if (savedTrackLikedFirst) library.setTrackLikedFirst(true);
        if (savedVideoLayout) {
          videoLayout.restoreLayout(savedVideoLayout);
        }
        if (savedSidebarCollapsed) setSidebarCollapsed(true);
        if (savedQueueCollapsed) setQueueCollapsed(true);
        if (savedQueueWidth && savedQueueWidth >= 200 && savedQueueWidth <= 600) setQueueWidth(savedQueueWidth);
        if (savedLastDownloadDest !== undefined) setLastDownloadDest(savedLastDownloadDest ?? null);
        if (savedSearchViewModes) {
          const validModes = ["basic", "list", "tiles"];
          const s = savedSearchViewModes as { tracks: ViewMode; albums: ViewMode; artists: ViewMode; tags?: ViewMode };
          if (validModes.includes(s.tracks) && validModes.includes(s.albums) && validModes.includes(s.artists)) {
            setSearchViewModes({ tracks: s.tracks, albums: s.albums, artists: s.artists, tags: s.tags && validModes.includes(s.tags) ? s.tags : "tiles" });
          }
        }
        const [savedLoggingEnabled, savedDebugLogging, savedDebugMode, savedDevPluginPath, savedAutoUpdateDeps] = await Promise.all([
          store.get<boolean>("loggingEnabled"),
          store.get<boolean>("debugLogging"),
          store.get<boolean>("debugMode"),
          store.get<string | null>("devPluginPath"),
          store.get<boolean>("autoUpdateManagedDeps"),
        ]);
        if (savedLoggingEnabled) setLoggingEnabled(true);
        // Default ON: only disable when explicitly set to false.
        if (savedAutoUpdateDeps === false) setAutoUpdateManagedDeps(false);
        if (savedDebugLogging) { setDebugLogging(true); setDebugLoggingRef(true); }
        if (savedDebugMode) setDebugMode(true);
        if (savedDevPluginPath) setDevPluginPath(savedDevPluginPath);
        // Startup always lands on Home — track detail / fallback state is intentionally not restored.

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
      restoredRef.current = true;
      setAppRestoring(false);
      await Promise.all([
        timeAsync("loadProviders", () => loadProviders(store).then(setSearchProviders)).catch(e => console.error("Failed to load providers:", e)),
        timeAsync("loadLibrary", () => library.loadLibrary()),
      ]);
    })();
  }, []);

  // Fetch main playlist directory on mount
  useEffect(() => {
    invoke<string>("main_playlist_dir").then(setMainPlaylistDir).catch(console.error);
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
      // Reconcile thumbnails cached before restart: ask the backend which track
      // URIs already have a thumb on disk and re-emit main-playlist-thumb-ready
      // for each, repopulating thumbInfo. Rust stays the sole namer of the file
      // (no JS slug recomputation here).
      const keys = queue.tracks.map(t => t.path).filter((p): p is string => !!p);
      if (keys.length > 0) {
        invoke("main_playlist_touch_thumbs", { keys })
          .catch(e => console.error("main_playlist_touch_thumbs failed:", e));
      }
    }
  }, [appRestoring]);

  // First-run: offer recommended plugins once, after restore completes.
  // Only marks itself "shown" after a successful gallery load, so an offline
  // first launch retries on a later launch.
  useEffect(() => {
    if (appRestoring) return;
    let cancelled = false;
    (async () => {
      try {
        const shown = await store.get<boolean>("pluginRecommendationsShown");
        if (shown || cancelled) return;
        // fetchPluginGallery returns the fresh entries and also updates
        // plugins.galleryPlugins for the render below.
        const entries = await plugins.fetchPluginGallery();
        if (cancelled) return;
        if (entries.length > 0) {
          setShowFirstRunPluginModal(true);
        }
        // gallery empty or fetch failed (returns []) => leave the flag unset,
        // retry on a later launch.
      } catch (e) {
        console.error("Failed to evaluate first-run plugin recommendations:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appRestoring]);

  // Refresh the algorithmic ("Made for you") auto-playlists ~daily, after restore.
  // The store key throttles how often we bother invoking; the backend itself
  // regenerates only the mixes whose 24h snapshot is stale (force:false), so this
  // is cheap on warm launches and never blocks the UI. The manual Refresh button
  // in PlaylistsView passes force:true. Mirrors the Home 24h snapshot model.
  useEffect(() => {
    if (appRestoring) return;
    (async () => {
      try {
        const last = (await store.get<number>("autoPlaylistsRefreshedAt")) ?? 0;
        if (Date.now() - last < 24 * 60 * 60 * 1000) return;
        await invoke("ensure_auto_playlists", { force: false });
        await store.set("autoPlaylistsRefreshedAt", Date.now());
      } catch (e) {
        console.error("Failed to ensure auto playlists:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appRestoring]);

  // Persist current track as QueueEntry (location + metadata, no DB IDs)
  useEffect(() => {
    if (!restoredRef.current) return;
    if (playback.currentTrack) {
      store.set("currentTrackEntry", trackToQueueEntry(playback.currentTrack));
    } else {
      store.set("currentTrackEntry", null);
    }
  }, [playback.currentTrack]);

  useEffect(() => {
    if (!restoredRef.current) return;
    store.set("eqEnabled", playback.eqEnabled);
  }, [playback.eqEnabled]);

  useEffect(() => {
    if (!restoredRef.current) return;
    store.set("eqMode", playback.eqMode);
  }, [playback.eqMode]);

  useEffect(() => {
    if (!restoredRef.current) return;
    store.set("eqShowBarControlSimple", eqShowBarControlSimple);
  }, [eqShowBarControlSimple]);

  useEffect(() => {
    if (!restoredRef.current) return;
    store.set("eqShowBarControlAdvanced", eqShowBarControlAdvanced);
  }, [eqShowBarControlAdvanced]);

  useEffect(() => {
    if (!restoredRef.current) return;
    store.set("eqPreset", playback.eqPreset);
  }, [playback.eqPreset]);

  useEffect(() => {
    if (!restoredRef.current) return;
    store.set("eqGains", playback.eqGains);
  }, [playback.eqGains]);

  useEffect(() => {
    if (!restoredRef.current) return;
    store.set("eqCustomPresets", eqCustomPresets);
  }, [eqCustomPresets]);

  useEffect(() => {
    if (!restoredRef.current) return;
    store.set("eqPreGainDb", playback.eqPreGainDb);
  }, [playback.eqPreGainDb]);

  useEffect(() => {
    if (!restoredRef.current) return;
    store.set("eqBassDb", playback.eqBassDb);
  }, [playback.eqBassDb]);

  useEffect(() => {
    if (!restoredRef.current) return;
    store.set("eqTrebleDb", playback.eqTrebleDb);
  }, [playback.eqTrebleDb]);

  // Persist recently visited entities (album/artist detail views)
  const recentlyVisitedRef = useRef<RecentlyVisitedEntry[]>([]);

  useEffect(() => {
    (async () => {
      const stored = (await store.get<RecentlyVisitedEntry[]>("recentlyVisitedEntities")) ?? [];
      recentlyVisitedRef.current = stored;
    })();
  }, []);

  useEffect(() => {
    if (!restoredRef.current) return;
    if (library.selectedAlbum == null) return;
    const next = recordVisit(recentlyVisitedRef.current, {
      kind: "album", id: library.selectedAlbum, ts: Date.now(),
    });
    recentlyVisitedRef.current = next;
    store.set("recentlyVisitedEntities", next).catch((e) => console.error("Failed to persist recentlyVisitedEntities:", e));
  }, [library.selectedAlbum]);

  useEffect(() => {
    if (!restoredRef.current) return;
    if (library.selectedArtist == null) return;
    const next = recordVisit(recentlyVisitedRef.current, {
      kind: "artist", id: library.selectedArtist, ts: Date.now(),
    });
    recentlyVisitedRef.current = next;
    store.set("recentlyVisitedEntities", next).catch((e) => console.error("Failed to persist recentlyVisitedEntities:", e));
  }, [library.selectedArtist]);

  // Forward frontend errors to backend log file
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      invoke("write_frontend_log", { level: "error", message: `${e.message} at ${e.filename}:${e.lineno}`, section: "fr-error" }).catch(() => {}); // Fire-and-forget: avoid infinite loop if the error logger itself fails
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      invoke("write_frontend_log", { level: "error", message: `Unhandled rejection: ${e.reason}`, section: "fr-error" }).catch(() => {}); // Fire-and-forget: avoid infinite loop if the error logger itself fails
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Trigger image fetch for selected entities (getImage auto-fetches on first access)
  useEffect(() => {
    if (library.selectedArtist === null) return;
    const artist = library.artists.find(a => a.id === library.selectedArtist);
    if (artist) artistImageCache.getImage(artist.name);
  }, [library.selectedArtist, library.artists]);

  useEffect(() => {
    if (library.selectedAlbum === null) return;
    const album = library.albums.find(a => a.id === library.selectedAlbum);
    if (album) albumImageCache.getImage(album.title, album.artist_name);
  }, [library.selectedAlbum, library.albums]);

  useEffect(() => {
    if (library.selectedTag === null) return;
    const tag = library.tags.find(t => t.id === library.selectedTag);
    if (tag) tagImageCache.getImage(tag.name);
  }, [library.selectedTag, library.tags]);

  // Ranked tag-suggestion pool for TagEditor surfaces (library tags by frequency).
  const tagSuggestionPool = useMemo(
    () => buildTagSuggestionPool(
      library.tags.map((t) => ({ name: t.name, track_count: t.track_count })),
      [],
    ),
    [library.tags],
  );

  // Resolve track for the detail view — try local lookups (sync), fall back to backend (async)
  const detailTrackLocal = useMemo(() => {
    if (library.selectedTrack === null) return null;
    return library.tracks.find(t => t.key === library.selectedTrack) ?? null;
  }, [library.selectedTrack, library.tracks]);

  useEffect(() => {
    if (library.selectedTrack === null) { setDetailTrack(null); return; }
    if (detailTrackLocal) { setDetailTrack(detailTrackLocal); return; }
    // Fetch from backend as last resort
    let cancelled = false;
    const libId = parseLibraryId(library.selectedTrack);
    if (libId == null) {
      // Non-library track (ext:N) — build synthetic Track from queue or currentTrack
      const queueTrack = queueHook.queue.find(t => t.key === library.selectedTrack)
        ?? (playback.currentTrack?.key === library.selectedTrack ? playback.currentTrack : null);
      if (queueTrack) {
        // Render a synthetic (id-less) track immediately so the hero shows without delay…
        setDetailTrack({
          id: null, key: queueTrack.key, path: queueTrack.path,
          title: queueTrack.title, artist_id: null, artist_name: queueTrack.artist_name,
          album_id: null, album_title: queueTrack.album_title, year: null,
          track_number: null, duration_secs: queueTrack.duration_secs,
          format: queueTrack.format, file_size: null, collection_id: null,
          collection_name: null, liked: queueTrack.liked ?? 0,
          added_at: null, modified_at: null,
          image_url: queueTrack.image_url,
        });
        if (queueTrack.album_title) {
          albumImageCache.getImage(queueTrack.album_title, queueTrack.artist_name);
        }
        if (queueTrack.artist_name) {
          artistImageCache.getImage(queueTrack.artist_name);
        }
        // …but resolve the real library row so tags, audio properties, and
        // library-only actions work for now-playing / restored / external tracks
        // that exist in the library. Try the exact path first (same source, exact
        // match — local file:// / subsonic:// round-trip via the backend's
        // PATH_EXPR), then fall back to metadata (catches a same-song different
        // copy in the library, e.g. a stream you also own locally). Genuinely
        // external tracks resolve to nothing → the synthetic track stays.
        (async () => {
          let found: Track | null = null;
          if (queueTrack.path) {
            const id = await invoke<number | null>("find_track_id_by_path", { path: queueTrack.path });
            if (id != null) found = await invoke<Track>("get_track_by_id", { trackId: id });
          }
          if (!found) {
            found = await invoke<Track | null>("find_track_by_metadata", {
              title: queueTrack.title,
              artistName: queueTrack.artist_name ?? null,
              albumName: queueTrack.album_title ?? null,
            });
          }
          if (!cancelled && found) setDetailTrack(found);
        })().catch(e => console.error("Failed to resolve library track for detail view:", e));
      } else {
        setDetailTrack(null);
      }
      return;
    }
    invoke<Track>("get_track_by_id", { trackId: libId })
      .then(t => { if (!cancelled) setDetailTrack(t); })
      .catch(() => { if (!cancelled) setDetailTrack(null); });
    return () => { cancelled = true; };
  }, [library.selectedTrack, detailTrackLocal]);

  useEffect(() => {
    if (!restoredRef.current) return;
    if (detailTrack) {
      store.set("fallbackTrackName", { name: detailTrack.title, artistName: detailTrack.artist_name ?? undefined, albumTitle: detailTrack.album_title ?? undefined });
    } else {
      store.set("fallbackTrackName", null);
    }
  }, [detailTrack]);

  // Resolve image for current track: video frame → album → artist
  useEffect(() => {
    const track = playback.currentTrack;
    if (!track || track.image_url) return;
    let cancelled = false;
    (async () => {
      if (isVideoTrack(track) && track.path) {
        const trackId = await invoke<number | null>("find_track_id_by_path", { path: track.path });
        if (trackId && !cancelled) {
          const frames = await invoke<{ status: string; paths?: string[] } | null>("get_video_frames", { trackId });
          if (!cancelled && frames?.status === "ok" && frames.paths?.[0]) {
            playback.setCurrentTrack(prev => prev && !prev.image_url ? { ...prev, image_url: frames.paths![0] } : prev);
            return;
          }
        }
      }
      if (cancelled) return;
      const img = (track.album_title && albumImageCache.getImage(track.album_title, track.artist_name ?? undefined))
        || (track.artist_name && artistImageCache.getImage(track.artist_name))
        || null;
      if (img) {
        playback.setCurrentTrack(prev => prev && !prev.image_url ? { ...prev, image_url: img } : prev);
      }
    })();
    return () => { cancelled = true; };
  }, [playback.currentTrack, albumImageCache.getImage, artistImageCache.getImage, albumImageCache.cache, artistImageCache.cache]);

  // When a backend image fetch completes, update currentTrack if it's still missing artwork
  useEffect(() => {
    const norm = (s: string | null | undefined) => (s ?? "").toLowerCase();
    const unlistenAlbum = listen<{ title: string; artist_name?: string | null; path: string }>("album-image-ready", (event) => {
      const { title, artist_name, path } = event.payload;
      playback.setCurrentTrack(prev => {
        if (!prev || prev.image_url) return prev;
        if (norm(prev.album_title) !== norm(title)) return prev;
        if (artist_name && norm(prev.artist_name) !== norm(artist_name)) return prev;
        return { ...prev, image_url: path };
      });
    });
    const unlistenArtist = listen<{ name: string; path: string }>("artist-image-ready", (event) => {
      const { name, path } = event.payload;
      playback.setCurrentTrack(prev => {
        if (!prev || prev.image_url) return prev;
        if (norm(prev.artist_name) !== norm(name)) return prev;
        return { ...prev, image_url: path };
      });
    });
    return () => {
      unlistenAlbum.then(f => f());
      unlistenArtist.then(f => f());
    };
  }, [playback.setCurrentTrack]);


  const handleToggleLikeRef = useRef((_track: QueueTrack) => {});

  // In-app keyboard shortcuts (window keydown). OS-level media keys are handled
  // separately by useGlobalShortcuts above.
  useInAppKeyboardShortcuts({
    library, playback, queueHook, mini,
    volume: playback.volume,
    getMediaElement: playback.getMediaElement,
    handleSeek: playback.handleSeek,
    handlePause: playback.handlePause,
    currentTrack: playback.currentTrack,
    goBack: () => goBackRef.current(),
    toggleLike: (t) => handleToggleLikeRef.current(t),
    focusSearch: () => searchInputRef.current?.focus(),
    handleNext: () => handleNext(),
    handleToggleQueueCollapsed,
    handleToggleSidebar,
    miniSearchOpen: miniSearch.isOpen,
    openMiniSearch: (initialChar) => miniSearch.open(initialChar),
  });


  // onEnded handler — uses refs to avoid stale closures from useCallback([])
  const autoContinueRef = useRef(autoContinue);
  autoContinueRef.current = autoContinue;
  const queueModeRef = useRef(queueHook.queueMode);
  queueModeRef.current = queueHook.queueMode;
  const currentTrackRef = useRef(playback.currentTrack);
  currentTrackRef.current = playback.currentTrack;
  const handleStopRef = useRef(playback.handleStop);
  handleStopRef.current = playback.handleStop;
  const playNextRef = useRef(queueHook.playNext);
  playNextRef.current = queueHook.playNext;
  const addToQueueAndPlayRef = useRef(queueHook.addToQueueAndPlay);
  addToQueueAndPlayRef.current = queueHook.addToQueueAndPlay;
  const addToQueueRef = useRef(queueHook.addToQueue);
  addToQueueRef.current = queueHook.addToQueue;
  const queueRef = useRef(queueHook.queue);
  queueRef.current = queueHook.queue;

  prefetchNextRef.current = () => {
    const ac = autoContinueRef.current;
    const track = currentTrackRef.current;
    if (!ac.enabled || !track) return;
    console.log(`[prefetch] Fetching auto-continue track (current: "${track.title}")`);
    ac.fetchTrack(track).then(next => {
      if (next) {
        console.log(`[prefetch] Queued "${next.title}" by ${next.artist_name}`);
        addToQueueRef.current(next);
      } else {
        console.log("[prefetch] Auto-continue returned no track");
      }
    });
  };

  const handleNext = useCallback(async (source: "user" | "auto" = "user") => {
    if (!playNextRef.current(source)) {
      const ac = autoContinueRef.current;
      const track = currentTrackRef.current;
      // Auto-continue extends the queue only in Normal mode. In repeat-all /
      // repeat-one, playNext never returns false, so this branch is unreachable
      // there anyway — the explicit mode check is belt-and-suspenders + intent.
      if (queueModeRef.current === "normal" && ac.enabled && track) {
        const next = await ac.fetchTrack(track);
        if (next) {
          addToQueueAndPlayRef.current(next, source);
          return;
        }
      }
      handleStopRef.current();
    }
  }, []);

  mediaSessionNextRef.current = () => handleNext();

  // Deleting the currently-playing track: advance to the nearest surviving track
  // after it, else (Normal mode) auto-continue, else the nearest surviving track
  // before it, else stop — and remove the deleted entries from the queue. The
  // stray media error from the file vanishing under the player is cleared too
  // (a surviving track's handlePlay also resets it; the stop path needs this).
  const handleCurrentTrackDeleted = useCallback(async (removeIndices: number[]) => {
    playback.clearPlaybackError();
    if (removeIndices.length === 0) {
      // Playing track isn't represented in the queue — just stop dead playback.
      handleStopRef.current();
    } else {
      await queueHook.removeAndAdvance(
        removeIndices,
        async () => {
          const ac = autoContinueRef.current;
          const track = currentTrackRef.current;
          return ac.enabled && track ? await ac.fetchTrack(track) : null;
        },
        () => handleStopRef.current(),
      );
    }
    playback.clearPlaybackError();
  }, [queueHook, playback]);
  currentTrackDeletedRef.current = (indices) => { void handleCurrentTrackDeleted(indices); };

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

  function handleMinimizeToMiniPlayerChange(enabled: boolean) {
    setMinimizeToMiniPlayer(enabled);
    store.set("minimizeToMiniPlayer", enabled);
  }

  function handleLoggingEnabledChange(enabled: boolean) {
    setLoggingEnabled(enabled);
    store.set("loggingEnabled", enabled);
  }

  function handleAutoUpdateManagedDepsChange(enabled: boolean) {
    setAutoUpdateManagedDeps(enabled);
    store.set("autoUpdateManagedDeps", enabled);
  }

  function handleDebugLoggingChange(enabled: boolean) {
    setDebugLogging(enabled);
    setDebugLoggingRef(enabled);
    store.set("debugLogging", enabled);
  }

  function handleDebugModeChange(enabled: boolean) {
    setDebugMode(enabled);
    store.set("debugMode", enabled);
  }

  function handleDevPluginPathChange(path: string | null) {
    setDevPluginPath(path);
    store.set("devPluginPath", path);
  }

  const handleSetDownloadsFolder = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, title: "Select Downloads Folder" });
    if (!selected) return;
    try {
      const col = await invoke<Collection>("add_collection", { kind: "local", name: "Downloads", path: selected });
      setDownloadsCollectionId(col.id);
      store.set("downloadsCollectionId", col.id);
      library.loadLibrary();
    } catch (e) {
      console.error("Failed to set downloads collection:", e);
    }
  };

  const handleUnsetDownloadsCollection = async () => {
    setDownloadsCollectionId(null);
    store.set("downloadsCollectionId", null);
  };

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
  const handlePlayEntityAll = useCallback((kind: "artist" | "album" | "tag", name: string, entityArtistName?: string, opts?: { tracks?: Track[]; entityId?: number }) => {
    if (kind === "artist") {
      const id = opts?.entityId ?? library.artists.find(a => a.name === name)?.id;
      if (id) {
        playActions.playArtist(id, { tracks: opts?.tracks, startIndex: 0 });
      } else if (opts?.tracks) {
        queueHook.playTracks(opts.tracks, 0, { name, source: "artist", imagePath: artistImageCache.getImage(name) });
      }
    } else if (kind === "album") {
      const id = opts?.entityId ?? library.albums.find(a => a.title === name && (!entityArtistName || a.artist_name === entityArtistName))?.id;
      if (id) {
        playActions.playAlbum(id, { tracks: opts?.tracks, startIndex: 0 });
      } else if (opts?.tracks) {
        queueHook.playTracks(opts.tracks, 0, { name, source: "album", imagePath: albumImageCache.getImage(name, entityArtistName) });
      }
    } else {
      const id = opts?.entityId ?? library.tags.find(t => t.name === name)?.id;
      if (id) {
        playActions.playTag(id, { tracks: opts?.tracks, startIndex: 0 });
      } else if (opts?.tracks) {
        queueHook.playTracks(opts.tracks, 0, { name, source: "tag", imagePath: tagImageCache.getImage(name) });
      }
    }
  }, [library.artists, library.albums, library.tags, playActions.playArtist, playActions.playAlbum, playActions.playTag, queueHook.playTracks, artistImageCache.getImage, albumImageCache.getImage, tagImageCache.getImage]);

  const detailViewActions: DetailViewActions = useMemo(() => ({
    navigateToArtist: library.handleArtistClick,
    navigateToAlbum: library.handleAlbumClick,
    navigateToTag: library.handleTagClick,
    navigateToTagByName: library.navigateToTagByName,
    goBack,
    canGoBack,
    playTracks: queueHook.playTracks,
    playEntityAll: handlePlayEntityAll,
    playAlbum: playActions.playAlbum,
    enqueueTracks: contextMenuActions.handleEnqueue,
    playExternal: (tracks) => queueHook.playTracks(tracks, 0),
    enqueueExternal: queueHook.enqueueTracks,
    toggleLike: likeActions.handleToggleLike,
    toggleDislike: likeActions.handleToggleDislike,
    toggleEntityLike: (kind: "artist" | "album" | "tag", id: number) => {
      if (kind === "artist") likeActions.handleToggleArtistLike(id);
      else if (kind === "album") likeActions.handleToggleAlbumLike(id);
      else likeActions.handleToggleTagLike(id);
    },
    toggleEntityDislike: (kind: "artist" | "album" | "tag", id: number) => {
      if (kind === "artist") likeActions.handleToggleArtistDislike(id);
      else if (kind === "album") likeActions.handleToggleAlbumDislike(id);
      else likeActions.handleToggleTagDislike(id);
    },
    deleteTracks: handleDeleteTracks,
    handleTrackContextMenu: contextMenuActions.handleTrackContextMenu,
    handleAlbumContextMenu: contextMenuActions.handleAlbumContextMenu,
    handleInfoTrackContextMenu: contextMenuActions.handleInfoTrackContextMenu,
    handleEntityContextMenu: contextMenuActions.handleEntityContextMenu,
    handleTrackDragStart: contextMenuActions.handleTrackDragStart,
    getArtistImage: artistImageCache.getImage,
    getAlbumImage: albumImageCache.getImage,
    getTagImage: tagImageCache.getImage,
    invalidateImage: (kind: "artist" | "album" | "tag", name: string, artistName?: string) => {
      if (kind === "artist") artistImageCache.invalidate(name);
      else if (kind === "album") albumImageCache.invalidate(name, artistName);
      else tagImageCache.invalidate(name);
    },
    requestFetchImage: (kind: "artist" | "album" | "tag", name: string, artistName?: string) => {
      // Explicit user action (hero refresh button) → open the centered Retrieve
      // modal (preview → Apply). NOT for automatic/lazy hero-image fetching —
      // that uses autoFetchImage below so the modal never auto-pops.
      void beginRetrieveImage(kind, name, artistName ?? null);
    },
    autoFetchImage: (kind: "artist" | "album" | "tag", name: string, artistName?: string) => {
      // Silent background fetch for lazy hero-image resolution (no modal).
      if (kind === "artist") artistImageCache.requestFetch(name);
      else if (kind === "album") albumImageCache.requestFetch(name, artistName);
      else tagImageCache.requestFetch(name);
    },
    invokeInfoFetch: plugins.invokeInfoFetch,
    pluginsLoaded: plugins.pluginsLoaded,
    pluginNames: plugins.pluginNames,
    searchProviders,
    tagSuggestionPool,
    refreshLibraryTags: library.loadLibrary,
    retrieve: {
      openInfo: retrieve.openInfo,
    },
  }), [
    library.handleArtistClick, library.handleAlbumClick, library.handleTagClick, library.navigateToTagByName,
    goBack, canGoBack,
    queueHook.playTracks, queueHook.enqueueTracks, handlePlayEntityAll, playActions.playAlbum, contextMenuActions.handleEnqueue,
    likeActions.handleToggleLike, likeActions.handleToggleDislike,
    likeActions.handleToggleArtistLike, likeActions.handleToggleArtistDislike,
    likeActions.handleToggleAlbumLike, likeActions.handleToggleAlbumDislike,
    likeActions.handleToggleTagLike, likeActions.handleToggleTagDislike,
    handleDeleteTracks,
    contextMenuActions.handleTrackContextMenu, contextMenuActions.handleAlbumContextMenu,
    contextMenuActions.handleInfoTrackContextMenu, contextMenuActions.handleEntityContextMenu,
    contextMenuActions.handleTrackDragStart,
    artistImageCache.getImage, albumImageCache.getImage, tagImageCache.getImage,
    artistImageCache.invalidate, albumImageCache.invalidate, tagImageCache.invalidate,
    artistImageCache.requestFetch, albumImageCache.requestFetch, tagImageCache.requestFetch,
    plugins.invokeInfoFetch, plugins.pluginsLoaded, plugins.pluginNames, searchProviders,
    tagSuggestionPool, library.loadLibrary,
    beginRetrieveImage, retrieve.openInfo,
  ]);

  // Now Playing view: lyrics via the shared info-type chain, and resolved art.
  const nowPlayingLyrics = useLyrics({
    track: playback.currentTrack,
    enabled: library.view === "nowplaying",
    invokeInfoFetch: plugins.invokeInfoFetch,
    pluginNames: plugins.pluginNames,
  });
  const detailViewState: DetailViewState = useMemo(() => ({
    currentTrack: playback.currentTrack,
    playing: playback.playing,
  }), [playback.currentTrack, playback.playing]);

  function handleSaveAsPlaylist() {
    if (queueHook.queue.length === 0) return;
    setEditPlaylistMode(false);
    setShowSavePlaylistModal(true);
  }

  function handleEditPlaylist() {
    setEditPlaylistMode(true);
    setShowSavePlaylistModal(true);
  }

  function handleQueueExportAsMixtape() {
    const tracks = queueHook.queue;
    if (tracks.length === 0) return;
    const exportTracks: ExportTrack[] = tracks.map(t => ({
      id: parseLibraryId(t.key) ?? undefined,
      title: t.title,
      artistName: t.artist_name || undefined,
      albumTitle: t.album_title || undefined,
      durationSecs: t.duration_secs || undefined,
      path: t.path || undefined,
      imageUrl: t.image_url || undefined,
    }));
    setMixtapeExportTracks(exportTracks);
    setMixtapeExportDefaultTitle(queueHook.playlistContext?.name || "");
    setMixtapeExportDefaultCover(queueHook.playlistContext?.imagePath ?? null);
    setMixtapeExportDefaultMetadata(contextToExportMetadata(queueHook.playlistContext));
    const ctxSource = queueHook.playlistContext?.source;
    setMixtapeExportDefaultType(ctxSource === "album" ? "album" : ctxSource === "artist" ? "best_of_artist" : "custom");
  }

  async function handleSavePlaylistConfirm(name: string, imagePath: string | null, info?: import("./components/SavePlaylistModal").PlaylistEditInfo | null) {
    setShowSavePlaylistModal(false);
    if (editPlaylistMode) {
      queueHook.setPlaylistContext(prev => ({
        ...prev,
        name,
        imagePath: imagePath ?? prev?.imagePath ?? null,
        ...(info ? { source: info.source, description: info.description, metadata: info.metadata } : {}),
      }));
      return;
    }
    const tracks = queueHook.queue.map((t) => ({
      title: t.title,
      artist_name: t.artist_name ?? null,
      album_name: t.album_title ?? null,
      duration_secs: t.duration_secs ?? null,
      source: t.path,
      image_url: t.image_url ?? null,
    }));
    const ctx = queueHook.playlistContext;
    try {
      const playlistId = await invoke<number>("save_playlist_record", {
        name,
        source: ctx?.source ?? null,
        imageUrl: null,
        description: ctx?.description ?? null,
        metadata: ctx?.metadata ? JSON.stringify(ctx.metadata) : null,
        tracks,
      });
      if (imagePath) {
        await invoke("update_playlist_image", { playlistId, imagePath });
      }
    } catch (err) {
      console.error("Failed to save playlist:", err);
    }
  }

  // Mixtape export trigger — fetches full track data and opens the export modal
  const handleExportAsMixtape = useCallback(async (trackIds: number[], defaultTitle?: string, defaultType?: "custom" | "album" | "best_of_artist") => {
    try {
      const tracks = await invoke<Track[]>("get_tracks_by_ids", { ids: trackIds });
      setMixtapeExportTracks(tracks.map((t) => ({
        id: t.id!,
        title: t.title,
        artistName: t.artist_name || undefined,
        albumTitle: t.album_title || undefined,
        durationSecs: t.duration_secs || undefined,
        fileSize: t.file_size || undefined,
        path: t.path || undefined,
      })));
      let inferredType = defaultType;
      if (!inferredType) {
        if (library.selectedAlbum != null && tracks.length > 0 && tracks.every(t => t.album_id === library.selectedAlbum)) {
          inferredType = "album";
        } else if (library.selectedArtist != null && tracks.length > 0 && tracks.every(t => t.artist_id === library.selectedArtist)) {
          inferredType = "best_of_artist";
        }
      }
      setMixtapeExportDefaultTitle(defaultTitle || "");
      setMixtapeExportDefaultCover(null);
      setMixtapeExportDefaultMetadata(null);
      setMixtapeExportDefaultType(inferredType || "custom");
    } catch (e) {
      console.error("Failed to prepare mixtape export:", e);
    }
  }, [library.selectedAlbum, library.selectedArtist]);

  const handleExportAsMixtapeDirect = useCallback((tracks: ExportTrack[], defaultTitle?: string, coverPath?: string | null, metadata?: Record<string, string> | null) => {
    if (tracks.length === 0) return;
    setMixtapeExportTracks(tracks);
    setMixtapeExportDefaultTitle(defaultTitle || "");
    setMixtapeExportDefaultCover(coverPath ?? null);
    setMixtapeExportDefaultMetadata(metadata ?? null);
    setMixtapeExportDefaultType("custom");
  }, []);

  // Queue handler for mixtape "Just Play" mode — replaces the queue with mixtape tracks
  const handleMixtapeQueueTracks = useCallback((tracks: Track[], context: { name: string; imagePath?: string | null; metadata?: Record<string, string> | null }) => {
    const queueTracks: QueueTrack[] = tracks.map(t => ({
      key: t.key || nextExternalKey(),
      path: t.path ?? null,
      title: t.title,
      artist_name: t.artist_name ?? null,
      album_title: t.album_title ?? null,
      duration_secs: t.duration_secs ?? null,
      format: t.format ?? null,
      image_url: t.image_url,
      liked: t.liked ?? 0,
    }));
    queueHook.playTracks(queueTracks, 0, contextFromMixtapeMetadata(context.name, context.imagePath ?? null, context.metadata ?? null));
  }, [queueHook.playTracks]);

  // Bridge for keyboard shortcuts
  handleToggleLikeRef.current = likeActions.handleToggleLike;
  handleExportAsMixtapeRef.current = handleExportAsMixtape;

  const { view, selectedArtist, selectedAlbum, selectedTag, artists, albums, tags,
    highlightedListIndex } = library;

  const localCollections = library.collections.filter(c => c.kind === "local" && c.enabled).map(c => ({ id: c.id, name: c.name, path: c.path ?? "" }));

  // The video "theater" overlay fills the main content area while the Now Playing
  // view is active. But navigating to a track detail (e.g. via the queue "locate"
  // button or the Now Playing bar title) sets selectedTrack and renders the detail
  // page inside .content — which the opaque, absolutely-positioned theater overlay
  // would otherwise hide entirely ("nothing happens"). So theater mode only applies
  // when no detail page is open; otherwise the video reverts to its docked layout.
  const detailPageOpen = library.selectedTrack !== null || !!library.fallbackTrackName;
  const videoTheater = view === "nowplaying" && !detailPageOpen;

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

  return (
    <VideoFrameQueueProvider>
    <VideoFrameQueueRefBridge refOut={videoFrameQueueRef} />
    <div className={`app ${appRestoring ? "app-restoring" : ""} ${playback.currentTrack && isVideoTrack(playback.currentTrack) ? "video-mode" : ""} queue-open ${queueCollapsed ? "queue-collapsed" : ""} ${mini.miniMode ? "mini-mode" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} style={{ "--queue-width": `${queueWidth}px` } as React.CSSProperties}>
      {/* Hidden audio elements (A/B for gapless playback) */}
      <audio
        ref={playback.audioRefA}
        crossOrigin="anonymous"
        onTimeUpdate={playback.onTimeUpdate}
        onLoadedMetadata={playback.onLoadedMetadata}
        onPlay={playback.onPlaySlotA}
        onPause={playback.onPauseSlotA}
        onEnded={() => playback.onEndedSlotA(onEnded)}
        onError={playback.onMediaError}
      />
      <audio
        ref={playback.audioRefB}
        crossOrigin="anonymous"
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
        nowPlayingMedia={
          playback.currentTrack
            ? (isVideoTrack(playback.currentTrack) ? "video" : "audio")
            : null
        }
        nowPlayingActive={playback.playing}
        collapsed={sidebarCollapsed}
        onShowHome={() => {
          library.setView("home");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowSearch={() => {
          library.setView("search");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowHistory={() => {
          library.setView("history");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowNowPlaying={() => {
          library.setView("nowplaying");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowPlaylists={() => {
          library.setView("playlists");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowCollections={() => {
          library.setView("collections");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowSettings={() => {
          library.setView("settings");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        onShowExtensions={() => {
          library.setView("extensions");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        updateAvailable={updater.updateState.available !== null}
        extensionUpdateCount={extensionsHook.updateCount}
        pluginNavItems={plugins.sidebarItems}
        badgeMap={mergedBadgeMap}
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
          initialName={deepLinkServer?.name}
          initialUrl={deepLinkServer?.url}
          initialUsername={deepLinkServer?.username}
          initialPassword={deepLinkServer?.password}
        />
      )}


      {deepLinkInstall && (
        <DeepLinkInstallModal
          kind={deepLinkInstall.kind}
          url={deepLinkInstall.url}
          onCancel={() => setDeepLinkInstall(null)}
          onInstall={async () => {
            const { kind, url } = deepLinkInstall;
            setDeepLinkInstall(null);
            if (kind === "plugin") {
              await extensionsHook.installFromUrl(url);
            } else {
              try {
                await invoke<string>("install_gallery_skin", { url });
              } catch (e) {
                console.error("Failed to install skin from URL:", e);
              }
            }
          }}
        />
      )}

      {/* Caption bar - full width */}
      <CaptionBar
        centralSearch={centralSearch}
        searchInputRef={searchInputRef}
        getAlbumImage={albumImageCache.getImage}
        getArtistImage={artistImageCache.getImage}
        onToggleMiniMode={mini.toggleMiniMode}
        onToggleHelp={() => setShowHelp(h => !h)}
        resyncProgress={resyncProgress}
        resyncComplete={resyncComplete}
        onNavigateToCollections={() => {
          library.setView("collections");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
        }}
        minimizeToMiniPlayer={minimizeToMiniPlayer}
      />

      {/* Main content */}
      <main className="main" data-dock={playback.currentTrack && isVideoTrack(playback.currentTrack) ? videoLayout.dockSide : undefined}>
        {/* Content area */}
        <div className="content" ref={contentRef} style={playback.currentTrack && isVideoTrack(playback.currentTrack) ? (videoLayout.isHorizontal ? { minHeight: 150 } : { minWidth: 150 }) : undefined}>
          <DetailViewProvider actions={detailViewActions} state={detailViewState}>
          {/* Track detail view */}
          {library.selectedTrack !== null && (() => {
            const track = detailTrackLocal ?? detailTrack;
            if (!track) return null;
            const isCurrentTrack = playback.currentTrack?.key === library.selectedTrack;
            return (
              <TrackDetailView
                trackId={track.id}
                track={track}
                albumImagePath={
                  (track.album_title ? albumImageCache.getImage(track.album_title, track.artist_name) : null)
                    || track.image_url || null}
                artistImagePath={track.artist_name ? artistImageCache.getImage(track.artist_name) : null}
                positionSecs={isCurrentTrack ? playback.positionSecs : 0}
                isCurrentTrack={isCurrentTrack}
                onPlay={() => queueHook.playTracks([track], 0)}
                onPlayAt={(secs: number) => {
                  if (isCurrentTrack) {
                    playback.handleSeek(secs);
                  } else {
                    playback.setPendingSeek(secs);
                    queueHook.playTracks([track], 0);
                  }
                }}
                onWatchOnYoutube={track.id != null ? () => contextMenuActions.watchOnYoutube(track.title, track.artist_name, track.duration_secs) : undefined}
                onStartRadio={() => contextMenuActions.startRadio({ title: track.title, artistName: track.artist_name, coverPath: track.image_url ?? null })}
                onToggleLike={() => likeActions.handleToggleLike(track)}
                onToggleDislike={() => likeActions.handleToggleDislike(track)}
                onShowInFolder={async () => { const libId = track.id; if (libId == null) return; try { await invoke("show_in_folder", { trackId: libId }); } catch (e) { console.error("Failed to open containing folder:", e); contextMenuActions.setFolderError(String(e)); } }}
              />
            );
          })()}

          {/* Fallback track detail (non-library) */}
          {library.fallbackTrackName && !library.selectedTrack && (() => {
            const syntheticTrack: Track = {
              id: null,
              key: `fallback:${library.fallbackTrackName.name}:${library.fallbackTrackName.artistName ?? ""}`,
              path: null,
              title: library.fallbackTrackName.name,
              artist_id: null,
              artist_name: library.fallbackTrackName.artistName ?? null,
              album_id: null,
              album_title: library.fallbackTrackName.albumTitle ?? null,
              year: null,
              track_number: null,
              duration_secs: null,
              format: null,
              file_size: null,
              collection_id: null,
              collection_name: null,
              liked: 0,
              added_at: null,
              modified_at: null,
            };
            const albumImg = syntheticTrack.album_title
              ? albumImageCache.getImage(syntheticTrack.album_title, syntheticTrack.artist_name)
              : null;
            const artistImg = syntheticTrack.artist_name
              ? artistImageCache.getImage(syntheticTrack.artist_name)
              : null;
            return (
              <TrackDetailView
                trackId={null}
                track={syntheticTrack}
                albumImagePath={albumImg}
                artistImagePath={artistImg}
                positionSecs={0}
                isCurrentTrack={false}
                onPlay={() => queueHook.playTracks([syntheticTrack], 0)}
                onPlayAt={() => {}}
                onWatchOnYoutube={syntheticTrack.artist_name ? () => contextMenuActions.watchOnYoutube(syntheticTrack.title, syntheticTrack.artist_name, syntheticTrack.duration_secs) : undefined}
                onStartRadio={syntheticTrack.artist_name ? () => contextMenuActions.startRadio({ title: syntheticTrack.title, artistName: syntheticTrack.artist_name, coverPath: albumImg ?? artistImg ?? null }) : undefined}
                onToggleLike={() => {}}
                onToggleDislike={() => {}}
                onShowInFolder={() => {}}
              />
            );
          })()}

          {library.selectedTrack === null && !library.fallbackTrackName && <>
          {/* Artist detail (unified: library + fallback) */}
          {view === "artists" && (selectedArtist !== null || library.fallbackArtistName) && selectedAlbum === null && (
            <ArtistDetailContent
              name={library.fallbackArtistName ?? artists.find(a => a.id === selectedArtist)?.name ?? "Unknown"}
            />
          )}

          {/* Tag detail — header + track list + information sections */}
          {view === "tags" && selectedTag !== null && (
            <TagDetail name={tags.find(t => t.id === selectedTag)?.name ?? "Unknown"} />
          )}

          {/* Album detail (unified: albums view + artists sub-album + fallback) */}
          {((view === "albums" && selectedAlbum !== null) || (view === "albums" && library.fallbackAlbumName) || (view === "artists" && selectedAlbum !== null)) && (() => {
            let detailAlbumName: string;
            let detailAlbumArtistName: string | undefined;
            if (library.fallbackAlbumName && !selectedAlbum) {
              detailAlbumName = library.fallbackAlbumName.name;
              detailAlbumArtistName = library.fallbackAlbumName.artistName;
            } else {
              const album = albums.find(a => a.id === selectedAlbum);
              detailAlbumName = album?.title ?? "Unknown";
              detailAlbumArtistName = album?.artist_name ?? undefined;
            }
            return <AlbumDetail name={detailAlbumName} artistName={detailAlbumArtistName} />;
          })()}

          {/* Home view — always mounted to preserve state and avoid re-fetching on revisit */}
          <HomeView
            style={{ display: view === "home" ? undefined : "none" }}
            isVisible={view === "home"}
            pluginShelves={plugins.homeShelves}
            pluginsLoaded={plugins.pluginsLoaded}
            invokePluginShelf={plugins.invokeHomeShelf}
            restoredRef={restoredRef}
            onPlayStation={(s) => contextMenuActions.startRadio({
              title: s.seed.title,
              artistName: s.seed.artist_name,
              coverPath: s.coverUrl ?? s.seed.image_url ?? null,
            })}
            onShelfItemClick={handleHomeShelfItemClick}
            onShelfItemPlay={handleHomeShelfItemPlay}
            onShelfItemContextMenu={handleHomeShelfItemContextMenu}
          />

          {/* Search view — always mounted to preserve state and scroll position */}
          <SearchView
            style={{ display: view === "search" ? undefined : "none" }}
            initialQuery={searchInitialQuery}
            initialQueryKey={searchQueryKey}
            deletedTrackIds={searchDeletedBatch.ids}
            deletedTrackKey={searchDeletedBatch.key}
            deletedTagIds={searchDeletedTagBatch.ids}
            deletedTagKey={searchDeletedTagBatch.key}
            bulkEditKey={searchBulkEditKey}
            currentTrack={playback.currentTrack}
            playing={playback.playing}
            viewModes={searchViewModes}
            onViewModesChange={handleSearchViewModesChange}
            getArtistImage={artistImageCache.getImage}
            getAlbumImage={albumImageCache.getImage}
            getTagImage={tagImageCache.getImage}
            onPlayTracks={queueHook.playTracks}
            onEnqueueTrack={(t) => contextMenuActions.handleEnqueue([t])}
            onStartRadio={(t) => contextMenuActions.startRadio({ title: t.title, artistName: t.artist_name, coverPath: t.image_url ?? null })}
            onLocateTrack={(t) => library.handleTrackClick(t.key)}
            onPlayAlbum={playActions.playAlbum}
            onPlayArtist={playActions.playArtist}
            onPlayTag={playActions.playTag}
            onEnqueueAlbum={playActions.enqueueAlbum}
            onEnqueueArtist={playActions.enqueueArtist}
            onEnqueueTag={playActions.enqueueTag}
            onArtistClick={library.handleArtistClick}
            onAlbumClick={library.handleAlbumClick}
            onTrackContextMenu={contextMenuActions.handleTrackContextMenu}
            onArtistContextMenu={contextMenuActions.handleArtistContextMenu}
            onAlbumContextMenu={contextMenuActions.handleAlbumContextMenu}
            onMultiAlbumContextMenu={contextMenuActions.handleMultiAlbumContextMenu}
            onMultiArtistContextMenu={contextMenuActions.handleMultiArtistContextMenu}
            onMultiTagContextMenu={contextMenuActions.handleMultiTagContextMenu}
            onToggleLike={likeActions.handleToggleLike}
            onToggleDislike={likeActions.handleToggleDislike}
            onToggleArtistLike={likeActions.handleToggleArtistLike}
            onToggleAlbumLike={likeActions.handleToggleAlbumLike}
            onToggleArtistDislike={likeActions.handleToggleArtistDislike}
            onToggleAlbumDislike={likeActions.handleToggleAlbumDislike}
            onTrackDragStart={contextMenuActions.handleTrackDragStart}
            onEntityDragStart={async (kind, ids) => {
              const target = kind === "album" ? { kind: "multi-album" as const, albumIds: ids }
                           : kind === "artist" ? { kind: "multi-artist" as const, artistIds: ids }
                           : { kind: "multi-tag" as const, tagIds: ids };
              const tracks = await contextMenuActions.fetchMultiEntityTracks(target);
              if (tracks.length > 0) contextMenuActions.handleTrackDragStart(tracks);
            }}
            onTagClick={library.handleTagClick}
            onTagContextMenu={contextMenuActions.handleTagContextMenu}
            onToggleTagLike={likeActions.handleToggleTagLike}
            onToggleTagDislike={likeActions.handleToggleTagDislike}
            columns={library.trackColumns}
            onColumnsChange={library.setTrackColumns}
          />

          {/* Now Playing view */}
          {view === "nowplaying" && (
            <NowPlayingView
              track={playback.currentTrack}
              positionSecs={playback.positionSecs}
              lyrics={nowPlayingLyrics}
              getAlbumImage={albumImageCache.getImage}
              getArtistImage={artistImageCache.getImage}
              onSeek={playback.handleSeek}
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
              <HistoryView ref={historyRef} searchQuery={viewSearch.getQuery("history")} highlightedIndex={highlightedListIndex} onPlayTrack={queueHook.playTracks} onEnqueueTrack={contextMenuActions.handleEnqueue} onLocateTrack={(t) => library.handleTrackClick(t.key)} onArtistClick={library.handleArtistClick} onPlayArtist={playActions.playArtist} onEnqueueArtist={playActions.enqueueArtist} />
            </>
          )}

          {/* Playlists view */}
          {view === "playlists" && (
            <PlaylistsView
              searchQuery={viewSearch.getQuery("playlists")}
              onSearchChange={(q) => viewSearch.setQuery("playlists", q)}
              onPlayTracks={queueHook.playTracks}
              onEnqueueTracks={queueHook.enqueueTracks}
              onExportAsMixtape={handleExportAsMixtapeDirect}
              pluginMenuItems={plugins.menuItems}
              onPluginAction={plugins.dispatchContextMenuAction}
            />
          )}

          {/* Collections view */}
          {view === "collections" && (
            <CollectionsView
              collections={library.collections.filter(c => ["local", "subsonic", "seed"].includes(c.kind))}
              downloadsCollectionId={downloadsCollectionId}
              onToggleEnabled={collectionActions.handleToggleCollectionEnabled}
              onCheckConnection={collectionActions.handleCheckConnection}
              onResync={collectionActions.handleResyncCollection}
              checkingConnectionId={collectionActions.checkingConnectionId}
              connectionResult={collectionActions.connectionResult}
              resyncProgress={resyncProgress}
              resyncComplete={resyncComplete}
              onEdit={(c) => collectionActions.setEditingCollection(c)}
              onRemove={(c) => collectionActions.setRemoveCollectionConfirm(c)}
              onAddFolder={handleAddFolder}
              onShowAddServer={() => setShowAddServer(true)}
              onOpenFolder={(path) => invoke("open_folder", { folderPath: path }).catch(console.error)}
              onOpenUrl={(url) => openUrl(url)}
              statsMap={new Map(library.collectionStats.map(s => [s.collection_id, s]))}
            />
          )}
          {typeof view === "string" && view.startsWith("plugin:") && (() => {
            const parts = view.slice("plugin:".length).split(":");
            const pluginId = parts[0];
            const viewId = parts.slice(1).join(":");
            const pluginState = plugins.pluginStates.find(p => p.id === pluginId);
            const data = plugins.getViewData(pluginId, viewId);
            const scrollKey = plugins.getViewScrollKey(pluginId, viewId);
            return (
              <PluginViewRenderer
                pluginName={pluginState?.manifest.name ?? pluginId}
                data={data}
                scrollKey={scrollKey}
                currentTrack={playback.currentTrack}
                onPlayTrack={(track) => {
                  queueHook.playTracks([track], 0);
                }}
                onAction={(actionId, actionData) => {
                  plugins.dispatchUIAction(pluginId, actionId, actionData);
                }}
                onTrackContextMenu={(e, track) => {
                  buildAndShowNativeMenu({ x: e.clientX, y: e.clientY, target: { kind: "track", trackId: track.id ?? undefined, isLocal: isLocalTrack(track), title: track.title, artistName: track.artist_name } });
                }}
                onTrackRowContextMenu={(e, item) => {
                  buildAndShowNativeMenu({ x: e.clientX, y: e.clientY, target: { kind: "track", trackId: undefined, isLocal: false, title: item.title, artistName: item.subtitle ?? null } });
                }}
                pluginMenuItems={plugins.menuItems}
                onPluginAction={plugins.dispatchContextMenuAction}
              />
            );
          })()}
          {/* Extensions view */}
          {view === "extensions" && (
            <ExtensionsView
              allExtensions={extensionsHook.allExtensions}
              updateCount={extensionsHook.updateCount}
              selectedId={extensionsHook.selectedId}
              onSelectExtension={extensionsHook.setSelectedId}
              searchQuery={extensionsHook.searchQuery}
              onSetSearchQuery={extensionsHook.setSearchQuery}
              installing={extensionsHook.installing}
              checking={extensionsHook.checking}
              lastChecked={extensionsHook.lastChecked}
              onCheckForUpdates={extensionsHook.checkForUpdates}
              onUpdateExtension={extensionsHook.updateExtension}
              onUpdateAll={extensionsHook.updateAll}
              onInstallFromGallery={extensionsHook.installFromGallery}
              onUninstall={extensionsHook.uninstall}
              onToggleEnabled={extensionsHook.toggleEnabled}
              onFetchPluginGallery={extensionsHook.onFetchPluginGallery}
              onFetchSkinGallery={extensionsHook.onFetchSkinGallery}
              onInstallFromUrl={extensionsHook.installFromUrl}
              galleryPlugins={plugins.galleryPlugins || []}
              gallerySkins={skins.gallerySkins || []}
              getPluginViewData={plugins.getViewData}
              onPluginAction={plugins.dispatchUIAction}
            />
          )}
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
              minimizeToMiniPlayer={minimizeToMiniPlayer}
              onMinimizeToMiniPlayerChange={handleMinimizeToMiniPlayerChange}
              appVersion={updater.appVersion}
              updateState={updater.updateState}
              onCheckForUpdates={updater.handleCheckForUpdates}
              onInstallUpdate={updater.handleInstallUpdate}
              backendTimings={backendTimings}
              frontendTimings={getTimingEntries()}
              onFetchBackendTimings={() => invoke<TimingEntry[]>("get_startup_timings").then(setBackendTimings)}
              pluginStates={plugins.pluginStates}
              loggingEnabled={loggingEnabled}
              onLoggingEnabledChange={handleLoggingEnabledChange}
              debugLogging={debugLogging}
              onDebugLoggingChange={handleDebugLoggingChange}
              debugMode={debugMode}
              onDebugModeChange={handleDebugModeChange}
              devPluginPath={devPluginPath}
              onDevPluginPathChange={handleDevPluginPathChange}
              onReloadPlugins={plugins.reloadAllPlugins}
              onStreamResolverOrderChanged={() => setStreamResolverOrderVersion(v => v + 1)}
              downloadsCollection={downloadsCollection}
              onSetDownloadsFolder={handleSetDownloadsFolder}
              onUnsetDownloadsCollection={handleUnsetDownloadsCollection}
              dependencies={dependencies}
              autoUpdateManagedDeps={autoUpdateManagedDeps}
              onAutoUpdateManagedDepsChange={handleAutoUpdateManagedDepsChange}
            />
          )}
          </>}
          </DetailViewProvider>
        </div>

        {/* Video splitter + player area (below content, above now-playing) */}
        {playback.currentTrack && isVideoTrack(playback.currentTrack) && view !== "nowplaying" && (
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
          className={`video-container${videoLayout.isCollapsed ? " collapsed" : ""}${videoTheater ? " video-container--theater" : ""}`}
          data-fit={videoLayout.fitMode}
          onContextMenu={(e) => {
            e.preventDefault();
            buildAndShowNativeMenu({ x: e.clientX, y: e.clientY, target: { kind: "video", dockSide: videoLayout.dockSide, fitMode: videoLayout.fitMode } });
          }}
          style={{
            display: playback.currentTrack && isVideoTrack(playback.currentTrack) ? undefined : 'none',
            ...(videoTheater
              ? {}
              : videoLayout.isHorizontal
              ? { height: videoLayout.isCollapsed ? 0 : videoLayout.videoSize }
              : { width: videoLayout.isCollapsed ? 0 : videoLayout.videoSize }),
          }}
        >
          <video
            ref={playback.videoRef}
            tabIndex={-1}
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
            muted={playback.muted}
            queueMode={queueHook.queueMode}
            autoContinueEnabled={autoContinue.enabled}
            autoContinueSameFormat={autoContinue.sameFormat}
            showAutoContinuePopover={autoContinue.showPopover}
            autoContinueWeights={autoContinue.weights}
            imagePath={playback.currentTrack?.image_url || null}
            onPause={playback.handlePause}
            onStop={playback.handleStop}
            onNext={handleNext}
            onPrevious={queueHook.playPrevious}
            onSeek={playback.handleSeek}
            onVolume={playback.handleVolume}
            onMute={playback.toggleMute}
            onToggleQueueMode={queueHook.toggleQueueMode}
            onRandomize={queueHook.randomizeQueue}
            queueLength={queueHook.queue.length}
            onToggleAutoContinue={() => autoContinue.setEnabled(!autoContinue.enabled)}
            onToggleAutoContinueSameFormat={() => autoContinue.setSameFormat(!autoContinue.sameFormat)}
            onToggleAutoContinuePopover={() => autoContinue.setShowPopover(!autoContinue.showPopover)}
            onAdjustAutoContinueWeight={autoContinue.adjustWeight}
            onResetAutoContinueWeights={autoContinue.resetWeights}
            onCloseAutoContinuePopover={() => autoContinue.setShowPopover(false)}
            onToggleLike={() => playback.currentTrack && likeActions.handleToggleLike(playback.currentTrack)}
            onToggleDislike={() => { if (playback.currentTrack) likeActions.handleToggleDislike(playback.currentTrack); }}
            onToggleFullscreen={playback.toggleFullscreen}
            showQueue={!queueCollapsed}
            onToggleQueue={handleToggleQueueCollapsed}
            onNavigateToArtistByName={library.navigateToArtistByName}
            onNavigateToAlbumByName={(name, artistName) => library.navigateToAlbumByName(name, artistName ?? undefined)}
          />
          {videoTheater && playback.currentTrack && isVideoTrack(playback.currentTrack) && (
            <VideoAmbientOverlay
              currentTrack={playback.currentTrack}
              playing={playback.playing}
              queue={queueHook.queue}
              queueIndex={queueHook.queueIndex}
              getAlbumImage={albumImageCache.getImage}
              getArtistImage={artistImageCache.getImage}
              onPlayQueueIndex={(index) => { queueHook.setQueueIndex(index); playback.handlePlay(queueHook.queue[index]); }}
              onToggleFullscreen={playback.toggleFullscreen}
            />
          )}
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
            library.handleTrackClick(track.key);
          }}
          onMoveMultiple={queueHook.moveMultiple}
          onClear={queueHook.clearQueue}
          onSaveAsM3U={queueHook.savePlaylist}
          onSaveToPlaylists={handleSaveAsPlaylist}
          onExportAsMixtape={handleQueueExportAsMixtape}
          onEditPlaylist={handleEditPlaylist}
          onLoadPlaylist={() => queueHook.loadPlaylist(setMixtapePreviewPath)}
          onContextMenu={(e, indices) => {
            const tracks = indices.map(i => queueHook.queue[i]).filter(Boolean);
            const first = tracks[0];
            buildAndShowNativeMenu({ x: e.clientX, y: e.clientY, target: {
              kind: "queue-multi", indices,
              trackIds: tracks.map(t => parseLibraryId(t.key)).filter((id): id is number => id != null),
              firstTrack: first ? { title: first.title, artistName: first.artist_name, isLocal: isLocalTrack(first) } : { title: "", artistName: null, isLocal: false },
            } });
          }}
          externalDropTarget={contextMenuActions.externalDropTarget}
          collapsed={queueCollapsed}
          onToggleCollapsed={handleToggleQueueCollapsed}
          onResizeWidth={handleResizeQueueWidth}
          isPlaying={playback.playing}
          debugMode={debugMode}
          mainPlaylistDir={mainPlaylistDir}
          thumbInfo={queueHook.thumbInfo}
          resolvingStatus={resolvingStatus}
          resolveFailures={resolveFailures}
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



      {showFirstRunPluginModal && plugins.galleryPlugins.length > 0 && (
        <FirstRunPluginModal
          entries={plugins.galleryPlugins}
          installedIds={new Set(plugins.pluginStates.map((p) => p.id))}
          onInstallEntry={(entry) => plugins.installFromGallery(entry)}
          onDone={async () => {
            setShowFirstRunPluginModal(false);
            try {
              await store.set("pluginRecommendationsShown", true);
            } catch (e) {
              console.error("Failed to persist pluginRecommendationsShown:", e);
            }
          }}
        />
      )}
      {downloadModal && (() => {
        const parts = downloadModal.providerId.split(":");
        // Built-in providers (e.g. Subsonic) supply options in app code; plugins
        // supply theirs via onGetQualities.
        const qualityOptions = builtinQualityOptions(downloadModal.providerId)
          ?? (parts.length >= 2 ? plugins.invokeGetQualities(parts[0], parts.slice(1).join(":")) : null);
        return (
        <DownloadModal
          tracks={downloadModal.tracks}
          providerId={downloadModal.providerId}
          providerName={downloadModal.providerName}
          confirmed={downloadModal.confirmed}
          resolveByUri={downloadModal.resolveByUri}
          qualityOptions={qualityOptions}
          collections={localCollections}
          downloadsCollectionId={downloadsCollectionId}
          store={store}
          lastDest={lastDownloadDest}
          onSearch={(query, limit) => {
            const parts = downloadModal.providerId.split(":");
            return plugins.invokeInteractiveSearch(parts[0], parts.slice(1).join(":"), query, limit);
          }}
          onResolve={(matchId, format) => {
            const parts = downloadModal.providerId.split(":");
            return plugins.invokeInteractiveResolve(parts[0], parts.slice(1).join(":"), matchId, format);
          }}
          onClose={() => setDownloadModal(null)}
          onComplete={(_msg) => { setDownloadModal(null); library.loadLibrary(); library.loadTracks(); }}
          onPlay={async (path) => {
            const uri = `file://${path}`;
            try {
              await library.loadTracks();
              const tracks = await invoke<Track[]>("get_tracks", { opts: {} });
              const match = tracks.find(t => t.path === uri);
              if (match) {
                queueHook.playTracks([match], 0);
                return;
              }
            } catch (e) {
              console.error("Failed to look up downloaded track:", e);
            }
            const fallback: Track = {
              id: null,
              key: uri,
              path: uri,
              title: path.split("/").pop() ?? "Track",
              artist_id: null,
              artist_name: null,
              album_id: null,
              album_title: null,
              year: null,
              track_number: null,
              duration_secs: null,
              format: null,
              file_size: null,
              collection_id: null,
              collection_name: null,
              liked: 0,
              added_at: null,
              modified_at: null,
            };
            queueHook.playTracks([fallback], 0);
          }}
        />
        );
      })()}

      {contextMenuActions.bulkEditTracks && (
        <BulkEditModal
          pluginsLoaded={plugins.pluginsLoaded}
          tracks={contextMenuActions.bulkEditTracks}
          artistOptions={[...new Set(library.artists.map((a) => a.name))]}
          albumOptions={[...new Set(library.albums.map((a) => a.title))]}
          tagOptions={[...new Set(library.tags.map((t) => t.name))]}
          invokeInfoFetch={plugins.invokeInfoFetch}
          onClose={() => contextMenuActions.setBulkEditTracks(null)}
          onSave={() => { contextMenuActions.setBulkEditTracks(null); library.loadLibrary(); library.loadTracks(); }}
        />
      )}

      {contextMenuActions.deleteConfirm && (
        <DeleteTracksModal
          title={contextMenuActions.deleteConfirm.title}
          trackCount={contextMenuActions.deleteConfirm.trackIds.length}
          trashLabel={trashLabel}
          network={contextMenuActions.deleteConfirm.network}
          onCancel={() => contextMenuActions.setDeleteConfirm(null)}
          onConfirm={contextMenuActions.handleDeleteConfirm}
        />
      )}

      {deleteTagConfirm && (
        <DeleteTagsModal
          tagCount={deleteTagConfirm.length}
          firstTagName={deleteTagConfirm[0].name}
          onCancel={() => setDeleteTagConfirm(null)}
          onConfirm={async () => {
            const tags = deleteTagConfirm;
            setDeleteTagConfirm(null);
            const deletedIds: number[] = [];
            for (const { id } of tags) {
              try {
                await invoke("delete_tag", { tagId: id });
                deletedIds.push(id);
              } catch (e) {
                console.error("Failed to delete tag:", e);
              }
            }
            if (deletedIds.length > 0) {
              library.setTags(prev => prev.filter(t => !deletedIds.includes(t.id)));
              setSearchDeletedTagBatch(prev => ({ ids: deletedIds, key: prev.key + 1 }));
              if (library.selectedTag !== null && deletedIds.includes(library.selectedTag)) {
                library.setSelectedTag(null);
              }
            }
          }}
        />
      )}

      {contextMenuActions.deleteError && (
        <DeleteErrorModal
          message={contextMenuActions.deleteError.message}
          failures={contextMenuActions.deleteError.failures}
          onDismiss={() => contextMenuActions.setDeleteError(null)}
        />
      )}

      {contextMenuActions.folderError && (
        <FolderErrorModal
          message={contextMenuActions.folderError}
          onDismiss={() => contextMenuActions.setFolderError(null)}
        />
      )}

      {contextMenuActions.downloadConfirm && (
        <DownloadAgainModal
          localTitle={contextMenuActions.downloadConfirm.localTitle}
          onCancel={contextMenuActions.handleDownloadConfirmDismiss}
          onShowInFolder={() => {
            invoke("show_in_folder", { trackId: contextMenuActions.downloadConfirm!.localTrackId }).catch(console.error);
            contextMenuActions.handleDownloadConfirmDismiss();
          }}
          onDownload={contextMenuActions.handleDownloadConfirm}
        />
      )}

      {collectionActions.editingCollection && (
        <EditCollectionModal
          collection={collectionActions.editingCollection}
          onSave={collectionActions.handleSaveCollection}
          onClose={() => collectionActions.setEditingCollection(null)}
        />
      )}

      {collectionActions.removeCollectionConfirm && (
        <RemoveCollectionModal
          name={collectionActions.removeCollectionConfirm.name}
          onCancel={() => collectionActions.setRemoveCollectionConfirm(null)}
          onConfirm={collectionActions.handleRemoveCollectionConfirm}
        />
      )}

      {playback.playbackError && !mini.miniMode && (
        <PlaybackErrorModal
          error={playback.playbackError}
          trackTitle={playback.failedTrack?.title ?? null}
          onDismiss={playback.clearPlaybackError}
          onSkip={() => { playback.clearPlaybackError(); handleNext(); }}
          onSearchYoutube={playback.failedTrack ? () => {
            const ft = playback.failedTrack!;
            invoke<{ url: string; video_title: string | null }>("search_youtube", { title: ft.title, artistName: ft.artist_name ?? null })
              .then(r => openUrl(r.url))
              .catch((e) => {
                console.error("YouTube search failed, falling back to manual search:", e);
                const q = encodeURIComponent(`${ft.title} ${ft.artist_name ?? ""}`);
                openUrl(`https://www.youtube.com/results?search_query=${q}`).catch(console.error);
              });
          } : undefined}
        />
      )}

      {eqSaveAsOpen && (
        <PromptModal
          title="Save preset"
          placeholder="My preset"
          okLabel="Save"
          onCancel={() => setEqSaveAsOpen(false)}
          onSubmit={name => {
            const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            setEqCustomPresets(prev => [...prev, { id, name, gains: [...playback.eqGains] }]);
            playback.setEqPreset(id);
            setEqSaveAsOpen(false);
          }}
        />
      )}

      {dependencies.modalState && (
        <DependencyModal
          dep={dependencies.modalState.dep}
          feature={dependencies.modalState.feature}
          installProgress={dependencies.installing[dependencies.modalState.dep.name]}
          onInstall={dependencies.installDep}
          onDismiss={dependencies.dismissModal}
          onRecheck={dependencies.recheckModal}
        />
      )}

      {mixtapePreviewPath && (
        <MixtapePreviewModal
          mixtapePath={mixtapePreviewPath}
          onClose={() => setMixtapePreviewPath(null)}
          onQueueTracks={handleMixtapeQueueTracks}
        />
      )}
      {mixtapeExportTracks && (
        <MixtapeExportModal
          tracks={mixtapeExportTracks}
          defaultTitle={mixtapeExportDefaultTitle}
          defaultCoverPath={mixtapeExportDefaultCover}
          defaultMetadata={mixtapeExportDefaultMetadata}
          defaultMixtapeType={mixtapeExportDefaultType}
          onClose={() => setMixtapeExportTracks(null)}
        />
      )}

      {navError && (
        <NavErrorModal message={navError} onDismiss={() => setNavError(null)} />
      )}

      {pluginLoadingMessage && (
        <PluginLoadingModal message={pluginLoadingMessage} />
      )}

      {extensionsHook.busyMessage && (
        <PluginLoadingModal message={extensionsHook.busyMessage} />
      )}

      {showSavePlaylistModal && (
        <SavePlaylistModal
          defaultName={editPlaylistMode
            ? (queueHook.playlistContext?.name ?? "")
            : (() => {
              const date = new Date();
              const dateStr = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
              return queueHook.playlistContext?.name
                ? `${queueHook.playlistContext.name} ${dateStr}`
                : `Queue ${dateStr}`;
            })()}
          defaultImage={queueHook.playlistContext?.imagePath ?? null}
          title={editPlaylistMode ? "Edit Playlist" : "Save Playlist"}
          info={editPlaylistMode ? { source: queueHook.playlistContext?.source, description: queueHook.playlistContext?.description, metadata: queueHook.playlistContext?.metadata } : null}
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
        muted={playback.muted}
        queueMode={queueHook.queueMode}
        autoContinueEnabled={autoContinue.enabled}
        autoContinueSameFormat={autoContinue.sameFormat}
        showAutoContinuePopover={autoContinue.showPopover}
        autoContinueWeights={autoContinue.weights}
        imagePath={playback.currentTrack?.image_url || null}
        miniMode={mini.miniMode}
        miniExpanded={mini.miniExpanded}
        miniRestingSize={mini.miniRestingSize}
        miniWidthSize={mini.miniWidthSize}
        onCancelCollapseTimer={mini.cancelCollapseTimer}
        onCycleRestingSize={() => mini.setMiniRestingSize(cycleRestingSize(mini.miniRestingSize))}
        onCycleMiniWidth={() => mini.setMiniWidthSize(cycleMiniWidth(mini.miniWidthSize))}
        onToggleMiniMode={mini.toggleMiniMode}
        onClose={() => exit(0)}
        onPause={playback.handlePause}
        onStop={playback.handleStop}
        onNext={handleNext}
        onPrevious={queueHook.playPrevious}
        onSeek={playback.handleSeek}
        onVolume={playback.handleVolume}
        onMute={playback.toggleMute}
        eqEnabled={playback.eqEnabled}
        eqMode={playback.eqMode}
        eqPreset={playback.eqPreset}
        eqGains={playback.eqGains}
        eqPreGainDb={playback.eqPreGainDb}
        eqBassDb={playback.eqBassDb}
        eqTrebleDb={playback.eqTrebleDb}
        eqCustomPresets={eqCustomPresets}
        onEqEnabledChange={playback.setEqEnabled}
        onEqModeChange={playback.setEqMode}
        onEqPresetChange={(id) => {
          if (id === "custom") {
            playback.setEqPreset("custom");
            return;
          }
          const builtIn = BUILTIN_PRESETS.find(p => p.id === id);
          const cust = eqCustomPresets.find(p => p.id === id);
          const target = builtIn ?? cust;
          if (target) {
            playback.setEqGains([...target.gains]);
            playback.setEqPreset(id);
          }
        }}
        onEqGainChange={(i, db) => {
          const next = [...playback.eqGains];
          next[i] = db;
          playback.setEqGains(next);
          playback.setEqPreset(presetForGains(next, eqCustomPresets));
        }}
        onEqPreGainChange={playback.setEqPreGainDb}
        onEqBassChange={playback.setEqBassDb}
        onEqTrebleChange={playback.setEqTrebleDb}
        onEqResetAll={() => {
          if (playback.eqMode === "simple") {
            playback.setEqBassDb(0);
            playback.setEqTrebleDb(0);
            return;
          }
          playback.setEqGains([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
          playback.setEqPreset("flat");
          playback.setEqPreGainDb(0);
        }}
        onEqSaveAs={() => setEqSaveAsOpen(true)}
        eqShowBarControl={playback.eqMode === "simple" ? eqShowBarControlSimple : eqShowBarControlAdvanced}
        onEqShowBarControlChange={playback.eqMode === "simple" ? setEqShowBarControlSimple : setEqShowBarControlAdvanced}
        onToggleQueueMode={queueHook.toggleQueueMode}
        onRandomize={queueHook.randomizeQueue}
        queueLength={queueHook.queue.length}
        onToggleAutoContinue={() => autoContinue.setEnabled(!autoContinue.enabled)}
        onToggleAutoContinueSameFormat={() => autoContinue.setSameFormat(!autoContinue.sameFormat)}
        onToggleAutoContinuePopover={() => autoContinue.setShowPopover(!autoContinue.showPopover)}
        onAdjustAutoContinueWeight={autoContinue.adjustWeight}
        onResetAutoContinueWeights={autoContinue.resetWeights}
        onCloseAutoContinuePopover={() => autoContinue.setShowPopover(false)}
        onToggleLike={() => playback.currentTrack && likeActions.handleToggleLike(playback.currentTrack)}
        onToggleDislike={() => { if (playback.currentTrack) likeActions.handleToggleDislike(playback.currentTrack); }}
        onTrackClick={(trackId) => { library.handleTrackClick(trackId); }}
        onNavigateToArtistByName={library.navigateToArtistByName}
        onNavigateToAlbumByName={library.navigateToAlbumByName}
        onNavigateToTagByName={library.navigateToTagByName}
        showHelp={showHelp}
        onToggleHelp={() => setShowHelp(h => !h)}
        resolvedSource={resolvedSource}
        loadingTrack={playback.loadingTrack}
        playbackError={playback.playbackError}
        onSkipError={() => { playback.clearPlaybackError(); handleNext(); }}
        onContextMenu={(e: React.MouseEvent) => {
          const specs: MenuItemSpec[] = [];
          const t = playback.currentTrack;
          if (t) {
            specs.push({ kind: "item", text: playback.playing ? "Pause" : "Play", action: playback.handlePause });
            specs.push({ kind: "item", text: "Next", action: handleNext });
            specs.push({ kind: "item", text: "Previous", action: queueHook.playPrevious });
            specs.push({ kind: "separator" });
            const ratingItems: MenuItemSpec[] = [
              { kind: "check", text: "Like", checked: t.liked === 1, action: () => likeActions.handleToggleLike(t) },
              { kind: "check", text: "None", checked: t.liked === 0, action: () => { if (t.liked === 1) likeActions.handleToggleLike(t); else if (t.liked === -1) likeActions.handleToggleDislike(t); } },
              { kind: "check", text: "Dislike", checked: t.liked === -1, action: () => likeActions.handleToggleDislike(t) },
            ];
            specs.push({ kind: "submenu", text: "Rating", items: ratingItems });
          }
          const widthItems: MenuItemSpec[] = (["small", "medium", "large"] as const).map(size => ({
            kind: "check" as const,
            text: size === "small" ? "Small" : size === "medium" ? "Medium" : "Large",
            checked: mini.miniWidthSize === size,
            action: () => mini.setMiniWidthSize(size),
          }));
          specs.push({ kind: "submenu", text: "Width", items: widthItems });
          const heightItems: MenuItemSpec[] = [
            { kind: "check", text: "Normal", checked: mini.miniRestingSize === "normal", action: () => mini.setMiniRestingSize("normal") },
            { kind: "check", text: "Compact", checked: mini.miniRestingSize === "compact", action: () => mini.setMiniRestingSize("compact") },
          ];
          specs.push({ kind: "submenu", text: "Height", items: heightItems });
          specs.push({ kind: "separator" });
          specs.push({ kind: "item", text: "Show Main Window", action: mini.toggleMiniMode });
          specs.push({ kind: "item", text: "Exit App", action: () => exit(0) });
          showNativeMenu(e.clientX, e.clientY, specs);
        }}
        miniSearch={{
          isOpen: miniSearch.isOpen,
          query: miniSearch.query,
          results: miniSearch.results,
          items: miniSearch.items,
          highlightedIndex: miniSearch.highlightedIndex,
          onQueryChange: miniSearch.setQuery,
          onKeyDown: miniSearch.handleKeyDown,
          onResultClick: miniSearch.handleResultClick,
        }}
        getAlbumImage={albumImageCache.getImage}
        getArtistImage={artistImageCache.getImage}
        onDownloadTrack={playback.currentTrack ? () => openDownloadForCurrentTrack(playback.currentTrack!, resolvedSource) : undefined}
        tagSuggestions={tagSuggestionPool}
        invokeInfoFetch={plugins.invokeInfoFetch}
        pluginsLoaded={plugins.pluginsLoaded}
      />

      {retrieve.modal && (
        <RetrieveModal
          modal={retrieve.modal}
          onTryNext={retrieve.tryNext}
          onApplyNow={retrieve.applyNow}
          onCancel={retrieve.cancel}
          onSetKeepOpen={retrieve.setKeepOpen}
        />
      )}

      <Toasts toasts={toasts} onDismiss={dismissToast} />

    </div>
    </VideoFrameQueueProvider>
  );
}

export default App;
