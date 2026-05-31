import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { store } from "../store";
import type { Track, QueueTrack, Collection } from "../types";
import type {
  InstalledPlugin,
  PluginManifest,
  PluginState,
  PluginSidebarItem,
  PluginMenuItem,
  PluginSettingsPanel,
  PluginViewData,
  PluginContextMenuTarget,
  PluginBadge,
  ViboplrPluginAPI,
  PluginEventName,
  PluginTrack,
  GalleryPluginEntry,
  PluginGalleryIndex,
  ImageFetchResult,
  DownloadResolveByUriHandler,
  DownloadResolveByMetadataHandler,
  DownloadResolveResult,
  InteractiveSearchHandler,
  InteractiveResolveHandler,
  InteractiveSearchResult,
  GetQualitiesHandler,
  DownloadQualityOption,
  HomeShelfDisplayKind,
  HomeShelfItem,
  HomeShelfResult,
} from "../types/plugin";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { withResolverLog } from "../utils/resolverLog";

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

export const DEFAULT_INFO_TYPE_PRIORITY: Record<string, Record<string, number>> = {
  lyrics: { lrclib: 100, genius: 200, "lyrics-ovh": 300, "google-lyrics": 400 },
  artist_bio: { lastfm: 100, genius: 200 },
  album_wiki: { lastfm: 100, genius: 200 },
};

// Internal priority for image providers (keyed by "pluginId:entity")
export const DEFAULT_IMAGE_PROVIDER_PRIORITY: Record<string, number> = {
  "tidal-browse:artist": 100,
  "deezer:artist": 200,
  "itunes:artist": 300,
  "audiodb:artist": 400,
  "musicbrainz:artist": 500,
  "google-image-search:artist": 900,
  "tidal-browse:album": 100,
  "itunes:album": 200,
  "deezer:album": 300,
  "musicbrainz:album": 500,
  "google-image-search:album": 900,
  "google-image-search:tag": 900,
};

// Internal priority for download providers (keyed by "pluginId:providerId")
export const DEFAULT_DOWNLOAD_PROVIDER_PRIORITY: Record<string, number> = {
  "tidal-browse:tidal-download": 100,
  "p2p-sharing:p2p-download": 200,
  "youtube:youtube-download": 300,
  "mock-download:mock-dl": 900,
};

// Simple semver comparison: returns true if current >= required
function semverSatisfies(current: string, required: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const c = parse(current);
  const r = parse(required);
  for (let i = 0; i < 3; i++) {
    const cv = c[i] ?? 0;
    const rv = r[i] ?? 0;
    if (cv > rv) return true;
    if (cv < rv) return false;
  }
  return true; // equal
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
  streamResolveHandlers: Map<string, (title: string, artistName: string | null, albumName: string | null, durationSecs: number | null) => Promise<{ url: string; label: string; sourceUrl?: string } | null>>;
  streamUriResolvers: Map<string, (id: string, quality?: string | null) => Promise<string | null>>;
  schedulerHandlers: Map<string, () => void>;
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
  playTracks: (tracks: PluginTrack[], startIndex?: number, context?: { name?: string; playlistName?: string; coverUrl?: string | null; source?: string | null; description?: string | null; metadata?: Record<string, string> | null }) => void;
  insertTrack: (track: PluginTrack, position: number) => void;
  insertTracks: (tracks: PluginTrack[], position: number) => void;
  getDownloadFormat: () => string;
}

export interface PluginHostCallbacks {
  navigateToPluginView: (pluginId: string, viewId: string) => void;
  requestAction: (pluginId: string, action: string, payload: Record<string, unknown>) => void;
  showNotification: (message: string) => void;
}

export function usePlugins(
  currentTrackRef: React.RefObject<QueueTrack | null>,
  playingRef: React.RefObject<boolean>,
  positionRef: React.RefObject<number>,
  playbackCallbacks?: PluginPlaybackCallbacks,
  hostCallbacks?: PluginHostCallbacks,
  debugMode?: boolean,
  devPluginPath?: string | null,
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
  const [galleryPlugins, setGalleryPlugins] = useState<GalleryPluginEntry[]>(
    [],
  );
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  // True once the initial plugin load has completed at least once. Lets consumers
  // (e.g. Home shelves) distinguish "no plugin shelves because none are loaded"
  // from "plugins haven't finished loading yet" — avoids pruning valid shelves
  // during the async load window.
  const [pluginsLoaded, setPluginsLoaded] = useState(false);

  const playbackCallbacksRef = useRef(playbackCallbacks);
  playbackCallbacksRef.current = playbackCallbacks;

  const hostCallbacksRef = useRef(hostCallbacks);
  hostCallbacksRef.current = hostCallbacks;

  const fetchUrlCallbackRef = useRef<((url: string) => void) | null>(null);
  const loadedPluginsRef = useRef<Map<string, LoadedPlugin>>(new Map());
  const eventHandlersRef = useRef<EventHandlers>({
    "track:started": [],
    "track:scrobbled": [],
    "track:liked": [],
    "track:added": [],
    "track:removed": [],
    "scan:complete": [],
  });
  const enabledPluginsRef = useRef<Set<string>>(new Set());
  const appVersionRef = useRef<string>("0.0.0");
  const viewDataRef = useRef<Map<string, PluginViewData>>(new Map());
  const viewScrollKeyRef = useRef<Map<string, string>>(new Map());
  const badgeMapRef = useRef<Map<string, PluginBadge>>(new Map());
  const [badgeMap, setBadgeMap] = useState<Map<string, PluginBadge>>(new Map());
  const homeShelfHandlersRef = useRef(new Map<string, (limit: number) => Promise<HomeShelfResult>>());
  // shelf key -> plugin-provided click handler that takes over card body-clicks
  const homeShelfClickHandlersRef = useRef(new Map<string, (item: HomeShelfItem) => void | Promise<void>>());
  const dynamicHomeShelvesRef = useRef(new Map<string, {
    pluginId: string;
    shelfId: string;
    title: string;
    displayKind: HomeShelfDisplayKind;
    limit: number;
    icon?: string;
  }>());
  const [dynamicShelvesVersion, setDynamicShelvesVersion] = useState(0);

  // Build the curated API for a specific plugin
  const buildAPI = useCallback(
    (pluginId: string, loaded: LoadedPlugin): ViboplrPluginAPI => {
      const trackUnsubscribe = (fn: () => void) => {
        loaded.unsubscribers.push(fn);
      };

      const subscribeEvent = (
        event: PluginEventName,
        handler: (...args: unknown[]) => void,
      ): (() => void) => {
        const entry = { pluginId, handler };
        eventHandlersRef.current[event].push(entry);
        const unsub = () => {
          const arr = eventHandlersRef.current[event];
          const idx = arr.indexOf(entry);
          if (idx !== -1) arr.splice(idx, 1);
        };
        trackUnsubscribe(unsub);
        return unsub;
      };

      return {
        appVersion: appVersionRef.current,
        log: (level: string, message: string, section?: string) => {
          invoke("write_frontend_log", { level, message, section: section ?? pluginId }).catch(() => {});
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
          async getArtists(opts) {
            const artists = await invoke<Array<{ id: number; name: string; track_count: number }>>("get_artists");
            const offset = opts?.offset ?? 0;
            const limit = opts?.limit;
            if (offset || limit) {
              return artists.slice(offset, limit ? offset + limit : undefined);
            }
            return artists;
          },
          async getAlbums(opts) {
            const albums = await invoke<Array<{ id: number; title: string; artist_name: string | null; year: number | null }>>(
              "get_albums",
              { artistId: opts?.artistId ?? null },
            );
            const offset = opts?.offset ?? 0;
            const limit = opts?.limit;
            if (offset || limit) {
              return albums.slice(offset, limit ? offset + limit : undefined);
            }
            return albums;
          },
          async getTags(opts) {
            const tags = await invoke<Array<{ id: number; name: string; track_count: number }>>("get_tags");
            const offset = opts?.offset ?? 0;
            const limit = opts?.limit;
            if (offset || limit) {
              return tags.slice(offset, limit ? offset + limit : undefined);
            }
            return tags;
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
          async recordHistoryPlaysBatch(plays) {
            const tuples = plays.map(p => [p.artist, p.track, p.playedAt] as [string, string, number]);
            const [imported, skipped] = await invoke<[number, number]>("plugin_record_history_plays_batch", { plays: tuples });
            return { imported, skipped };
          },
          async applyTags(trackId, tagNames) {
            return invoke<Array<{ id: number; name: string }>>("plugin_apply_tags", { trackId, tagNames });
          },
          async applyTagsBulk(assignments) {
            return invoke<number>("plugin_apply_tags_bulk", { assignments });
          },
          async bulkUpdateTracks(trackIds, fields) {
            return invoke<string[]>("bulk_update_tracks", {
              trackIds,
              fields: {
                artist_name: fields.artist_name ?? null,
                album_title: fields.album_title ?? null,
                year: fields.year ?? null,
                tag_names: fields.tag_names ?? null,
              },
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
        },

        playback: {
          getCurrentTrack: () => currentTrackRef.current,
          isPlaying: () => playingRef.current ?? false,
          getPosition: () => positionRef.current ?? 0,
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
          onTrackLiked: (handler) =>
            subscribeEvent(
              "track:liked",
              handler as (...args: unknown[]) => void,
            ),
          onStreamResolve(
            providerId: string,
            handler: (title: string, artistName: string | null, albumName: string | null, durationSecs: number | null) => Promise<{ url: string; label: string } | null>,
          ): () => void {
            loaded.streamResolveHandlers.set(providerId, handler);
            const unsub = () => {
              loaded.streamResolveHandlers.delete(providerId);
            };
            trackUnsubscribe(unsub);
            return unsub;
          },
          onResolveStreamByUri(
            scheme: string,
            handler: (id: string, quality?: string | null) => Promise<string | null>,
          ): () => void {
            loaded.streamUriResolvers.set(scheme, handler);
            const unsub = () => {
              loaded.streamUriResolvers.delete(scheme);
            };
            trackUnsubscribe(unsub);
            return unsub;
          },
        },

        contextMenu: {
          onAction: (actionId, handler) => {
            loaded.contextMenuHandlers.set(actionId, handler);
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
          showNotification: (message) => {
            hostCallbacksRef.current?.showNotification(message)
              ?? console.log(`[plugin:${pluginId}]`, message);
          },
          navigateToView: (viewId) => {
            hostCallbacksRef.current?.navigateToPluginView(pluginId, viewId);
          },
          requestAction: (action, payload) => {
            hostCallbacksRef.current?.requestAction(pluginId, action, payload);
          },
          onAction: (actionId, handler) => {
            loaded.uiActionHandlers.set(actionId, handler);
          },
          setBadge: (viewId: string, badge: PluginBadge) => {
            const key = `${pluginId}:${viewId}`;
            if (badge === null) {
              badgeMapRef.current.delete(key);
            } else {
              badgeMapRef.current.set(key, badge);
            }
            setBadgeMap(new Map(badgeMapRef.current));
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
          async cacheFile(subdir: string, filename: string, url: string): Promise<string> {
            return invoke<string>("plugin_cache_image", { pluginId, subdir, filename, url });
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
            async download(path: string[], url: string): Promise<string> {
              return invoke<string>("plugin_files_download", { pluginId, path, url });
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
            const resp = await invoke<{ status: number; body: string }>(
              "plugin_fetch",
              {
                url,
                method: init?.method ?? null,
                headers: init?.headers ?? null,
                body: init?.body ?? null,
                insecure: init?.insecure ?? null,
              },
            );
            const bodyText = resp.body;
            return {
              status: resp.status,
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

            // Clean up listeners when plugin deactivates
            for (const ul of unlisteners) trackUnsubscribe(ul);

            return {
              async eval(js: string) {
                await invoke("browse_window_eval", { label, js });
              },
              async close() {
                for (const ul of unlisteners) ul();
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

        informationTypes: {
          onFetch(
            infoTypeId: string,
            handler: (entity: InfoEntity) => Promise<InfoFetchResult>,
          ): () => void {
            loaded.infoFetchHandlers.set(infoTypeId, handler);
            const unsub = () => {
              loaded.infoFetchHandlers.delete(infoTypeId);
            };
            trackUnsubscribe(unsub);
            return unsub;
          },
        },

        home: {
          onFetchShelf(shelfId: string, handler: (limit: number) => Promise<HomeShelfResult>): () => void {
            const key = `${pluginId}:${shelfId}`;
            homeShelfHandlersRef.current.set(key, handler);
            const unsub = () => {
              if (homeShelfHandlersRef.current.get(key) === handler) {
                homeShelfHandlersRef.current.delete(key);
              }
            };
            trackUnsubscribe(unsub);
            return unsub;
          },
          registerShelf(descriptor: {
            id: string;
            title: string;
            displayKind: HomeShelfDisplayKind;
            limit?: number;
            icon?: string;
          }): () => void {
            const key = `${pluginId}:${descriptor.id}`;
            dynamicHomeShelvesRef.current.set(key, {
              pluginId,
              shelfId: descriptor.id,
              title: descriptor.title,
              displayKind: descriptor.displayKind,
              limit: descriptor.limit ?? 20,
              icon: descriptor.icon,
            });
            setDynamicShelvesVersion((v) => v + 1);
            const unsub = () => {
              if (dynamicHomeShelvesRef.current.delete(key)) {
                setDynamicShelvesVersion((v) => v + 1);
              }
            };
            trackUnsubscribe(unsub);
            return unsub;
          },
          unregisterShelf(shelfId: string): void {
            const key = `${pluginId}:${shelfId}`;
            if (dynamicHomeShelvesRef.current.delete(key)) {
              setDynamicShelvesVersion((v) => v + 1);
            }
          },
          onItemClick(shelfId: string, handler: (item: HomeShelfItem) => void | Promise<void>): () => void {
            const key = `${pluginId}:${shelfId}`;
            homeShelfClickHandlersRef.current.set(key, handler);
            const unsub = () => {
              if (homeShelfClickHandlersRef.current.get(key) === handler) {
                homeShelfClickHandlersRef.current.delete(key);
              }
            };
            trackUnsubscribe(unsub);
            return unsub;
          },
        },

        imageProviders: {
          onFetch(
            entity: "artist" | "album",
            handler: (name: string, artistName?: string) => Promise<ImageFetchResult>,
          ): () => void {
            loaded.imageFetchHandlers.set(entity, handler);
            const unsub = () => {
              loaded.imageFetchHandlers.delete(entity);
            };
            trackUnsubscribe(unsub);
            return unsub;
          },
        },

        downloads: {
          async getDownloadFormat() {
            return playbackCallbacksRef.current?.getDownloadFormat() ?? "flac";
          },
          async enqueue(request) {
            return invoke<number>("enqueue_download", {
              title: request.title,
              artistName: request.artistName ?? null,
              albumTitle: request.albumTitle ?? null,
              uri: request.uri ?? null,
              durationSecs: request.durationSecs ?? null,
              destCollectionId: request.destCollectionId ?? null,
              destCollectionPath: request.destCollectionPath ?? null,
              format: request.format ?? null,
              provider: request.provider ?? null,
            });
          },
          onResolveByUri(providerId: string, handler: DownloadResolveByUriHandler): () => void {
            loaded.downloadResolveByUriHandlers.set(providerId, handler);
            const unsub = () => { loaded.downloadResolveByUriHandlers.delete(providerId); };
            trackUnsubscribe(unsub);
            return unsub;
          },
          onResolveByMetadata(providerId: string, handler: DownloadResolveByMetadataHandler): () => void {
            loaded.downloadResolveByMetadataHandlers.set(providerId, handler);
            const unsub = () => { loaded.downloadResolveByMetadataHandlers.delete(providerId); };
            trackUnsubscribe(unsub);
            return unsub;
          },
          onInteractiveSearch(providerId: string, handler: InteractiveSearchHandler): () => void {
            loaded.interactiveSearchHandlers.set(providerId, handler);
            const unsub = () => { loaded.interactiveSearchHandlers.delete(providerId); };
            trackUnsubscribe(unsub);
            return unsub;
          },
          onInteractiveResolve(providerId: string, handler: InteractiveResolveHandler): () => void {
            loaded.interactiveResolveHandlers.set(providerId, handler);
            const unsub = () => { loaded.interactiveResolveHandlers.delete(providerId); };
            trackUnsubscribe(unsub);
            return unsub;
          },
          onGetQualities(providerId: string, handler: GetQualitiesHandler): () => void {
            loaded.getQualitiesHandlers.set(providerId, handler);
            const unsub = () => { loaded.getQualitiesHandlers.delete(providerId); };
            trackUnsubscribe(unsub);
            return unsub;
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
          async exec(program: string, args?: string[], opts?: { cwd?: string }) {
            return invoke<{ exitCode: number; stdout: string; stderr: string }>("plugin_exec", {
              program,
              args: args ?? [],
              cwd: opts?.cwd ?? null,
            });
          },
        },

        env: {
          async get(key: string): Promise<string | null> {
            return invoke<string | null>("plugin_getenv", { key });
          },
        },
        p2p: {
          async start(relayMultiaddr?: string) {
            return invoke("p2p_start", { relayMultiaddr: relayMultiaddr ?? null });
          },
          async stop() {
            return invoke("p2p_stop", {});
          },
          async getStatus() {
            return invoke("p2p_get_status", {});
          },
          async searchPeer(peerId: string, multiaddr: string, query: string, limit?: number) {
            return invoke("p2p_search_peer", { peerId, multiaddr, query, limit: limit ?? 20 });
          },
          async streamFromPeer(peerId: string, multiaddr: string, trackId: string) {
            return invoke<string>("p2p_stream_from_peer", { peerId, multiaddr, trackId });
          },
          async downloadFromPeer(peerId: string, multiaddr: string, trackId: string, destCollectionId: number) {
            return invoke("p2p_download_from_peer", { peerId, multiaddr, trackId, destCollectionId });
          },
          async getSharedCollections() {
            return invoke<number[]>("p2p_get_shared_collections", {});
          },
          async setSharedCollections(ids: number[]) {
            return invoke("p2p_set_shared_collections", { collectionIds: ids });
          },
          async reserveRelay(multiaddr: string) {
            return invoke("p2p_reserve_relay", { multiaddr });
          },
          async getMultiaddrs() {
            return invoke<string[]>("p2p_get_multiaddrs", {});
          },
          async getDiagnostics() {
            return invoke("p2p_get_diagnostics", {});
          },
        },
      };
    },
    [currentTrackRef, playingRef, positionRef],
  );

  // Listen for scheduler due events from the Rust backend
  useEffect(() => {
    const unlisten = listen<{ pluginId: string; taskId: string }>(
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
    return () => { unlisten.then(fn => fn()); };
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
    loaded.schedulerHandlers.clear();

    // Clear view data for this plugin
    for (const key of viewDataRef.current.keys()) {
      if (key.startsWith(`${pluginId}:`)) {
        viewDataRef.current.delete(key);
      }
    }
    setViewData(new Map(viewDataRef.current));

    // Clear badges for this plugin
    for (const key of badgeMapRef.current.keys()) {
      if (key.startsWith(`${pluginId}:`)) {
        badgeMapRef.current.delete(key);
      }
    }
    setBadgeMap(new Map(badgeMapRef.current));

    // Clear home shelf handlers for this plugin
    for (const key of Array.from(homeShelfHandlersRef.current.keys())) {
      if (key.startsWith(`${pluginId}:`)) {
        homeShelfHandlersRef.current.delete(key);
      }
    }
    // Clear home shelf item-click handlers for this plugin
    for (const key of Array.from(homeShelfClickHandlersRef.current.keys())) {
      if (key.startsWith(`${pluginId}:`)) {
        homeShelfClickHandlersRef.current.delete(key);
      }
    }
    // Clear dynamically registered home shelves for this plugin
    let dynamicShelvesChanged = false;
    for (const key of Array.from(dynamicHomeShelvesRef.current.keys())) {
      if (key.startsWith(`${pluginId}:`)) {
        dynamicHomeShelvesRef.current.delete(key);
        dynamicShelvesChanged = true;
      }
    }
    if (dynamicShelvesChanged) {
      setDynamicShelvesVersion((v) => v + 1);
    }

    loadedPluginsRef.current.delete(pluginId);
  }, []);

  // Load and activate a single plugin
  const activatePlugin = useCallback(
    async (installed: InstalledPlugin): Promise<PluginState> => {
      const { id, manifest, builtin, dev, devPath } = installed;

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
        streamResolveHandlers: new Map(),
        streamUriResolvers: new Map(),
        schedulerHandlers: new Map(),
      };

      try {
        // Prefer code bundled with the manifest listing (saves an IPC round-trip).
        const code =
          installed.code ??
          (await invoke<string>("plugin_read_file", {
            pluginId: id,
            path: "index.js",
          }));

        const api = buildAPI(id, loaded);
        const pluginSandbox = Object.create(null);
        pluginSandbox.setTimeout = window.setTimeout.bind(window);
        pluginSandbox.clearTimeout = window.clearTimeout.bind(window);
        pluginSandbox.setInterval = window.setInterval.bind(window);
        pluginSandbox.clearInterval = window.clearInterval.bind(window);
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

        const factory = new Function("api", "window", "globalThis", "self", "document", code);
        const pluginExports = factory(api, pluginSandbox, pluginSandbox, pluginSandbox, undefined);

        if (pluginExports && typeof pluginExports.activate === "function") {
          await pluginExports.activate(api);
        }
        if (pluginExports && typeof pluginExports.deactivate === "function") {
          loaded.deactivate = pluginExports.deactivate;
        }

        loadedPluginsRef.current.set(id, loaded);

        return { id, manifest, status: "active", enabled: true, builtin, dev, devPath };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error(`[plugin:${id}] activation error:`, error);
        return { id, manifest, status: "error", error, enabled: true, builtin, dev, devPath };
      }
    },
    [buildAPI],
  );

  // Load all plugins
  const loadPlugins = useCallback(async () => {
    try {
      // Deactivate all previously loaded plugins to prevent handler accumulation
      for (const id of loadedPluginsRef.current.keys()) {
        deactivatePlugin(id);
      }

      const installed = await invoke<InstalledPlugin[]>("plugin_list_installed", {
        devPluginDir: debugMode ? (devPluginPath || null) : null,
      });
      const appVersion = await getVersion().catch(() => "0.0.0");
      appVersionRef.current = appVersion;
      const enabled =
        (await store.get<string[]>("enabledPlugins")) ?? null;
      const enabledSet =
        enabled !== null
          ? new Set(enabled)
          : new Set<string>();

      // Auto-enable all built-in plugins on first launch only
      // (when no enabledPlugins key exists in the store yet).
      // Plugins with autoEnable: false in their manifest are skipped.
      // Once the user has a saved list, respect their choices.
      if (enabled === null) {
        for (const plugin of installed) {
          if (plugin.builtin && plugin.manifest.autoEnable !== false) {
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
      const allInfoTypes: Array<[string, string, string, string, string, number, number, number, string]> = [];
      const allImageProviders: [string, string, number][] = []; // [plugin_id, entity, priority]

      // First pass: classify plugins synchronously and collect the ones that
      // need to actually activate. Plugins whose status is decided by manifest
      // alone (error/disabled/incompatible) get their state pushed eagerly.
      const toActivate: InstalledPlugin[] = [];
      for (const plugin of installed) {
        const m = plugin.manifest;

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

        if (m.debugOnly && !debugMode) {
          continue;
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
      for (const plugin of toActivate) {
        const state = await activatePlugin(plugin);
        states.push(state);

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
              const order = DEFAULT_INFO_TYPE_ORDER[it.id] ?? 500;
              const priority = DEFAULT_INFO_TYPE_PRIORITY[it.id]?.[plugin.id] ?? 500;
              allInfoTypes.push([it.id, it.name, it.entity, it.displayKind, plugin.id, it.ttl, order, priority, it.description ?? ""]);
            }
          }
          if (contrib.imageProviders) {
            for (const ip of contrib.imageProviders) {
              const imgPriority = DEFAULT_IMAGE_PROVIDER_PRIORITY[`${plugin.id}:${ip.entity}`] ?? 999;
              allImageProviders.push([plugin.id, ip.entity, imgPriority]);
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
        }
      }

      if (allInfoTypes.length > 0) {
        await invoke("info_sync_types", { types: allInfoTypes });

        // Track plugin info versions (no longer invalidates cache)
        const storedVersions = (await store.get<Record<string, string>>("pluginInfoVersions")) ?? {};
        const newVersions: Record<string, string> = { ...storedVersions };
        let versionsDirty = false;
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

      // Sort by plugin name for consistent display
      sidebar.sort((a, b) => a.label.localeCompare(b.label));
      menus.sort((a, b) => a.label.localeCompare(b.label));

      settings.sort((a, b) => a.order - b.order);

      setPluginStates(states);
      setSidebarItems(sidebar);
      setMenuItems(menus);
      setSettingsPanels(settings);
      setHomeShelves(shelves);
    } catch (e) {
      console.error("Failed to load plugins:", e);
    } finally {
      setPluginsLoaded(true);
    }
  }, [activatePlugin, deactivatePlugin, debugMode, devPluginPath]);

  // Initialize on mount, and reload when debugMode changes
  const initialLoadDone = useRef(false);
  useEffect(() => {
    loadPlugins();
    initialLoadDone.current = true;
    return () => {
      // Deactivate all on unmount
      for (const id of loadedPluginsRef.current.keys()) {
        deactivatePlugin(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload plugins when debugMode changes (after initial load)
  useEffect(() => {
    if (initialLoadDone.current) {
      loadPlugins();
    }
  }, [debugMode, devPluginPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Public methods --

  const dispatchEvent = useCallback(
    (event: PluginEventName, ...args: unknown[]) => {
      const handlers = eventHandlersRef.current[event];
      for (const { pluginId, handler } of handlers) {
        try {
          handler(...args);
        } catch (e) {
          console.error(`[plugin:${pluginId}] event ${event} error:`, e);
        }
      }
    },
    [],
  );

  const dispatchContextMenuAction = useCallback(
    (pluginId: string, actionId: string, target: PluginContextMenuTarget) => {
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) return;
      const handler = loaded.contextMenuHandlers.get(actionId);
      if (handler) {
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

  const dispatchUIAction = useCallback(
    (pluginId: string, actionId: string, data?: unknown) => {
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) return;
      const handler = loaded.uiActionHandlers.get(actionId);
      if (handler) {
        try {
          handler(data);
        } catch (e) {
          console.error(
            `[plugin:${pluginId}] UI action ${actionId} error:`,
            e,
          );
        }
      }
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

  const getViewScrollKey = useCallback(
    (pluginId: string, viewId: string): string | undefined => {
      return viewScrollKeyRef.current.get(`${pluginId}:${viewId}`);
    },
    [],
  );

  const fetchPluginGallery = useCallback(async () => {
    setGalleryLoading(true);
    setGalleryError(null);
    try {
      const json = await invoke<string>("fetch_plugin_gallery");
      const index: PluginGalleryIndex = JSON.parse(json);
      setGalleryPlugins(index.plugins || []);
    } catch (e) {
      setGalleryError(String(e));
    } finally {
      setGalleryLoading(false);
    }
  }, []);

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
        await invoke("delete_user_plugin", { pluginId });
        if (enabledPluginsRef.current.has(pluginId)) {
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
    [deactivatePlugin, loadPlugins],
  );

  const forwardDeepLink = useCallback((url: string) => {
    const pluginCount = loadedPluginsRef.current.size;
    let handlerCount = 0;
    for (const [, l] of loadedPluginsRef.current) handlerCount += l.deepLinkHandlers.length;
    console.log(`[forwardDeepLink] url=${url}, plugins=${pluginCount}, handlers=${handlerCount}`);
    for (const [, loaded] of loadedPluginsRef.current) {
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
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) return { status: "error" };
      const handler = loaded.infoFetchHandlers.get(infoTypeId);
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

  const invokeImageFetch = useCallback(
    async (pluginId: string, entity: "artist" | "album" | "tag", name: string, artistName?: string): Promise<ImageFetchResult> => {
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) return { status: "error", message: "plugin not loaded" };
      const handler = loaded.imageFetchHandlers.get(entity);
      if (!handler) return { status: "error", message: "no handler for entity" };
      try {
        return await handler(name, artistName);
      } catch (e) {
        console.error(`[plugin:${pluginId}] image fetch error for ${entity}:`, e);
        return { status: "error", message: e instanceof Error ? e.message : String(e) };
      }
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
    ): Promise<{ url: string; label: string; sourceUrl?: string } | null> => {
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
          () => handler(title, artistName, albumName, durationSecs));
      } catch {
        return null;
      }
    },
    [],
  );

  const invokeDownloadResolveByUri = useCallback(
    async (pluginId: string, providerId: string, uri: string, format: string): Promise<DownloadResolveResult | null> => {
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
      try {
        return await withResolverLog({ kind: "download:uri", provider, input },
          () => handler(uri, format));
      } catch {
        return null;
      }
    },
    [],
  );

  const invokeDownloadResolveByMetadata = useCallback(
    async (
      pluginId: string, providerId: string,
      title: string, artistName: string | null, albumName: string | null,
      durationSecs: number | null, format: string,
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
      try {
        return await withResolverLog({ kind: "download:metadata", provider, input },
          () => handler(title, artistName, albumName, durationSecs, format));
      } catch {
        return null;
      }
    },
    [],
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
    async (pluginId: string, providerId: string, matchId: string, format: string): Promise<DownloadResolveResult> => {
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
      return withResolverLog({ kind: "download:resolve", provider, input }, () => handler(matchId, format));
    },
    [],
  );

  const hasInteractiveDownload = useCallback(
    (pluginId: string, providerId: string): boolean => {
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) return false;
      return loaded.interactiveSearchHandlers.has(providerId) && loaded.interactiveResolveHandlers.has(providerId);
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

  const resolveStreamByUri = useCallback(
    async (scheme: string, id: string, quality?: string | null): Promise<string> => {
      for (const [, lp] of loadedPluginsRef.current) {
        const handler = lp.streamUriResolvers.get(scheme);
        if (handler) {
          const url = await handler(id, quality);
          if (url) return url;
        }
      }
      throw new Error(`No stream URI resolver for scheme: ${scheme}`);
    },
    [],
  );

  const invokeHomeShelf = useCallback(
    async (pluginId: string, shelfId: string, limit: number): Promise<HomeShelfResult> => {
      const handler = homeShelfHandlersRef.current.get(`${pluginId}:${shelfId}`);
      if (!handler) return { status: "error", message: "handler not registered" };
      return handler(limit);
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

  const pluginNames = useMemo(
    () => new Map(pluginStates.map((s) => [s.id, s.manifest.name])),
    [pluginStates],
  );

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

  return {
    pluginStates,
    pluginNames,
    sidebarItems,
    menuItems,
    settingsPanels,
    homeShelves: allHomeShelves,
    pluginsLoaded,
    viewData,
    getViewData,
    getViewScrollKey,
    badgeMap,
    dispatchEvent,
    dispatchContextMenuAction,
    dispatchUIAction,
    invokeHomeShelfItemClick,
    togglePlugin,
    reloadPlugin,
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
    invokeInteractiveSearch,
    invokeInteractiveResolve,
    hasInteractiveDownload,
    invokeGetQualities,
    resolveStreamByUri,
    invokeHomeShelf,
  };
}
