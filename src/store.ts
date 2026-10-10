import { LazyStore } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";

const STORE_DEFAULTS = {
  // Only keys something reads. Selected entities are never restored (startup
  // lands on Home), the queue lives in main_playlist, and the per-entity
  // sort / section keys predate the unified Library — so none of those are here.
  view: "all",
  currentTrackEntry: null,
  volume: 1.0,
  positionSecs: 0,
  crossfadeSecs: 3,
  playbackEngine: "native",
  audioExclusive: false,
  betaUpdates: false,
  windowWidth: null,
  windowHeight: null,
  windowX: null,
  windowY: null,
  windowMaximized: false,
  miniMode: false,
  fullWindowWidth: null,
  fullWindowHeight: null,
  fullWindowX: null,
  fullWindowY: null,
  fullWindowMaximized: false,
  autoContinueEnabled: false,
  autoContinueWeights: { random: 40, sameArtist: 20, sameTag: 20, mostPlayed: 10, liked: 10 },
  autoContinueSameFormat: false,
  trackColumns: null,
  trackSortField: null,
  trackSortDir: "asc",
  mediaTypeFilter: "all",
  trackLikedFirst: false,
  confirmTrashDelete: true,
  // Bit-perfect mode's confirmation "Don't ask again". The mode itself is
  // session-only and never persisted.
  bitPerfectSkipConfirm: false,
  openNowPlayingOnPlay: false,
  openNowPlayingOnVideoPlay: false,
  // Settings → Scrobbling (utils/scrobblers.ts). `trackVideoHistory` is the
  // legacy single switch, read once to migrate when this was never written.
  scrobbleSettings: null,
  videoLyricsOverlay: true,
  preferVideoResolution: false,
  videoStoryboards: true,
  radioOptions: { artistShare: 50, taste: "mixed", spreadArtists: false },
  videoLayout: { dockSide: "queue", fitMode: "contain", sizes: { top: 300, bottom: 300, left: 400, right: 400, queue: 260 }, isCollapsed: false },
  sidebarCollapsed: true,
  queueCollapsed: true,
  lastDownloadDest: null,
  skin: "default",
  loggingEnabled: false,
  debugLogging: false,
  debugMode: false,
  devPluginPath: null,
  trackDetailTabOrder: null,
  streamResolverOrder: null,
  minimizeToMiniPlayer: false,
  heroEffectMode: "by-artist",
  pluginRecommendationsShown: false,
  onboardingComplete: false,
  uiZoom: 1,
  miniZoom: 1,
  quizBestScores: {},
};

export interface AppStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  /** All key-value pairs in one IPC round-trip (vs one `get` per key). */
  entries<T = unknown>(): Promise<Array<[string, T]>>;
  init(): Promise<void>;
  /** Flush pending debounced writes to disk immediately (autoSave is 500ms). */
  save(): Promise<void>;
}

class ProfileStore implements AppStore {
  private _inner?: LazyStore;
  private _initPromise?: Promise<LazyStore>;

  private getInner(): Promise<LazyStore> {
    if (this._inner) return Promise.resolve(this._inner);
    if (!this._initPromise) {
      this._initPromise = invoke<{ storePath: string }>("get_profile_info")
        .then(({ storePath }) => {
          this._inner = new LazyStore(storePath, {
            autoSave: 500,
            defaults: STORE_DEFAULTS,
          });
          return this._inner;
        })
        .catch((e) => {
          this._initPromise = undefined;
          throw e;
        });
    }
    return this._initPromise;
  }

  async init(): Promise<void> {
    await this.getInner();
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.getInner()).get<T>(key);
  }

  async entries<T = unknown>(): Promise<Array<[string, T]>> {
    return (await this.getInner()).entries<T>();
  }

  async set(key: string, value: unknown): Promise<void> {
    return (await this.getInner()).set(key, value);
  }

  async save(): Promise<void> {
    return (await this.getInner()).save();
  }
}

export const store = new ProfileStore();
