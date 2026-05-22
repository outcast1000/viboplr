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

import type { Track, QueueTrack, Tag, View, ViewMode, ColumnConfig, SortField, SortDir, Collection } from "./types";
import { isVideoTrack, parseSubsonicUrl, trashLabel } from "./utils";

const TRANSCODE_VIDEO_FORMATS = ["mkv", "avi", "wmv"];

function needsTranscode(track: { format: string | null }): boolean {
  return TRANSCODE_VIDEO_FORMATS.includes(track.format?.toLowerCase() ?? "");
}

import { store } from "./store";
import { parseUrlScheme, trackToQueueEntry, isRemoteScheme, shouldAutoSave, nextExternalKey, parseLibraryId, isLocalTrack, type QueueEntry } from "./queueEntry";
import { tracksFromManifest, contextFromManifest, contextToExportMetadata, contextFromMixtapeMetadata, type Manifest, type MainPlaylistState } from "./mainPlaylist";
import type { SearchProviderConfig } from "./searchProviders";
import { DEFAULT_PROVIDERS, loadProviders, saveProviders, getProvidersForContext, buildSearchUrl } from "./searchProviders";
import { type StreamResolver, stripRemasterSuffix } from "./streamResolvers";
import { timeAsync, getTimingEntries, type TimingEntry } from "./startupTiming";

import { usePlayback } from "./hooks/usePlayback";
import { useQueue } from "./hooks/useQueue";
import { usePlayActions } from "./hooks/usePlayActions";
import { useLibrary, DEFAULT_TRACK_COLUMNS } from "./hooks/useLibrary";
import { useEventListeners } from "./hooks/useEventListeners";
import { useImageCache } from "./hooks/useImageCache";
import { useAutoContinue } from "./hooks/useAutoContinue";
import { usePasteImage } from "./hooks/usePasteImage";
import { useNavigationHistory, type NavState } from "./hooks/useNavigationHistory";
import { useAppUpdater } from "./hooks/useAppUpdater";
import { useMiniMode, cycleRestingSize, cycleMiniWidth } from "./hooks/useMiniMode";
import { useVideoLayout } from "./hooks/useVideoLayout";
import type { VideoLayoutState } from "./hooks/useVideoLayout";
import { useWaveform } from "./hooks/useWaveform";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useSkins } from "./hooks/useSkins";
import { usePlugins, DEFAULT_DOWNLOAD_PROVIDER_PRIORITY, type PluginHostCallbacks } from "./hooks/usePlugins";
import { useImageResolver } from "./hooks/useImageResolver";
import { useExtensions } from "./hooks/useExtensions";

import { useDownloads } from "./hooks/useDownloads";
import { useLikeActions } from "./hooks/useLikeActions";
import { useCollectionActions } from "./hooks/useCollectionActions";
import { useContextMenuActions } from "./hooks/useContextMenuActions";
import type { PluginTrack, DownloadProvider, DownloadResolveResult } from "./types/plugin";
import { useViewSearchState } from "./hooks/useViewSearchState";
import { useCentralSearch } from "./hooks/useCentralSearch";
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
import { AddServerModal } from "./components/AddServerModal";
import { showNativeMenu, type MenuItemSpec } from "./nativeMenu";
import { toPluginTarget } from "./types/contextMenu";
import { ArtistDetailContent } from "./components/ArtistDetailContent";
import { AlbumDetail } from "./components/AlbumDetail";
import { TagDetail } from "./components/TagDetail";
import { HistoryView } from "./components/HistoryView";
import type { HistoryViewHandle } from "./components/HistoryView";
import { PlaylistsView } from "./components/PlaylistsView";
import { SavePlaylistModal } from "./components/SavePlaylistModal";
import { CollectionsView } from "./components/CollectionsView";
import { EditCollectionModal } from "./components/EditCollectionModal";
import { PluginViewRenderer } from "./components/PluginViewRenderer";
import { TrackDetailView } from "./components/TrackDetailView";
import { DownloadModal } from "./components/DownloadModal";
import type { DownloadTrack } from "./components/DownloadModal";
import BulkEditModal from "./components/BulkEditModal";
import PlaybackErrorModal from "./components/PlaybackErrorModal";
import { MixtapePreviewModal } from "./components/MixtapePreviewModal";
import { MixtapeExportModal } from "./components/MixtapeExportModal";
import type { ExportTrack } from "./components/MixtapeExportModal";

import { SearchView } from "./components/SearchView";
import { IconYoutube } from "./components/Icons";
import { useDependencies } from "./hooks/useDependencies";
import { DependencyModal } from "./components/DependencyModal";


function VideoFrameQueueRefBridge({ refOut }: { refOut: React.MutableRefObject<VideoFrameQueue | null> }) {
  const queue = useVideoFrameQueue();
  useEffect(() => { refOut.current = queue; }, [queue, refOut]);
  return null;
}

function App() {
  const restoredRef = useRef(false);
  const videoFrameQueueRef = useRef<VideoFrameQueue | null>(null);
  const [appRestoring, setAppRestoring] = useState(true);
  const [navError, setNavError] = useState<string | null>(null);
  const [showSavePlaylistModal, setShowSavePlaylistModal] = useState(false);
  const [editPlaylistMode, setEditPlaylistMode] = useState(false);
  const [pluginLoadingMessage, setPluginLoadingMessage] = useState<string | null>(null);
  const [downloadModal, setDownloadModal] = useState<{
    tracks: DownloadTrack[];
    providerId: string;
    providerName: string;
    confirmed?: boolean;
    resolveByUri?: (uri: string, format: string) => Promise<DownloadResolveResult | null>;
  } | null>(null);
  const pendingRestoreTrackRef = useRef<QueueTrack | null>(null);
  const pendingRestoreQueueRef = useRef<{ tracks: QueueTrack[]; index: number } | null>(null);
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
  const peekNextRef = useRef<() => QueueTrack | null>(() => null);
  const prefetchNextRef = useRef<() => void>(() => {});
  const crossfadeSecsRef = useRef(3);
  const [crossfadeSecs, setCrossfadeSecs] = useState(3);
  crossfadeSecsRef.current = crossfadeSecs;
  const trackVideoHistoryRef = useRef(false);
  const [trackVideoHistory, setTrackVideoHistory] = useState(false);
  const [loggingEnabled, setLoggingEnabled] = useState(false);
  const [minimizeToMiniPlayer, setMinimizeToMiniPlayer] = useState(false);
  const [debugLogging, setDebugLogging] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [lastDownloadDest, setLastDownloadDest] = useState<string | null>(null);
  const [autoSaveStreams, setAutoSaveStreams] = useState<Record<string, boolean>>({});
  const [downloadsCollectionId, setDownloadsCollectionId] = useState<number | null>(null);
  const [mainPlaylistDir, setMainPlaylistDir] = useState<string | null>(null);
  const autoSaveStreamsRef = useRef<Record<string, boolean>>({});
  const downloadsCollectionIdRef = useRef<number | null>(null);
  trackVideoHistoryRef.current = trackVideoHistory;
  autoSaveStreamsRef.current = autoSaveStreams;
  downloadsCollectionIdRef.current = downloadsCollectionId;
  const advanceIndexRef = useRef<() => void>(() => {});
  const resolveStreamByUriRef = useRef<(scheme: string, id: string, quality?: string | null) => Promise<string>>(
    async () => { throw new Error("Stream URI resolver not ready"); }
  );
  const resolveTrackSrcRef = useRef<(track: QueueTrack) => Promise<string>>(async (track) => {
    const url = track.path;
    if (!url) throw new Error("Track has no URL");
    const parsed = parseUrlScheme(url);
    if (parsed.scheme === "file") return convertFileSrc(parsed.path);
    if (parsed.scheme === "plugin") {
      const resolved = await resolveStreamByUriRef.current(parsed.protocol, parsed.id, null);
      if (resolved.startsWith("file://")) return convertFileSrc(resolved.substring(7));
      return resolved;
    }
    if (parsed.scheme === "external") throw new Error("Cannot play external track directly — requires stream resolver");
    return invoke<string>("resolve_subsonic_location", { location: parsed.url });
  });
  const streamResolversRef = useRef<StreamResolver[]>([]);
  const [streamResolverOrderVersion, setStreamResolverOrderVersion] = useState(0);
  const [resolvingStatus, setResolvingStatus] = useState<{ error: string | null; trying: string | null } | null>(null);
  const [resolvedSource, setResolvedSource] = useState<{ name: string; url: string; sourceUrl: string | null; id: string | null } | null>(null);
  const resolveGenerationRef = useRef(0);
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
  useEffect(() => {
    if (transcodeSessionRef.current && (!playback.currentTrack || !needsTranscode(playback.currentTrack))) {
      invoke("stop_transcode", { sessionId: transcodeSessionRef.current.sessionId }).catch(console.error);
      transcodeSessionRef.current = null;
    }
  }, [playback.currentTrack]);

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
  const downloadFormatRef = useRef("flac");
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
    getDownloadFormat: () => downloadFormatRef.current,
  }), [queueHook, pluginTrackToQueueTrack]);
  const pluginHostCallbacksRef = useRef<PluginHostCallbacks | undefined>(undefined);
  const plugins = usePlugins(pluginTrackRef, pluginPlayingRef, pluginPositionRef, pluginPlaybackCallbacks, pluginHostCallbacksRef.current, debugMode);
  const dependencies = useDependencies(plugins.pluginStates);
  if (import.meta.env.DEV) (window as any).__dependencies = dependencies;

  // Wire up image resolver to handle image-resolve-request events
  useImageResolver(plugins.invokeImageFetch);

  const streamResolversMeta = useMemo(() => {
    const meta: Array<{ id: string; name: string; source: string }> = [];
    for (const ps of plugins.pluginStates) {
      if (ps.status !== "active") continue;
      const srs = ps.manifest.contributes?.streamResolvers;
      if (!srs) continue;
      for (const sr of srs) {
        meta.push({ id: `${ps.id}:${sr.id}`, name: sr.name, source: ps.id });
      }
    }
    return meta;
  }, [plugins.pluginStates]);

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

      // Migrate old boolean autoSaveStreams to per-resolver map
      const stored = await store.get<Record<string, boolean> | boolean>("autoSaveStreams");
      if (typeof stored === "boolean") {
        if (stored) {
          const migrated: Record<string, boolean> = {};
          for (const r of pluginResolvers) {
            migrated[r.id] = true;
          }
          setAutoSaveStreams(migrated);
          store.set("autoSaveStreams", migrated);
        } else {
          setAutoSaveStreams({});
          store.set("autoSaveStreams", {});
        }
      }
    };
    buildResolvers();
  }, [plugins.pluginStates, plugins.invokeStreamResolve, streamResolverOrderVersion]);

  // Build ordered download provider list from active plugins
  const downloadProviders = useMemo(() => {
    const providers: DownloadProvider[] = [];

    // Built-in subsonic provider
    providers.push({
      id: "__builtin:subsonic",
      name: "Subsonic",
      source: "__builtin",
      resolveByUri: async (uri, format) => {
        if (!uri.startsWith("subsonic://")) return null;
        const rest = uri.substring(11);
        const lastSlash = rest.lastIndexOf("/");
        if (lastSlash < 0) return null;
        const collectionId = parseInt(rest.substring(0, lastSlash), 10);
        const trackId = rest.substring(lastSlash + 1);
        if (!trackId || isNaN(collectionId)) return null;
        try {
          const url = await invoke<string>("resolve_subsonic_download_url", {
            collectionId, remoteTrackId: trackId, format,
          });
          return { url, headers: null, metadata: null };
        } catch (e) {
          console.error("Subsonic download resolve failed:", e);
          return null;
        }
      },
      resolveByMetadata: async () => null,
    });

    // Plugin providers
    for (const ps of plugins.pluginStates) {
      if (ps.status !== "active") continue;
      const dps = ps.manifest.contributes?.downloadProviders;
      if (!dps) continue;
      for (const dp of dps) {
        providers.push({
          id: `${ps.id}:${dp.id}`,
          name: dp.name,
          source: ps.id,
          resolveByUri: (uri, format) =>
            plugins.invokeDownloadResolveByUri(ps.id, dp.id, uri, format),
          resolveByMetadata: (title, artistName, albumName, durationSecs, format) =>
            plugins.invokeDownloadResolveByMetadata(ps.id, dp.id, title, artistName, albumName, durationSecs, format),
        });
      }
    }

    return providers;
  }, [plugins.pluginStates, plugins.invokeDownloadResolveByUri, plugins.invokeDownloadResolveByMetadata]);

  const downloadProvidersRef = useRef<DownloadProvider[]>([]);
  downloadProvidersRef.current = downloadProviders;

  const [providerPriorities, setProviderPriorities] = useState<Map<string, number>>(new Map());

  const refreshProviderPriorities = useCallback(async () => {
    try {
      const rows = await invoke<[string, string, string, number][]>("get_active_download_providers");
      const map = new Map<string, number>();
      for (const [pluginId, providerId, , priority] of rows) {
        map.set(`${pluginId}:${providerId}`, priority);
      }
      setProviderPriorities(map);
    } catch (e) {
      console.error("Failed to load download provider priorities:", e);
    }
  }, []);

  const downloadProviderEntries = useMemo(() => {
    return downloadProviders
      .filter(p => p.source !== "__builtin")
      .map(p => {
        const parts = p.id.split(":");
        const pluginId = parts[0];
        const providerId = parts.slice(1).join(":");
        return {
          id: p.id,
          name: p.name,
          priority: providerPriorities.get(p.id) ?? Number.MAX_SAFE_INTEGER,
          interactive: plugins.hasInteractiveDownload(pluginId, providerId),
        };
      })
      .sort((a, b) => a.priority - b.priority);
  }, [downloadProviders, providerPriorities, plugins.hasInteractiveDownload]);

  // Sync download providers to DB for backend ordering
  useEffect(() => {
    const providerData: [string, string, string, number][] = [];
    for (const ps of plugins.pluginStates) {
      if (ps.status !== "active") continue;
      const dps = ps.manifest.contributes?.downloadProviders;
      if (!dps) continue;
      for (const dp of dps) {
        const dlPriority = DEFAULT_DOWNLOAD_PROVIDER_PRIORITY[`${ps.id}:${dp.id}`] ?? 999;
        providerData.push([ps.id, dp.id, dp.name, dlPriority]);
      }
    }
    if (providerData.length > 0) {
      invoke("sync_download_providers", { providers: providerData })
        .then(() => refreshProviderPriorities())
        .catch(console.error);
    } else {
      refreshProviderPriorities();
    }
  }, [plugins.pluginStates, refreshProviderPriorities]);


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
    if (shouldAutoSave(autoSaveStreamsRef.current, track.path ?? "", resolvedSource?.id ?? null)) {
      const dlColId = downloadsCollectionIdRef.current;
      if (dlColId != null) {
        downloads.autoSaveTrack(track, dlColId, downloadFormatRef.current, library.tracks).catch(console.error);
      }
    }
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
  const [syncWithPlaying, setSyncWithPlaying] = useState(false);
  const [showAddServer, setShowAddServer] = useState(false);
  const [deepLinkServer, setDeepLinkServer] = useState<{ url: string; username: string; password: string } | null>(null);
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
        plugins.togglePlugin(id, plugin.status !== "active");
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

  // Downloads
  const downloads = useDownloads(downloadFormatRef, downloadProvidersRef);

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

  const playActions = usePlayActions({
    playTracks: queueHook.playTracks,
    setPlaylistContext: queueHook.setPlaylistContext,
    albums: library.albums,
    artists: library.artists,
    tags: library.tags,
    getAlbumImage: albumImageCache.getImage,
    getArtistImage: artistImageCache.getImage,
    getTagImage: tagImageCache.getImage,
  });

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const track = playback.currentTrack;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    const artSrc = track.image_url || null;
    const artwork: MediaImage[] = artSrc
      ? [{ src: artSrc.startsWith("http") ? artSrc : convertFileSrc(artSrc) }]
      : [];
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
    onShowMenu: (state) => showNativeMenuRef.current?.(state),
  });

  const handleDeleteTracks = useCallback((trackIds: number[]) => {
    const idSet = new Set(trackIds);
    const selected = library.tracks.filter(t => t.id != null && idSet.has(t.id));
    const localIds = selected.filter(t => t.id != null && isLocalTrack(t)).map(t => t.id!);
    if (localIds.length === 0) return;
    const title = localIds.length === 1
      ? (selected.find(t => t.id != null && t.id === localIds[0])?.title ?? "track")
      : `${localIds.length} tracks`;
    contextMenuActions.setDeleteConfirm({ trackIds: localIds, title });
  }, [library.tracks, contextMenuActions.setDeleteConfirm]);

  const handleDownloadFromProvider = useCallback((providerId: string, interactive: boolean) => {
    const ctx = contextMenuActions.contextMenu;
    if (!ctx) return;
    const target = ctx.target;

    // Collect tracks for batch downloads
    let batchTracks: QueueTrack[] | null = null;
    if (target.kind === "multi-track") {
      const idSet = new Set(target.trackIds);
      batchTracks = library.tracks.filter(t => t.id != null && idSet.has(t.id));
    } else if (target.kind === "queue-multi" && target.indices.length > 1) {
      batchTracks = target.indices.map(i => queueHook.queue[i]).filter(Boolean);
    }

    if (batchTracks && batchTracks.length > 0) {
      const providerEntry = downloadProviderEntries.find(e => e.id === providerId);
      setDownloadModal({
        tracks: batchTracks.map(t => ({
          title: t.title,
          artistName: t.artist_name ?? null,
          albumTitle: t.album_title ?? null,
          uri: t.path ?? null,
          durationSecs: t.duration_secs ?? null,
          trackId: parseLibraryId(t.key),
        })),
        providerId,
        providerName: providerEntry?.name ?? providerId,
        confirmed: !interactive,
      });
      return;
    }

    // Single track
    let trackId: number | null = null;
    let title = "";
    let artistName: string | null = null;

    if (target.kind === "track") {
      trackId = target.trackId ?? null;
      title = target.title ?? "";
      artistName = target.artistName ?? null;
    } else if (target.kind === "queue-multi" && target.indices.length === 1) {
      const queueTrack = queueHook.queue[target.indices[0]];
      if (queueTrack) {
        trackId = parseLibraryId(queueTrack.key);
        title = queueTrack.title;
        artistName = queueTrack.artist_name ?? null;
      }
    } else {
      return;
    }

    if (interactive) {
      const track = trackId != null ? library.tracks.find(t => t.id === trackId) : null;
      setDownloadModal({
        tracks: [{
          title: track?.title ?? title,
          artistName: track?.artist_name ?? artistName,
          albumTitle: track?.album_title ?? null,
          uri: track?.path ?? null,
          durationSecs: track?.duration_secs ?? null,
          trackId,
        }],
        providerId,
        providerName: downloadProviderEntries.find(e => e.id === providerId)?.name ?? providerId,
      });
    } else {
      // Non-interactive: silent enqueue (no modal)
      const track = trackId != null ? library.tracks.find(t => t.id === trackId) : null;
      invoke("enqueue_download", {
        title: track?.title ?? title,
        artistName: track?.artist_name ?? artistName,
        albumTitle: track?.album_title ?? null,
        uri: track?.path ?? null,
        durationSecs: track?.duration_secs ?? null,
        destCollectionId: null,
        format: downloadFormatRef.current,
        provider: providerId,
      }).catch((e: unknown) => {
        console.error("Failed to enqueue download:", e);
      });
    }
  }, [contextMenuActions.contextMenu, downloadProviderEntries, library.tracks, queueHook.queue]);

  const buildAndShowNativeMenu = useCallback((cm: { x: number; y: number; target: import("./types/contextMenu").ContextMenuTarget }) => {
    contextMenuActions.setContextMenu(cm);
    const { target } = cm;
    const specs: MenuItemSpec[] = [];

    if (target.kind === "video") {
      (["contain", "fit-width", "fit-height", "fill"] as const).forEach(mode => {
        specs.push({ kind: "check", text: mode === "contain" ? "Contain" : mode === "fit-width" ? "Fit Width" : mode === "fit-height" ? "Fit Height" : "Fill", checked: target.fitMode === mode, action: () => videoLayout.setFitMode(mode) });
      });
      specs.push({ kind: "separator" });
      (["top", "bottom", "left", "right"] as const).forEach(side => {
        specs.push({ kind: "check", text: side[0].toUpperCase() + side.slice(1), checked: target.dockSide === side, action: () => videoLayout.setDockSide(side) });
      });
    } else if (target.kind === "queue-multi") {
      const count = target.indices.length;
      const selectedTracks = target.indices.map(i => queueHook.queue[i]).filter(Boolean);

      // Queue operations — always available
      if (contextMenuActions.handleQueueRemove) {
        specs.push({ kind: "item", text: count > 1 ? `Remove ${count} tracks` : "Remove", action: contextMenuActions.handleQueueRemove });
      }
      if (contextMenuActions.handleQueueKeepOnly) {
        specs.push({ kind: "item", text: count > 1 ? `Keep only ${count} tracks` : "Keep only", action: contextMenuActions.handleQueueKeepOnly });
      }
      if (contextMenuActions.handleQueueMoveToTop) {
        specs.push({ kind: "item", text: "Move to top", action: contextMenuActions.handleQueueMoveToTop });
      }
      if (contextMenuActions.handleQueueMoveToBottom) {
        specs.push({ kind: "item", text: "Move to bottom", action: contextMenuActions.handleQueueMoveToBottom });
      }

      // Single-track actions
      if (count === 1) {
        if (target.firstTrack.isLocal) {
          specs.push({ kind: "separator" });
          specs.push({ kind: "item", text: "Open Containing Folder", action: contextMenuActions.handleShowInFolder });
        }
        const locateTrack = () => {
          const track = queueHook.queue[target.indices[0]];
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
        };
        specs.push({ kind: "item", text: "Locate Track", action: locateTrack });

        // Find in YouTube — works by metadata, any track type
        specs.push({ kind: "item", text: "Find in YouTube", action: () => {
          const track = queueHook.queue[target.indices[0]];
          if (track) {
            contextMenuActions.watchOnYoutube(parseLibraryId(track.key) ?? 0, track.title, track.artist_name, null, track.duration_secs ?? null);
          }
        }});

        // View Details — needs library ID
        if (target.trackIds[0] != null) {
          specs.push({ kind: "item", text: "View Details", action: () => library.handleTrackClick(`lib:${target.trackIds[0]}`) });
        }
      }

      // Move to Trash — local tracks only
      if (contextMenuActions.handleDeleteRequest) {
        const localDeletable = selectedTracks.filter(t => isLocalTrack(t) && parseLibraryId(t.key) != null);
        if (localDeletable.length > 0) {
          specs.push({ kind: "separator" });
          const deleteLabel = localDeletable.length === 1 ? `Move to ${trashLabel}` : `Move ${localDeletable.length} local tracks to ${trashLabel}`;
          specs.push({ kind: "item", text: deleteLabel, action: contextMenuActions.handleDeleteRequest });
        }
      }

      // Download — non-local tracks only
      if (downloadProviderEntries.length > 0) {
        const downloadable = selectedTracks.filter(t => !isLocalTrack(t));
        if (downloadable.length > 0) {
          const dlItems: MenuItemSpec[] = [];
          dlItems.push({ kind: "item", text: "Download (auto)", action: () => {
            if (downloadable.length === 1) contextMenuActions.handleDownloadTrack(downloadable[0]);
            else contextMenuActions.handleDownloadMulti(downloadable);
          }});
          downloadProviderEntries.forEach(entry => {
            dlItems.push({ kind: "item", text: `Download from ${entry.name}${entry.interactive ? "..." : ""}`, action: () => handleDownloadFromProvider(entry.id, entry.interactive) });
          });
          specs.push({ kind: "separator" });
          const dlLabel = downloadable.length === 1 ? "Download" : `Download ${downloadable.length} tracks`;
          specs.push({ kind: "submenu", text: dlLabel, items: dlItems });
        }
      }

      // Search providers — single track only
      if (count === 1) {
        const contextProviders = getProvidersForContext(searchProviders, "track");
        if (contextProviders.length > 0) {
          const params = { title: target.firstTrack.title, artist: target.firstTrack.artistName ?? undefined };
          const searchItems: MenuItemSpec[] = contextProviders.map(provider => ({
            kind: "item" as const,
            text: provider.name,
            action: () => openUrl(buildSearchUrl(provider.trackUrl!, params)),
          }));
          specs.push({ kind: "separator" });
          specs.push({ kind: "submenu", text: "Search", items: searchItems });
        }
      }

      // Plugin actions
      const pluginTargetKind = count === 1 ? "track" : "multi-track";
      const matching = plugins.menuItems.filter(item => item.targets.includes(pluginTargetKind as "track" | "multi-track"));
      if (matching.length > 0) {
        specs.push({ kind: "separator" });
        matching.forEach(item => {
          specs.push({ kind: "item", text: item.label, action: () => plugins.dispatchContextMenuAction(item.pluginId, item.id, toPluginTarget(target)) });
        });
      }
    } else if (target.kind === "multi-album" || target.kind === "multi-artist" || target.kind === "multi-tag") {
      const count = target.kind === "multi-album" ? target.albumIds.length
                  : target.kind === "multi-artist" ? target.artistIds.length
                  : target.tagIds.length;
      const label = target.kind === "multi-album" ? "albums" : target.kind === "multi-artist" ? "artists" : "tags";
      specs.push({ kind: "item", text: `Play ${count} ${label}`, action: contextMenuActions.handleContextPlay });
      specs.push({ kind: "item", text: `Enqueue ${count} ${label}`, action: contextMenuActions.handleContextEnqueue });
      if (target.kind === "multi-tag") {
        const tagsToDelete = target.tagIds.map(id => {
          const tag = library.tags.find(t => t.id === id);
          return { id, name: tag?.name ?? "Unknown" };
        });
        specs.push({ kind: "separator" });
        specs.push({ kind: "item", text: `Delete ${count} tags`, action: () => {
          setDeleteTagConfirm(tagsToDelete);
        }});
      }
    } else {
      const isMulti = target.kind === "multi-track";
      const context = isMulti ? "track" : target.kind;
      const hasId = target.kind === "artist" ? !!target.artistId
                  : target.kind === "album" ? !!target.albumId
                  : target.kind === "track" ? !!target.trackId
                  : target.kind === "tag" ? !!target.tagId
                  : true;

      if (hasId) {
        specs.push({ kind: "item", text: isMulti ? `Play ${target.trackIds.length} tracks` : "Play", action: contextMenuActions.handleContextPlay });
        specs.push({ kind: "item", text: isMulti ? `Enqueue ${target.trackIds.length} tracks` : "Enqueue", action: contextMenuActions.handleContextEnqueue });
      }
      if (hasId && (target.kind === "artist" || target.kind === "album" || target.kind === "tag")) {
        const refreshAction = target.kind === "artist"
          ? () => artistImageCache.requestFetch(target.name)
          : target.kind === "album"
          ? () => albumImageCache.requestFetch(target.title, target.artistName)
          : target.kind === "tag"
          ? () => tagImageCache.requestFetch(target.name)
          : null;
        if (refreshAction) {
          specs.push({ kind: "item", text: "Refresh Image", action: refreshAction });
        }
      }
      if (isMulti && contextMenuActions.handleBulkEdit) {
        specs.push({ kind: "item", text: "Edit Properties", action: contextMenuActions.handleBulkEdit });
      }
      if (target.kind === "track" && target.isLocal) {
        specs.push({ kind: "item", text: "Open Containing Folder", action: contextMenuActions.handleShowInFolder });
      }
      if (target.kind === "track" && target.trackId && contextMenuActions.handleWatchOnYoutube) {
        specs.push({ kind: "item", text: "Find in YouTube", action: contextMenuActions.handleWatchOnYoutube });
      }
      if (target.kind === "track" && target.trackId) {
        specs.push({ kind: "item", text: "View Details", action: () => library.handleTrackClick(`lib:${target.trackId}`) });
      }
      if (contextMenuActions.handleDeleteRequest && (target.kind === "track" && target.isLocal || target.kind === "multi-track")) {
        if (target.kind === "track") {
          specs.push({ kind: "separator" });
          specs.push({ kind: "item", text: `Move to ${trashLabel}`, action: contextMenuActions.handleDeleteRequest });
        } else {
          const localCount = library.tracks.filter(t => target.trackIds.includes(t.id!) && isLocalTrack(t)).length;
          if (localCount > 0) {
            specs.push({ kind: "separator" });
            specs.push({ kind: "item", text: `Move ${localCount} local track${localCount > 1 ? "s" : ""} to ${trashLabel}`, action: contextMenuActions.handleDeleteRequest });
          }
        }
      }
      if (target.kind === "track" && !target.isLocal && downloadProviderEntries.length > 0) {
        const dlItems: MenuItemSpec[] = [];
        dlItems.push({ kind: "item", text: "Download (auto)", action: () => {
          if (target.trackId) {
            const track = library.tracks.find(tr => tr.id === target.trackId);
            if (track) contextMenuActions.handleDownloadTrack(track);
          }
        }});
        downloadProviderEntries.forEach(entry => {
          dlItems.push({ kind: "item", text: `Download from ${entry.name}${entry.interactive ? "..." : ""}`, action: () => handleDownloadFromProvider(entry.id, entry.interactive) });
        });
        specs.push({ kind: "separator" });
        specs.push({ kind: "submenu", text: "Download", items: dlItems });
      }
      if (target.kind === "album" && target.albumId && downloadProviderEntries.length > 0) {
        specs.push({ kind: "separator" });
        specs.push({ kind: "item", text: "Download Album", action: () => {
          const albumTracks = library.tracks.filter(tr => tr.album_id === target.albumId);
          if (albumTracks.length) contextMenuActions.handleDownloadMulti(albumTracks);
        }});
      }
      if (isMulti && downloadProviderEntries.length > 0) {
        const dlItems: MenuItemSpec[] = [];
        dlItems.push({ kind: "item", text: "Download (auto)", action: () => {
          const idSet = new Set(target.trackIds);
          const selected = library.tracks.filter(tr => tr.id != null && idSet.has(tr.id));
          contextMenuActions.handleDownloadMulti(selected);
        }});
        downloadProviderEntries.forEach(entry => {
          dlItems.push({ kind: "item", text: `Download from ${entry.name}${entry.interactive ? "..." : ""}`, action: () => handleDownloadFromProvider(entry.id, entry.interactive) });
        });
        specs.push({ kind: "separator" });
        specs.push({ kind: "submenu", text: `Download ${target.trackIds.length} tracks`, items: dlItems });
      }
      if (!isMulti && target.kind !== "tag") {
        const contextProviders = getProvidersForContext(searchProviders, context as "artist" | "album" | "track");
        if (contextProviders.length > 0) {
          const urlKey = context === "artist" ? "artistUrl" : context === "album" ? "albumUrl" : "trackUrl";
          const params = target.kind === "artist"
            ? { artist: target.name }
            : { title: target.title, artist: target.artistName ?? undefined };
          const searchItems: MenuItemSpec[] = contextProviders.map(provider => ({
            kind: "item" as const,
            text: provider.name,
            action: () => openUrl(buildSearchUrl(provider[urlKey]!, params)),
          }));
          specs.push({ kind: "separator" });
          specs.push({ kind: "submenu", text: "Search", items: searchItems });
        }
      }
      const targetKind = target.kind as string;
      const matching = plugins.menuItems.filter(item => item.targets.includes(targetKind as "track" | "album" | "artist" | "multi-track"));
      if (matching.length > 0) {
        specs.push({ kind: "separator" });
        matching.forEach(item => {
          specs.push({ kind: "item", text: item.label, action: () => plugins.dispatchContextMenuAction(item.pluginId, item.id, toPluginTarget(target)) });
        });
      }
      if (isMulti && handleExportAsMixtapeRef.current) {
        specs.push({ kind: "separator" });
        specs.push({ kind: "item", text: "Export as Mixtape", action: () => handleExportAsMixtapeRef.current?.(target.trackIds) });
      }
      if (target.kind === "tag" && target.tagId) {
        specs.push({ kind: "separator" });
        specs.push({ kind: "item", text: "Delete Tag", action: () => {
          setDeleteTagConfirm([{ id: target.tagId, name: target.name }]);
        }});
      }
    }

    if (specs.length === 0) {
      contextMenuActions.setContextMenu(null);
      return;
    }

    showNativeMenu(cm.x, cm.y, specs);
  }, [contextMenuActions, videoLayout, queueHook.queue, library, downloadProviderEntries, plugins.menuItems, plugins.dispatchContextMenuAction, searchProviders, handleDownloadFromProvider, artistImageCache, albumImageCache]);
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
      }
    },
    showNotification: (message) => {
      console.debug("[plugin]", message);
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
    dispatchPluginEvent: plugins.dispatchEvent as (event: string, ...args: unknown[]) => void,
  });

  useEffect(() => {
    resolveStreamByUriRef.current = plugins.resolveStreamByUri;
  }, [plugins.resolveStreamByUri]);

  // Resolve a queue track's url to a playable source
  useEffect(() => {
    const resolveUrl = (url: string): Promise<string> => {
      if (url.startsWith("http://") || url.startsWith("https://")) return Promise.resolve(url);
      const parsed = parseUrlScheme(url);
      if (parsed.scheme === "file") return Promise.resolve(convertFileSrc(parsed.path));
      if (parsed.scheme === "plugin") return resolveStreamByUriRef.current(parsed.protocol, parsed.id, null).then(r => resolveUrl(r));
      if (parsed.scheme === "subsonic") return invoke<string>("resolve_subsonic_location", { location: url });
      return Promise.reject(new Error(`Unplayable URL scheme: ${url}`));
    };

    const nativeResolverName = (url: string): string => {
      if (url.startsWith("http://") || url.startsWith("https://")) return "Direct URL";
      const parsed = parseUrlScheme(url);
      if (parsed.scheme === "file") return "Local";
      if (parsed.scheme === "plugin") return parsed.protocol.charAt(0).toUpperCase() + parsed.protocol.slice(1);
      if (parsed.scheme === "subsonic") return "Subsonic";
      return "Unknown";
    };

    resolveTrackSrcRef.current = async (track: QueueTrack) => {
      const generation = ++resolveGenerationRef.current;
      setResolvedSource(null);
      const url = track.path;

      interface ResolverEntry { name: string; id: string | null; sourceUrl: string | null; resolve: () => Promise<string> }
      const chain: ResolverEntry[] = [];

      // Pre-resolution: check if a local copy exists for remote tracks
      if (url && isRemoteScheme(url)) {
        try {
          const localMatch = await invoke<Track | null>("find_track_by_metadata", {
            title: stripRemasterSuffix(track.title) ?? track.title,
            artistName: track.artist_name ?? null,
            albumName: stripRemasterSuffix(track.album_title),
          });
          if (localMatch && localMatch.path?.startsWith("file://")) {
            const localPath = localMatch.path.substring(7);
            chain.push({
              name: "Library",
              id: null,
              sourceUrl: localPath,
              resolve: () => Promise.resolve(convertFileSrc(localPath)),
            });
          }
        } catch (e) {
          console.error("Pre-resolution local copy check failed:", e);
        }
      }

      // Native resolver first (if track has a known URL)
      if (url) {
        if (url.startsWith("http://") || url.startsWith("https://")) {
          chain.push({ name: "Direct URL", id: null, sourceUrl: url, resolve: () => Promise.resolve(url) });
        } else {
          chain.push({
            name: nativeResolverName(url),
            id: null,
            sourceUrl: url,
            resolve: async () => {
              const parsed = parseUrlScheme(url);
              if (parsed.scheme === "file" && needsTranscode(track)) {
                if (transcodeSessionRef.current) {
                  invoke("stop_transcode", { sessionId: transcodeSessionRef.current.sessionId }).catch(console.error);
                }
                try {
                  const result = await invoke<{ url: string; sessionId: string; durationSecs: number | null }>("start_transcode", { path: parsed.path });
                  transcodeSessionRef.current = {
                    sessionId: result.sessionId,
                    baseUrl: result.url.replace(/\?seek=.*$/, ""),
                    durationSecs: result.durationSecs ?? null,
                    seekOffset: 0,
                  };
                  return result.url;
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  if (msg.includes("ffmpeg is not installed")) {
                    dependencies.requireDep("ffmpeg", "Video playback");
                  }
                  throw e;
                }
              }
              return resolveUrl(url);
            },
          });
        }
      }

      // Append user-configured stream resolvers
      for (const sr of streamResolversRef.current) {
        const entry: ResolverEntry = {
          name: sr.name,
          id: sr.id,
          sourceUrl: null,
          resolve: async () => {
            const result = await Promise.race([
              sr.resolve(track.title, track.artist_name, track.album_title, track.duration_secs ?? null),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 60000)),
            ]);
            if (!result) throw new Error("No result");
            if (result.sourceUrl) entry.sourceUrl = result.sourceUrl;
            return resolveUrl(result.url);
          },
        };
        chain.push(entry);
      }

      if (chain.length === 0) {
        throw new Error(`No playback source for: ${track.title}`);
      }

      let lastError: string | null = null;
      for (const entry of chain) {
        if (resolveGenerationRef.current !== generation) return "";
        if (lastError || chain.length > 1) {
          setResolvingStatus({ error: lastError, trying: entry.name });
        }
        try {
          const src = await entry.resolve();
          if (resolveGenerationRef.current !== generation) return "";
          setResolvingStatus(null);
          setResolvedSource({ name: entry.name, url: src, sourceUrl: entry.sourceUrl, id: entry.id });
          if (lastError) {
            console.debug(`Playing from ${entry.name} (original unavailable)`);
          }
          return src;
        } catch (e) {
          console.error(`Stream resolver "${entry.name}" failed:`, e);
          lastError = entry.name === "Library" ? "Not in library" : `${entry.name} failed`;
          continue;
        }
      }

      if (resolveGenerationRef.current === generation) {
        setResolvingStatus(null);
      }
      throw new Error(`No playback source found for: ${track.title}`);
    };
  }, []);

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

  const { pushState, goBack, goForward, canGoBack, canGoForward } = useNavigationHistory(
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

  const syncRef = useRef(syncWithPlaying);
  syncRef.current = syncWithPlaying;

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

  // Clean up temporary mixtape files on app startup
  useEffect(() => {
    invoke("cleanup_temp_mixtapes").catch(() => {});
  }, []);

  // Restore persisted state on mount
  useEffect(() => {
    (async () => {
      try {
        await timeAsync("store.init", () => store.init());
        const [v, sa, sal, st, , vol, _pos, cf, savedTrackVideoHistory, wasMini, fww, fwh, fwx, fwy, tSortField, tSortDir, tCols, , , , savedTrackViewMode, , savedVideoLayout, savedVideoSplitHeight, savedSidebarCollapsed, savedQueueCollapsed, savedQueueWidth, savedDownloadFormat, , , , , , , , , , , savedFilterYoutubeOnly, savedMediaTypeFilter, savedTrackLikedFirst, savedLastDownloadDest, savedSearchViewModes, savedAutoSaveStreams, savedDownloadsCollectionId, savedMinimizeToMiniPlayer] = await timeAsync("store.restore", () => Promise.all([
          store.get<string>("view"),
          store.get<number | null>("selectedArtist"),
          store.get<number | null>("selectedAlbum"),
          store.get<number | null>("selectedTag"),
          store.get<QueueEntry | null>("currentTrackEntry"),
          store.get<number>("volume"),
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
          store.get<string | null>("lastDownloadDest"),
          store.get<{ tracks: ViewMode; albums: ViewMode; artists: ViewMode } | null>("searchViewModes"),
          store.get<Record<string, boolean> | boolean>("autoSaveStreams"),
          store.get<number | null>("downloadsCollectionId"),
          store.get<boolean>("minimizeToMiniPlayer"),
        ]));
        if (v && ["search", "artists", "albums", "tags", "history"].includes(v)) {
          // Entity views without a matching selection have no standalone list — redirect to search
          const entityViewNeedsSelection = (v === "artists" && !sa) || (v === "albums" && !sal) || (v === "tags" && !st);
          library.setView(entityViewNeedsSelection ? "search" : v as View);
        }
        if (sa !== undefined && sa !== null) {
          library.setSelectedArtist(sa);
        }
        if (sal !== undefined && sal !== null) library.setSelectedAlbum(sal);
        if (st !== undefined && st !== null) library.setSelectedTag(st);
        if (vol !== undefined && vol !== null) playback.setVolume(vol);
        if (cf !== undefined && cf !== null) setCrossfadeSecs(cf);
        if (savedTrackVideoHistory) setTrackVideoHistory(true);
        if (savedAutoSaveStreams && typeof savedAutoSaveStreams === "object") {
          setAutoSaveStreams(savedAutoSaveStreams);
        }
        if (savedDownloadsCollectionId != null) setDownloadsCollectionId(savedDownloadsCollectionId);
        if (savedMinimizeToMiniPlayer) setMinimizeToMiniPlayer(true);

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

        // Restore queue from main-playlist folder (replaces tauri-store queue keys)
        try {
          const [{ manifest, state: mpState }, dir] = await Promise.all([
            invoke<{ manifest: Manifest | null; state: MainPlaylistState | null }>("main_playlist_read"),
            invoke<string>("main_playlist_dir"),
          ]);
          if (manifest) {
            const tracks = tracksFromManifest(manifest, dir);
            const ctx = contextFromManifest(manifest, dir);
            if (tracks.length > 0) {
              const idx = mpState?.queueIndex != null && mpState.queueIndex >= 0 && mpState.queueIndex < tracks.length ? mpState.queueIndex : -1;
              pendingRestoreQueueRef.current = { tracks, index: idx };
              if (idx >= 0) {
                pendingRestoreTrackRef.current = tracks[idx];
              }
            }
            if (ctx) queueHook.setPlaylistContext(ctx);
          }
          if (mpState) {
            if (mpState.queueMode && ["normal", "loop", "shuffle"].includes(mpState.queueMode)) {
              queueHook.setQueueMode(mpState.queueMode);
            }
            queueHook.setShuffleOrder(mpState.shuffleOrder ?? []);
            queueHook.setShufflePosition(mpState.shufflePosition ?? 0);
          }
          // Fire-and-forget gc; not awaited so it never blocks startup.
          invoke("main_playlist_gc").catch(e => console.error("main_playlist_gc failed:", e));
        } catch (e) {
          console.error("Failed to restore main playlist:", e);
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
        if (savedLastDownloadDest !== undefined) setLastDownloadDest(savedLastDownloadDest ?? null);
        if (savedSearchViewModes) {
          const validModes = ["basic", "list", "tiles"];
          const s = savedSearchViewModes as { tracks: ViewMode; albums: ViewMode; artists: ViewMode; tags?: ViewMode };
          if (validModes.includes(s.tracks) && validModes.includes(s.albums) && validModes.includes(s.artists)) {
            setSearchViewModes({ tracks: s.tracks, albums: s.albums, artists: s.artists, tags: s.tags && validModes.includes(s.tags) ? s.tags : "tiles" });
          }
        }
        const savedLoggingEnabled = await store.get<boolean>("loggingEnabled");
        if (savedLoggingEnabled) setLoggingEnabled(true);
        const savedDebugLogging = await store.get<boolean>("debugLogging");
        if (savedDebugLogging) { setDebugLogging(true); setDebugLoggingRef(true); }
        const savedDebugMode = await store.get<boolean>("debugMode");
        if (savedDebugMode) setDebugMode(true);
        const savedSyncWithPlaying = await store.get<boolean | string>("syncWithPlaying");
        if (savedSyncWithPlaying === true || savedSyncWithPlaying === "enabled" || savedSyncWithPlaying === "active") setSyncWithPlaying(true);
        const savedFallbackTrack = await store.get<{ name: string; artistName?: string; albumTitle?: string } | null>("fallbackTrackName");
        if (savedFallbackTrack) {
          library.setFallbackTrackName(savedFallbackTrack);
        }

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
      await timeAsync("loadProviders", () => loadProviders(store).then(setSearchProviders)).catch(e => console.error("Failed to load providers:", e));
      restoredRef.current = true;
      setAppRestoring(false);
      await timeAsync("loadLibrary", () => library.loadLibrary());
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
    }
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
        setDetailTrack({
          id: null, key: queueTrack.key, path: queueTrack.path,
          title: queueTrack.title, artist_id: null, artist_name: queueTrack.artist_name,
          album_id: null, album_title: queueTrack.album_title, year: null,
          track_number: null, duration_secs: queueTrack.duration_secs,
          format: queueTrack.format, file_size: null, collection_id: null,
          collection_name: null, liked: queueTrack.liked ?? 0,
          youtube_url: null, added_at: null, modified_at: null,
          image_url: queueTrack.image_url,
        });
        if (queueTrack.album_title) {
          albumImageCache.getImage(queueTrack.album_title, queueTrack.artist_name);
        }
        if (queueTrack.artist_name) {
          artistImageCache.getImage(queueTrack.artist_name);
        }
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

  // Sync detail view with currently playing track when user is idle (no navigation for 3 min)

  // Navigate to current track's detail view on track change when sync is on
  useEffect(() => {
    if (!syncRef.current || !playback.currentTrack) return;
    const ct = playback.currentTrack;
    if (ct.key && ct.key !== library.selectedTrack) {
      library.handleTrackClick(ct.key);
    }
  }, [playback.currentTrack?.key]);

  const handleToggleSync = useCallback(() => {
    setSyncWithPlaying(prev => {
      const next = !prev;
      store.set("syncWithPlaying", next);
      return next;
    });
  }, []);

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

  // Ref for keyboard shortcut handler to avoid stale closures
  const shortcutStateRef = useRef({
    volume: playback.volume,
    getMediaElement: playback.getMediaElement,
    handleSeek: playback.handleSeek,
    handlePause: playback.handlePause,
    currentTrack: playback.currentTrack,
  });
  shortcutStateRef.current = {
    volume: playback.volume,
    getMediaElement: playback.getMediaElement,
    handleSeek: playback.handleSeek,
    handlePause: playback.handlePause,
    currentTrack: playback.currentTrack,
  };
  const handleToggleLikeRef = useRef((_track: QueueTrack) => {});

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const s = shortcutStateRef.current;
      const isInput = (e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA";

      if (e.key === "Escape" && library.selectedTrack !== null) {
        library.setSelectedTrack(null);
        return;
      }
      if (e.key === "Escape" && (library.fallbackArtistName || library.fallbackAlbumName || library.fallbackTrackName)) {
        goBackRef.current();
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
            s.handlePause();
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
      if (ac.enabled && track) {
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

  function handleDebugLoggingChange(enabled: boolean) {
    setDebugLogging(enabled);
    setDebugLoggingRef(enabled);
    store.set("debugLogging", enabled);
  }

  function handleDebugModeChange(enabled: boolean) {
    setDebugMode(enabled);
    store.set("debugMode", enabled);
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
    setAutoSaveStreams({});
    store.set("downloadsCollectionId", null);
    store.set("autoSaveStreams", {});
  };

  function handleAutoSaveStreamsChange(resolverId: string, enabled: boolean) {
    setAutoSaveStreams(prev => {
      const next = { ...prev, [resolverId]: enabled };
      store.set("autoSaveStreams", next);
      return next;
    });
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
    playTracks: queueHook.playTracks,
    playEntityAll: handlePlayEntityAll,
    playAlbum: playActions.playAlbum,
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
      if (kind === "artist") artistImageCache.requestFetch(name);
      else if (kind === "album") albumImageCache.requestFetch(name, artistName);
      else tagImageCache.requestFetch(name);
    },
    invokeInfoFetch: plugins.invokeInfoFetch,
    pluginNames: plugins.pluginNames,
    searchProviders,
  }), [
    library.handleArtistClick, library.handleAlbumClick, library.handleTagClick,
    queueHook.playTracks, handlePlayEntityAll, playActions.playAlbum,
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
    plugins.invokeInfoFetch, plugins.pluginNames, searchProviders,
  ]);

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
    <VideoFrameQueueProvider>
    <VideoFrameQueueRefBridge refOut={videoFrameQueueRef} />
    <div className={`app ${appRestoring ? "app-restoring" : ""} ${playback.currentTrack && isVideoTrack(playback.currentTrack) ? "video-mode" : ""} queue-open ${queueCollapsed ? "queue-collapsed" : ""} ${mini.miniMode ? "mini-mode" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} style={{ "--queue-width": `${queueWidth}px` } as React.CSSProperties}>
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
        onShowExtensions={() => {
          pushAndScroll();
          library.setView("extensions");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
        }}
        updateAvailable={updater.updateState.available !== null}
        extensionUpdateCount={extensionsHook.updateCount}
        pluginNavItems={plugins.sidebarItems}
        badgeMap={plugins.badgeMap}
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


      {deepLinkInstall && (
        <div className="ds-modal-overlay">
          <div className="ds-modal ds-modal--sm" onClick={(e) => e.stopPropagation()}>
            <div className="ds-modal-title">Install {deepLinkInstall.kind === "plugin" ? "Plugin" : "Skin"}</div>
            <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)", margin: "12px 0" }}>
              Install from <strong style={{ color: "var(--text-primary)", wordBreak: "break-all" }}>{deepLinkInstall.url}</strong>?
            </p>
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => setDeepLinkInstall(null)}>Cancel</button>
              <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={async () => {
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
              }}>Install</button>
            </div>
          </div>
        </div>
      )}

      {/* Caption bar - full width */}
      <CaptionBar
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onGoBack={goBack}
        onGoForward={goForward}
        centralSearch={centralSearch}
        searchInputRef={searchInputRef}
        getAlbumImage={albumImageCache.getImage}
        getArtistImage={artistImageCache.getImage}
        onToggleMiniMode={mini.toggleMiniMode}
        onToggleHelp={() => setShowHelp(h => !h)}
        resyncProgress={resyncProgress}
        resyncComplete={resyncComplete}
        onNavigateToCollections={() => {
          pushAndScroll();
          library.setView("collections");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
        }}
        minimizeToMiniPlayer={minimizeToMiniPlayer}
      />

      {/* Main content */}
      <main className={`main${library.selectedTrack !== null && playback.currentTrack?.key === library.selectedTrack && isVideoTrack(playback.currentTrack) ? " video-detail" : ""}`} data-dock={playback.currentTrack && isVideoTrack(playback.currentTrack) ? videoLayout.dockSide : undefined}>
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
                trackId={parseLibraryId(library.selectedTrack!)}
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
                onWatchOnYoutube={track.id != null ? () => contextMenuActions.watchOnYoutube(track.id!, track.title, track.artist_name, track.youtube_url) : undefined}
                onToggleLike={() => likeActions.handleToggleLike(track)}
                onToggleDislike={() => likeActions.handleToggleDislike(track)}
                onShowInFolder={async () => { const libId = parseLibraryId(library.selectedTrack!); if (libId == null) return; try { await invoke("show_in_folder", { trackId: libId }); } catch (e) { console.error("Failed to open containing folder:", e); contextMenuActions.setFolderError(String(e)); } }}
                onUpdateTrack={(update) => library.setTracks(prev => prev.map(t => t.id === library.selectedTrack ? { ...t, ...update } : t))}
                onTagsChanged={() => invoke<Tag[]>("get_tags").then(library.setTags).catch(console.error)}
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
              youtube_url: null,
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
                onWatchOnYoutube={syntheticTrack.artist_name ? () => contextMenuActions.watchOnYoutube(0, syntheticTrack.title, syntheticTrack.artist_name, null) : undefined}
                onToggleLike={() => {}}
                onToggleDislike={() => {}}
                onShowInFolder={() => {}}
                onUpdateTrack={() => {}}
                onTagsChanged={() => invoke<Tag[]>("get_tags").then(library.setTags).catch(console.error)}
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

          {/* Search view — always mounted to preserve state and scroll position */}
          <SearchView
            style={{ display: view === "search" ? undefined : "none" }}
            initialQuery={searchInitialQuery}
            initialQueryKey={searchQueryKey}
            deletedTrackIds={searchDeletedBatch.ids}
            deletedTrackKey={searchDeletedBatch.key}
            deletedTagIds={searchDeletedTagBatch.ids}
            deletedTagKey={searchDeletedTagBatch.key}
            currentTrack={playback.currentTrack}
            playing={playback.playing}
            viewModes={searchViewModes}
            onViewModesChange={handleSearchViewModesChange}
            getArtistImage={artistImageCache.getImage}
            getAlbumImage={albumImageCache.getImage}
            getTagImage={tagImageCache.getImage}
            onPlayTracks={queueHook.playTracks}
            onPlayAlbum={playActions.playAlbum}
            onPlayArtist={playActions.playArtist}
            onPlayTag={playActions.playTag}
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
            columns={library.trackColumns}
            onColumnsChange={library.setTrackColumns}
          />



          {/* History view */}
          {view === "history" && (
            <>
              <ViewSearchBar
                query={viewSearch.getQuery("history")}
                onQueryChange={(q) => viewSearch.setQuery("history", q)}
                placeholder="Search history..."
                {...historySearchNav}
              />
              <HistoryView ref={historyRef} searchQuery={viewSearch.getQuery("history")} highlightedIndex={highlightedListIndex} onPlayTrack={queueHook.playTracks} onEnqueueTrack={contextMenuActions.handleEnqueue} onArtistClick={library.handleArtistClick} />
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
                onExportAsMixtape={handleExportAsMixtapeDirect}
                pluginMenuItems={plugins.menuItems}
                onPluginAction={plugins.dispatchContextMenuAction}
              />
            </>
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
              downloadFormat={downloads.downloadFormat}
              onDownloadFormatChange={(format) => downloads.setFormat(format, store)}
              pluginStates={plugins.pluginStates}
              loggingEnabled={loggingEnabled}
              onLoggingEnabledChange={handleLoggingEnabledChange}
              debugLogging={debugLogging}
              onDebugLoggingChange={handleDebugLoggingChange}
              debugMode={debugMode}
              onDebugModeChange={handleDebugModeChange}
              onStreamResolverOrderChanged={() => setStreamResolverOrderVersion(v => v + 1)}
              downloadsCollection={downloadsCollection}
              streamResolvers={streamResolversMeta}
              autoSaveStreams={autoSaveStreams}
              onSetDownloadsFolder={handleSetDownloadsFolder}
              onUnsetDownloadsCollection={handleUnsetDownloadsCollection}
              onAutoSaveStreamsChange={handleAutoSaveStreamsChange}
              dependencies={dependencies}
            />
          )}
          </>}
          </DetailViewProvider>
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
            buildAndShowNativeMenu({ x: e.clientX, y: e.clientY, target: { kind: "video", dockSide: videoLayout.dockSide, fitMode: videoLayout.fitMode } });
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
            onToggleDislike={() => { if (playback.currentTrack) { likeActions.handleToggleDislike(playback.currentTrack); handleNext(); } }}
            onToggleFullscreen={playback.toggleFullscreen}
            showQueue={!queueCollapsed}
            onToggleQueue={handleToggleQueueCollapsed}
            onNavigateToArtistByName={library.navigateToArtistByName}
            onNavigateToAlbumByName={(name, artistName) => library.navigateToAlbumByName(name, artistName ?? undefined)}
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
          thumbVersions={queueHook.thumbVersions}
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



      {downloadModal && (() => {
        const parts = downloadModal.providerId.split(":");
        const qualityOptions = parts.length >= 2 ? plugins.invokeGetQualities(parts[0], parts.slice(1).join(":")) : null;
        return (
        <DownloadModal
          tracks={downloadModal.tracks}
          providerId={downloadModal.providerId}
          providerName={downloadModal.providerName}
          confirmed={downloadModal.confirmed}
          resolveByUri={downloadModal.resolveByUri}
          downloadFormat={downloads.downloadFormat}
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
              youtube_url: null,
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
          tracks={contextMenuActions.bulkEditTracks}
          onClose={() => contextMenuActions.setBulkEditTracks(null)}
          onSave={() => { contextMenuActions.setBulkEditTracks(null); library.loadLibrary(); library.loadTracks(); }}
        />
      )}

      {contextMenuActions.deleteConfirm && (
        <div className="ds-modal-overlay">
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="ds-modal-title">Move {contextMenuActions.deleteConfirm.title} to {trashLabel}?</h2>
            <p className="delete-confirm-warning">This will move the file{contextMenuActions.deleteConfirm.trackIds.length > 1 ? "s" : ""} to {trashLabel} and remove from library.</p>
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--ghost" onClick={() => contextMenuActions.setDeleteConfirm(null)}>Cancel</button>
              <button className="ds-btn ds-btn--danger" onClick={contextMenuActions.handleDeleteConfirm} autoFocus>Move to {trashLabel}</button>
            </div>
          </div>
        </div>
      )}

      {deleteTagConfirm && (
        <div className="ds-modal-overlay">
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="ds-modal-title">
              {deleteTagConfirm.length === 1
                ? `Delete tag "${deleteTagConfirm[0].name}"?`
                : `Delete ${deleteTagConfirm.length} tags?`}
            </h2>
            <p className="delete-confirm-warning">
              {deleteTagConfirm.length === 1
                ? "This will remove the tag from all tracks. The tracks themselves will not be deleted."
                : "This will remove these tags from all tracks. The tracks themselves will not be deleted."}
            </p>
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--ghost" onClick={() => setDeleteTagConfirm(null)}>Cancel</button>
              <button className="ds-btn ds-btn--danger" onClick={async () => {
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
              }} autoFocus>Delete</button>
            </div>
          </div>
        </div>
      )}

      {contextMenuActions.deleteError && (
        <div className="ds-modal-overlay">
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="ds-modal-title">Delete Failed</h2>
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
        <div className="ds-modal-overlay">
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="ds-modal-title">Open Containing Folder</h2>
            <p className="delete-confirm-warning">{contextMenuActions.folderError}</p>
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--ghost" onClick={() => contextMenuActions.setFolderError(null)}>OK</button>
            </div>
          </div>
        </div>
      )}

      {contextMenuActions.downloadConfirm && (
        <div className="ds-modal-overlay">
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="ds-modal-title">Already Downloaded</h2>
            <p className="delete-confirm-warning">
              "{contextMenuActions.downloadConfirm.localTitle}" already exists in your local library. Download again?
            </p>
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--ghost" onClick={contextMenuActions.handleDownloadConfirmDismiss}>Cancel</button>
              <button className="ds-btn ds-btn--secondary" onClick={() => {
                invoke("show_in_folder", { trackId: contextMenuActions.downloadConfirm!.localTrackId }).catch(console.error);
                contextMenuActions.handleDownloadConfirmDismiss();
              }}>Show in Folder</button>
              <button className="ds-btn ds-btn--primary" onClick={contextMenuActions.handleDownloadConfirm} autoFocus>Download</button>
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
        <div className="ds-modal-overlay">
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="ds-modal-title">Remove &ldquo;{collectionActions.removeCollectionConfirm.name}&rdquo;?</h2>
            <p className="delete-confirm-warning">This will permanently remove this collection and all its tracks from the library.</p>
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--ghost" onClick={() => collectionActions.setRemoveCollectionConfirm(null)}>Cancel</button>
              <button className="ds-btn ds-btn--danger" onClick={collectionActions.handleRemoveCollectionConfirm}>Remove</button>
            </div>
          </div>
        </div>
      )}

      {playback.playbackError && !mini.miniMode && (
        <PlaybackErrorModal
          error={playback.playbackError}
          trackTitle={playback.failedTrack?.title ?? null}
          onDismiss={playback.clearPlaybackError}
          onSkip={() => { playback.clearPlaybackError(); handleNext(); }}
        />
      )}

      {dependencies.modalState && (
        <DependencyModal
          dep={dependencies.modalState.dep}
          feature={dependencies.modalState.feature}
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
          downloadFormat={downloads.downloadFormat}
          onClose={() => setMixtapeExportTracks(null)}
        />
      )}

      {navError && (
        <div className="ds-modal-overlay">
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="ds-modal-title">Navigation Error</h2>
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
        onToggleDislike={() => { if (playback.currentTrack) { likeActions.handleToggleDislike(playback.currentTrack); handleNext(); } }}
        onTrackClick={(trackId) => { library.handleTrackClick(trackId); }}
        onNavigateToArtistByName={library.navigateToArtistByName}
        onNavigateToAlbumByName={library.navigateToAlbumByName}
        syncState={syncWithPlaying}
        onToggleSync={handleToggleSync}
        showHelp={showHelp}
        onToggleHelp={() => setShowHelp(h => !h)}
        resolvingStatus={resolvingStatus}
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
        onDownloadTrack={playback.currentTrack ? async () => {
          const track = playback.currentTrack!;
          const trackUri = track.path ?? "";
          const trackPayload = {
            title: track.title,
            artistName: track.artist_name ?? null,
            albumTitle: track.album_title ?? null,
            uri: track.path ?? null,
            durationSecs: track.duration_secs ?? null,
            trackId: parseLibraryId(track.key),
          };

          // If playing via a fallback stream resolver (e.g. YouTube), prefer that
          // plugin's download provider over the original scheme's provider
          const resolverPluginId = resolvedSource?.id?.split(":")[0] ?? null;
          const resolverDownloadProvider = resolverPluginId
            ? downloadProviders.find(p => p.source === resolverPluginId)
            : null;

          // Direct URI resolution: for remote schemes, skip interactive search
          if (isRemoteScheme(trackUri) && !resolverDownloadProvider) {
            const scheme = trackUri.substring(0, trackUri.indexOf("://"));
            const directProvider = scheme === "subsonic"
              ? downloadProviders.find(p => p.id === "__builtin:subsonic")
              : downloadProviders.find(p => p.source !== "__builtin");
            if (directProvider) {
              setDownloadModal({
                tracks: [trackPayload],
                providerId: directProvider.id,
                providerName: directProvider.name,
                resolveByUri: directProvider.resolveByUri,
              });
              return;
            }
          }

          // If playing via a fallback resolver that has a download provider,
          // use its resolveByMetadata (which checks cache before re-downloading)
          if (resolverDownloadProvider) {
            setDownloadModal({
              tracks: [trackPayload],
              providerId: resolverDownloadProvider.id,
              providerName: resolverDownloadProvider.name,
              resolveByUri: (_uri, format) =>
                resolverDownloadProvider.resolveByMetadata(
                  track.title, track.artist_name ?? null, track.album_title ?? null,
                  track.duration_secs ?? null, format,
                ),
            });
            return;
          }

          // Fallback: interactive search via plugin providers
          let entries = downloadProviderEntries;
          try {
            const rows = await invoke<[string, string, string, number][]>("get_active_download_providers");
            const freshPriorities = new Map<string, number>();
            for (const [pid, provId, , prio] of rows) freshPriorities.set(`${pid}:${provId}`, prio);
            setProviderPriorities(freshPriorities);
            entries = downloadProviders
              .filter(p => p.source !== "__builtin")
              .map(p => {
                const parts = p.id.split(":");
                return {
                  id: p.id,
                  name: p.name,
                  priority: freshPriorities.get(p.id) ?? Number.MAX_SAFE_INTEGER,
                  interactive: plugins.hasInteractiveDownload(parts[0], parts.slice(1).join(":")),
                };
              })
              .sort((a, b) => a.priority - b.priority);
          } catch (e) {
            console.error("Failed to load download provider priorities:", e);
          }
          const provider = entries.find(e => e.interactive) ?? entries[0];
          if (!provider) {
            contextMenuActions.handleDownloadTrack(track);
            return;
          }
          setDownloadModal({
            tracks: [trackPayload],
            providerId: provider.id,
            providerName: provider.name,
          });
        } : undefined}
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


    </div>
    </VideoFrameQueueProvider>
  );
}

export default App;
