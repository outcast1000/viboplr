import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { store } from "../store";
import type { Track, Collection } from "../types";
import type {
  InstalledPlugin,
  PluginManifest,
  PluginState,
  PluginSidebarItem,
  PluginMenuItem,
  PluginViewData,
  PluginContextMenuTarget,
  ViboplrPluginAPI,
  PluginEventName,
  TidalSearchTrackLike,
  GalleryPluginEntry,
  PluginGalleryIndex,
} from "../types/plugin";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";

const PLUGIN_GALLERY_BASE_URL =
  "https://raw.githubusercontent.com/outcast1000/viboplr-plugins/main/plugins/";

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
  oauthCallbackHandlers: Array<(queryString: string) => void>;
  infoFetchHandlers: Map<string, (entity: InfoEntity) => Promise<InfoFetchResult>>;
}

type EventHandlers = {
  [K in PluginEventName]: Array<{
    pluginId: string;
    handler: (...args: unknown[]) => void;
  }>;
};

// -- Hook --

export interface PluginPlaybackCallbacks {
  playTidalTrack: (track: TidalSearchTrackLike) => void;
  enqueueTidalTrack: (track: TidalSearchTrackLike) => void;
  playTidalTracks: (tracks: TidalSearchTrackLike[], startIndex?: number) => void;
  getDownloadFormat: () => string;
}

export interface PluginHostCallbacks {
  navigateToPluginView: (pluginId: string, viewId: string) => void;
  requestAction: (pluginId: string, action: string, payload: Record<string, unknown>) => void;
  showNotification: (message: string) => void;
}

export function usePlugins(
  currentTrackRef: React.RefObject<Track | null>,
  playingRef: React.RefObject<boolean>,
  positionRef: React.RefObject<number>,
  playbackCallbacks?: PluginPlaybackCallbacks,
  hostCallbacks?: PluginHostCallbacks,
) {
  const [pluginStates, setPluginStates] = useState<PluginState[]>([]);
  const [sidebarItems, setSidebarItems] = useState<PluginSidebarItem[]>([]);
  const [menuItems, setMenuItems] = useState<PluginMenuItem[]>([]);
  const [viewData, setViewData] = useState<Map<string, PluginViewData>>(
    new Map(),
  );
  const [galleryPlugins, setGalleryPlugins] = useState<GalleryPluginEntry[]>(
    [],
  );
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState<string | null>(null);

  const playbackCallbacksRef = useRef(playbackCallbacks);
  playbackCallbacksRef.current = playbackCallbacks;

  const hostCallbacksRef = useRef(hostCallbacks);
  hostCallbacksRef.current = hostCallbacks;

  const loadedPluginsRef = useRef<Map<string, LoadedPlugin>>(new Map());
  const eventHandlersRef = useRef<EventHandlers>({
    "track:started": [],
    "track:played": [],
    "track:scrobbled": [],
    "track:liked": [],
  });
  const enabledPluginsRef = useRef<Set<string>>(new Set());
  const viewDataRef = useRef<Map<string, PluginViewData>>(new Map());

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
        library: {
          async getTracks(opts) {
            return invoke<Track[]>("get_tracks", {
              opts: {
                artistId: opts?.artistId ?? null,
                albumId: opts?.albumId ?? null,
                tagId: opts?.tagId ?? null,
                limit: opts?.limit ?? 100,
                offset: 0,
              },
            });
          },
          async getArtists() {
            return invoke("get_artists");
          },
          async getAlbums() {
            return invoke("get_albums", { artistId: null });
          },
          async getTrackById(id: number) {
            return invoke<Track | null>("get_track_by_id", { trackId: id }).catch(() => null);
          },
          async search(query: string) {
            return invoke<Track[]>("get_tracks", {
              opts: { query, limit: 50, offset: 0 },
            });
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
        },

        playback: {
          getCurrentTrack: () => currentTrackRef.current,
          isPlaying: () => playingRef.current ?? false,
          getPosition: () => positionRef.current ?? 0,
          playTidalTrack: (track) => {
            playbackCallbacksRef.current?.playTidalTrack(track);
          },
          enqueueTidalTrack: (track) => {
            playbackCallbacksRef.current?.enqueueTidalTrack(track);
          },
          playTidalTracks: (tracks, startIndex) => {
            playbackCallbacksRef.current?.playTidalTracks(tracks, startIndex);
          },
          onTrackStarted: (handler) =>
            subscribeEvent(
              "track:started",
              handler as (...args: unknown[]) => void,
            ),
          onTrackPlayed: (handler) =>
            subscribeEvent(
              "track:played",
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
        },

        contextMenu: {
          onAction: (actionId, handler) => {
            loaded.contextMenuHandlers.set(actionId, handler);
          },
        },

        ui: {
          setViewData: (viewId, data) => {
            const key = `${pluginId}:${viewId}`;
            viewDataRef.current.set(key, data);
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
        },

        network: {
          async fetch(url, init) {
            const resp = await invoke<{ status: number; body: string }>(
              "plugin_fetch",
              {
                url,
                method: init?.method ?? null,
                headers: init?.headers ?? null,
                body: init?.body ?? null,
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
          onOAuthCallback(handler: (queryString: string) => void) {
            loaded.oauthCallbackHandlers.push(handler);
            return () => {
              const idx = loaded.oauthCallbackHandlers.indexOf(handler);
              if (idx >= 0) loaded.oauthCallbackHandlers.splice(idx, 1);
            };
          },
          async startOAuthListener(): Promise<number> {
            return invoke<number>("oauth_listen");
          },
        },

        tidal: {
          async search(query, limit, offset) {
            return invoke("tidal_search", {
              query,
              limit: limit ?? 20,
              offset: offset ?? 0,
            });
          },
          async getAlbum(albumId) {
            return invoke("tidal_get_album", { albumId });
          },
          async getArtist(artistId) {
            return invoke("tidal_get_artist", { artistId });
          },
          async getArtistAlbums(artistId) {
            return invoke("tidal_get_artist_albums", { artistId });
          },
          async getStreamUrl(trackId, quality) {
            return invoke("tidal_get_stream_url", {
              trackId,
              quality: quality ?? null,
            });
          },
          async downloadTrack(trackId, opts) {
            await invoke("tidal_save_track", {
              trackId,
              collectionId: opts?.collectionId ?? null,
              format: opts?.format ?? null,
            });
          },
          async downloadAlbum(albumId, opts) {
            await invoke("download_album", {
              albumId,
              collectionId: opts?.collectionId ?? null,
              format: opts?.format ?? null,
            });
          },
          async checkStatus() {
            return invoke("tidal_check_status");
          },
        },

        collections: {
          async getLocalCollections() {
            const all = await invoke<Collection[]>("get_collections");
            return all
              .filter((c) => c.kind === "local")
              .map((c) => ({ id: c.id, name: c.name, path: c.path }));
          },
          async getDownloadFormat() {
            return playbackCallbacksRef.current?.getDownloadFormat() ?? "flac";
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
          async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
            return invoke<T>(command, args ?? {});
          },
        },
      };
    },
    [currentTrackRef, playingRef, positionRef],
  );

  // Listen for OAuth callback events from the Rust backend
  useEffect(() => {
    const unlisten = listen<string>("oauth-callback", (event) => {
      for (const [, loaded] of loadedPluginsRef.current) {
        for (const handler of loaded.oauthCallbackHandlers) {
          try {
            handler(event.payload);
          } catch (e) {
            console.error(`[plugin:${loaded.id}] oauth callback error:`, e);
          }
        }
      }
    });
    return () => { unlisten.then(f => f()); };
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
      } catch {}
    }

    // Clear handlers
    loaded.contextMenuHandlers.clear();
    loaded.uiActionHandlers.clear();

    // Clear view data for this plugin
    for (const key of viewDataRef.current.keys()) {
      if (key.startsWith(`${pluginId}:`)) {
        viewDataRef.current.delete(key);
      }
    }
    setViewData(new Map(viewDataRef.current));

    loadedPluginsRef.current.delete(pluginId);
  }, []);

  // Load and activate a single plugin
  const activatePlugin = useCallback(
    async (installed: InstalledPlugin): Promise<PluginState> => {
      const { id, manifest, builtin } = installed;

      const loaded: LoadedPlugin = {
        id,
        manifest,
        unsubscribers: [],
        contextMenuHandlers: new Map(),
        uiActionHandlers: new Map(),
        deepLinkHandlers: [],
        oauthCallbackHandlers: [],
        infoFetchHandlers: new Map(),
      };

      try {
        const code = await invoke<string>("plugin_read_file", {
          pluginId: id,
          path: "index.js",
        });

        const api = buildAPI(id, loaded);
        const factory = new Function("api", code);
        const pluginExports = factory(api);

        if (pluginExports && typeof pluginExports.activate === "function") {
          await pluginExports.activate(api);
        }
        if (pluginExports && typeof pluginExports.deactivate === "function") {
          loaded.deactivate = pluginExports.deactivate;
        }

        loadedPluginsRef.current.set(id, loaded);

        return { id, manifest, status: "active", enabled: true, builtin };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error(`[plugin:${id}] activation error:`, error);
        return { id, manifest, status: "error", error, enabled: true, builtin };
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

      const installed =
        await invoke<InstalledPlugin[]>("plugin_list_installed");
      const appVersion = await getVersion().catch(() => "0.0.0");
      const enabled =
        (await store.get<string[]>("enabledPlugins")) ?? null;
      // If no enabled list in store, all plugins are disabled by default
      const enabledSet =
        enabled !== null
          ? new Set(enabled)
          : new Set<string>();
      enabledPluginsRef.current = enabledSet;

      const states: PluginState[] = [];
      const sidebar: PluginSidebarItem[] = [];
      const menus: PluginMenuItem[] = [];
      const allInfoTypes: Array<[string, string, string, string, string, number, number, number]> = [];

      for (const plugin of installed) {
        const m = plugin.manifest;

        // Validate required manifest fields
        if (!m.name || !m.version) {
          states.push({
            id: plugin.id,
            manifest: m,
            status: "error",
            error: "Invalid manifest: missing name or version",
            enabled: false,
            builtin: plugin.builtin,
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
          });
          continue;
        }

        // Check minAppVersion compatibility
        if (m.minAppVersion && !semverSatisfies(appVersion, m.minAppVersion)) {
          states.push({
            id: plugin.id,
            manifest: m,
            status: "incompatible",
            error: `Requires app version ${m.minAppVersion} (current: ${appVersion})`,
            enabled: true,
            builtin: plugin.builtin,
          });
          continue;
        }

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
              allInfoTypes.push([it.id, it.name, it.entity, it.displayKind, plugin.id, it.ttl, it.order, it.priority]);
            }
          }
        }
      }

      if (allInfoTypes.length > 0) {
        await invoke("info_rebuild_types", { types: allInfoTypes });
      }

      // Sort by plugin name for consistent display
      sidebar.sort((a, b) => a.label.localeCompare(b.label));
      menus.sort((a, b) => a.label.localeCompare(b.label));

      setPluginStates(states);
      setSidebarItems(sidebar);
      setMenuItems(menus);
    } catch (e) {
      console.error("Failed to load plugins:", e);
    }
  }, [activatePlugin, deactivatePlugin]);

  // Initialize on mount
  useEffect(() => {
    loadPlugins();
    return () => {
      // Deactivate all on unmount
      for (const id of loadedPluginsRef.current.keys()) {
        deactivatePlugin(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      try {
        await invoke<string>("install_gallery_plugin", {
          pluginId: entry.id,
          baseUrl: PLUGIN_GALLERY_BASE_URL,
          files: entry.files,
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
    async (pluginId: string) => {
      try {
        // Remove from enabled set if present
        if (enabledPluginsRef.current.has(pluginId)) {
          enabledPluginsRef.current.delete(pluginId);
          deactivatePlugin(pluginId);
          await store.set(
            "enabledPlugins",
            Array.from(enabledPluginsRef.current),
          );
        }
        await invoke("delete_user_plugin", { pluginId });
        await loadPlugins();
      } catch (e) {
        console.error("Failed to delete plugin:", e);
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
    async (pluginId: string, infoTypeId: string, entity: InfoEntity): Promise<InfoFetchResult> => {
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) return { status: "error" };
      const handler = loaded.infoFetchHandlers.get(infoTypeId);
      if (!handler) return { status: "error" };
      return handler(entity);
    },
    [],
  );

  return {
    pluginStates,
    sidebarItems,
    menuItems,
    viewData,
    getViewData,
    dispatchEvent,
    dispatchContextMenuAction,
    dispatchUIAction,
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
  };
}
