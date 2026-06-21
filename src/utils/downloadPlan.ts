import type { QueueTrack } from "../types";
import type { EffectiveSource } from "../queueEntry";
import type { DownloadProvider, DownloadResolveResult } from "../types/plugin";

/** The built-in Subsonic download provider id (see `useDownloadOrchestration`). */
export const BUILTIN_SUBSONIC_PROVIDER_ID = "__builtin:subsonic";

/**
 * A resolved decision about how (and whether) the currently-playing track can be
 * downloaded. `null` means "no downloader owns this source" → hide the button.
 * When non-null, it maps 1:1 onto a `DownloadModalState` for the single track.
 */
export interface DownloadPlan {
  providerId: string;
  providerName: string;
  /** URI to stamp on the modal track (the effective-source URI when available). */
  uri: string | null;
  /** How the modal resolves the track — by URI for native/subsonic sources, or a
   *  metadata closure for plugin stream-resolver wins (e.g. YouTube). */
  resolveByUri: (uri: string, format: string) => Promise<DownloadResolveResult | null>;
}

/**
 * The single source of truth mapping a winning playback source → its downloader.
 * Drives BOTH the now-playing download button's visibility (plan != null) and the
 * provider the download modal opens with. Pure + exhaustively unit-tested.
 *
 * Rules (see the matrix in the plugins/download review):
 * - `local` / `direct-url`            → null (nothing/no-one to download from)
 * - `subsonic`                        → built-in Subsonic provider, by URI
 * - `plugin` with a matching provider → that plugin's provider; by URI if a native
 *                                        URI is known, else by metadata
 * - `plugin` with no matching provider → null (hide — "downloader follows resolver")
 */
export function decideDownload(
  source: EffectiveSource | null | undefined,
  track: Pick<QueueTrack, "title" | "artist_name" | "album_title" | "duration_secs">,
  providers: DownloadProvider[],
): DownloadPlan | null {
  if (!source) return null;
  if (source.kind === "local" || source.kind === "direct-url") return null;

  if (source.kind === "subsonic") {
    const p = providers.find((pr) => pr.id === BUILTIN_SUBSONIC_PROVIDER_ID);
    if (!p) return null;
    return { providerId: p.id, providerName: p.name, uri: source.uri, resolveByUri: p.resolveByUri };
  }

  // plugin source — the downloader must be contributed by the same plugin.
  const p = providers.find((pr) => pr.source === source.pluginId);
  if (!p) return null;

  if (source.uri) {
    // Native scheme (e.g. tidal://) — resolve directly by URI.
    return { providerId: p.id, providerName: p.name, uri: source.uri, resolveByUri: p.resolveByUri };
  }
  // Stream-resolver win (e.g. YouTube fallback) — no native URI; resolve by
  // metadata, which lets the provider check its cache before re-downloading.
  return {
    providerId: p.id,
    providerName: p.name,
    uri: null,
    resolveByUri: (_uri, format) =>
      p.resolveByMetadata(
        track.title,
        track.artist_name ?? null,
        track.album_title ?? null,
        track.duration_secs ?? null,
        format,
      ),
  };
}
