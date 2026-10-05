import { useState, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, QueueTrack } from "../types";
import type { DownloadProvider } from "../types/plugin";
import type { DownloadTrack } from "../components/DownloadModal";
import type { ContextMenuState } from "../types/contextMenu";
import { classifyEffectiveSource } from "../queueEntry";
import { isVideoTrack } from "../utils";
import { withResolverLog } from "../utils/resolverLog";
import { decideDownload, decideMetadataDownload, type DownloadPlan, type ResolveTrack } from "../utils/downloadPlan";
import { usePlugins } from "./usePlugins";

import { useAssignRef } from "./useLatestRef";
export interface DownloadModalState {
  tracks: DownloadTrack[];
  providerId: string;
  providerName: string;
  /** Batch flow only (plugin requestAction("download-tracks"/"download-album")):
   *  skip the per-track resolve/search step and resolve each uri directly. */
  confirmed?: boolean;
  /** Single track: how to fetch THIS track — a `DownloadPlan.resolve`. Present
   *  → the modal goes straight to its configure step and calls it; absent →
   *  the modal opens the provider's interactive search (only a plugin flow that
   *  names a track without a source does that). The modal never infers this
   *  from `tracks[0].uri`; that inference is what kept sending tracks a
   *  playback fallback played into a search Soulseek doesn't answer. */
  resolveTrack?: ResolveTrack;
}

/** The modal state for downloading one track through a plan. Every plan-based
 *  entry point (now-playing button, context menu, "Not in library" rows) goes
 *  through this, so none of them can wire the modal differently. `uri` is the
 *  track's own path — display, video detection and the local-file upgrade
 *  check read it; it does not decide how the track is resolved. */
export function planDownloadModal(track: DownloadTrack, plan: DownloadPlan): DownloadModalState {
  return {
    tracks: [track],
    providerId: plan.providerId,
    providerName: plan.providerName,
    resolveTrack: plan.resolve,
  };
}

interface UseDownloadOrchestrationDeps {
  plugins: Pick<
    ReturnType<typeof usePlugins>,
    "pluginStates" | "invokeDownloadResolveByUri" | "invokeDownloadResolveByMetadata" | "streamUriResolverOwner"
  >;
  libraryTracks: Track[];
  queue: QueueTrack[];
  /** The enabled stream resolvers' `source`s, in the user's order — what a
   *  metadata-only track's downloader follows (`decideMetadataDownload`). */
  resolverSources: readonly string[];
}

/**
 * Download-orchestration engine, extracted out of App.tsx. Owns the plugin
 * download-provider list, the `downloadModal` state, and the source-owned
 * download triggers (context-menu "Download…", now-playing download, the
 * "Not in library" rows' hover button). There are no per-provider triggers, no
 * download-provider priorities, and no resolve chain: a track's own source
 * decides its downloader (`decideDownload`); a track with no source yet
 * follows the stream-resolver order (`decideMetadataDownload`), and providers
 * surface their own context-menu items (plugin-first).
 */
export function useDownloadOrchestration({
  plugins,
  libraryTracks,
  queue,
  resolverSources,
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
  // a plugin scheme → that plugin, local → none, a raw URL → itself, and a
  // metadata-only track (no path) → the first resolver in the user's order whose
  // plugin can download. This keeps every entry point opening the same modal
  // with the same provider.

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
      if (target.kind === "track" && target.trackId == null && target.title) {
        // Known by name only (a "Not in library" row, an information-section
        // track): no source until a resolver finds one.
        return { title: target.title, artist_name: target.artistName ?? null, album_title: target.albumTitle ?? null, duration_secs: null, path: null, trackId: null, format: null };
      }
      if (target.kind === "queue-multi" && target.indices.length === 1) {
        const t = queue[target.indices[0]];
        if (!t) return null;
        return { title: t.title, artist_name: t.artist_name ?? null, album_title: t.album_title ?? null, duration_secs: t.duration_secs ?? null, path: t.path ?? null, trackId: t.libraryId ?? null, format: t.format ?? null };
      }
      return null;
    },
    [libraryTracks, queue],
  );

  const nativePlanForTrack = useCallback(
    (t: { title: string; artist_name: string | null; album_title: string | null; duration_secs: number | null; path: string | null }): DownloadPlan | null => {
      if (!t.path) return decideMetadataDownload(resolverSources, t, downloadProvidersRef.current);
      return decideDownload(classifyEffectiveSource(t.path, plugins.streamUriResolverOwner), t, downloadProvidersRef.current);
    },
    [plugins.streamUriResolverOwner, resolverSources],
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
      setDownloadModal(planDownloadModal({
        title: t.title,
        artistName: t.artist_name,
        albumTitle: t.album_title,
        uri: t.path,
        durationSecs: t.duration_secs,
        trackId: t.trackId,
        isVideo: isVideoTrack({ format: t.format, path: t.path }),
      }, plan));
    },
    [contextTrack, nativePlanForTrack],
  );

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

  // A track known only by name ("Not in library" rows' hover button). Null when
  // no resolver in the user's order can download, so callers hide the button.
  // Track-independent by construction — only the order and the providers decide.
  const openDownloadByName = useMemo(() => {
    if (!decideMetadataDownload(resolverSources, { title: "", artist_name: null, album_title: null, duration_secs: null }, downloadProviders)) return null;
    return (track: QueueTrack) => {
      const plan = decideMetadataDownload(resolverSources, track, downloadProvidersRef.current);
      if (plan) openDownloadForCurrentTrack(track, plan);
    };
  }, [resolverSources, downloadProviders, openDownloadForCurrentTrack]);

  return {
    downloadModal,
    setDownloadModal,
    downloadProviders,
    openDownloadForCurrentTrack,
    resolveNativeDownload,
    openNativeDownload,
    openDownloadByName,
  };
}
