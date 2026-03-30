import { LazyStore } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";

const STORE_DEFAULTS = {
  view: "all",
  selectedArtist: null,
  selectedAlbum: null,
  selectedTag: null,
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
  lastfmSessionKey: null,
  lastfmUsername: null,
  trackVideoHistory: false,
  videoSplitHeight: 300,
  sidebarCollapsed: false,
  queueCollapsed: false,
  downloadFormat: "flac",
  tidalEnabled: false,
  musicGatewayUrl: "",
  musicGatewayExePath: "",
  musicGatewayManaged: false,
  skin: "default",
  loggingEnabled: false,
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
        });
    }
    return this._initPromise;
  }

  async init(): Promise<void> {
    const inner = await this.getInner();
    // Access a key to force LazyStore to connect and load defaults
    await inner.get("view");
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.getInner()).get<T>(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    return (await this.getInner()).set(key, value);
  }
}

export const store = new ProfileStore();
