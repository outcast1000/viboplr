import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Track, QueueTrack } from "../types";
import type { DownloadProvider, DownloadResolveResult } from "../types/plugin";
import type { DownloadTrack } from "../components/DownloadModal";
import type { ContextMenuState } from "../types/contextMenu";
import { parseLibraryId, isRemoteScheme } from "../queueEntry";
import { withResolverLog } from "../utils/resolverLog";
import { usePlugins, DEFAULT_DOWNLOAD_PROVIDER_PRIORITY } from "./usePlugins";

export interface DownloadModalState {
  tracks: DownloadTrack[];
  providerId: string;
  providerName: string;
  confirmed?: boolean;
  resolveByUri?: (uri: string, format: string) => Promise<DownloadResolveResult | null>;
}

type ResolvedSource = { name: string; url: string; sourceUrl: string | null; id: string | null } | null;

/** Walk the plugin download-provider chain (by-uri first, then by-metadata) and
 * return the first successful resolution. Each provider call is bounded to 10s. */
async function resolveTrackDownload(
  providers: DownloadProvider[],
  uri: string | null,
  title: string,
  artistName: string | null,
  albumName: string | null,
  durationSecs: number | null,
  format: string,
  provider?: string | null,
): Promise<DownloadResolveResult | null> {
  const targetProviders = provider
    ? providers.filter(p => p.id === provider)
    : providers;

  if (uri) {
    for (const p of targetProviders) {
      try {
        const result = await Promise.race([
          p.resolveByUri(uri, format),
          new Promise<null>((r) => setTimeout(() => r(null), 10000)),
        ]);
        if (result) return result;
      } catch {
        continue;
      }
    }
  }

  for (const p of targetProviders) {
    try {
      const result = await Promise.race([
        p.resolveByMetadata(title, artistName, albumName, durationSecs, format),
        new Promise<null>((r) => setTimeout(() => r(null), 10000)),
      ]);
      if (result) return result;
    } catch {
      continue;
    }
  }

  return null;
}

interface UseDownloadOrchestrationDeps {
  plugins: Pick<
    ReturnType<typeof usePlugins>,
    "pluginStates" | "invokeDownloadResolveByUri" | "invokeDownloadResolveByMetadata" | "hasInteractiveDownload"
  >;
  /** The active context-menu target — drives `handleDownloadFromProvider`. */
  contextMenu: ContextMenuState | null;
  libraryTracks: Track[];
  queue: QueueTrack[];
  /** Last-resort fallback when no download provider is available (the metadata-aware
   * single-track download path in `useContextMenuActions`/`useDownloadActions`). */
  handleDownloadTrackFallback: (track: QueueTrack) => void;
}

/**
 * Download-orchestration engine, extracted out of App.tsx. Owns the ordered
 * plugin download-provider list, the backend `download-resolve-request` bridge,
 * provider priorities, the `downloadModal` state, and every download *trigger*
 * (context-menu provider pick, now-playing download) — collapsing the previously
 * duplicated provider-id parsing + priority-refetch into one place.
 */
export function useDownloadOrchestration({
  plugins,
  contextMenu,
  libraryTracks,
  queue,
  handleDownloadTrackFallback,
}: UseDownloadOrchestrationDeps) {
  const [downloadModal, setDownloadModal] = useState<DownloadModalState | null>(null);
  const [providerPriorities, setProviderPriorities] = useState<Map<string, number>>(new Map());

  // Build ordered download provider list from active plugins
  const downloadProviders = useMemo(() => {
    const providers: DownloadProvider[] = [];

    // Built-in subsonic provider
    providers.push({
      id: "__builtin:subsonic",
      name: "Subsonic",
      source: "__builtin",
      resolveByUri: (uri, format) =>
        withResolverLog(
          { kind: "download:uri", provider: "__builtin:subsonic", input: { uri, format } },
          async () => {
            if (!uri.startsWith("subsonic://")) return null;
            const rest = uri.substring(11);
            const lastSlash = rest.lastIndexOf("/");
            if (lastSlash < 0) throw new Error(`malformed subsonic uri (no '/'): ${uri}`);
            const collectionId = parseInt(rest.substring(0, lastSlash), 10);
            const trackId = rest.substring(lastSlash + 1);
            if (!trackId || isNaN(collectionId)) throw new Error(`malformed subsonic uri (bad id): ${uri}`);
            const target = await invoke<{ url: string; ext: string }>("resolve_subsonic_download_url", {
              collectionId, remoteTrackId: trackId, format,
            });
            return { url: target.url, headers: null, metadata: null, ext: target.ext };
          },
        ).catch(() => null),
      resolveByMetadata: () =>
        withResolverLog(
          { kind: "download:metadata", provider: "__builtin:subsonic", input: {} },
          async () => null,
        ),
    });

    // Plugin providers
    for (const ps of plugins.pluginStates) {
      if (ps.status !== "active") continue;
      const dps = ps.manifest.contributes?.downloadProviders;
      if (!dps) continue;
      for (const dp of dps) {
        providers.push({
          id: `${ps.id}:${dp.id}`,
          name: dp.name,
          source: ps.id,
          resolveByUri: (uri, format) =>
            plugins.invokeDownloadResolveByUri(ps.id, dp.id, uri, format),
          resolveByMetadata: (title, artistName, albumName, durationSecs, format) =>
            plugins.invokeDownloadResolveByMetadata(ps.id, dp.id, title, artistName, albumName, durationSecs, format),
        });
      }
    }

    return providers;
  }, [plugins.pluginStates, plugins.invokeDownloadResolveByUri, plugins.invokeDownloadResolveByMetadata]);

  const downloadProvidersRef = useRef<DownloadProvider[]>([]);
  downloadProvidersRef.current = downloadProviders;

  // Respond to backend download-resolve-request events by walking the plugin
  // download-provider chain. (Inlined from the former useDownloads hook.)
  useEffect(() => {
    const unlisten = listen<{
      id: number;
      title: string;
      artist_name: string | null;
      album_title: string | null;
      duration_secs: number | null;
      uri: string | null;
      format: string;
      provider: string | null;
    }>("download-resolve-request", async (event) => {
      const { id, title, artist_name, album_title, duration_secs, uri, format, provider } = event.payload;
      const result = await resolveTrackDownload(
        downloadProvidersRef.current,
        uri, title, artist_name, album_title, duration_secs, format, provider,
      );
      await invoke("download_resolve_response", { id, result: result ?? null });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const refreshProviderPriorities = useCallback(async () => {
    try {
      const rows = await invoke<[string, string, string, number][]>("get_active_download_providers");
      const map = new Map<string, number>();
      for (const [pluginId, providerId, , priority] of rows) {
        map.set(`${pluginId}:${providerId}`, priority);
      }
      setProviderPriorities(map);
    } catch (e) {
      console.error("Failed to load download provider priorities:", e);
    }
  }, []);

  const downloadProviderEntries = useMemo(() => {
    return downloadProviders
      .filter(p => p.source !== "__builtin")
      .map(p => {
        const parts = p.id.split(":");
        const pluginId = parts[0];
        const providerId = parts.slice(1).join(":");
        return {
          id: p.id,
          name: p.name,
          priority: providerPriorities.get(p.id) ?? Number.MAX_SAFE_INTEGER,
          interactive: plugins.hasInteractiveDownload(pluginId, providerId),
        };
      })
      .sort((a, b) => a.priority - b.priority);
  }, [downloadProviders, providerPriorities, plugins.hasInteractiveDownload]);

  // Sync download providers to DB for backend ordering
  useEffect(() => {
    const providerData: [string, string, string, number][] = [];
    for (const ps of plugins.pluginStates) {
      if (ps.status !== "active") continue;
      const dps = ps.manifest.contributes?.downloadProviders;
      if (!dps) continue;
      for (const dp of dps) {
        const dlPriority = DEFAULT_DOWNLOAD_PROVIDER_PRIORITY[`${ps.id}:${dp.id}`] ?? 999;
        providerData.push([ps.id, dp.id, dp.name, dlPriority]);
      }
    }
    if (providerData.length > 0) {
      invoke("sync_download_providers", { providers: providerData })
        .then(() => refreshProviderPriorities())
        .catch(console.error);
    } else {
      refreshProviderPriorities();
    }
  }, [plugins.pluginStates, refreshProviderPriorities]);

  const handleDownloadFromProvider = useCallback((providerId: string, interactive: boolean) => {
    if (!contextMenu) return;
    const target = contextMenu.target;

    // Collect tracks for batch downloads
    let batchTracks: QueueTrack[] | null = null;
    if (target.kind === "multi-track") {
      const idSet = new Set(target.trackIds);
      batchTracks = libraryTracks.filter(t => t.id != null && idSet.has(t.id));
    } else if (target.kind === "queue-multi" && target.indices.length > 1) {
      batchTracks = target.indices.map(i => queue[i]).filter(Boolean);
    }

    if (batchTracks && batchTracks.length > 0) {
      const providerEntry = downloadProviderEntries.find(e => e.id === providerId);
      setDownloadModal({
        tracks: batchTracks.map(t => ({
          title: t.title,
          artistName: t.artist_name ?? null,
          albumTitle: t.album_title ?? null,
          uri: t.path ?? null,
          durationSecs: t.duration_secs ?? null,
          trackId: parseLibraryId(t.key),
        })),
        providerId,
        providerName: providerEntry?.name ?? providerId,
        confirmed: !interactive,
      });
      return;
    }

    // Single track
    let trackId: number | null = null;
    let title = "";
    let artistName: string | null = null;

    if (target.kind === "track") {
      trackId = target.trackId ?? null;
      title = target.title ?? "";
      artistName = target.artistName ?? null;
    } else if (target.kind === "queue-multi" && target.indices.length === 1) {
      const queueTrack = queue[target.indices[0]];
      if (queueTrack) {
        trackId = parseLibraryId(queueTrack.key);
        title = queueTrack.title;
        artistName = queueTrack.artist_name ?? null;
      }
    } else {
      return;
    }

    if (interactive) {
      const track = trackId != null ? libraryTracks.find(t => t.id === trackId) : null;
      setDownloadModal({
        tracks: [{
          title: track?.title ?? title,
          artistName: track?.artist_name ?? artistName,
          albumTitle: track?.album_title ?? null,
          uri: track?.path ?? null,
          durationSecs: track?.duration_secs ?? null,
          trackId,
        }],
        providerId,
        providerName: downloadProviderEntries.find(e => e.id === providerId)?.name ?? providerId,
      });
    } else {
      // Non-interactive: silent enqueue (no modal)
      const track = trackId != null ? libraryTracks.find(t => t.id === trackId) : null;
      invoke("enqueue_download", {
        title: track?.title ?? title,
        artistName: track?.artist_name ?? artistName,
        albumTitle: track?.album_title ?? null,
        uri: track?.path ?? null,
        durationSecs: track?.duration_secs ?? null,
        destCollectionId: null,
        format: null,
        provider: providerId,
      }).catch((e: unknown) => {
        console.error("Failed to enqueue download:", e);
      });
    }
  }, [contextMenu, downloadProviderEntries, libraryTracks, queue]);

  // Download the currently-playing track. Prefers the download provider of the
  // fallback stream resolver it's playing through (e.g. YouTube), then a direct
  // by-uri provider for remote schemes, else an interactive search (with a fresh
  // priority refetch). Final fallback hands off to the single-track download path.
  const openDownloadForCurrentTrack = useCallback(async (track: QueueTrack, resolvedSource: ResolvedSource) => {
    const trackUri = track.path ?? "";
    const trackPayload = {
      title: track.title,
      artistName: track.artist_name ?? null,
      albumTitle: track.album_title ?? null,
      uri: track.path ?? null,
      durationSecs: track.duration_secs ?? null,
      trackId: parseLibraryId(track.key),
    };

    // If playing via a fallback stream resolver (e.g. YouTube), prefer that
    // plugin's download provider over the original scheme's provider
    const resolverPluginId = resolvedSource?.id?.split(":")[0] ?? null;
    const resolverDownloadProvider = resolverPluginId
      ? downloadProviders.find(p => p.source === resolverPluginId)
      : null;

    // Direct URI resolution: for remote schemes, skip interactive search
    if (isRemoteScheme(trackUri) && !resolverDownloadProvider) {
      const scheme = trackUri.substring(0, trackUri.indexOf("://"));
      const directProvider = scheme === "subsonic"
        ? downloadProviders.find(p => p.id === "__builtin:subsonic")
        : downloadProviders.find(p => p.source !== "__builtin");
      if (directProvider) {
        setDownloadModal({
          tracks: [trackPayload],
          providerId: directProvider.id,
          providerName: directProvider.name,
          resolveByUri: directProvider.resolveByUri,
        });
        return;
      }
    }

    // If playing via a fallback resolver that has a download provider,
    // use its resolveByMetadata (which checks cache before re-downloading)
    if (resolverDownloadProvider) {
      setDownloadModal({
        tracks: [trackPayload],
        providerId: resolverDownloadProvider.id,
        providerName: resolverDownloadProvider.name,
        resolveByUri: (_uri, format) =>
          resolverDownloadProvider.resolveByMetadata(
            track.title, track.artist_name ?? null, track.album_title ?? null,
            track.duration_secs ?? null, format,
          ),
      });
      return;
    }

    // Fallback: interactive search via plugin providers
    let entries = downloadProviderEntries;
    try {
      const rows = await invoke<[string, string, string, number][]>("get_active_download_providers");
      const freshPriorities = new Map<string, number>();
      for (const [pid, provId, , prio] of rows) freshPriorities.set(`${pid}:${provId}`, prio);
      setProviderPriorities(freshPriorities);
      entries = downloadProviders
        .filter(p => p.source !== "__builtin")
        .map(p => {
          const parts = p.id.split(":");
          return {
            id: p.id,
            name: p.name,
            priority: freshPriorities.get(p.id) ?? Number.MAX_SAFE_INTEGER,
            interactive: plugins.hasInteractiveDownload(parts[0], parts.slice(1).join(":")),
          };
        })
        .sort((a, b) => a.priority - b.priority);
    } catch (e) {
      console.error("Failed to load download provider priorities:", e);
    }
    const provider = entries.find(e => e.interactive) ?? entries[0];
    if (!provider) {
      handleDownloadTrackFallback(track);
      return;
    }
    setDownloadModal({
      tracks: [trackPayload],
      providerId: provider.id,
      providerName: provider.name,
    });
  }, [downloadProviders, downloadProviderEntries, plugins.hasInteractiveDownload, handleDownloadTrackFallback]);

  return {
    downloadModal,
    setDownloadModal,
    downloadProviders,
    downloadProviderEntries,
    handleDownloadFromProvider,
    openDownloadForCurrentTrack,
  };
}
