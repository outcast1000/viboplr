import { useState, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, QueueTrack } from "../types";
import type { DownloadProvider, DownloadResolveResult, DownloadResolveProgress } from "../types/plugin";
import type { DownloadTrack } from "../components/DownloadModal";
import type { ContextMenuState } from "../types/contextMenu";
import { parseLibraryId, classifyEffectiveSource } from "../queueEntry";
import { isVideoTrack } from "../utils";
import { withResolverLog } from "../utils/resolverLog";
import { decideDownload, type DownloadPlan } from "../utils/downloadPlan";
import { usePlugins } from "./usePlugins";

import { useAssignRef } from "./useLatestRef";
export interface DownloadModalState {
  tracks: DownloadTrack[];
  providerId: string;
  providerName: string;
  /** Batch flow only (plugin requestAction("download-tracks"/"download-album")):
   *  skip the per-track resolve/search step and resolve each uri directly. */
  confirmed?: boolean;
  resolveByUri?: (
    uri: string,
    format: string,
    onProgress?: (progress: DownloadResolveProgress) => void,
  ) => Promise<DownloadResolveResult | null>;
}

interface UseDownloadOrchestrationDeps {
  plugins: Pick<
    ReturnType<typeof usePlugins>,
    "pluginStates" | "invokeDownloadResolveByUri" | "invokeDownloadResolveByMetadata" | "streamUriResolverOwner"
  >;
  libraryTracks: Track[];
  queue: QueueTrack[];
}

/**
 * Download-orchestration engine, extracted out of App.tsx. Owns the plugin
 * download-provider list, the `downloadModal` state, and the source-owned
 * download triggers (context-menu "Download…", now-playing download). There
 * are no per-provider triggers, no provider priorities, and no resolve chain:
 * a track's own source decides its downloader (`decideDownload`), and
 * providers surface their own context-menu items (plugin-first).
 */
export function useDownloadOrchestration({
  plugins,
  libraryTracks,
  queue,
}: UseDownloadOrchestrationDeps) {
  const [downloadModal, setDownloadModal] = useState<DownloadModalState | null>(null);

  // The download provider list: built-in Subsonic first, then active plugins'
  // providers in registration order. No user-configurable priority/enable — the
  // Settings → Providers download group was removed with the auto-download
  // chain; the only order-sensitive consumer left is mixtape export's resolve.
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
          resolveByUri: (uri, format, onProgress) =>
            plugins.invokeDownloadResolveByUri(ps.id, dp.id, uri, format, onProgress),
          resolveByMetadata: (title, artistName, albumName, durationSecs, format, onProgress) =>
            plugins.invokeDownloadResolveByMetadata(ps.id, dp.id, title, artistName, albumName, durationSecs, format, onProgress),
        });
      }
    }

    return providers;
  }, [plugins.pluginStates, plugins.invokeDownloadResolveByUri, plugins.invokeDownloadResolveByMetadata]);

  // Kept in a ref so nativePlanForTrack (a stable callback) always reads the
  // live provider list. There is no download-resolve bridge any more — mixtape
  // export downloads its sources backend-side, so nothing subscribes here.
  const downloadProvidersRef = useRef<DownloadProvider[]>([]);
  useAssignRef(downloadProvidersRef, downloadProviders);

  // --- Unified per-track download (context menu ⟷ now-playing) --------------
  // The now-playing button and the context-menu "Download…" both resolve which
  // downloader owns a track from its *source* via `decideDownload` (the single,
  // unit-tested matrix): subsonic:// → built-in Subsonic ("Source original"),
  // a plugin scheme → that plugin, local/direct-url/metadata-only → none. This
  // keeps every entry point opening the same modal with the same provider.

  /** Normalize a single-track context target to the fields the plan + modal need. */
  const contextTrack = useCallback(
    (target: ContextMenuState["target"]):
      | { title: string; artist_name: string | null; album_title: string | null; duration_secs: number | null; path: string | null; trackId: number | null; format: string | null }
      | null => {
      if (target.kind === "track" && target.trackId != null) {
        const t = libraryTracks.find((tr) => tr.id === target.trackId);
        if (!t) return null;
        return { title: t.title, artist_name: t.artist_name ?? null, album_title: t.album_title ?? null, duration_secs: t.duration_secs ?? null, path: t.path ?? null, trackId: t.id ?? null, format: t.format ?? null };
      }
      if (target.kind === "queue-multi" && target.indices.length === 1) {
        const t = queue[target.indices[0]];
        if (!t) return null;
        return { title: t.title, artist_name: t.artist_name ?? null, album_title: t.album_title ?? null, duration_secs: t.duration_secs ?? null, path: t.path ?? null, trackId: parseLibraryId(t.key), format: t.format ?? null };
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
          isVideo: isVideoTrack({ format: t.format, path: t.path }),
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
        isVideo: isVideoTrack(track),
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
    openDownloadForCurrentTrack,
    resolveNativeDownload,
    openNativeDownload,
  };
}
