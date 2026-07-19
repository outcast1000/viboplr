import type {
  Track,
  QueueTrack,
  HistoryEntry,
  HistoryPlayLite,
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
}

export interface PluginManifestImageProvider {
  entity: string;
}

export interface PluginManifestStreamResolver {
  id: string;
  name: string;
}

export interface PluginManifestDownloadProvider {
  id: string;
  name: string;
}

export interface PluginManifestSettingsPanel {
  id: string;
  label: string;
  icon?: string;
  order?: number;
}

export type HomeShelfDisplayKind =
  | "album-cards"
  | "artist-cards"
  | "playlist-cards"
  | "track-rows";

export interface PluginManifestHomeShelf {
  id: string;
  title: string;
  displayKind: HomeShelfDisplayKind;
  limit?: number;
  icon?: string;
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
  homeShelves?: PluginManifestHomeShelf[];
}

export interface PluginApiUsage {
  api: string;
  reason: string;
}

export interface PluginBinaryDependency {
  name: string;
  required: boolean;
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
  binaryDependencies?: PluginBinaryDependency[];
  homepage?: string;
  autoEnable?: boolean;
  contributes?: PluginManifestContributes;
  updateUrl?: string;
  /** Plugin maturity ("experimental" | "stable"). Absent = stable; unrecognized
   *  values are treated as experimental-tier (fail-safe). See utils/pluginStability.ts. */
  stability?: string;
}

// -- Installed plugin from backend --

export interface InstalledPlugin {
  id: string;
  manifest: PluginManifest;
  builtin?: boolean;
  // True when loaded from the configured external "dev plugin folder" (overrides
  // the installed/built-in copy of the same id). Set by `plugin_list_installed`.
  dev?: boolean;
  devPath?: string;
  // Bundled by `plugin_list_installed` so activation skips a second IPC.
  // May be null if the file couldn't be read.
  code?: string | null;
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
  dev?: boolean;
  devPath?: string;
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
  isLocal?: boolean;
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
  // e.g. a playlist card carrying its tracks so that a download
  // plugin action can resolve them without round-tripping to the DB.
  tracks?: Array<{ title: string; artistName?: string | null; albumName?: string | null }>;
}

export interface StatItem {
  label: string;
  value: string | number;
}

// One bar in a `bar-chart`. `value` is raw; the renderer scales it against the
// chart's `max` (or the largest value if `max` is omitted). `color` should be a
// skin CSS variable (e.g. "var(--accent)") to stay skin-safe; omit for default.
export interface BarChartDatum {
  label: string;
  value: number;
  sublabel?: string;
  color?: string;
  // When `action` is set, the bar becomes clickable: clicking it fires
  // onAction(action, { id, label }). `id` is an opaque identifier the plugin
  // uses to resolve what was clicked (the human label may not be unique).
  id?: string;
  action?: string;
}

// One series in a `line-chart`. `points` are raw values plotted left→right.
export interface LineSeries {
  label?: string;
  points: number[];
  color?: string;
}

export interface TrackRowItem {
  id: string;
  title: string;
  subtitle?: string;
  album?: string;
  imageUrl?: string;
  duration?: string;
  action?: string;
  checked?: string[];
  // Playable / resolvable metadata (all optional). When present, the host can
  // resolve a row's artwork the same way the library/queue do (album→artist by
  // name) and act on it from the right-click menu / drag-to-queue without a DB
  // id. `path` is the scheme-prefixed URI (file://, subsonic://, …) used for
  // playback; artistName/albumTitle drive the name-based image lookup.
  artistName?: string | null;
  albumTitle?: string | null;
  path?: string | null;
  durationSecs?: number | null;
}

export type PluginViewData =
  | { type: "track-list"; tracks: Track[]; title?: string }
  | { type: "card-grid"; items: CardGridItem[]; columns?: number }
  | {
      type: "track-row-list";
      items: TrackRowItem[];
      selectable?: boolean;
      actions?: { id: string; label: string; icon?: string }[];
      categories?: string[];
      numbered?: boolean;
      showHeader?: boolean;
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
      submitOnly?: boolean;
      buttonLabel?: string;
    }
  | {
      type: "text-input";
      placeholder?: string;
      action: string;
      value?: string;
      multiline?: boolean;
      rows?: number;
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
      // Proportional bars for distributions / ranked counts. Horizontal by
      // default (label · fill · value); "vertical" renders column bars.
      type: "bar-chart";
      bars: BarChartDatum[];
      max?: number;
      orientation?: "horizontal" | "vertical";
      valueFormat?: "number" | "percent" | "duration";
    }
  | {
      // Grid of intensity cells (e.g. an hour-of-day × weekday "listening
      // clock"). `cells[rowIndex][colIndex]`; intensity = value / max.
      type: "heatmap";
      rows: string[];
      cols: string[];
      cells: number[][];
      max?: number;
      colLabelEvery?: number;
      valueSuffix?: string;
    }
  | {
      // Trend line(s) over an ordered x-axis (e.g. plays per month). `labels`
      // are the x-axis ticks; `area` fills under the line.
      type: "line-chart";
      series: LineSeries[];
      labels?: string[];
      max?: number;
      area?: boolean;
      valueFormat?: "number" | "percent" | "duration";
    }
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
      imageUrl?: string;              // foreground art only
      bgImages?: string[];            // 0-4 crossfade background images
      artShape?: "square" | "circle"; // defaults to "square"
      actions?: { id: string; label: string; icon?: string }[];
      backAction?: string;
      playAction?: string;
      enqueueAction?: string;         // wires the native Enqueue button
      contextMenuActions?: { id: string; label: string; separator?: boolean }[];
    };

// -- Plugin API (what plugins receive) --

export interface PluginLibraryAPI {
  getTrackCount(): Promise<number>;
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
  // Total recorded plays — drives a determinate progress bar for chunked reads.
  getHistoryPlayCount(): Promise<number>;
  // One keyset-paginated page of raw plays (no album resolution; cheap). Pass the
  // previous page's last row as { beforeTs, beforeId } to advance; omit for page 1.
  getHistoryPlaysPage(opts?: {
    beforeTs?: number | null;
    beforeId?: number | null;
    limit?: number;
  }): Promise<HistoryPlayLite[]>;
  getMostPlayed(opts?: {
    limit?: number;
    days?: number;
  }): Promise<HistoryMostPlayed[]>;
  getMostPlayedArtists(opts?: {
    limit?: number;
    days?: number;
  }): Promise<
    Array<{
      history_artist_id: number;
      play_count: number;
      track_count: number;
      display_name: string;
      rank: number;
    }>
  >;
  recordHistoryPlaysBatch(plays: { artist: string; track: string; playedAt: number }[]): Promise<{ imported: number; skipped: number }>;
  applyTags(trackId: number, tagNames: string[]): Promise<Array<{ id: number; name: string }>>;
  applyTagsBulk(assignments: Array<[number, string[]]>): Promise<number>;
  bulkUpdateTracks(trackIds: number[], fields: {
    artist_name?: string | null;
    album_title?: string | null;
    year?: number | null;
    tag_names?: string[] | null;
  }): Promise<string[]>;
  /**
   * Find duplicate tracks grouped by diacritic-normalized title + artist.
   * Optionally require copies to also match on duration and/or file size
   * within tolerance. Each returned group (length >= 2) is keeper-first:
   * `group[0]` is the highest-quality copy to keep.
   */
  findDuplicates(opts?: {
    matchDuration?: boolean;
    durationToleranceSecs?: number;
    matchSize?: boolean;
    sizeTolerancePct?: number;
    localOnly?: boolean;
  }): Promise<Track[][]>;
  onTrackAdded(handler: (track: { trackId: number; path: string; title: string; artistName: string | null; albumTitle: string | null; collectionId: number }) => void): () => void;
  onTrackRemoved(handler: (track: { trackId: number; path: string }) => void): () => void;
  onScanComplete(handler: (result: { collectionId: number; newTracks: number; removedTracks: number }) => void): () => void;
}

export interface PluginPlaybackAPI {
  getCurrentTrack(): QueueTrack | null;
  isPlaying(): boolean;
  getPosition(): number;
  playTrack(track: PluginTrack): void;
  playTracks(tracks: PluginTrack[], startIndex?: number, context?: { name?: string; playlistName?: string; coverUrl?: string | null; source?: string | null; description?: string | null; metadata?: Record<string, string> | null }): void;
  insertTrack(track: PluginTrack, position: number): void;
  insertTracks(tracks: PluginTrack[], position: number): void;
  // These receive the currently-playing track, which is a metadata-only
  // QueueTrack (no DB ids) — NOT a library Track. Plugins must act on metadata
  // (title/artist_name/album_title/duration_secs); id/album_id/artist_id are
  // absent at runtime. Resolve a library row on demand via find_track_by_metadata.
  onTrackStarted(handler: (track: QueueTrack) => void): () => void;
  onTrackScrobbled(handler: (track: QueueTrack) => void): () => void;
  onTrackLiked(handler: (track: QueueTrack, liked: boolean) => void): () => void;
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

/**
 * A context-menu item registered at runtime via api.contextMenu.registerItem.
 * Unlike the static manifest items, these can be added/removed while the plugin
 * runs (mirrors api.home.registerShelf). When `submenuLabel` is set, the host
 * groups all items sharing that label (per target kind) into one native submenu.
 */
export interface PluginDynamicMenuItem {
  id: string; // action id — dispatch routes to the handler registered via onAction
  label: string; // text only (native menu items have no icon)
  targets: PluginTargetKind[];
  submenuLabel?: string;
  order?: number;
}

export interface PluginContextMenuAPI {
  onAction(
    actionId: string,
    handler: (target: PluginContextMenuTarget) => void,
  ): void;
  /** Register a context-menu item at runtime. Returns an unsubscriber. */
  registerItem(item: PluginDynamicMenuItem): () => void;
  /** Remove a runtime-registered context-menu item by id. */
  unregisterItem(itemId: string): void;
}

export type PluginBadgeVariant = "accent" | "error" | "success" | "warning" | "muted";

export type PluginBadge =
  | null
  | { type: "dot"; variant: PluginBadgeVariant; tooltip?: string }
  | { type: "count"; value: number; variant: PluginBadgeVariant };

export interface PluginUIAPI {
  setViewData(viewId: string, data: PluginViewData, opts?: { scrollKey?: string }): void;
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
  list(path: string[]): Promise<{ name: string; isDir: boolean; size?: number; modifiedAt?: number }[]>;
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

/** One match from `searchValues` across cached `information_values`. */
export interface InfoValueMatch {
  typeId: string;
  pluginId: string;
  entity: import("./informationTypes").InfoEntityKind;
  displayKind: string;
  entityKey: string;
  /** The stored value, parsed from JSON (raw string if it wasn't valid JSON). */
  value: unknown;
  status: string;
  fetchedAt: number;
  /** Short excerpt of the matched text (the `jsonPath` field, or whole value). */
  snippet: string;
  /** Resolved library track — only for `entity: "track"` matches when
   *  `resolveTracks` was requested; null when the track isn't in the library. */
  track: Track | null;
}

/** A single cached information value read back for an entity. */
export interface InfoValueRead {
  typeId: string;
  /** The stored value, parsed from JSON (raw string if it wasn't valid JSON). */
  value: unknown;
  status: string;
  fetchedAt: number;
}

export interface PluginInformationTypesAPI {
  onFetch(
    infoTypeId: string,
    handler: (entity: import("./informationTypes").InfoEntity) => Promise<import("./informationTypes").InfoFetchResult>,
  ): () => void;
  /**
   * Substring-search the values cached in `information_values` across any info
   * type (lyrics, bios, reviews, similar lists, …). Matching is case/diacritic-
   * insensitive. All filters are optional and AND-combined:
   * - `typeId` / `displayKind` / `entity` narrow by info type.
   * - `jsonPath` scopes matching + snippet to one JSON field (e.g. "$.text" for
   *   lyrics, "$.summary" for bios); omit to search the whole stored value.
   * - `resolveTracks` populates `match.track` for track-entity matches.
   */
  searchValues(query: string, opts?: {
    typeId?: string;
    displayKind?: string;
    entity?: import("./informationTypes").InfoEntityKind;
    jsonPath?: string;
    resolveTracks?: boolean;
    limit?: number;
  }): Promise<InfoValueMatch[]>;
  /** All cached info values for an entity (across every info type). */
  getValuesForEntity(entity: import("./informationTypes").InfoEntity): Promise<InfoValueRead[]>;
  /** A single cached info value for an entity by info type, or null if absent. */
  getValue(typeId: string, entity: import("./informationTypes").InfoEntity): Promise<InfoValueRead | null>;
}

export type HomeShelfItem =
  | {
      // playlist-cards
      id: string;
      name: string;
      coverUrl?: string;
      subtitle?: string;
      tracks: PluginTrack[];
      sourcePluginId?: string;
    }
  | {
      // album-cards
      libraryId?: number;
      name: string;
      artistName?: string;
      coverUrl?: string;
      tracks?: PluginTrack[];
      // Per-item override for mixed album/artist shelves (e.g. builtin:jump-back-in).
      // When "artist", `libraryId` is an artist id and the card renders, navigates,
      // and plays as an artist. Absent or "album" = album (default, back-compatible).
      entityKind?: "album" | "artist";
    }
  | {
      // artist-cards
      libraryId?: number;
      name: string;
      imageUrl?: string;
    }
  | {
      // track-rows
      track: PluginTrack;
    };

export type HomeShelfResult =
  | { status: "ok"; items: HomeShelfItem[] }
  | { status: "empty" }
  | { status: "error"; message?: string };

export interface PluginHomeAPI {
  onFetchShelf(
    shelfId: string,
    handler: (limit: number) => Promise<HomeShelfResult>,
  ): () => void;
  registerShelf(descriptor: {
    id: string;
    title: string;
    displayKind: HomeShelfDisplayKind;
    limit?: number;
    icon?: string;
  }): () => void;
  unregisterShelf(shelfId: string): void;
  // Take over body-clicks on this shelf's cards. When a handler is registered,
  // the host calls it instead of its default action (e.g. play). Use it to
  // navigate into the plugin's own view for the clicked item. Returns an unsubscriber.
  onItemClick(
    shelfId: string,
    handler: (item: HomeShelfItem) => void | Promise<void>,
  ): () => void;
  // Resolve the tracks to play for a card whose `tracks` arrived empty (lazy).
  // The host awaits this (behind a loading modal) only when the card's play
  // action is kind:"tracks" with an empty list. Return the tracks to play (or
  // [] to play nothing).
  onResolvePlay(
    shelfId: string,
    handler: (item: HomeShelfItem) => Promise<PluginTrack[]>,
  ): () => void;
}

/** Result of resolving a Now Playing info item for the current track.
 *  `empty` hides the item for that track (no error indicator); `error` is
 *  logged and also hides it. See `useNowPlayingInfo`. */
export type NowPlayingInfoResult =
  | { status: "ok"; text: string }
  | { status: "empty" }
  | { status: "error"; message?: string };

export interface PluginNowPlayingInfoAPI {
  // Register an info item shown in the cycling now-playing section (mini player
  // + main bar). Lower `priority` sorts earlier among plugin items.
  // `defaultEnabled` (default false) decides whether the item is on before the
  // user customizes the selection. Mirrors api.home.registerShelf. Returns an
  // unsubscriber.
  registerItem(descriptor: {
    id: string;
    label: string;
    priority?: number;
    defaultEnabled?: boolean;
  }): () => void;
  unregisterItem(id: string): void;
  // Resolve the item's text for a given track. Has a fixed host-side timeout;
  // slow handlers are treated as `error` for that track.
  onFetch(
    id: string,
    handler: (track: PluginTrack) => Promise<NowPlayingInfoResult>,
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
  /** File extension to save as, overriding the requested format's default.
   *  Use "auto" to have the backend sniff the container from the downloaded
   *  bytes (e.g. an original file of unknown format). */
  ext?: string | null;
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

export interface DownloadQualityOption {
  value: string;
  label: string;
}

export type GetQualitiesHandler = () => DownloadQualityOption[];

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
  enqueue(request: DownloadRequest): Promise<number>;
  onResolveByUri(providerId: string, handler: DownloadResolveByUriHandler): () => void;
  onResolveByMetadata(providerId: string, handler: DownloadResolveByMetadataHandler): () => void;
  onInteractiveSearch(providerId: string, handler: InteractiveSearchHandler): () => void;
  onInteractiveResolve(providerId: string, handler: InteractiveResolveHandler): () => void;
  onGetQualities(providerId: string, handler: GetQualitiesHandler): () => void;
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
  }): Promise<number>;

  list(): Promise<Array<{
    id: number;
    name: string;
    source: string | null;
    savedAt: number;
    imagePath: string | null;
    trackCount: number;
    description: string | null;
    metadata: Record<string, unknown> | null;
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

/** Read-only view of a host-managed external binary (e.g. yt-dlp, ffmpeg). */
export interface PluginDependencyStatus {
  name: string;
  /** Whether the binary is currently available (managed copy or on PATH). */
  installed: boolean;
  /** Installed version string, or null if not installed / unknown. */
  version: string | null;
  /** Where the installed copy came from. */
  origin: "managed" | "system" | null;
  /** Latest released version from the host's TTL cache, or null if the host
   *  hasn't checked yet this run. Never triggers a fetch — the host owns when
   *  releases are checked; plugins must not check GitHub themselves. */
  latest: string | null;
}

export interface PluginSystemAPI {
  exec(program: string, args?: string[], opts?: { cwd?: string }): Promise<ExecResult>;
  /** Read the host's cached status for a registered dependency. Cache-only:
   *  never hits the network. `latest` is null until the host's background
   *  check populates it (~30s after startup, then daily, or via Settings). */
  getDependency(name: string): Promise<PluginDependencyStatus | null>;
}

export interface PluginEnvAPI {
  get(key: string): Promise<string | null>;
}

export interface P2pSharedCollectionInfo {
  id: number;
  name: string;
  track_count: number;
}

export interface P2pDiagnostics {
  peer_id: string;
  listen_addrs: string[];
  nat_status: string;
  can_relay: boolean;
  connected_peers: number;
  protocol_version: string;
  search_protocol: string;
  transfer_protocol: string;
  shared_collections: P2pSharedCollectionInfo[];
  uptime_secs: number;
  transfers_completed: number;
  bytes_sent: number;
  bytes_received: number;
  pending_dials: number;
  pending_searches: number;
  pending_transfers: number;
}

export interface PluginP2pAPI {
  start(relayMultiaddr?: string): Promise<unknown>;
  stop(): Promise<void>;
  getStatus(): Promise<unknown>;
  searchPeer(peerId: string, multiaddr: string, query: string, limit?: number): Promise<unknown>;
  streamFromPeer(peerId: string, multiaddr: string, trackId: string): Promise<string>;
  downloadFromPeer(peerId: string, multiaddr: string, trackId: string, destCollectionId: number): Promise<void>;
  getSharedCollections(): Promise<number[]>;
  setSharedCollections(ids: number[]): Promise<void>;
  reserveRelay(multiaddr: string): Promise<void>;
  getMultiaddrs(): Promise<string[]>;
  getDiagnostics(): Promise<P2pDiagnostics>;
}

export interface ViboplrPluginAPI {
  appVersion: string;
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
  p2p: PluginP2pAPI;
  home: PluginHomeAPI;
  nowPlayingInfo: PluginNowPlayingInfoAPI;
}

// -- Gallery types --

export interface GalleryPluginEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  /** Display-only version. The gallery index frequently omits this for
   *  externally-maintained plugins (the real version lives in each plugin's
   *  own update.json/manifest and is enforced at install), so treat as optional. */
  version?: string;
  minAppVersion?: string;
  updateUrl?: string;
  files?: string[];
  /** Marked as recommended in the gallery index. Optional; absent = false.
   *  Source of truth is the separate outcast1000/viboplr-plugins index.json. */
  recommended?: boolean;
  /** Onboarding profiles this plugin is pre-checked for ("normal" | "video" |
   *  "streaming" | "server"). Optional; when absent, `recommended: true` means
   *  pre-checked for every profile. Source of truth is the gallery index. */
  profiles?: string[];
  icon?: string;
  /** Plugin maturity ("experimental" | "stable"). Absent = stable; unrecognized
   *  values are treated as experimental-tier (fail-safe). Mirrors the manifest
   *  field for pre-install presentation. Source of truth is the gallery index. */
  stability?: string;
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
  /** When set, the host groups same-label items (per target) into one submenu. */
  submenuLabel?: string;
  order?: number;
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
  /** Undefined for not-installed gallery entries whose index omits a version
   *  (installed plugins always carry their manifest version). */
  version?: string;
  description: string;
  status: "active" | "disabled" | "incompatible" | "error" | "not_installed";
  updateAvailable?: ExtensionUpdate;
  source: "builtin" | "user" | "gallery" | "dev";
  // Absolute path to the dev plugin folder when source === "dev".
  devPath?: string;
  icon?: string;
  contributes?: PluginManifestContributes;
  apiUsage?: PluginApiUsage[];
  homepage?: string;
  minAppVersion?: string;
  skinColors?: [string, string, string, string];
  skinType?: "dark" | "light";
  isActiveSkin?: boolean;
  updateUrl?: string;
  /** Featured in the gallery index (plugins and skins). Drives the
   *  "Recommended" badge on not-installed gallery entries. */
  recommended?: boolean;
  /** Plugin maturity ("experimental" | "stable"). Installed plugins: manifest
   *  value, falling back to the gallery entry (dev source exempt). Gallery
   *  entries: the index value. Absent = stable. */
  stability?: string;
}

export type ExtensionFilter = "all" | "plugins" | "skins" | "installed" | "updates" | "gallery";
