import type { QueueTrack } from "../types";
import type { EffectiveSource } from "../queueEntry";
import type {
  DownloadProvider,
  DownloadResolveResult,
  DownloadResolveProgress,
  DownloadPreview,
  InteractiveSearchResult,
} from "../types/plugin";

/** The built-in Subsonic download provider id (see `useDownloadOrchestration`). */
export const BUILTIN_SUBSONIC_PROVIDER_ID = "__builtin:subsonic";

/** The self-contained direct-URL plan id. Not a registered provider — a raw
 *  http(s) source needs no resolver, the bytes ARE the URL. */
export const BUILTIN_DIRECT_PROVIDER_ID = "__builtin:direct";

/** File extension named by a direct URL's own path (query/fragment stripped,
 *  host excluded so a bare domain's TLD can't read as one), or null when the
 *  path names none — the modal then falls back per its own rules. Pure;
 *  exported for tests. */
export function extFromDirectUrl(uri: string): string | null {
  const path = uri.replace(/^https?:\/\/[^/]*/i, "").split(/[?#]/)[0];
  const m = /\.([a-z0-9]{2,4})$/i.exec(path);
  return m ? m[1].toLowerCase() : null;
}

/** Resolve one known track to the bytes to save. `onProgress` receives
 *  whatever the provider reports while it works; a provider that downloads the
 *  file itself (yt-dlp) reports real percentages, one that just mints a URL
 *  reports nothing and returns fast. */
export type ResolveTrack = (
  format: string,
  onProgress?: (progress: DownloadResolveProgress) => void,
) => Promise<DownloadResolveResult | null>;

/**
 * A resolved decision about how (and whether) one track can be downloaded.
 * `null` means "no downloader owns this source" → hide the button.
 *
 * `resolve` already knows WHICH track — the source URI or the metadata is
 * closed over here — so the download modal never re-derives it. That is the
 * whole point of the shape: the modal used to guess "resolve directly" vs
 * "search the provider" from whether the track had a uri, and every metadata
 * plan (a track a playback fallback played, a "Not in library" row) has none,
 * so it fell into a search step a provider like Soulseek doesn't answer.
 */
export interface DownloadPlan {
  providerId: string;
  providerName: string;
  resolve: ResolveTrack;
  /** Ask the provider which item `resolve` would fetch, before fetching it.
   *  Null answer = no preview; the modal then just calls `resolve`. */
  /** `opts.uri` asks about one specific item instead (a match the user picked
   *  from `search`), for its real qualities. */
  preview?: (opts: { isVideo: boolean; uri?: string }) => Promise<DownloadPreview | null>;
  /** Fetch one specific match — the previewed item, or one the user picked
   *  from `search`. */
  resolveMatch?: (
    matchId: string,
    format: string,
    onProgress?: (progress: DownloadResolveProgress) => void,
  ) => Promise<DownloadResolveResult>;
  /** The provider's free-text search, to pick a different match. */
  search?: (query: string, limit: number) => Promise<InteractiveSearchResult[]>;
  /** Whether `search` + `resolveMatch` can answer right now (asked when the
   *  modal renders; absent = they can whenever both are present). */
  canChooseAnother?: () => boolean;
}

type PlanTrack = Pick<QueueTrack, "title" | "artist_name" | "album_title" | "duration_secs">;

/**
 * The single source of truth mapping a winning playback source → its downloader.
 * Drives BOTH the now-playing download button's visibility (plan != null) and the
 * provider the download modal opens with. Pure + exhaustively unit-tested.
 *
 * Rules (see the matrix in the plugins/download review):
 * - `local`                           → null (already a file on disk)
 * - `direct-url`                      → self-contained plan ("Source"): the URL
 *                                        itself is the download, no provider
 * - `subsonic`                        → built-in Subsonic provider, by URI
 * - `plugin` with a matching provider → that plugin's provider; by URI if a native
 *                                        URI is known, else by metadata
 * - `plugin` with no matching provider → null (hide — "downloader follows resolver")
 */
export function decideDownload(
  source: EffectiveSource | null | undefined,
  track: PlanTrack,
  providers: DownloadProvider[],
): DownloadPlan | null {
  if (!source) return null;
  if (source.kind === "local") return null;

  if (source.kind === "direct-url") {
    // Download exactly what is streaming: no resolver, no provider — the plan
    // hands the URL straight to the modal's direct path. The container comes
    // from the URL's own extension when it names one (a manifest track's
    // `tracks/song.flac`); a bare streaming endpoint falls back in the modal.
    const ext = extFromDirectUrl(source.uri);
    return {
      providerId: BUILTIN_DIRECT_PROVIDER_ID,
      providerName: "Source",
      resolve: async () => ({ url: source.uri, headers: null, metadata: null, ext }),
    };
  }

  if (source.kind === "subsonic") {
    const p = providers.find((pr) => pr.id === BUILTIN_SUBSONIC_PROVIDER_ID);
    if (!p) return null;
    return uriPlan(p, source.uri, track);
  }

  // plugin source — the downloader must be contributed by the same plugin.
  const p = providers.find((pr) => pr.source === source.pluginId);
  if (!p) return null;

  if (source.uri) {
    // Native plugin scheme (e.g. qbt://) — resolve directly by URI.
    return uriPlan(p, source.uri, track);
  }
  // Stream-resolver win (e.g. YouTube fallback) — no native URI; resolve by
  // metadata, which lets the provider check its cache before re-downloading.
  return metadataPlan(p, track);
}

/** The plan for one provider-owned URI — what `decideDownload` builds for a
 *  plugin scheme, for callers that already know the provider (a plugin's own
 *  `download-tracks` request). */
export function uriPlan(p: DownloadProvider, uri: string, track: PlanTrack): DownloadPlan {
  return {
    providerId: p.id,
    providerName: p.name,
    resolve: (format, onProgress) => p.resolveByUri(uri, format, onProgress),
    ...matchCapabilities(p, uri, track),
  };
}

function metadataPlan(p: DownloadProvider, track: PlanTrack): DownloadPlan {
  return {
    providerId: p.id,
    providerName: p.name,
    resolve: (format, onProgress) =>
      p.resolveByMetadata(
        track.title,
        track.artist_name ?? null,
        track.album_title ?? null,
        track.duration_secs ?? null,
        format,
        onProgress,
      ),
    ...matchCapabilities(p, null, track),
  };
}

/** The preview / pick-another half of a plan, for providers that have it. */
function matchCapabilities(
  p: DownloadProvider,
  uri: string | null,
  track: PlanTrack,
): Pick<DownloadPlan, "preview" | "resolveMatch" | "search" | "canChooseAnother"> {
  const preview = p.preview;
  return {
    preview: preview
      ? (opts) => preview({
        uri: opts.uri ?? uri,
        isVideo: opts.isVideo,
        title: track.title,
        artistName: track.artist_name ?? null,
        albumName: track.album_title ?? null,
        durationSecs: track.duration_secs ?? null,
      })
      : undefined,
    resolveMatch: p.resolveMatch,
    search: p.search,
    canChooseAnother: p.canChooseAnother,
  };
}
