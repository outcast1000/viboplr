import type { QueueTrack } from "../types";
import type { EffectiveSource } from "../queueEntry";
import type { DownloadProvider, DownloadResolveResult, DownloadResolveProgress } from "../types/plugin";

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
   *  metadata closure for plugin stream-resolver wins (e.g. YouTube).
   *  `onProgress` receives whatever the provider reports while it works; a
   *  provider that downloads the file itself (yt-dlp) reports real percentages,
   *  one that just mints a URL reports nothing and returns fast. */
  resolveByUri: (
    uri: string,
    format: string,
    onProgress?: (progress: DownloadResolveProgress) => void,
  ) => Promise<DownloadResolveResult | null>;
}

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
  track: Pick<QueueTrack, "title" | "artist_name" | "album_title" | "duration_secs">,
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
      uri: source.uri,
      resolveByUri: async (uri) => ({ url: uri, headers: null, metadata: null, ext }),
    };
  }

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
    resolveByUri: (_uri, format, onProgress) =>
      p.resolveByMetadata(
        track.title,
        track.artist_name ?? null,
        track.album_title ?? null,
        track.duration_secs ?? null,
        format,
        onProgress,
      ),
  };
}
