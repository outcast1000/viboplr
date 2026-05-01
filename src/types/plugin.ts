import type {
  Track,
  HistoryEntry,
  HistoryMostPlayed,
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
  | "track:scrobbled"
  | "track:liked"
  | "track:added"
  | "track:removed"
  | "scan:complete";

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

export interface PluginManifestStreamResolver {
  id: string;
  name: string;
  priority: number;
}

export interface PluginManifestDownloadProvider {
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
  streamResolvers?: PluginManifestStreamResolver[];
  downloadProviders?: PluginManifestDownloadProvider[];
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
  debugOnly?: boolean;
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
  | { type: "button"; label: string; action: string; variant?: "accent" | "secondary"; disabled?: boolean; style?: Record<string, string>; data?: unknown; className?: string }
  | {
      type: "layout";
      direction: "vertical" | "horizontal";
      children: PluginViewData[];
      className?: string;
    }
  | { type: "spacer" }
  | {
      type: "search-input";
      placeholder?: string;
      action: string;
      value?: string;
    }
  | {
      type: "text-input";
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
  | {
      type: "toolbar";
      title?: string;
      buttons: { label: string; action: string; variant?: "accent" | "secondary"; disabled?: boolean; data?: unknown; icon?: string }[];
      status?: string;
      statusVariant?: "default" | "error" | "success";
    }
  | { type: "settings-row"; label: string; description?: string; control?: PluginViewData; child?: PluginViewData }
  | { type: "section"; title: string; children: PluginViewData[] }
  | {
      type: "confirm";
      title?: string;
      message: string;
      confirmLabel?: string;
      cancelLabel?: string;
      confirmVariant?: "accent" | "secondary" | "danger";
      confirmAction: string;
      cancelAction: string;
      data?: unknown;
    }
  | {
      type: "detail-header";
      title: string;
      subtitle?: string;
      meta?: string;
      imageUrl?: string;
      actions?: { id: string; label: string; icon?: string }[];
      backAction?: string;
      playAction?: string;
      contextMenuActions?: { id: string; label: string; separator?: boolean }[];
    };

// -- Plugin API (what plugins receive) --

export interface PluginLibraryAPI {
  getTracks(opts?: {
    artistId?: number;
    albumId?: number;
    tagId?: number;
    limit?: number;
    offset?: number;
  }): Promise<Track[]>;
  ftsTracks(query: string, opts?: {
    limit?: number;
    offset?: number;
  }): Promise<Track[]>;
  ftsArtists(query: string, opts?: {
    limit?: number;
    offset?: number;
  }): Promise<Array<{ id: number; name: string; track_count: number }>>;
  ftsAlbums(query: string, opts?: {
    limit?: number;
    offset?: number;
  }): Promise<Array<{ id: number; title: string; artist_name: string | null; year: number | null }>>;
  ftsTags(query: string, opts?: {
    limit?: number;
    offset?: number;
  }): Promise<Array<{ id: number; name: string; track_count: number }>>;
  getArtists(opts?: {
    limit?: number;
    offset?: number;
  }): Promise<
    Array<{ id: number; name: string; track_count: number }>
  >;
  getAlbums(opts?: {
    artistId?: number;
    limit?: number;
    offset?: number;
  }): Promise<
    Array<{
      id: number;
      title: string;
      artist_name: string | null;
      year: number | null;
    }>
  >;
  getTags(opts?: {
    limit?: number;
    offset?: number;
  }): Promise<
    Array<{ id: number; name: string; track_count: number }>
  >;
  getTrackById(id: number): Promise<Track | null>;
  getArtistById(id: number): Promise<{ id: number; name: string; track_count: number } | null>;
  getAlbumById(id: number): Promise<{ id: number; title: string; artist_name: string | null; year: number | null } | null>;
  getTagById(id: number): Promise<{ id: number; name: string; track_count: number } | null>;
  getHistory(opts?: { limit?: number }): Promise<HistoryEntry[]>;
  getMostPlayed(opts?: {
    limit?: number;
    days?: number;
  }): Promise<HistoryMostPlayed[]>;
  recordHistoryPlaysBatch(plays: { artist: string; track: string; playedAt: number }[]): Promise<{ imported: number; skipped: number }>;
  applyTags(trackId: number, tagNames: string[]): Promise<Array<{ id: number; name: string }>>;
  onTrackAdded(handler: (track: { trackId: number; path: string; title: string; artistName: string | null; albumTitle: string | null; collectionId: number }) => void): () => void;
  onTrackRemoved(handler: (track: { trackId: number; path: string }) => void): () => void;
  onScanComplete(handler: (result: { collectionId: number; newTracks: number; removedTracks: number }) => void): () => void;
}

export interface PluginPlaybackAPI {
  getCurrentTrack(): Track | null;
  isPlaying(): boolean;
  getPosition(): number;
  playTrack(track: PluginTrack): void;
  playTracks(tracks: PluginTrack[], startIndex?: number, context?: { name: string; coverUrl?: string | null; source?: string | null; metadata?: Record<string, string> | null }): void;
  insertTrack(track: PluginTrack, position: number): void;
  insertTracks(tracks: PluginTrack[], position: number): void;
  onTrackStarted(handler: (track: Track) => void): () => void;
  onTrackScrobbled(handler: (track: Track) => void): () => void;
  onTrackLiked(handler: (track: Track, liked: boolean) => void): () => void;
  onStreamResolve(
    providerId: string,
    handler: (title: string, artistName: string | null, albumName: string | null, durationSecs: number | null) => Promise<{ url: string; label: string } | null>,
  ): () => void;
  onResolveStreamByUri(
    scheme: string,
    handler: (id: string, quality?: string | null) => Promise<string | null>,
  ): () => void;
}

export interface PluginTrack {
  path?: string | null;
  title: string;
  artist_name?: string | null;
  album_title?: string | null;
  duration_secs?: number | null;
  track_number?: number | null;
  image_url?: string | null;
}

export interface PluginCollectionsAPI {
  getLocalCollections(): Promise<Array<{ id: number; name: string; path: string | null }>>;
}

export interface PluginContextMenuAPI {
  onAction(
    actionId: string,
    handler: (target: PluginContextMenuTarget) => void,
  ): void;
}

export type PluginBadge =
  | null
  | { type: "dot"; variant: "accent" | "error" }
  | { type: "count"; value: number; variant: "accent" | "error" };

export interface PluginUIAPI {
  setViewData(viewId: string, data: PluginViewData): void;
  showNotification(message: string): void;
  onAction(actionId: string, handler: (data: unknown) => void): void;
  navigateToView(viewId: string): void;
  requestAction(action: string, payload: Record<string, unknown>): void;
  setBadge(viewId: string, badge: PluginBadge): void;
}

export interface PluginStorageAPI {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  cacheFile(subdir: string, filename: string, url: string): Promise<string>;
  getCachePath(subdir: string, filename: string): Promise<string | null>;
  listCacheDirs(): Promise<string[]>;
  deleteCacheDir(subdir: string): Promise<void>;
  files: PluginFileAPI;
}

export interface PluginFileAPI {
  writeJson(path: string[], data: unknown): Promise<string>;
  readJson<T>(path: string[]): Promise<T | null>;
  writeText(path: string[], content: string): Promise<string>;
  readText(path: string[]): Promise<string | null>;
  download(path: string[], url: string): Promise<string>;
  getPath(path: string[]): Promise<string | null>;
  exists(path: string[]): Promise<boolean>;
  list(path: string[]): Promise<{ name: string; isDir: boolean }[]>;
  remove(path: string[]): Promise<void>;
  copy(src: string[], dst: string[]): Promise<void>;
  move(src: string[], dst: string[]): Promise<void>;
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
      insecure?: boolean;
    },
  ): Promise<{
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
  openUrl(url: string): Promise<void>;
  onDeepLink(handler: (url: string) => void): () => void;
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

export interface DownloadResolveResult {
  url: string;
  headers?: Record<string, string> | null;
  metadata?: {
    title?: string;
    artist?: string;
    album?: string;
    trackNumber?: number;
    year?: number;
    genre?: string;
    coverUrl?: string;
  } | null;
}

export type DownloadResolveByUriHandler = (
  uri: string,
  format: string,
) => Promise<DownloadResolveResult | null>;

export type DownloadResolveByMetadataHandler = (
  title: string,
  artistName: string | null,
  albumName: string | null,
  durationSecs: number | null,
  format: string,
) => Promise<DownloadResolveResult | null>;

export interface InteractiveSearchResult {
  id: string;
  title: string;
  artistName?: string | null;
  albumTitle?: string | null;
  coverUrl?: string | null;
  durationSecs?: number | null;
  trackNumber?: number | null;
}

export type InteractiveSearchHandler = (
  query: string,
  limit: number,
) => Promise<InteractiveSearchResult[]>;

export type InteractiveResolveHandler = (
  matchId: string,
  format: string,
) => Promise<DownloadResolveResult>;

export interface DownloadRequest {
  title: string;
  artistName?: string | null;
  albumTitle?: string | null;
  uri?: string | null;
  durationSecs?: number | null;
  destCollectionId?: number | null;
  destCollectionPath?: string | null;
  format?: string | null;
  provider?: string | null;
}

export interface PluginDownloadsAPI {
  getDownloadFormat(): Promise<string>;
  enqueue(request: DownloadRequest): Promise<number>;
  onResolveByUri(providerId: string, handler: DownloadResolveByUriHandler): () => void;
  onResolveByMetadata(providerId: string, handler: DownloadResolveByMetadataHandler): () => void;
  onInteractiveSearch(providerId: string, handler: InteractiveSearchHandler): () => void;
  onInteractiveResolve(providerId: string, handler: InteractiveResolveHandler): () => void;
}

export interface DownloadProvider {
  id: string;
  name: string;
  source: string;
  resolveByUri: (
    uri: string,
    format: string,
  ) => Promise<DownloadResolveResult | null>;
  resolveByMetadata: (
    title: string,
    artistName: string | null,
    albumName: string | null,
    durationSecs: number | null,
    format: string,
  ) => Promise<DownloadResolveResult | null>;
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

export interface PluginSchedulerAPI {
  register(taskId: string, intervalMs: number): Promise<void>;
  unregister(taskId: string): Promise<void>;
  complete(taskId: string): Promise<boolean>;
  onDue(taskId: string, handler: () => void): () => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PluginSystemAPI {
  exec(program: string, args?: string[], opts?: { cwd?: string }): Promise<ExecResult>;
}

export interface PluginEnvAPI {
  get(key: string): Promise<string | null>;
}

export interface ViboplrPluginAPI {
  log(level: string, message: string, section?: string): void;
  library: PluginLibraryAPI;
  playback: PluginPlaybackAPI;
  contextMenu: PluginContextMenuAPI;
  ui: PluginUIAPI;
  storage: PluginStorageAPI;
  network: PluginNetworkAPI;
  collections: PluginCollectionsAPI;
  playlists: PluginPlaylistsAPI;
  informationTypes: PluginInformationTypesAPI;
  imageProviders: PluginImageProvidersAPI;
  downloads: PluginDownloadsAPI;
  scheduler: PluginSchedulerAPI;
  system: PluginSystemAPI;
  env: PluginEnvAPI;
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
