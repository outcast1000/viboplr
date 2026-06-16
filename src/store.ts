import { LazyStore } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";

const STORE_DEFAULTS = {
  view: "all",
  selectedArtist: null,
  selectedAlbum: null,
  selectedTag: null,
  selectedTrack: null,
  currentTrackEntry: null,
  volume: 1.0,
  queueEntries: [],
  queueIndex: -1,
  queueMode: "normal",
  positionSecs: 0,
  crossfadeSecs: 3,
  windowWidth: null,
  windowHeight: null,
  windowX: null,
  windowY: null,
  miniMode: false,
  fullWindowWidth: null,
  fullWindowHeight: null,
  fullWindowX: null,
  fullWindowY: null,
  searchProviders: null,
  autoContinueEnabled: false,
  autoContinueWeights: { random: 40, sameArtist: 20, sameTag: 20, mostPlayed: 10, liked: 10 },
  autoContinueSameFormat: false,
  trackColumns: null,
  trackSortField: null,
  trackSortDir: "asc",
  artistSortField: null,
  artistSortDir: "asc",
  artistLikedFirst: false,
  albumSortField: null,
  albumSortDir: "asc",
  albumLikedFirst: false,
  tagSortField: null,
  tagSortDir: "asc",
  tagLikedFirst: false,
  mediaTypeFilter: "all",
  trackLikedFirst: false,
  trackVideoHistory: true,
  videoLayout: { dockSide: "bottom", fitMode: "contain", sizes: { top: 300, bottom: 300, left: 400, right: 400 }, isCollapsed: false },
  sidebarCollapsed: true,
  queueCollapsed: true,
  lastDownloadDest: null,
  skin: "default",
  loggingEnabled: false,
  debugLogging: false,
  debugMode: false,
  devPluginPath: null,
  artistSections: { topSongs: true, about: true, albums: true, similarArtists: true },
  albumSections: { review: true, unmatchedTracks: true },
  trackDetailTabOrder: null,
  streamResolverOrder: null,
  minimizeToMiniPlayer: false,
  heroEffectMode: "by-artist",
  pluginRecommendationsShown: false,
};

export interface AppStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  init(): Promise<void>;
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

  async set(key: string, value: unknown): Promise<void> {
    return (await this.getInner()).set(key, value);
  }
}

export const store = new ProfileStore();
