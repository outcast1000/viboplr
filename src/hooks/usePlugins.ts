import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { saveCueSheet } from "../utils/cueOps";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { subscribe, safeUnlisten } from "../utils/tauriEvents";
import { isExperimental } from "../utils/pluginStability";
import { semverSatisfies } from "../utils/semver";
import { recordPluginLog } from "../utils/pluginLog";
import { foldHeaderPairs, setCookieValues, type PluginHeaderPairs } from "../utils/pluginFetchHeaders";
import {
  filterContributions,
  listPluginContributions,
  type ContributionVisibility,
} from "../utils/pluginContributions";
import { getVersion } from "@tauri-apps/api/app";
import { audioDir, downloadDir, homeDir } from "@tauri-apps/api/path";
import { track as trackTelemetry } from "../telemetry";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { describeProgramDownload } from "../utils/programInstall";
import { store } from "../store";
import type { Track, QueueTrack, Collection } from "../types";
import { coerceToastKind, type NotifyOptions, type ToastAction } from "./useToasts";
import type {
  InstalledPlugin,
  PluginManifest,
  PluginState,
  PluginSidebarItem,
  PluginMenuItem,
  PluginDynamicMenuItem,
  PluginSettingsPanel,
  PluginViewData,
  PluginContextMenuTarget,
  PluginBadge,
  PluginViewHeader,
  ViboplrPluginAPI,
  PluginEventName,
  PluginTrack,
  PluginPlayContext,
  GalleryPluginEntry,
  PluginGalleryIndex,
  ImageFetchResult,
  DownloadResolveByUriHandler,
  DownloadResolveByMetadataHandler,
  DownloadResolveResult,
  DownloadResolveProgress,
  ExecResult,
  PluginProgramSpec,
  PluginProgramStatus,
  PluginExecHandle,
  PluginFileTags,
  InteractiveSearchHandler,
  InteractiveResolveHandler,
  InteractiveSearchResult,
  GetQualitiesHandler,
  DownloadPreviewHandler,
  DownloadPreviewRequest,
  DownloadPreview,
  DownloadQualityOption,
  HomeShelfDisplayKind,
  HomeShelfItem,
  HomeShelfResult,
  NowPlayingInfoResult,
  PluginSearchProvider,
  PluginAssistantTool,
  PluginAssistantToolDescriptor,
  PluginVisualizer,
  PluginVisualizerDescriptor,
  PluginVisualizerRegistration,
  PluginSearchResult,
  PluginWebSearchProvider,
  PluginWebSearchResult,
  InfoValueMatch,
  StreamCandidate,
  StreamResolveResult,
  ReplaceTrackFileRequest,
  ReplaceTrackFileResult,
  PluginCueSheet,
  PluginCollectionSource,
  PluginWaveformLookupHandler,
  PluginWaveformShareHandler,
  PluginDownloadInit,
  PluginAutoContinueRequest,
} from "../types/plugin";
import { sanitizePluginRms, type WaveformPluginBridge } from "../waveform/pluginProvider";
import { PLUGIN_AUTO_CONTINUE_TIMEOUT_MS, type AutoContinuePluginBridge } from "../utils/autoContinue";
import type { UiContext } from "../utils/uiContext";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import type { Storyboard } from "../utils/storyboard";
import { buildEntityKey } from "../types/informationTypes";
import {
  CORE_LOCAL_LYRICS_PROVIDER, fetchInfoValue, resolveInfoEntityId, saveInfoValue, saveOwnInfoValue, sectionDataRequest, type InvokeInfoFetch,
} from "../utils/infoFetchChain";
import { CallGraph, callableProblem, describePlugins } from "../utils/crossPluginCalls";
import { sanitizeSeekMarkers, type SeekMarker } from "../utils/seekMarkers";
import { coerceScrobbleReport, type ScrobbleReport } from "../utils/scrobblers";
import { requestDetailTab } from "../utils/pendingDetailTab";
import {
  addTags, editTrackTags, NO_TAG_REFRESH, removeTags, writeFileMetadata,
  type FileMetadataEdit, type TagOpsDeps,
} from "../utils/tagOps";
import {
  invokeAssistantTool as invokeAssistantToolOp, listAssistantTools, listSearchProviders, listWebSearchProviders,
  searchCatalog, webSearch,
} from "../utils/hostOps";
import {
  mergeWebSearchOrder, normalizeWebSearchResult, orderWebSearchProviders, WEB_SEARCH_ORDER_KEY,
  type OrderedWebSearchProvider, type WebSearchOrderEntry,
} from "../utils/webSearch";
import { hostInstructions, inProcessContext, invokeHostTool, listHostTools } from "../utils/hostAssistantTools";
import { fetchLocalLyrics } from "../utils/localLyrics";
import { sanitizeViewHeader } from "../utils/pluginViewHeader";

/** Backstop for a global-search handler that never settles. Deliberately far
 *  more generous than the 5s home-shelf budget: search runs only when the user
 *  explicitly asks for it, and the real providers shell out to a binary or drive
 *  a scrape window, which legitimately takes tens of seconds. */
const PLUGIN_SEARCH_TIMEOUT_MS = 60000;

/** Backstop for one web-search provider. Shorter than catalog search: a web
 *  engine answers in a second or two, and the walk falls through to the next
 *  provider on a timeout, so a hung one shouldn't hold the caller for a minute. */
const WEB_SEARCH_TIMEOUT_MS = 20000;

type PluginAutoContinueHandler = (request: PluginAutoContinueRequest) => PluginTrack[] | null | Promise<PluginTrack[] | null>;

/** The host registries a plugin may call into — see `hostRegistryRef`. */
interface HostRegistry {
  pluginStates: PluginState[];
  searchProviders: PluginSearchProvider[];
  invokePluginSearch: (pluginId: string, providerId: string, query: string, limit: number) => Promise<PluginSearchResult>;
  webSearchProviders: OrderedWebSearchProvider[];
  invokeWebSearch: (pluginId: string, providerId: string, query: string, limit: number) => Promise<PluginWebSearchResult>;
  assistantTools: PluginAssistantTool[];
  assistantInstructions: Map<string, string>;
  invokeAssistantTool: (pluginId: string, name: string, args: Record<string, unknown>) => Promise<unknown>;
  homeShelves: Array<{ pluginId: string }>;
  menuItems: Array<{ pluginId: string }>;
  pluginNames: Map<string, string>;
}

/** Parse a stored info value (JSON string) for plugin consumers; passes through
 *  non-string / non-JSON values unchanged so callers never see a parse throw. */
function parsePluginJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
import { withResolverLog } from "../utils/resolverLog";
import { normalizeSearchResult, type NormalizedSearchResult } from "../utils/pluginSearchResult";

import { useAssignRef } from "./useLatestRef";
import { dropPrewarmedWorkers, prewarmPluginWorkers, startWorkerPlugin, type WorkerPluginControl } from "../pluginWorker/host";
import {
  ALWAYS_ASK_PERMISSIONS, needsUnsignedWarning, networkHosts, permissionReasons, permissionsAwaitingConsent,
  type ProgramConsent,
} from "../pluginWorker/permissions";
import { isFirstParty, mainRealmVerdict } from "../utils/pluginTrust";
import { deletePluginKeys, registerKeyed } from "../utils/registryOps";
import { abortError, armFetchAbort, isFetchAborted } from "../utils/pluginFetchAbort";
import { handlerKey, matchesProviderRef, parseProviderKey, providerKey, providerNames } from "../utils/providerKey";
import { MERGED_PLUGINS_DONE_KEY, migrateMergedPlugins, providerRowsFor } from "../utils/mergedPlugins";
import { withoutRetiredContributions, withoutRetiredIds, withoutRetiredKeys } from "../utils/retiredPlugins";
import { watchPlaybackLevel } from "../playback/levelStore";
// Hardcoded defaults for information type tab order and provider priority.
// Plugins cannot override these — users customize via Settings > Providers.
export const DEFAULT_INFO_TYPE_ORDER: Record<string, number> = {
  artist_stats: 100,
  artist_top_tracks: 150,
  artist_bio: 200,
  similar_artists: 500,
  album_wiki: 200,
  album_track_popularity: 300,
  song_meaning: 100,
  lyrics: 200,
  track_info: 300,
  song_bio: 350,
  track_tags: 400,
  similar_tracks: 500,
};

/** Longest lyrics text a plugin may save (api.lyrics.save) — far past any song. */
const MAX_PLUGIN_LYRICS_CHARS = 200_000;

export const DEFAULT_INFO_TYPE_PRIORITY: Record<string, Record<string, number>> = {
  // "core:local-lyrics" (50, ahead of every web provider) is seeded by DB
  // `ensure_builtin_rows` (db/mod.rs), not by this map — it has no manifest for the sync/reset
  // loops to walk. Listed here as documentation of the full default chain.
  // Keys are provider keys (utils/providerKey.ts): the bundled Lyrics plugin
  // offers LRCLIB and Lyrics.ovh as two providers of one type.
  lyrics: { "core:local-lyrics": 50, "lyrics/lrclib": 100, genius: 200, "lyrics/lyrics-ovh": 300, google: 400 },
  artist_bio: { lastfm: 100, genius: 200 },
  album_wiki: { lastfm: 100, genius: 200 },
};

// Internal priority for image providers (keyed by "<provider key>:entity")
export const DEFAULT_IMAGE_PROVIDER_PRIORITY: Record<string, number> = {
  // TheAudioDB is the most accurate bundled artist source in practice, so it
  // leads the bundled chain. Deezer follows (broad coverage, now name-gated).
  // iTunes contributes no artist images (musicArtist has no artwork field).
  // All four are providers of the one bundled Artwork plugin.
  "artwork/audiodb:artist": 200,
  "artwork/deezer:artist": 300,
  "artwork/musicbrainz:artist": 500,
  "google:artist": 900,
  "artwork/itunes:album": 200,
  "artwork/deezer:album": 300,
  "artwork/musicbrainz:album": 500,
  "google:album": 900,
  "google:tag": 900,
};

/** One image provider's answer, a throw turned into an `error` the chain moves past. */
async function runImageHandler(
  key: string,
  entity: string,
  handler: (name: string, artistName?: string) => Promise<ImageFetchResult>,
  name: string,
  artistName?: string,
): Promise<ImageFetchResult> {
  try {
    return await handler(name, artistName);
  } catch (e) {
    console.error(`[plugin:${key}] image fetch error for ${entity}:`, e);
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

// -- Internal types --

interface LoadedPlugin {
  id: string;
  manifest: PluginManifest;
  deactivate?: () => void;
  unsubscribers: Array<() => void>;
  contextMenuHandlers: Map<string, (target: PluginContextMenuTarget) => void>;
  uiActionHandlers: Map<string, (data: unknown) => void>;
  deepLinkHandlers: Array<(url: string) => void>;
  infoFetchHandlers: Map<string, (entity: InfoEntity) => Promise<InfoFetchResult>>;
  imageFetchHandlers: Map<string, (name: string, artistName?: string) => Promise<ImageFetchResult>>;
  downloadResolveByUriHandlers: Map<string, DownloadResolveByUriHandler>;
  downloadResolveByMetadataHandlers: Map<string, DownloadResolveByMetadataHandler>;
  interactiveSearchHandlers: Map<string, InteractiveSearchHandler>;
  interactiveResolveHandlers: Map<string, InteractiveResolveHandler>;
  getQualitiesHandlers: Map<string, GetQualitiesHandler>;
  downloadPreviewHandlers: Map<string, DownloadPreviewHandler>;
  streamResolveHandlers: Map<string, (title: string, artistName: string | null, albumName: string | null, durationSecs: number | null, opts?: { preferVideo?: boolean; externalAudio?: boolean; fresh?: boolean }) => Promise<StreamResolveResult | null>>;
  streamUriResolvers: Map<string, (id: string, quality?: string | null, opts?: { externalAudio?: boolean; fresh?: boolean; video?: boolean }) => Promise<string | { candidates: StreamCandidate[]; sourceUrl?: string } | null>>;
  storyboardResolvers: Map<string, (id: string) => Promise<Storyboard | null>>;
  /** `api.waveforms.onLookup` / `onShare` — one of each per plugin, last wins. */
  waveformLookupHandler: PluginWaveformLookupHandler | null;
  waveformShareHandler: PluginWaveformShareHandler | null;
  /** `api.playback.onAutoContinue` — one per plugin, last wins. */
  autoContinueHandler: PluginAutoContinueHandler | null;
  schedulerHandlers: Map<string, () => void>;
  visualizerFactories: Map<string, () => PluginVisualizer>;
}

type ExecOutputHandler = (line: string, stream: "stdout" | "stderr") => void;
export type DownloadProgressHandler = (progress: DownloadResolveProgress) => void;

/** One in-flight download resolve: what it reports progress to, and which
 *  subprocesses it started (so a cancel can kill them). See `resolveScopesRef`. */
interface ResolveScope {
  onProgress?: DownloadProgressHandler;
  execIds: Set<string>;
  cancelled: boolean;
}

/** Store key: approved permissions per worker-runtime plugin (id → permission strings). */
const PERMISSION_GRANTS_KEY = "pluginPermissionGrants";
/** Store key: under what trust each plugin's always-ask permissions
 *  (`programs:run`) were approved — id → `ProgramConsent`. See
 *  `permissionsAwaitingConsent`. */
const PROGRAM_CONSENT_KEY = "pluginProgramConsent";
/** What `api.system.programs.download` rejects with when the user turns the
 *  install down — a plugin can tell it apart from a failed download. */
export const PROGRAM_INSTALL_DECLINED = "Install declined";

/** The second, warned consent an unsigned plugin needs before it may run
 *  programs. App renders it; `answer` settles the approval that asked. */
export interface UnsignedProgramsRequest {
  pluginId: string;
  pluginName: string;
  answer: (allowed: boolean) => void;
}

/** A plugin used one of its `optionalPermissions` for the first time; App asks
 *  the user for the whole optional set (what the feature needs). */
export interface OptionalPermissionsRequest {
  pluginId: string;
  pluginName: string;
  /** The optional permissions not granted yet. */
  permissions: string[];
  reasons: Record<string, string>;
  answer: (allowed: boolean) => void;
}

/** Rust's answer to starting a dependency the user hasn't agreed to run yet. */
const DEPENDENCY_RUN_UNCONFIRMED = "DEPENDENCY_RUN_UNCONFIRMED";
/** What `programs.start({ dependency })` rejects with when the user says no. */
export const DEPENDENCY_RUN_DECLINED = "Run declined";
/** How long a quit waits for every plugin's `onAppQuitting` (Rust waits 5s). */
const APP_QUIT_BUDGET_MS = 4500;

/** "Let <plugin> run <tool> in the background?" */
export interface DependencyRunRequest {
  pluginId: string;
  pluginName: string;
  dependency: string;
  version: string | null;
  repo: string | null;
  answer: (allowed: boolean) => void;
}

/** The host's confirmation before every `api.system.programs.download` — each
 *  install or update of a program is the user's call, not just the first. */
export interface ProgramInstallRequest {
  pluginId: string;
  pluginName: string;
  fileName: string;
  host: string;
  url: string;
  /** The plugin pinned a checksum, so only that exact file is kept. */
  pinned: boolean;
  /** What the plugin says it is installing ("slskd 0.26.1"), shown as its words. */
  label: string | null;
  answer: (allowed: boolean) => void;
}

/** Max time a single plugin's activate() may block the sequential load before
 *  the host moves on. The plugin keeps initializing in the background; this
 *  just stops one slow/hung activate() (e.g. one that awaits network) from
 *  freezing startup and everything queued behind it. */
const ACTIVATE_TIMEOUT_MS = 3000;
/** Budget for a plugin's storyboard lookup. Bounded so a wedged resolver just means
 *  "no thumbnail" instead of a seek bar that never previews.
 *
 *  This was 10s, which the only real producer could never meet — so the video
 *  filmstrip silently never appeared for a yt-dlp track. Measured on a dev machine:
 *  `yt-dlp -j --no-warnings --no-playlist <youtube url>` alone takes **12.2s** (yt-dlp
 *  is pathologically slow to start here — the same reason dependency probes carry a
 *  60s timeout and a persisted cache), and the resolver then downloads the chosen
 *  level's sheets — up to 8 images — *inside the same budget*. It lost the race on
 *  every play, including repeat plays: the plugin caches sheet bytes but runs yt-dlp
 *  before consulting that cache.
 *
 *  A long budget costs nothing visible. `useStoryboard` starts in `loading` and the
 *  seek bar renders its ordinary fallback meanwhile, so the only effect of waiting is
 *  that the filmstrip appears late instead of never. Track changes are already guarded
 *  by the effect's `cancelled` flag. */
const STORYBOARD_RESOLVE_TIMEOUT_MS = 60000;
// Cache the gallery index so the Extensions panel paints installable plugins
// instantly on open (stale-while-revalidate), instead of waiting on the network.
const PLUGIN_GALLERY_CACHE_KEY = "galleryPluginsCache";
// Skip re-hitting the network if we already revalidated within this window. The
// curated index changes rarely, so reopening the panel is free within the TTL.
const GALLERY_TTL_MS = 30 * 60 * 1000;

/** Per-plugin activation timing, logged as a summary after the load loop so we
 *  can see how long each plugin takes and where the time goes. */
interface PluginActivationTiming {
  plugin: string;
  /** Total time spent in activatePlugin for this plugin. */
  totalMs: number;
  /** Reading index.js over IPC (0 when the listing bundled the code). */
  codeMs: number;
  /** new Function() + running the factory to get exports. */
  compileMs: number;
  /** The plugin's own activate() body (its registration / storage / network). */
  activateMs: number;
  /** Wall-time spent inside invoke() (IPC) during activate() — debug only, else 0. */
  ipcMs: number;
  /** Number of invoke() calls the plugin made during activate() — debug only. */
  ipcCount: number;
  /** Whether the code came bundled in plugin_list_installed (no extra IPC). */
  bundled: boolean;
}

type EventHandlers = {
  [K in PluginEventName]: Array<{
    pluginId: string;
    handler: (...args: unknown[]) => void;
  }>;
};

// -- Hook --

export interface PluginPlaybackCallbacks {
  playTrack: (track: PluginTrack) => void;
  playTracks: (tracks: PluginTrack[], startIndex?: number, context?: PluginPlayContext) => void;
  insertTrack: (track: PluginTrack, position: number) => void;
  insertTracks: (tracks: PluginTrack[], position: number) => void;
  // Resolves with the number of tracks actually appended (0 = nothing landed).
  playWithBackfill: (opts: {
    head: PluginTrack[];
    context?: PluginPlayContext;
    resolveTail: () => Promise<PluginTrack[]> | PluginTrack[];
    tailErrorMessage?: string;
  }) => Promise<number>;
}

/** One handler's answer to a dispatched event (`dispatchEventTo`). */
export interface PluginEventResult {
  pluginId: string;
  value?: unknown;
  error?: unknown;
}

export interface PluginHostCallbacks {
  /** `api.ui.getContext`: what the user is looking at (utils/uiContext.ts). */
  getUiContext?: () => UiContext | null;
  /** Refresh hooks for the shared tag ops (utils/tagOps.ts). */
  tagOps?: TagOpsDeps;
  navigateToPluginView: (pluginId: string, viewId: string) => void;
  requestAction: (pluginId: string, action: string, payload: Record<string, unknown>) => void;
  showNotification: (message: string, options?: NotifyOptions) => void;
  /** `api.library.replaceTrackFile`: the host's Replace dialog, then the swap. */
  replaceTrackFile?: (pluginId: string, request: ReplaceTrackFileRequest) => Promise<ReplaceTrackFileResult>;
  /** `api.collections.requestAdd`: the app's own prefilled Add dialog. */
  requestAddCollection?: (pluginId: string, source: PluginCollectionSource) => void;
  /** `api.playback.setMarkers`: replace this plugin's seek-bar ticks for the
   *  playing track. Already sanitized; `trackKey` already matched. */
  setSeekMarkers?: (pluginId: string, trackKey: string, markers: SeekMarker[]) => void;
  /** Drop every seek-bar tick this plugin drew (it was disabled or unloaded). */
  clearSeekMarkers?: (pluginId: string) => void;
  /** `api.ui.navigateToEntity`: open the page (the tab is already parked). */
  navigateToEntity?: (kind: "track" | "album" | "artist", ref: { name: string; artistName?: string; albumTitle?: string }) => void;
  /** `api.playback.reportScrobble`: a later outcome for this scrobbler.
   *  Already coerced; the plugin is subscribed to `track:scrobbled`. */
  reportScrobble?: (pluginId: string, report: ScrobbleReport) => void;
}

export function usePlugins(
  currentTrackRef: React.RefObject<QueueTrack | null>,
  playingRef: React.RefObject<boolean>,
  positionRef: React.RefObject<number>,
  // Live queue, for plugins that render the queue itself (the vinyl deck).
  // A ref, like the three above, so reading it never re-runs the api builder.
  queueRef: React.RefObject<{ tracks: QueueTrack[]; index: number }>,
  playbackCallbacks?: PluginPlaybackCallbacks,
  // A ref for the same reason as the four above, plus one specific to this one:
  // App.tsx can only build the host callbacks *after* the state and actions they
  // close over exist, which is hundreds of lines below this call. Taking the
  // value meant reading `.current` during App's render and getting the previous
  // render's object — `undefined` on the very first one. Taking the ref lets the
  // consumers below read it lazily, at call time, when it is always populated.
  hostCallbacksRef?: React.RefObject<PluginHostCallbacks | undefined>,
  debugMode?: boolean,
  devPluginPath?: string | null,
  // Gate the initial plugin load until the app's cold-start critical path
  // (store restore, main-playlist read, window show, library load) is done.
  // Nothing in first paint needs plugins — they feed info sections, image
  // providers, home shelves, and resolvers, all consumed lazily — so loading
  // them up front just contends with startup on the single Tauri IPC channel.
  // Pass `true` once startup has settled to kick the (still background) load.
  startupReady: boolean = true,
) {
  const [pluginStates, setPluginStates] = useState<PluginState[]>([]);
  const [sidebarItems, setSidebarItems] = useState<PluginSidebarItem[]>([]);
  const [menuItems, setMenuItems] = useState<PluginMenuItem[]>([]);
  const [viewData, setViewData] = useState<Map<string, PluginViewData>>(
    new Map(),
  );
  const [settingsPanels, setSettingsPanels] = useState<PluginSettingsPanel[]>([]);
  const [homeShelves, setHomeShelves] = useState<Array<{
    pluginId: string;
    shelfId: string;
    title: string;
    displayKind: HomeShelfDisplayKind;
    limit: number;
    icon?: string;
  }>>([]);
  const [searchProviders, setSearchProviders] = useState<PluginSearchProvider[]>([]);
  const [manifestWebSearchProviders, setManifestWebSearchProviders] = useState<PluginWebSearchProvider[]>([]);
  const [visualizers, setVisualizers] = useState<PluginVisualizerRegistration[]>([]);
  const dynamicVisualizersRef = useRef<Map<string, PluginVisualizerRegistration>>(new Map());
  const [dynamicVisualizersVersion, setDynamicVisualizersVersion] = useState(0);
  const [galleryPlugins, setGalleryPlugins] = useState<GalleryPluginEntry[]>(
    [],
  );
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  // Refs backing the TTL guard so fetchPluginGallery can stay a stable callback
  // and short-circuit reopens without re-hitting the network.
  const galleryPluginsRef = useRef<GalleryPluginEntry[]>([]);
  const lastGalleryFetchRef = useRef(0);
  useEffect(() => { galleryPluginsRef.current = galleryPlugins; }, [galleryPlugins]);
  // True once the initial plugin load has completed at least once. Lets consumers
  // (e.g. Home shelves) distinguish "no plugin shelves because none are loaded"
  // from "plugins haven't finished loading yet" — avoids pruning valid shelves
  // during the async load window.
  const [pluginsLoaded, setPluginsLoaded] = useState(false);

  const playbackCallbacksRef = useRef(playbackCallbacks);
  useAssignRef(playbackCallbacksRef, playbackCallbacks);

  const fetchUrlCallbackRef = useRef<((url: string) => void) | null>(null);
  const loadedPluginsRef = useRef<Map<string, LoadedPlugin>>(new Map());
  // Forward refs for api.informationTypes.fetch: buildAPI is defined before
  // invokeInfoFetch / pluginNames exist and must stay dependency-free, so it
  // reads them through refs filled in below (see useLatestRef.ts).
  const invokeInfoFetchRef = useRef<InvokeInfoFetch | null>(null);
  const pluginNamesRef = useRef<Map<string, string>>(new Map());
  // The host registries a plugin may call INTO (api.search.query,
  // api.assistant.invoke, api.plugins.list) — the same lists and invokers the
  // control API dispatches through, so user visibility/enable settings gate a
  // plugin caller exactly as they gate an HTTP one. Filled by useAssignRef
  // below once those memos exist.
  const hostRegistryRef = useRef<HostRegistry | null>(null);
  // In-flight plugin→plugin call edges, so A → B → A fails fast instead of
  // spinning for the 60s tool timeout. See utils/crossPluginCalls.ts.
  const crossCallGraphRef = useRef(new CallGraph());
  // --- Download-resolve scopes ---------------------------------------------
  // A scope is one resolve call the host is awaiting. It exists because a
  // provider that downloads the file itself (yt-dlp merging a video can run for
  // minutes) is otherwise a black box: nothing to show and nothing to stop.
  // Every `api.system.exec` started inside the scope is recorded, so cancelling
  // the download kills the tool rather than orphaning it, and every
  // `api.downloads.reportProgress` inside it reaches the modal that is waiting.
  // A stack per plugin, since a resolve may nest (retry, cache probe).
  const resolveScopesRef = useRef<Map<string, ResolveScope[]>>(new Map());
  const execSeqRef = useRef(0);
  const execOutputHandlersRef = useRef<Map<string, ExecOutputHandler>>(new Map());
  const eventHandlersRef = useRef<EventHandlers>({
    "track:started": [],
    "track:scrobbled": [],
    "track:added": [],
    "track:removed": [],
    "queue:changed": [],
    "scan:complete": [],
    "like:changed": [],
    "ui:context-changed": [],
  });
  // Plugins currently subscribed to `track:scrobbled` — the plugin half of the
  // Settings → Playback → Scrobbling list. Re-derived on every (un)subscribe to that event.
  const [scrobblerPluginIds, setScrobblerPluginIds] = useState<string[]>([]);
  const syncScrobblerPluginIds = useCallback(() => {
    const ids = [...new Set(eventHandlersRef.current["track:scrobbled"].map((h) => h.pluginId))];
    setScrobblerPluginIds((prev) =>
      prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids,
    );
  }, []);
  const enabledPluginsRef = useRef<Set<string>>(new Set());
  const permissionGrantsRef = useRef<Record<string, string[]>>({});
  const programConsentRef = useRef<Record<string, ProgramConsent>>({});
  const [unsignedProgramsRequest, setUnsignedProgramsRequest] = useState<UnsignedProgramsRequest | null>(null);
  const [optionalPermissionsRequest, setOptionalPermissionsRequest] = useState<OptionalPermissionsRequest | null>(null);
  const [programInstallRequest, setProgramInstallRequest] = useState<ProgramInstallRequest | null>(null);
  const [dependencyRunRequest, setDependencyRunRequest] = useState<DependencyRunRequest | null>(null);
  // `api.system.programs.onAppQuitting`, one per plugin.
  const appQuittingHandlersRef = useRef<Map<string, () => void | Promise<void>>>(new Map());
  // One host dialog at a time: a plugin firing two installs at once (or an
  // install while its permission prompt is up) waits its turn.
  const hostPromptChainRef = useRef<Promise<unknown>>(Promise.resolve());
  // `api.system.programs.download` progress, keyed by the download id the
  // bridge minted for a call that passed `onProgress`.
  const programDownloadHandlersRef = useRef<Map<string, (received: number, total: number | null) => void>>(new Map());
  const programDownloadSeqRef = useRef(0);
  /** The states the last loadPlugins produced, for callers that act right after
   *  an install/update and can't wait for a re-render (approval prompts). */
  const pluginStatesRef = useRef<PluginState[]>([]);
  const appVersionRef = useRef<string>("0.0.0");
  const viewDataRef = useRef<Map<string, PluginViewData>>(new Map());
  const viewScrollKeyRef = useRef<Map<string, string>>(new Map());
  const badgeMapRef = useRef<Map<string, PluginBadge>>(new Map());
  const [badgeMap, setBadgeMap] = useState<Map<string, PluginBadge>>(new Map());
  // Runtime view-header overrides (`api.ui.setViewHeader`), keyed like
  // viewData. Already sanitized; merged over the manifest by
  // `resolvePluginViewHeader` at render time.
  const viewHeadersRef = useRef<Map<string, PluginViewHeader>>(new Map());
  const [viewHeaders, setViewHeaders] = useState<Map<string, PluginViewHeader>>(new Map());
  const homeShelfHandlersRef = useRef(new Map<string, (limit: number) => Promise<HomeShelfResult>>());
  // shelf key -> plugin-provided click handler that takes over card body-clicks
  const homeShelfClickHandlersRef = useRef(new Map<string, (item: HomeShelfItem) => void | Promise<void>>());
  const homeShelfResolvePlayHandlersRef = useRef(new Map<string, (item: HomeShelfItem) => Promise<PluginTrack[]>>());
  const dynamicHomeShelvesRef = useRef(new Map<string, {
    pluginId: string;
    shelfId: string;
    title: string;
    displayKind: HomeShelfDisplayKind;
    limit: number;
    icon?: string;
  }>());
  const [dynamicShelvesVersion, setDynamicShelvesVersion] = useState(0);
  // Global-search providers, keyed `${pluginId}:${providerId}` — handlers plus
  // the runtime-registered descriptors (mirrors dynamicHomeShelvesRef). Runtime
  // registration matters more here than for shelves: a provider whose backing
  // tool is missing (yt-dlp with no binary) must not be offered at all.
  const searchHandlersRef = useRef(
    new Map<string, (query: string, limit: number) => Promise<PluginSearchResult>>(),
  );
  const dynamicSearchProvidersRef = useRef(new Map<string, PluginSearchProvider>());
  const [dynamicSearchProvidersVersion, setDynamicSearchProvidersVersion] = useState(0);
  // Web-search providers (api.webSearch): same shape as the catalog search
  // above, plus the user's order + on/off from Settings → Providers.
  const webSearchHandlersRef = useRef(
    new Map<string, (query: string, limit: number) => Promise<PluginWebSearchResult>>(),
  );
  // Runtime registrations: the ref is mutated synchronously by the API, and
  // each change is published as a state snapshot, so the merge below reads
  // state rather than a ref during render.
  const dynamicWebSearchProvidersRef = useRef(new Map<string, PluginWebSearchProvider>());
  const [dynamicWebSearchProviders, setDynamicWebSearchProviders] = useState<PluginWebSearchProvider[]>([]);
  const publishDynamicWebSearchProviders = useCallback(
    () => setDynamicWebSearchProviders(Array.from(dynamicWebSearchProvidersRef.current.values())),
    [],
  );
  const [webSearchOrder, setWebSearchOrderState] = useState<WebSearchOrderEntry[] | null>(null);
  const webSearchOrderRef = useRef<WebSearchOrderEntry[] | null>(null);
  // Until the stored order is read, nobody knows which engines the user
  // switched off, so every provider counts as off (see webSearchProviders) —
  // a search that early must not reach an engine the user turned off.
  const [webSearchOrderLoaded, setWebSearchOrderLoaded] = useState(false);
  const webSearchOrderLoadedRef = useRef(false);
  // Assistant tools (api.assistant): manifest declarations in state, runtime
  // registrations/handlers/instructions in refs — merged like search providers.
  // Handlers keyed `${pluginId}:${toolName}`.
  const [manifestAssistantTools, setManifestAssistantTools] = useState<PluginAssistantTool[]>([]);
  const [manifestAssistantInstructions, setManifestAssistantInstructions] = useState<Map<string, string>>(new Map());
  const assistantToolHandlersRef = useRef(
    new Map<string, (args: Record<string, unknown>) => Promise<unknown>>(),
  );
  const dynamicAssistantToolsRef = useRef(new Map<string, PluginAssistantTool>());
  const runtimeAssistantInstructionsRef = useRef(new Map<string, string>());
  const [assistantVersion, setAssistantVersion] = useState(0);
  // Runtime-registered context-menu items, keyed `${pluginId}:${itemId}`
  // (mirrors dynamicHomeShelvesRef). Merged with the static manifest items.
  const dynamicMenuItemsRef = useRef(new Map<string, PluginMenuItem>());
  const [dynamicMenuItemsVersion, setDynamicMenuItemsVersion] = useState(0);
  // Runtime-registered Now Playing info items, keyed `${pluginId}:${itemId}`
  // (mirrors dynamicHomeShelvesRef). Drives the cycling now-playing section.
  const nowPlayingInfoItemsRef = useRef(new Map<string, {
    pluginId: string;
    itemId: string;
    label: string;
    priority: number;
    defaultEnabled: boolean;
  }>());
  const nowPlayingInfoHandlersRef = useRef(new Map<string, (track: PluginTrack) => Promise<NowPlayingInfoResult>>());
  const [nowPlayingInfoVersion, setNowPlayingInfoVersion] = useState(0);

  // Per-contribution on/off for context-menu items and sidebar views, keyed
  // `${pluginId}:${kind}:${itemId}`. See utils/pluginContributions.ts — a
  // missing key means visible, so a plugin update's new item is never hidden.
  const [contributionVisibility, setContributionVisibility] =
    useState<ContributionVisibility>({});
  const contributionVisibilityRef = useRef<ContributionVisibility>({});

  // Read the saved map on mount. Runs ahead of the plugin load (which waits on
  // startupReady), so menus are filtered from the first right-click.
  useEffect(() => {
    (async () => {
      try {
        const saved = await store.get<ContributionVisibility>(
          "pluginContributionVisibility",
        );
        if (!saved) return;
        const kept = withoutRetiredContributions(saved);
        if (kept) await store.set("pluginContributionVisibility", kept);
        contributionVisibilityRef.current = kept ?? saved;
        setContributionVisibility(kept ?? saved);
      } catch (e) {
        console.error("Failed to read plugin contribution visibility:", e);
      }
    })();
  }, []);

  // The user's web-search provider order (Settings → Providers). Read on
  // mount; written only by setWebSearchOrder, for the same no-restore-guard
  // reason as the contribution map below.
  useEffect(() => {
    (async () => {
      try {
        const saved = await store.get<WebSearchOrderEntry[]>(WEB_SEARCH_ORDER_KEY);
        if (Array.isArray(saved)) {
          webSearchOrderRef.current = saved;
          setWebSearchOrderState(saved);
        }
      } catch (e) {
        // A store that can't be read leaves the defaults (every provider on):
        // the alternative is web search off for the whole session, with no
        // setting that could turn it back on.
        console.error("Failed to read web search provider order:", e);
      } finally {
        webSearchOrderLoadedRef.current = true;
        setWebSearchOrderLoaded(true);
      }
    })();
  }, []);

  /** Save the rows the user sees, in their new order / switches. Providers
   *  not on screen keep their stored place (see mergeWebSearchOrder). */
  const setWebSearchOrder = useCallback(
    async (shown: Array<{ key: string; enabled: boolean }>) => {
      // Before the stored order is read, merging against nothing would drop
      // the entries for providers that aren't on screen. Settings shows every
      // row off until then, so there is nothing real to save yet.
      if (!webSearchOrderLoadedRef.current) {
        console.error("Ignored a web search provider order change made before the saved order was read");
        return;
      }
      const next = mergeWebSearchOrder(shown, webSearchOrderRef.current);
      webSearchOrderRef.current = next;
      setWebSearchOrderState(next);
      try {
        await store.set(WEB_SEARCH_ORDER_KEY, next);
      } catch (e) {
        console.error("Failed to persist web search provider order:", e);
      }
    },
    [],
  );

  /** Settings' "Reset to Defaults": forget the stored order, so every
   *  provider is on, in registration order (`orderWebSearchProviders`). */
  const resetWebSearchOrder = useCallback(async () => {
    webSearchOrderRef.current = [];
    setWebSearchOrderState([]);
    try {
      await store.set(WEB_SEARCH_ORDER_KEY, []);
    } catch (e) {
      console.error("Failed to reset web search provider order:", e);
    }
  }, []);

  // Persist on the toggle itself rather than from an effect: an effect would
  // need a "have we restored yet" guard to avoid writing `{}` over the saved
  // map during startup, and there is nothing else that mutates this state.
  const setContributionEnabled = useCallback(
    async (key: string, enabled: boolean) => {
      const next = { ...contributionVisibilityRef.current, [key]: enabled };
      contributionVisibilityRef.current = next;
      setContributionVisibility(next);
      try {
        await store.set("pluginContributionVisibility", next);
      } catch (e) {
        console.error("Failed to persist plugin contribution visibility:", e);
      }
    },
    [],
  );

  // Active IPC-timing bucket for the plugin currently inside its activate()
  // window (set only in debug mode). tapInvoke attributes each invoke()'s
  // wall-time to it; when null it's a pure passthrough (negligible overhead).
  const ipcTapRef = useRef<{ ms: number; count: number } | null>(null);
  const tapInvoke = useCallback(
    <T,>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> => {
      const bucket = ipcTapRef.current;
      if (!bucket) return invoke<T>(cmd, args, options);
      const t = performance.now();
      return invoke<T>(cmd, args, options).finally(() => {
        bucket.ms += performance.now() - t;
        bucket.count += 1;
      });
    },
    [],
  );

  // Build the curated API for a specific plugin
  /** Run `ask` after every host dialog already queued has been answered. */
  const queueHostPrompt = useCallback(<T,>(ask: () => Promise<T>): Promise<T> => {
    const run = hostPromptChainRef.current.then(ask, ask);
    hostPromptChainRef.current = run.catch(() => undefined);
    return run;
  }, []);

  /** Open the unsigned-plugin warning; resolves with the user's answer. */
  const askUnsignedPrograms = useCallback((pluginId: string, pluginName: string) =>
    new Promise<boolean>((resolve) => {
      setUnsignedProgramsRequest({
        pluginId,
        pluginName,
        answer: (ok) => {
          setUnsignedProgramsRequest(null);
          resolve(ok);
        },
      });
    }), []);

  const isTrustedPlugin = useCallback((pluginId: string) => {
    const s = pluginStatesRef.current.find((p) => p.id === pluginId);
    return !!(s?.builtin || s?.firstParty);
  }, []);

  /** The plugin's optional permissions the user has granted and that still
   *  count — an always-ask one only under a consent that still holds. */
  const optionalGranted = useCallback((pluginId: string, declared: readonly string[]): string[] => {
    const approved = permissionGrantsRef.current[pluginId] ?? [];
    const waiting = permissionsAwaitingConsent({
      requested: declared,
      approved,
      trusted: isTrustedPlugin(pluginId),
      consent: programConsentRef.current[pluginId],
    });
    return declared.filter((p) => approved.includes(p) && !waiting.includes(p));
  }, [isTrustedPlugin]);

  /** Ask for the plugin's optional permissions the first time a call needs
   *  one. Grants the whole optional set at once — the feature that needs one
   *  (installing slskd: run programs + its download hosts) needs them all —
   *  and adds the unsigned warning when the set includes running programs. */
  const requestOptionalPermissions = useCallback((pluginId: string, declared: readonly string[]) =>
    queueHostPrompt(async () => {
      const granted = optionalGranted(pluginId, declared);
      const pending = declared.filter((p) => !granted.includes(p));
      if (pending.length === 0) return true;
      const state = pluginStatesRef.current.find((s) => s.id === pluginId);
      const pluginName = state?.manifest.name ?? pluginId;
      const allowed = await new Promise<boolean>((resolve) => {
        setOptionalPermissionsRequest({
          pluginId,
          pluginName,
          permissions: pending,
          reasons: state ? permissionReasons(state.manifest.optionalPermissions, state.manifest.permissionReasons) : {},
          answer: (ok) => {
            setOptionalPermissionsRequest(null);
            resolve(ok);
          },
        });
      });
      if (!allowed) return false;
      const trusted = isTrustedPlugin(pluginId);
      if (needsUnsignedWarning(pending, trusted) && !(await askUnsignedPrograms(pluginId, pluginName))) return false;
      const approved = permissionGrantsRef.current[pluginId] ?? [];
      permissionGrantsRef.current = { ...permissionGrantsRef.current, [pluginId]: Array.from(new Set([...approved, ...pending])) };
      await store.set(PERMISSION_GRANTS_KEY, permissionGrantsRef.current);
      if (pending.some((p) => ALWAYS_ASK_PERMISSIONS.includes(p))) {
        programConsentRef.current = { ...programConsentRef.current, [pluginId]: trusted ? "signed" : "unsigned" };
        await store.set(PROGRAM_CONSENT_KEY, programConsentRef.current);
      }
      // No reload: the gate reads grants per call. Only the Extensions view
      // needs telling.
      const nowGranted = optionalGranted(pluginId, declared);
      pluginStatesRef.current = pluginStatesRef.current.map((s) => (s.id === pluginId ? { ...s, optionalGranted: nowGranted } : s));
      setPluginStates(pluginStatesRef.current);
      return true;
    }), [queueHostPrompt, optionalGranted, isTrustedPlugin, askUnsignedPrograms]);

  /** The host's confirmation before a program download (every install and
   *  every update). */
  const confirmProgramInstall = useCallback((req: Omit<ProgramInstallRequest, "answer">) =>
    queueHostPrompt(() => new Promise<boolean>((resolve) => {
      setProgramInstallRequest({
        ...req,
        answer: (ok) => {
          setProgramInstallRequest(null);
          resolve(ok);
        },
      });
    })), [queueHostPrompt]);

  /** "Let <plugin> run <tool> in the background?" — the first start of Vibo's
   *  copy of a tool, and again after its source changed. Names the version and
   *  where it comes from. */
  const confirmDependencyRun = useCallback((pluginId: string, pluginName: string, dependency: string) =>
    queueHostPrompt(async () => {
      let version: string | null = null;
      let repo: string | null = null;
      try {
        const [info] = await invoke<{ version?: string; managedRepo?: string | null }[]>("check_dependencies", {
          names: [dependency], pluginDeps: null, forceRefresh: false,
        });
        version = info?.version ?? null;
        repo = info?.managedRepo ?? null;
      } catch (e) {
        console.error(`Failed to read ${dependency}'s version for the run dialog:`, e);
      }
      return new Promise<boolean>((resolve) => {
        setDependencyRunRequest({
          pluginId, pluginName, dependency, version, repo,
          answer: (ok) => {
            setDependencyRunRequest(null);
            resolve(ok);
          },
        });
      });
    }), [queueHostPrompt]);

  /** Vibo is quitting while a program that asked not to outlive it runs: give
   *  every plugin's `onAppQuitting` handler a chance, together at most
   *  `APP_QUIT_BUDGET_MS`. */
  const runAppQuitting = useCallback(async () => {
    const handlers = [...appQuittingHandlersRef.current.entries()];
    if (handlers.length === 0) return;
    const all = Promise.allSettled(handlers.map(async ([pluginId, handler]) => {
      try {
        await handler();
      } catch (e) {
        console.error(`[plugin:${pluginId}] quit handler failed:`, e);
      }
    }));
    await Promise.race([all, new Promise((resolve) => setTimeout(resolve, APP_QUIT_BUDGET_MS))]);
  }, []);

  const buildAPI = useCallback(
    (pluginId: string, loaded: LoadedPlugin): ViboplrPluginAPI => {
      // Shadow the module `invoke` so all of this plugin's API IPC is routed
      // through the tap and attributed to it during its activate() window.
      const invoke = tapInvoke;
      // A worker-runtime plugin's network grant, sent with every command that
      // fetches a plugin-supplied URL so Rust holds redirects to it too
      // (plugin_worker.rs → NetworkScope). null = main-realm plugin, unscoped.
      // Read per call: an optional network grant (a download host) can be
      // given while the plugin runs.
      const allowedHosts = (): string[] | null =>
        loaded.manifest.runtime === "worker"
          ? networkHosts([
              ...(loaded.manifest.permissions ?? []),
              ...optionalGranted(pluginId, loaded.manifest.optionalPermissions ?? []),
            ])
          : null;
      const trackUnsubscribe = (fn: () => void): (() => void) => {
        loaded.unsubscribers.push(fn);
        return fn;
      };

      // One gate for every plugin→plugin call (search.query, assistant.invoke):
      // the target must be installed + enabled + active, the call must not
      // close a loop with what is already in flight, and the hop is written
      // to the plugin log so yt-dlp activity started by another plugin reads
      // as "completer → ytdlp:search" rather than as unexplained yt-dlp work.
      const registry = (): HostRegistry => {
        const r = hostRegistryRef.current;
        if (!r) throw new Error("plugin registries are not ready yet");
        return r;
      };
      const crossCall = async <T>(target: string, what: string, run: () => Promise<T>): Promise<T> => {
        const problem = callableProblem(registry().pluginStates, target);
        if (problem) throw new Error(problem);
        const graph = crossCallGraphRef.current;
        if (graph.wouldCycle(pluginId, target)) {
          throw new Error(`cross-plugin call cycle: ${graph.describeCycle(pluginId, target)} (${what})`);
        }
        recordPluginLog("debug", `→ ${target}:${what}`, pluginId);
        const leave = graph.enter(pluginId, target);
        try {
          return await run();
        } finally {
          leave();
        }
      };

      const subscribeEvent = (
        event: PluginEventName,
        handler: (...args: unknown[]) => void,
      ): (() => void) => {
        const entry = { pluginId, handler };
        eventHandlersRef.current[event].push(entry);
        if (event === "track:scrobbled") syncScrobblerPluginIds();
        const unsub = () => {
          const arr = eventHandlersRef.current[event];
          const idx = arr.indexOf(entry);
          if (idx !== -1) arr.splice(idx, 1);
          if (event === "track:scrobbled") syncScrobblerPluginIds();
        };
        trackUnsubscribe(unsub);
        return unsub;
      };

      return {
        appVersion: appVersionRef.current,
        log: (level: string, message: string, section?: string) => {
          // The ring buffer is the always-on copy — the file log below is off
          // by default and truncated per launch, so without it a plugin's own
          // error report was unreadable after the fact.
          recordPluginLog(level, message, section ?? pluginId);
          // Fire-and-forget: this IS the logger (a plugin's api.log). Reporting its
          // own failure would recurse, and a lost plugin log line has no user impact.
          invoke("write_frontend_log", { level, message, section: section ?? pluginId }).catch(() => {}); // eslint-disable-line no-restricted-syntax
        },
        library: {
          async getTrackCount() {
            return invoke<number>("get_track_count");
          },
          async getTracks(opts) {
            return invoke<Track[]>("get_tracks", {
              opts: {
                artistId: opts?.artistId ?? null,
                albumId: opts?.albumId ?? null,
                tagId: opts?.tagId ?? null,
                limit: opts?.limit ?? 100,
                offset: opts?.offset ?? 0,
              },
            });
          },
          async ftsTracks(query, opts) {
            return invoke<Track[]>("get_tracks", {
              opts: {
                query,
                limit: opts?.limit ?? 50,
                offset: opts?.offset ?? 0,
              },
            });
          },
          async ftsArtists(query, opts) {
            const res = await invoke<{ artists: Array<{ id: number; name: string; track_count: number }> | null }>(
              "search_entity",
              { query, entity: "artists", limit: opts?.limit ?? 50, offset: opts?.offset ?? 0 },
            );
            return res.artists ?? [];
          },
          async ftsAlbums(query, opts) {
            const res = await invoke<{ albums: Array<{ id: number; title: string; artist_name: string | null; year: number | null }> | null }>(
              "search_entity",
              { query, entity: "albums", limit: opts?.limit ?? 50, offset: opts?.offset ?? 0 },
            );
            return res.albums ?? [];
          },
          async ftsTags(query, opts) {
            const res = await invoke<{ tags: Array<{ id: number; name: string; track_count: number }> | null }>(
              "search_entity",
              { query, entity: "tags", limit: opts?.limit ?? 50, offset: opts?.offset ?? 0 },
            );
            return res.tags ?? [];
          },
          // limit/offset are applied in SQL (`limit_offset_clause`), not by
          // slicing here — these used to fetch the whole table over IPC and
          // slice in JS, so a polite paging plugin paid the full-table cost
          // per page on a large library.
          async getArtists(opts) {
            return invoke<Array<{ id: number; name: string; track_count: number }>>("get_artists", {
              limit: opts?.limit ?? null,
              offset: opts?.offset ?? null,
            });
          },
          async getAlbums(opts) {
            return invoke<Array<{ id: number; title: string; artist_name: string | null; year: number | null }>>(
              "get_albums",
              {
                artistId: opts?.artistId ?? null,
                limit: opts?.limit ?? null,
                offset: opts?.offset ?? null,
              },
            );
          },
          async getTags(opts) {
            return invoke<Array<{ id: number; name: string; track_count: number }>>("get_tags", {
              limit: opts?.limit ?? null,
              offset: opts?.offset ?? null,
            });
          },
          async getTrackById(id: number) {
            return invoke<Track | null>("get_track_by_id", { trackId: id }).catch(() => null);
          },
          async getArtistById(id: number) {
            return invoke<{ id: number; name: string; track_count: number } | null>("get_artist_by_id", { artistId: id }).catch(() => null);
          },
          async getAlbumById(id: number) {
            return invoke<{ id: number; title: string; artist_name: string | null; year: number | null } | null>("get_album_by_id", { albumId: id }).catch(() => null);
          },
          async getTagById(id: number) {
            return invoke<{ id: number; name: string; track_count: number } | null>("get_tag_by_id", { tagId: id }).catch(() => null);
          },
          async getHistory(opts) {
            return invoke("get_history_recent", {
              limit: opts?.limit ?? 50,
              resolveAlbums: true,
            });
          },
          async getHistoryPlayCount() {
            return invoke<number>("get_history_play_count");
          },
          async getHistoryPlaysPage(opts) {
            return invoke("get_history_plays_page", {
              beforeTs: opts?.beforeTs ?? null,
              beforeId: opts?.beforeId ?? null,
              limit: opts?.limit ?? 20000,
            });
          },
          async getMostPlayed(opts) {
            if (opts?.days) {
              const sinceTs = Math.floor(Date.now() / 1000) - opts.days * 86400;
              return invoke("get_history_most_played_since", {
                sinceTs,
                limit: opts?.limit ?? 20,
              });
            }
            return invoke("get_history_most_played", {
              limit: opts?.limit ?? 20,
            });
          },
          async getMostPlayedArtists(opts) {
            if (opts?.days) {
              const sinceTs = Math.floor(Date.now() / 1000) - opts.days * 86400;
              return invoke("get_history_most_played_artists_since", {
                sinceTs,
                limit: opts?.limit ?? 20,
              });
            }
            return invoke("get_history_most_played_artists", {
              limit: opts?.limit ?? 20,
            });
          },
          async recordHistoryPlaysBatch(plays) {
            const tuples = plays.map(p => [p.artist, p.track, p.playedAt] as [string, string, number]);
            const [imported, skipped] = await invoke<[number, number]>("plugin_record_history_plays_batch", { plays: tuples });
            return { imported, skipped };
          },
          // Tag writes go through utils/tagOps.ts — the same code the control
          // API runs, including the recount + library refresh afterwards.
          async applyTags(trackId, tagNames) {
            const deps = hostCallbacksRef?.current?.tagOps ?? NO_TAG_REFRESH;
            const wanted = new Set((tagNames ?? []).map((n) => String(n).trim().toLowerCase()).filter(Boolean));
            if (wanted.size === 0) return [];
            const all = await editTrackTags(deps, trackId, { add: tagNames });
            // The tags this call applied, with their real ids (the backend
            // canonicalises spelling, so match case-insensitively).
            return all.filter((t) => wanted.has(t.name.toLowerCase()));
          },
          async applyTagsBulk(assignments) {
            return addTags(hostCallbacksRef?.current?.tagOps ?? NO_TAG_REFRESH, assignments);
          },
          async removeTags(trackIds, tagNames) {
            return removeTags(hostCallbacksRef?.current?.tagOps ?? NO_TAG_REFRESH, trackIds, tagNames);
          },
          async bulkUpdateTracks(trackIds, fields) {
            // Forward only the keys the plugin actually provided: an omitted key
            // leaves the field unchanged, a present `null` clears it.
            const edit: FileMetadataEdit = {};
            if (fields.artist_name !== undefined) edit.artistName = fields.artist_name;
            if (fields.album_artist_name !== undefined) edit.albumArtistName = fields.album_artist_name;
            if (fields.album_title !== undefined) edit.albumTitle = fields.album_title;
            if (fields.year !== undefined) edit.year = fields.year;
            if (fields.track_number !== undefined) edit.trackNumber = fields.track_number;
            if (fields.title !== undefined) edit.title = fields.title;
            if (fields.tag_names !== undefined) edit.tagNames = fields.tag_names;
            if (fields.tag_mode !== undefined) edit.tagMode = fields.tag_mode;
            return writeFileMetadata(hostCallbacksRef?.current?.tagOps ?? NO_TAG_REFRESH, trackIds, edit);
          },
          async replaceTrackFile(request) {
            const replace = hostCallbacksRef?.current?.replaceTrackFile;
            if (!replace) throw new Error("This Vibo can't replace library files for plugins yet");
            if (typeof request?.trackId !== "number" || typeof request.path !== "string" || !request.path) {
              throw new Error("replaceTrackFile needs { trackId: number, path: string }");
            }
            return replace(pluginId, request);
          },
          async findDuplicates(opts) {
            // Backend groups by diacritic-normalized title+artist (reusing the
            // shared strip_diacritics/unicode_lower SQL fns), optionally
            // constrained by duration/size tolerance. Each group is keeper-first.
            return invoke<Track[][]>("find_duplicate_tracks", {
              matchDuration: opts?.matchDuration ?? false,
              durationToleranceSecs: opts?.durationToleranceSecs ?? 2,
              matchSize: opts?.matchSize ?? false,
              sizeTolerancePct: opts?.sizeTolerancePct ?? 0.05,
              localOnly: opts?.localOnly ?? true,
            });
          },
          async getTrackLikeStates(tracks) {
            return invoke<number[]>("get_track_like_states", {
              tracks: tracks.map(t => ({ title: t.title, artistName: t.artistName ?? null })),
            });
          },
          async setTrackLikesBatch(tracks) {
            return invoke<number>("plugin_set_track_likes_batch", {
              tracks: tracks.map(t => ({
                title: t.title,
                artistName: t.artistName ?? null,
                liked: t.liked ?? 1,
                updatedAt: t.updatedAt ?? null,
              })),
            });
          },
          onTrackAdded: (handler) =>
            subscribeEvent(
              "track:added",
              handler as (...args: unknown[]) => void,
            ),
          onTrackRemoved: (handler) =>
            subscribeEvent(
              "track:removed",
              handler as (...args: unknown[]) => void,
            ),
          onScanComplete: (handler) =>
            subscribeEvent(
              "scan:complete",
              handler as (...args: unknown[]) => void,
            ),
          onLikeChanged: (handler) =>
            subscribeEvent(
              "like:changed",
              handler as (...args: unknown[]) => void,
            ),
        },

        playback: {
          setMarkers: (trackKey, markers) => {
            // Only for the track that is playing: a late answer for the song
            // before must not draw on this one.
            if (typeof trackKey !== "string" || trackKey !== currentTrackRef.current?.key) return;
            hostCallbacksRef?.current?.setSeekMarkers?.(pluginId, trackKey, sanitizeSeekMarkers(markers));
          },
          reportScrobble: (report) => {
            const clean = coerceScrobbleReport(report);
            if (!clean) throw new Error("reportScrobble: status must be one of sent, queued, skipped, failed");
            // Only a scrobbler has a row to show it under.
            if (!eventHandlersRef.current["track:scrobbled"].some((h) => h.pluginId === pluginId)) {
              recordPluginLog("warn", "reportScrobble ignored: subscribe with onTrackScrobbled first", pluginId);
              return;
            }
            hostCallbacksRef?.current?.reportScrobble?.(pluginId, clean);
          },
          getCurrentTrack: () => currentTrackRef.current,
          isPlaying: () => playingRef.current ?? false,
          getPosition: () => positionRef.current ?? 0,
          getQueue: () => queueRef.current ?? { tracks: [], index: 0 },
          onQueueChanged: (handler) =>
            subscribeEvent("queue:changed", handler as (...args: unknown[]) => void),
          onLevel: (handler) => {
            // One shared meter for every subscriber (levelStore ref-counts it).
            // Tracked like the other subscriptions so an unload releases the
            // hold — a forgotten one would keep the engine measuring all session.
            const fail = (e: unknown) => console.error(`[plugin:${pluginId}] onLevel handler failed:`, e);
            const unsub = watchPlaybackLevel((level) => {
              try {
                // A worker plugin's handler is an RPC stub returning a
                // (callable) promise, so a throw there arrives as a rejection.
                const ret: unknown = handler(level ? { peakDb: [...level.peakDb], rmsDb: [...level.rmsDb] } : null);
                if (ret && typeof (ret as Promise<unknown>).catch === "function") (ret as Promise<unknown>).catch(fail);
              } catch (e) {
                fail(e);
              }
            });
            trackUnsubscribe(unsub);
            return unsub;
          },
          playTrack: (track) => {
            playbackCallbacksRef.current?.playTrack(track);
          },
          playTracks: (tracks, startIndex, context) => {
            playbackCallbacksRef.current?.playTracks(tracks, startIndex, context);
          },
          insertTrack: (track, position) => {
            playbackCallbacksRef.current?.insertTrack(track, position);
          },
          insertTracks: (tracks, position) => {
            playbackCallbacksRef.current?.insertTracks(tracks, position);
          },
          playWithBackfill: (opts) =>
            playbackCallbacksRef.current?.playWithBackfill(opts) ?? Promise.resolve(0),
          onTrackStarted: (handler) =>
            subscribeEvent(
              "track:started",
              handler as (...args: unknown[]) => void,
            ),
          onTrackScrobbled: (handler) =>
            subscribeEvent(
              "track:scrobbled",
              handler as (...args: unknown[]) => void,
            ),
          onAutoContinue(handler) {
            loaded.autoContinueHandler = handler;
            const unsub = () => {
              if (loaded.autoContinueHandler === handler) loaded.autoContinueHandler = null;
            };
            trackUnsubscribe(unsub);
            return unsub;
          },
          onStreamResolve(
            providerId: string,
            handler: (title: string, artistName: string | null, albumName: string | null, durationSecs: number | null) => Promise<{ url: string; label: string } | null>,
          ): () => void {
            return trackUnsubscribe(registerKeyed(loaded.streamResolveHandlers, providerId, handler));
          },
          onResolveStreamByUri(
            scheme: string,
            handler: (id: string, quality?: string | null, opts?: { externalAudio?: boolean; fresh?: boolean; video?: boolean }) => Promise<string | { candidates: StreamCandidate[]; sourceUrl?: string } | null>,
          ): () => void {
            // Resolution walks loaded plugins in load order and first-wins, so
            // a collision is silent nondeterminism at play time — surface it at
            // registration, where the author can still see it.
            for (const [, lp] of loadedPluginsRef.current) {
              if (lp.id !== pluginId && lp.streamUriResolvers.has(scheme)) {
                console.warn(`[plugin:${pluginId}] stream scheme "${scheme}://" is already registered by plugin "${lp.id}" — the first-loaded plugin wins at resolve time`);
              }
            }
            return trackUnsubscribe(registerKeyed(loaded.streamUriResolvers, scheme, handler));
          },
          onResolveStoryboard(
            scheme: string,
            handler: (id: string) => Promise<Storyboard | null>,
          ): () => void {
            // Same first-wins collision hazard as onResolveStreamByUri above.
            for (const [, lp] of loadedPluginsRef.current) {
              if (lp.id !== pluginId && lp.storyboardResolvers.has(scheme)) {
                console.warn(`[plugin:${pluginId}] storyboard scheme "${scheme}://" is already registered by plugin "${lp.id}" — the first-loaded plugin wins at resolve time`);
              }
            }
            return trackUnsubscribe(registerKeyed(loaded.storyboardResolvers, scheme, handler));
          },
        },

        contextMenu: {
          onAction: (actionId, handler) => {
            loaded.contextMenuHandlers.set(actionId, handler);
          },
          registerItem: (item: PluginDynamicMenuItem): (() => void) => {
            const key = `${pluginId}:${item.id}`;
            const entry = {
              pluginId,
              id: item.id,
              label: item.label,
              targets: item.targets,
              submenuLabel: item.submenuLabel,
              order: item.order,
            };
            return trackUnsubscribe(registerKeyed(dynamicMenuItemsRef.current, key, entry, () => setDynamicMenuItemsVersion((v) => v + 1)));
          },
          unregisterItem: (itemId: string): void => {
            const key = `${pluginId}:${itemId}`;
            if (dynamicMenuItemsRef.current.delete(key)) {
              setDynamicMenuItemsVersion((v) => v + 1);
            }
          },
        },

        ui: {
          setViewData: (viewId, data, opts) => {
            const key = `${pluginId}:${viewId}`;
            viewDataRef.current.set(key, data);
            if (opts && typeof opts.scrollKey === "string") {
              viewScrollKeyRef.current.set(key, opts.scrollKey);
            } else {
              viewScrollKeyRef.current.delete(key);
            }
            setViewData(new Map(viewDataRef.current));
          },
          showNotification: (message, options) => {
            // Was `showNotification(message) ?? console.log(...)`, which always
            // logged: showNotification returns void, so the `??` right-hand side
            // ran whether or not a host was attached. The console line is the
            // fallback for a host that has none (tests, an early activate).
            const notify = hostCallbacksRef?.current?.showNotification;
            // The button runs this plugin's own UI action — never another
            // plugin's, and nothing when the plugin registered no such action.
            const a = options?.action;
            const action: ToastAction | undefined =
              a && typeof a.label === "string" && a.label.trim() && typeof a.id === "string"
                ? {
                    label: a.label.trim().slice(0, 40),
                    run: () => {
                      const handler = loaded.uiActionHandlers.get(a.id);
                      if (!handler) {
                        console.error(`[plugin:${pluginId}] notification action ${a.id} has no handler`);
                        return;
                      }
                      try {
                        handler(undefined);
                      } catch (e) {
                        console.error(`[plugin:${pluginId}] notification action ${a.id} error:`, e);
                      }
                    },
                  }
                : undefined;
            const kind = coerceToastKind(options?.kind);
            // The host names the plugin (a source line on the toast and in the
            // notifications list); a plugin can't speak as anyone else.
            if (notify) notify(message, { action, kind, source: loaded.manifest.name || pluginId });
            else console.info(`[plugin:${pluginId}]`, message);
          },
          navigateToView: (viewId) => {
            hostCallbacksRef?.current?.navigateToPluginView(pluginId, viewId);
          },
          requestAction: (action, payload) => {
            hostCallbacksRef?.current?.requestAction(pluginId, action, payload);
          },
          onAction: (actionId, handler) => {
            loaded.uiActionHandlers.set(actionId, handler);
          },
          navigateToEntity: (kind, ref, opts) => {
            const name = typeof ref?.name === "string" ? ref.name.trim() : "";
            if (!name || (kind !== "track" && kind !== "album" && kind !== "artist")) {
              throw new Error("ui.navigateToEntity: a kind (track, album or artist) and a name are required");
            }
            const artistName = typeof ref.artistName === "string" && ref.artistName.trim() ? ref.artistName.trim() : undefined;
            const albumTitle = typeof ref.albumTitle === "string" && ref.albumTitle.trim() ? ref.albumTitle.trim() : undefined;
            if (opts?.tab && typeof opts.tab === "string") {
              requestDetailTab({ kind, name, artistName }, opts.tab);
            }
            hostCallbacksRef?.current?.navigateToEntity?.(kind, { name, artistName, albumTitle });
          },
          async pickFolder(opts?: { title?: string; defaultPath?: string }) {
            const picked = await openDialog({
              directory: true,
              multiple: false,
              canCreateDirectories: true,
              title: typeof opts?.title === "string" ? opts.title : undefined,
              defaultPath: typeof opts?.defaultPath === "string" ? opts.defaultPath : undefined,
            });
            return typeof picked === "string" ? picked : null;
          },
          getContext: async () => hostCallbacksRef?.current?.getUiContext?.() ?? null,
          onContextChanged: (handler) =>
            subscribeEvent("ui:context-changed", handler as (...args: unknown[]) => void),
          setBadge: (viewId: string, badge: PluginBadge) => {
            const key = `${pluginId}:${viewId}`;
            if (badge === null) {
              badgeMapRef.current.delete(key);
            } else {
              badgeMapRef.current.set(key, badge);
            }
            setBadgeMap(new Map(badgeMapRef.current));
          },
          setViewHeader: (viewId: string, header: PluginViewHeader | null) => {
            const key = `${pluginId}:${viewId}`;
            const clean = sanitizeViewHeader(header);
            if (clean === null) viewHeadersRef.current.delete(key);
            else viewHeadersRef.current.set(key, clean);
            setViewHeaders(new Map(viewHeadersRef.current));
          },
        },

        storage: {
          async get<T>(key: string): Promise<T | undefined> {
            const value = await invoke<string | null>(
              "plugin_storage_get",
              { pluginId, key },
            );
            if (value === null || value === undefined) return undefined;
            return JSON.parse(value) as T;
          },
          async set(key: string, value: unknown): Promise<void> {
            await invoke("plugin_storage_set", {
              pluginId,
              key,
              value: JSON.stringify(value),
            });
          },
          async delete(key: string): Promise<void> {
            await invoke("plugin_storage_delete", { pluginId, key });
          },
          async cacheFile(subdir: string, filename: string, url: string, init?: PluginDownloadInit): Promise<string> {
            return invoke<string>("plugin_cache_image", { pluginId, subdir, filename, url, headers: init?.headers ?? null, allowedHosts: allowedHosts() });
          },
          async getCachePath(subdir: string, filename: string): Promise<string | null> {
            return invoke<string | null>("plugin_cache_get_path", { pluginId, subdir, filename });
          },
          async listCacheDirs(): Promise<string[]> {
            return invoke<string[]>("plugin_cache_list_dirs", { pluginId });
          },
          async deleteCacheDir(subdir: string): Promise<void> {
            await invoke("plugin_cache_delete_dir", { pluginId, subdir });
          },
          files: {
            async writeJson(path: string[], data: unknown): Promise<string> {
              return invoke<string>("plugin_files_write_text", {
                pluginId,
                path,
                content: JSON.stringify(data),
              });
            },
            async readJson<T>(path: string[]): Promise<T | null> {
              const raw = await invoke<string | null>("plugin_files_read_text", { pluginId, path });
              if (raw === null || raw === undefined) return null;
              return JSON.parse(raw) as T;
            },
            async writeText(path: string[], content: string): Promise<string> {
              return invoke<string>("plugin_files_write_text", { pluginId, path, content });
            },
            async readText(path: string[]): Promise<string | null> {
              const raw = await invoke<string | null>("plugin_files_read_text", { pluginId, path });
              return raw ?? null;
            },
            async download(path: string[], url: string, init?: PluginDownloadInit): Promise<string> {
              return invoke<string>("plugin_files_download", { pluginId, path, url, headers: init?.headers ?? null, allowedHosts: allowedHosts() });
            },
            async getPath(path: string[]): Promise<string | null> {
              return invoke<string | null>("plugin_files_get_path", { pluginId, path });
            },
            async exists(path: string[]): Promise<boolean> {
              return invoke<boolean>("plugin_files_exists", { pluginId, path });
            },
            async list(path: string[]): Promise<{ name: string; isDir: boolean }[]> {
              return invoke<{ name: string; is_dir: boolean; size?: number; modified_at?: number }[]>("plugin_files_list", { pluginId, path })
                .then((entries) => entries.map((e) => ({ name: e.name, isDir: e.is_dir, size: e.size, modifiedAt: e.modified_at })));
            },
            async remove(path: string[]): Promise<void> {
              await invoke("plugin_files_remove", { pluginId, path });
            },
            async copy(src: string[], dst: string[]): Promise<void> {
              await invoke("plugin_files_copy", { pluginId, src, dst });
            },
            async move(src: string[], dst: string[]): Promise<void> {
              await invoke("plugin_files_move", { pluginId, src, dst });
            },
          },
        },

        network: {
          async fetch(url, init) {
            fetchUrlCallbackRef.current?.(url);
            const abort = armFetchAbort(pluginId, init, (requestId) => {
              invoke("plugin_fetch_cancel", { requestId }).catch((e) => console.error("Failed to cancel plugin fetch:", e));
            });
            let resp: { status: number; body: string; headers?: PluginHeaderPairs; url?: string };
            try {
              resp = await invoke<{ status: number; body: string; headers?: PluginHeaderPairs; url?: string }>(
                "plugin_fetch",
                {
                  url,
                  method: init?.method ?? null,
                  headers: init?.headers ?? null,
                  body: init?.body ?? null,
                  insecure: init?.insecure ?? null,
                  timeoutMs: init?.timeoutMs ?? null,
                  allowedHosts: allowedHosts(),
                  requestId: abort?.requestId ?? null,
                },
              );
            } catch (e) {
              throw isFetchAborted(e) ? abortError() : e;
            } finally {
              abort?.settle();
            }
            const bodyText = resp.body;
            // Older backends sent no headers at all; treat that as none rather
            // than throwing, so a plugin can feature-detect on the array.
            const headerPairs = resp.headers ?? [];
            return {
              status: resp.status,
              headers: foldHeaderPairs(headerPairs),
              getSetCookie: () => setCookieValues(headerPairs),
              // The final URL after redirects (absent on older backends). What
              // lets a plugin spot an ISP block page: HTTP 200 from a host it
              // never asked.
              url: resp.url,
              text: async () => bodyText,
              json: async () => JSON.parse(bodyText),
            };
          },
          async openUrl(url: string) {
            await openUrl(url);
          },
          onDeepLink(handler: (url: string) => void) {
            loaded.deepLinkHandlers.push(handler);
            return () => {
              const idx = loaded.deepLinkHandlers.indexOf(handler);
              if (idx >= 0) loaded.deepLinkHandlers.splice(idx, 1);
            };
          },
          async openBrowseWindow(url, opts) {
            const label = `browse-${pluginId}-${Date.now()}`;
            await invoke("open_browse_window", {
              url,
              label,
              title: opts?.title ?? null,
              width: opts?.width ?? null,
              height: opts?.height ?? null,
              visible: opts?.visible ?? null,
            });

            const messageHandlers: Array<(msg: { type: string; data: unknown }) => void> = [];
            const navHandlers: Array<(url: string) => void> = [];
            const unlisteners: UnlistenFn[] = [];

            const msgUnlisten = await listen<{ label: string; msg_type: string; data: string }>(
              "browse-window-message",
              (event) => {
                if (event.payload.label !== label) return;
                let parsed: unknown;
                try { parsed = JSON.parse(event.payload.data); } catch { parsed = event.payload.data; }
                const msg = { type: event.payload.msg_type, data: parsed };
                for (const h of messageHandlers) {
                  try { h(msg); } catch (e) { console.error(`[plugin:${pluginId}] browse message error:`, e); }
                }
              },
            );
            unlisteners.push(msgUnlisten);

            const navUnlisten = await listen<{ label: string; url: string }>(
              "browse-window-navigation",
              (event) => {
                if (event.payload.label !== label) return;
                for (const h of navHandlers) {
                  try { h(event.payload.url); } catch (e) { console.error(`[plugin:${pluginId}] browse nav error:`, e); }
                }
              },
            );
            unlisteners.push(navUnlisten);

            const closeUnlisten = await listen<{ label: string }>(
              "browse-window-closed",
              (event) => {
                if (event.payload.label !== label) return;
                const msg = { type: "window-closed", data: {} };
                for (const h of messageHandlers) {
                  try { h(msg); } catch (e) { console.error(`[plugin:${pluginId}] browse close error:`, e); }
                }
              },
            );
            unlisteners.push(closeUnlisten);

            // Clean up listeners when plugin deactivates (safeUnlisten guards the
            // tauri 2.11 stale-id rejection if the same handle is also close()d).
            for (const ul of unlisteners) trackUnsubscribe(() => safeUnlisten(ul));

            return {
              async eval(js: string) {
                await invoke("browse_window_eval", { label, js });
              },
              async close() {
                for (const ul of unlisteners) safeUnlisten(ul);
                await invoke("close_browse_window", { label });
              },
              async show() {
                await invoke("browse_window_set_visible", { label, visible: true });
              },
              async hide() {
                await invoke("browse_window_set_visible", { label, visible: false });
              },
              async devtools() {
                await invoke("open_devtools_for_window", { label });
              },
              onMessage(handler) {
                messageHandlers.push(handler);
                return () => {
                  const idx = messageHandlers.indexOf(handler);
                  if (idx >= 0) messageHandlers.splice(idx, 1);
                };
              },
              onNavigation(handler) {
                navHandlers.push(handler);
                return () => {
                  const idx = navHandlers.indexOf(handler);
                  if (idx >= 0) navHandlers.splice(idx, 1);
                };
              },
            };
          },
        },


        collections: {
          async getLocalCollections() {
            const all = await invoke<Collection[]>("get_collections");
            return all
              .filter((c) => c.kind === "local")
              .map((c) => ({ id: c.id, name: c.name, path: c.path }));
          },
          async resync(collectionId: number): Promise<void> {
            // Returns as soon as the rescan is spawned, not when it finishes —
            // the backend guards against a second run for the same collection,
            // so calling this after every file drop is safe. Completion arrives
            // via api.library.onScanComplete.
            await invoke("resync_collection", { collectionId });
          },
          async trashPath(collectionId: number, relativePath: string): Promise<void> {
            // The root and the traversal checks live in Rust — the frontend is
            // not the trust boundary for a delete inside the user's music.
            await invoke("plugin_trash_collection_path", { collectionId, relativePath });
          },
          async requestAdd(source) {
            const open = hostCallbacksRef?.current?.requestAddCollection;
            if (!open) throw new Error("This Vibo can't open the Add dialog for plugins yet");
            const kind = source?.kind;
            if ((kind !== "subsonic" && kind !== "manifest") || typeof source.url !== "string") {
              throw new Error('requestAdd needs { kind: "subsonic" | "manifest", url: string }');
            }
            let protocol = "";
            try {
              protocol = new URL(source.url).protocol;
            } catch {
              // Reported below as not an http(s) URL.
            }
            if (protocol !== "http:" && protocol !== "https:") {
              throw new Error("requestAdd needs an http(s) url");
            }
            open(pluginId, source);
          },
        },

        playlists: {
          async save(data: {
            name: string;
            source?: string;
            imageUrl?: string;
            description?: string;
            metadata?: Record<string, unknown>;
            tracks: Array<{
              title: string;
              artistName?: string;
              albumName?: string;
              durationSecs?: number;
              source?: string;
              imageUrl?: string;
            }>;
          }): Promise<number> {
            return invoke<number>("save_playlist_record", {
              name: data.name,
              source: data.source ?? null,
              imageUrl: data.imageUrl ?? null,
              description: data.description ?? null,
              metadata: data.metadata ? JSON.stringify(data.metadata) : null,
              tracks: data.tracks.map((t) => ({
                title: t.title,
                artist_name: t.artistName ?? null,
                album_name: t.albumName ?? null,
                duration_secs: t.durationSecs ?? null,
                source: t.source ?? null,
                image_url: t.imageUrl ?? null,
              })),
            });
          },
          async list() {
            const rows = await invoke<Array<{
              id: number;
              name: string;
              source: string | null;
              saved_at: number;
              image_path: string | null;
              track_count: number;
              description: string | null;
              metadata: string | null;
            }>>("get_playlists");
            return rows.map((r) => ({
              id: r.id,
              name: r.name,
              source: r.source,
              savedAt: r.saved_at,
              imagePath: r.image_path,
              trackCount: r.track_count,
              description: r.description,
              metadata: r.metadata ? JSON.parse(r.metadata) : null,
            }));
          },
          async delete(id: number) {
            await invoke("delete_playlist_record", { playlistId: id });
          },
          async getTracks(id: number) {
            const rows = await invoke<Array<{
              title: string;
              artist_name: string | null;
              album_name: string | null;
              duration_secs: number | null;
              source: string | null;
              image_path: string | null;
            }>>("get_playlist_tracks", { playlistId: id });
            return rows.map((r) => ({
              title: r.title,
              artistName: r.artist_name,
              albumName: r.album_name,
              durationSecs: r.duration_secs,
              source: r.source,
              imagePath: r.image_path,
            }));
          },
        },

        cues: {
          get(title, artistName) {
            return invoke<PluginCueSheet | null>("cue_sheet_get", { title, artistName: artistName ?? null });
          },
          list() {
            return invoke<PluginCueSheet[]>("cue_sheet_list");
          },
          // The same save the control API runs (utils/cueOps.ts): the past-
          // the-end check, and the album / length filled from what the app
          // knows when the plugin doesn't say. A declared `durationSecs` wins
          // — a shared sheet was timed to its author's copy. The command
          // normalizes and emits `cue-sheet-changed`, so an open Now Playing
          // view picks up a sheet a plugin installs mid-song.
          set(title, artistName, sheet, meta) {
            return saveCueSheet<PluginCueSheet>(
              {
                currentTrack: () => currentTrackRef.current,
                currentDurationSecs: () => null,
                queue: () => queueRef.current?.tracks ?? [],
              },
              { title, artistName: artistName ?? null },
              sheet,
              { author: meta?.author ?? null, albumName: meta?.albumName ?? null, durationSecs: meta?.durationSecs ?? null },
            );
          },
          delete(title, artistName) {
            return invoke<boolean>("cue_sheet_delete", { title, artistName: artistName ?? null });
          },
        },

        waveforms: {
          onLookup(handler) {
            loaded.waveformLookupHandler = handler;
            const unsub = () => {
              if (loaded.waveformLookupHandler === handler) loaded.waveformLookupHandler = null;
            };
            trackUnsubscribe(unsub);
            return unsub;
          },
          onShare(handler) {
            loaded.waveformShareHandler = handler;
            const unsub = () => {
              if (loaded.waveformShareHandler === handler) loaded.waveformShareHandler = null;
            };
            trackUnsubscribe(unsub);
            return unsub;
          },
        },

        lyrics: {
          // The same write as the in-app lyrics editor: the song's cached
          // lyrics become these, and every open view of it re-reads.
          async save(track, lyrics) {
            const title = typeof track?.title === "string" ? track.title.trim() : "";
            if (!title) throw new Error("lyrics.save: track.title is required");
            if (lyrics?.kind !== "synced" && lyrics?.kind !== "plain") {
              throw new Error('lyrics.save: kind must be "synced" or "plain"');
            }
            if (typeof lyrics.text !== "string" || !lyrics.text.trim()) {
              throw new Error("lyrics.save: text is required");
            }
            if (lyrics.text.length > MAX_PLUGIN_LYRICS_CHARS) {
              throw new Error(`lyrics.save: text is longer than ${MAX_PLUGIN_LYRICS_CHARS} characters`);
            }
            const entity: InfoEntity = { kind: "track", name: title, id: 0 };
            if (track.artistName) entity.artistName = track.artistName;
            if (track.albumTitle) entity.albumTitle = track.albumTitle;
            await saveInfoValue({ typeId: "lyrics", entity, value: { text: lyrics.text, kind: lyrics.kind } });
          },
        },

        informationTypes: {
          async setSectionData(typeId, entity, data) {
            await saveOwnInfoValue({ pluginId, ...sectionDataRequest(typeId, entity, data) });
          },
          onFetch(
            infoTypeId: string,
            handler: (entity: InfoEntity) => Promise<InfoFetchResult>,
            opts?: { provider?: string },
          ): () => void {
            const key = handlerKey(infoTypeId, opts?.provider);
            return trackUnsubscribe(registerKeyed(loaded.infoFetchHandlers, key, handler));
          },
          async searchValues(query, opts) {
            const matches = await invoke<InfoValueMatch[]>("search_information_values", {
              query,
              typeId: opts?.typeId ?? null,
              displayKind: opts?.displayKind ?? null,
              entity: opts?.entity ?? null,
              jsonPath: opts?.jsonPath ?? null,
              matchMode: opts?.matchMode ?? null,
              requireTextMatch: opts?.requireTextMatch ?? false,
              resolveTracks: opts?.resolveTracks ?? false,
              limit: opts?.limit ?? 50,
            });
            // Hand the plugin the parsed value, not the raw JSON string.
            return matches.map((m) => ({ ...m, value: parsePluginJson(m.value) }));
          },
          async getValuesForEntity(entity) {
            const entityKey = buildEntityKey(entity);
            const rows = await invoke<Array<[number, string, string, string, number]>>(
              "info_get_values_for_entity",
              { entityKey },
            );
            return rows.map(([, typeId, value, status, fetchedAt]) => ({
              typeId,
              value: parsePluginJson(value),
              status,
              fetchedAt,
            }));
          },
          async getValue(typeId, entity) {
            const entityKey = buildEntityKey(entity);
            const rows = await invoke<Array<[number, string, string, string, number]>>(
              "info_get_values_for_entity",
              { entityKey },
            );
            const hit = rows.find((r) => r[1] === typeId);
            if (!hit) return null;
            return { typeId: hit[1], value: parsePluginJson(hit[2]), status: hit[3], fetchedAt: hit[4] };
          },
          async fetch(typeId, entity, opts) {
            // The control API's info.fetch, offered to plugins: cache-first,
            // otherwise the user-ordered provider chain (fetchInfoValue), with
            // the result written into the shared cache the detail pages read.
            // Not an escape hatch — a plugin cannot reach a provider the user
            // disabled, and the answer is the one the page would render.
            const infoFetch = invokeInfoFetchRef.current;
            if (!infoFetch) throw new Error("information types are not ready yet");
            if (typeof typeId !== "string" || !typeId) throw new Error("typeId is required");
            if (!entity || typeof entity !== "object" || typeof entity.name !== "string" || !entity.name) {
              throw new Error("entity with a kind and a name is required");
            }
            if (!["track", "artist", "album", "tag"].includes(entity.kind)) {
              throw new Error('entity.kind must be "track", "artist", "album" or "tag"');
            }
            // Plugins build entities from metadata; resolve the library id
            // best-effort when they didn't (0 = not in library, tolerated by
            // every provider), so handlers keyed on `entity.id` still work.
            const id = typeof entity.id === "number" && entity.id > 0
              ? entity.id
              : await resolveInfoEntityId(entity);
            return fetchInfoValue({
              typeId,
              entity: { ...entity, id },
              pluginId: opts?.pluginId,
              force: opts?.force,
              invokeInfoFetch: infoFetch,
              pluginNames: pluginNamesRef.current,
            });
          },
        },

        home: {
          onFetchShelf(shelfId: string, handler: (limit: number) => Promise<HomeShelfResult>): () => void {
            const key = `${pluginId}:${shelfId}`;
            return trackUnsubscribe(registerKeyed(homeShelfHandlersRef.current, key, handler));
          },
          registerShelf(descriptor: {
            id: string;
            title: string;
            displayKind: HomeShelfDisplayKind;
            limit?: number;
            icon?: string;
          }): () => void {
            const key = `${pluginId}:${descriptor.id}`;
            const entry = {
              pluginId,
              shelfId: descriptor.id,
              title: descriptor.title,
              displayKind: descriptor.displayKind,
              limit: descriptor.limit ?? 20,
              icon: descriptor.icon,
            };
            return trackUnsubscribe(registerKeyed(dynamicHomeShelvesRef.current, key, entry, () => setDynamicShelvesVersion((v) => v + 1)));
          },
          unregisterShelf(shelfId: string): void {
            const key = `${pluginId}:${shelfId}`;
            if (dynamicHomeShelvesRef.current.delete(key)) {
              setDynamicShelvesVersion((v) => v + 1);
            }
          },
          onItemClick(shelfId: string, handler: (item: HomeShelfItem) => void | Promise<void>): () => void {
            const key = `${pluginId}:${shelfId}`;
            return trackUnsubscribe(registerKeyed(homeShelfClickHandlersRef.current, key, handler));
          },
          onResolvePlay(shelfId: string, handler: (item: HomeShelfItem) => Promise<PluginTrack[]>): () => void {
            const key = `${pluginId}:${shelfId}`;
            return trackUnsubscribe(registerKeyed(homeShelfResolvePlayHandlersRef.current, key, handler));
          },
        },

        visualizers: {
          onMount(id: string, factory: () => PluginVisualizer): () => void {
            return trackUnsubscribe(registerKeyed(loaded.visualizerFactories, id, factory));
          },
          register(descriptor: PluginVisualizerDescriptor): () => void {
            const key = `${pluginId}:${descriptor.id}`;
            const entry = { pluginId, ...descriptor };
            return trackUnsubscribe(registerKeyed(dynamicVisualizersRef.current, key, entry, () => setDynamicVisualizersVersion((v) => v + 1)));
          },
          unregister(id: string): void {
            if (dynamicVisualizersRef.current.delete(`${pluginId}:${id}`)) {
              setDynamicVisualizersVersion((v) => v + 1);
            }
          },
        },

        search: {
          onQuery(
            providerId: string,
            handler: (query: string, limit: number) => Promise<PluginSearchResult>,
          ): () => void {
            const key = `${pluginId}:${providerId}`;
            return trackUnsubscribe(registerKeyed(searchHandlersRef.current, key, handler));
          },
          registerProvider(descriptor: { id: string; name: string; icon?: string }): () => void {
            const key = `${pluginId}:${descriptor.id}`;
            const entry = {
              pluginId,
              providerId: descriptor.id,
              name: descriptor.name,
              icon: descriptor.icon,
            };
            return trackUnsubscribe(registerKeyed(dynamicSearchProvidersRef.current, key, entry, () => setDynamicSearchProvidersVersion((v) => v + 1)));
          },
          unregisterProvider(providerId: string): void {
            const key = `${pluginId}:${providerId}`;
            if (dynamicSearchProvidersRef.current.delete(key)) {
              setDynamicSearchProvidersVersion((v) => v + 1);
            }
          },
          listProviders() {
            // The user-visible list (Extensions → Contributions filter applied),
            // exactly what Cmd+K and the control API offer.
            return listSearchProviders(registry());
          },
          async query(providerKey, query, limit) {
            if (typeof providerKey !== "string" || !providerKey) throw new Error("providerKey is required (see listProviders())");
            if (typeof query !== "string" || !query) throw new Error("query is required");
            const { result } = await searchCatalog(registry(), { providerKey, query, limit }, crossCall);
            return result;
          },
        },

        webSearch: {
          onQuery(
            providerId: string,
            handler: (query: string, limit: number) => Promise<PluginWebSearchResult>,
          ): () => void {
            const key = `${pluginId}:${providerId}`;
            return trackUnsubscribe(registerKeyed(webSearchHandlersRef.current, key, handler));
          },
          registerProvider(descriptor: { id: string; name: string; icon?: string }): () => void {
            const key = `${pluginId}:${descriptor.id}`;
            const entry = { pluginId, providerId: descriptor.id, name: descriptor.name, icon: descriptor.icon };
            return trackUnsubscribe(registerKeyed(dynamicWebSearchProvidersRef.current, key, entry, () => publishDynamicWebSearchProviders()));
          },
          unregisterProvider(providerId: string): void {
            if (dynamicWebSearchProvidersRef.current.delete(`${pluginId}:${providerId}`)) {
              publishDynamicWebSearchProviders();
            }
          },
          listProviders() {
            return listWebSearchProviders(registry());
          },
          async query(query, opts) {
            if (typeof query !== "string" || !query.trim()) throw new Error("query is required");
            const provider = typeof opts?.provider === "string" && opts.provider ? opts.provider : undefined;
            return webSearch(registry(), { query, limit: opts?.limit, provider }, crossCall);
          },
        },

        plugins: {
          list() {
            const r = registry();
            return describePlugins(r.pluginStates, {
              searchProviders: r.searchProviders,
              webSearchProviders: r.webSearchProviders,
              homeShelves: r.homeShelves,
              menuItems: r.menuItems,
              assistantTools: r.assistantTools,
            });
          },
        },

        assistant: {
          registerTool(descriptor: PluginAssistantToolDescriptor): () => void {
            const key = `${pluginId}:${descriptor.name}`;
            const entry = {
              pluginId,
              name: descriptor.name,
              description: descriptor.description,
              inputSchema: descriptor.inputSchema,
              readOnly: descriptor.readOnly === true,
            };
            return trackUnsubscribe(registerKeyed(dynamicAssistantToolsRef.current, key, entry, () => setAssistantVersion((v) => v + 1)));
          },
          unregisterTool(name: string): void {
            const key = `${pluginId}:${name}`;
            if (dynamicAssistantToolsRef.current.delete(key)) {
              setAssistantVersion((v) => v + 1);
            }
          },
          onTool(
            name: string,
            handler: (args: Record<string, unknown>) => Promise<unknown>,
          ): () => void {
            const key = `${pluginId}:${name}`;
            return trackUnsubscribe(registerKeyed(assistantToolHandlersRef.current, key, handler));
          },
          setInstructions(text: string): void {
            runtimeAssistantInstructionsRef.current.set(pluginId, text);
            setAssistantVersion((v) => v + 1);
          },
          listTools(targetPluginId) {
            return listAssistantTools(registry(), targetPluginId);
          },
          async invoke(targetPluginId, tool, args) {
            if (typeof targetPluginId !== "string" || !targetPluginId) throw new Error("pluginId is required");
            if (typeof tool !== "string" || !tool) throw new Error("tool is required");
            return invokeAssistantToolOp(registry(), { pluginId: targetPluginId, tool, args }, crossCall);
          },
          // The app's own assistant tools — the MCP server's catalog, run
          // in-process through the control API (see utils/hostAssistantTools.ts).
          host: {
            listTools() {
              return listHostTools(inProcessContext(`plugin:${pluginId}`));
            },
            instructions() {
              return hostInstructions();
            },
            invoke(name, args) {
              return invokeHostTool(inProcessContext(`plugin:${pluginId}`), name, args);
            },
          },
        },

        nowPlayingInfo: {
          registerItem(descriptor: { id: string; label: string; priority?: number; defaultEnabled?: boolean }): () => void {
            const key = `${pluginId}:${descriptor.id}`;
            const entry = {
              pluginId,
              itemId: descriptor.id,
              label: descriptor.label,
              priority: descriptor.priority ?? 100,
              defaultEnabled: descriptor.defaultEnabled ?? false,
            };
            return trackUnsubscribe(registerKeyed(nowPlayingInfoItemsRef.current, key, entry, () => setNowPlayingInfoVersion((v) => v + 1)));
          },
          unregisterItem(id: string): void {
            const key = `${pluginId}:${id}`;
            if (nowPlayingInfoItemsRef.current.delete(key)) {
              setNowPlayingInfoVersion((v) => v + 1);
            }
          },
          onFetch(id: string, handler: (track: PluginTrack) => Promise<NowPlayingInfoResult>): () => void {
            const key = `${pluginId}:${id}`;
            return trackUnsubscribe(registerKeyed(nowPlayingInfoHandlersRef.current, key, handler));
          },
        },

        imageProviders: {
          onFetch(
            entity: "artist" | "album" | "tag",
            handler: (name: string, artistName?: string) => Promise<ImageFetchResult>,
            opts?: { provider?: string },
          ): () => void {
            const key = handlerKey(entity, opts?.provider);
            return trackUnsubscribe(registerKeyed(loaded.imageFetchHandlers, key, handler));
          },
        },

        downloads: {
          // There is no `enqueue` any more — the background download queue
          // (`enqueue_download`) was removed with the batch menu entries. A
          // plugin that wants a download UI opens the host modal via
          // requestAction("download-tracks"), or downloads itself.
          reportProgress(progress: DownloadResolveProgress): void {
            // Only the resolve the host is currently awaiting has a listener;
            // outside that window this is deliberately a no-op, so a provider
            // can report unconditionally without knowing who called it.
            const scopes = resolveScopesRef.current.get(pluginId);
            const scope = scopes && scopes.length ? scopes[scopes.length - 1] : undefined;
            try { scope?.onProgress?.(progress); }
            catch (e) { console.error(`Download progress handler error [${pluginId}]:`, e); }
          },
          onResolveByUri(providerId: string, handler: DownloadResolveByUriHandler): () => void {
            return trackUnsubscribe(registerKeyed(loaded.downloadResolveByUriHandlers, providerId, handler));
          },
          onResolveByMetadata(providerId: string, handler: DownloadResolveByMetadataHandler): () => void {
            return trackUnsubscribe(registerKeyed(loaded.downloadResolveByMetadataHandlers, providerId, handler));
          },
          onInteractiveSearch(providerId: string, handler: InteractiveSearchHandler): () => void {
            return trackUnsubscribe(registerKeyed(loaded.interactiveSearchHandlers, providerId, handler));
          },
          onInteractiveResolve(providerId: string, handler: InteractiveResolveHandler): () => void {
            return trackUnsubscribe(registerKeyed(loaded.interactiveResolveHandlers, providerId, handler));
          },
          onGetQualities(providerId: string, handler: GetQualitiesHandler): () => void {
            // The contract is synchronous (the download modal reads it during
            // render), but a worker-runtime plugin's handler can only answer
            // asynchronously. So the host keeps the last answer: each call
            // returns the freshest value it has — the current one for a
            // main-realm plugin, the previous one for a worker — and refreshes
            // the cache. Called once right here so the first read already has it.
            let cached: DownloadQualityOption[] | null = null;
            const read = (): DownloadQualityOption[] => {
              const r = handler() as DownloadQualityOption[] | PromiseLike<DownloadQualityOption[]>;
              if (r && typeof (r as PromiseLike<unknown>).then === "function") {
                (r as PromiseLike<DownloadQualityOption[]>).then(
                  (v) => { cached = Array.isArray(v) ? v : null; },
                  (e) => console.error(`[plugin:${pluginId}] getQualities(${providerId}) failed:`, e),
                );
                return cached ?? [];
              }
              cached = r as DownloadQualityOption[];
              return cached;
            };
            // The prime must not turn a handler that isn't ready yet (reads state
            // activate() sets later) into an activation failure.
            try {
              read();
            } catch (e) {
              console.error(`[plugin:${pluginId}] getQualities(${providerId}) failed at registration:`, e);
            }
            return trackUnsubscribe(registerKeyed(loaded.getQualitiesHandlers, providerId, read));
          },
          onPreview(providerId: string, handler: DownloadPreviewHandler): () => void {
            return trackUnsubscribe(registerKeyed(loaded.downloadPreviewHandlers, providerId, handler));
          },
        },

        scheduler: {
          async register(taskId: string, intervalMs: number): Promise<void> {
            await invoke("plugin_scheduler_register", { pluginId, taskId, intervalMs });
          },
          async unregister(taskId: string): Promise<void> {
            await invoke("plugin_scheduler_unregister", { pluginId, taskId });
          },
          async complete(taskId: string): Promise<boolean> {
            return await invoke<boolean>("plugin_scheduler_complete", { pluginId, taskId });
          },
          onDue(taskId: string, handler: () => void): () => void {
            loaded.schedulerHandlers.set(taskId, handler);
            return () => { loaded.schedulerHandlers.delete(taskId); };
          },
        },

        system: {
          async exec(
            program: string,
            args?: string[],
            opts?: { cwd?: string; onOutput?: ExecOutputHandler; onStart?: (handle: PluginExecHandle) => void },
          ) {
            const logFailedExec = (result: ExecResult): ExecResult => {
              if (result.exitCode !== 0) {
                const detail = result.stderr.trim() || result.stdout.trim() || "no output";
                console.error(`[plugin:${pluginId}] ${program} exited with code ${result.exitCode}:`, detail);
              }
              return result;
            };
            const scopes = resolveScopesRef.current.get(pluginId);
            const scope = scopes && scopes.length ? scopes[scopes.length - 1] : undefined;
            const onOutput = opts?.onOutput;
            const onStart = opts?.onStart;
            // A cancel kills only the execs running at that moment. A resolve
            // that chains several (rqbit's hunt: search, list a torrent, then
            // download) can be between two when the user cancels, and the next
            // one would then run to completion with nobody watching — so a
            // cancelled scope refuses new execs with the same rejection a kill
            // produces.
            if (scope?.cancelled) throw new Error("Cancelled");
            // An exec id buys cancellability and line streaming, at the cost of
            // piping both channels through the host. Only take it when someone
            // can use it — a plain version probe keeps the original path.
            if (!scope && !onOutput && !onStart) {
              return invoke<ExecResult>("plugin_exec", {
                program, args: args ?? [], cwd: opts?.cwd ?? null,
              }).then(logFailedExec);
            }
            const execId = `${pluginId}:${++execSeqRef.current}`;
            scope?.execIds.add(execId);
            if (onOutput) execOutputHandlersRef.current.set(execId, onOutput);
            // A plugin-owned long run (a torrent download started from the
            // plugin's own view) has no resolve scope and so no host Cancel
            // button; the handle is its way to stop the process itself. Handed
            // over before the invoke so a cancel that lands before the spawn is
            // still honoured — the backend registry records it against the id.
            if (onStart) {
              onStart({
                cancel: () =>
                  invoke<boolean>("plugin_exec_cancel", { execId })
                    .catch((e) => { console.error(`[plugin:${pluginId}] failed to cancel ${program}:`, e); return false; }),
              });
            }
            try {
              const result = await invoke<ExecResult>("plugin_exec", {
                program,
                args: args ?? [],
                cwd: opts?.cwd ?? null,
                execId,
                streamOutput: !!onOutput,
              });
              return logFailedExec(result);
            } finally {
              execOutputHandlersRef.current.delete(execId);
              scope?.execIds.delete(execId);
            }
          },
          async getDependency(name: string) {
            // Cache-only: forceRefresh: false means the host serves its cached
            // status (installed/origin) and cached latest version — it never
            // hits GitHub here. The host owns *when* the latest cache refreshes
            // (background thread ~30s after startup + daily, or Settings). So
            // `latest` may be null until that runs; plugins must never check
            // releases themselves. See the "host owns dependency checks" rule.
            const list = await invoke<Array<{
              name: string;
              status: "installed" | "notFound" | "error";
              version?: string;
              origin?: "managed" | "system";
              latestVersion?: string | null;
            }>>("check_dependencies", { names: [name], pluginDeps: null, forceRefresh: false });
            const d = list[0];
            if (!d) return null;
            return {
              name: d.name,
              installed: d.status === "installed",
              version: d.version ?? null,
              origin: d.origin ?? null,
              latest: d.latestVersion ?? null,
            };
          },
          async readAudioTags(paths: string[]) {
            // One invoke for the whole batch: a plugin queueing a finished
            // release calls this once per user action, not once per file.
            if (!paths.length) return [];
            return invoke<Array<PluginFileTags | null>>("read_file_tags", { paths });
          },
          // Both go through Rust commands rather than the frontend's `openUrl`:
          // the opener plugin's JS scope permits only http/https/mailto/tel, so a
          // `file://` URL from JS is refused outright — which is why a plugin's
          // "Open" button silently did nothing.
          async openPath(path: string) {
            await invoke("open_path_with_default_app", { filePath: path });
          },
          async revealPath(path: string) {
            await invoke("show_in_folder_path", { filePath: path });
          },
          async platform() {
            return invoke<{ os: string; arch: string }>("plugin_platform");
          },
          // A sensible default for a folder setting (a downloads folder) without
          // making the user pick one first. Each is null where the OS has none.
          async userFolders() {
            const read = async (get: () => Promise<string>, name: string) => {
              try {
                return await get();
              } catch (e) {
                console.error(`Couldn't read the ${name} folder:`, e);
                return null;
              }
            };
            const [home, downloads, music] = await Promise.all([
              read(homeDir, "home"),
              read(downloadDir, "downloads"),
              read(audioDir, "music"),
            ]);
            return { home, downloads, music };
          },
          // Programs run outside the worker sandbox, so they are a worker-only
          // surface: the permission gate (programs:run, network for downloads)
          // and the activation-time consent — including the unsigned-plugin
          // warning — are what make them safe to offer. A main-realm plugin has
          // neither, so it is refused here rather than let in silently.
          programs: (() => {
            const workerOnly = () => {
              if (loaded.manifest.runtime !== "worker") {
                throw new Error("api.system.programs is available to worker-runtime plugins only");
              }
            };
            return {
              async download(
                path: string[],
                url: string,
                opts?: { sha256?: string; headers?: Record<string, string>; maxBytes?: number; label?: string; onProgress?: (received: number, total: number | null) => void },
              ) {
                workerOnly();
                const allowed = await confirmProgramInstall({
                  pluginId,
                  pluginName: loaded.manifest.name,
                  url,
                  ...describeProgramDownload(url, opts),
                });
                if (!allowed) throw new Error(PROGRAM_INSTALL_DECLINED);
                const onProgress = opts?.onProgress;
                const downloadId = onProgress ? `${pluginId}:${++programDownloadSeqRef.current}` : null;
                if (downloadId && onProgress) programDownloadHandlersRef.current.set(downloadId, onProgress);
                try {
                  return await invoke<{ path: string; sha256: string; size: number }>("plugin_program_download", {
                    pluginId, path, url,
                    sha256: opts?.sha256 ?? null,
                    headers: opts?.headers ?? null,
                    allowedHosts: allowedHosts(),
                    maxBytes: opts?.maxBytes ?? null,
                    downloadId,
                  });
                } finally {
                  if (downloadId) programDownloadHandlersRef.current.delete(downloadId);
                }
              },
              async extract(archive: string[], dest: string[]) {
                workerOnly();
                return invoke<number>("plugin_program_extract", { pluginId, archive, dest });
              },
              async run(path: string[], args?: string[], opts?: { env?: Record<string, string>; cwd?: string[]; timeoutSecs?: number }) {
                workerOnly();
                const result = await invoke<ExecResult>("plugin_program_run", {
                  pluginId, path, args: args ?? [],
                  env: opts?.env ?? null, cwd: opts?.cwd ?? null, timeoutSecs: opts?.timeoutSecs ?? null,
                });
                if (result.exitCode !== 0) {
                  console.error(`[plugin:${pluginId}] ${path.join("/")} exited with code ${result.exitCode}:`, result.stderr.trim() || result.stdout.trim() || "no output");
                }
                return result;
              },
              async start(name: string, spec: PluginProgramSpec) {
                workerOnly();
                const send = () => invoke<PluginProgramStatus>("plugin_program_start", {
                  pluginId, name,
                  spec: {
                    path: spec.path ?? null,
                    dependency: spec.dependency ?? null,
                    args: spec.args ?? [],
                    env: spec.env ?? {},
                    cwd: spec.cwd ?? null,
                    outliveApp: spec.outliveApp ?? true,
                  },
                });
                let refusal: unknown;
                try {
                  return await send();
                } catch (e) {
                  refusal = e;
                }
                // Running Vibo's copy of a tool in the background needs the
                // user's yes once per source; Rust refuses until it has one.
                const dep = spec.dependency;
                if (!dep || !String(refusal).startsWith(DEPENDENCY_RUN_UNCONFIRMED)) throw refusal;
                const allowed = await confirmDependencyRun(pluginId, loaded.manifest.name, dep);
                if (!allowed) throw new Error(DEPENDENCY_RUN_DECLINED);
                await invoke("plugin_program_confirm_dependency", { pluginId, dependency: dep });
                return send();
              },
              onAppQuitting(handler: () => void | Promise<void>) {
                appQuittingHandlersRef.current.set(pluginId, handler);
                return () => {
                  if (appQuittingHandlersRef.current.get(pluginId) === handler) {
                    appQuittingHandlersRef.current.delete(pluginId);
                  }
                };
              },
              async status(name: string) {
                workerOnly();
                return invoke<PluginProgramStatus>("plugin_program_status", { pluginId, name });
              },
              async list() {
                workerOnly();
                return invoke<PluginProgramStatus[]>("plugin_program_list", { pluginId });
              },
              async stop(name: string, opts?: { graceSecs?: number }) {
                workerOnly();
                return invoke<PluginProgramStatus>("plugin_program_stop", { pluginId, name, graceSecs: opts?.graceSecs ?? null });
              },
              async remove(name: string) {
                workerOnly();
                await invoke("plugin_program_remove", { pluginId, name });
              },
            };
          })(),
        },

        env: {
          async get(key: string): Promise<string | null> {
            return invoke<string | null>("plugin_getenv", { key });
          },
        },
      };
    },
    [currentTrackRef, playingRef, positionRef, queueRef, tapInvoke, syncScrobblerPluginIds, confirmProgramInstall, confirmDependencyRun, optionalGranted],
  );

  // Line-by-line output from a streaming `plugin_exec`, routed to the plugin
  // call that asked for it. Only execs started with an `onOutput` are streamed,
  // so an unmatched id here is a run whose caller already returned.
  useEffect(() => {
    return subscribe<{ execId: string; stream: "stdout" | "stderr"; line: string }>(
      "plugin-exec-output",
      (event) => {
        const handler = execOutputHandlersRef.current.get(event.payload.execId);
        if (!handler) return;
        try { handler(event.payload.line, event.payload.stream); }
        catch (e) { console.error("Plugin exec output handler error:", e); }
      },
    );
  }, []);

  // `api.system.programs.download` progress, routed to the call that passed
  // `onProgress`. An unmatched id is a download whose caller already returned.
  useEffect(() => {
    return subscribe<{ downloadId: string; received: number; total: number | null }>(
      "plugin-program-download-progress",
      (event) => {
        const handler = programDownloadHandlersRef.current.get(event.payload.downloadId);
        if (!handler) return;
        try { handler(event.payload.received, event.payload.total ?? null); }
        catch (e) { console.error("Plugin program download progress handler error:", e); }
      },
    );
  }, []);

  // Listen for scheduler due events from the Rust backend
  useEffect(() => {
    return subscribe<{ pluginId: string; taskId: string }>(
      "plugin-scheduler-due",
      (event) => {
        const { pluginId, taskId } = event.payload;
        const loaded = loadedPluginsRef.current.get(pluginId);
        if (!loaded) return;
        const handler = loaded.schedulerHandlers.get(taskId);
        if (handler) {
          try { handler(); } catch (e) { console.error(`Scheduler handler error [${pluginId}:${taskId}]:`, e); }
        }
      }
    );
  }, []);

  // Deactivate and clean up a single plugin
  const deactivatePlugin = useCallback((pluginId: string) => {
    const loaded = loadedPluginsRef.current.get(pluginId);
    if (!loaded) return;

    // Call deactivate
    try {
      loaded.deactivate?.();
    } catch (e) {
      console.error(`[plugin:${pluginId}] deactivate error:`, e);
    }

    // Clean up all subscriptions
    for (const unsub of loaded.unsubscribers) {
      try {
        unsub();
      } catch (e) {
        console.error(`Failed to unsubscribe plugin handler:`, e);
      }
    }

    // Clear handlers
    loaded.contextMenuHandlers.clear();
    loaded.uiActionHandlers.clear();
    loaded.infoFetchHandlers.clear();
    loaded.imageFetchHandlers.clear();
    loaded.downloadResolveByUriHandlers.clear();
    loaded.downloadResolveByMetadataHandlers.clear();
    loaded.interactiveSearchHandlers.clear();
    loaded.interactiveResolveHandlers.clear();
    loaded.streamResolveHandlers.clear();
    loaded.streamUriResolvers.clear();
    loaded.storyboardResolvers.clear();
    loaded.waveformLookupHandler = null;
    loaded.waveformShareHandler = null;
    loaded.autoContinueHandler = null;
    loaded.schedulerHandlers.clear();
    loaded.visualizerFactories.clear();

    // Its seek-bar ticks go with it: nothing else would clear them before the
    // track changes.
    hostCallbacksRef?.current?.clearSeekMarkers?.(pluginId);

    // Everything this plugin registered under `${pluginId}:…` keys. Most of
    // it already went with the unsubscribers above; this sweep catches what was
    // set without one (view data, headers, badges) or whose unsubscriber threw.
    deletePluginKeys(viewDataRef.current, pluginId);
    setViewData(new Map(viewDataRef.current));
    deletePluginKeys(viewHeadersRef.current, pluginId);
    setViewHeaders(new Map(viewHeadersRef.current));
    deletePluginKeys(badgeMapRef.current, pluginId);
    setBadgeMap(new Map(badgeMapRef.current));

    for (const handlers of [
      homeShelfHandlersRef.current,
      homeShelfClickHandlersRef.current,
      homeShelfResolvePlayHandlersRef.current,
      nowPlayingInfoHandlersRef.current,
      searchHandlersRef.current,
      webSearchHandlersRef.current,
      assistantToolHandlersRef.current,
    ] as Map<string, unknown>[]) {
      deletePluginKeys(handlers, pluginId);
    }

    if (deletePluginKeys(dynamicHomeShelvesRef.current, pluginId)) setDynamicShelvesVersion((v) => v + 1);
    if (deletePluginKeys(dynamicMenuItemsRef.current, pluginId)) setDynamicMenuItemsVersion((v) => v + 1);
    if (deletePluginKeys(nowPlayingInfoItemsRef.current, pluginId)) setNowPlayingInfoVersion((v) => v + 1);
    if (deletePluginKeys(dynamicSearchProvidersRef.current, pluginId)) setDynamicSearchProvidersVersion((v) => v + 1);
    if (deletePluginKeys(dynamicVisualizersRef.current, pluginId)) setDynamicVisualizersVersion((v) => v + 1);
    if (deletePluginKeys(dynamicWebSearchProvidersRef.current, pluginId)) publishDynamicWebSearchProviders();
    const toolsRemoved = deletePluginKeys(dynamicAssistantToolsRef.current, pluginId);
    if (runtimeAssistantInstructionsRef.current.delete(pluginId) || toolsRemoved) {
      setAssistantVersion((v) => v + 1);
    }
    appQuittingHandlersRef.current.delete(pluginId);

    loadedPluginsRef.current.delete(pluginId);
  }, []);

  // Load and activate a single plugin
  const activatePlugin = useCallback(
    async (installed: InstalledPlugin): Promise<{ state: PluginState; timing: PluginActivationTiming }> => {
      const { id, manifest, builtin, dev, devPath } = installed;
      // Phase timers: codeMs = reading index.js (IPC, 0 when bundled),
      // compileMs = new Function + factory call, activateMs = the plugin's own
      // activate() body (its storage/network/registration work). Together they
      // explain where a slow plugin spends its activation budget.
      const t0 = performance.now();
      const bundled = installed.code != null;
      let codeMs = 0;
      let compileMs = 0;
      let activateMs = 0;
      let ipcMs = 0;
      let ipcCount = 0;

      const loaded: LoadedPlugin = {
        id,
        manifest,
        unsubscribers: [],
        contextMenuHandlers: new Map(),
        uiActionHandlers: new Map(),
        deepLinkHandlers: [],
        infoFetchHandlers: new Map(),
        imageFetchHandlers: new Map(),
        downloadResolveByUriHandlers: new Map(),
        downloadResolveByMetadataHandlers: new Map(),
        interactiveSearchHandlers: new Map(),
        interactiveResolveHandlers: new Map(),
        getQualitiesHandlers: new Map(),
        downloadPreviewHandlers: new Map(),
        streamResolveHandlers: new Map(),
        streamUriResolvers: new Map(),
        storyboardResolvers: new Map(),
        waveformLookupHandler: null,
        waveformShareHandler: null,
        autoContinueHandler: null,
        schedulerHandlers: new Map(),
        visualizerFactories: new Map(),
      };

      let workerControl: WorkerPluginControl | null = null;
      try {
        // Prefer code bundled with the manifest listing (saves an IPC round-trip).
        const tCode = performance.now();
        const code =
          installed.code ??
          (await invoke<string>("plugin_read_file", {
            pluginId: id,
            path: "index.js",
          }));
        codeMs = performance.now() - tCode;

        const api = buildAPI(id, loaded);
        let pluginExports: { activate?: (api: ViboplrPluginAPI) => unknown; deactivate?: () => void } | undefined;
        if (manifest.runtime === "worker") {
          // Worker runtime: the same `api` object, but reached only through the
          // permission-gated bridge. compileMs = worker boot + source evaluation.
          const tCompile = performance.now();
          const control = await startWorkerPlugin({
            pluginId: id,
            code,
            permissions: manifest.permissions ?? [],
            optional: {
              declared: manifest.optionalPermissions ?? [],
              granted: () => optionalGranted(id, manifest.optionalPermissions ?? []),
              request: () => requestOptionalPermissions(id, manifest.optionalPermissions ?? []),
            },
            api: api as unknown as Record<string, unknown>,
            onDenied: (e) => recordPluginLog("error", e.message, id),
            onWorkerLog: (level, message) => {
              recordPluginLog(level, message, id);
              console.error(`[plugin:${id}]`, message);
            },
            bench: debugMode,
          });
          workerControl = control;
          compileMs = performance.now() - tCompile;
          pluginExports = {
            activate: () => control.activate(),
            deactivate: () => { void control.deactivate(); },
          };
        } else {
        const pluginSandbox = Object.create(null);
        pluginSandbox.setTimeout = window.setTimeout.bind(window);
        pluginSandbox.clearTimeout = window.clearTimeout.bind(window);
        pluginSandbox.setInterval = window.setInterval.bind(window);
        pluginSandbox.clearInterval = window.clearInterval.bind(window);
        // This IS the plugin sandbox's `console`: a plugin calling console.log
        // must reach the real one. Not a stray trace of ours (conventions.md >
        // Error Logging). The directive must sit on the line directly above the
        // code — `eslint-disable-next-line` covers exactly the next line, so a
        // comment continuing beneath it swallows the exemption.
        // eslint-disable-next-line no-console
        pluginSandbox.console = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
        pluginSandbox.Math = Math;
        pluginSandbox.JSON = JSON;
        pluginSandbox.Date = Date;
        pluginSandbox.Promise = Promise;
        pluginSandbox.Object = Object;
        pluginSandbox.Array = Array;
        pluginSandbox.String = String;
        pluginSandbox.Number = Number;
        pluginSandbox.RegExp = RegExp;
        pluginSandbox.Error = Error;
        pluginSandbox.encodeURIComponent = encodeURIComponent;
        pluginSandbox.decodeURIComponent = decodeURIComponent;
        pluginSandbox.parseInt = parseInt;
        pluginSandbox.parseFloat = parseFloat;
        pluginSandbox.isNaN = isNaN;
        pluginSandbox.isFinite = isFinite;
        Object.freeze(pluginSandbox);

        const tCompile = performance.now();
        const factory = new Function("api", "window", "globalThis", "self", "document", code);
        pluginExports = factory(api, pluginSandbox, pluginSandbox, pluginSandbox, undefined);
        compileMs = performance.now() - tCompile;
        }

        const tActivate = performance.now();
        // Attribute IPC made during activate() to this plugin (debug only).
        const tap = debugMode ? { ms: 0, count: 0 } : null;
        if (tap) ipcTapRef.current = tap;
        // Race activate() against a timeout so a slow/hung activate() (e.g. one
        // that awaits network) can't freeze the sequential load. On timeout we
        // proceed; the plugin keeps initializing in the background and its
        // handlers register whenever they finish (loaded is registered below,
        // so late registrations are live).
        let timedOut = false;
        const activatePromise = Promise.resolve(
          pluginExports && typeof pluginExports.activate === "function"
            ? pluginExports.activate(api)
            : undefined,
        );
        // A rejection AFTER we've moved on would otherwise be unhandled; a
        // rejection BEFORE the timeout still surfaces via the race → outer catch.
        activatePromise.catch((err) => {
          if (timedOut) {
            console.warn(`[plugin:${id}] activate() failed after timeout:`, err instanceof Error ? err.message : String(err));
          }
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            activatePromise,
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                timedOut = true;
                resolve();
              }, ACTIVATE_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          if (tap) {
            ipcTapRef.current = null;
            ipcMs = tap.ms;
            ipcCount = tap.count;
          }
        }
        if (timedOut) {
          console.warn(`[plugin:${id}] activate() exceeded ${ACTIVATE_TIMEOUT_MS}ms; continuing in background`);
        }
        activateMs = performance.now() - tActivate;
        if (pluginExports && typeof pluginExports.deactivate === "function") {
          loaded.deactivate = pluginExports.deactivate;
        }

        loadedPluginsRef.current.set(id, loaded);

        return {
          state: { id, manifest, status: "active", enabled: true, builtin, dev, devPath },
          timing: { plugin: id, totalMs: performance.now() - t0, codeMs, compileMs, activateMs, ipcMs, ipcCount, bundled },
        };
      } catch (e) {
        // A worker that started but whose activate() threw must not keep running.
        workerControl?.terminate();
        const error = e instanceof Error ? e.message : String(e);
        console.error(`[plugin:${id}] activation error:`, error);
        return {
          state: { id, manifest, status: "error", error, enabled: true, builtin, dev, devPath },
          timing: { plugin: id, totalMs: performance.now() - t0, codeMs, compileMs, activateMs, ipcMs, ipcCount, bundled },
        };
      }
    },
    [buildAPI, debugMode, optionalGranted, requestOptionalPermissions],
  );

  // Load all plugins
  const loadPlugins = useCallback(async () => {
    try {
      // Deactivate all previously loaded plugins to prevent handler accumulation
      for (const id of loadedPluginsRef.current.keys()) {
        deactivatePlugin(id);
      }

      // Read the enabled set first so we can tell the backend which plugins'
      // index.js it actually needs to read. Disabled plugins never activate, so
      // slurping their source up front is pure startup cost. `null` (first
      // launch) means "read all" — the auto-enable path below needs every
      // builtin's code without a second IPC round-trip.
      let storedEnabled =
        (await store.get<string[]>("enabledPlugins")) ?? null;
      // The permissions the user approved for each worker-runtime plugin. A
      // worker plugin whose manifest asks for anything not in here does not
      // activate — see the approval gate below.
      permissionGrantsRef.current =
        (await store.get<Record<string, string[]>>(PERMISSION_GRANTS_KEY)) ?? {};
      programConsentRef.current =
        (await store.get<Record<string, ProgramConsent>>(PROGRAM_CONSENT_KEY)) ?? {};
      // The retired plugins (utils/retiredPlugins.ts) are forgotten: the
      // backend deleted their folders, this drops their switches and grants.
      // Nothing to drop is the common case, and then nothing is written.
      const keptEnabled = withoutRetiredIds(storedEnabled);
      if (keptEnabled) {
        storedEnabled = keptEnabled;
        await store.set("enabledPlugins", keptEnabled);
      }
      const keptGrants = withoutRetiredKeys(permissionGrantsRef.current);
      if (keptGrants) {
        permissionGrantsRef.current = keptGrants;
        await store.set(PERMISSION_GRANTS_KEY, keptGrants);
      }
      const keptConsent = withoutRetiredKeys(programConsentRef.current);
      if (keptConsent) {
        programConsentRef.current = keptConsent;
        await store.set(PROGRAM_CONSENT_KEY, keptConsent);
      }
      // The bundled image and lyrics plugins were merged into Artwork and
      // Lyrics (utils/mergedPlugins.ts). Applied in memory here — the list
      // decides which plugins' code gets read — and persisted only after the
      // per-source switches it implies are written (after the provider sync
      // below), so a run cut short simply runs again.
      const mergeMigration =
        storedEnabled !== null && !(await store.get<boolean>(MERGED_PLUGINS_DONE_KEY))
          ? migrateMergedPlugins(storedEnabled)
          : null;
      if (storedEnabled === null) await store.set(MERGED_PLUGINS_DONE_KEY, true);
      // search-providers is now an external gallery plugin (no longer bundled),
      // so there's no built-in copy to auto-enable here — users install it from
      // the gallery like any other plugin.
      const enabled = mergeMigration ? mergeMigration.enabled : storedEnabled;
      const enabledSet =
        enabled !== null
          ? new Set(enabled)
          : new Set<string>();

      const installed = await invoke<InstalledPlugin[]>("plugin_list_installed", {
        devPluginDir: debugMode ? (devPluginPath || null) : null,
        enabledIds: enabled,
      });
      const appVersion = await getVersion().catch(() => "0.0.0");
      appVersionRef.current = appVersion;

      // Auto-enable all built-in plugins on first launch only
      // (when no enabledPlugins key exists in the store yet).
      // Plugins with autoEnable: false in their manifest are skipped, as are
      // experimental-tier plugins — experimental is opt-in by definition.
      // Once the user has a saved list, respect their choices.
      if (enabled === null) {
        for (const plugin of installed) {
          if (
            plugin.builtin &&
            plugin.manifest.autoEnable !== false &&
            !isExperimental(plugin.manifest.stability)
          ) {
            enabledSet.add(plugin.id);
          }
        }
        await store.set("enabledPlugins", Array.from(enabledSet));
      }

      enabledPluginsRef.current = enabledSet;

      const states: PluginState[] = [];
      const sidebar: PluginSidebarItem[] = [];
      const menus: PluginMenuItem[] = [];
      const settings: PluginSettingsPanel[] = [];
      const shelves: Array<{
        pluginId: string;
        shelfId: string;
        title: string;
        displayKind: HomeShelfDisplayKind;
        limit: number;
        icon?: string;
      }> = [];
      const searchers: PluginSearchProvider[] = [];
      const webSearchers: PluginWebSearchProvider[] = [];
      const vizzes: PluginVisualizerRegistration[] = [];
      const assistTools: PluginAssistantTool[] = [];
      const assistInstructions: Array<[string, string]> = [];
      const allInfoTypes: Array<[string, string, string, string, string, number, number, number, string]> = [];
      const allImageProviders: [string, string, number][] = []; // [plugin_id, entity, priority]

      // First pass: classify plugins synchronously and collect the ones that
      // need to actually activate. Plugins whose status is decided by manifest
      // alone (error/disabled/incompatible) get their state pushed eagerly.
      const toActivate: InstalledPlugin[] = [];
      /** Main-realm plugins running without a Vibo signature (see pluginTrust.ts). */
      const unverifiedIds = new Set<string>();
      /** Worker plugins signed by the trusted first-party key: pre-approved like built-ins. */
      const firstPartyIds = new Set<string>();
      for (const plugin of installed) {
        const m = plugin.manifest;
        if (m.runtime === "worker" && isFirstParty(plugin)) firstPartyIds.add(plugin.id);

        if (!m.name || !m.version) {
          states.push({
            id: plugin.id,
            manifest: m,
            status: "error",
            error: "Invalid manifest: missing name or version",
            enabled: false,
            builtin: plugin.builtin,
            dev: plugin.dev,
            devPath: plugin.devPath,
          });
          continue;
        }

        // Before the enabled check: a debug-only plugin is hidden whenever
        // debug mode is off, switched on or not. Checked after it, a disabled
        // one was still listed (as "disabled") in a normal session.
        if (m.debugOnly && !debugMode) {
          continue;
        }

        if (!enabledSet.has(plugin.id)) {
          states.push({
            id: plugin.id,
            manifest: m,
            status: "disabled",
            enabled: false,
            builtin: plugin.builtin,
            dev: plugin.dev,
            devPath: plugin.devPath,
          });
          continue;
        }

        if (m.minAppVersion && !semverSatisfies(appVersion, m.minAppVersion)) {
          states.push({
            id: plugin.id,
            manifest: m,
            status: "incompatible",
            error: `Requires app version ${m.minAppVersion} (current: ${appVersion})`,
            enabled: true,
            builtin: plugin.builtin,
            dev: plugin.dev,
            devPath: plugin.devPath,
          });
          continue;
        }

        // Worker-runtime plugins run only with every requested permission
        // approved. Checking here, at activation, is what covers every way a
        // plugin arrives — gallery install, zip/URL install, the dev folder,
        // and an update whose new version asks for more than the last one.
        // Built-ins are the exception: they ship inside the app and carry its
        // trust, and asking would stop lyrics, artwork and bios on every fresh
        // install until the user clicked through each one. Their permissions
        // are still enforced — that part protects against their bugs, not the
        // user's consent. A user or dev copy overriding a built-in's id is not
        // built-in, so it is asked.
        // A visualizer is handed a live ShadowRoot, which a worker has no DOM
        // for — its worker model is still undecided. Starting such a plugin
        // anyway made it report "active" while its visualizer could never
        // mount, so say so instead.
        if (m.runtime === "worker" && (m.contributes?.visualizers?.length ?? 0) > 0) {
          states.push({
            id: plugin.id,
            manifest: m,
            status: "error",
            error: "Visualizers can't run in the worker runtime yet. Remove \"runtime\": \"worker\" from this plugin's manifest to use it.",
            enabled: true,
            builtin: plugin.builtin,
            dev: plugin.dev,
            devPath: plugin.devPath,
          });
          continue;
        }

        // Main-realm plugins get full app access, so they must be signed by
        // Vibo (utils/pluginTrust.ts): an unsigned or broken one is refused
        // (an unsigned dev folder still runs in debug mode, labelled).
        const trust = mainRealmVerdict(
          { runtime: m.runtime, builtin: plugin.builtin, dev: plugin.dev, signature: plugin.signature, signatureError: plugin.signatureError },
          { debugMode: debugMode === true },
        );
        if (!trust.allow) {
          states.push({
            id: plugin.id,
            manifest: m,
            status: "error",
            error: trust.reason,
            enabled: true,
            builtin: plugin.builtin,
            dev: plugin.dev,
            devPath: plugin.devPath,
          });
          continue;
        }
        if (trust.unverified) unverifiedIds.add(plugin.id);

        if (m.runtime === "worker") {
          // A first-party plugin's ordinary permissions are pre-approved; the
          // always-ask ones (programs:run) still wait for the user.
          const pending = permissionsAwaitingConsent({
            requested: m.permissions ?? [],
            approved: permissionGrantsRef.current[plugin.id] ?? [],
            trusted: firstPartyIds.has(plugin.id),
            consent: programConsentRef.current[plugin.id],
          });
          if (pending.length > 0) {
            states.push({
              id: plugin.id,
              manifest: m,
              status: "needs-approval",
              enabled: true,
              pendingPermissions: pending,
              builtin: plugin.builtin,
              dev: plugin.dev,
              devPath: plugin.devPath,
            });
            continue;
          }
        }

        toActivate.push(plugin);
      }

      // Activate sequentially. Parallel activation was tried but caused IPC
      // saturation: every plugin's activate() typically issues its own invokes
      // (plugin_storage_get, plugin_fetch, info_get_value, etc.), and Tauri's
      // single IPC channel serializes them anyway. Running concurrently just
      // queued them all behind the rest of the startup path's invokes, slowing
      // store.restore / main_playlist.read by ~1s in measured runs.
      // The win from F4 here is the bundled `code` field in plugin_list_installed,
      // which removes one IPC per plugin even on the sequential path.
      const timings: PluginActivationTiming[] = [];
      const loopStart = performance.now();
      // Boot every worker-runtime plugin's worker up front so their startup
      // overlaps; each activation below then claims its own already-warm one.
      prewarmPluginWorkers(toActivate.filter((p) => p.manifest.runtime === "worker").map((p) => p.id));
      for (const plugin of toActivate) {
        const { state, timing } = await activatePlugin(plugin);
        states.push(unverifiedIds.has(plugin.id) ? { ...state, unverified: true } : state);
        timings.push(timing);

        if (state.status === "active" && plugin.manifest.contributes) {
          const contrib = plugin.manifest.contributes;
          if (contrib.sidebarItems) {
            for (const item of contrib.sidebarItems) {
              sidebar.push({
                pluginId: plugin.id,
                id: item.id,
                label: item.label,
                icon: item.icon,
              });
            }
          }
          if (contrib.contextMenuItems) {
            for (const item of contrib.contextMenuItems) {
              menus.push({
                pluginId: plugin.id,
                id: item.id,
                label: item.label,
                targets: item.targets,
              });
            }
          }
          if (contrib.informationTypes) {
            for (const it of contrib.informationTypes) {
              const key = providerKey(plugin.id, it.provider);
              const order = DEFAULT_INFO_TYPE_ORDER[it.id] ?? 500;
              const priority = DEFAULT_INFO_TYPE_PRIORITY[it.id]?.[key] ?? 500;
              allInfoTypes.push([it.id, it.name, it.entity, it.displayKind, key, it.ttl, order, priority, it.description ?? ""]);
            }
          }
          if (contrib.imageProviders) {
            for (const ip of contrib.imageProviders) {
              const key = providerKey(plugin.id, ip.provider);
              const imgPriority = DEFAULT_IMAGE_PROVIDER_PRIORITY[`${key}:${ip.entity}`] ?? 999;
              allImageProviders.push([key, ip.entity, imgPriority]);
            }
          }
          if (contrib.settingsPanel) {
            const sp = contrib.settingsPanel;
            settings.push({
              pluginId: plugin.id,
              id: sp.id,
              label: sp.label,
              icon: sp.icon,
              order: sp.order ?? 100,
            });
          }
          if (contrib.homeShelves) {
            for (const hs of contrib.homeShelves) {
              shelves.push({
                pluginId: plugin.id,
                shelfId: hs.id,
                title: hs.title,
                displayKind: hs.displayKind,
                limit: hs.limit ?? 20,
                icon: hs.icon,
              });
            }
          }
          if (contrib.searchProviders) {
            for (const sp of contrib.searchProviders) {
              searchers.push({
                pluginId: plugin.id,
                providerId: sp.id,
                name: sp.name,
                icon: sp.icon,
              });
            }
          }
          for (const wp of contrib.webSearchProviders ?? []) {
            if (typeof wp?.id !== "string" || typeof wp.name !== "string") continue;
            webSearchers.push({ pluginId: plugin.id, providerId: wp.id, name: wp.name, icon: wp.icon });
          }
          if (contrib.visualizers) {
            for (const vz of contrib.visualizers) {
              vizzes.push({ pluginId: plugin.id, ...vz });
            }
          }
          if (contrib.assistant) {
            for (const tool of contrib.assistant.tools ?? []) {
              assistTools.push({
                pluginId: plugin.id,
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                readOnly: tool.readOnly === true,
              });
            }
            if (contrib.assistant.instructions) {
              assistInstructions.push([plugin.id, contrib.assistant.instructions]);
            }
          }
        }
      }
      // Every worker plugin has claimed its worker by now; any left over belong
      // to activations that failed before reaching startWorkerPlugin.
      dropPrewarmedWorkers();

      if (debugMode && timings.length > 0) {
        const wallMs = performance.now() - loopStart;
        const sumMs = timings.reduce((s, t) => s + t.totalMs, 0);
        const r1 = (n: number) => (Math.round(n * 10) / 10).toString();
        // Plain-text aligned table: Safari's Web Inspector renders console.table
        // poorly (and it isn't copy-pasteable), so format it ourselves.
        const cols: Array<{ h: string; w: number; v: (t: PluginActivationTiming) => string }> = [
          { h: "plugin", w: 22, v: (t) => t.plugin },
          { h: "total", w: 8, v: (t) => r1(t.totalMs) },
          { h: "code", w: 7, v: (t) => r1(t.codeMs) },
          { h: "compile", w: 8, v: (t) => r1(t.compileMs) },
          { h: "activate", w: 9, v: (t) => r1(t.activateMs) },
          { h: "ipcMs", w: 8, v: (t) => r1(t.ipcMs) },
          { h: "ipc#", w: 5, v: (t) => t.ipcCount.toString() },
          { h: "syncMs", w: 8, v: (t) => r1(Math.max(0, t.activateMs - t.ipcMs)) },
          { h: "bundled", w: 7, v: (t) => (t.bundled ? "yes" : "no") },
        ];
        const pad = (s: string, w: number, left = false) => (left ? s.padEnd(w) : s.padStart(w));
        const header = cols.map((c, i) => pad(c.h, c.w, i === 0)).join("  ");
        const lines = [...timings]
          .sort((a, b) => b.totalMs - a.totalMs)
          .map((t) => cols.map((c, i) => pad(c.v(t), c.w, i === 0)).join("  "));
        const table =
          `[plugin-timing] activated ${timings.length} plugins sequentially in ${r1(wallMs)}ms (sum of activations ${r1(sumMs)}ms)\n` +
          [header, ...lines].join("\n");
        console.debug(table);
        // Debug-only copy into the backend log so the table is readable from a
        // `tauri dev` terminal.
        invoke("write_frontend_log", { level: "info", message: table, section: "plugin-timing" }).catch(() => {}); // eslint-disable-line no-restricted-syntax -- Fire-and-forget: a lost debug timing line has no user impact
      }

      if (allInfoTypes.length > 0) {
        await invoke("info_sync_types", { types: allInfoTypes });

        // Track plugin info versions (no longer invalidates cache)
        const savedVersions = (await store.get<Record<string, string>>("pluginInfoVersions")) ?? {};
        const keptVersions = withoutRetiredKeys(savedVersions);
        const storedVersions = keptVersions ?? savedVersions;
        const newVersions: Record<string, string> = { ...storedVersions };
        let versionsDirty = keptVersions !== null;
        for (const st of states) {
          if (st.status !== "active" || !st.manifest.contributes?.informationTypes?.length) continue;
          const prev = storedVersions[st.id];
          if (prev !== st.manifest.version) {
            newVersions[st.id] = st.manifest.version;
            versionsDirty = true;
          }
        }
        if (versionsDirty) {
          await store.set("pluginInfoVersions", newVersions);
        }
      }

      if (allImageProviders.length > 0) {
        await invoke("sync_image_providers", { providers: allImageProviders });
      }

      // Finish the merged-plugins migration now that the rows exist: switch
      // off the sources whose old plugin was off, then persist the new list.
      if (mergeMigration) {
        try {
          for (const id of new Set(mergeMigration.disabledProviders.map((k) => parseProviderKey(k).pluginId))) {
            const plugin = installed.find((p) => p.id === id);
            if (!plugin) continue;
            const rows = providerRowsFor(id, plugin.manifest, mergeMigration.disabledProviders);
            for (const [key, entity] of rows.images) {
              await invoke("update_image_provider_active", { pluginId: key, entity, active: false });
            }
            for (const [typeId, key] of rows.info) {
              await invoke("update_info_type_active", { typeId, pluginId: key, active: false });
            }
          }
          await store.set("enabledPlugins", mergeMigration.enabled);
          await store.set(MERGED_PLUGINS_DONE_KEY, true);
        } catch (e) {
          console.error("Failed to carry plugin switches over to the merged Artwork / Lyrics plugins:", e);
        }
      }

      // Sort by plugin name for consistent display
      sidebar.sort((a, b) => a.label.localeCompare(b.label));
      menus.sort((a, b) => a.label.localeCompare(b.label));

      settings.sort((a, b) => a.order - b.order);

      const shadowingIds = new Set(installed.filter((p) => p.shadowsBuiltin).map((p) => p.id));
      for (let i = 0; i < states.length; i++) {
        if (firstPartyIds.has(states[i].id)) states[i] = { ...states[i], firstParty: true };
        const optional = states[i].manifest.optionalPermissions ?? [];
        if (optional.length > 0) {
          const approved = permissionGrantsRef.current[states[i].id] ?? [];
          const waiting = permissionsAwaitingConsent({
            requested: optional,
            approved,
            trusted: firstPartyIds.has(states[i].id) || !!states[i].builtin,
            consent: programConsentRef.current[states[i].id],
          });
          states[i] = { ...states[i], optionalGranted: optional.filter((p) => approved.includes(p) && !waiting.includes(p)) };
        }
        if (shadowingIds.has(states[i].id)) states[i] = { ...states[i], shadowsBuiltin: true };
      }
      pluginStatesRef.current = states;
      setPluginStates(states);
      setSidebarItems(sidebar);
      setMenuItems(menus);
      setSettingsPanels(settings);
      setHomeShelves(shelves);
      setSearchProviders(searchers);
      setManifestWebSearchProviders(webSearchers);
      setVisualizers(vizzes);
      setManifestAssistantTools(assistTools);
      setManifestAssistantInstructions(new Map(assistInstructions));
    } catch (e) {
      console.error("Failed to load plugins:", e);
    } finally {
      setPluginsLoaded(true);
    }
  }, [activatePlugin, deactivatePlugin, debugMode, devPluginPath]);

  // Kick the initial load once startup has settled (startupReady flips true).
  // Loading earlier just contends with the cold-start critical path on the
  // single IPC channel; deferring it keeps first paint fast while still loading
  // every plugin in the background a beat later. Because debugMode/devPluginPath
  // are restored before the gate opens, the first load already sees their final
  // values — no redundant second full reload on debug startup.
  const initialLoadDone = useRef(false);
  useEffect(() => {
    if (!startupReady || initialLoadDone.current) return;
    initialLoadDone.current = true;
    loadPlugins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startupReady]);

  // Deactivate all on unmount.
  useEffect(() => {
    return () => {
      for (const id of loadedPluginsRef.current.keys()) {
        deactivatePlugin(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hydrate the plugin gallery from the last cached index so the Extensions
  // panel can show installable plugins instantly on open; fetchPluginGallery()
  // then revalidates over the network (stale-while-revalidate).
  useEffect(() => {
    (async () => {
      try {
        const cached = await store.get<GalleryPluginEntry[]>(
          PLUGIN_GALLERY_CACHE_KEY,
        );
        if (cached && cached.length) {
          setGalleryPlugins((prev) => (prev.length ? prev : cached));
        }
      } catch (e) {
        console.error("Failed to read cached plugin gallery:", e);
      }
    })();
  }, []);

  // Reload plugins when debugMode / devPluginPath changes (after initial load).
  useEffect(() => {
    if (initialLoadDone.current) {
      loadPlugins();
    }
  }, [debugMode, devPluginPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Public methods --

  /** Deliver `event` to the plugins `accept` lets through — how the
   *  Settings → Playback → Scrobbling media choices reach `track:scrobbled`. Returns how
   *  many plugins were offered it and how many took it without throwing (a
   *  plugin with several handlers counts once, and only if none threw), plus
   *  each handler's own `results` entry: what it returned (for a worker
   *  plugin, a promise of what the worker's handler returned — or rejected
   *  with), or the error it threw. */
  const dispatchEventTo = useCallback(
    (event: PluginEventName, accept: (pluginId: string) => boolean, ...args: unknown[]): {
      offered: number;
      delivered: number;
      results: PluginEventResult[];
    } => {
      const offered = new Set<string>();
      const failed = new Set<string>();
      const results: PluginEventResult[] = [];
      // Copy: a handler may unsubscribe itself while we iterate, and splicing
      // the live array would skip the handler after it.
      for (const { pluginId, handler } of [...eventHandlersRef.current[event]]) {
        if (!accept(pluginId)) continue;
        offered.add(pluginId);
        try {
          results.push({ pluginId, value: (handler as (...a: unknown[]) => unknown)(...args) });
        } catch (e) {
          failed.add(pluginId);
          results.push({ pluginId, error: e });
          console.error(`[plugin:${pluginId}] event ${event} error:`, e);
        }
      }
      return { offered: offered.size, delivered: offered.size - failed.size, results };
    },
    [],
  );

  const dispatchEvent = useCallback(
    (event: PluginEventName, ...args: unknown[]) => {
      dispatchEventTo(event, () => true, ...args);
    },
    [dispatchEventTo],
  );

  const dispatchContextMenuAction = useCallback(
    (pluginId: string, actionId: string, target: PluginContextMenuTarget) => {
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) return;
      const handler = loaded.contextMenuHandlers.get(actionId);
      if (handler) {
        // Anonymous: which plugin action was invoked (ids only, no target data).
        trackTelemetry("plugin_action", { plugin_id: pluginId, action_id: actionId });
        try {
          handler(target);
        } catch (e) {
          console.error(
            `[plugin:${pluginId}] context menu action ${actionId} error:`,
            e,
          );
        }
      }
    },
    [],
  );

  /** Returns whether a handler for `actionId` existed and was called. Callers
   *  that own a fallback need this: `HOST_SEARCH_ACTION` is offered to every
   *  plugin view opened with a query and handled by almost none, and the
   *  fallback (seeding the view's own search box) must not run for the one
   *  plugin that took the query itself — it would search twice. A handler that
   *  throws still counts as handled: it was that plugin's to answer, and the
   *  fallback would be a second attempt at a gesture already in progress. */
  const dispatchUIAction = useCallback(
    (pluginId: string, actionId: string, data?: unknown): boolean => {
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) return false;
      const handler = loaded.uiActionHandlers.get(actionId);
      if (!handler) return false;
      try {
        handler(data);
      } catch (e) {
        console.error(
          `[plugin:${pluginId}] UI action ${actionId} error:`,
          e,
        );
      }
      return true;
    },
    [],
  );

  const togglePlugin = useCallback(
    async (pluginId: string, enabled: boolean) => {
      if (enabled) {
        enabledPluginsRef.current.add(pluginId);
      } else {
        enabledPluginsRef.current.delete(pluginId);
        deactivatePlugin(pluginId);
      }
      await store.set(
        "enabledPlugins",
        Array.from(enabledPluginsRef.current),
      );
      // Reload to rebuild state
      await loadPlugins();
    },
    [deactivatePlugin, loadPlugins],
  );

  const reloadPlugin = useCallback(
    async (pluginId: string) => {
      deactivatePlugin(pluginId);
      await loadPlugins();
    },
    [deactivatePlugin, loadPlugins],
  );

  // Approve everything a worker plugin's current manifest asks for, then load
  // it. The approval is exactly the requested list — not a union with older
  // approvals — so revoking a permission in a later version really drops it.
  //
  // Reads the latest loaded states, not this render's: the install dialog and
  // the after-update prompt call it straight after a reload, before React has
  // re-rendered, and a stale manifest would grant the previous version's list.
  //
  // Resolves false, granting nothing, when an unsigned plugin asks to run
  // programs and the user turns down the warning that follows (the second
  // consent — every approval surface goes through here, so none can skip it).
  const approvePermissions = useCallback(
    async (pluginId: string): Promise<boolean> => {
      const state = pluginStatesRef.current.find((s) => s.id === pluginId);
      const requested = state?.manifest.permissions ?? [];
      const trusted = !!(state?.builtin || state?.firstParty);
      if (needsUnsignedWarning(requested, trusted) && !(await askUnsignedPrograms(pluginId, state?.manifest.name ?? pluginId))) {
        return false;
      }
      // Exactly the manifest's list — plus optional permissions granted
      // earlier, which belong to a feature the user already said yes to.
      const optional = state?.manifest.optionalPermissions ?? [];
      const keptOptional = (permissionGrantsRef.current[pluginId] ?? []).filter((p) => optional.includes(p));
      permissionGrantsRef.current = { ...permissionGrantsRef.current, [pluginId]: Array.from(new Set([...requested, ...keptOptional])) };
      await store.set(PERMISSION_GRANTS_KEY, permissionGrantsRef.current);
      if (requested.some((p) => ALWAYS_ASK_PERMISSIONS.includes(p))) {
        programConsentRef.current = { ...programConsentRef.current, [pluginId]: trusted ? "signed" : "unsigned" };
        await store.set(PROGRAM_CONSENT_KEY, programConsentRef.current);
      }
      await loadPlugins();
      return true;
    },
    [askUnsignedPrograms, loadPlugins],
  );

  // What the user would be asked to approve for this plugin right now: the
  // requested permissions not yet approved. Empty for built-ins and plugins
  // signed by the trusted first-party key (both pre-approved),
  // main-realm plugins (no permission model) and anything fully approved — so
  // an update asks only when it brings a NEW permission (owner decision,
  // 2026-10-03). Works for a disabled plugin too, which is what a fresh install
  // is until its install dialog enables it.
  // The always-ask permissions (programs:run) are the exception to the
  // pre-approval: they show up here for signed plugins too.
  const permissionsToApprove = useCallback((pluginId: string): string[] => {
    const s = pluginStatesRef.current.find((p) => p.id === pluginId);
    if (!s || s.manifest.runtime !== "worker") return [];
    return permissionsAwaitingConsent({
      requested: s.manifest.permissions ?? [],
      approved: permissionGrantsRef.current[pluginId] ?? [],
      trusted: !!(s.builtin || s.firstParty),
      consent: programConsentRef.current[pluginId],
    });
  }, []);

  // Why the plugin says it needs each permission (manifest `permissionReasons`,
  // cleaned), for every surface that shows the list.
  const permissionReasonsFor = useCallback((pluginId: string): Record<string, string> => {
    const m = pluginStatesRef.current.find((p) => p.id === pluginId)?.manifest;
    return m ? permissionReasons(m.permissions, m.permissionReasons) : {};
  }, []);

  const dropProgramConsent = useCallback(async (pluginId: string) => {
    if (!(pluginId in programConsentRef.current)) return;
    const { [pluginId]: _dropped, ...rest } = programConsentRef.current;
    programConsentRef.current = rest;
    await store.set(PROGRAM_CONSENT_KEY, rest);
  }, []);

  // Withdraw every approval: the plugin stops now and waits for approval again.
  const revokePermissions = useCallback(
    async (pluginId: string) => {
      const { [pluginId]: _revoked, ...rest } = permissionGrantsRef.current;
      permissionGrantsRef.current = rest;
      await store.set(PERMISSION_GRANTS_KEY, rest);
      await dropProgramConsent(pluginId);
      deactivatePlugin(pluginId);
      await loadPlugins();
    },
    [deactivatePlugin, dropProgramConsent, loadPlugins],
  );

  const reloadAllPlugins = useCallback(async () => {
    for (const id of loadedPluginsRef.current.keys()) {
      deactivatePlugin(id);
    }
    await loadPlugins();
  }, [deactivatePlugin, loadPlugins]);

  const getViewData = useCallback(
    (pluginId: string, viewId: string): PluginViewData | undefined => {
      return viewData.get(`${pluginId}:${viewId}`);
    },
    [viewData],
  );

  const getViewHeader = useCallback(
    (pluginId: string, viewId: string): PluginViewHeader | null => {
      return viewHeaders.get(`${pluginId}:${viewId}`) ?? null;
    },
    [viewHeaders],
  );

  const getViewScrollKey = useCallback(
    (pluginId: string, viewId: string): string | undefined => {
      return viewScrollKeyRef.current.get(`${pluginId}:${viewId}`);
    },
    [],
  );

  const fetchPluginGallery = useCallback(
    async (force = false): Promise<GalleryPluginEntry[]> => {
      // Within the TTL, serve the already-loaded index without a network call so
      // reopening the panel is instant. `force` bypasses it (first-run prompt).
      if (
        !force &&
        galleryPluginsRef.current.length > 0 &&
        Date.now() - lastGalleryFetchRef.current < GALLERY_TTL_MS
      ) {
        return galleryPluginsRef.current;
      }
      setGalleryLoading(true);
      setGalleryError(null);
      try {
        const json = await invoke<string>("fetch_plugin_gallery");
        const index: PluginGalleryIndex = JSON.parse(json);
        const entries = index.plugins || [];
        setGalleryPlugins(entries);
        lastGalleryFetchRef.current = Date.now();
        store.set(PLUGIN_GALLERY_CACHE_KEY, entries).catch((e) =>
          console.error("Failed to cache plugin gallery:", e),
        );
        return entries;
      } catch (e) {
        setGalleryError(String(e));
        return galleryPluginsRef.current;
      } finally {
        setGalleryLoading(false);
      }
    },
    [],
  );

  // Warm the gallery cache once plugins finish loading, so the Extensions panel's
  // "Available" list is ready before the user opens it. Fire-and-forget and
  // TTL-guarded — it never blocks startup or the UI.
  useEffect(() => {
    if (!pluginsLoaded) return;
    fetchPluginGallery().catch((e) =>
      console.error("Plugin gallery prefetch failed:", e),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginsLoaded]);

  const installFromGallery = useCallback(
    async (
      entry: GalleryPluginEntry,
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!entry.updateUrl) {
        return { ok: false, error: "Gallery entry has no updateUrl; cannot install." };
      }
      try {
        await invoke<void>("install_gallery_plugin_by_update_url", {
          pluginId: entry.id,
          updateUrl: entry.updateUrl,
        });
        await loadPlugins();
        trackTelemetry("plugin_installed", { id: entry.id });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    [loadPlugins],
  );

  const deletePlugin = useCallback(
    async (pluginId: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Delete on disk FIRST — only mutate enabled-state/deactivate once the
        // backend confirms removal, so a failed delete (e.g. it's a built-in, not
        // a user plugin) leaves the plugin's enabled state and activation intact.
        // Removing an update installed over a built-in (Last.fm) brings the
        // built-in back, so the plugin stays switched on: dropping it from the
        // enabled list would leave the built-in off for good, since built-ins
        // are only auto-enabled on first launch.
        const revertsToBuiltin = !!pluginStatesRef.current.find((p) => p.id === pluginId)?.shadowsBuiltin;
        await invoke("delete_user_plugin", { pluginId });
        // An approval belongs to what the user reviewed, not to an id: a
        // different plugin installed later under the same id must be asked
        // again, so uninstalling drops it.
        if (pluginId in permissionGrantsRef.current) {
          const { [pluginId]: _dropped, ...rest } = permissionGrantsRef.current;
          permissionGrantsRef.current = rest;
          await store.set(PERMISSION_GRANTS_KEY, rest);
        }
        await dropProgramConsent(pluginId);
        if (revertsToBuiltin) {
          deactivatePlugin(pluginId);
        } else if (enabledPluginsRef.current.has(pluginId)) {
          enabledPluginsRef.current.delete(pluginId);
          deactivatePlugin(pluginId);
          await store.set(
            "enabledPlugins",
            Array.from(enabledPluginsRef.current),
          );
        }
        await loadPlugins();
        return { ok: true };
      } catch (e) {
        console.error("Failed to delete plugin:", e);
        return { ok: false, error: String(e) };
      }
    },
    [deactivatePlugin, dropProgramConsent, loadPlugins],
  );

  const forwardDeepLink = useCallback((url: string) => {
    // Scoped routing: `viboplr://plugin/<id>/...` is delivered ONLY to the
    // plugin whose id it names. Anything else keeps the legacy broadcast to
    // every plugin's onDeepLink handler — which is why anything sensitive (an
    // OAuth callback carrying a token) should use the scoped form: a broadcast
    // link is readable by every installed plugin, not just its addressee.
    const scoped = /^viboplr:\/\/plugin\/([^/?#]+)/.exec(url);
    let targets: LoadedPlugin[];
    if (scoped) {
      const owner = loadedPluginsRef.current.get(decodeURIComponent(scoped[1]));
      if (!owner) {
        console.warn(`[forwardDeepLink] scoped link for plugin "${scoped[1]}", which is not loaded — dropped`);
        return;
      }
      targets = [owner];
    } else {
      targets = Array.from(loadedPluginsRef.current.values());
    }
    let handlerCount = 0;
    for (const l of targets) handlerCount += l.deepLinkHandlers.length;
    console.debug(`[forwardDeepLink] url=${url}, ${scoped ? `scoped to ${targets[0].id}` : `plugins=${targets.length}`}, handlers=${handlerCount}`);
    for (const loaded of targets) {
      for (const handler of loaded.deepLinkHandlers) {
        try {
          handler(url);
        } catch (e) {
          console.error(`[plugin:${loaded.id}] deep link handler error:`, e);
        }
      }
    }
  }, []);

  const invokeInfoFetch = useCallback(
    async (
      pluginId: string,
      infoTypeId: string,
      entity: InfoEntity,
      onFetchUrl?: (url: string) => void,
    ): Promise<InfoFetchResult> => {
      // The built-in local-lyrics provider (a `core:` row in the chain, like
      // the image chain's core rows) is answered natively rather than by a
      // plugin: embedded tag / sidecar .lrc / Lyrics folder, probed live by
      // `get_local_lyrics`. not_found falls through to the next provider.
      if (pluginId === CORE_LOCAL_LYRICS_PROVIDER) {
        const value = await fetchLocalLyrics(entity, entity.path);
        return value ? { status: "ok", value } : { status: "not_found" };
      }
      // `pluginId` is a provider row's key: a bare plugin id, or
      // `<pluginId>/<provider>` for a plugin offering several (providerKey.ts).
      const { pluginId: owner, provider } = parseProviderKey(pluginId);
      const loaded = loadedPluginsRef.current.get(owner);
      if (!loaded) return { status: "error" };
      const handler = loaded.infoFetchHandlers.get(handlerKey(infoTypeId, provider));
      if (!handler) return { status: "error" };
      const prev = fetchUrlCallbackRef.current;
      fetchUrlCallbackRef.current = onFetchUrl ?? null;
      try {
        return await handler(entity);
      } finally {
        fetchUrlCallbackRef.current = prev;
      }
    },
    [],
  );
  useAssignRef(invokeInfoFetchRef, invokeInfoFetch);

  const invokeImageFetch = useCallback(
    async (pluginId: string, entity: "artist" | "album" | "tag", name: string, artistName?: string): Promise<ImageFetchResult> => {
      // `pluginId` is normally a provider row's exact key — the Rust chain names
      // the row it is walking.
      const { pluginId: owner, provider } = parseProviderKey(pluginId);
      const loaded = loadedPluginsRef.current.get(owner);
      const handler = loaded?.imageFetchHandlers.get(handlerKey(entity, provider));
      if (handler) return runImageHandler(pluginId, entity, handler, name, artistName);
      // A full `<plugin>/<source>` key names one row; nothing to resolve. (Also
      // the common miss: the chain asking before that plugin finished loading.)
      if (provider) return { status: "error", message: loaded ? "no handler for entity" : "plugin not loaded" };

      // A pin (the control API's `pluginId`) is whatever the caller typed: a
      // plugin id, a bare source name. Same rule as an info-type pin
      // (matchesProviderRef), walked in the user's order, first `ok` wins —
      // so `artwork` tries Artwork's sources and `deezer` reaches its Deezer
      // provider, deterministically.
      const rows = await invoke<Array<[string, number, number]>>("get_image_providers", { entity })
        .catch((e) => {
          console.error(`Failed to read the ${entity} image providers:`, e);
          return [] as Array<[string, number, number]>;
        });
      let last: ImageFetchResult | null = null;
      for (const [key] of rows) {
        if (key === pluginId || !matchesProviderRef(key, pluginId)) continue;
        const parsed = parseProviderKey(key);
        const h = loadedPluginsRef.current.get(parsed.pluginId)?.imageFetchHandlers.get(handlerKey(entity, parsed.provider));
        if (!h) continue;
        last = await runImageHandler(key, entity, h, name, artistName);
        if (last.status === "ok") return last;
      }
      if (last) return last;
      // Exact text matters: the Rust image chain (lib.rs → is_provider_unavailable)
      // reads it as "couldn't ask" and then doesn't record a day-long failure.
      if (!loaded) return { status: "error", message: "plugin not loaded" };
      return { status: "error", message: "no handler for entity" };
    },
    [],
  );

  const invokeStreamResolve = useCallback(
    async (
      pluginId: string,
      providerId: string,
      title: string,
      artistName: string | null,
      albumName: string | null,
      durationSecs: number | null,
      preferVideo = false,
      externalAudio = false,
      fresh = false,
    ): Promise<StreamResolveResult | null> => {
      const provider = `${pluginId}:${providerId}`;
      const input = { title, artistName, albumName, durationSecs };
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) {
        return withResolverLog({ kind: "stream", provider, input }, async () => { throw new Error("plugin not loaded"); }).catch(() => null);
      }
      const handler = loaded.streamResolveHandlers.get(providerId);
      if (!handler) {
        return withResolverLog({ kind: "stream", provider, input }, async () => { throw new Error("no stream resolve handler registered"); }).catch(() => null);
      }
      try {
        return await withResolverLog({ kind: "stream", provider, input },
          () => handler(title, artistName, albumName, durationSecs, { preferVideo, externalAudio, fresh }));
      } catch {
        return null;
      }
    },
    [],
  );

  /** Run a resolve inside a scope, so its subprocesses are cancellable and its
   *  progress reports have somewhere to go. Nested resolves stack; the innermost
   *  wins for progress, but a cancel kills the whole stack for that plugin. */
  const withResolveScope = useCallback(
    async <T,>(pluginId: string, onProgress: DownloadProgressHandler | undefined, fn: () => Promise<T>): Promise<T> => {
      const scope: ResolveScope = { onProgress, execIds: new Set(), cancelled: false };
      const stack = resolveScopesRef.current.get(pluginId) ?? [];
      stack.push(scope);
      resolveScopesRef.current.set(pluginId, stack);
      try {
        return await fn();
      } finally {
        const live = resolveScopesRef.current.get(pluginId);
        if (live) {
          const i = live.indexOf(scope);
          if (i >= 0) live.splice(i, 1);
          if (live.length === 0) resolveScopesRef.current.delete(pluginId);
        }
      }
    },
    [],
  );

  /** Stop whatever this plugin is doing for an in-flight download resolve —
   *  the point of the whole scope mechanism. Kills every subprocess the resolve
   *  started; the plugin's `exec` then rejects and its handler throws, which the
   *  caller ignores because it asked for the cancel. */
  const cancelDownloadResolve = useCallback((pluginId: string) => {
    const stack = resolveScopesRef.current.get(pluginId);
    if (!stack) return;
    for (const scope of stack) {
      scope.cancelled = true;
      for (const execId of scope.execIds) {
        invoke("plugin_exec_cancel", { execId })
          .catch(e => console.error("Failed to cancel plugin exec:", e));
      }
    }
  }, []);

  const invokeDownloadResolveByUri = useCallback(
    async (
      pluginId: string, providerId: string, uri: string, format: string,
      onProgress?: DownloadProgressHandler,
    ): Promise<DownloadResolveResult | null> => {
      const provider = `${pluginId}:${providerId}`;
      const input = { uri, format };
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) {
        return withResolverLog({ kind: "download:uri", provider, input }, async () => { throw new Error("plugin not loaded"); }).catch(() => null);
      }
      const handler = loaded.downloadResolveByUriHandlers.get(providerId);
      if (!handler) {
        return withResolverLog({ kind: "download:uri", provider, input }, async () => { throw new Error("no resolveByUri handler registered"); }).catch(() => null);
      }
      // Errors propagate: a provider that THROWS is reporting a user-facing
      // reason ("YouTube bot check", "region-locked", …) — the download modal
      // shows it, and the background chain catches per-provider and moves on.
      // Returning null still means "cannot serve this URI, try the next".
      return await withResolveScope(pluginId, onProgress, () =>
        withResolverLog({ kind: "download:uri", provider, input },
          () => handler(uri, format)));
    },
    [withResolveScope],
  );

  const invokeDownloadResolveByMetadata = useCallback(
    async (
      pluginId: string, providerId: string,
      title: string, artistName: string | null, albumName: string | null,
      durationSecs: number | null, format: string,
      onProgress?: DownloadProgressHandler,
    ): Promise<DownloadResolveResult | null> => {
      const provider = `${pluginId}:${providerId}`;
      const input = { title, artistName, albumName, durationSecs, format };
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) {
        return withResolverLog({ kind: "download:metadata", provider, input }, async () => { throw new Error("plugin not loaded"); }).catch(() => null);
      }
      const handler = loaded.downloadResolveByMetadataHandlers.get(providerId);
      if (!handler) {
        return withResolverLog({ kind: "download:metadata", provider, input }, async () => { throw new Error("no resolveByMetadata handler registered"); }).catch(() => null);
      }
      // Errors propagate, as by URI: a throw is the provider's user-facing
      // reason and the modal shows it. Swallowing it here is what made every
      // fallback-path failure read "could not resolve this track".
      return await withResolveScope(pluginId, onProgress, () =>
        withResolverLog({ kind: "download:metadata", provider, input },
          () => handler(title, artistName, albumName, durationSecs, format)));
    },
    [withResolveScope],
  );

  const invokeInteractiveSearch = useCallback(
    async (pluginId: string, providerId: string, query: string, limit: number): Promise<InteractiveSearchResult[]> => {
      const provider = `${pluginId}:${providerId}`;
      const input = { query, limit };
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) {
        return withResolverLog({ kind: "download:search", provider, input }, async () => { throw new Error("plugin not loaded"); }).catch(() => []);
      }
      const handler = loaded.interactiveSearchHandlers.get(providerId);
      if (!handler) {
        return withResolverLog({ kind: "download:search", provider, input }, async () => { throw new Error("no interactive search handler registered"); }).catch(() => []);
      }
      return withResolverLog({ kind: "download:search", provider, input }, () => handler(query, limit));
    },
    [],
  );

  const invokeInteractiveResolve = useCallback(
    async (
      pluginId: string, providerId: string, matchId: string, format: string,
      onProgress?: DownloadProgressHandler,
    ): Promise<DownloadResolveResult> => {
      const provider = `${pluginId}:${providerId}`;
      const input = { matchId, format };
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) {
        return withResolverLog({ kind: "download:resolve", provider, input }, async () => { throw new Error(`Plugin ${pluginId} not loaded`); });
      }
      const handler = loaded.interactiveResolveHandlers.get(providerId);
      if (!handler) {
        return withResolverLog({ kind: "download:resolve", provider, input }, async () => { throw new Error(`No interactive resolve handler for ${providerId}`); });
      }
      // Scoped like the by-uri/by-metadata paths: the manual-search flow ends in
      // the same provider work, so it needs the same progress + cancel.
      return withResolveScope(pluginId, onProgress, () =>
        withResolverLog({ kind: "download:resolve", provider, input }, () => handler(matchId, format)));
    },
    [withResolveScope],
  );

  /** The provider's preview of what a download would fetch, or null when it
   *  offers none (no `onPreview`, or no interactive resolve to fetch the
   *  previewed item with). Throws whatever the provider throws. */
  const hasDownloadPreview = useCallback((pluginId: string, providerId: string): boolean => {
    const loaded = loadedPluginsRef.current.get(pluginId);
    return !!loaded?.downloadPreviewHandlers.get(providerId) && !!loaded.interactiveResolveHandlers.get(providerId);
  }, []);

  const hasInteractiveSearch = useCallback((pluginId: string, providerId: string): boolean => {
    return !!loadedPluginsRef.current.get(pluginId)?.interactiveSearchHandlers.get(providerId);
  }, []);

  const hasInteractiveResolve = useCallback((pluginId: string, providerId: string): boolean => {
    return !!loadedPluginsRef.current.get(pluginId)?.interactiveResolveHandlers.get(providerId);
  }, []);

  const invokeDownloadPreview = useCallback(
    async (pluginId: string, providerId: string, request: DownloadPreviewRequest): Promise<DownloadPreview | null> => {
      const provider = `${pluginId}:${providerId}`;
      const handler = loadedPluginsRef.current.get(pluginId)?.downloadPreviewHandlers.get(providerId);
      if (!handler) return null;
      return withResolverLog({ kind: "download:preview", provider, input: { ...request } }, () => handler(request));
    },
    [],
  );

  const invokeGetQualities = useCallback(
    (pluginId: string, providerId: string): DownloadQualityOption[] | null => {
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) return null;
      const handler = loaded.getQualitiesHandlers.get(providerId);
      if (!handler) return null;
      return handler();
    },
    [],
  );

  // Resolves a plugin URL scheme to a playable stream. A resolver may return a
  // bare URL (a single self-contained stream) or a candidate list (a source with
  // split video/audio streams the host picks among per its active engine — see
  // selectStream). Normalized here to `{ url, candidates? }`: `url` is always a
  // usable self-contained URL for URL-only consumers (source classification /
  // download detail); `candidates`, when present, carries the full menu for the
  // play path's selector. `opts.externalAudio` tells the resolver the host can
  // merge a separate audio track, so it should offer the split candidates.
  // `sourceUrl` (optional) is the page the stream came from — the same
  // attribution field the metadata resolver returns, passed straight through so
  // a plugin-scheme track can be shown and opened as its real source rather than
  // as its own opaque URI.
  const resolveStreamByUri = useCallback(
    async (
      scheme: string,
      id: string,
      quality?: string | null,
      opts?: { externalAudio?: boolean; fresh?: boolean; video?: boolean },
    ): Promise<{ url: string; candidates?: StreamCandidate[]; sourceUrl?: string }> => {
      for (const [, lp] of loadedPluginsRef.current) {
        const handler = lp.streamUriResolvers.get(scheme);
        if (handler) {
          const result = await handler(id, quality, opts);
          if (!result) continue;
          if (typeof result === "string") return { url: result };
          const candidates = result.candidates ?? [];
          if (candidates.length === 0) continue;
          // A self-contained URL for URL-only consumers: prefer a muxed stream,
          // else any candidate (the play path uses `candidates` directly).
          const selfContained = candidates.find((c) => c.kind === "muxed") ?? candidates[0];
          return { url: selfContained.url, candidates, sourceUrl: result.sourceUrl };
        }
      }
      throw new Error(`No stream URI resolver for scheme: ${scheme}`);
    },
    [],
  );

  // Seek-preview storyboard for a plugin-owned scheme. Bounded by
  // STORYBOARD_RESOLVE_TIMEOUT_MS (see there for why it is as long as it is) because
  // discovery may shell out and the seek bar must not be held hostage. Null when no
  // plugin owns the scheme, the plugin has none for this id, it times out, or it
  // throws — every case means "no preview", not an error.
  const resolveStoryboardByUri = useCallback(
    async (scheme: string, id: string): Promise<Storyboard | null> => {
      for (const [, lp] of loadedPluginsRef.current) {
        const handler = lp.storyboardResolvers.get(scheme);
        if (!handler) continue;
        try {
          const result = await Promise.race([
            handler(id),
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), STORYBOARD_RESOLVE_TIMEOUT_MS),
            ),
          ]);
          if (result) return result;
        } catch (e) {
          console.error(`Storyboard resolver failed for ${scheme}:`, e);
        }
      }
      return null;
    },
    [],
  );

  // Plugin id that owns a custom URL scheme (registered via onResolveStreamByUri).
  // Mirrors `resolveStreamByUri`'s lookup so a native plugin-scheme track can map
  // back to that plugin's download provider. Null when no plugin owns the scheme.
  const streamUriResolverOwner = useCallback((scheme: string): string | null => {
    for (const [, lp] of loadedPluginsRef.current) {
      if (lp.streamUriResolvers.has(scheme)) return lp.id;
    }
    return null;
  }, []);

  const invokeHomeShelf = useCallback(
    async (pluginId: string, shelfId: string, limit: number): Promise<HomeShelfResult> => {
      const handler = homeShelfHandlersRef.current.get(`${pluginId}:${shelfId}`);
      if (!handler) return { status: "error", message: "handler not registered" };
      return handler(limit);
    },
    [],
  );

  const invokeNowPlayingInfo = useCallback(
    async (pluginId: string, itemId: string, track: PluginTrack): Promise<NowPlayingInfoResult> => {
      const handler = nowPlayingInfoHandlersRef.current.get(`${pluginId}:${itemId}`);
      if (!handler) return { status: "error", message: "handler not registered" };
      return handler(track);
    },
    [],
  );

  // Invoke a plugin's registered card-click handler for a shelf, if any.
  // Returns true if a handler took over the click, false otherwise (so the
  // host can fall back to its default action).
  const invokeHomeShelfItemClick = useCallback(
    (pluginId: string, shelfId: string, item: HomeShelfItem): boolean => {
      const handler = homeShelfClickHandlersRef.current.get(`${pluginId}:${shelfId}`);
      if (!handler) return false;
      try {
        const r = handler(item);
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((e) => console.error(`[plugin:${pluginId}] home item click error:`, e));
        }
      } catch (e) {
        console.error(`[plugin:${pluginId}] home item click error:`, e);
      }
      return true;
    },
    [],
  );

  // Returns the resolver's promise of tracks, or null if no resolver is
  // registered for this shelf. The caller (App) awaits it to lazily resolve a
  // card whose tracks arrived empty.
  const invokeHomeShelfResolvePlay = useCallback(
    (pluginId: string, shelfId: string, item: HomeShelfItem): Promise<PluginTrack[]> | null => {
      const handler = homeShelfResolvePlayHandlersRef.current.get(`${pluginId}:${shelfId}`);
      if (!handler) return null;
      return Promise.resolve().then(() => handler(item));
    },
    [],
  );

  // Run one global-search provider. Never called while the user types — the
  // dropdown offers the provider and the user picks it (see PluginSearchAPI) —
  // so this is allowed to take real time and only needs a backstop against a
  // handler that never settles. Failures come back as `error`, so one broken
  // provider can never reject the caller.
  const invokePluginSearch = useCallback(
    async (
      pluginId: string,
      providerId: string,
      query: string,
      limit: number,
    ): Promise<NormalizedSearchResult> => {
      const handler = searchHandlersRef.current.get(`${pluginId}:${providerId}`);
      if (!handler) return { status: "error", message: "handler not registered" };
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => handler(query, limit)),
          new Promise<PluginSearchResult>((resolve) =>
            setTimeout(
              () => resolve({ status: "error", message: "timed out" }),
              PLUGIN_SEARCH_TIMEOUT_MS,
            ),
          ),
        ]);
        return normalizeSearchResult(result);
      } catch (e) {
        console.error(`Plugin search "${pluginId}:${providerId}" failed:`, e);
        return { status: "error", message: e instanceof Error ? e.message : String(e) };
      }
    },
    [],
  );

  // Run one web-search provider. Like invokePluginSearch, never rejects: a
  // missing handler, a throw or the timeout come back as `error`, which is
  // what lets hostOps.webSearch fall through to the user's next provider.
  const invokeWebSearch = useCallback(
    async (pluginId: string, providerId: string, query: string, limit: number): Promise<PluginWebSearchResult> => {
      const handler = webSearchHandlersRef.current.get(`${pluginId}:${providerId}`);
      if (!handler) return { status: "error", message: "handler not registered" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raw = await Promise.race([
          Promise.resolve().then(() => handler(query, limit)),
          new Promise<PluginWebSearchResult>((resolve) => {
            timer = setTimeout(() => resolve({ status: "error", message: "timed out" }), WEB_SEARCH_TIMEOUT_MS);
          }),
        ]);
        return normalizeWebSearchResult(raw, limit);
      } catch (e) {
        console.error(`Web search "${pluginId}:${providerId}" failed:`, e);
        return { status: "error", message: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(timer);
      }
    },
    [],
  );

  const pluginNames = useMemo(
    () =>
      new Map([
        // The built-in local-lyrics provider has no manifest to name it; without
        // this the fetch-progress line and the Retrieve modal show the raw id.
        [CORE_LOCAL_LYRICS_PROVIDER, "Local files"],
        // Plugin ids and provider keys alike: a provider row names the
        // provider ("Deezer"), not the plugin that hosts it ("Artwork").
        ...providerNames(pluginStates),
      ]),
    [pluginStates],
  );
  useAssignRef(pluginNamesRef, pluginNames);

  const allSearchProviders = useMemo(() => {
    const seen = new Set(searchProviders.map((p) => `${p.pluginId}:${p.providerId}`));
    const merged = [...searchProviders];
    for (const entry of dynamicSearchProvidersRef.current.values()) {
      const key = `${entry.pluginId}:${entry.providerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchProviders, dynamicSearchProvidersVersion]);

  // Web-search providers in the user's order (Settings → Providers), each with
  // its switch. Manifest + runtime merged like allSearchProviders.
  const webSearchProviders = useMemo(() => {
    const byKey = new Map(manifestWebSearchProviders.map((p) => [`${p.pluginId}:${p.providerId}`, p]));
    for (const entry of dynamicWebSearchProviders) {
      const key = `${entry.pluginId}:${entry.providerId}`;
      if (!byKey.has(key)) byKey.set(key, entry);
    }
    const ordered = orderWebSearchProviders([...byKey.values()], webSearchOrder);
    // Fail closed until the user's switches are known (see webSearchOrderLoaded).
    return webSearchOrderLoaded ? ordered : ordered.map((p) => ({ ...p, enabled: false }));
  }, [manifestWebSearchProviders, dynamicWebSearchProviders, webSearchOrder, webSearchOrderLoaded]);

  // Assistant tools: manifest declarations + runtime registrations, runtime
  // winning a name collision (a conditional re-registration refines the
  // manifest's static claim). Same merge shape as allSearchProviders.
  const allAssistantTools = useMemo(() => {
    const byKey = new Map(manifestAssistantTools.map((t) => [`${t.pluginId}:${t.name}`, t]));
    for (const entry of dynamicAssistantToolsRef.current.values()) {
      byKey.set(`${entry.pluginId}:${entry.name}`, entry);
    }
    return [...byKey.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestAssistantTools, assistantVersion]);

  // Per-plugin assistant instructions — runtime setInstructions() wins over
  // the manifest's static text while the plugin is active.
  const assistantInstructions = useMemo(() => {
    const merged = new Map(manifestAssistantInstructions);
    for (const [pluginId, text] of runtimeAssistantInstructionsRef.current) {
      merged.set(pluginId, text);
    }
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestAssistantInstructions, assistantVersion]);

  /** Invoke one plugin assistant tool. Rejects with the plugin's own error
   *  message (or the timeout) — the control API turns that into the HTTP
   *  error body, so throw something a model can act on. Same generous budget
   *  as catalog search: a tool may legitimately shell out or hit a network. */
  const invokeAssistantTool = useCallback(
    async (pluginId: string, name: string, args: Record<string, unknown>): Promise<unknown> => {
      const handler = assistantToolHandlersRef.current.get(`${pluginId}:${name}`);
      if (!handler) {
        throw new Error(
          `plugin "${pluginId}" has no live handler for tool "${name}" — the plugin may be disabled, still loading, or the tool is declared but not wired with api.assistant.onTool`,
        );
      }
      // The timer is cleared once the race settles: callers that poll (the
      // setup wizard's Spotify step) would otherwise leave a live 60s timer
      // behind for every call.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(() => handler(args)),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`tool "${name}" timed out after ${PLUGIN_SEARCH_TIMEOUT_MS / 1000}s`)),
              PLUGIN_SEARCH_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    [],
  );

  /**
   * Build a fresh visualizer instance for a slot.
   *
   * One instance per occupied slot — the same visualizer can legitimately be in
   * `nowplaying` and `miniplayer` at once, and they must not share DOM or
   * derived state. Returns null when the plugin is gone or never registered a
   * factory, which the slot renders as "nothing selected" rather than an error:
   * a disabled plugin taking a slot down with it should be invisible.
   */
  const createVisualizer = useCallback(
    (pluginId: string, visualizerId: string): PluginVisualizer | null => {
      const loaded = loadedPluginsRef.current.get(pluginId);
      const factory = loaded?.visualizerFactories.get(visualizerId);
      if (!factory) return null;
      try {
        return factory();
      } catch (e) {
        console.error(`[plugin:${pluginId}] visualizer ${visualizerId} factory failed:`, e);
        return null;
      }
    },
    [],
  );

  const allVisualizers = useMemo(() => {
    const seen = new Set(visualizers.map((v) => `${v.pluginId}:${v.id}`));
    const merged = [...visualizers];
    for (const entry of dynamicVisualizersRef.current.values()) {
      const key = `${entry.pluginId}:${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualizers, dynamicVisualizersVersion]);

  const allHomeShelves = useMemo(() => {
    const seen = new Set(homeShelves.map((s) => `${s.pluginId}:${s.shelfId}`));
    const merged = [...homeShelves];
    for (const entry of dynamicHomeShelvesRef.current.values()) {
      const key = `${entry.pluginId}:${entry.shelfId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeShelves, dynamicShelvesVersion]);

  // Static manifest items + runtime-registered ones, before the user's
  // per-contribution filter. The config UI needs this unfiltered list so a
  // turned-off item still has a row to turn back on.
  const mergedMenuItems = useMemo(() => {
    const seen = new Set(menuItems.map((m) => `${m.pluginId}:${m.id}`));
    const merged = [...menuItems];
    for (const entry of dynamicMenuItemsRef.current.values()) {
      const key = `${entry.pluginId}:${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuItems, dynamicMenuItemsVersion]);

  // One filter here covers every menu surface — library, queue, playlists,
  // plugin views, Home — because they all consume `plugins.menuItems`.
  // Stamped with the owning plugin's name so every menu can say whose action it is.
  const allMenuItems = useMemo(
    () => filterContributions(mergedMenuItems, "menu", contributionVisibility)
      .map((m) => ({ ...m, pluginName: pluginNames.get(m.pluginId) ?? m.pluginId })),
    [mergedMenuItems, contributionVisibility, pluginNames],
  );

  const visibleSidebarItems = useMemo(
    () => filterContributions(sidebarItems, "sidebar", contributionVisibility),
    [sidebarItems, contributionVisibility],
  );

  // A hidden provider loses its offer row, which is also what stops it being
  // queried — the host only calls a search handler on activation, so there is
  // no second path to gate.
  const visibleSearchProviders = useMemo(
    () =>
      filterContributions(
        allSearchProviders,
        "search",
        contributionVisibility,
        (p) => p.providerId,
      ),
    [allSearchProviders, contributionVisibility],
  );

  const hostRegistry = useMemo<HostRegistry>(
    () => ({
      pluginStates,
      searchProviders: visibleSearchProviders,
      invokePluginSearch,
      webSearchProviders,
      invokeWebSearch,
      assistantTools: allAssistantTools,
      assistantInstructions,
      invokeAssistantTool,
      homeShelves: allHomeShelves,
      menuItems: allMenuItems,
      pluginNames,
    }),
    [
      pluginStates, visibleSearchProviders, invokePluginSearch, webSearchProviders, invokeWebSearch, allAssistantTools,
      assistantInstructions, invokeAssistantTool, allHomeShelves, allMenuItems, pluginNames,
    ],
  );
  useAssignRef(hostRegistryRef, hostRegistry);

  const contributions = useMemo(
    () =>
      listPluginContributions({
        menuItems: mergedMenuItems,
        sidebarItems,
        searchProviders: allSearchProviders,
      }),
    [mergedMenuItems, sidebarItems, allSearchProviders],
  );

  // The waveform chain's plugin half (`api.waveforms`). Read from the loaded
  // plugins at call time, so the one object stays valid across loads/reloads.
  const waveformBridge = useMemo<WaveformPluginBridge>(() => ({
    lookupProviderIds: () =>
      [...loadedPluginsRef.current.values()].filter((lp) => lp.waveformLookupHandler).map((lp) => lp.id),
    async lookup(pluginId, facts) {
      const handler = loadedPluginsRef.current.get(pluginId)?.waveformLookupHandler;
      if (!handler) return null;
      try {
        const answer = await handler(facts);
        const rms = sanitizePluginRms(answer?.rms, facts.durationSecs);
        if (answer?.rms && !rms) console.warn(`[waveform] ${pluginId} answered a waveform that doesn't fit "${facts.title}" (${facts.durationSecs}s); ignored`);
        return rms;
      } catch (e) {
        console.error(`Waveform lookup via ${pluginId} failed:`, e);
        return null;
      }
    },
    share(facts, rms) {
      for (const lp of loadedPluginsRef.current.values()) {
        const handler = lp.waveformShareHandler;
        if (!handler) continue;
        Promise.resolve()
          .then(() => handler(facts, rms))
          .catch((e) => console.error(`Sharing a waveform with ${lp.id} failed:`, e));
      }
    },
    hasShareHandlers: () => [...loadedPluginsRef.current.values()].some((lp) => lp.waveformShareHandler),
  }), []);

  // Auto-continue's plugin half (`api.playback.onAutoContinue`). Like the
  // waveform bridge, handlers are read from the loaded plugins at call time.
  // Only a plugin that declares `contributes.autoContinue` AND registered a
  // handler is asked — the declaration is what Settings and the prefetch lead
  // see, so asking an undeclared plugin would run the slow path on the short
  // lead behind a slider that says no provider exists.
  const autoContinueBridge = useMemo<AutoContinuePluginBridge>(() => {
    const providers = () =>
      [...loadedPluginsRef.current.values()].filter((lp) => lp.autoContinueHandler && lp.manifest.contributes?.autoContinue);
    return {
      hasProviders: () => providers().length > 0,
      async suggest(request, accept) {
        for (const lp of providers()) {
          const handler = lp.autoContinueHandler;
          if (!handler) continue;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let answer: PluginTrack[] | null = null;
          try {
            answer = await Promise.race([
              Promise.resolve().then(() => handler(request)),
              new Promise<null>((resolve) => {
                timer = setTimeout(() => {
                  console.error(`Auto-continue via ${lp.id} timed out`);
                  resolve(null);
                }, PLUGIN_AUTO_CONTINUE_TIMEOUT_MS);
              }),
            ]);
          } catch (e) {
            console.error(`Auto-continue via ${lp.id} failed:`, e);
          } finally {
            clearTimeout(timer);
          }
          if (!Array.isArray(answer) || answer.length === 0) continue;
          const accepted = await accept(lp.id, answer);
          if (accepted !== null) return accepted;
        }
        return null;
      },
    };
  }, []);

  // What Settings lists: active plugins that declare `contributes.autoContinue`
  // (the registration itself isn't state, so the declaration is the reactive
  // signal; the bridge above asks only these, once they have registered).
  const autoContinueProviders = useMemo(
    () =>
      pluginStates
        .filter((p) => p.enabled && p.status === "active" && p.manifest.contributes?.autoContinue)
        .map((p) => ({ pluginId: p.id, name: p.manifest.contributes?.autoContinue?.name || p.manifest.name })),
    [pluginStates],
  );

  // Runtime-registered Now Playing info items, sorted by priority then label.
  const nowPlayingInfoItems = useMemo(
    () =>
      Array.from(nowPlayingInfoItemsRef.current.values()).sort(
        (a, b) => a.priority - b.priority || a.label.localeCompare(b.label),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nowPlayingInfoVersion],
  );

  return {
    pluginStates,
    pluginNames,
    sidebarItems: visibleSidebarItems,
    // Before the visibility filter. For consumers asking "does this user have
    // plugin views at all?" rather than "what goes in the nav" — the empty-state
    // branches must not flip because someone hid a nav entry. See App.tsx
    // `pluginViewList`.
    sidebarItemsUnfiltered: sidebarItems,
    menuItems: allMenuItems,
    // Per-contribution on/off (Extensions → plugin detail → Contributions).
    contributions,
    contributionVisibility,
    setContributionEnabled,
    settingsPanels,
    homeShelves: allHomeShelves,
    pluginsLoaded,
    viewData,
    getViewData,
    getViewHeader,
    getViewScrollKey,
    badgeMap,
    dispatchEvent,
    dispatchEventTo,
    scrobblerPluginIds,
    dispatchContextMenuAction,
    dispatchUIAction,
    invokeHomeShelfItemClick,
    invokeHomeShelfResolvePlay,
    searchProviders: visibleSearchProviders,
    invokePluginSearch,
    webSearchProviders,
    invokeWebSearch,
    setWebSearchOrder,
    resetWebSearchOrder,
    assistantTools: allAssistantTools,
    assistantInstructions,
    invokeAssistantTool,
    visualizers: allVisualizers,
    createVisualizer,
    togglePlugin,
    reloadPlugin,
    approvePermissions,
    unsignedProgramsRequest,
    optionalPermissionsRequest,
    programInstallRequest,
    dependencyRunRequest,
    runAppQuitting,
    permissionsToApprove,
    permissionReasonsFor,
    revokePermissions,
    reloadAllPlugins,
    forwardDeepLink,
    galleryPlugins,
    galleryLoading,
    galleryError,
    fetchPluginGallery,
    installFromGallery,
    deletePlugin,
    invokeInfoFetch,
    invokeImageFetch,
    invokeStreamResolve,
    invokeDownloadResolveByUri,
    invokeDownloadResolveByMetadata,
    cancelDownloadResolve,
    invokeInteractiveSearch,
    invokeInteractiveResolve,
    invokeGetQualities,
    invokeDownloadPreview,
    hasDownloadPreview,
    hasInteractiveSearch,
    hasInteractiveResolve,
    resolveStreamByUri,
    streamUriResolverOwner,
    resolveStoryboardByUri,
    waveformBridge,
    autoContinueBridge,
    autoContinueProviders,
    invokeHomeShelf,
    nowPlayingInfoItems,
    invokeNowPlayingInfo,
  };
}
