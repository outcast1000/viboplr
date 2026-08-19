import type {
  Track,
  QueueTrack,
  HistoryEntry,
  HistoryPlayLite,
  HistoryMostPlayed,
} from "../types";
// One definition, shared by the plugin API and the host's own renderer/cache — a
// plugin-supplied storyboard and a locally generated one are the same shape.
import type { Storyboard } from "../utils/storyboard";
import type {
  PluginVisualizerAPI,
  PluginVisualizerDescriptor,
} from "./pluginVisualizer";

export type { Storyboard };
export type * from "./pluginVisualizer";

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
  // Queue contents or current index moved. Coalesced — read the new state back
  // via `api.playback.getQueue()`; the event carries no payload.
  | "queue:changed"
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

/**
 * A catalog the global search (Cmd+K) can query on demand. The host never runs
 * these while the user types — see `PluginSearchAPI` for why — so a provider is
 * free to be slow.
 */
export interface PluginManifestSearchProvider {
  id: string;
  /** Shown in the dropdown, both on the offer row and as the results header. */
  name: string;
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
  searchProviders?: PluginManifestSearchProvider[];
  /** Rich visuals that fill host-owned slots. See types/pluginVisualizer.ts. */
  visualizers?: PluginVisualizerDescriptor[];
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
  // Which of the list level `actions` this row shows, by id. Absent = all of
  // them. Order always follows the declared list, so shared buttons stay in the
  // same slot down the column. For rows whose applicable actions differ — a
  // file already queued wants "Skip" where a skipped one wants "Download", and
  // offering both on both is one dead button per row.
  actions?: string[];
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
      // Plain click opens the row (fires its `action`) instead of selecting it.
      // For lists of *containers* — torrents, folders — where clicking a thing
      // you can go into should go into it, and a click that only highlighted
      // the row reads as nothing having happened. Modifier-clicks still select,
      // so the toolbar's multi-selection stays reachable. Requires `selectable`.
      openOnClick?: boolean;
      // Extra buttons in the toolbar's All / None group that select a named
      // subset of rows ("Audio", "Video"). A preset SELECTS rows; the list's
      // `actions` are what act on a selection. Only the plugin can know which
      // rows are "audio", so it carries its own ids and the host applies them
      // (intersected with what is on screen — see `presetIds`). Requires
      // `selectable`.
      selectionPresets?: { id: string; label: string; ids: string[] }[];
      // How many rows can be selected at once. `"multi"` (the default) is the
      // library-style listbox with the All / None selection toolbar above it.
      // `"single"` drops that toolbar entirely and lets one row be current at a
      // time — for a list whose actions are per-row (each row's hover buttons)
      // rather than per-selection, where a bulk toolbar is a control with
      // nothing to act on. `selectionPresets` are ignored in single mode, since
      // a preset's whole job is selecting several rows. Requires `selectable`.
      selectionMode?: "single" | "multi";
      actions?: { id: string; label: string; icon?: string }[];
      categories?: string[];
      numbered?: boolean;
      showHeader?: boolean;
      // Right-click a row for the universal track menu (Play / Enqueue / Play
      // Next + plugin actions). Default `true`. Set `false` for a list whose
      // rows are not tracks — a torrent's *contents*, where most rows are cover
      // art and .nfo files and every real action is already a row button, so the
      // menu offers Play/Enqueue on things that cannot be played. Drag-to-queue
      // is unaffected; it is gated on the row's own `path`.
      contextMenu?: boolean;
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
      // Renders a "Paste" button next to the submit button: clicking it fills
      // the input with the clipboard text and submits it as the action's query.
      pasteButton?: boolean;
      // Session text memory. One live input often serves several logical search
      // boxes multiplexed through the same node position (e.g. per-source
      // tabs); the input keeps one text per stateKey, stashing the outgoing
      // key's text on a key change and restoring the incoming key's (falling
      // back to `value`). Omit for a single-box view.
      stateKey?: string;
    }
  | {
      type: "text-input";
      placeholder?: string;
      action: string;
      value?: string;
      multiline?: boolean;
      rows?: number;
      // Mask the input (a service password / API secret in a settings panel).
      // Wins over `multiline`, which can't be masked.
      password?: boolean;
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
      // Title + Back only — no artwork, background, motion look or FX picker.
      // For a subject with no image of its own (a torrent), where the hero
      // would otherwise wrap a placeholder disc in a 320px scrimmed panel.
      plain?: boolean;
      // The hero's own action buttons, replacing the fixed Play / Enqueue pair
      // for a subject those verbs don't fit (a torrent is started and stopped).
      // They then sit where every other detail page puts its primary controls,
      // rather than in a separate bar underneath.
      buttons?: { id: string; label: string; variant?: "primary" | "secondary" | "danger"; disabled?: boolean }[];
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
  /**
   * Read persisted track like states from the durable, ID-less `entity_likes`
   * store (so it works for tracks not in the library too). The result is
   * parallel to the input: `1` = liked, `-1` = disliked, `0` = neither. Use it
   * to skip already-applied entries before {@link setTrackLikesBatch}.
   */
  getTrackLikeStates(tracks: { title: string; artistName?: string | null }[]): Promise<number[]>;
  /**
   * Persist a batch of track likes/dislikes (e.g. importing Last.fm loved
   * tracks). Funnelled through the host's newer-wins merge with existing state,
   * so re-running is safe. `liked` defaults to `1` (a like); `updatedAt` (unix
   * seconds) sets the merge timestamp — pass the source's own "loved" time when
   * you have it so it wins/loses correctly against local edits. Returns the
   * number of rows actually applied.
   */
  setTrackLikesBatch(tracks: { title: string; artistName?: string | null; liked?: number; updatedAt?: number }[]): Promise<number>;
  onTrackAdded(handler: (track: { trackId: number; path: string; title: string; artistName: string | null; albumTitle: string | null; collectionId: number }) => void): () => void;
  onTrackRemoved(handler: (track: { trackId: number; path: string }) => void): () => void;
  onScanComplete(handler: (result: { collectionId: number; newTracks: number; removedTracks: number }) => void): () => void;
}

/** A plugin-supplied play context — becomes the queue panel's banner. */
export interface PluginPlayContext {
  name?: string;
  playlistName?: string;
  coverUrl?: string | null;
  source?: string | null;
  description?: string | null;
  metadata?: Record<string, string> | null;
}

export interface PluginPlaybackAPI {
  getCurrentTrack(): QueueTrack | null;
  isPlaying(): boolean;
  getPosition(): number;
  /** The whole play queue, in order, plus the index of the playing entry.
   *  Metadata-only `QueueTrack`s, same as `getCurrentTrack`. Guard with a
   *  `typeof` check — older hosts don't have it. */
  getQueue(): { tracks: QueueTrack[]; index: number };
  /** Fires whenever the queue's contents or current index change (enqueue,
   *  reorder, remove, clear, track advance). Returns an unsubscriber.
   *  This is a coalesced notification, not a per-frame one: read the new state
   *  with `getQueue()` when it fires. */
  onQueueChanged(handler: () => void): () => void;
  playTrack(track: PluginTrack): void;
  playTracks(tracks: PluginTrack[], startIndex?: number, context?: PluginPlayContext): void;
  insertTrack(track: PluginTrack, position: number): void;
  insertTracks(tracks: PluginTrack[], position: number): void;
  /** Start playing the track(s) you already know NOW, and hand the rest over
   *  when your slow work finishes — instead of making the user wait for the
   *  whole list. Use it when a play's opening track is known up front but the
   *  remainder costs seconds to produce (a scrape, a paged catalog): e.g. a
   *  "song radio" whose station always opens with the seed the user picked.
   *
   *  `head` plays immediately (a metadata-only track is fine — the host's
   *  stream-resolver chain resolves it on play). `resolveTail` returns the full
   *  list, head included or not; the host strips a leading run it has already
   *  started. On failure or an empty result the head keeps playing and
   *  `tailErrorMessage` is shown as a toast.
   *
   *  Prefer this over `playTracks` + `insertTracks`: the host discards the tail
   *  if the user replaced or cleared the queue while you were resolving, which a
   *  hand-rolled insert cannot detect. Guard with a `typeof` check — older hosts
   *  don't have it.
   *
   *  Resolves with **how many tracks were actually appended** — 0 when the tail
   *  failed, came back empty, was entirely the head, or was discarded because
   *  the user had moved on. Report success from this number rather than from
   *  your own resolved list, or you'll announce a station that never landed. */
  playWithBackfill(opts: {
    head: PluginTrack[];
    context?: PluginPlayContext;
    resolveTail: () => Promise<PluginTrack[]> | PluginTrack[];
    tailErrorMessage?: string;
  }): Promise<number>;
  // These receive the currently-playing track, which is a metadata-only
  // QueueTrack (no DB ids) — NOT a library Track. Plugins must act on metadata
  // (title/artist_name/album_title/duration_secs); id/album_id/artist_id are
  // absent at runtime. Resolve a library row on demand via find_track_by_metadata.
  onTrackStarted(handler: (track: QueueTrack) => void): () => void;
  onTrackScrobbled(handler: (track: QueueTrack) => void): () => void;
  onTrackLiked(handler: (track: QueueTrack, liked: boolean) => void): () => void;
  onStreamResolve(
    providerId: string,
    handler: (
      title: string,
      artistName: string | null,
      albumName: string | null,
      durationSecs: number | null,
      /** Advisory hints from the host. `preferVideo`: the user asked to watch
       *  video when possible — a resolver that can should return a video stream
       *  and set `video: true` on its result (the host then plays it in the
       *  theater). Ignore it to keep returning audio.
       *  `externalAudio`: the host can merge a separate audio track (native mpv
       *  engine), so a source whose hi-res streams are split should answer with
       *  `candidates` rather than a single muxed URL — see `StreamResolveResult`.
       *  `fresh`: the last answer for this track did not play — don't serve it
       *  again from a cache of your own.
       *  Optional for back-compat. */
      opts?: { preferVideo?: boolean; externalAudio?: boolean; fresh?: boolean },
    ) => Promise<StreamResolveResult | null>,
  ): () => void;
  onResolveStreamByUri(
    scheme: string,
    /** Return a bare URL for a single self-contained stream, or a candidate
     *  list when the source offers multiple streams (e.g. YouTube's split
     *  video-only + audio-only formats) and the host should pick per its active
     *  engine — see `StreamCandidate` / `opts.externalAudio`. `null` = no match.
     *
     *  Alongside `candidates` you may report `sourceUrl` — the page the stream
     *  came from, the same field `onStreamResolve` returns. Do: a track played
     *  from its own plugin scheme is otherwise attributed by its *URI*, and an
     *  opaque or encoded one (`ytdlp://https%3A%2F%2F…`) is unreadable in the
     *  source panel and offers the user no way out to the original page. */
    handler: (
      id: string,
      quality?: string | null,
      /** `externalAudio`: the host can merge a separate audio track (native mpv
       *  engine + video). When set, a resolver with split streams should return
       *  a candidate list so the host can pick a hi-res video-only stream plus a
       *  companion audio stream; otherwise return a self-contained (muxed) URL.
       *  `fresh`: the answer you gave for this id last time did not play, so do
       *  not serve it again from a cache of your own — mint a new one. (A signed
       *  CDN URL that has been refused usually stays refused.)
       *  Optional for back-compat — older hosts don't send them. */
      opts?: { externalAudio?: boolean; fresh?: boolean },
    ) => Promise<string | { candidates: StreamCandidate[]; sourceUrl?: string } | null>,
  ): () => void;
  /** Supply seek-preview thumbnails for a custom URL scheme. The host shows one
   *  tile in the seek bar's hover bubble.
   *
   *  Return the source's OWN published storyboard where one exists rather than
   *  extracting frames — YouTube, for instance, serves `sb0`-`sb3` sprite sheets
   *  (~58 KB for 200 thumbnails) that cost nothing to decode and don't re-stream
   *  the video. Cache the SHEET BYTES (e.g. via `api.storage.files.download`), not
   *  the URLs: signed media URLs typically expire within hours while the images
   *  themselves are permanent.
   *
   *  Called once per track, with a 10 s host-side timeout — discovery that needs a
   *  subprocess should ride whatever call already resolves the stream rather than
   *  spawning again. `null` = no storyboard (short clips often have none), which
   *  simply leaves the bubble as plain text. */
  onResolveStoryboard(
    scheme: string,
    handler: (id: string) => Promise<Storyboard | null>,
  ): () => void;
}

/** One playable stream a resolver offers for a source. The host picks among
 *  candidates per its active playback engine: the native mpv engine can merge a
 *  `video`-only stream with a separate `audio`-only stream (hi-res); the browser
 *  engine needs a self-contained `muxed` stream. Only the fields the host
 *  selects on are required — richer metadata (codecs/tbr) just refines the pick. */
export interface StreamCandidate {
  url: string;
  /** `muxed` = video+audio in one stream (browser-safe); `video`/`audio` = a
   *  single track that must be paired (mpv attaches the audio to the video). */
  kind: "muxed" | "video" | "audio";
  /** Pixel height for `video`/`muxed` streams (drives the resolution pick). */
  height?: number;
  /** Container, e.g. "mp4" | "webm" | "m4a" — the browser prefers mp4/m4a. */
  container?: string;
  vcodec?: string;
  acodec?: string;
  /** Total bitrate (kbps); tiebreaks equal-resolution/quality candidates. */
  tbr?: number;
  /** Request headers the source requires for this signed URL. The host passes
   *  these only to native playback; browser elements manage their own headers. */
  headers?: Record<string, string>;
  label?: string;
}

/** What a metadata stream resolver (`onStreamResolve`) hands back: a single
 *  playable URL plus how to play and attribute it. The by-URI resolver returns
 *  `StreamCandidate[]` instead, because a source addressed by id can enumerate
 *  its formats; a metadata resolver has already *chosen* one. */
export interface StreamResolveResult {
  url: string;
  /** Every stream this source offers, when the resolver can enumerate them —
   *  the same menu `onResolveStreamByUri` returns, for the metadata path. Answer
   *  `opts.externalAudio` with this: without it the only shape available here is
   *  a single self-contained stream, and on YouTube the only self-contained
   *  format is 360p, so a "watch this" resolved by metadata could never play at
   *  more than 360p however good the source was. The host runs its own
   *  `selectStream` over these; `url` stays the self-contained fallback for when
   *  no candidate suits the active engine. */
  candidates?: StreamCandidate[];
  /** Display name for the resolver-chain entry that won ("yt-dlp", "Library"). */
  label: string;
  /** True when `url` is a video stream — the host reclassifies the track and
   *  plays it in the theater. Set this only in answer to `opts.preferVideo`. */
  video?: boolean;
  /** The page/item the stream came from (e.g. the watch URL), for attribution
   *  and for download providers that resolve by the same source. */
  sourceUrl?: string;
  /** Request headers `url` requires. Signed CDN links are commonly bound to the
   *  User-Agent — and sometimes Referer/Origin — that minted them, so a bare GET
   *  gets a 403; yt-dlp reports them per-format as `http_headers`. Passed to
   *  **native playback only**, exactly like `StreamCandidate.headers`: a browser
   *  media element manages its own headers and cannot be told otherwise. Omit
   *  when the URL is fetchable with defaults. */
  headers?: Record<string, string>;
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
  /**
   * Rescan a collection — the plugin-side equivalent of the Resync button in
   * Collections. For a plugin that lands new files inside a local collection
   * (a completed download, an import), this is what makes them appear in the
   * library without waiting for the daily auto-update.
   *
   * Resolves as soon as the scan is *spawned*; the host ignores a second call
   * for a collection already scanning, so calling it after each batch is safe.
   * Listen on `api.library.onScanComplete` for the finish.
   */
  resync(collectionId: number): Promise<void>;
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
      /**
       * Abort the request after this many milliseconds. There is no default:
       * reqwest imposes none, so an unreachable host hangs the promise until
       * the OS gives up. Set one on anything that polls; leave it off for a
       * call that may legitimately run for minutes.
       */
      timeoutMs?: number;
    },
  ): Promise<{
    status: number;
    /**
     * Response headers, names lowercased. Repeated headers are joined with
     * ", " as `Headers.get()` does — for `Set-Cookie` use `getSetCookie()`,
     * whose values can't be split back out of that join.
     */
    headers: Record<string, string>;
    /** Every `Set-Cookie` value, in the order the server sent them. */
    getSetCookie(): string[];
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
      // `tracks` is only the known *start* of the list (e.g. a radio station's
      // seed, or the one track still cached from a previous fetch) — the rest
      // comes from this shelf's `onResolvePlay` handler. The host plays what's
      // here immediately and appends the resolved remainder behind the music,
      // instead of holding the user behind a loading modal for the whole
      // fetch. Only set it when the shipped tracks really do open the list:
      // the host trusts the order and appends after them.
      partial?: boolean;
      sourcePluginId?: string;
    }
  | {
      // album-cards
      libraryId?: number;
      name: string;
      artistName?: string;
      coverUrl?: string;
      tracks?: PluginTrack[];
      /** See `partial` on playlist-cards. Ignored when `libraryId` is set. */
      partial?: boolean;
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
  // Resolve the tracks to play for a card that shipped without its full list.
  // The host calls this when the card's play action is kind:"tracks" and either
  // the list is empty (it awaits behind a loading modal) or the card is marked
  // `partial` (it plays the shipped head first and appends the remainder — no
  // modal, no waiting). Return the full list either way; the host de-dupes a
  // head it has already started. Return [] to play nothing.
  onResolvePlay(
    shelfId: string,
    handler: (item: HomeShelfItem) => Promise<PluginTrack[]>,
  ): () => void;
}

/** Result of one global-search query against a plugin catalog. */
export type PluginSearchResult =
  | { status: "ok"; tracks: PluginTrack[] }
  | { status: "empty" }
  | { status: "error"; message?: string };

/**
 * Global search (Cmd+K) against a plugin's catalog.
 *
 * **The host never queries a provider while the user types.** Every known
 * provider costs real time — yt-dlp shells out to a binary, a scraper drives a
 * hidden browser window — so auto-firing on a debounce would spawn a process or
 * a window per keystroke. Instead the dropdown offers a row ("Search “x” on
 * yt-dlp") and only queries when the user picks it. Handlers may therefore take
 * seconds; they get a generous host-side timeout, not a 5s budget like home
 * shelves. Do not add speculative prefetching on the plugin side either.
 *
 * Providers are declared in `contributes.searchProviders` (known before
 * activation) and/or registered at runtime. Register at runtime when the
 * capability is conditional — yt-dlp can only search when its binary is
 * actually installed, and a provider that can't work should not be offered.
 */
export interface PluginSearchAPI {
  /** Handle a query for one provider. `limit` is a hint, not a contract — the
   *  host trims. Returning `empty` is a normal miss, not a failure. */
  onQuery(
    providerId: string,
    handler: (query: string, limit: number) => Promise<PluginSearchResult>,
  ): () => void;
  registerProvider(descriptor: { id: string; name: string; icon?: string }): () => void;
  unregisterProvider(providerId: string): void;
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
  /** Marks this option as producing a video file. The download modal defaults to
   *  the first `video: true` option when the track being downloaded is itself a
   *  video (e.g. downloading a video you're watching), instead of the first
   *  option. The user can still pick any other option. */
  video?: boolean;
  /** Longer note shown under the quality picker for the SELECTED option (e.g.
   *  what the format really is, re-encode caveats). Keep `label` short; put the
   *  explanation here. Older hosts ignore it. */
  description?: string;
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

/** A progress report from a provider that is doing real work inside a resolve
 *  (see `PluginDownloadsAPI.reportProgress`). Every field is optional — a
 *  provider that only knows "merging now" sends a `label` and no `percent`. */
export interface DownloadResolveProgress {
  /** 0-100. Omit (or null) when the work is indeterminate — the host then
   *  keeps the spinner rather than parking a bar at a made-up number. */
  percent?: number | null;
  /** Short phase description, e.g. "Downloading video" / "Merging audio". */
  label?: string | null;
  /** Human-readable transfer detail, e.g. "12.4MiB / 48.1MiB at 3.2MiB/s". */
  detail?: string | null;
  /** Seconds remaining, when the tool reports an ETA. */
  etaSecs?: number | null;
}

export interface PluginDownloadsAPI {
  enqueue(request: DownloadRequest): Promise<number>;
  /** Report progress for the resolve currently being awaited by the host.
   *  Only meaningful while one of this plugin's download-resolve handlers is
   *  running — outside that window it is a no-op, so it is always safe to call.
   *  Providers that download the file themselves (rather than handing back a
   *  URL) should call this: without it the host can only show a spinner for
   *  what may be several minutes of work. */
  reportProgress(progress: DownloadResolveProgress): void;
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
  /** `onProgress` is forwarded to the provider's `api.downloads.reportProgress`
   *  calls for the duration of this resolve (see `usePlugins` resolve scopes). */
  resolveByUri: (
    uri: string,
    format: string,
    onProgress?: (progress: DownloadResolveProgress) => void,
  ) => Promise<DownloadResolveResult | null>;
  resolveByMetadata: (
    title: string,
    artistName: string | null,
    albumName: string | null,
    durationSecs: number | null,
    format: string,
    onProgress?: (progress: DownloadResolveProgress) => void,
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
  /** Run a registry-allowed binary. `opts.onOutput` streams the child's output
   *  line by line as it is produced (split on `\n` **and** `\r`, so a CLI that
   *  redraws one progress line still reports) — pass it to drive a progress
   *  readout; the resolved `ExecResult` still carries the full text either way.
   *  An exec started inside a download resolve is killed when the user cancels
   *  that download, and the promise then rejects with "Cancelled". */
  exec(
    program: string,
    args?: string[],
    opts?: { cwd?: string; onOutput?: (line: string, stream: "stdout" | "stderr") => void },
  ): Promise<ExecResult>;
  /** Read the host's cached status for a registered dependency. Cache-only:
   *  never hits the network. `latest` is null until the host's background
   *  check populates it (~30s after startup, then daily, or via Settings). */
  getDependency(name: string): Promise<PluginDependencyStatus | null>;
  /** Read embedded tags for local files — one result per input path, in order,
   *  `null` for anything unreadable. Batch the whole set in one call: the host
   *  probes on a worker thread, and per-file calls are per-file IPC round trips.
   *  There is **no filename fallback** — a missing tag comes back as `null` so
   *  your own parse (which knows the folder/context the file came from) stands.
   *  Feature-detect it (`typeof api.system.readAudioTags === "function"`) rather
   *  than raising `minAppVersion`, so older hosts just keep your parsed values. */
  readAudioTags(paths: string[]): Promise<Array<PluginFileTags | null>>;
  /** Open a local file (or folder) with the application the OS associates with
   *  it — the "let me just look at this" action for something the app itself
   *  can't render: a `.nfo`, a PDF booklet, a folder of scans.
   *
   *  Use this rather than `api.network.openUrl("file://…")`: the opener plugin's
   *  JS scope allows only `http`/`https`/`mailto`/`tel`, so a `file://` URL from
   *  JS is *refused* — the button appeared to do nothing. `path` may be bare or
   *  `file://`-prefixed; a missing path rejects rather than failing silently.
   *  Feature-detect for older hosts. */
  openPath(path: string): Promise<void>;
  /** Reveal a local file in the OS file manager, selecting it in its folder
   *  (falling back to opening the containing folder on network shares, where the
   *  shell's select APIs reject UNC paths). Same host command the app's own
   *  "Show in folder" uses. Feature-detect for older hosts. */
  revealPath(path: string): Promise<void>;
}

/** Embedded tags for one file. Every field is optional; a missing one means the
 *  file didn't carry it. `duration_secs` is present even for an untagged file —
 *  a queue entry with no length shows no seek bar and never scrobbles. */
export interface PluginFileTags {
  title: string | null;
  artist: string | null;
  album_artist: string | null;
  album: string | null;
  track_number: number | null;
  disc_number: number | null;
  year: number | null;
  genre: string | null;
  duration_secs: number | null;
}

export interface PluginEnvAPI {
  get(key: string): Promise<string | null>;
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
  home: PluginHomeAPI;
  nowPlayingInfo: PluginNowPlayingInfoAPI;
  search: PluginSearchAPI;
  /** Rich visuals in host-owned slots. Plugins render host state; they do not
   *  own it. See types/pluginVisualizer.ts for the contract. */
  visualizers: PluginVisualizerAPI;
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

/** A registered global-search provider (manifest or runtime), host-side view. */
export interface PluginSearchProvider {
  pluginId: string;
  providerId: string;
  name: string;
  icon?: string;
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
