import type { DownloadProvider } from "../types/plugin";
import type { DownloadTrack, DownloadPurpose } from "../components/download/types";
import { isVideoTrack } from "../utils";
import { uriPlan, type DownloadPlan, type ResolveTrack } from "./downloadPlan";

/** One track of a batch download, with how to fetch exactly it. */
export interface DownloadItem {
  track: DownloadTrack;
  resolve: ResolveTrack;
}

/**
 * What the download modal shows. Every way in arrives knowing how to fetch each
 * track — a plan for one track, a resolve per track for several — so the modal
 * never searches a provider to find out what to download.
 *
 * It used to: a request without a source opened the provider's interactive
 * search, and a batch could match every track by search before downloading.
 * Every caller names its source now, so both paths were unreachable, and the
 * batch path resolved through the provider's interactive-resolve handler —
 * which Soulseek and rqbit don't register, so their batches failed.
 */
export type DownloadModalState =
  | {
    kind: "single";
    track: DownloadTrack;
    plan: DownloadPlan;
    /** `"import"` when the file is already here and only gets copied into a
     *  collection (a plugin's `download-tracks` with `purpose`). */
    purpose?: DownloadPurpose;
  }
  | {
    kind: "batch";
    items: DownloadItem[];
    providerId: string;
    providerName: string;
    purpose?: DownloadPurpose;
  };

export function downloadModalProviderId(state: DownloadModalState): string {
  return state.kind === "single" ? state.plan.providerId : state.providerId;
}

/** The modal state for downloading one track through a plan. `track.uri` is the
 *  track's own path — display, video detection and the local-file upgrade check
 *  read it; it never decides how the track is fetched. */
export function planDownloadModal(track: DownloadTrack, plan: DownloadPlan, purpose?: DownloadPurpose): DownloadModalState {
  return { kind: "single", track, plan, purpose };
}

/** A track as a plugin's `download-tracks` / `download-album` request names it. */
export interface PluginDownloadTrack {
  title: string;
  artist_name?: string | null;
  album_title?: string | null;
  uri?: string | null;
  durationSecs?: number | null;
}

export interface PluginDownloadRequest {
  providerId: string;
  providerName?: string | null;
  tracks: PluginDownloadTrack[];
  /** `download-album`: the album every track is filed under. */
  albumTitle?: string | null;
  purpose?: DownloadPurpose;
  /** The local library row a single track replaces (`libraryTrackId`). */
  upgradeOf?: { id: number; path: string } | null;
}

/**
 * The modal state for a plugin's download request, or why it can't open. Each
 * track is fetched by its own `uri` through the named provider's by-URI
 * resolver — the plan `decideDownload` builds for a playing plugin track. A
 * track without a `uri` can't be downloaded and is left out; a request left with
 * none is refused. `upgradeOf` stands in as the single track so the in-place
 * upgrade flow can compare files, while the plan still resolves the plugin's uri.
 */
export function pluginDownloadModal(
  provider: DownloadProvider | undefined,
  request: PluginDownloadRequest,
): DownloadModalState | { error: string } {
  if (!provider) return { error: `${request.providerName || request.providerId} isn't an active download provider.` };
  const providerName = request.providerName || provider.name;
  const usable = request.tracks.filter((t): t is PluginDownloadTrack & { uri: string } => !!t.uri);
  if (usable.length === 0) return { error: `${providerName} named no track to download.` };

  const items = usable.map((t): DownloadItem & { plan: DownloadPlan } => {
    const albumTitle = t.album_title ?? request.albumTitle ?? null;
    const plan = uriPlan(provider, t.uri, {
      title: t.title,
      artist_name: t.artist_name ?? null,
      album_title: albumTitle,
      duration_secs: t.durationSecs ?? null,
    });
    return {
      track: {
        title: t.title,
        artistName: t.artist_name ?? null,
        albumTitle,
        uri: t.uri,
        durationSecs: t.durationSecs ?? null,
        isVideo: isVideoTrack({ format: null, path: t.uri }),
      },
      resolve: plan.resolve,
      plan: { ...plan, providerName },
    };
  });

  if (items.length === 1) {
    const { track, plan } = items[0];
    const up = request.upgradeOf;
    return planDownloadModal(up ? { ...track, uri: up.path, trackId: up.id } : track, plan, request.purpose);
  }
  return {
    kind: "batch",
    items: items.map(({ track, resolve }) => ({ track, resolve })),
    providerId: provider.id,
    providerName,
    purpose: request.purpose,
  };
}
