import type {
  Track,
  HistoryEntry,
  HistoryMostPlayed,
  TidalSearchResult,
  TidalAlbumDetail,
  TidalArtistDetail,
  TidalSearchAlbum,
} from "../types";

// -- Manifest types --

export interface PluginManifestSidebarItem {
  id: string;
  label: string;
  icon: string;
}

export interface PluginManifestContextMenuItem {
  id: string;
  label: string;
  targets: PluginTargetKind[];
}

export type PluginTargetKind = "track" | "album" | "artist" | "multi-track" | "playlist";

export type PluginEventName =
  | "track:started"
  | "track:played"
  | "track:scrobbled"
  | "track:liked";

export interface PluginManifestInfoType {
  id: string;
  name: string;
  description?: string;
  entity: "artist" | "album" | "track" | "tag";
  displayKind: string;
  ttl: number;
  order: number;
  priority: number;
}

export interface PluginManifestImageProvider {
  entity: "artist" | "album";
  priority: number;
}

export interface PluginManifestFallbackProvider {
  id: string;
  name: string;
  priority: number;
}

export interface PluginManifestSettingsPanel {
  id: string;
  label: string;
  icon?: string;
  order?: number;
}

export interface PluginManifestContributes {
  sidebarItems?: PluginManifestSidebarItem[];
  contextMenuItems?: PluginManifestContextMenuItem[];
  eventHooks?: PluginEventName[];
  informationTypes?: PluginManifestInfoType[];
  imageProviders?: PluginManifestImageProvider[];
  fallbackProviders?: PluginManifestFallbackProvider[];
  settingsPanel?: PluginManifestSettingsPanel;
}

export interface PluginApiUsage {
  api: string;
  reason: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  minAppVersion?: string;
  icon?: string;
  apiUsage?: PluginApiUsage[];
  homepage?: string;
  contributes?: PluginManifestContributes;
  updateUrl?: string;
}

// -- Installed plugin from backend --

export interface InstalledPlugin {
  id: string;
  manifest: PluginManifest;
  builtin?: boolean;
}

// -- Plugin status --

export type PluginStatus = "active" | "error" | "incompatible" | "disabled";

export interface PluginState {
  id: string;
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  enabled: boolean;
  builtin?: boolean;
}

// -- Plugin-facing context menu target --

export interface PluginContextMenuTarget {
  kind: PluginTargetKind;
  trackId?: number;
  title?: string;
  artistName?: string;
  albumId?: number;
  albumTitle?: string;
  artistId?: number;
  trackIds?: number[];
  subsonic?: boolean;
  playlistId?: number;
  playlistName?: string;
  tracks?: Array<{ title: string; artistName?: string | null; albumName?: string | null }>;
}

// -- View data types --

export interface CardGridContextAction {
  id: string;
  label: string;
  separator?: boolean;
}

export interface CardGridItem {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  action?: string;
  contextMenuActions?: CardGridContextAction[];
  // Target kind for plugin context menu items registered for this card.
  // Defaults to "playlist" in PluginViewRenderer if unspecified.
  targetKind?: "playlist" | "album" | "artist";
  // Optional track data plumbed through plugin context menu targets,
  // e.g. a Spotify playlist card carrying its tracks so that a TIDAL
  // plugin action can download them without round-tripping to the DB.
  tracks?: Array<{ title: string; artistName?: string | null; albumName?: string | null }>;
}

export interface StatItem {
  label: string;
  value: string | number;
}

export interface TrackRowItem {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  duration?: string;
  action?: string;
}

export type PluginViewData =
  | { type: "track-list"; tracks: Track[]; title?: string }
  | { type: "card-grid"; items: CardGridItem[]; columns?: number }
  | {
      type: "track-row-list";
      items: TrackRowItem[];
      selectable?: boolean;
      actions?: { id: string; label: string; icon?: string }[];
    }
  | { type: "text"; content: string; className?: string }
  | { type: "stats-grid"; items: StatItem[] }
  | { type: "button"; label: string; action: string; variant?: "accent" | "secondary"; disabled?: boolean; style?: Record<string, string> }
  | {
      type: "layout";
      direction: "vertical" | "horizontal";
      children: PluginViewData[];
    }
  | { type: "spacer" }
  | {
      type: "search-input";
      placeholder?: string;
      action: string;
      value?: string;
    }
  | {
      type: "tabs";
      tabs: { id: string; label: string; count?: number }[];
      activeTab: string;
      action: string;
    }
  | { type: "loading"; message?: string }
  | { type: "toggle"; label: string; description?: string; action: string; checked: boolean; disabled?: boolean }
  | { type: "select"; label: string; description?: string; action: string; value: string; options: { value: string; label: string }[] }
  | { type: "progress-bar"; value: number; max: number; label?: string }
  | { type: "settings-row"; label: string; description?: string; control: PluginViewData }
  | { type: "section"; title: string; children: PluginViewData[] }
  | {
      type: "detail-header";
      title: string;
      subtitle?: string;
      meta?: string;
      imageUrl?: string;
      actions?: { id: string; label: string; icon?: string }[];
      backAction?: string;
    };

// -- Plugin API (what plugins receive) --

export interface PluginLibraryAPI {
  getTracks(opts?: {
    artistId?: number;
    albumId?: number;
    tagId?: number;
    limit?: number;
  }): Promise<Track[]>;
  getArtists(): Promise<
    Array<{ id: number; name: string; track_count: number }>
  >;
  getAlbums(): Promise<
    Array<{
      id: number;
      title: string;
      artist_name: string | null;
      year: number | null;
    }>
  >;
  getTrackById(id: number): Promise<Track | null>;
  search(query: string): Promise<Track[]>;
  getHistory(opts?: { limit?: number }): Promise<HistoryEntry[]>;
  getMostPlayed(opts?: {
    limit?: number;
    days?: number;
  }): Promise<HistoryMostPlayed[]>;
  recordHistoryPlaysBatch(plays: { artist: string; track: string; playedAt: number }[]): Promise<{ imported: number; skipped: number }>;
  applyTags(trackId: number, tagNames: string[]): Promise<Array<{ id: number; name: string }>>;
}

export interface PluginPlaybackAPI {
  getCurrentTrack(): Track | null;
  isPlaying(): boolean;
  getPosition(): number;
  playTidalTrack(track: TidalSearchTrackLike): void;
  enqueueTidalTrack(track: TidalSearchTrackLike): void;
  playTidalTracks(tracks: TidalSearchTrackLike[], startIndex?: number, context?: { name: string; coverUrl?: string | null }): void;
  onTrackStarted(handler: (track: Track) => void): () => void;
  onTrackPlayed(handler: (track: Track) => void): () => void;
  onTrackScrobbled(handler: (track: Track) => void): () => void;
  onTrackLiked(handler: (track: Track, liked: boolean) => void): () => void;
  onFallbackResolve(
    providerId: string,
    handler: (title: string, artistName: string | null, albumName: string | null) => Promise<{ url: string; label: string } | null>,
  ): () => void;
}

// Loose shape plugins pass for TIDAL tracks (matches TidalSearchTrack)
export interface TidalSearchTrackLike {
  tidal_id: string;
  title: string;
  artist_name?: string | null;
  artist_id?: string | null;
  album_title?: string | null;
  album_id?: string | null;
  cover_id?: string | null;
  duration_secs?: number | null;
  track_number?: number | null;
}

export interface PluginTidalAPI {
  search(query: string, limit?: number, offset?: number): Promise<TidalSearchResult>;
  getAlbum(albumId: string): Promise<TidalAlbumDetail>;
  getArtist(artistId: string): Promise<TidalArtistDetail>;
  getArtistAlbums(artistId: string): Promise<TidalSearchAlbum[]>;
  getStreamUrl(trackId: string, quality?: string): Promise<string>;
  downloadTrack(trackId: string, opts?: { collectionId?: number; format?: string }): Promise<void>;
  downloadAlbum(albumId: string, opts?: { collectionId?: number; format?: string }): Promise<void>;
  checkStatus(): Promise<{ available: boolean; instance_count: number }>;
}

export interface PluginCollectionsAPI {
  getLocalCollections(): Promise<Array<{ id: number; name: string; path: string | null }>>;
  getDownloadFormat(): Promise<string>;
}

export interface PluginContextMenuAPI {
  onAction(
    actionId: string,
    handler: (target: PluginContextMenuTarget) => void,
  ): void;
}

export interface PluginUIAPI {
  setViewData(viewId: string, data: PluginViewData): void;
  showNotification(message: string): void;
  onAction(actionId: string, handler: (data: unknown) => void): void;
  navigateToView(viewId: string): void;
  requestAction(action: string, payload: Record<string, unknown>): void;
}

export interface PluginStorageAPI {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface BrowseWindowHandle {
  eval(js: string): Promise<void>;
  close(): Promise<void>;
  show(): Promise<void>;
  hide(): Promise<void>;
  onMessage(handler: (msg: { type: string; data: unknown }) => void): () => void;
  onNavigation(handler: (url: string) => void): () => void;
}

export interface PluginNetworkAPI {
  fetch(
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<{
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
  openUrl(url: string): Promise<void>;
  onDeepLink(handler: (url: string) => void): () => void;
  onOAuthCallback(handler: (queryString: string) => void): () => void;
  startOAuthListener(): Promise<number>;
  openBrowseWindow(
    url: string,
    opts?: { title?: string; width?: number; height?: number; visible?: boolean },
  ): Promise<BrowseWindowHandle>;
}

export interface PluginInformationTypesAPI {
  onFetch(
    infoTypeId: string,
    handler: (entity: import("./informationTypes").InfoEntity) => Promise<import("./informationTypes").InfoFetchResult>,
  ): () => void;
  /** Call a Tauri command from within an info fetch handler. Allows internal
   *  plugins to reuse existing backend commands (e.g. lastfm_get_artist_info). */
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export type ImageFetchResult =
  | { status: "ok"; url: string; headers?: Record<string, string> }
  | { status: "ok"; data: string }
  | { status: "not_found" }
  | { status: "error"; message?: string };

export interface PluginImageProvidersAPI {
  onFetch(
    entity: "artist" | "album",
    handler: (name: string, artistName?: string) => Promise<ImageFetchResult>,
  ): () => void;
}

export interface PluginPlaylistsAPI {
  save(data: {
    name: string;
    source?: string;
    imageUrl?: string;
    tracks: Array<{
      title: string;
      artistName?: string;
      albumName?: string;
      durationSecs?: number;
      source?: string;
      imageUrl?: string;
    }>;
  }): Promise<number>;

  list(): Promise<Array<{
    id: number;
    name: string;
    source: string | null;
    savedAt: number;
    imagePath: string | null;
    trackCount: number;
  }>>;

  delete(id: number): Promise<void>;

  getTracks(id: number): Promise<Array<{
    title: string;
    artistName: string | null;
    albumName: string | null;
    durationSecs: number | null;
    source: string | null;
    imagePath: string | null;
  }>>;
}

export interface ViboplrPluginAPI {
  library: PluginLibraryAPI;
  playback: PluginPlaybackAPI;
  contextMenu: PluginContextMenuAPI;
  ui: PluginUIAPI;
  storage: PluginStorageAPI;
  network: PluginNetworkAPI;
  tidal: PluginTidalAPI;
  collections: PluginCollectionsAPI;
  playlists: PluginPlaylistsAPI;
  informationTypes: PluginInformationTypesAPI;
  imageProviders: PluginImageProvidersAPI;
}

// -- Gallery types --

export interface GalleryPluginEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  version: string;
  minAppVersion?: string;
  updateUrl?: string;
  files: string[];
}

export interface PluginGalleryIndex {
  version: number;
  plugins: GalleryPluginEntry[];
}

// -- Registry types (internal to usePlugins) --

export interface PluginSidebarItem {
  pluginId: string;
  id: string;
  label: string;
  icon: string;
}

export interface PluginMenuItem {
  pluginId: string;
  id: string;
  label: string;
  targets: PluginTargetKind[];
}

export interface PluginSettingsPanel {
  pluginId: string;
  id: string;
  label: string;
  icon?: string;
  order: number;
}

// -- Extension types --

export interface ExtensionUpdate {
  id: string;
  kind: "plugin" | "skin";
  name: string;
  currentVersion: string;
  latestVersion: string;
  changelog: string;
  downloadUrl: string;
  status: "available" | "requires_app_update";
  minAppVersion?: string;
}

export interface ExtensionItem {
  id: string;
  kind: "plugin" | "skin";
  name: string;
  author: string;
  version: string;
  description: string;
  status: "active" | "disabled" | "incompatible" | "error" | "not_installed";
  updateAvailable?: ExtensionUpdate;
  source: "builtin" | "user" | "gallery";
  icon?: string;
  contributes?: PluginManifestContributes;
  apiUsage?: PluginApiUsage[];
  homepage?: string;
  minAppVersion?: string;
  skinColors?: [string, string, string, string];
  skinType?: "dark" | "light";
  isActiveSkin?: boolean;
  updateUrl?: string;
}

export type ExtensionFilter = "all" | "plugins" | "skins" | "installed" | "updates" | "gallery";
