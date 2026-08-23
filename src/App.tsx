import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { exit } from "@tauri-apps/plugin-process";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrent as getDeepLinkCurrent } from "@tauri-apps/plugin-deep-link";
import { subscribe, combineUnlisten, safeUnlisten } from "./utils/tauriEvents";
import "./base.css";
import "./design-system.css";
import "./App.css";

import type { Track, QueueTrack, ViewMode, ColumnConfig, SortField, SortDir, Collection, ResolvedTrackSource, Album, Artist, Tag } from "./types";
import { isVideoTrack, parseSubsonicUrl, trashLabel } from "./utils";
import { parseLrc, syncedLyricsFitMedia, lyricOffsetKey, clampLyricOffset } from "./utils/lyrics";

import { store } from "./store";
import { readPersistedSettings } from "./startup/readPersistedSettings";
import { parseUrlScheme, trackToQueueEntry, nextExternalKey, parseLibraryId, isLocalTrack, effectiveLocalPath, pluginTrackToQueueTrack } from "./queueEntry";
import { partitionTrackIds, buildDeleteConfirmPayload } from "./utils/deleteTracks";
import { fetchLikeStates, applyLikeState, applyLikeStates, trackLikeId } from "./utils/likeReconcile";
import { subscribeTrackEvents } from "./trackEvents";
import { track as trackTelemetry, setTelemetryEnabled as syncTelemetryEnabled, bucketCount, sourceClass } from "./telemetry";
import { tracksFromManifest, contextFromManifest, contextToExportMetadata, contextFromMixtapeMetadata, type Manifest, type MainPlaylistState } from "./mainPlaylist";
import { recordVisit, type RecentlyVisitedEntry } from "./utils/recentlyVisited";
import { collectionAlert } from "./utils/collectionAlert";
import { buildPlaySession, recordPlaySession, type RecentPlaySession } from "./utils/recentPlays";
import { resolveImageUrl, resolveImageSrc, stripImageVersion } from "./utils/resolveImageUrl";
import { resolveNowPlayingArt } from "./utils/nowPlayingArt";
import { pickEntityImagePath } from "./utils/trackImage";
import { buildTagSuggestionPool } from "./utils/tagSuggestions";
import { resolveShelfPlayAction } from "./utils/homeShelfPlay";
import { builtinQualityOptions } from "./utils/builtinDownloadQualities";
import { buildPluginOverflowItems } from "./utils/heroOverflow";
import { applyReduceMotionAttr } from "./utils/reducedMotion";
import { type StreamResolver, stripRemasterSuffix } from "./streamResolvers";
import { BUILTIN_PRESETS, presetForGains } from "./eqPresets";
import { timeAsync, getTimingEntries, type TimingEntry } from "./startupTiming";

import { usePlayback } from "./hooks/usePlayback";
import { probeEngineCapabilities, nativeEngine, type EngineCapabilities } from "./playback/nativeEngine";
import { useEngineComponent } from "./hooks/useEngineComponent";
import { isFormatPlaybackError } from "./playback/playbackErrors";
import { getPlaybackPosition, subscribePlaybackPosition } from "./playback/positionStore";
import { useStreamResolution } from "./hooks/useStreamResolution";
import { useDownloadOrchestration } from "./hooks/useDownloadOrchestration";
import { decideDownload } from "./utils/downloadPlan";
import { useQueue } from "./hooks/useQueue";
import type { PlaylistContext } from "./hooks/useQueue";
import { usePlayActions } from "./hooks/usePlayActions";
import type { BackfillPlay } from "./hooks/usePlayActions";
import { useToasts } from "./hooks/useToasts";
import { useProfileSwitch } from "./hooks/useProfileSwitch";
import ProfileSwitchOverlay from "./components/ProfileSwitchOverlay";
import { Toasts } from "./components/Toasts";
import { useLibrary, DEFAULT_TRACK_COLUMNS } from "./hooks/useLibrary";
import { useEventListeners } from "./hooks/useEventListeners";
import { useFileDrop } from "./hooks/useFileDrop";
import { useImageCache } from "./hooks/useImageCache";
import { useAutoContinue } from "./hooks/useAutoContinue";
import { usePasteImage } from "./hooks/usePasteImage";
import { useNavigationHistory, type NavState } from "./hooks/useNavigationHistory";
import { useAppUpdater, updateBadgeFor } from "./hooks/useAppUpdater";
import { useMiniMode, cycleRestingSize, cycleMiniWidth } from "./hooks/useMiniMode";
import { useStableCallbacks } from "./hooks/useStableCallbacks";
import { usePersistedSetting, usePersistMirror } from "./hooks/usePersistedSetting";
import { useUiZoom } from "./hooks/useUiZoom";
import { applyWebviewZoom, stepZoomPreset } from "./utils/zoom";
import { useVideoLayout } from "./hooks/useVideoLayout";
import { useWaveform } from "./hooks/useWaveform";
import { useStoryboard } from "./hooks/useStoryboard";
import { partialStoryboard } from "./utils/storyboard";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useInAppKeyboardShortcuts } from "./hooks/useInAppKeyboardShortcuts";
import { useSkins } from "./hooks/useSkins";
import { usePlugins, type PluginHostCallbacks } from "./hooks/usePlugins";
import { useNowPlayingInfo } from "./hooks/useNowPlayingInfo";
import { useImageResolver } from "./hooks/useImageResolver";
import { useRetrieveModal } from "./hooks/useRetrieveModal";
import { RetrieveModal } from "./components/RetrieveModal";
import { useExtensions } from "./hooks/useExtensions";

import { useLikeActions } from "./hooks/useLikeActions";
import { useCollectionActions } from "./hooks/useCollectionActions";
import { useContextMenuActions } from "./hooks/useContextMenuActions";
import type { PluginTrack, PluginBadge, PluginPlayContext } from "./types/plugin";
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
import type { EqControls } from "./components/EqButton";
import { QueuePanel } from "./components/QueuePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import ExtensionsView, { type PluginViewMode } from "./components/ExtensionsView";
import { FullscreenControls } from "./components/FullscreenControls";
import { VideoAmbientOverlay } from "./components/VideoAmbientOverlay";
import { VideoSubtitles } from "./components/VideoSubtitles";
import { AddServerModal } from "./components/AddServerModal";
import { showNativeMenu, type MenuItemSpec } from "./nativeMenu";
import { buildPluginMenuSpecs } from "./contextMenu/pluginMenuGroups";
import { toPluginTarget } from "./types/contextMenu";
import { buildContextMenuSpecs } from "./contextMenu/buildContextMenuSpecs";
import { ArtistDetail } from "./components/ArtistDetail";
import { AlbumDetail } from "./components/AlbumDetail";
import { TagDetail } from "./components/TagDetail";
import { HistoryView } from "./components/HistoryView";
import type { HistoryViewHandle } from "./components/HistoryView";
import { PlaylistsView } from "./components/PlaylistsView";
import { SavePlaylistModal } from "./components/SavePlaylistModal";
import { EditTrackMetadataModal, buildTrackInfoEntries, type TrackInfoEntry } from "./components/EditTrackMetadataModal";
import { CollectionsView } from "./components/CollectionsView";
import { EditCollectionModal } from "./components/EditCollectionModal";
import {
  DeleteTracksModal,
  DeleteTagsModal,
  DeleteErrorModal,
  FolderErrorModal,
  RemoveCollectionModal,
  NavErrorModal,
  PluginLoadingModal,
  DeepLinkInstallModal,
  AddMusicSourceModal,
} from "./components/modals/ConfirmModals";
import { AlertModal } from "./components/AlertModal";
import { PluginViewRenderer } from "./components/PluginViewRenderer";
import { VisualizerSlot } from "./components/VisualizerSlot";
import { AudioFullscreen } from "./components/AudioFullscreen";
import {
  buildVisualizerMenuSpecs,
  candidatesFor,
  resolveFullscreenSlot,
  resolveSlot,
  visualizerKey,
  type VisualizerSlotSelection,
} from "./utils/visualizerSlots";
import type { PluginVisualizerPlacement } from "./types/pluginVisualizer";
import { TrackDetailView } from "./components/TrackDetailView";
import { DownloadModal } from "./components/DownloadModal";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { onboardingDecision, normalizeProfile, type OnboardingProfile } from "./components/onboardingSteps";
import BulkEditModal, { type BulkEditResult } from "./components/BulkEditModal";
import PlaybackErrorModal from "./components/PlaybackErrorModal";
import { PromptModal } from "./components/PromptModal";
import { PublishSourceModal } from "./components/PublishSourceModal";
import { MixtapePreviewModal } from "./components/MixtapePreviewModal";
import { MixtapeExportModal } from "./components/MixtapeExportModal";
import type { ExportTrack } from "./components/MixtapeExportModal";

import { SearchView } from "./components/SearchView";
import { HomeView } from "./components/HomeView";
import { FreezeWhileHidden } from "./components/FreezeWhileHidden";
import { NowPlayingView } from "./components/NowPlayingView";
import { MusicQuizView } from "./components/MusicQuizView";
import { useLyrics } from "./hooks/useLyrics";
import type { ResolvedShelf } from "./hooks/useHome";
import { LATEST_PLAY_SHELF_ID } from "./hooks/useHome";
import type { HomeShelfItem } from "./types/plugin";
import { useDependencies } from "./hooks/useDependencies";
import { DependencyModal } from "./components/DependencyModal";
import ReportProblemModal from "./components/ReportProblemModal";
import type { DiagnosticContext, DiagnosticSources } from "./utils/diagnosticReport";
import { recordAppError } from "./utils/errorLog";
import { classifyErrorKind, errorText } from "./utils/errorKind";


import { useAssignRef } from "./hooks/useLatestRef";
function VideoFrameQueueRefBridge({ refOut }: { refOut: React.MutableRefObject<VideoFrameQueue | null> }) {
  const queue = useVideoFrameQueue();
  useEffect(() => { refOut.current = queue; }, [queue, refOut]);
  return null;
}

// Resolve a default cover from a track list when no playlist context / saved
// image supplies one (mixtape share, Save as Playlist): the first track's
// album image, then artist image, then any explicit per-track image_url.
// Mirrors the queue thumbnail chain (album -> artist), all name-based via the
// entity-image cache. Always returns a local filesystem path (or null) — the
// mixtape and playlist backends read the cover from disk, so a remote
// image_url is downloaded into playlist_images first.
async function resolveFirstAlbumCover(
  tracks: Array<{ album_title?: string | null; artist_name?: string | null; image_url?: string | null }>,
): Promise<string | null> {
  const first = tracks.find(t => t.album_title || t.artist_name || t.image_url);
  if (!first) return null;
  try {
    if (first.album_title) {
      const albumImg = await invoke<string | null>("get_entity_image", {
        kind: "album",
        name: first.album_title,
        artistName: first.artist_name ?? null,
      });
      if (albumImg) return albumImg;
    }
    if (first.artist_name) {
      const artistImg = await invoke<string | null>("get_entity_image", {
        kind: "artist",
        name: first.artist_name,
        artistName: null,
      });
      if (artistImg) return artistImg;
    }
  } catch (err) {
    console.error("Failed to resolve default cover:", err);
  }
  const raw = stripImageVersion(first.image_url ?? null);
  if (!raw || raw.startsWith("data:")) return null;
  const local = raw.startsWith("file://") ? raw.substring(7) : raw;
  if (local.startsWith("http://") || local.startsWith("https://")) {
    try {
      return await invoke<string>("download_url_to_playlist_images", { url: local });
    } catch (err) {
      console.error("Failed to download first-track cover:", err);
      return null;
    }
  }
  return local;
}

function App() {
  const restoredRef = useRef(false);
  const handleEnqueueRef = useRef<(tracks: Track[]) => void>(() => {});
  // Late-bound so the plugin playback bridge (built above playActions) can reach
  // the canonical backfill action. Resolves with the tracks actually appended.
  const playWithBackfillRef = useRef<(opts: BackfillPlay) => Promise<QueueTrack[]>>(() => Promise.resolve([]));
  const videoFrameQueueRef = useRef<VideoFrameQueue | null>(null);
  const [appRestoring, setAppRestoring] = useState(true);
  const [navError, setNavError] = useState<string | null>(null);
  const [showSavePlaylistModal, setShowSavePlaylistModal] = useState(false);
  const [savePlaylistDefaultCover, setSavePlaylistDefaultCover] = useState<string | null>(null);
  const [editQueueTrack, setEditQueueTrack] = useState<{ index: number; title: string; artist: string; album: string; info: TrackInfoEntry[] } | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingProfile, setOnboardingProfile] = useState<OnboardingProfile>("normal");
  const [pluginLoadingMessage, setPluginLoadingMessage] = useState<string | null>(null);
  const pendingRestoreTrackRef = useRef<QueueTrack | null>(null);
  const pendingRestoreQueueRef = useRef<{ tracks: QueueTrack[]; index: number } | null>(null);
  // Cached-thumb pairs (`[uri, filename]`) from main_playlist_read, seeded into
  // thumbInfo when the deferred queue is applied so rows paint art immediately.
  const pendingRestoreThumbsRef = useRef<Array<[string, string]>>([]);
  // "Latest play" ring buffer (things that replaced the queue). Mirrors
  // recentlyVisitedRef: loaded from the store on mount, written on each play.
  const recentPlaysRef = useRef<RecentPlaySession[]>([]);
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
  useAssignRef(crossfadeSecsRef, crossfadeSecs);
  // Native (mpv) playback engine: capability is a build fact (probed once via
  // engine_capabilities), the choice is a persisted setting. usePlayback routes
  // per-track through the combined ref.
  const [mpvCapable, setMpvCapable] = useState(false);
  const [mpvVideoCapable, setMpvVideoCapable] = useState(false);
  // Gates the see-through hole opaque until bounds have settled (this timer,
  // set in the bounds effect) — covers resize / enter-now-playing. The
  // className ANDs this with `playback.nativeVideoPresenting` (first frame
  // actually on screen) so a fresh start also stays opaque until mpv is
  // painting, not just until the settle timer elapses. See `.mpv-video-ready`.
  const [videoReady, setVideoReady] = useState(false);
  // mpv is the primary engine — default to native, gated by `mpvCapable` below
  // (falls back to the browser engine when libmpv can't be loaded, and per-track
  // on any engine-error). An explicit user choice is restored on startup.
  const [playbackEngine, setPlaybackEngine] = useState<"browser" | "native">("native");
  const [audioExclusive, setAudioExclusive] = usePersistedSetting("audioExclusive", false, restoredRef);
  // Update channel: default stable-only; beta is an explicit opt-in.
  const [betaUpdates, setBetaUpdates] = usePersistedSetting("betaUpdates", false, restoredRef);
  // Anonymous usage telemetry: default on (opt-out). See telemetry.ts.
  const [telemetryEnabled, setTelemetryEnabled] = usePersistedSetting("telemetryEnabled", true, restoredRef);
  const useNativeEngineRef = useRef(false);
  useAssignRef(useNativeEngineRef, mpvCapable && playbackEngine === "native");
  const useNativeVideoRef = useRef(false);
  useAssignRef(useNativeVideoRef, mpvCapable && mpvVideoCapable && playbackEngine === "native");
  // Assigned to `() => handleNext("auto")` once handleNext exists below.
  const nativeEndedRef = useRef<() => void>(() => {});
  // False only until the first probe answers. libmpv ships bundled in every
  // release, so `mpvCapable === false` means one of two very different things:
  // "we haven't looked yet" or "it's here and it wouldn't load". Settings says
  // something different for each, and the probe is raced against a 5s timeout
  // in the restore effect — long enough to render the wrong one.
  const [mpvProbed, setMpvProbed] = useState(false);
  const applyEngineCapabilities = useCallback((caps: EngineCapabilities) => {
    setMpvCapable(caps.mpv);
    setMpvVideoCapable(caps.video);
    setMpvProbed(true);
  }, []);
  // The probe itself is kicked off inside the restore effect below (in
  // parallel with the rest of restore, awaited right before appRestoring
  // flips false) — see the comment there for why.
  // Downloadable libmpv component (Settings > Playback); re-probes
  // capabilities after install so the native engine unlocks live.
  const engineComponent = useEngineComponent(applyEngineCapabilities);
  // Track a format-failed file to replay once the mpv engine is enabled from
  // the Playback Failed modal (the retry effect below fires when it's ready).
  const pendingMpvRetryRef = useRef<QueueTrack | null>(null);
  const trackVideoHistoryRef = useRef(true);
  const [trackVideoHistory, setTrackVideoHistory] = usePersistedSetting("trackVideoHistory", true, restoredRef);
  // "Prefer video" is an advisory hint passed to every stream resolver in normal
  // order: a resolver that understands it (e.g. yt-dlp) returns a video stream
  // and flags the result `video`, which the host then routes to the theater;
  // resolvers that ignore it (Library, Subsonic, …) play whatever they normally
  // would. Read via a ref inside the resolver wrapper so it stays fresh.
  const preferVideoRef = useRef(false);
  const [preferVideoResolution, setPreferVideoResolution] = usePersistedSetting("preferVideoResolution", false, restoredRef);
  // Show synced lyrics as subtitles over video (persisted; default on). One
  // shared toggle drives all three video surfaces — the docked preview, the Now
  // Playing theater, and fullscreen. The store key stays the legacy
  // `videoLyricsOverlay` so existing saved preferences carry over.
  const [videoSubtitlesOn, setVideoSubtitlesOn] = usePersistedSetting("videoLyricsOverlay", true, restoredRef);
  const handleToggleSubtitles = useCallback(() => {
    setVideoSubtitlesOn((on) => !on); // persistence: usePersistedSetting
  }, []);
  const [loggingEnabled, setLoggingEnabled] = usePersistedSetting("loggingEnabled", false, restoredRef);
  // Default ON — stale yt-dlp breaks against YouTube and the failure looks
  // like an app bug to users. See MANAGED-DEPENDENCIES-PLAN.md.
  const [autoUpdateManagedDeps, setAutoUpdateManagedDeps] = usePersistedSetting("autoUpdateManagedDeps", true, restoredRef);
  const [minimizeToMiniPlayer, setMinimizeToMiniPlayer] = usePersistedSetting("minimizeToMiniPlayer", false, restoredRef);
  const [confirmTrashDelete, setConfirmTrashDelete] = usePersistedSetting("confirmTrashDelete", true, restoredRef);
  const [reduceMotion, setReduceMotion] = usePersistedSetting("reduceMotion", false, restoredRef);
  const [eqCustomPresets, setEqCustomPresets] = usePersistedSetting<{ id: string; name: string; gains: number[] }[]>("eqCustomPresets", [], restoredRef);
  const [eqShowBarControlSimple, setEqShowBarControlSimple] = usePersistedSetting("eqShowBarControlSimple", true, restoredRef);
  const [eqShowBarControlAdvanced, setEqShowBarControlAdvanced] = usePersistedSetting("eqShowBarControlAdvanced", false, restoredRef);
  const [eqSaveAsOpen, setEqSaveAsOpen] = useState(false);
  const [debugLogging, setDebugLogging] = usePersistedSetting("debugLogging", false, restoredRef);
  const [debugMode, setDebugMode] = usePersistedSetting("debugMode", false, restoredRef);
  const [devPluginPath, setDevPluginPath] = usePersistedSetting<string | null>("devPluginPath", null, restoredRef);
  const [lastDownloadDest, setLastDownloadDest] = useState<string | null>(null);
  const [mainPlaylistDir, setMainPlaylistDir] = useState<string | null>(null);
  useAssignRef(trackVideoHistoryRef, trackVideoHistory);
  useAssignRef(preferVideoRef, preferVideoResolution);
  const advanceIndexRef = useRef<() => void>(() => {});
  const resolveStreamByUriRef = useRef<(scheme: string, id: string, quality?: string | null, opts?: { externalAudio?: boolean }) => Promise<{ url: string; candidates?: import("./types/plugin").StreamCandidate[]; sourceUrl?: string }>>(
    async () => { throw new Error("Stream URI resolver not ready"); }
  );
  // Placeholder resolver: replaced by useStreamResolution's chain (which runs the
  // candidate selector) once plugins load. This bare form is only the pre-mount
  // fallback, so it uses the normalized self-contained URL, not the candidate menu.
  const resolveTrackSrcRef = useRef<(track: QueueTrack, opts?: { preload?: boolean }) => Promise<ResolvedTrackSource>>(async (track) => {
    const url = track.path;
    if (!url) throw new Error("Track has no URL");
    const parsed = parseUrlScheme(url);
    if (parsed.scheme === "file") return { src: convertFileSrc(parsed.path), engineSource: { kind: "file", path: parsed.path } };
    if (parsed.scheme === "plugin") {
      const { url: resolved } = await resolveStreamByUriRef.current(parsed.protocol, parsed.id, null);
      if (resolved.startsWith("file://")) return { src: convertFileSrc(resolved.substring(7)), engineSource: { kind: "file", path: resolved.substring(7) } };
      return { src: resolved, engineSource: resolved.startsWith("http") ? { kind: "http", url: resolved } : null };
    }
    if (parsed.scheme === "external") throw new Error("Cannot play external track directly — requires stream resolver");
    const streamUrl = await invoke<string>("resolve_subsonic_location", { location: parsed.url });
    return { src: streamUrl, engineSource: { kind: "http", url: streamUrl } };
  });
  const streamResolversRef = useRef<StreamResolver[]>([]);
  const [streamResolverOrderVersion, setStreamResolverOrderVersion] = useState(0);
  const transcodeSessionRef = useRef<{ sessionId: string; baseUrl: string; durationSecs: number | null; seekOffset: number } | null>(null);
  const playback = usePlayback(restoredRef, peekNextRef, crossfadeSecsRef, advanceIndexRef, trackVideoHistoryRef, resolveTrackSrcRef, prefetchNextRef, transcodeSessionRef, useNativeEngineRef, useNativeVideoRef, nativeEndedRef);
  const waveformPeaks = useWaveform(
    playback.currentTrack?.path ?? null,
    playback.currentTrack?.title ?? null,
    playback.currentTrack?.artist_name ?? null,
    playback.currentTrack?.duration_secs ?? null,
    playback.currentTrack ? isVideoTrack(playback.currentTrack) : false,
    playback.currentAssetUrl,
  );

  const [trackRank, setTrackRank] = useState<number | null>(null);
  const [artistRank, setArtistRank] = useState<number | null>(null);
  // Which Now Playing info items the user has enabled in the cycling section
  // (mini player + main bar). Empty default → only the combined "Artist · Album"
  // item shows, so the line looks exactly like before until customized.
  const [nowPlayingInfoSelection, setNowPlayingInfoSelection] = usePersistedSetting<Record<string, boolean>>("nowPlayingInfoSelection", {}, restoredRef);
  // Per-item time-of-persistence multipliers (id → 0/1/2/5/10). Missing = 1, so
  // an un-customized item dwells for the base interval, exactly as before.
  const [nowPlayingInfoPersistence, setNowPlayingInfoPersistence] = usePersistedSetting<Record<string, number>>("nowPlayingInfoPersistence", {}, restoredRef);
  // User priority order (ordered item ids) for the same section. Empty default →
  // registration order (built-ins as declared, then plugin items).
  const [nowPlayingInfoOrder, setNowPlayingInfoOrder] = usePersistedSetting<string[]>("nowPlayingInfoOrder", [], restoredRef);
  // One-shot deep link into a Settings section (element id), consumed by
  // SettingsPanel on mount and cleared once it has scrolled.
  const [settingsScrollTarget, setSettingsScrollTarget] = useState<string | null>(null);

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

  // Which plugin visualizer fills each host-owned slot, keyed by placement.
  // A stale entry (plugin disabled/uninstalled) is deliberately kept rather
  // than pruned — resolveSlot renders the slot empty, and the choice comes back
  // if the plugin returns. See utils/visualizerSlots.ts.
  const [visualizerSlots, setVisualizerSlots] = usePersistedSetting<VisualizerSlotSelection>("visualizerSlots", {}, restoredRef);


  // The user collapsed the Now Playing lyrics column. Persisted because it is a
  // standing preference about how that view is laid out ("I want the visual, not
  // the words"), not a per-track state — re-deciding it every launch would be
  // the annoying half of a toggle.
  const [nowPlayingLyricsHidden, setNowPlayingLyricsHidden] = usePersistedSetting("nowPlayingLyricsHidden", false, restoredRef);
  // Lyrics timing offsets, per track, keyed by metadata (`lyricOffsetKey`).
  // Persisted rather than session-scoped: fetched LRC is timed against the audio
  // release, so a music video is out by its intro EVERY time it plays — making
  // the user re-dial it on each play would be the actual bug. Keyed by metadata
  // for the same reason likes are: a QueueTrack has no DB id, and the same
  // recording should keep its offset whichever source served it.
  const [lyricsOffsets, setLyricsOffsets] = usePersistedSetting<Record<string, number>>("lyricsOffsets", {}, restoredRef);

  // The current track's offset, and the setter that stores it. Declared here
  // (rather than beside the other now-playing derivations further down) because
  // `useNowPlayingInfo` needs it — the mini player's synced line must resolve to
  // the same lyric the Now Playing view is showing.
  const lyricsOffsetSecs = useMemo(() => {
    const t = playback.currentTrack;
    if (!t) return 0;
    return clampLyricOffset(lyricsOffsets[lyricOffsetKey(t)] ?? 0);
  }, [playback.currentTrack, lyricsOffsets]);

  // Zero is pruned rather than stored: a reset should leave no trace, or the
  // record accumulates a no-op entry for every track anyone ever nudged and
  // undid, forever.
  const handleLyricsOffsetChange = useCallback((secs: number) => {
    const t = playback.currentTrack;
    if (!t) return;
    const key = lyricOffsetKey(t);
    const value = clampLyricOffset(secs);
    setLyricsOffsets((prev) => {
      if (value === 0) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (prev[key] === value) return prev;
      return { ...prev, [key]: value };
    });
  }, [playback.currentTrack, setLyricsOffsets]);


  // Fullscreen visualizer. Transient by design — landing back in fullscreen on
  // launch with no way to have anticipated it would be hostile.
  const [audioFullscreen, setAudioFullscreen] = useState(false);


  const beforeNavRef = useRef<() => void>(() => {});
  const viewSearch = useViewSearchState();

  const debugLoggingRef = useRef(false);
  const setDebugLoggingRef = useCallback((enabled: boolean) => {
    debugLoggingRef.current = enabled;
  }, []);
  const albumImageCache = useImageCache("album");

  const library = useLibrary(restoredRef, () => beforeNavRef.current(), viewSearch.getDebouncedQuery, undefined, setNavError);

  const queueHook = useQueue(restoredRef, playback.handlePlay, (tracks, startIndex, context) => {
    // Record the "Latest play" session for anything that replaces the queue.
    // Guarded so the startup queue-restore doesn't masquerade as a fresh play.
    if (!restoredRef.current) return;
    const session = buildPlaySession(tracks, startIndex, context, Date.now());
    if (!session) return;
    const next = recordPlaySession(recentPlaysRef.current, session);
    recentPlaysRef.current = next;
    store.set("recentPlaySessions", next).catch((e) => console.error("Failed to persist recentPlaySessions:", e));
  });
  const autoContinue = useAutoContinue(restoredRef);
  const zoom = useUiZoom();
  const mini = useMiniMode(restoredRef, zoom.uiZoomRef, zoom.miniZoomRef);
  const videoLayout = useVideoLayout(restoredRef);

  // Plugin system
  const pluginTrackRef = useRef<QueueTrack | null>(null);
  useAssignRef(pluginTrackRef, playback.currentTrack);
  const pluginPlayingRef = useRef(false);
  useAssignRef(pluginPlayingRef, playback.playing);
  const pluginPositionRef = useRef(0);
  // Position lives in the external positionStore (not React state), so the
  // plugin-facing ref is kept fresh by subscription instead of per-render.
  useEffect(() => subscribePlaybackPosition(() => {
    pluginPositionRef.current = getPlaybackPosition();
  }), []);
  // Live queue for plugins that render the queue itself (the vinyl deck presses
  // it to a record). Mirrored into a ref per render like the three above, and
  // announced via one `queue:changed` event so a plugin can re-push its view
  // without polling.
  const pluginQueueRef = useRef<{ tracks: QueueTrack[]; index: number }>({ tracks: [], index: 0 });
  useAssignRef(pluginQueueRef, { tracks: queueHook.queue, index: queueHook.queueIndex });
  // Plugin/external tracks enter the queue with liked hardcoded 0 (they carry no
  // DB row). Reconcile the just-added ones against the durable, metadata-keyed
  // entity_likes store so a song liked in a previous session shows its heart on
  // enqueue — the reconcile triggers (startup restore / currentTrack identity /
  // entity-likes-changed) never fire for a plain mid-session add. Applies only
  // likes/dislikes (never clears), so it can't race-revert an optimistic like on
  // a pre-existing same-song copy. Patches by metadata via functional setQueue,
  // so it's correct regardless of the fresh keys useQueue assigns on insert.
  const reconcileAddedLikeStates = useCallback(async (added: QueueTrack[]) => {
    if (added.length === 0) return;
    try {
      const byId = await fetchLikeStates(added);
      // onlyNonZero: never clears, so it can't race-revert an optimistic like.
      queueHook.setQueue(prev => applyLikeStates(prev, byId, { onlyNonZero: true }));
      playback.setCurrentTrack(prev => (prev ? applyLikeState(prev, byId, { onlyNonZero: true }) : prev));
    } catch (e) {
      console.error("Failed to reconcile like state for added tracks:", e);
    }
  }, [queueHook, playback]);

  // Map a plugin-supplied play context onto the queue's PlaylistContext. Shared
  // by every plugin play entry point so the banner is identical whichever one a
  // plugin uses.
  const pluginPlaylistContext = useCallback((context?: PluginPlayContext): PlaylistContext | undefined => {
    const displayName = context?.playlistName || context?.name || "";
    if (!context || !displayName) return undefined;
    const cleanName = context.name || context.playlistName || "";
    const meta = { ...(context.metadata ?? {}) };
    if (cleanName && cleanName !== displayName) meta.playlistName = cleanName;
    return {
      name: displayName,
      source: context.source ?? null,
      description: context.description ?? null,
      metadata: Object.keys(meta).length > 0 ? meta : null,
      remote: true,
      imagePath: context.coverUrl ?? null,
    };
  }, []);

  const pluginPlaybackCallbacks = useMemo(() => ({
    playTrack: (track: PluginTrack) => {
      const converted = [pluginTrackToQueueTrack(track)];
      queueHook.playTracks(converted, 0);
      reconcileAddedLikeStates(converted);
    },
    playTracks: (tracks: PluginTrack[], startIndex?: number, context?: PluginPlayContext) => {
      const converted = tracks.map(pluginTrackToQueueTrack);
      queueHook.playTracks(converted, startIndex ?? 0, pluginPlaylistContext(context));
      reconcileAddedLikeStates(converted);
    },
    // Play the plugin's known head now, append its resolved tail behind the
    // music. The host owns the staleness guard + head de-dupe (see
    // conventions.md "Play With Backfill"), so a plugin can't splice a late
    // tail into a queue the user has since replaced. Routed through a ref
    // because playActions is constructed further down.
    playWithBackfill: (opts: { head: PluginTrack[]; context?: PluginPlayContext; resolveTail: () => Promise<PluginTrack[]> | PluginTrack[]; tailErrorMessage?: string }) => {
      const head = opts.head.map(pluginTrackToQueueTrack);
      if (head.length === 0) return Promise.resolve(0);
      const appended = playWithBackfillRef.current({
        head,
        context: pluginPlaylistContext(opts.context),
        // Promise.resolve tolerates a plugin handing back a plain array.
        resolveTail: () => Promise.resolve(opts.resolveTail()).then(ts => (ts ?? []).map(pluginTrackToQueueTrack)),
        tailErrorMessage: opts.tailErrorMessage,
      });
      reconcileAddedLikeStates(head);
      // Hand back the appended count so the plugin reports what actually landed
      // rather than what it resolved — a tail dropped as stale appended nothing.
      return appended.then(tracks => {
        if (tracks.length > 0) reconcileAddedLikeStates(tracks);
        return tracks.length;
      }).catch(e => {
        console.error("Plugin backfill play failed:", e);
        return 0;
      });
    },
    insertTrack: (track: PluginTrack, position: number) => {
      const converted = [pluginTrackToQueueTrack(track)];
      if (position === -1) {
        queueHook.enqueueTracks(converted);
      } else {
        queueHook.insertAtPosition(converted, position);
      }
      reconcileAddedLikeStates(converted);
    },
    insertTracks: (tracks: PluginTrack[], position: number) => {
      const converted = tracks.map(pluginTrackToQueueTrack);
      if (position === -1) {
        queueHook.enqueueTracks(converted);
      } else {
        queueHook.insertAtPosition(converted, position);
      }
      reconcileAddedLikeStates(converted);
    },
  }), [queueHook, reconcileAddedLikeStates, pluginPlaylistContext]);
  const pluginHostCallbacksRef = useRef<PluginHostCallbacks | undefined>(undefined);
  // Defer plugin loading until the cold-start critical path has settled
  // (window shown + state restored). `!appRestoring` flips true at that point;
  // plugins then load in the background without contending with startup on the
  // single IPC channel. debugMode/devPluginPath are restored before this flips,
  // so the deferred first load already sees their final values.
  const plugins = usePlugins(pluginTrackRef, pluginPlayingRef, pluginPositionRef, pluginQueueRef, pluginPlaybackCallbacks, pluginHostCallbacksRef, debugMode, devPluginPath, !appRestoring);

  // The `nowplaying` visualizer slot. resolveSlot returns null when the chosen
  // visualizer isn't available, so a disabled plugin silently frees the slot
  // instead of breaking the view.
  const nowPlayingVisualizer = resolveSlot(plugins.visualizers, visualizerSlots, "nowplaying");

  // The `fullscreen` slot inherits the Now Playing pick unless one was chosen
  // for it explicitly — see resolveFullscreenSlot.
  const fullscreenVisualizer = resolveFullscreenSlot(plugins.visualizers, visualizerSlots);

  // Anything playing can go fullscreen. A visualizer is only what *fills* the
  // screen when one is selected — without it the album art does, the same way
  // the Now Playing view already falls back. Gating fullscreen on having a
  // visualizer made the feature come and go with a plugin setting.
  //
  // Video is excluded here only because it has its own path (the video container
  // / native mpv layer, which owns the element and must not have it moved); both
  // answering the same key would be a bug. From the user's side there is one
  // fullscreen, and the control bar inside it is literally the same component.
  const canAudioFullscreen =
    !!playback.currentTrack && !isVideoTrack(playback.currentTrack);

  // Kept out of a functional setState updater on purpose: updaters must be pure
  // (React may run one twice), and this one moves the OS window.
  const toggleAudioFullscreen = useCallback(() => {
    const next = !audioFullscreen;
    if (next && !canAudioFullscreen) return;
    setAudioFullscreen(next);
    getCurrentWindow()
      .setFullscreen(next)
      .catch((e) => console.error("Failed to set window fullscreen:", e));
  }, [audioFullscreen, canAudioFullscreen]);

  // One fullscreen *intent*, dispatched by track kind — video to its own path
  // (the container / mpv layer owns the element and it must not be re-parented),
  // audio to the overlay. Cmd/Ctrl+F and the now-playing bar's button both call
  // this rather than re-deriving the rule, so the key and the button can never
  // disagree about which surface answers.
  const canFullscreen = !!playback.currentTrack;
  const toggleFullscreenForTrack = useCallback(() => {
    const t = playback.currentTrack;
    if (!t) return;
    if (isVideoTrack(t)) playback.toggleFullscreen();
    else toggleAudioFullscreen();
  }, [playback.currentTrack, playback.toggleFullscreen, toggleAudioFullscreen]);

  // Leave fullscreen the moment it stops being valid — the track changed to a
  // video, the plugin was disabled, playback stopped. Otherwise the window stays
  // fullscreen showing an empty overlay with no obvious way back.
  useEffect(() => {
    if (audioFullscreen && !canAudioFullscreen) toggleAudioFullscreen();
  }, [audioFullscreen, canAudioFullscreen, toggleAudioFullscreen]);

  // Reconcile against the window, because we are not the only thing that can
  // end fullscreen. In macOS native fullscreen AppKit consumes Escape itself,
  // so the capture-phase handler below never runs; the green button, Mission
  // Control and Ctrl+Cmd+F don't involve the webview at all either. Without
  // this the flag stays true over a now-windowed app — the overlay is stuck up,
  // and the next toggle reads inverted and just turns it off. Observed, not
  // theorised: entering worked, Escape left fullscreen with our state still
  // true, and the following Cmd+F did nothing.
  useEffect(() => {
    if (!audioFullscreen) return;
    let cancelled = false;
    const w = getCurrentWindow();
    // No fullscreen-changed event in the Tauri API; the transition always
    // resizes, so onResized + a state read is the available signal.
    const unlisten = w.onResized(() => {
      w.isFullscreen()
        .then((fs) => {
          // Set the flag directly rather than toggling — the window has already
          // left, so asking it to leave again would be wrong.
          if (!cancelled && !fs) setAudioFullscreen(false);
        })
        .catch((e) => console.error("Failed to read window fullscreen state:", e));
    });
    return () => {
      cancelled = true;
      unlisten.then(safeUnlisten).catch((e) =>
        console.error("Failed to stop watching window resize:", e),
      );
    };
  }, [audioFullscreen]);

  // The Now Playing view's visualizer picker, opened from the button that names
  // it. This is all that's left of what used to be a whole view menu behind a ⋯:
  // fullscreen and the lyrics toggle are their own buttons now, and a picker is
  // the one item that genuinely is a list of choices — so it stays a native menu.
  //
  // It sits here with the rest of the visualizer state. It used to be declared
  // far below, beside `nowPlayingLyrics`, purely because the old menu's "Show
  // lyrics" item read it; nothing here does any more.
  const openVisualizerPicker = useCallback(
    (x: number, y: number) => {
      showNativeMenu(
        x,
        y,
        buildVisualizerMenuSpecs(
          plugins.visualizers,
          visualizerSlots,
          "nowplaying",
          (key) => setVisualizerSlots((prev) => ({ ...prev, nowplaying: key })),
        ),
      );
    },
    [plugins.visualizers, visualizerSlots],
  );

  // Tell plugins the queue moved. One coalesced signal — handlers read the new
  // state back via `api.playback.getQueue()` — so a plugin rendering the queue
  // (the vinyl deck) re-presses its record on enqueue / reorder / remove /
  // advance without polling for it.
  useEffect(() => {
    plugins.dispatchEvent("queue:changed");
  }, [queueHook.queue, queueHook.queueIndex, plugins.dispatchEvent]);

  const dependencies = useDependencies(plugins.pluginStates);

  // "Report a problem" — null when closed. The entry point supplies the issue
  // title plus an optional context block describing what the user was doing,
  // so a report raised from a playback failure carries that failure with it.
  const [reportProblem, setReportProblem] = useState<{ title: string; context: DiagnosticContext | null } | null>(null);

  // Host-only facts for the diagnostic bundle — the things the report can't
  // reach on its own (release channel, effective engine, plugin + dependency
  // state). Called while the modal is open; the modal snapshots the result
  // once on mount, so the report describes the moment the user asked.
  const buildDiagnosticSources = useCallback((context: DiagnosticContext | null): DiagnosticSources => ({
    channel: betaUpdates ? "beta" : "stable",
    engine: mpvCapable && playbackEngine === "native" ? "native" : "browser",
    mpvCapable,
    mpvVideo: mpvVideoCapable,
    plugins: plugins.pluginStates.map((p) => ({
      id: p.id,
      version: p.manifest?.version,
      enabled: p.enabled,
      status: p.status,
      error: p.error,
    })),
    dependencies: dependencies.deps.map((d) => ({
      name: d.name,
      status: d.status,
      version: d.version,
      origin: d.origin,
    })),
    context,
  }), [betaUpdates, mpvCapable, mpvVideoCapable, playbackEngine, plugins.pluginStates, dependencies.deps]);

  // Set of currently loaded & active plugin ids — passed to Home so it keeps the
  // cached shelves of a plugin that registers them late (see useHome prune).
  const activePluginIds = useMemo(
    () => new Set(plugins.pluginStates.filter((p) => p.status === "active").map((p) => p.id)),
    [plugins.pluginStates],
  );

  // Dynamic, cycling Now Playing info section (mini player + main bar).
  const { availableItems: nowPlayingInfoAvailable, resolvedItems: nowPlayingInfoResolved } = useNowPlayingInfo({
    currentTrack: playback.currentTrack,
    trackRank,
    artistRank,
    pluginItems: plugins.nowPlayingInfoItems,
    invokeNowPlayingInfo: plugins.invokeNowPlayingInfo,
    selection: nowPlayingInfoSelection,
    persistence: nowPlayingInfoPersistence,
    order: nowPlayingInfoOrder,
    pluginsLoaded: plugins.pluginsLoaded,
    invokeInfoFetch: plugins.invokeInfoFetch,
    pluginNames: plugins.pluginNames,
    // The cycler renders only in the mini player — see the hook's doc.
    cyclerVisible: mini.miniMode,
    lyricsOffsetSecs,
  });
  // The single per-item control in Settings: a time-of-persistence multiplier
  // (which also enables the item), or null to turn it off.
  const setNowPlayingInfoDwell = useCallback((id: string, top: number | null) => {
    if (top === null) {
      setNowPlayingInfoSelection((prev) => ({ ...prev, [id]: false }));
      return;
    }
    setNowPlayingInfoSelection((prev) => ({ ...prev, [id]: true }));
    setNowPlayingInfoPersistence((prev) => ({ ...prev, [id]: top }));
  }, []);
  // Reset every customization of the section back to the registered defaults.
  const resetNowPlayingInfo = useCallback(() => {
    setNowPlayingInfoSelection({});
    setNowPlayingInfoPersistence({});
    setNowPlayingInfoOrder([]);
  }, []);
  // Props bundle for the Settings > Playback control (drag to reorder + one
  // dwell/off select per item) — the single place this section is configured.
  const nowPlayingInfoSettings = useMemo(() => ({
    items: nowPlayingInfoAvailable,
    selection: nowPlayingInfoSelection,
    persistence: nowPlayingInfoPersistence,
    onSetDwell: setNowPlayingInfoDwell,
    onReorder: setNowPlayingInfoOrder,
    onReset: resetNowPlayingInfo,
  }), [nowPlayingInfoAvailable, nowPlayingInfoSelection, nowPlayingInfoPersistence, setNowPlayingInfoDwell, resetNowPlayingInfo]);
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
  // Toasts — created before stream resolution and the updater so their
  // failure/fallback paths can surface feedback.
  const { toasts, notify, dismiss: dismissToast } = useToasts();

  const { resolvingStatus, resolveFailures, resolvedSource } = useStreamResolution({
    resolveTrackSrcRef,
    transcodeSessionRef,
    resolveStreamByUriRef,
    streamResolversRef,
    resolveStreamByUri: plugins.resolveStreamByUri,
    streamUriResolverOwner: plugins.streamUriResolverOwner,
    pluginNames: plugins.pluginNames,
    requireDep: dependencies.requireDep,
    useNativeVideoRef,
    preferVideoRef,
    queue: queueHook.queue,
    currentTrack: playback.currentTrack,
    notify,
    onTrackFormatResolved: (key, format, localPath) => {
      queueHook.patchTrackFormat(key, format);
      // A plugin-scheme video (qbt://…) carries no art of its own — no
      // image_url, no library row — so its queue row falls to the film-reel
      // icon. With the resolved file on this disk in hand, grab one frame off
      // it through the ordinary main-playlist thumb pipeline; the thumb-ready
      // event updates the row (and the manifest restore keeps it across
      // restarts). set_thumb_from_video no-ops when the thumb already exists
      // and when ffmpeg is missing.
      if (localPath && isVideoTrack({ format, path: null })) {
        const entry = queueHook.queue.find(t => t.key === key);
        if (entry?.path && !entry.image_url) {
          invoke("main_playlist_set_thumb_from_video", { key: entry.path, videoPath: localPath })
            .catch(e => console.error("Failed to grab a video frame for the queue thumb:", e));
        }
      }
    },
  });

  // Seek-bar hover previews for video. Complements the waveform, which is audio-only:
  // at most one of the two is non-null for a given track. Declared after `plugins`
  // (plugin-scheme tracks ask their owning plugin first) and after
  // `useStreamResolution`: when the plugin has no storyboard but its scheme
  // resolved to a file on this disk (qbt://…), the resolved local path lets the
  // ordinary local ffmpeg pass run — same attribution the source panel uses.
  const storyboardState = useStoryboard(
    playback.playbackError ? null : playback.currentTrack,
    plugins.resolveStoryboardByUri,
    playback.currentTrack ? effectiveLocalPath(playback.currentTrack, resolvedSource) : null,
  );
  // What the seek surfaces get: the finished board, or — while it still generates —
  // a board synthesized from the frames extracted so far, so the filmstrip replaces
  // the segmented bar progressively instead of popping in whole at the end. The
  // synthetic board carries the final tile count, so the layout never reflows as
  // frames land; unextracted moments just have no tile yet.
  const storyboard = useMemo(() => {
    if (storyboardState.board) return storyboardState.board;
    const p = storyboardState.partial;
    return p ? partialStoryboard(p.frames, p.intervalSecs, p.count) : null;
  }, [storyboardState.board, storyboardState.partial]);

  // Native (mpv) video session: punch the CSS hole (see App.css
  // `.mpv-video-hole`) and keep the native layer aligned with the video
  // container. A ResizeObserver tracks size changes within a frame so the
  // native child follows a window/pane resize immediately — without it the
  // grown container's newly-exposed area flashes the transparent window until
  // the next poll. The 250ms poll still covers position-only changes (sidebar
  // collapse, dock moves) that ResizeObserver can't see.
  useEffect(() => {
    if (!playback.nativeVideoActive) return;
    let last = "";
    const push = () => {
      const container = playback.videoRef.current?.parentElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const z = zoom.uiZoomRef.current || 1;
      const key = [rect.left, rect.top, rect.width, rect.height, z]
        .map((v) => Math.round(v * 100))
        .join(",");
      if (key === last) return;
      last = key;
      nativeEngine
        .setVideoBounds(rect.left * z, rect.top * z, rect.width * z, rect.height * z)
        .catch(console.error);
    };
    // Keep the hole opaque until bounds have settled + the first frame is up,
    // then reveal. A (re)establish re-arms it — video (re)start, or the <video>
    // reparenting when this effect re-runs on a view/fullscreen change — so
    // those transitions never expose the transparent window before the
    // async-positioned native child has caught up. Resize deliberately does NOT
    // re-arm it (see the ResizeObserver below), so the video stays visible and
    // tracks the drag instead of blanking. `videoReady` defaults false so the
    // very first render with the hole is already opaque (no gap before this
    // effect runs).
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    const armReveal = () => {
      setVideoReady(false);
      clearTimeout(readyTimer);
      readyTimer = setTimeout(() => setVideoReady(true), 250);
    };
    push();
    armReveal();
    const interval = setInterval(push, 250);
    const container = playback.videoRef.current?.parentElement;
    const ro = container
      ? new ResizeObserver(() => {
          // Track bounds every frame, but do NOT re-arm the reveal here.
          // Re-arming on every resize tick held the hole opaque (app bg) for
          // the whole drag + 250ms, which read as "the video turns black
          // while resizing". Keeping it revealed lets the native surface
          // track the resize live: on macOS the render layer repaints
          // synchronously at the new size (set_bounds handshake), on Windows
          // the child window follows via SetWindowPos and mpv repaints — so
          // there's content under the hole, not a blank.
          push();
        })
      : null;
    ro?.observe(container!);
    return () => {
      clearInterval(interval);
      ro?.disconnect();
      clearTimeout(readyTimer);
      setVideoReady(false);
    };
    // Re-run on view / fullscreen changes too: the shared <video> reparents
    // into a different container when entering now-playing (theater) or
    // fullscreen, so we must re-read the container, push bounds immediately,
    // and re-point the ResizeObserver — otherwise the new container's bounds
    // lag until the next 250ms poll and the grown hole flashes the transparent
    // window. (These are the layout vars declared before this effect.)
  }, [playback.nativeVideoActive, library.view, playback.nativeFullscreen]);

  // Let the (opaque-by-default) body go transparent only when see-through is
  // actually wanted: the mini player, or a native video that is *presenting*.
  // Deliberately NOT gated on `videoReady` — that toggles during resize, which
  // would flip the whole window opaque↔transparent (a DWM recomposition flash)
  // and regress the resize case. So the body backstops only the not-yet-
  // presenting phase (startup, start/switch playing) so the desktop never
  // shows there; once presenting it stays transparent and the hole-cover
  // (`.mpv-video-ready`) handles resize on its own. See base.css.
  useEffect(() => {
    const seeThrough =
      mini.miniMode || (playback.nativeVideoActive && playback.nativeVideoPresenting);
    document.body.classList.toggle("window-transparent", seeThrough);
  }, [mini.miniMode, playback.nativeVideoActive, playback.nativeVideoPresenting]);

  // Native video fullscreen has no DOM :fullscreen state, so Escape must be
  // handled explicitly (capture phase so a focused list's Escape handling
  // doesn't swallow it).
  useEffect(() => {
    if (!playback.nativeFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        playback.toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [playback.nativeFullscreen]);

  // Same for the fullscreen visualizer — window fullscreen, so there is no DOM
  // :fullscreen state for the browser to unwind on Escape. Capture phase for the
  // same reason: a focused list would otherwise swallow the key.
  useEffect(() => {
    if (!audioFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        toggleAudioFullscreen();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [audioFullscreen, toggleAudioFullscreen]);

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
          // Report the matched copy's media kind so the resolver layer can
          // reclassify the played track: a VIDEO track that falls back to a
          // library AUDIO copy (e.g. a VPN-blocked YouTube video → its local /
          // Subsonic audio version) must then play as audio. Otherwise the
          // native engine renders video:true over an audio stream and the video
          // window lingers showing black / the previous frame. (See the
          // reclassify branch in useStreamResolution.)
          return { url: track.path, label: "Library", sourceUrl: filePath, video: isVideoTrack(track), format: track.format };
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
            resolve: (title, artistName, albumName, durationSecs, opts) =>
              plugins.invokeStreamResolve(ps.id, sr.id, title, artistName, albumName, durationSecs, preferVideoRef.current, opts?.externalAudio ?? false, opts?.fresh ?? false),
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
      trackTelemetry("track_played", {
        media: isVideoTrack(track) ? "video" : "audio",
        source: sourceClass(track.path),
      });
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
    searchProviders: plugins.searchProviders,
    runProviderSearch: plugins.invokePluginSearch,
    // A plugin search result is an external track like any other: convert, play
    // through the canonical queue action, then reconcile its like state against
    // the durable metadata-keyed store (same as every other plugin-track entry
    // point — see the playback bridge).
    onPlayPluginTrack: (track) => {
      const converted = [pluginTrackToQueueTrack(track)];
      queueHook.playTracks(converted, 0);
      reconcileAddedLikeStates(converted);
    },
    onEnqueuePluginTrack: (track) => {
      const converted = [pluginTrackToQueueTrack(track)];
      queueHook.enqueueTracks(converted);
      reconcileAddedLikeStates(converted);
    },
  });

  useAssignRef(peekNextRef, queueHook.peekNext);
  useAssignRef(advanceIndexRef, queueHook.advanceIndex);

  // UI state
  const [clearing, setClearing] = useState(false);
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
  const [deepLinkMusicSource, setDeepLinkMusicSource] = useState<{ name: string; url: string } | null>(null);
  const [showAddMusicSource, setShowAddMusicSource] = useState(false);
  const [addSourceError, setAddSourceError] = useState<string | null>(null);
  const [publishTarget, setPublishTarget] = useState<{ trackIds?: number[]; collectionId?: number; defaultName?: string; trackCount?: number } | null>(null);
  const [mixtapePreviewPath, setMixtapePreviewPath] = useState<string | null>(null);
  const [mixtapeExportTracks, setMixtapeExportTracks] = useState<ExportTrack[] | null>(null);
  const [mixtapeExportDefaultTitle, setMixtapeExportDefaultTitle] = useState<string>("");
  const [mixtapeExportDefaultCover, setMixtapeExportDefaultCover] = useState<string | null>(null);
  const [mixtapeExportDefaultMetadata, setMixtapeExportDefaultMetadata] = useState<Record<string, string> | null>(null);
  const [mixtapeExportDefaultType, setMixtapeExportDefaultType] = useState<"custom" | "album" | "best_of_artist">("custom");

  const [deleteTagConfirm, setDeleteTagConfirm] = useState<{ id: number; name: string }[] | null>(null);

  const [backendTimings, setBackendTimings] = useState<TimingEntry[]>([]);

  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedSetting("sidebarCollapsed", false, restoredRef);
  const [queueCollapsed, setQueueCollapsed] = usePersistedSetting("queueCollapsed", false, restoredRef);
  const [queueWidth, setQueueWidth] = usePersistedSetting("queueWidth", 300, restoredRef);

  // Edge-revealed queue drawer, fullscreen only.
  //
  // Fullscreen has no room for a permanently-parked panel and no button to summon
  // one (both were removed from the bar), so the gesture is the affordance: push
  // the pointer into the right edge and the queue slides in; move away and it
  // leaves. Same shape as the control bar's own idle-hide — pointer-driven, no
  // state the user has to manage — which is why the queue button became redundant
  // rather than merely relocated.
  //
  // Hysteresis, not one threshold: reveal at the outer EDGE strip, hide only once
  // the pointer is clear of the whole drawer. A single boundary would flicker the
  // panel every time the pointer crossed it, and the drawer is exactly the region
  // you have to be inside to click a track in it.
  const [fsQueueRevealed, setFsQueueRevealed] = useState(false);
  useEffect(() => {
    if (!audioFullscreen) {
      setFsQueueRevealed(false);
      return;
    }
    const EDGE_PX = 24;
    const onMove = (e: MouseEvent) => {
      const fromRight = window.innerWidth - e.clientX;
      if (fromRight <= EDGE_PX) setFsQueueRevealed(true);
      else if (fromRight > queueWidth) setFsQueueRevealed(false);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [audioFullscreen, queueWidth]);
  const [searchViewModes, setSearchViewModes] = usePersistedSetting<{ tracks: ViewMode; albums: ViewMode; artists: ViewMode; tags: ViewMode }>("searchViewModes", { tracks: "list", albums: "tiles", artists: "tiles", tags: "tiles" }, restoredRef);
  const [pluginViewMode, setPluginViewMode] = usePersistedSetting<PluginViewMode>("pluginViewMode", "list", restoredRef);
  const [searchInitialQuery, setSearchInitialQuery] = useState<string | null>(null);
  const [searchQueryKey, setSearchQueryKey] = useState(0);
  // Bumped when a scan/sync changes the library's track population, so the
  // always-mounted SearchView re-runs its current (often empty) query instead of
  // showing stale results cached from an earlier (possibly empty) startup.
  const [searchLibraryKey, setSearchLibraryKey] = useState(0);
  // Monotonic counter bumped whenever a collection resync changes the library.
  // Drives Home's generic post-resync refresh (see useHome / HomeView).
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [searchDeletedBatch, setSearchDeletedBatch] = useState<{ ids: number[]; key: number }>({ ids: [], key: 0 });
  const [searchDeletedTagBatch, setSearchDeletedTagBatch] = useState<{ ids: number[]; key: number }>({ ids: [], key: 0 });
  const [searchBulkEditKey, setSearchBulkEditKey] = useState(0);

  // Updater
  const updater = useAppUpdater(betaUpdates ? "beta" : "stable", playback.handleStop, notify);

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
    onNotify: notify,
  });

  // Stable wrapper so switchToProfile's identity doesn't churn per render.
  const saveStoreNow = useCallback(() => store.save(), []);
  const profileSwitch = useProfileSwitch({
    restoredRef,
    flushQueue: queueHook.flushNow,
    saveStore: saveStoreNow,
    notify,
  });

  // Profile-switch handoff: a second launch with --profile <other> (e.g. a
  // profile shortcut double-clicked while the app runs) forwards through the
  // single-instance callback. The backend stash is the single consumption
  // point (pull-once take()); the event is only a nudge — so a request is
  // never delivered twice, even when an event-path attempt fails and the
  // stash would otherwise replay it. Requests arriving before the deferred
  // queue restore has been applied stay stashed and are consumed at the end
  // of the apply-pending-restore effect below: switching earlier would flush
  // the still-empty queueRef over the profile's saved manifest. allowCreate
  // gives warm shortcuts cold-start parity — a manually deleted profile is
  // recreated empty, matching a cold launch.
  const restoreAppliedRef = useRef(false);
  const consumePendingProfileSwitch = useCallback(() => {
    invoke<string | null>("get_pending_profile_switch")
      .then((name) => {
        if (name) profileSwitch.switchToProfile(name, { allowCreate: true });
      })
      .catch((e) => console.error("Failed to check pending profile switch:", e));
  }, [profileSwitch.switchToProfile]);

  useEffect(() => {
    return subscribe<string>("profile-switch-requested", () => {
      if (!restoreAppliedRef.current) return; // stash consumed after restore applies
      consumePendingProfileSwitch();
    });
  }, [consumePendingProfileSwitch]);

  // True while a now-playing-bar like/dislike write is in flight, used to
  // disable the bar's like control as a visual cue (the hook already guards the
  // double-click race functionally).
  const [likeBusy, setLikeBusy] = useState(false);

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
    notify,
  });

  // The library's track population changed (scan, sync, collection
  // enable/disable/remove): re-run SearchView's active query (it holds its own
  // results — see searchLibraryKey) and bump Home's revision.
  const notifyLibraryChanged = () => {
    setSearchLibraryKey(k => k + 1);
    setLibraryRevision(k => k + 1);
  };

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
      queue: queueHook.queue,
      removeMultiple: queueHook.removeMultiple,
    },
    collections: library.collections,
    onLibraryChanged: notifyLibraryChanged,
  });

  // Image caches
  const artistImageCache = useImageCache("artist");

  // Art for the deck's label and the fullscreen stage. Resolved here, in render,
  // because that's where the image cache lives: a queue track's own `image_url` is
  // usually empty and the real art comes from the album→artist chain by name,
  // exactly as the queue rows and now-playing bar resolve it.
  //
  // The same chain the Now Playing view reads, so it goes through the same
  // (unit-tested) resolver rather than a second copy of the walk. `pending` is
  // ignored here: these consumers just show an image late, they don't switch a
  // text/layout regime on the answer — the distinction that made the flag exist.
  const nowPlayingArtSrc = playback.currentTrack
    ? resolveImageSrc(
        resolveNowPlayingArt(playback.currentTrack, {
          getAlbumImage: albumImageCache.getImage,
          getArtistImage: artistImageCache.getImage,
        }).path,
      )
    : null;
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

  const playActions = usePlayActions({
    playTracks: queueHook.playTracks,
    enqueueTracks: (tracks: Track[]) => handleEnqueueRef.current(tracks),
    // Raw guarded append (no duplicate banner) — a backfill continues a play
    // the user already made. See useQueue.appendToPlaySession.
    appendToPlaySession: queueHook.appendToPlaySession,
    markBackfillPending: queueHook.markBackfillPending,
    settleBackfill: queueHook.settleBackfill,
    setPlaylistContext: queueHook.setPlaylistContext,
    albums: library.albums,
    artists: library.artists,
    tags: library.tags,
    getAlbumImage: albumImageCache.getImage,
    getArtistImage: artistImageCache.getImage,
    getTagImage: tagImageCache.getImage,
    notify,
  });
  useAssignRef(playWithBackfillRef, playActions.playWithBackfill);

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

  // Windows answers taskbar-button clicks inside the window proc, before it can
  // ask the webview anything — so it needs these two flags up front. See
  // `taskbar_win.rs`; a no-op on macOS/Linux.
  useEffect(() => {
    invoke("set_window_behavior", {
      miniMode: mini.miniMode,
      minimizeToMini: minimizeToMiniPlayer,
    }).catch(console.error);
  }, [mini.miniMode, minimizeToMiniPlayer]);

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
  const openPublishMusicSourceRef = useRef<((trackIds: number[]) => void) | null>(null);
  const openEditTrackInfoRef = useRef<((queueIndex: number) => void) | null>(null);
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
    confirmTrashDelete,
    onTracksDeleted: (deletedIds: number[]) => {
      // Accumulate rather than replace: SearchView is frozen while hidden
      // (FreezeWhileHidden) and processes only the tail it hasn't seen yet, so
      // a replaced batch delivered while frozen would be lost when the next
      // one overwrote it — leaving deleted tracks visible in its results.
      setSearchDeletedBatch(prev => ({ ids: [...prev.ids, ...deletedIds], key: prev.key + 1 }));
      for (const id of deletedIds) {
        videoFrameQueueRef.current?.evict(id);
      }
      // A deletion changes the library's track population, so refresh Home too —
      // otherwise a deleted track lingers on content shelves (Recently added,
      // Never played, …) until the next resync / manual refresh / 24h staleness.
      // Bumping the revision re-runs the generic shelf refresh (all shelves, no
      // per-shelf wiring). We only bump the Home revision here (not the full
      // notifyLibraryChanged) because SearchView already handles deletes via the
      // searchDeletedBatch above.
      setLibraryRevision(k => k + 1);
    },
    onCurrentTrackDeleted: (indices) => currentTrackDeletedRef.current(indices),
    onShowMenu: (state) => showNativeMenuRef.current?.(state),
  });

  // playActions is constructed before contextMenuActions, so the enqueue-entity
  // actions reach the dedup-aware handleEnqueue through this ref (updated each render).
  useAssignRef(handleEnqueueRef, contextMenuActions.handleEnqueue);

  // Drag files/folders from the OS file manager into the app to enqueue them.
  const { isDragging: fileDragOver } = useFileDrop({
    enqueue: (tracks) => contextMenuActions.handleEnqueue(tracks as unknown as Track[]),
    findDuplicates: queueHook.findDuplicates,
    expandQueue: () => {
      if (queueCollapsed) setQueueCollapsed(false); // persistence: usePersistedSetting
    },
    notify,
  });

  // Download-orchestration engine: ordered provider list, priorities, the backend
  // resolve-request bridge, the download modal, and the source-owned download
  // triggers. There are no host-generated per-provider menu entries — a provider
  // that wants a menu presence contributes its own context-menu item, and plugin
  // views open the modal themselves via requestAction("download-tracks").
  const {
    downloadModal,
    setDownloadModal,
    downloadProviders,
    openDownloadForCurrentTrack,
    resolveNativeDownload,
    openNativeDownload,
  } = useDownloadOrchestration({
    plugins,
    libraryTracks: library.tracks,
    queue: queueHook.queue,
  });

  // The single decision for the now-playing download button: whether it shows
  // (plan != null) and which downloader it opens — derived from the winning
  // playback source's EffectiveSource. See `decideDownload` / the matrix.
  const downloadPlan = useMemo(
    () => (playback.currentTrack && resolvedSource
      ? decideDownload(resolvedSource.effectiveSource, playback.currentTrack, downloadProviders)
      : null),
    [playback.currentTrack, resolvedSource, downloadProviders],
  );

  const handleDeleteTracks = useCallback(async (trackIds: number[]) => {
    // library.tracks is paginated to the current view's first page, so a
    // plugin-initiated delete (e.g. Duplicate Finder) can reference ids that
    // were never loaded. Resolve those from the backend before building the
    // confirm payload — otherwise off-page ids drop out and the delete no-ops.
    const { loaded, missingIds } = partitionTrackIds(trackIds, library.tracks);
    let resolved = loaded;
    if (missingIds.length > 0) {
      try {
        const fetched = await invoke<Track[]>("get_tracks_by_ids", { ids: missingIds });
        resolved = [...loaded, ...fetched];
      } catch (e) {
        console.error("Failed to resolve tracks for delete:", e);
      }
    }
    const payload = buildDeleteConfirmPayload(resolved);
    if (payload) contextMenuActions.setDeleteConfirm(payload);
  }, [library.tracks, contextMenuActions.setDeleteConfirm]);

  const buildAndShowNativeMenu = useCallback((cm: { x: number; y: number; target: import("./types/contextMenu").ContextMenuTarget }) => {
    contextMenuActions.setContextMenu(cm);
    const specs = buildContextMenuSpecs(cm.target, {
      contextMenuActions, videoLayout, queueHook, library,
      plugins, resolveNativeDownload, openNativeDownload, artistImageCache,
      albumImageCache, tagImageCache, beginRetrieveImage,
      setSearchInitialQuery, setSearchQueryKey,
      setDeleteTagConfirm, trashLabel, handleExportAsMixtapeRef, openPublishMusicSourceRef, openEditTrackInfoRef,
    });
    if (!specs) {
      contextMenuActions.setContextMenu(null);
      return;
    }
    showNativeMenu(cm.x, cm.y, specs);
  }, [contextMenuActions, videoLayout, queueHook, library, plugins, resolveNativeDownload, openNativeDownload, artistImageCache, albumImageCache, tagImageCache, beginRetrieveImage, setSearchInitialQuery, setSearchQueryKey, setDeleteTagConfirm, trashLabel, handleExportAsMixtapeRef, openPublishMusicSourceRef, openEditTrackInfoRef]);
  useAssignRef(showNativeMenuRef, buildAndShowNativeMenu);

  // Wire plugin host callbacks (uses library, contextMenuActions defined above)
  useAssignRef(pluginHostCallbacksRef, {
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
              isVideo: isVideoTrack({ format: null, path: t.uri }),
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
              isVideo: isVideoTrack({ format: null, path: t.uri ?? null }),
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
      } else if (action === "delete-tracks") {
        // Route a plugin-initiated delete through the canonical delete flow
        // (confirm modal → delete_tracks → library/queue cleanup → track:removed).
        // handleDeleteTracks already filters to local, deletable copies and
        // computes the network-share permanent-delete warning.
        const ids = ((payload as { trackIds?: unknown }).trackIds);
        if (Array.isArray(ids)) {
          handleDeleteTracks(ids.filter((x): x is number => typeof x === "number"));
        }
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
  });

  // Event listeners
  useEventListeners({
    loadLibrary: library.loadLibrary,
    loadTracks: library.loadTracks,
    onResyncDone: collectionActions.clearResyncingState,
    resyncingCollectionName: collectionActions.resyncingCollection?.name ?? null,
    setResyncProgress,
    setResyncComplete,
    onBulkEditComplete: () => setSearchBulkEditKey(k => k + 1),
    onLibraryChanged: notifyLibraryChanged,
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
  useAssignRef(beforeNavRef, pushAndScroll);

  const goBackRef = useRef(goBack);
  useAssignRef(goBackRef, goBack);
  const pushStateRef = useRef(pushAndScroll);
  useAssignRef(pushStateRef, pushAndScroll);

  // Replay a "Latest play" tile. Re-resolves by source rather than replaying a
  // stored track list: library entities play fresh from the current library,
  // radio regenerates a new station, and a lone/unresolved track replays itself.
  const handleReplayLatestPlay = useCallback(async (session: RecentPlaySession) => {
    try {
      if (session.source === "album") {
        const a = await invoke<Album | null>("find_album_by_name", { title: session.name, artistName: session.artistName ?? null });
        if (a) { playActions.playAlbum(a.id); return; }
      } else if (session.source === "artist") {
        const ar = await invoke<Artist | null>("find_artist_by_name", { name: session.name });
        if (ar) { playActions.playArtist(ar.id); return; }
      } else if (session.source === "tag") {
        const t = await invoke<Tag | null>("find_tag_by_name", { name: session.name });
        if (t) { playActions.playTag(t.id); return; }
      } else if (session.source === "radio") {
        // Seed from the stored seed track when present: its artist is required to
        // re-resolve the station (and this rescues sessions saved before the seed
        // artist was captured). Fall back to the stored seed title/artist fields.
        const seedTitle = session.track?.title ?? session.seedTitle ?? null;
        const seedArtist = session.track?.artist_name ?? session.seedArtist ?? null;
        if (seedTitle) {
          await playActions.startRadio({ title: seedTitle, artistName: seedArtist, coverPath: session.imagePath ?? null });
          return;
        }
      }
      // track / playlist / unresolved library entity → replay the captured lead track.
      if (session.track) { queueHook.playTracks([session.track], 0); return; }
      notify(`Couldn't replay “${session.name}”.`);
    } catch (e) {
      console.error("Failed to replay latest-play session:", e);
      notify(`Couldn't replay “${session.name}”.`);
    }
  }, [playActions, queueHook, notify]);

  // The sidebar's list reshaped for the surfaces that offer plugin views as a
  // way out of an empty library (Home's empty state, the caption-bar search's
  // no-match state). Deliberately unfiltered: a utility plugin that happens to
  // have a view (library stats, say) is listed alongside the real sources,
  // because separating them would need a source/utility distinction the manifest
  // doesn't carry — a browse-only plugin like Spotify contributes no stream
  // resolver of its own, so capability can't stand in for intent.
  //
  // Reads `sidebarItemsUnfiltered`, NOT `sidebarItems`, for the same reason: a
  // user who hid a plugin's nav entry still has a plugins-only setup, and
  // sourcing this from the filtered list would drop them into the "add a music
  // folder" empty state that has nothing to offer them. Hiding a nav entry never
  // disabled the view itself (`navigateToView` still reaches it), so these
  // entry points stay valid.
  const pluginViewList = useMemo(
    () => plugins.sidebarItemsUnfiltered.map((i) => ({ pluginId: i.pluginId, viewId: i.id, label: i.label })),
    [plugins.sidebarItemsUnfiltered],
  );

  // Open a plugin's sidebar view. Shared by the sidebar itself and the empty
  // states above, which offer these views as the way in for a setup whose only
  // sources are plugins.
  const handleOpenPluginView = useCallback((pluginId: string, viewId: string) => {
    library.setView(`plugin:${pluginId}:${viewId}`);
    library.setSelectedArtist(null);
    library.setSelectedAlbum(null);
    library.setSelectedTag(null);
    library.setSelectedTrack(null);
  }, [library]);

  const handleHomeShelfItemPlay = useCallback((shelf: ResolvedShelf, item: HomeShelfItem) => {
    // "Latest play" tiles replay their session (the shipped `tracks` are empty).
    if (shelf.id === LATEST_PLAY_SHELF_ID) {
      const sess = (item as { __session?: RecentPlaySession }).__session;
      if (sess) void handleReplayLatestPlay(sess);
      return;
    }
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
        const label = (item as { name?: string }).name ?? "tracks";
        // A card that shipped without its full list (empty, or a `partial`
        // head) resolves through the shelf's plugin handler. Kick that off
        // first so the resolve overlaps the head's playback.
        const shelfId = shelf.pluginId ? shelf.id.slice(shelf.pluginId.length + 1) : null;
        const pending = shelf.pluginId && shelfId !== null && (action.partial || action.tracks.length === 0)
          ? plugins.invokeHomeShelfResolvePlay(shelf.pluginId, shelfId, item)
          : null;
        if (action.tracks.length > 0) {
          const head = action.tracks.map(pluginTrackToQueueTrack);
          // Partial: start the known head now and append the rest behind the
          // music — no modal, since audio covers the wait.
          if (action.partial && pending) {
            void playActions.playWithBackfill({
              head,
              context: ctx ?? null,
              resolveTail: () => pending.then(ts => ts.map(pluginTrackToQueueTrack)),
              tailErrorMessage: `Couldn't load the rest of “${label}”.`,
            });
            return;
          }
          queueHook.playTracks(head, 0, ctx);
          return;
        }
        // Nothing playable shipped, so there's no audio to hide the wait
        // behind — this is the one case that still blocks on a modal.
        if (pending) {
          setPluginLoadingMessage("Loading " + label + "…");
          pending.then((tracks) => {
            if (tracks && tracks.length > 0) {
              queueHook.playTracks(tracks.map(pluginTrackToQueueTrack), 0, ctx);
            }
          }).catch((e) => {
            console.error("[home] resolve-play failed:", e);
          }).finally(() => {
            setPluginLoadingMessage(null);
          });
        }
        return;
      }
      case "none":
        return;
    }
  }, [playActions, contextMenuActions, queueHook, plugins, handleReplayLatestPlay]);

  const handleHomeShelfItemClick = useCallback((shelf: ResolvedShelf, item: HomeShelfItem) => {
    // The "Latest play" shelf re-resolves each tile to a fresh play (see
    // handleReplayLatestPlay); it does not navigate or use the empty `tracks`.
    if (shelf.id === LATEST_PLAY_SHELF_ID) {
      const sess = (item as { __session?: RecentPlaySession }).__session;
      if (sess) void handleReplayLatestPlay(sess);
      return;
    }
    // A plugin shelf can take over its own card-clicks (e.g. Spotify navigates
    // into its playlist view). If a handler is registered, let it win.
    if (shelf.pluginId && plugins.invokeHomeShelfItemClick(shelf.pluginId, shelf.id.slice(shelf.pluginId.length + 1), item)) {
      return;
    }
    // Clicking a card body navigates to the entity's detail page (the play
    // button on the card handles playing). Name-based navigation falls back to
    // a synthetic detail page when the entity isn't in the library.
    if (shelf.displayKind === "album-cards") {
      const it = item as { libraryId?: number; name: string; artistName?: string; entityKind?: "album" | "artist" };
      // Mixed shelves (e.g. builtin:jump-back-in) tag artist items so a single
      // album-cards shelf can route each card to the correct detail page.
      if (it.entityKind === "artist") {
        if (it.libraryId) {
          library.handleArtistClick(it.libraryId, it.name);
        } else {
          library.navigateToArtistByName(it.name).catch(console.error);
        }
        return;
      }
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
      // Plugin playlist shelves have no detail page — clicking plays them, via
      // the same path as the card's play button so radio seeds, lazy resolves
      // and partial backfills all behave identically on body-click.
      handleHomeShelfItemPlay(shelf, item);
      return;
    }
    // track-rows — open the track detail page (synthetic if not in library)
    const it = item as { track: PluginTrack };
    library.navigateToTrackByName(it.track.title, it.track.artist_name ?? undefined, it.track.album_title ?? undefined).catch(console.error);
  }, [library, handleHomeShelfItemPlay, plugins, handleReplayLatestPlay]);

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

  // Opens the hidden Song Quiz (supporter easter egg) — reached only via the
  // viboplr://quiz deep link or Settings > Debug, never from the sidebar.
  // Ref-held so the deep-link effect below never sees a stale closure.
  const openQuizRef = useRef(() => {});
  useAssignRef(openQuizRef, () => {
    library.setView("quiz");
    library.setSelectedArtist(null);
    library.setSelectedAlbum(null);
    library.setSelectedTag(null);
    library.setSelectedTrack(null);
  });

  // Listen for deep link events
  useEffect(() => {
    const handled = new Set<string>();
    function handleDeepLink(urls: string[]) {
      for (const raw of urls) {
        if (handled.has(raw)) continue;
        handled.add(raw);
        console.debug("[deep-link] received:", raw);
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
          if (kind === "manifest" && url) {
            // Music source published as an HTTP manifest (artist catalog).
            // Confirm before subscribing — a clicked link is untrusted input.
            setDeepLinkMusicSource({ name: params.get("name") || "", url });
            break;
          }
          // Non-subsonic kinds fall through to plugin-registered collection handlers
        }
        // Supporter easter egg: the hidden Song Quiz game. There is no sidebar
        // entry — this link is the "present" shared with donors on the
        // website's support page (plus a row at the end of Settings > Debug).
        if (raw === "viboplr://quiz" || raw.startsWith("viboplr://quiz?") || raw.startsWith("viboplr://quiz/")) {
          openQuizRef.current();
          break;
        }
        // Forward other viboplr:// deep links to plugins
        if (raw.startsWith("viboplr://")) {
          plugins.forwardDeepLink(raw);
        }
      }
    }
    const stopDeepLink = subscribe<string>("deep-link-received", (event) => {
      handleDeepLink([event.payload]);
    });
    // Check for URLs that arrived before listeners were registered
    getDeepLinkCurrent().then((urls) => {
      if (urls && urls.length > 0) handleDeepLink(urls);
    }).catch(() => {}); // eslint-disable-line no-restricted-syntax -- Fire-and-forget: deep link check on startup — no URLs is the common case
    return stopDeepLink;
  }, [plugins.forwardDeepLink]);

  // Listen for mixtape file opened events (from file association / CLI) — play immediately
  useEffect(() => {
    const stopMixtapeOpen = subscribe<string>("mixtape-file-opened", (event) => {
      trackTelemetry("playlist_loaded", { format: "mixtape" });
      invoke("import_mixtape", { path: event.payload, mode: "just_play", destDir: null })
        .catch(err => console.error("Failed to play mixtape:", err));
    });

    const stopJustPlay = subscribe<{ tracks: Track[]; coverPath?: string | null; title?: string; metadata?: Record<string, string> | null }>("mixtape-just-play", (event) => {
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

    return combineUnlisten(stopMixtapeOpen, stopJustPlay);
  }, [mixtapePreviewPath, queueHook.playTracks]);

  // Handle drag-and-drop of .mixtape files onto the window — play immediately
  useEffect(() => {
    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const paths: string[] = event.payload.paths;
        const mixtapePath = paths.find(p => p.endsWith(".mixtape"));
        if (mixtapePath) {
          trackTelemetry("playlist_loaded", { format: "mixtape" });
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
      // Fire-and-forget: startup housekeeping of temp files — a failed sweep
      // just leaves them for the next launch, with no user-visible effect.
      invoke("cleanup_temp_mixtapes").catch(() => {}); // eslint-disable-line no-restricted-syntax
    }, 3000);
    return () => clearTimeout(t);
  }, []);

  // Restore persisted state on mount
  useEffect(() => {
    (async () => {
      // Kick off the mpv capability probe now, in parallel with the rest of
      // restore below — it's awaited (never rejects; probeEngineCapabilities
      // catches internally) right before appRestoring flips false, so
      // mpvCapable/mpvVideoCapable are guaranteed settled by the time the
      // restored queue/track become playable. Without this, the first play
      // after launch (e.g. a restored video) could read a stale
      // mpvCapable=false and fall through to the browser engine — invisible
      // for most formats, but visible for codecs (e.g. HEVC) the webview
      // <video> can't decode, which then fall to the ffmpeg transcode path.
      const engineCapabilityPromise = probeEngineCapabilities().then(applyEngineCapabilities);
      try {
        await timeAsync("store.init", () => store.init());
        // Startup always lands on Home; `view` and selected-entity state are
        // intentionally not restored (see readPersistedSettings).
        const {
          vol, muted: savedMuted, crossfadeSecs: cf, playbackEngine: savedPlaybackEngine, audioExclusive: savedAudioExclusive, betaUpdates: savedBetaUpdates, telemetryEnabled: savedTelemetryEnabled, trackVideoHistory: savedTrackVideoHistory, preferVideoResolution: savedPreferVideoResolution, videoSubtitles: savedVideoSubtitles, miniMode: wasMini,
          fullWindowWidth: fww, fullWindowHeight: fwh, fullWindowX: fwx, fullWindowY: fwy,
          trackSortField: tSortField, trackSortDir: tSortDir, trackColumns: tCols, trackViewMode: savedTrackViewMode,
          videoLayout: savedVideoLayout,
          sidebarCollapsed: savedSidebarCollapsed, queueCollapsed: savedQueueCollapsed, queueWidth: savedQueueWidth,
          mediaTypeFilter: savedMediaTypeFilter, trackLikedFirst: savedTrackLikedFirst,
          lastDownloadDest: savedLastDownloadDest, searchViewModes: savedSearchViewModes,
          pluginViewMode: savedPluginViewMode,
          minimizeToMiniPlayer: savedMinimizeToMiniPlayer,
          confirmTrashDelete: savedConfirmTrashDelete,
          reduceMotion: savedReduceMotion,
          uiZoom: savedUiZoom, miniZoom: savedMiniZoom,
          eqEnabled: savedEqEnabled, eqMode: savedEqMode, eqPreset: savedEqPreset, eqGains: savedEqGains,
          eqCustomPresets: savedEqCustomPresets, eqPreGainDb: savedEqPreGainDb, eqBassDb: savedEqBassDb, eqTrebleDb: savedEqTrebleDb,
          eqShowBarControlSimple: savedEqShowBarSimple, eqShowBarControlAdvanced: savedEqShowBarAdvanced,
          rgMode: savedRgMode, rgPreampDb: savedRgPreampDb, rgPreventClip: savedRgPreventClip,
          nowPlayingInfoSelection: savedNowPlayingInfo, visualizerSlots: savedVisualizerSlots,
          nowPlayingLyricsHidden: savedLyricsHidden, nowPlayingInfoPersistence: savedNowPlayingInfoTop,
          nowPlayingInfoOrder: savedNowPlayingInfoOrder,
          loggingEnabled: savedLoggingEnabled, debugLogging: savedDebugLogging, debugMode: savedDebugMode,
          devPluginPath: savedDevPluginPath, autoUpdateManagedDeps: savedAutoUpdateDeps,
        } = await timeAsync("store.restore", () => readPersistedSettings(store));
        zoom.hydrate(savedUiZoom, savedMiniZoom);
        if (vol !== undefined && vol !== null) playback.setVolume(vol);
        if (savedMuted !== undefined && savedMuted !== null) {
          playback.setMuted(savedMuted);
          // Restoring a muted state means the app starts silent — surface a
          // non-blocking toast so the silence isn't mistaken for a playback bug.
          if (savedMuted) notify("Audio is muted from your last session");
        }
        if (cf !== undefined && cf !== null) setCrossfadeSecs(cf);
        // Native is the default (store seeds "native"); honor an explicit
        // choice in either direction so a user who picked Browser stays there.
        if (savedPlaybackEngine === "native" || savedPlaybackEngine === "browser") {
          setPlaybackEngine(savedPlaybackEngine);
        }
        if (savedAudioExclusive) {
          setAudioExclusive(true);
          // Cached engine-side until the engine exists; no-op where libmpv
          // couldn't be loaded.
          nativeEngine.setAudioExclusive(true).catch(console.error);
        }
        if (savedBetaUpdates) setBetaUpdates(true);
        // Anonymous usage telemetry (opt-out; see telemetry.ts). Absent key ⇒
        // on. Mirror the flag into the telemetry module, then emit the startup
        // heartbeat + a one-time install event.
        const telemetryOn = savedTelemetryEnabled !== false;
        setTelemetryEnabled(telemetryOn);
        syncTelemetryEnabled(telemetryOn);
        if (telemetryOn) {
          // Enriched startup heartbeat + one-time install event. Fire-and-forget;
          // never blocks startup. All props anonymous + low-cardinality (bucketed
          // library size, small counts, build flavor, release channel).
          void (async () => {
            // `probeEngineCapabilities()` is cached (the mount-time probe above
            // shares this promise), so this resolves the same result without a
            // second `engine_capabilities` round-trip.
            const [trackCount, cols, enabledPlugins, installReported, caps] = await Promise.all([
              invoke<number>("get_track_count").catch(() => null),
              invoke<Collection[]>("get_collections").catch(() => null),
              store.get<string[]>("enabledPlugins").catch(() => null),
              store.get<boolean>("telemetryInstallReported").catch(() => null),
              probeEngineCapabilities(),
            ]);
            // Effective audio engine: the user's choice (default native) gated by
            // whether libmpv actually loaded on this machine. There is one build
            // and it always bundles libmpv, so there is no flavor to report —
            // `mpv_capable` is the only thing that actually varies per machine.
            const engineChoice = savedPlaybackEngine === "browser" ? "browser" : "native";
            const effectiveEngine = caps.mpv && engineChoice === "native" ? "native" : "browser";
            trackTelemetry("app_started", {
              channel: savedBetaUpdates ? "beta" : "stable",
              engine: effectiveEngine,
              mpv_capable: caps.mpv ? "yes" : "no",
              mpv_video: caps.video ? "yes" : "no",
              ...(trackCount != null ? { tracks_bucket: bucketCount(trackCount) } : {}),
              ...(cols ? { collections: cols.length } : {}),
              ...(enabledPlugins ? { plugins_enabled: enabledPlugins.length } : {}),
            });
            if (!installReported) {
              trackTelemetry("app_installed");
              store.set("telemetryInstallReported", true).catch((e) =>
                console.error("Failed to persist telemetryInstallReported:", e));
            }
          })();
        }
        if (savedTrackVideoHistory !== undefined && savedTrackVideoHistory !== null) setTrackVideoHistory(savedTrackVideoHistory);
        if (savedPreferVideoResolution !== undefined && savedPreferVideoResolution !== null) setPreferVideoResolution(savedPreferVideoResolution);
        if (savedVideoSubtitles === false) setVideoSubtitlesOn(false);
        if (savedMinimizeToMiniPlayer) setMinimizeToMiniPlayer(true);
        if (savedConfirmTrashDelete === false) setConfirmTrashDelete(false);
        if (savedReduceMotion) { setReduceMotion(true); applyReduceMotionAttr(true); }

        // EQ / RG / Now Playing info / debug values all arrive from the one
        // batched readPersistedSettings entries() read above — this used to be
        // ~23 more store.get round-trips (5 sequential) before window.show().
        if (typeof savedEqEnabled === "boolean") playback.setEqEnabled(savedEqEnabled);
        if (savedEqMode === "simple" || savedEqMode === "advanced") playback.setEqMode(savedEqMode);

        if (savedRgMode === "off" || savedRgMode === "track" || savedRgMode === "album") playback.setRgMode(savedRgMode);
        if (typeof savedRgPreampDb === "number") playback.setRgPreampDb(savedRgPreampDb);
        if (typeof savedRgPreventClip === "boolean") playback.setRgPreventClip(savedRgPreventClip);
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

        if (savedNowPlayingInfo && typeof savedNowPlayingInfo === "object") setNowPlayingInfoSelection(savedNowPlayingInfo);
        if (savedVisualizerSlots && typeof savedVisualizerSlots === "object") setVisualizerSlots(savedVisualizerSlots);
        if (typeof savedLyricsHidden === "boolean") setNowPlayingLyricsHidden(savedLyricsHidden);
        if (savedNowPlayingInfoTop && typeof savedNowPlayingInfoTop === "object") setNowPlayingInfoPersistence(savedNowPlayingInfoTop);
        if (Array.isArray(savedNowPlayingInfoOrder)) {
          setNowPlayingInfoOrder(savedNowPlayingInfoOrder.filter((id): id is string => typeof id === "string"));
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
          const [{ manifest, state: mpState, thumbs }, dir] = await Promise.all([
            invoke<{ manifest: Manifest | null; state: MainPlaylistState | null; thumbs: [string, string][] }>("main_playlist_read"),
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
                const byId = await fetchLikeStates(tracks);
                for (let i = 0; i < tracks.length; i++) {
                  tracks[i] = applyLikeState(tracks[i], byId);
                }
              } catch (e) {
                console.error("Failed to reconcile restored like states:", e);
              }
              const idx = mpState?.queueIndex != null && mpState.queueIndex >= 0 && mpState.queueIndex < tracks.length ? mpState.queueIndex : -1;
              pendingRestoreQueueRef.current = { tracks, index: idx };
              pendingRestoreThumbsRef.current = thumbs ?? [];
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
        if (savedPluginViewMode && ["cards", "list"].includes(savedPluginViewMode)) setPluginViewMode(savedPluginViewMode as PluginViewMode);
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
          // Apply the saved interface zoom for the restored mode before showing,
          // so the first paint lands at the right size (webview zoom doesn't
          // persist across restarts). hydrate() clamped these to the ladder.
          await applyWebviewZoom(wasMini ? zoom.miniZoomRef.current : zoom.uiZoomRef.current);
          await getCurrentWindow().show();
        });
      } catch (e) {
        console.error("Failed to restore state:", e);
        await getCurrentWindow().show();
      }
      // Bounded: a slow or stalled libmpv load (native dlopen at startup) must
      // never wedge the whole restore behind it — queue/track restoration and
      // library load both happen after this point. On timeout, mpvCapable
      // simply settles a moment later via the same promise's applyEngineCapabilities
      // callback (still attached, still running) and only the very next play
      // risks the original browser-engine fallback race this was meant to close.
      await timeAsync("engineCapabilities", () =>
        Promise.race([
          engineCapabilityPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ])
      );
      restoredRef.current = true;
      setAppRestoring(false);
      await Promise.all([
        timeAsync("loadLibrary", () => library.loadLibrary()),
      ]);
      // Persist the frontend startup timings to the on-disk log so every cold
      // start leaves a cross-session record of the perceived-startup path
      // (they otherwise live only in Settings and vanish on close). The window
      // is already visible by now, so this never gates first paint.
      invoke("record_frontend_startup_timings", { entries: getTimingEntries() })
        .catch(e => console.error("Failed to log frontend startup timings:", e));
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
      // Restore lands paused (no autoplay). For a video track that means an
      // empty <video> until the user presses play — load the first frame so the
      // theater/preview surface isn't black. No-op for audio / non-local video.
      playback.loadRestoredVideoPreview(track).catch(console.error);
      pendingRestoreTrackRef.current = null;
    }
    if (queue) {
      queueHook.setQueue(queue.tracks);
      queueHook.setQueueIndex(queue.index);
      pendingRestoreQueueRef.current = null;
      // Seed thumbnails cached before restart synchronously with the queue. The
      // backend already existence-checked each thumb and returned its
      // canonical_slug-derived filename in main_playlist_read's `thumbs`, so
      // rows paint cached art on the first render with no async round-trip and
      // Rust stays the sole namer of the file.
      queueHook.seedThumbInfo(pendingRestoreThumbsRef.current);
      pendingRestoreThumbsRef.current = [];
    }
    // Only now is a profile-switch flush safe: the saved queue is applied (or
    // there was none), so flushing can no longer overwrite it with the empty
    // default. Consume any switch request stashed during startup.
    restoreAppliedRef.current = true;
    consumePendingProfileSwitch();
  }, [appRestoring, consumePendingProfileSwitch]);

  // First-run onboarding: decide once after restore completes. Existing
  // profiles (collections present, or the legacy plugin-recommendations flag
  // set) are marked complete silently so only fresh profiles see the wizard.
  useEffect(() => {
    if (appRestoring) return;
    let cancelled = false;
    (async () => {
      try {
        const savedProfile = await store.get<string>("onboardingProfile");
        if (!cancelled) setOnboardingProfile(normalizeProfile(savedProfile));
        const complete = await store.get<boolean>("onboardingComplete");
        if (complete || cancelled) return;
        const recsShown = await store.get<boolean>("pluginRecommendationsShown");
        const cols = await invoke<Collection[]>("get_collections");
        if (cancelled) return;
        const decision = onboardingDecision({
          onboardingComplete: !!complete,
          pluginRecommendationsShown: !!recsShown,
          collectionCount: cols.length,
        });
        if (decision === "mark-complete") {
          await store.set("onboardingComplete", true);
        } else if (decision === "show") {
          // Prefetch the gallery for the plugins step; a failure just leaves
          // that step in its retry state instead of blocking the wizard.
          plugins.fetchPluginGallery(true).catch(console.error);
          setShowOnboarding(true);
        }
      } catch (e) {
        console.error("Failed to evaluate onboarding state:", e);
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

  usePersistMirror("eqEnabled", playback.eqEnabled, restoredRef);

  usePersistMirror("eqMode", playback.eqMode, restoredRef);


  usePersistMirror("eqPreset", playback.eqPreset, restoredRef);

  usePersistMirror("eqGains", playback.eqGains, restoredRef);


  usePersistMirror("eqPreGainDb", playback.eqPreGainDb, restoredRef);

  usePersistMirror("eqBassDb", playback.eqBassDb, restoredRef);

  usePersistMirror("eqTrebleDb", playback.eqTrebleDb, restoredRef);

  usePersistMirror("rgMode", playback.rgMode, restoredRef);

  usePersistMirror("rgPreampDb", playback.rgPreampDb, restoredRef);

  usePersistMirror("rgPreventClip", playback.rgPreventClip, restoredRef);

  // Persist recently visited entities (album/artist detail views)
  const recentlyVisitedRef = useRef<RecentlyVisitedEntry[]>([]);

  useEffect(() => {
    (async () => {
      const stored = (await store.get<RecentlyVisitedEntry[]>("recentlyVisitedEntities")) ?? [];
      recentlyVisitedRef.current = stored;
      const plays = (await store.get<RecentPlaySession[]>("recentPlaySessions")) ?? [];
      recentPlaysRef.current = plays;
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

  // Forward frontend errors to the backend log file, the in-memory report
  // buffer, and telemetry. Three destinations because each covers a different
  // gap: the log file is the richest but is OFF by default, the ring buffer is
  // always on but local-only (feeds "Report a problem"), and telemetry is the
  // only one that reaches us unprompted — as a bucketed kind, never the text.
  useEffect(() => {
    // A render loop that throws fires window.onerror hundreds of times a
    // second. The local buffer self-bounds (ring), but telemetry would flood
    // the backend and skew every error rate, so cap it per session — the 20th
    // copy of a repeating error tells us nothing the 1st didn't.
    let errorEventsSent = 0;
    const APP_ERROR_EVENT_CAP = 20;
    const reportError = (scope: string, cause: unknown) => {
      if (errorEventsSent >= APP_ERROR_EVENT_CAP) return;
      errorEventsSent++;
      trackTelemetry("app_error", { scope, error_kind: classifyErrorKind(cause) });
    };
    const onError = (e: ErrorEvent) => {
      const message = `${e.message} at ${e.filename}:${e.lineno}`;
      recordAppError("window", message, e.error instanceof Error ? e.error.stack : undefined);
      reportError("window", e.error ?? e.message);
      invoke("write_frontend_log", { level: "error", message, section: "fr-error" }).catch(() => {}); // eslint-disable-line no-restricted-syntax -- Fire-and-forget: avoid infinite loop if the error logger itself fails
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      recordAppError("unhandledrejection", errorText(e.reason), e.reason instanceof Error ? e.reason.stack : undefined);
      reportError("rejection", e.reason);
      invoke("write_frontend_log", { level: "error", message: `Unhandled rejection: ${e.reason}`, section: "fr-error" }).catch(() => {}); // eslint-disable-line no-restricted-syntax -- Fire-and-forget: avoid infinite loop if the error logger itself fails
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
      .catch(e => {
        console.error("Failed to load track detail:", e);
        if (!cancelled) setDetailTrack(null);
      });
    return () => { cancelled = true; };
  }, [library.selectedTrack, detailTrackLocal]);

  // Keep the Track-detail header fresh on in-place track patches (e.g. a
  // like/dislike). The detail view renders `detailTrackLocal ?? detailTrack`,
  // and for tracks opened from the Library (SearchView keeps its own results)
  // `detailTrackLocal` is null, so the backend-fetched `detailTrack` is what's
  // shown — and nothing else patches it. Mirror the pattern used by SearchView
  // and useEntityDetail: subscribe to trackEvents and patch by id.
  useEffect(() => {
    return subscribeTrackEvents(event => {
      if (event.kind === "patch") {
        setDetailTrack(prev => prev && prev.id === event.trackId ? { ...prev, ...event.patch } : prev);
      } else {
        const removed = new Set(event.trackIds);
        setDetailTrack(prev => prev && prev.id != null && removed.has(prev.id) ? null : prev);
      }
    });
  }, []);

  useEffect(() => {
    if (!restoredRef.current) return;
    if (detailTrack) {
      store.set("fallbackTrackName", { name: detailTrack.title, artistName: detailTrack.artist_name ?? undefined, albumTitle: detailTrack.album_title ?? undefined });
    } else {
      store.set("fallbackTrackName", null);
    }
  }, [detailTrack]);

  // Resolve image for current track: video frame → album → artist. Album/artist
  // come from useImageCache (which also fires the fetch; the listener below patches
  // currentTrack on {album,artist}-image-ready). Video first-frames go through the
  // shared VideoFrameQueue — extract on demand and patch currentTrack when the frame
  // lands, since there is no backend event for frame completion. If the video has no
  // extractable frame, fall back to album/artist like the non-video path.
  useEffect(() => {
    const track = playback.currentTrack;
    if (!track || track.image_url) return;
    let cancelled = false;
    let unsubFrames: (() => void) | null = null;
    // Only stamp if the current track is still this one (guards against the track
    // changing while a fetch/extraction was in flight).
    const stamp = (img: string) => playback.setCurrentTrack(prev =>
      prev && !prev.image_url && prev.path === track.path ? { ...prev, image_url: img } : prev);
    const applyEntityFallback = () => {
      // Same album→artist sequence as the queue/home shelves (pickEntityImagePath),
      // but we stamp the RAW path — NowPlayingBar converts it via resolveImageUrl
      // at render, so this must not pre-convert.
      const img = pickEntityImagePath(track, {
        albumImageFor: albumImageCache.getImage,
        artistImageFor: artistImageCache.getImage,
      });
      if (img) stamp(img);
    };
    (async () => {
      // Frame extraction needs a local file — the backend rejects remote tracks
      // (subsonic, and prefer-video streams reclassified to video), so only try
      // it for file:// video and otherwise fall back to entity art. Mirrors the
      // isLocalTrack gate in useVideoFrames / useQueueVideoFrames.
      if (isVideoTrack(track) && isLocalTrack(track)) {
        const trackId = await invoke<number | null>("find_track_id_by_path", { path: track.path });
        if (cancelled) return;
        const fq = videoFrameQueueRef.current;
        if (trackId != null && fq) {
          // Returns true once the frame entry has settled (ready -> stamp, or
          // unavailable -> entity fallback); false while still loading.
          const resolveFromEntry = (): boolean => {
            const entry = fq.getEntry(trackId);
            if (entry.status === "ready" && entry.frames[0]) { stamp(entry.frames[0]); return true; }
            if (entry.status === "unavailable") { applyEntityFallback(); return true; }
            return false;
          };
          if (resolveFromEntry()) return;
          unsubFrames = fq.subscribe(() => {
            if (cancelled) return;
            if (resolveFromEntry()) { unsubFrames?.(); unsubFrames = null; }
          });
          if (cancelled) { unsubFrames(); unsubFrames = null; return; }
          fq.enqueue(trackId);
          return; // video resolves via the queue
        }
      }
      if (cancelled) return;
      applyEntityFallback();
    })();
    return () => { cancelled = true; if (unsubFrames) { unsubFrames(); unsubFrames = null; } };
  }, [playback.currentTrack, albumImageCache.getImage, artistImageCache.getImage, albumImageCache.cache, artistImageCache.cache]);

  // When a backend image fetch completes, update currentTrack if it's still missing artwork
  useEffect(() => {
    const norm = (s: string | null | undefined) => (s ?? "").toLowerCase();
    const stopAlbum = subscribe<{ title: string; artist_name?: string | null; path: string }>("album-image-ready", (event) => {
      const { title, artist_name, path } = event.payload;
      playback.setCurrentTrack(prev => {
        if (!prev || prev.image_url) return prev;
        if (norm(prev.album_title) !== norm(title)) return prev;
        if (artist_name && norm(prev.artist_name) !== norm(artist_name)) return prev;
        return { ...prev, image_url: path };
      });
    });
    const stopArtist = subscribe<{ name: string; path: string }>("artist-image-ready", (event) => {
      const { name, path } = event.payload;
      playback.setCurrentTrack(prev => {
        if (!prev || prev.image_url) return prev;
        if (norm(prev.artist_name) !== norm(name)) return prev;
        return { ...prev, image_url: path };
      });
    });
    return combineUnlisten(stopAlbum, stopArtist);
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
    canFullscreen,
    toggleFullscreenForTrack,
    adjustZoom,
    miniSearchOpen: miniSearch.isOpen,
    openMiniSearch: (initialChar) => miniSearch.open(initialChar),
    profileSwitchActive: profileSwitch.switching !== null,
  });


  // onEnded handler — uses refs to avoid stale closures from useCallback([])
  const autoContinueRef = useRef(autoContinue);
  useAssignRef(autoContinueRef, autoContinue);
  const queueModeRef = useRef(queueHook.queueMode);
  useAssignRef(queueModeRef, queueHook.queueMode);
  const currentTrackRef = useRef(playback.currentTrack);
  useAssignRef(currentTrackRef, playback.currentTrack);
  const handleStopRef = useRef(playback.handleStop);
  useAssignRef(handleStopRef, playback.handleStop);
  const playNextRef = useRef(queueHook.playNext);
  useAssignRef(playNextRef, queueHook.playNext);
  const addToQueueAndPlayRef = useRef(queueHook.addToQueueAndPlay);
  useAssignRef(addToQueueAndPlayRef, queueHook.addToQueueAndPlay);
  const addToQueueRef = useRef(queueHook.addToQueue);
  useAssignRef(addToQueueRef, queueHook.addToQueue);
  const queueRef = useRef(queueHook.queue);
  useAssignRef(queueRef, queueHook.queue);

  // Keep the now-playing track's like state in sync with the durable
  // entity_likes store. currentTrack is seeded verbatim from the queue entry
  // (often liked:0 for external/restored/plugin copies) and is otherwise never
  // reconciled after playback starts — a stale value would drive the like
  // toggle the wrong way and can delete a real like. Re-read the authoritative
  // state whenever the track *identity* changes (NOT on .liked changes, so an
  // optimistic like is never reverted by a read of the not-yet-committed row).
  useEffect(() => {
    const track = playback.currentTrack;
    if (!track) return;
    let cancelled = false;
    (async () => {
      try {
        const byId = await fetchLikeStates([track]);
        if (cancelled) return;
        const durable = byId.get(trackLikeId(track.title, track.artist_name ?? null)) ?? 0;
        playback.setCurrentTrack(prev =>
          prev && prev.path === track.path && prev.title === track.title && prev.liked !== durable
            ? { ...prev, liked: durable } : prev);
      } catch (e) {
        console.error("Failed to reconcile current track like state:", e);
      }
    })();
    return () => { cancelled = true; };
    // Identity-only deps: must NOT include .liked (see comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.currentTrack?.path, playback.currentTrack?.title, playback.currentTrack?.artist_name, playback.setCurrentTrack]);

  // Re-reconcile like state when the durable store changes from any surface
  // (e.g. liking the now-playing song from the Library list, or a same-song
  // copy whose metadata differs only by case/diacritics so the in-memory
  // sameSong propagation missed it). Reads authoritative state for currentTrack
  // + the queue and patches any drift. Our own writes also fire this event —
  // reconciling to the just-written value is a harmless no-op.
  useEffect(() => {
    return subscribe<{ kind?: string }>("entity-likes-changed", async (event) => {
      const kind = event.payload?.kind;
      // Only track-level changes can move a track's like state. An artist/
      // album/tag heart also fires this event, and reconciling then shipped
      // the title+artist of every queue entry to the backend (30-150 KB for a
      // large queue) to read back states that cannot have changed. Missing
      // kind (never emitted today) falls through to the reconcile — a wasted
      // round-trip is safer than a missed patch.
      if (kind != null && kind !== "track" && kind !== "bulk") return;
      // A bulk change (Import likes file, or a plugin's loved-tracks import)
      // can touch any number of library rows, so refresh the library lists too
      // — the per-entity optimistic updates that cover single likes don't apply.
      if (kind === "bulk") {
        library.loadLibrary().catch(e => console.error("Failed to reload library after likes import:", e));
        library.loadTracks().catch(e => console.error("Failed to reload tracks after likes import:", e));
      }
      try {
        const byId = await fetchLikeStates([currentTrackRef.current, ...queueRef.current]);
        if (byId.size === 0) return;
        playback.setCurrentTrack(prev => (prev ? applyLikeState(prev, byId) : prev));
        queueHook.setQueue(prev => applyLikeStates(prev, byId));
      } catch (e) {
        console.error("Failed to reconcile like states after change:", e);
      }
    });
  }, [playback.setCurrentTrack, queueHook.setQueue, library.loadLibrary, library.loadTracks]);

  useAssignRef(prefetchNextRef, () => {
    const ac = autoContinueRef.current;
    const track = currentTrackRef.current;
    if (!ac.enabled || !track) return;
    console.debug(`[prefetch] Fetching auto-continue track (current: "${track.title}")`);
    ac.fetchTrack(track).then(next => {
      if (next) {
        console.debug(`[prefetch] Queued "${next.title}" by ${next.artist_name}`);
        addToQueueRef.current(next);
      } else {
        console.debug("[prefetch] Auto-continue returned no track");
      }
    });
  });

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

  useAssignRef(mediaSessionNextRef, () => handleNext());
  // Engine-side "ended with nothing gapless-armed" — the native equivalent of
  // the media elements' `ended` (gapless is engine-internal, so no
  // handleGaplessNext check here).
  useAssignRef(nativeEndedRef, () => handleNext("auto"));

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
  useAssignRef(currentTrackDeletedRef, (indices) => { void handleCurrentTrackDeleted(indices); });

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
      await invoke("add_collection", { kind: "local", name: folderName, path: selected });
      trackTelemetry("collection_added", { kind: "local" });
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

  function handleCrossfadeChange(secs: number) {
    setCrossfadeSecs(secs);
    store.set("crossfadeSecs", secs).catch((e) => {
      console.error("Failed to persist crossfadeSecs:", e);
    });
  }

  function handlePlaybackEngineChange(engine: "browser" | "native") {
    if (engine === playbackEngine) return;
    // A manual switch cancels any pending "install mpv & retry" so the old
    // failed track can't get auto-replayed by the retry effect.
    pendingMpvRetryRef.current = null;
    // Clean cut: no mid-track engine handoff. The user re-starts playback on
    // whichever engine they switched to.
    playback.handleStop();
    setPlaybackEngine(engine);
    trackTelemetry("engine_selected", { engine });
    store.set("playbackEngine", engine).catch((e) => {
      console.error("Failed to persist playbackEngine:", e);
    });
  }

  // Playback Failed modal → "Install mpv engine & play": download libmpv if
  // needed, switch to the native engine, and replay the file that WKWebView
  // couldn't. The replay is deferred to the effect below so it runs after
  // mpvCapable/playbackEngine (and useNativeEngineRef) have settled.
  async function handleEnableMpvAndRetry() {
    const track = playback.failedTrack;
    if (!track) return;
    pendingMpvRetryRef.current = track;
    try {
      if (!mpvCapable) {
        await engineComponent.install(); // refreshes capabilities → flips mpvCapable
      }
      setPlaybackEngine("native");
      store.set("playbackEngine", "native").catch((e) => {
        console.error("Failed to persist playbackEngine:", e);
      });
      playback.clearPlaybackError();
    } catch (e) {
      console.error("Failed to enable the mpv engine for playback:", e);
      pendingMpvRetryRef.current = null; // leave the error modal up to Skip/Dismiss
    }
  }

  useEffect(() => {
    const track = pendingMpvRetryRef.current;
    if (track && mpvCapable && playbackEngine === "native") {
      pendingMpvRetryRef.current = null;
      playback.handlePlay(track, "user");
    }
  }, [mpvCapable, playbackEngine]);

  function handleAudioExclusiveChange(enabled: boolean) {
    setAudioExclusive(enabled); // persistence: usePersistedSetting
    nativeEngine.setAudioExclusive(enabled).catch(console.error);
  }

  function handleBetaUpdatesChange(enabled: boolean) {
    setBetaUpdates(enabled); // persistence: usePersistedSetting
  }

  function handleTelemetryEnabledChange(enabled: boolean) {
    setTelemetryEnabled(enabled); // persistence: usePersistedSetting
    syncTelemetryEnabled(enabled);
  }

  function handleOnboardingClose(profile: OnboardingProfile) {
    setShowOnboarding(false);
    setOnboardingProfile(profile);
    store.set("onboardingProfile", profile).catch((e) => {
      console.error("Failed to persist onboardingProfile:", e);
    });
    store.set("onboardingComplete", true).catch((e) => {
      console.error("Failed to persist onboardingComplete:", e);
    });
    // Keep the legacy first-run flag consistent — the wizard's plugins step
    // replaces the old recommendations prompt.
    store.set("pluginRecommendationsShown", true).catch((e) => {
      console.error("Failed to persist pluginRecommendationsShown:", e);
    });
  }

  function handleTrackVideoHistoryChange(enabled: boolean) {
    setTrackVideoHistory(enabled); // persistence: usePersistedSetting
  }

  function handlePreferVideoResolutionChange(enabled: boolean) {
    setPreferVideoResolution(enabled); // persistence: usePersistedSetting
  }

  function handleMinimizeToMiniPlayerChange(enabled: boolean) {
    setMinimizeToMiniPlayer(enabled); // persistence: usePersistedSetting
  }

  function handleConfirmTrashDeleteChange(enabled: boolean) {
    setConfirmTrashDelete(enabled); // persistence: usePersistedSetting
  }

  function handleReduceMotionChange(enabled: boolean) {
    setReduceMotion(enabled); // persistence: usePersistedSetting
    applyReduceMotionAttr(enabled); // toggles the root attr + notifies live JS animations
  }

  // Interface zoom. The full-window factor applies immediately only when not in
  // the mini player (otherwise it takes effect on returning to full mode, via
  // useMiniMode's transition). The mini factor is re-fit by useMiniMode.
  function handleUiZoomChange(factor: number) {
    zoom.setUiZoom(factor);
    if (!mini.miniModeRef.current) applyWebviewZoom(factor);
  }

  function handleMiniZoomChange(factor: number) {
    zoom.setMiniZoom(factor);
    mini.applyMiniZoom();
  }

  // Cmd/Ctrl +/- steps the active context's zoom (mini player or full window).
  function adjustZoom(dir: 1 | -1) {
    if (mini.miniModeRef.current) {
      handleMiniZoomChange(stepZoomPreset(zoom.miniZoomRef.current, dir));
    } else {
      handleUiZoomChange(stepZoomPreset(zoom.uiZoomRef.current, dir));
    }
  }

  function handleLoggingEnabledChange(enabled: boolean) {
    setLoggingEnabled(enabled); // persistence: usePersistedSetting
  }

  function handleAutoUpdateManagedDepsChange(enabled: boolean) {
    setAutoUpdateManagedDeps(enabled); // persistence: usePersistedSetting
  }

  function handleDebugLoggingChange(enabled: boolean) {
    setDebugLogging(enabled); // persistence: usePersistedSetting
    setDebugLoggingRef(enabled);
  }

  function handleDebugModeChange(enabled: boolean) {
    setDebugMode(enabled); // persistence: usePersistedSetting
  }

  function handleDevPluginPathChange(path: string | null) {
    setDevPluginPath(path); // persistence: usePersistedSetting
  }

  function handleToggleSidebar() {
    setSidebarCollapsed(prev => !prev); // persistence: usePersistedSetting
  }

  function handleToggleQueueCollapsed() {
    setQueueCollapsed(prev => !prev); // persistence: usePersistedSetting
  }

  function handleResizeQueueWidth(width: number) {
    setQueueWidth(width); // persistence: usePersistedSetting
  }

  function handleSearchViewModesChange(modes: { tracks: ViewMode; albums: ViewMode; artists: ViewMode; tags: ViewMode }) {
    setSearchViewModes(modes); // persistence: usePersistedSetting
  }
  function handlePluginViewModeChange(mode: PluginViewMode) {
    setPluginViewMode(mode); // persistence: usePersistedSetting
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
    startRadio: (t) => contextMenuActions.startRadio({ title: t.title, artistName: t.artist_name, coverPath: t.image_url ?? null }),
    locateTrack: (t) => library.handleTrackClick(t.key),
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
    buildPluginOverflowItems: (target) => buildPluginOverflowItems(
      plugins.menuItems.filter(item => item.targets.includes(target.kind)),
      target,
      plugins.dispatchContextMenuAction,
    ),
    tagSuggestionPool,
    refreshLibraryTags: library.loadLibrary,
    retrieve: {
      openInfo: retrieve.openInfo,
    },
  }), [
    library.handleArtistClick, library.handleAlbumClick, library.handleTagClick, library.navigateToTagByName,
    library.handleTrackClick, contextMenuActions.startRadio,
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
    plugins.invokeInfoFetch, plugins.pluginsLoaded, plugins.pluginNames,
    plugins.menuItems, plugins.dispatchContextMenuAction,
    tagSuggestionPool, library.loadLibrary,
    beginRetrieveImage, retrieve.openInfo,
  ]);

  // Now Playing view: lyrics via the shared info-type chain, and resolved art.
  const nowPlayingLyrics = useLyrics({
    track: playback.currentTrack,
    // Fetch for the Now Playing view (centered lyrics), for the fullscreen
    // overlay — which is that same view, and is reachable from *any* view, so
    // gating on `nowplaying` alone left fullscreen entered from the Library with
    // no lyrics at all — and for any playing video (subtitle overlay). Fetching
    // for video regardless of `videoSubtitlesOn` is deliberate: the subtitle
    // toggle is gated on lyrics *existing*, so if we only fetched while subtitles
    // were on, turning them off would hide the toggle and make the choice
    // irreversible. Lyrics are cached, so this is one background fetch per video.
    enabled:
      library.view === "nowplaying" ||
      audioFullscreen ||
      (!!playback.currentTrack && isVideoTrack(playback.currentTrack)),
    invokeInfoFetch: plugins.invokeInfoFetch,
    pluginNames: plugins.pluginNames,
  });
  // Synced lyrics for the video subtitle overlay: only when the current track is
  // video, synced lyrics exist, and they fit the media length in BOTH directions
  // — not running past it (a short edit/preview) and not covering only a sliver
  // of it (a concert upload or extended remix). Rendered as subtitles across the
  // docked preview, theater, and fullscreen; visibility is the shared
  // `videoSubtitlesOn`. A rejected fit also hides the subtitle toggle, since
  // both toggle sites are gated on this being non-null — no dead switch.
  const videoSyncedLyricLines = useMemo(() => {
    const t = playback.currentTrack;
    if (!t || !isVideoTrack(t)) return null;
    if (nowPlayingLyrics.status !== "loaded" || nowPlayingLyrics.data?.kind !== "synced" || !nowPlayingLyrics.data.text) {
      return null;
    }
    const lines = parseLrc(nowPlayingLyrics.data.text);
    // Prefer the live media duration over the queue entry's metadata: what a
    // plugin resolved and is actually decoding can differ from what the entry
    // claims, and the gate is about the video on screen. Falls back to metadata
    // while the media is still loading; 0/null means "unknown" and allows.
    const durationSecs = playback.durationSecs || t.duration_secs;
    return syncedLyricsFitMedia(lines, durationSecs) ? lines : null;
  }, [playback.currentTrack, playback.durationSecs, nowPlayingLyrics]);

  // `PluginVisualizerActions.setPlaying`. Idempotent: the visualizer states what
  // it wants, and this compares against live state, so a request that already
  // matches is a no-op rather than a toggle that inverts. `handlePause` is the
  // app's play/pause toggle, hence the comparison instead of calling it blind.
  const handleVisualizerSetPlaying = useCallback(
    (playing: boolean) => {
      if (playing === playback.playing) return;
      playback.handlePause();
    },
    [playback.playing, playback.handlePause],
  );

  // One host for every visualizer slot. The Now Playing view and the fullscreen
  // overlay differ only in `placement` and which selection they resolved, so the
  // ~15 props the plugin host contract needs are built once — two call sites
  // would drift the first time that contract gains a field, and only one of them
  // would be the one anybody tested.
  const renderVisualizerSlot = (
    placement: PluginVisualizerPlacement,
    selection: string,
  ) => (
    <VisualizerSlot
      placement={placement}
      selection={selection}
      createVisualizer={plugins.createVisualizer}
      queue={queueHook.queue}
      currentIndex={queueHook.queueIndex}
      playing={playback.playing}
      stopped={playback.stopped}
      durationSecs={playback.currentTrack?.duration_secs ?? null}
      currentArtUrl={nowPlayingArtSrc}
      onSeek={playback.handleSeek}
      onPlayQueueIndex={(index) => {
        const t = queueHook.queue[index];
        if (!t) return;
        queueHook.setQueueIndex(index);
        playback.handlePlay(t);
      }}
      onLoadQueueIndex={(index, positionSecs) => {
        const t = queueHook.queue[index];
        if (!t) return;
        queueHook.setQueueIndex(index);
        playback.loadPaused(t, positionSecs ?? 0);
      }}
      onSetPlaying={handleVisualizerSetPlaying}
      rate={playback.playbackRate}
      onSetRate={playback.setPlaybackRate}
      volume={playback.volume}
      muted={playback.muted}
    />
  );

  const detailViewState: DetailViewState = useMemo(() => ({
    currentTrack: playback.currentTrack,
    playing: playback.playing,
    bulkEditKey: searchBulkEditKey,
  }), [playback.currentTrack, playback.playing, searchBulkEditKey]);

  // After a bulk edit, keep the current detail page pointing at the right entity.
  // Detail pages refetch on `bulkEditKey`, so an entity that still has tracks just
  // refreshes in place (dropping tracks that moved elsewhere). When an edit empties
  // the *viewed* entity — every track renamed/moved out, so the backend's
  // recompute_counts prunes it — follow the tracks to their new home: albums and
  // artists have a single destination (the new name); a tag's edit is a set
  // operation with no single destination, so it falls back to the Library.
  const handleBulkEditSaved = async (result: BulkEditResult) => {
    contextMenuActions.setBulkEditTracks(null);
    library.loadLibrary();
    library.loadTracks();

    const { view, selectedAlbum, selectedArtist, selectedTag } = library;
    try {
      // Album detail (standalone albums view, or an album opened inside artist view).
      if ((view === "albums" || view === "artists") && selectedAlbum != null) {
        if (!(result.albumChanged || result.artistChanged)) return;
        const oldAlbum = library.albums.find(a => a.id === selectedAlbum);
        if (!oldAlbum) return;
        const oldTitle = oldAlbum.title;
        const oldArtist = oldAlbum.artist_name ?? undefined;
        const stillExists = await invoke<Album | null>("find_album_by_name", { title: oldTitle, artistName: oldArtist ?? null });
        if (stillExists) return; // still has tracks — stay (refetched via bulkEditKey)
        const targetTitle = result.albumChanged ? result.newAlbum : oldTitle;
        const targetArtist = result.artistChanged ? result.newArtist : oldArtist;
        if (targetTitle) library.navigateToAlbumByName(targetTitle, targetArtist ?? undefined);
        return;
      }

      // Artist detail.
      if (view === "artists" && selectedArtist != null) {
        if (!result.artistChanged) return;
        const oldArtist = library.artists.find(a => a.id === selectedArtist);
        if (!oldArtist) return;
        const stillExists = await invoke<Artist | null>("find_artist_by_name", { name: oldArtist.name });
        if (stillExists) return; // still has tracks — stay
        if (result.newArtist) library.navigateToArtistByName(result.newArtist);
        return;
      }

      // Tag detail. A bulk edit can strip the tag from its tracks; if that empties
      // the tag (pruned) there's no single destination — drop the selection and let
      // the Library redirect take over.
      if (view === "tags" && selectedTag != null) {
        const oldTag = library.tags.find(t => t.id === selectedTag);
        if (!oldTag) return;
        const stillExists = await invoke<Tag | null>("find_tag_by_name", { name: oldTag.name });
        if (!stillExists) library.setSelectedTag(null);
      }
    } catch (e) {
      console.error("Failed to re-point detail view after bulk edit:", e);
    }
  };

  async function handleSaveAsPlaylist() {
    if (queueHook.queue.length === 0) return;
    // Default the cover to the playlist-context image; when the queue has none
    // (e.g. a hand-built queue), fall back to the first track's image so the
    // saved playlist isn't cover-less — same rule as the mixtape share.
    const contextCover = stripImageVersion(queueHook.playlistContext?.imagePath ?? null);
    setSavePlaylistDefaultCover(contextCover ?? (await resolveFirstAlbumCover(queueHook.queue)));
    setShowSavePlaylistModal(true);
  }

  function handleEditQueueTrackSave(fields: { title: string; artist: string; album: string }) {
    const target = editQueueTrack;
    if (!target) return;
    const patch = {
      title: fields.title,
      artist_name: fields.artist || null,
      album_title: fields.album || null,
    };
    // Match the entry by key before mutating so we can tell if it's the one
    // playing — the queue array is the source of truth for the index.
    const editedKey = queueHook.queue[target.index]?.key;
    queueHook.updateTrackMetadata(target.index, patch);
    // When the edited entry is the current track, patch currentTrack too so the
    // now-playing bar and lyrics (keyed by title/artist) refresh right away.
    if (editedKey && playback.currentTrack?.key === editedKey) {
      playback.setCurrentTrack(prev => (prev ? { ...prev, ...patch } : prev));
    }
    setEditQueueTrack(null);
  }

  async function handlePublishQueue() {
    const localTracks = queueHook.queue.filter(isLocalTrack);
    if (localTracks.length === 0) {
      notify("The queue has no local tracks to share.");
      return;
    }
    // Resolve a library id per local track: prefer the in-memory lib:N key, else
    // look it up by its (durable) file path — mirrors the queue delete path so
    // restored / m3u-loaded / external-keyed local tracks resolve too. Dedupe so
    // a track queued twice isn't bundled twice.
    const ids: number[] = [];
    const seen = new Set<number>();
    for (const t of localTracks) {
      let id = parseLibraryId(t.key);
      if (id == null && t.path) {
        try {
          id = await invoke<number | null>("find_track_id_by_path", { path: t.path });
        } catch (e) {
          console.error("Failed to resolve track id by path:", e);
          id = null;
        }
      }
      if (id != null && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    if (ids.length === 0) {
      notify("Those tracks aren't in your library, so they can't be shared.");
      return;
    }
    setPublishTarget({ trackIds: ids, trackCount: ids.length, defaultName: queueHook.playlistContext?.name || "" });
  }

  async function handleQueueExportAsMixtape() {
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
    // Strip the entity cache's #v=N cache-buster: this becomes a persisted
    // mixtape cover path, and the backend treats it as a literal filesystem path.
    // When the queue has no playlist-context cover (e.g. a hand-built queue),
    // default to the first album's image so the mixtape isn't cover-less.
    const contextCover = stripImageVersion(queueHook.playlistContext?.imagePath ?? null);
    setMixtapeExportDefaultCover(contextCover ?? (await resolveFirstAlbumCover(tracks)));
    setMixtapeExportDefaultMetadata(contextToExportMetadata(queueHook.playlistContext));
    const ctxSource = queueHook.playlistContext?.source;
    setMixtapeExportDefaultType(ctxSource === "album" ? "album" : ctxSource === "artist" ? "best_of_artist" : "custom");
  }

  async function handleSavePlaylistConfirm(name: string, imagePath: string | null) {
    setShowSavePlaylistModal(false);
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
      // The backend copies imageUrl into playlist_images/{id}.jpg. Never store
      // the raw path via update_playlist_image here — the default cover can
      // point at the shared entity-image cache, and delete_playlist_record
      // deletes the file at image_path.
      await invoke<number>("save_playlist_record", {
        name,
        source: ctx?.source ?? null,
        imageUrl: imagePath,
        description: ctx?.description ?? null,
        metadata: ctx?.metadata ? JSON.stringify(ctx.metadata) : null,
        tracks,
      });
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
      // Library exports carry no explicit cover — default to the first
      // track's image so the mixtape isn't cover-less.
      setMixtapeExportDefaultCover(await resolveFirstAlbumCover(tracks));
      setMixtapeExportDefaultMetadata(null);
      setMixtapeExportDefaultType(inferredType || "custom");
    } catch (e) {
      console.error("Failed to prepare mixtape export:", e);
    }
  }, [library.selectedAlbum, library.selectedArtist]);

  const handleExportAsMixtapeDirect = useCallback(async (tracks: ExportTrack[], defaultTitle?: string, coverPath?: string | null, metadata?: Record<string, string> | null) => {
    if (tracks.length === 0) return;
    setMixtapeExportTracks(tracks);
    setMixtapeExportDefaultTitle(defaultTitle || "");
    // No cover from the caller (e.g. sharing a saved playlist that has no
    // image) — fall back to the first track's image, like the queue share.
    setMixtapeExportDefaultCover(
      coverPath ?? (await resolveFirstAlbumCover(tracks.map(t => ({
        album_title: t.albumTitle ?? null,
        artist_name: t.artistName ?? null,
        image_url: t.imageUrl ?? null,
      })))),
    );
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
  useAssignRef(handleToggleLikeRef, likeActions.handleToggleLike);
  useAssignRef(handleExportAsMixtapeRef, handleExportAsMixtape);
  useAssignRef(openPublishMusicSourceRef, (ids) => setPublishTarget({ trackIds: ids, trackCount: ids.length }));
  useAssignRef(openEditTrackInfoRef, (index) => {
    const t = queueHook.queue[index];
    if (!t) return;
    setEditQueueTrack({
      index,
      title: t.title,
      artist: t.artist_name ?? "",
      album: t.album_title ?? "",
      // Snapshot the read-only facts at open time — everything on the
      // QueueTrack except its internal key.
      info: buildTrackInfoEntries({
        position: index + 1,
        durationSecs: t.duration_secs,
        format: t.format,
        source: t.path,
        imageUrl: t.image_url,
        liked: t.liked,
      }),
    });
  });

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

  // The "queue" placement pins the shared video to the bottom of the queue
  // panel (column 3). It stays a child of .main in the DOM (repositioned via
  // CSS, like theater/fullscreen — no remount); theater and native fullscreen
  // still win, and a collapsed queue has no room so the video hides with it.
  const videoPlaying = !!(playback.currentTrack && isVideoTrack(playback.currentTrack));
  const videoInQueue = videoPlaying && videoLayout.dockSide === "queue" && !videoTheater && !playback.nativeFullscreen && !queueCollapsed;

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

  // Every NowPlayingBar callback goes through useStableCallbacks so the memo'd
  // bar (see NowPlayingBar.tsx) isn't re-rendered just because App's frequent
  // renders gave inline closures new identities. The bodies are re-captured
  // every render (they read live state); only the identities are pinned.
  const npBar = useStableCallbacks({
    onCancelCollapseTimer: mini.cancelCollapseTimer,
    onBeginMiniDrag: mini.beginMiniDrag,
    onCycleRestingSize: () => mini.setMiniRestingSize(cycleRestingSize(mini.miniRestingSize)),
    onCycleMiniWidth: () => mini.setMiniWidthSize(cycleMiniWidth(mini.miniWidthSize)),
    onToggleMiniMode: mini.toggleMiniMode,
    onClose: () => exit(0),
    onPause: playback.handlePause,
    onStop: playback.handleStop,
    onNext: handleNext,
    onPrevious: queueHook.playPrevious,
    onSeek: playback.handleSeek,
    onVolume: playback.handleVolume,
    onMute: playback.toggleMute,
    onEqEnabledChange: playback.setEqEnabled,
    onEqModeChange: playback.setEqMode,
    onEqPresetChange: (id: string) => {
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
    },
    onEqGainChange: (i: number, db: number) => {
      const next = [...playback.eqGains];
      next[i] = db;
      playback.setEqGains(next);
      playback.setEqPreset(presetForGains(next, eqCustomPresets));
    },
    onEqPreGainChange: playback.setEqPreGainDb,
    onEqBassChange: playback.setEqBassDb,
    onEqTrebleChange: playback.setEqTrebleDb,
    onEqResetAll: () => {
      if (playback.eqMode === "simple") {
        playback.setEqBassDb(0);
        playback.setEqTrebleDb(0);
        return;
      }
      playback.setEqGains([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      playback.setEqPreset("flat");
      playback.setEqPreGainDb(0);
    },
    onEqSaveAs: () => setEqSaveAsOpen(true),
    // The mode ternary lives inside the body (not at the prop site) so the
    // identity stays pinned while still targeting the live mode's setter.
    onEqShowBarControlChange: (v: boolean) => {
      if (playback.eqMode === "simple") setEqShowBarControlSimple(v);
      else setEqShowBarControlAdvanced(v);
    },
    onToggleFullscreen: () => toggleFullscreenForTrack(),
    onToggleQueueMode: queueHook.toggleQueueMode,
    onRandomize: queueHook.randomizeQueue,
    onToggleAutoContinue: () => autoContinue.setEnabled(!autoContinue.enabled),
    onToggleAutoContinueSameFormat: () => autoContinue.setSameFormat(!autoContinue.sameFormat),
    onToggleAutoContinuePopover: () => autoContinue.setShowPopover(!autoContinue.showPopover),
    onAdjustAutoContinueWeight: autoContinue.adjustWeight,
    onResetAutoContinueWeights: autoContinue.resetWeights,
    onCloseAutoContinuePopover: () => autoContinue.setShowPopover(false),
    onToggleLike: () => {
      const t = playback.currentTrack;
      if (!t) return;
      setLikeBusy(true);
      likeActions.handleToggleLike(t).finally(() => setLikeBusy(false));
    },
    onToggleDislike: () => {
      const t = playback.currentTrack;
      if (!t) return;
      setLikeBusy(true);
      likeActions.handleToggleDislike(t).finally(() => setLikeBusy(false));
    },
    onTrackClick: (trackId: string) => { library.handleTrackClick(trackId); },
    onNavigateToArtistByName: library.navigateToArtistByName,
    onNavigateToAlbumByName: library.navigateToAlbumByName,
    onNavigateToTagByName: library.navigateToTagByName,
    onSkipError: () => { playback.clearPlaybackError(); handleNext(); },
    // Defined unconditionally; the call site gates PRESENCE on currentTrack +
    // downloadPlan, so the bar still hides its download button.
    onDownloadTrack: () => {
      const t = playback.currentTrack;
      if (t && downloadPlan) openDownloadForCurrentTrack(t, downloadPlan);
    },
    onContextMenu: (e: React.MouseEvent) => {
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
        specs.push({ kind: "item", text: "Start radio from this track", action: () => {
          contextMenuActions.startRadio({ title: t.title, artistName: t.artist_name, coverPath: t.image_url ?? null });
        } });
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
      // The info line is configured in Settings > Playback (drag to reorder,
      // dwell, on/off) — the menu just takes you there, leaving the main
      // window open on that section.
      specs.push({ kind: "item", text: "Now playing info…", action: () => {
        setSettingsScrollTarget("now-playing-info");
        library.setView("settings");
        if (mini.miniMode) mini.toggleMiniMode();
      } });
      specs.push({ kind: "separator" });
      specs.push({ kind: "item", text: "Show Main Window", action: mini.toggleMiniMode });
      specs.push({ kind: "item", text: "Exit App", action: () => exit(0) });
      showNativeMenu(e.clientX, e.clientY, specs);
    },
    onMiniSearchQueryChange: miniSearch.setQuery,
    onMiniSearchKeyDown: miniSearch.handleKeyDown,
    onMiniSearchResultClick: miniSearch.handleResultClick,
  });

  // The EQ button's whole contract, in one bundle, so the fullscreen bar can
  // carry the same equalizer the windowed bar does. The now-playing bar still
  // takes the flat props (they feed its inline EqBarControl too) and rebuilds
  // this shape itself; both end up in the shared EqButton.
  const eqControls: EqControls = {
    enabled: playback.eqEnabled,
    mode: playback.eqMode,
    preset: playback.eqPreset,
    gains: playback.eqGains,
    preGainDb: playback.eqPreGainDb,
    bassDb: playback.eqBassDb,
    trebleDb: playback.eqTrebleDb,
    customPresets: eqCustomPresets,
    onEnabledChange: npBar.onEqEnabledChange,
    onModeChange: npBar.onEqModeChange,
    onPresetChange: npBar.onEqPresetChange,
    onGainChange: npBar.onEqGainChange,
    onPreGainChange: npBar.onEqPreGainChange,
    onBassChange: npBar.onEqBassChange,
    onTrebleChange: npBar.onEqTrebleChange,
    onResetAll: npBar.onEqResetAll,
    onSaveAs: npBar.onEqSaveAs,
    showBarControl: playback.eqMode === "simple" ? eqShowBarControlSimple : eqShowBarControlAdvanced,
    onShowBarControlChange: npBar.onEqShowBarControlChange,
  };

  // One prop set for the fullscreen control bar, rendered twice: once inside the
  // video container and once inside the audio/visualizer overlay. Shared rather
  // than duplicated because "the controls are consistent across fullscreens" is
  // the requirement — two 40-prop call sites would drift the first time either
  // was touched. Only `onToggleFullscreen` differs (each surface exits itself),
  // so each call site overrides that one.
  //
  // Declared after `npBar` because the EQ bundle reuses its pinned handlers
  // rather than re-deriving the preset/gain logic.
  const fullscreenControlsProps = {
    waveformPeaks,
    storyboard,
    currentTrack: playback.currentTrack,
    playing: playback.playing,
    durationSecs: playback.durationSecs,
    scrobbled: playback.scrobbled,
    volume: playback.volume,
    muted: playback.muted,
    queueMode: queueHook.queueMode,
    autoContinueEnabled: autoContinue.enabled,
    autoContinueSameFormat: autoContinue.sameFormat,
    showAutoContinuePopover: autoContinue.showPopover,
    autoContinueWeights: autoContinue.weights,
    imagePath: playback.currentTrack?.image_url || null,
    onPause: playback.handlePause,
    onStop: playback.handleStop,
    onNext: handleNext,
    onPrevious: queueHook.playPrevious,
    onSeek: playback.handleSeek,
    onVolume: playback.handleVolume,
    onMute: playback.toggleMute,
    onToggleQueueMode: queueHook.toggleQueueMode,
    onRandomize: queueHook.randomizeQueue,
    queueLength: queueHook.queue.length,
    onToggleAutoContinue: () => autoContinue.setEnabled(!autoContinue.enabled),
    onToggleAutoContinueSameFormat: () => autoContinue.setSameFormat(!autoContinue.sameFormat),
    onToggleAutoContinuePopover: () => autoContinue.setShowPopover(!autoContinue.showPopover),
    onAdjustAutoContinueWeight: autoContinue.adjustWeight,
    onResetAutoContinueWeights: autoContinue.resetWeights,
    onCloseAutoContinuePopover: () => autoContinue.setShowPopover(false),
    onToggleLike: () => { if (playback.currentTrack) likeActions.handleToggleLike(playback.currentTrack); },
    onToggleDislike: () => { if (playback.currentTrack) likeActions.handleToggleDislike(playback.currentTrack); },
    showQueue: !queueCollapsed,
    onToggleQueue: handleToggleQueueCollapsed,
    hasSubtitles: !!videoSyncedLyricLines,
    subtitlesOn: videoSubtitlesOn,
    onToggleSubtitles: handleToggleSubtitles,
    onNavigateToArtistByName: library.navigateToArtistByName,
    onNavigateToAlbumByName: (name: string, artistName?: string | null) =>
      library.navigateToAlbumByName(name, artistName ?? undefined),
    nativeVideoActive: playback.nativeVideoActive,
    eq: eqControls,
    resolvedSource,
  };

  // Object prop for the bar's mini-search panel — memoized on its value
  // members (state, stable between changes) with pinned callback identities,
  // so its identity only changes when the panel's data actually changes.
  const npBarMiniSearch = useMemo(() => ({
    isOpen: miniSearch.isOpen,
    query: miniSearch.query,
    results: miniSearch.results,
    items: miniSearch.items,
    highlightedIndex: miniSearch.highlightedIndex,
    onQueryChange: npBar.onMiniSearchQueryChange,
    onKeyDown: npBar.onMiniSearchKeyDown,
    onResultClick: npBar.onMiniSearchResultClick,
  }), [miniSearch.isOpen, miniSearch.query, miniSearch.results, miniSearch.items, miniSearch.highlightedIndex, npBar]);

  return (
    <VideoFrameQueueProvider>
    <VideoFrameQueueRefBridge refOut={videoFrameQueueRef} />
    <div className={`app ${appRestoring ? "app-restoring" : ""} ${playback.currentTrack && isVideoTrack(playback.currentTrack) ? "video-mode" : ""} ${playback.nativeVideoActive ? "mpv-video-hole" : ""} ${playback.nativeVideoActive && videoTheater ? "mpv-hole-theater" : ""} ${playback.nativeVideoActive && videoReady && playback.nativeVideoPresenting ? "mpv-video-ready" : ""} ${playback.nativeFullscreen ? "mpv-native-fs" : ""} queue-open ${queueCollapsed ? "queue-collapsed" : ""} ${mini.miniMode ? "mini-mode" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${videoInQueue ? "video-in-queue" : ""} ${audioFullscreen ? "audio-fs-open" : ""} ${audioFullscreen && fsQueueRevealed ? "fs-queue-revealed" : ""}`} style={{ "--queue-width": `${queueWidth}px`, "--video-queue-size": `${videoLayout.sizes.queue}px` } as React.CSSProperties}>
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
        onProgress={playback.onMediaProgress}
        onWaiting={playback.onMediaWaiting}
        onPlaying={playback.onMediaPlaying}
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
        onProgress={playback.onMediaProgress}
        onWaiting={playback.onMediaWaiting}
        onPlaying={playback.onMediaPlaying}
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
        updateBadge={updateBadgeFor(updater.updateState)}
        collectionAlertLabel={collectionAlert(library.collections)}
        extensionUpdateCount={extensionsHook.updateCount}
        pluginNavItems={plugins.sidebarItems}
        badgeMap={mergedBadgeMap}
        onPluginView={handleOpenPluginView}
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

      {deepLinkMusicSource && (
        <AddMusicSourceModal
          name={deepLinkMusicSource.name}
          url={deepLinkMusicSource.url}
          onCancel={() => setDeepLinkMusicSource(null)}
          onConfirm={async () => {
            const { name, url } = deepLinkMusicSource;
            setDeepLinkMusicSource(null);
            let fallbackName = url;
            try {
              fallbackName = new URL(url).host || url;
            } catch {
              // Unparseable URL — fall back to the raw string as the name.
            }
            try {
              await invoke<Collection>("add_collection", {
                kind: "manifest",
                name: name.trim() || fallbackName,
                url,
              });
              // Initial sync runs in the background; sync-complete reloads the
              // library. Reload now too so the new (empty) source shows at once.
              library.loadLibrary();
              library.loadTracks();
            } catch (e) {
              // The manifest was validated server-side; on failure nothing was
              // added, so inform the user instead of silently leaving a dead card.
              console.error("Failed to add music source:", e);
              setAddSourceError(String(e));
            }
          }}
        />
      )}

      {showAddMusicSource && (
        <PromptModal
          title="Add music source"
          label="Paste the URL of a music manifest (JSON). Its tracks will appear in your library and search, and refresh automatically."
          placeholder="https://example.com/manifest.json"
          okLabel="Add source"
          onCancel={() => setShowAddMusicSource(false)}
          onSubmit={async (url) => {
            setShowAddMusicSource(false);
            let name = url;
            try {
              name = new URL(url).host || url;
            } catch {
              // Unparseable URL — fall back to the raw string as the name.
            }
            try {
              await invoke<Collection>("add_collection", { kind: "manifest", name, url });
              library.loadLibrary();
              library.loadTracks();
            } catch (e) {
              // Manifest is validated before the collection is created, so on
              // failure nothing was added — tell the user what went wrong.
              console.error("Failed to add music source:", e);
              setAddSourceError(String(e));
            }
          }}
        />
      )}

      {addSourceError && (
        <AlertModal
          title="Couldn't add music source"
          message={addSourceError}
          dismissVariant="primary"
          onDismiss={() => setAddSourceError(null)}
        />
      )}

      {publishTarget && (
        <PublishSourceModal
          trackIds={publishTarget.trackIds}
          collectionId={publishTarget.collectionId}
          defaultName={publishTarget.defaultName}
          trackCount={publishTarget.trackCount}
          onClose={() => setPublishTarget(null)}
        />
      )}

      {/* Caption bar - full width */}
      <CaptionBar
        centralSearch={centralSearch}
        searchInputRef={searchInputRef}
        getAlbumImage={albumImageCache.getImage}
        getArtistImage={artistImageCache.getImage}
        pluginViews={pluginViewList}
        onOpenPluginView={handleOpenPluginView}
        onToggleMiniMode={mini.toggleMiniMode}
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
      <main className="main" data-dock={videoPlaying && videoLayout.dockSide !== "queue" ? videoLayout.dockSide : undefined}>
        {/* Content area */}
        <div className="content" ref={contentRef} style={videoPlaying && videoLayout.dockSide !== "queue" ? (videoLayout.isHorizontal ? { minHeight: 150 } : { minWidth: 150 }) : undefined}>
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
                isCurrentTrack={false}
                onPlay={() => queueHook.playTracks([syntheticTrack], 0)}
                onPlayAt={() => {}}
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
            <ArtistDetail
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

          {/* Home view — always mounted to preserve state and avoid re-fetching
              on revisit; frozen while hidden so it doesn't reconcile on every
              App render (see FreezeWhileHidden). */}
          <FreezeWhileHidden hidden={view !== "home"}>
          <HomeView
            style={{ display: view === "home" ? undefined : "none" }}
            isVisible={view === "home"}
            pluginShelves={plugins.homeShelves}
            pluginsLoaded={plugins.pluginsLoaded}
            activePluginIds={activePluginIds}
            invokePluginShelf={plugins.invokeHomeShelf}
            restoredRef={restoredRef}
            libraryRevision={libraryRevision}
            onShelfItemClick={handleHomeShelfItemClick}
            onShelfItemPlay={handleHomeShelfItemPlay}
            onShelfItemContextMenu={handleHomeShelfItemContextMenu}
            collectionCount={library.collections.length}
            onboardingProfile={onboardingProfile}
            pluginViews={pluginViewList}
            onOpenPluginView={handleOpenPluginView}
            indexing={
              resyncProgress
                ? {
                    collectionName: resyncProgress.collectionName,
                    kind: resyncProgress.kind,
                    scanned: resyncProgress.scanned,
                    total: resyncProgress.total,
                  }
                : null
            }
            onAddFolder={handleAddFolder}
            onConnectServer={() => setShowAddServer(true)}
            onBrowseExtensions={() => library.setView("extensions")}
            onRunSetup={() => setShowOnboarding(true)}
          />
          </FreezeWhileHidden>

          {/* Search view — always mounted to preserve state and scroll position;
              frozen while hidden. Its deleted-track/tag batches accumulate (and
              SearchView slices off the unprocessed tail) so deletes made from
              other views while this is frozen are not lost — see the producers. */}
          <FreezeWhileHidden hidden={view !== "search"}>
          <SearchView
            style={{ display: view === "search" ? undefined : "none" }}
            isVisible={view === "search"}
            hasPluginViews={pluginViewList.length > 0}
            initialQuery={searchInitialQuery}
            initialQueryKey={searchQueryKey}
            libraryRefreshKey={searchLibraryKey}
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
          </FreezeWhileHidden>

          {/* Now Playing view. Dropped entirely while the fullscreen overlay is
              up: that overlay renders this same component, and two live copies
              would each run the tag lookup and each hold a visualizer instance —
              the second painting behind an opaque surface, since the slot's
              IntersectionObserver still counts it as on screen. */}
          {view === "nowplaying" && !audioFullscreen && (
            <NowPlayingView
              track={playback.currentTrack}
              lyrics={nowPlayingLyrics}
              getAlbumImage={albumImageCache.getImage}
              getArtistImage={artistImageCache.getImage}
              isAlbumImageResolved={albumImageCache.isResolved}
              isArtistImageResolved={artistImageCache.isResolved}
              onSeek={playback.handleSeek}
              onOpenVisualizerPicker={openVisualizerPicker}
              onToggleLyrics={() => setNowPlayingLyricsHidden((v) => !v)}
              onToggleFullscreen={canAudioFullscreen ? toggleAudioFullscreen : undefined}
              lyricsOffsetSecs={lyricsOffsetSecs}
              onLyricsOffsetChange={handleLyricsOffsetChange}
              lyricsHidden={nowPlayingLyricsHidden}
              visualizerSlot={
                nowPlayingVisualizer
                  ? renderVisualizerSlot("nowplaying", nowPlayingVisualizer)
                  : undefined
              }
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
              <HistoryView ref={historyRef} searchQuery={viewSearch.getQuery("history")} highlightedIndex={highlightedListIndex} onPlayTrack={queueHook.playTracks} onEnqueueTrack={contextMenuActions.handleEnqueue} onLocateTrack={(t) => library.handleTrackClick(t.key)} onArtistClick={library.handleArtistClick} onPlayArtist={playActions.playArtist} onEnqueueArtist={playActions.enqueueArtist} onStartRadio={contextMenuActions.startRadio} onShowContextMenu={(x, y, target) => buildAndShowNativeMenu({ x, y, target })} />
            </>
          )}

          {/* Playlists view */}
          {view === "playlists" && (
            <PlaylistsView
              searchQuery={viewSearch.getQuery("playlists")}
              onSearchChange={(q) => viewSearch.setQuery("playlists", q)}
              onPlayTracks={queueHook.playTracks}
              onEnqueueTracks={queueHook.enqueueTracks}
              onStartRadio={contextMenuActions.startRadio}
              onLocateTrack={(title, artistName, albumName) => library.navigateToTrackByName(title, artistName ?? undefined, albumName ?? undefined).catch(console.error)}
              onExportAsMixtape={handleExportAsMixtapeDirect}
              pluginMenuItems={plugins.menuItems}
              onPluginAction={plugins.dispatchContextMenuAction}
              onTrackDragStart={contextMenuActions.handleTrackDragStart}
              onToggleLike={likeActions.handleToggleLike}
              onToggleDislike={likeActions.handleToggleDislike}
            />
          )}

          {/* Song Quiz view — mounted only while visible so its snippet audio
              stops the moment the user navigates away */}
          {view === "quiz" && (
            <MusicQuizView
              onPauseMainPlayback={() => { if (playback.playing) playback.handlePause(); }}
              volume={playback.volume}
            />
          )}

          {/* Collections view */}
          {view === "collections" && (
            <CollectionsView
              collections={library.collections.filter(c => ["local", "subsonic", "seed", "manifest"].includes(c.kind))}
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
              onAddMusicSource={() => setShowAddMusicSource(true)}
              onPublish={(c) => setPublishTarget({ collectionId: c.id, defaultName: c.name })}
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
                playing={playback.playing}
                onPlayTrack={(track) => {
                  queueHook.playTracks([track], 0);
                }}
                onAction={(actionId, actionData) => {
                  plugins.dispatchUIAction(pluginId, actionId, actionData);
                }}
                onTrackContextMenu={(e, track) => {
                  buildAndShowNativeMenu({ x: e.clientX, y: e.clientY, target: { kind: "track", trackId: track.id ?? undefined, isLocal: isLocalTrack(track), title: track.title, artistName: track.artist_name, albumTitle: track.album_title ?? null } });
                }}
                onTrackRowContextMenu={(e, items) => {
                  // Metadata-only rows (no DB id) → act directly on synthesized
                  // QueueTracks (the id-based context-menu Play/Enqueue would no-op).
                  const qts = items.map((it) => pluginTrackToQueueTrack({
                    path: it.path ?? null,
                    title: it.title,
                    artist_name: it.artistName ?? null,
                    album_title: it.albumTitle ?? null,
                    duration_secs: it.durationSecs ?? null,
                    image_url: it.imageUrl,
                    kind: it.kind,
                  }));
                  if (qts.length === 0) return;
                  const n = qts.length;
                  const specs: MenuItemSpec[] = [
                    { kind: "item", text: n > 1 ? `Play ${n} tracks` : "Play", action: () => queueHook.playTracks(qts, 0) },
                    { kind: "item", text: n > 1 ? `Enqueue ${n} tracks` : "Enqueue", action: () => contextMenuActions.handleEnqueue(qts as unknown as Track[]) },
                    { kind: "item", text: "Play Next", action: () => { for (let i = qts.length - 1; i >= 0; i--) queueHook.playNextInQueue(qts[i]); } },
                  ];
                  // Append plugin-registered actions (Universal Track Actions). A
                  // single row carries metadata for plugins to act on; a multi-row
                  // selection has no DB ids so only the queue actions above apply.
                  if (n === 1) {
                    const first = items[0];
                    const target = { kind: "track" as const, title: first.title, artistName: first.artistName ?? null, albumTitle: first.albumTitle ?? null, isLocal: isLocalTrack(qts[0]) };
                    const matching = plugins.menuItems.filter((mi) => mi.targets.includes("track"));
                    const pluginSpecs = buildPluginMenuSpecs(matching, toPluginTarget(target), plugins.dispatchContextMenuAction);
                    if (pluginSpecs.length > 0) { specs.push({ kind: "separator" }, ...pluginSpecs); }
                  }
                  showNativeMenu(e.clientX, e.clientY, specs);
                }}
                onTrackRowsDragStart={(items) => {
                  const qts = items.map((it) => pluginTrackToQueueTrack({
                    path: it.path ?? null,
                    title: it.title,
                    artist_name: it.artistName ?? null,
                    album_title: it.albumTitle ?? null,
                    duration_secs: it.durationSecs ?? null,
                    image_url: it.imageUrl,
                    kind: it.kind,
                  }));
                  if (qts.length > 0) contextMenuActions.handleTrackDragStart(qts as unknown as Track[]);
                }}
                pluginMenuItems={plugins.menuItems}
                onPluginAction={plugins.dispatchContextMenuAction}
              />
            );
          })()}
          {/* Extensions view */}
          {/* Extensions — always mounted (display toggle) so it doesn't remount
              and re-fetch the gallery on every open; fetch is gated on isVisible.
              Frozen while hidden (see FreezeWhileHidden). */}
          <FreezeWhileHidden hidden={view !== "extensions"}>
          <ExtensionsView
              style={{ display: view === "extensions" ? undefined : "none" }}
              isVisible={view === "extensions"}
              allExtensions={extensionsHook.allExtensions}
              updateCount={extensionsHook.updateCount}
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
              onNotify={notify}
              busy={extensionsHook.busyMessage !== null}
              galleryPlugins={plugins.galleryPlugins || []}
              gallerySkins={skins.gallerySkins || []}
              getPluginViewData={plugins.getViewData}
              onPluginAction={plugins.dispatchUIAction}
              contributions={plugins.contributions}
              contributionVisibility={plugins.contributionVisibility}
              onSetContributionEnabled={plugins.setContributionEnabled}
              pluginGalleryLoading={plugins.galleryLoading}
              pluginGalleryError={plugins.galleryError}
              skinGalleryLoading={skins.galleryLoading}
              skinGalleryError={skins.galleryError}
              onPreviewSkin={(id) => {
                if (!id) { skins.clearPreview(); return; }
                const s = skins.installedSkins.find((x) => x.id === id);
                if (s) skins.previewSkin(s);
                else skins.clearPreview();
              }}
              onCreateSkin={() => {
                skins.createSkin().then((res) => {
                  notify(res.ok
                    ? "New skin created — opening it in your editor"
                    : `Couldn't create skin: ${res.error}`);
                }).catch((e) => console.error("Failed to create skin:", e));
              }}
              onOpenSkinInEditor={(id) => { skins.openSkinInEditor(id).catch((e) => console.error("Failed to open skin in editor:", e)); }}
              onRefreshSkin={(id) => skins.refreshSkin(id)}
              onSubmitSkin={(id) => skins.submitSkin(id)}
              pluginViewMode={pluginViewMode}
              onSetPluginViewMode={handlePluginViewModeChange}
            />
          </FreezeWhileHidden>
          {/* Settings view */}
          {view === "settings" && (
            <SettingsPanel
              onSeedDatabase={handleSeedDatabase}
              onClearDatabase={handleClearDatabase}
              clearing={clearing}
              onClearImageFailures={handleClearImageFailures}
              crossfadeSecs={crossfadeSecs}
              onCrossfadeChange={handleCrossfadeChange}
              mpvCapable={mpvCapable}
              mpvProbed={mpvProbed}
              engineComponent={engineComponent.status}
              engineComponentInstalling={engineComponent.installing}
              onEngineComponentInstall={engineComponent.install}
              onEngineComponentUninstall={engineComponent.uninstall}
              playbackEngine={playbackEngine}
              onPlaybackEngineChange={handlePlaybackEngineChange}
              audioExclusive={audioExclusive}
              onAudioExclusiveChange={handleAudioExclusiveChange}
              eqEnabled={playback.eqEnabled}
              volume={playback.volume}
              betaUpdates={betaUpdates}
              onBetaUpdatesChange={handleBetaUpdatesChange}
              telemetryEnabled={telemetryEnabled}
              onTelemetryEnabledChange={handleTelemetryEnabledChange}
              rgMode={playback.rgMode}
              onRgModeChange={playback.setRgMode}
              rgPreampDb={playback.rgPreampDb}
              onRgPreampDbChange={playback.setRgPreampDb}
              rgPreventClip={playback.rgPreventClip}
              onRgPreventClipChange={playback.setRgPreventClip}
              trackVideoHistory={trackVideoHistory}
              onTrackVideoHistoryChange={handleTrackVideoHistoryChange}
              preferVideoResolution={preferVideoResolution}
              playbackRate={playback.playbackRate}
              onPlaybackRateChange={playback.setPlaybackRate}
              nowPlayingVisualizers={candidatesFor(plugins.visualizers, "nowplaying").map(v => ({ key: visualizerKey(v), name: v.name }))}
              nowPlayingVisualizer={nowPlayingVisualizer}
              onNowPlayingVisualizerChange={(key) => setVisualizerSlots(prev => ({ ...prev, nowplaying: key }))}
              onPreferVideoResolutionChange={handlePreferVideoResolutionChange}
              minimizeToMiniPlayer={minimizeToMiniPlayer}
              onMinimizeToMiniPlayerChange={handleMinimizeToMiniPlayerChange}
              confirmTrashDelete={confirmTrashDelete}
              onConfirmTrashDeleteChange={handleConfirmTrashDeleteChange}
              reduceMotion={reduceMotion}
              onReduceMotionChange={handleReduceMotionChange}
              uiZoom={zoom.uiZoom}
              onUiZoomChange={handleUiZoomChange}
              miniZoom={zoom.miniZoom}
              onMiniZoomChange={handleMiniZoomChange}
              nowPlayingInfo={nowPlayingInfoSettings}
              scrollToId={settingsScrollTarget}
              onScrolledToId={() => setSettingsScrollTarget(null)}
              appVersion={updater.appVersion}
              updateState={updater.updateState}
              onCheckForUpdates={updater.handleCheckForUpdates}
              onInstallUpdate={updater.handleInstallUpdate}
              onDismissUpdateError={updater.dismissUpdateError}
              onRunSetupWizard={() => setShowOnboarding(true)}
              backendTimings={backendTimings}
              frontendTimings={getTimingEntries()}
              onFetchBackendTimings={() =>
                invoke<TimingEntry[]>("get_startup_timings")
                  .then((entries) => setBackendTimings(entries ?? []))
                  .catch((e) => console.error("Failed to fetch startup timings:", e))
              }
              pluginStates={plugins.pluginStates}
              loggingEnabled={loggingEnabled}
              onLoggingEnabledChange={handleLoggingEnabledChange}
              debugLogging={debugLogging}
              onDebugLoggingChange={handleDebugLoggingChange}
              debugMode={debugMode}
              onDebugModeChange={handleDebugModeChange}
              onReportProblem={(report) => setReportProblem(report ?? { title: "Bug report", context: null })}
              devPluginPath={devPluginPath}
              onDevPluginPathChange={handleDevPluginPathChange}
              onReloadPlugins={plugins.reloadAllPlugins}
              onOpenQuiz={() => openQuizRef.current()}
              onSwitchProfile={(name) => profileSwitch.switchToProfile(name)}
              onNotify={notify}
              onStreamResolverOrderChanged={() => setStreamResolverOrderVersion(v => v + 1)}
              dependencies={dependencies}
              autoUpdateManagedDeps={autoUpdateManagedDeps}
              onAutoUpdateManagedDepsChange={handleAutoUpdateManagedDepsChange}
            />
          )}
          </>}
          </DetailViewProvider>
        </div>

        {/* Video splitter + player area (below content, above now-playing).
            The queue placement pins the video to the queue column instead, so
            the in-main splitter is suppressed there (it has its own handle). */}
        {videoPlaying && view !== "nowplaying" && videoLayout.dockSide !== "queue" && (
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
              {/* Double chevron points the way the video moves on click: expanded \u2192 toward the
                  dock edge (collapse away), collapsed \u2192 toward the content (expand back in). The
                  base glyph points down (0\u00B0); rotate per dock side, +180\u00B0 when collapsed \u2014 so a
                  single SVG serves both the horizontal (top/bottom) and vertical (left/right) bars. */}
              <svg
                className="splitter-collapse-chevron"
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                style={{ transform: `rotate(${{ bottom: 0, top: 180, left: 90, right: -90, queue: 0 }[videoLayout.dockSide] + (videoLayout.isCollapsed ? 180 : 0)}deg)` }}
              >
                <path
                  d="M3.5 8.5L8 12L12.5 8.5M3.5 4L8 7.5L12.5 4"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}
        <div
          className={`video-container${videoLayout.isCollapsed && !videoInQueue ? " collapsed" : ""}${videoTheater ? " video-container--theater" : ""}${playback.nativeFullscreen ? " video-container--native-fs" : ""}${videoInQueue ? " video-container--in-queue" : ""}`}
          data-fit={videoLayout.fitMode}
          onContextMenu={(e) => {
            e.preventDefault();
            const ct = playback.currentTrack;
            buildAndShowNativeMenu({ x: e.clientX, y: e.clientY, target: {
              kind: "video",
              dockSide: videoLayout.dockSide,
              fitMode: videoLayout.fitMode,
              track: ct ? {
                key: ct.key,
                path: ct.path,
                title: ct.title,
                artistName: ct.artist_name,
                albumTitle: ct.album_title ?? null,
                durationSecs: ct.duration_secs,
                isLocal: isLocalTrack(ct),
              } : undefined,
            } });
          }}
          style={{
            // Hide entirely when the "queue" placement is chosen but the queue
            // is collapsed (no room) — falling back into the main flow would be
            // confusing. The queue overlay itself is CSS-driven (--in-queue).
            display: !videoPlaying
              ? 'none'
              : (videoLayout.dockSide === "queue" && !videoInQueue && !videoTheater && !playback.nativeFullscreen)
              ? 'none'
              : undefined,
            ...(videoTheater || videoInQueue
              ? {}
              : videoLayout.isHorizontal
              ? { height: videoLayout.isCollapsed ? 0 : videoLayout.videoSize }
              : { width: videoLayout.isCollapsed ? 0 : videoLayout.videoSize }),
          }}
        >
          {videoInQueue && (
            <div
              className="video-queue-resize"
              onMouseDown={videoLayout.onQueueResizeMouseDown}
              title="Drag to resize"
            />
          )}
          <video
            ref={playback.videoRef}
            tabIndex={-1}
            onTimeUpdate={playback.onTimeUpdate}
            onLoadedMetadata={playback.onLoadedMetadata}
            onPlay={playback.onPlay}
            onPause={playback.onPause}
            onError={playback.onMediaError}
            onProgress={playback.onMediaProgress}
            onWaiting={playback.onMediaWaiting}
            onPlaying={playback.onMediaPlaying}
            onClick={playback.handlePause}
            onDoubleClick={playback.toggleFullscreen}
          />
          {/* One subtitle layer for every video mode — the container is only
              repositioned (never remounted), so this serves the docked preview,
              the theater, and fullscreen alike. */}
          {videoSubtitlesOn && videoSyncedLyricLines && (
            <VideoSubtitles lines={videoSyncedLyricLines} offsetSecs={lyricsOffsetSecs} />
          )}
          {!videoTheater && (
            <div className="video-dock-actions">
              {videoSyncedLyricLines && (
                <button
                  className={`video-dock-btn${videoSubtitlesOn ? "" : " is-off"}`}
                  onClick={handleToggleSubtitles}
                  title={videoSubtitlesOn ? "Hide subtitles" : "Show subtitles"}
                  aria-label={videoSubtitlesOn ? "Hide subtitles" : "Show subtitles"}
                  aria-pressed={videoSubtitlesOn}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <path d="M7 14.5a2 2 0 0 1 0-4" />
                    <path d="M15 14.5a3 3 0 0 1 0-4" />
                  </svg>
                </button>
              )}
              <button
                className="video-dock-btn"
                onClick={() => {
                  library.setView("nowplaying");
                  library.setSelectedArtist(null);
                  library.setSelectedAlbum(null);
                  library.setSelectedTag(null);
                  library.setSelectedTrack(null);
                }}
                title="Now Playing"
                aria-label="Switch to Now Playing"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="6" width="18" height="12" rx="2" />
                </svg>
              </button>
              <button
                className="video-dock-btn"
                onClick={playback.toggleFullscreen}
                title="Fullscreen (F)"
                aria-label="Enter fullscreen"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </button>
            </div>
          )}
          {/* The video fullscreen's control bar. The audio fullscreen renders the
              same component from the same `fullscreenControlsProps`, which is what
              makes the two surfaces identical rather than merely similar — see the
              AudioFullscreen render near the app root. */}
          {/* `active` is needed for the NATIVE (mpv) video fullscreen, which is
              window fullscreen and so has no DOM `:fullscreen` element — the bar
              is revealed by `.video-container--native-fs`, but the idle auto-hide
              and cursor-hiding are gated on the flag, so without this they never
              armed and the controls sat permanently over the video. The browser
              engine's DOM fullscreen is detected on its own. */}
          <FullscreenControls
            {...fullscreenControlsProps}
            onToggleFullscreen={playback.toggleFullscreen}
            active={playback.nativeFullscreen}
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
              lyricsOffsetSecs={lyricsOffsetSecs}
              onLyricsOffsetChange={handleLyricsOffsetChange}
              onToggleFullscreen={playback.toggleFullscreen}
              syncedLyricLines={videoSyncedLyricLines}
              subtitlesOn={videoSubtitlesOn}
              onToggleSubtitles={handleToggleSubtitles}
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
          onTogglePlayPause={playback.handlePause}
          onRemove={queueHook.removeFromQueue}
          onLocateTrack={(track) => {
            library.handleTrackClick(track.key);
          }}
          onStartRadio={(track) => contextMenuActions.startRadio({ title: track.title, artistName: track.artist_name, coverPath: track.image_url ?? null })}
          onMoveMultiple={queueHook.moveMultiple}
          onClear={queueHook.clearQueue}
          onSaveAsM3U={queueHook.savePlaylist}
          onSaveToPlaylists={handleSaveAsPlaylist}
          onExportAsMixtape={handleQueueExportAsMixtape}
          onLoadPlaylist={() => queueHook.loadPlaylist(setMixtapePreviewPath)}
          onPublishQueue={handlePublishQueue}
          preferVideoResolution={preferVideoResolution}
          onPreferVideoResolutionChange={handlePreferVideoResolutionChange}
          onContextMenu={(e, indices) => {
            const tracks = indices.map(i => queueHook.queue[i]).filter(Boolean);
            const first = tracks[0];
            buildAndShowNativeMenu({ x: e.clientX, y: e.clientY, target: {
              kind: "queue-multi", indices,
              trackIds: tracks.map(t => parseLibraryId(t.key)).filter((id): id is number => id != null),
              firstTrack: first ? { title: first.title, artistName: first.artist_name, albumTitle: first.album_title ?? null, isLocal: isLocalTrack(first) } : { title: "", artistName: null, albumTitle: null, isLocal: false },
            } });
          }}
          onToggleLike={likeActions.handleToggleLike}
          onToggleDislike={likeActions.handleToggleDislike}
          externalDropTarget={contextMenuActions.externalDropTarget}
          collapsed={queueCollapsed}
          onToggleCollapsed={handleToggleQueueCollapsed}
          onResizeWidth={handleResizeQueueWidth}
          isPlaying={playback.playing}
          debugMode={debugMode}
          mainPlaylistDir={mainPlaylistDir}
          thumbInfo={queueHook.thumbInfo}
          resolvingStatus={resolvingStatus}
          backfillPending={queueHook.backfillPending}
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



      {showOnboarding && (() => {
        const lastfmState = plugins.pluginStates.find((p) => p.id === "lastfm");
        const lastfmPanelId = lastfmState?.manifest.contributes?.settingsPanel?.id;
        return (
          <OnboardingWizard
            skins={skins}
            collections={library.collections}
            onCollectionAdded={() => library.loadLibrary()}
            galleryPlugins={plugins.galleryPlugins}
            installedPluginIds={new Set(plugins.pluginStates.map((p) => p.id))}
            onFetchGallery={() => plugins.fetchPluginGallery(true)}
            onInstallPlugin={(entry) => plugins.installFromGallery(entry)}
            onEnablePlugin={(id) => plugins.togglePlugin(id, true)}
            lastfmInstalled={!!lastfmState}
            lastfmActive={lastfmState?.status === "active"}
            lastfmPanelData={lastfmPanelId ? plugins.getViewData("lastfm", lastfmPanelId) : undefined}
            onLastfmAction={(actionId, data) => plugins.dispatchUIAction("lastfm", actionId, data)}
            deps={dependencies.deps}
            depInstalling={dependencies.installing}
            onInstallDep={dependencies.installDep}
            onRecheckDeps={() =>
              dependencies
                .checkAll(true)
                .then(() => undefined)
                .catch((e) => {
                  console.error("Failed to recheck dependencies:", e);
                })
            }
            crossfadeSecs={crossfadeSecs}
            onCrossfadeChange={handleCrossfadeChange}
            autoContinueEnabled={autoContinue.enabled}
            onAutoContinueEnabledChange={autoContinue.setEnabled}
            trackVideoHistory={trackVideoHistory}
            onTrackVideoHistoryChange={handleTrackVideoHistoryChange}
            resyncProgress={resyncProgress}
            resyncComplete={resyncComplete}
            initialProfile={onboardingProfile}
            onClose={handleOnboardingClose}
          />
        );
      })()}
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
          store={store}
          lastDest={lastDownloadDest}
          onSearch={(query, limit) => {
            const parts = downloadModal.providerId.split(":");
            return plugins.invokeInteractiveSearch(parts[0], parts.slice(1).join(":"), query, limit);
          }}
          onResolve={(matchId, format, onProgress) => {
            const parts = downloadModal.providerId.split(":");
            return plugins.invokeInteractiveResolve(parts[0], parts.slice(1).join(":"), matchId, format, onProgress);
          }}
          onCancelResolve={() => {
            // The provider id is `${pluginId}:${providerId}`; the plugin id is
            // what owns the running subprocesses. Built-in providers resolve in
            // milliseconds and have no plugin, so this is simply a no-op there.
            const pluginId = downloadModal.providerId.split(":")[0];
            if (pluginId && pluginId !== "__builtin") plugins.cancelDownloadResolve(pluginId);
          }}
          onClose={() => setDownloadModal(null)}
          onComplete={(_msg) => { setDownloadModal(null); library.loadLibrary(); library.loadTracks(); }}
          onPlay={async (path) => {
            const uri = `file://${path}`;
            try {
              await library.loadTracks();
              // Look the row up by URI rather than scanning the whole library —
              // get_tracks_by_paths matches on the same reconstructed path
              // expression the DB uses everywhere else.
              const [match] = await invoke<Track[]>("get_tracks_by_paths", { paths: [uri] });
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
          onSave={handleBulkEditSaved}
        />
      )}

      {contextMenuActions.deleteConfirm && (
        <DeleteTracksModal
          title={contextMenuActions.deleteConfirm.title}
          trackCount={contextMenuActions.deleteConfirm.trackIds.length}
          trashLabel={trashLabel}
          network={contextMenuActions.deleteConfirm.network}
          onSuppressConfirm={() => handleConfirmTrashDeleteChange(false)}
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
              // Accumulated, not replaced — same freeze-safety reasoning as
              // onTracksDeleted's searchDeletedBatch.
              setSearchDeletedTagBatch(prev => ({ ids: [...prev.ids, ...deletedIds], key: prev.key + 1 }));
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

      {profileSwitch.switching && (
        <ProfileSwitchOverlay profile={profileSwitch.switching} mini={mini.miniMode} />
      )}

      {playback.playbackError && !mini.miniMode && (
        <PlaybackErrorModal
          error={playback.playbackError}
          trackTitle={playback.failedTrack?.title ?? null}
          onDismiss={() => { pendingMpvRetryRef.current = null; playback.clearPlaybackError(); }}
          onSkip={() => { pendingMpvRetryRef.current = null; playback.clearPlaybackError(); handleNext(); }}
          onReportProblem={() => setReportProblem({
            title: "Playback failed",
            context: {
              title: "Playback failure",
              lines: [
                `Error: ${playback.playbackError}`,
                `Source: ${sourceClass(playback.failedTrack?.path ?? null)}`,
                `Format: ${playback.failedTrack?.format ?? "unknown"}`,
                `Engine: ${mpvCapable && playbackEngine === "native" ? "native" : "browser"}`,
              ],
            },
          })}
          mpvSuggestion={
            isFormatPlaybackError(playback.playbackError)
              && !(mpvCapable && playbackEngine === "native")
              && (mpvCapable || (engineComponent.status?.available ?? false))
              ? {
                  needsInstall: !mpvCapable,
                  installing: engineComponent.installing !== null,
                  onEnable: handleEnableMpvAndRetry,
                }
              : null
          }
        />
      )}

      {reportProblem && (
        <ReportProblemModal
          sources={buildDiagnosticSources(reportProblem.context)}
          issueTitle={reportProblem.title}
          onClose={() => setReportProblem(null)}
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
        <PluginLoadingModal
          message={extensionsHook.busyMessage}
          // Only one extension operation runs at a time, so the single live
          // progress row (if any) is the one this modal is describing.
          progress={Object.values(extensionsHook.progress)[0] ?? null}
        />
      )}

      {extensionsHook.resultModal && (
        <AlertModal
          title={extensionsHook.resultModal.title}
          message={extensionsHook.resultModal.message}
          dismissVariant="primary"
          onDismiss={extensionsHook.dismissResult}
        />
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
          defaultImage={savePlaylistDefaultCover}
          onSave={handleSavePlaylistConfirm}
          onClose={() => setShowSavePlaylistModal(false)}
        />
      )}

      {editQueueTrack && (
        <EditTrackMetadataModal
          defaultTitle={editQueueTrack.title}
          defaultArtist={editQueueTrack.artist}
          defaultAlbum={editQueueTrack.album}
          info={editQueueTrack.info}
          onSave={handleEditQueueTrackSave}
          onClose={() => setEditQueueTrack(null)}
        />
      )}

      <NowPlayingBar
        waveformPeaks={waveformPeaks}
        storyboard={storyboard}
        currentTrack={playback.currentTrack}
        nativeVideoActive={playback.nativeVideoActive}
        playing={playback.playing}
        durationSecs={playback.durationSecs}
        scrobbled={playback.scrobbled}
        icyTitle={playback.icyTitle}
        trackRank={trackRank}
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
        onCancelCollapseTimer={npBar.onCancelCollapseTimer}
        onBeginMiniDrag={npBar.onBeginMiniDrag}
        onCycleRestingSize={npBar.onCycleRestingSize}
        onCycleMiniWidth={npBar.onCycleMiniWidth}
        onToggleMiniMode={npBar.onToggleMiniMode}
        onClose={npBar.onClose}
        onPause={npBar.onPause}
        onStop={npBar.onStop}
        onNext={npBar.onNext}
        onPrevious={npBar.onPrevious}
        onSeek={npBar.onSeek}
        onVolume={npBar.onVolume}
        onMute={npBar.onMute}
        eqEnabled={playback.eqEnabled}
        eqMode={playback.eqMode}
        eqPreset={playback.eqPreset}
        eqGains={playback.eqGains}
        eqPreGainDb={playback.eqPreGainDb}
        eqBassDb={playback.eqBassDb}
        eqTrebleDb={playback.eqTrebleDb}
        eqCustomPresets={eqCustomPresets}
        onEqEnabledChange={npBar.onEqEnabledChange}
        onEqModeChange={npBar.onEqModeChange}
        onEqPresetChange={npBar.onEqPresetChange}
        onEqGainChange={npBar.onEqGainChange}
        onEqPreGainChange={npBar.onEqPreGainChange}
        onEqBassChange={npBar.onEqBassChange}
        onEqTrebleChange={npBar.onEqTrebleChange}
        onEqResetAll={npBar.onEqResetAll}
        onEqSaveAs={npBar.onEqSaveAs}
        eqShowBarControl={playback.eqMode === "simple" ? eqShowBarControlSimple : eqShowBarControlAdvanced}
        onEqShowBarControlChange={npBar.onEqShowBarControlChange}
        onToggleFullscreen={npBar.onToggleFullscreen}
        canFullscreen={canFullscreen}
        onToggleQueueMode={npBar.onToggleQueueMode}
        onRandomize={npBar.onRandomize}
        queueLength={queueHook.queue.length}
        onToggleAutoContinue={npBar.onToggleAutoContinue}
        onToggleAutoContinueSameFormat={npBar.onToggleAutoContinueSameFormat}
        onToggleAutoContinuePopover={npBar.onToggleAutoContinuePopover}
        onAdjustAutoContinueWeight={npBar.onAdjustAutoContinueWeight}
        onResetAutoContinueWeights={npBar.onResetAutoContinueWeights}
        onCloseAutoContinuePopover={npBar.onCloseAutoContinuePopover}
        onToggleLike={npBar.onToggleLike}
        onToggleDislike={npBar.onToggleDislike}
        likeDisabled={likeBusy}
        onTrackClick={npBar.onTrackClick}
        onNavigateToArtistByName={npBar.onNavigateToArtistByName}
        onNavigateToAlbumByName={npBar.onNavigateToAlbumByName}
        onNavigateToTagByName={npBar.onNavigateToTagByName}
        resolvedSource={resolvedSource}
        loadingTrack={playback.loadingTrack}
        playbackError={playback.playbackError}
        onSkipError={npBar.onSkipError}
        onContextMenu={npBar.onContextMenu}
        nowPlayingInfo={nowPlayingInfoResolved}
        miniSearch={npBarMiniSearch}
        getAlbumImage={albumImageCache.getImage}
        getArtistImage={artistImageCache.getImage}
        onDownloadTrack={playback.currentTrack && downloadPlan ? npBar.onDownloadTrack : undefined}
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

      {/* Fullscreen for a non-video track. Mounted at the app root, not inside
          the Now Playing view, so it survives a view switch underneath it and
          pins over everything without inheriting the grid.
          The surface IS the Now Playing view — same backdrop, same
          visualizer-or-artwork stage, same lyrics, same corner buttons, just
          bigger and with the shared control bar under it. Which is why fullscreen
          works for anything playing rather than only for users who installed a
          visualizer: the fallback ladder is the one the view already had. */}
      {audioFullscreen && (
        <AudioFullscreen
          surface={
            <NowPlayingView
              variant="fullscreen"
              track={playback.currentTrack}
              lyrics={nowPlayingLyrics}
              getAlbumImage={albumImageCache.getImage}
              getArtistImage={artistImageCache.getImage}
              isAlbumImageResolved={albumImageCache.isResolved}
              isArtistImageResolved={artistImageCache.isResolved}
              onSeek={playback.handleSeek}
              onOpenVisualizerPicker={openVisualizerPicker}
              onToggleLyrics={() => setNowPlayingLyricsHidden((v) => !v)}
              // Same callback as the windowed view — the row keeps all three
              // buttons in both states, and this one just points the other way.
              onToggleFullscreen={toggleAudioFullscreen}
              lyricsOffsetSecs={lyricsOffsetSecs}
              onLyricsOffsetChange={handleLyricsOffsetChange}
              lyricsHidden={nowPlayingLyricsHidden}
              visualizerSlot={
                fullscreenVisualizer
                  ? renderVisualizerSlot("fullscreen", fullscreenVisualizer)
                  : undefined
              }
            />
          }
          controls={
            <FullscreenControls
              {...fullscreenControlsProps}
              // Exit stays: the restore button belongs at the right end of the
              // control bar in every fullscreen, so it is where the user last
              // saw it in the windowed bar. (It duplicates the surface's corner
              // row, which is fine — the corner row fades with the artwork and
              // the bar is the transport.)
              onToggleFullscreen={toggleAudioFullscreen}
              // Still dropped: the queue reveals itself at the right edge here,
              // so a Playlist button would be a second route to it. Video
              // fullscreen has no such gesture and still passes one.
              onToggleQueue={undefined}
              active
            />
          }
        />
      )}

      <Toasts toasts={toasts} onDismiss={dismissToast} />

      {fileDragOver && (
        <div className="file-drop-overlay" aria-hidden="true">
          <div className="file-drop-overlay-card">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 16V4M12 4l-4 4M12 4l4 4" />
              <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
            </svg>
            <span>Drop to add to your queue</span>
          </div>
        </div>
      )}

    </div>
    </VideoFrameQueueProvider>
  );
}

export default App;
