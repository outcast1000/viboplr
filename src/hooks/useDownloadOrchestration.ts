import { useState, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";
import type { DownloadProvider } from "../types/plugin";
import { isVideoTrack } from "../utils";
import { withResolverLog } from "../utils/resolverLog";
import type { DownloadPlan } from "../utils/downloadPlan";
import { planDownloadModal, type DownloadModalState } from "../utils/downloadModalState";
import { usePlugins } from "./usePlugins";

export type { DownloadModalState } from "../utils/downloadModalState";

interface UseDownloadOrchestrationDeps {
  plugins: Pick<
    ReturnType<typeof usePlugins>,
    | "pluginStates" | "invokeDownloadResolveByUri" | "invokeDownloadResolveByMetadata"
    | "invokeDownloadPreview" | "hasDownloadPreview" | "hasInteractiveSearch" | "hasInteractiveResolve"
    | "invokeInteractiveResolve" | "invokeInteractiveSearch"
  >;
}

/**
 * Download-orchestration engine, extracted out of App.tsx. Owns the plugin
 * download-provider list, the `downloadModal` state, and the one host download
 * trigger: the now-playing button, which downloads the playing track from the
 * source it is actually playing from (`decideDownload` on the resolved
 * source; local → none). There is no context-menu "Download…", no download for
 * a track that isn't playing, no per-provider trigger, no download-provider
 * priority and no resolve chain; providers surface their own context-menu
 * items (plugin-first).
 */
export function useDownloadOrchestration({
  plugins,
}: UseDownloadOrchestrationDeps) {
  const [downloadModal, setDownloadModal] = useState<DownloadModalState | null>(null);

  // The download provider list: built-in Subsonic first, then active plugins'
  // providers in registration order. No user-configurable priority/enable — the
  // Settings → Providers download group was removed with the auto-download
  // chain. Nothing walks this list in order: callers look a provider up by id
  // or by the plugin that owns the playing source.
  const downloadProviders = useMemo(() => {
    const providers: DownloadProvider[] = [];

    // Built-in subsonic provider
    providers.push({
      id: "__builtin:subsonic",
      name: "Subsonic",
      source: "__builtin",
      // The backend's error is the reason ("no collection for host …", a
      // refused sign-in): it propagates to the modal rather than collapsing
      // into "could not resolve".
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
        ),
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
          resolveByUri: (uri, format, onProgress) =>
            plugins.invokeDownloadResolveByUri(ps.id, dp.id, uri, format, onProgress),
          resolveByMetadata: (title, artistName, albumName, durationSecs, format, onProgress) =>
            plugins.invokeDownloadResolveByMetadata(ps.id, dp.id, title, artistName, albumName, durationSecs, format, onProgress),
          // Handlers register during activation, so these are looked up when
          // called, not when the list is built.
          preview: (request) =>
            plugins.hasDownloadPreview(ps.id, dp.id)
              ? plugins.invokeDownloadPreview(ps.id, dp.id, request)
              : Promise.resolve(null),
          resolveMatch: (matchId, format, onProgress) =>
            plugins.invokeInteractiveResolve(ps.id, dp.id, matchId, format, onProgress),
          search: (query, limit) =>
            plugins.hasInteractiveSearch(ps.id, dp.id)
              ? plugins.invokeInteractiveSearch(ps.id, dp.id, query, limit)
              : Promise.resolve([]),
          canChooseAnother: () =>
            plugins.hasInteractiveSearch(ps.id, dp.id) && plugins.hasInteractiveResolve(ps.id, dp.id),
        });
      }
    }

    return providers;
  }, [
    plugins.pluginStates, plugins.invokeDownloadResolveByUri, plugins.invokeDownloadResolveByMetadata,
    plugins.invokeDownloadPreview, plugins.hasDownloadPreview, plugins.hasInteractiveSearch,
    plugins.hasInteractiveResolve, plugins.invokeInteractiveResolve, plugins.invokeInteractiveSearch,
  ]);

  // Download the currently-playing track. The decision of *which* downloader (and
  // whether the button is even shown) is made by `decideDownload` from the winning
  // playback source's `EffectiveSource`; the caller passes the resulting plan here.
  // This function only translates that plan into the download modal.
  const openDownloadForCurrentTrack = useCallback((track: QueueTrack, plan: DownloadPlan) => {
    setDownloadModal(planDownloadModal({
      title: track.title,
      artistName: track.artist_name ?? null,
      albumTitle: track.album_title ?? null,
      uri: track.path ?? null,
      durationSecs: track.duration_secs ?? null,
      trackId: track.libraryId ?? null,
      isVideo: isVideoTrack(track),
    }, plan));
  }, []);

  return {
    downloadModal,
    setDownloadModal,
    downloadProviders,
    openDownloadForCurrentTrack,
  };
}
