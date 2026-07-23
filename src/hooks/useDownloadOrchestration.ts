import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { subscribe } from "../utils/tauriEvents";
import type { Track, QueueTrack } from "../types";
import type { DownloadProvider, DownloadResolveResult } from "../types/plugin";
import type { DownloadTrack } from "../components/DownloadModal";
import type { ContextMenuState } from "../types/contextMenu";
import { parseLibraryId, classifyEffectiveSource } from "../queueEntry";
import { withResolverLog } from "../utils/resolverLog";
import { decideDownload, type DownloadPlan } from "../utils/downloadPlan";
import { usePlugins, DEFAULT_DOWNLOAD_PROVIDER_PRIORITY } from "./usePlugins";

export interface DownloadModalState {
  tracks: DownloadTrack[];
  providerId: string;
  providerName: string;
  confirmed?: boolean;
  resolveByUri?: (uri: string, format: string) => Promise<DownloadResolveResult | null>;
}

/** Walk the plugin download-provider chain (by-uri first, then by-metadata) and
 * return the first successful resolution. Each provider call is bounded to 10s.
 * Exported for unit testing of the provider-id matching. */
export async function resolveTrackDownload(
  providers: DownloadProvider[],
  uri: string | null,
  title: string,
  artistName: string | null,
  albumName: string | null,
  durationSecs: number | null,
  format: string,
  provider?: string | null,
): Promise<DownloadResolveResult | null> {
  // `provider` may arrive as the host's fully-qualified id ("pluginId:providerId")
  // or as the bare providerId a plugin passed to api.downloads.enqueue — which is
  // all a plugin knows of itself (its manifest's downloadProviders[].id). Accept
  // either, reconstructing the full id from each provider's source so a bare id
  // can't false-match a same-named provider under a different plugin.
  const targetProviders = provider
    ? providers.filter(p => p.id === provider || p.id === `${p.source}:${provider}`)
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
    "pluginStates" | "invokeDownloadResolveByUri" | "invokeDownloadResolveByMetadata" | "hasInteractiveDownload" | "streamUriResolverOwner"
  >;
  /** The active context-menu target — drives `handleDownloadFromProvider`. */
  contextMenu: ContextMenuState | null;
  libraryTracks: Track[];
  queue: QueueTrack[];
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
            // Subsonic paths are host-based (`subsonic://{host}/{id}`); the
            // backend resolves the collection by host, so pass the URI through.
            const target = await invoke<{ url: string; ext: string }>("resolve_subsonic_download_url", {
              location: uri, format,
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
    return subscribe<{
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

  // --- Unified per-track download (context menu ⟷ now-playing) --------------
  // The now-playing button and the context-menu "Download…" both resolve which
  // downloader owns a track from its *source* via `decideDownload` (the single,
  // unit-tested matrix): subsonic:// → built-in Subsonic ("Source original"),
  // a plugin scheme → that plugin, local/direct-url/metadata-only → none. This
  // keeps every entry point opening the same modal with the same provider.

  /** Normalize a single-track context target to the fields the plan + modal need. */
  const contextTrack = useCallback(
    (target: ContextMenuState["target"]):
      | { title: string; artist_name: string | null; album_title: string | null; duration_secs: number | null; path: string | null; trackId: number | null }
      | null => {
      if (target.kind === "track" && target.trackId != null) {
        const t = libraryTracks.find((tr) => tr.id === target.trackId);
        if (!t) return null;
        return { title: t.title, artist_name: t.artist_name ?? null, album_title: t.album_title ?? null, duration_secs: t.duration_secs ?? null, path: t.path ?? null, trackId: t.id ?? null };
      }
      if (target.kind === "queue-multi" && target.indices.length === 1) {
        const t = queue[target.indices[0]];
        if (!t) return null;
        return { title: t.title, artist_name: t.artist_name ?? null, album_title: t.album_title ?? null, duration_secs: t.duration_secs ?? null, path: t.path ?? null, trackId: parseLibraryId(t.key) };
      }
      return null;
    },
    [libraryTracks, queue],
  );

  const nativePlanForTrack = useCallback(
    (t: { title: string; artist_name: string | null; album_title: string | null; duration_secs: number | null; path: string | null }): DownloadPlan | null => {
      const source = t.path ? classifyEffectiveSource(t.path, plugins.streamUriResolverOwner) : null;
      return decideDownload(source, t, downloadProvidersRef.current);
    },
    [plugins.streamUriResolverOwner],
  );

  /** Which native provider (if any) owns this single-track target's source. Drives
   *  whether the context menu shows the primary "Download…" item. */
  const resolveNativeDownload = useCallback(
    (target: ContextMenuState["target"]): { providerId: string; providerName: string } | null => {
      const t = contextTrack(target);
      if (!t) return null;
      const plan = nativePlanForTrack(t);
      return plan ? { providerId: plan.providerId, providerName: plan.providerName } : null;
    },
    [contextTrack, nativePlanForTrack],
  );

  /** Open the download modal for a single-track target using its native provider. */
  const openNativeDownload = useCallback(
    (target: ContextMenuState["target"]) => {
      const t = contextTrack(target);
      if (!t) return;
      const plan = nativePlanForTrack(t);
      if (!plan) return;
      setDownloadModal({
        tracks: [{
          title: t.title,
          artistName: t.artist_name,
          albumTitle: t.album_title,
          uri: plan.uri ?? t.path ?? null,
          durationSecs: t.duration_secs,
          trackId: t.trackId,
        }],
        providerId: plan.providerId,
        providerName: plan.providerName,
        resolveByUri: plan.resolveByUri,
      });
    },
    [contextTrack, nativePlanForTrack],
  );

  // Download the currently-playing track. The decision of *which* downloader (and
  // whether the button is even shown) is made by `decideDownload` from the winning
  // playback source's `EffectiveSource`; the caller passes the resulting plan here.
  // This function only translates that plan into the download modal.
  const openDownloadForCurrentTrack = useCallback((track: QueueTrack, plan: DownloadPlan) => {
    setDownloadModal({
      tracks: [{
        title: track.title,
        artistName: track.artist_name ?? null,
        albumTitle: track.album_title ?? null,
        uri: plan.uri ?? track.path ?? null,
        durationSecs: track.duration_secs ?? null,
        trackId: parseLibraryId(track.key),
      }],
      providerId: plan.providerId,
      providerName: plan.providerName,
      resolveByUri: plan.resolveByUri,
    });
  }, []);

  return {
    downloadModal,
    setDownloadModal,
    downloadProviders,
    downloadProviderEntries,
    handleDownloadFromProvider,
    openDownloadForCurrentTrack,
    resolveNativeDownload,
    openNativeDownload,
  };
}
