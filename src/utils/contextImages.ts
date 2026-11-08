// Context images (`api.contextImages`): pictures a plugin picks for what the
// host is showing — photos of the artist from the years around this track,
// not just "photos of the artist". The pure parts live here: building the
// request, cleaning each answer once where the host receives it, ranking the
// answers of every provider into one list, and the walk that asks them all.
// Consumers are the Now Playing "Photos" visualizer (`useNowPlayingPhotos`)
// and the cue-sheet context (`cueContext.ts`).
//
// Plugins that still offer pictures the old way — an `image_gallery` info
// type, or one flagged `contextImages: true` — are adapted as providers that
// ignore the context (`gatherTrackGalleries`), unless the same plugin also
// declares a context-image provider, which then speaks for it.

import { invoke } from "@tauri-apps/api/core";
import type { Album, QueueTrack, Track } from "../types";
import type {
  ContextImage,
  ContextImageAbout,
  ContextImageRequest,
  ContextImageResult,
  PluginContextImageProvider,
} from "../types/plugin";
import type { OrderedWebSearchProvider } from "./webSearch";
import { gatherTrackGalleries, type GalleryAbout, type TrackGallery } from "./trackGalleries";
import type { InvokeInfoFetch } from "./infoFetchChain";

/** Store key for the user's order + on/off, `[{ id: "pluginId:providerId", enabled }]`
 *  — the same shape (and helpers) as `webSearchOrder`. */
export const CONTEXT_IMAGE_ORDER_KEY = "contextImageOrder";
/** One provider's budget. A scraped agency page can take a while; the
 *  slideshow shows whoever answers first, so a slow one costs only itself. */
export const CONTEXT_IMAGE_TIMEOUT_MS = 20_000;
export const CONTEXT_IMAGE_LIMIT_MAX = 60;
/** Pictures kept after merging every provider. */
export const CONTEXT_IMAGE_TOTAL_CAP = 36;
/** Relevance an image without one is ranked at. */
export const DEFAULT_RELEVANCE = 0.5;

export type OrderedContextImageProvider = PluginContextImageProvider & Pick<OrderedWebSearchProvider, "key" | "enabled">;

const MAX_TEXT = 300;
const MAX_REASON = 160;
const ABOUTS: ReadonlySet<string> = new Set(["artist", "album", "track", "event"]);

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const isHttps = (u: unknown): u is string => typeof u === "string" && /^https:\/\//i.test(u.trim());
const isWeb = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u.trim());

/** A year a photo could plausibly have been taken in. */
function plausibleYear(y: unknown): number | undefined {
  return typeof y === "number" && Number.isInteger(y) && y >= 1826 && y <= 2100 ? y : undefined;
}

/**
 * Make a provider's answer safe to show, once, where the host receives it:
 * https pictures only, http(s) page links only (the credit opens it in the
 * browser), text collapsed and capped, relevance clamped to 0–1, unknown
 * `about` dropped, repeats of the same URL dropped, trimmed to `limit`. A
 * provider is plugin code and its answer reaches the screen and an
 * assistant. `ok` with nothing usable left is `not_found`.
 */
export function normalizeContextImageResult(raw: unknown, limit: number): ContextImageResult {
  if (!raw || typeof raw !== "object") return { status: "not_found" };
  const r = raw as { status?: unknown; message?: unknown; images?: unknown };
  if (r.status === "error") {
    return { status: "error", message: typeof r.message === "string" && r.message.trim() ? clip(r.message, MAX_TEXT) : undefined };
  }
  if (r.status !== "ok" || !Array.isArray(r.images)) return { status: "not_found" };
  const seen = new Set<string>();
  const images: ContextImage[] = [];
  for (const item of r.images) {
    if (images.length >= limit) break;
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;
    if (!isHttps(i.url)) continue;
    const url = i.url.trim();
    if (seen.has(url)) continue;
    seen.add(url);
    const img: ContextImage = { url };
    for (const k of ["caption", "author", "source", "license"] as const) {
      const v = i[k];
      if (typeof v === "string" && v.trim()) img[k] = clip(v, MAX_TEXT);
    }
    if (typeof i.reason === "string" && i.reason.trim()) img.reason = clip(i.reason, MAX_REASON);
    if (isWeb(i.pageUrl)) img.pageUrl = i.pageUrl.trim();
    for (const k of ["width", "height"] as const) {
      const v = i[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) img[k] = Math.round(v);
    }
    const year = plausibleYear(i.year);
    if (year !== undefined) img.year = year;
    if (typeof i.about === "string" && ABOUTS.has(i.about)) img.about = i.about as ContextImageAbout;
    if (typeof i.relevance === "number" && Number.isFinite(i.relevance)) {
      img.relevance = Math.min(1, Math.max(0, i.relevance));
    }
    images.push(img);
  }
  return images.length ? { status: "ok", images } : { status: "not_found" };
}

/** One provider's answer, as the merge sees it. */
export interface ContextImageBatch {
  /** `pluginId:providerId`, or `gallery:<typeId>` for an adapted gallery. */
  providerKey: string;
  providerName: string;
  /** The provider's place in the user's order — breaks ties. */
  order: number;
  images: ContextImage[];
}

export interface RankedContextImage extends ContextImage {
  providerKey: string;
  providerName: string;
}

/**
 * Every provider's pictures as one list: best `relevance` first; among equal
 * fits, each provider's own order dealt round-robin (its first picture, then
 * the next provider's first, …), so a prolific source doesn't bury another;
 * then the user's provider order. The same picture twice is kept once.
 */
export function rankContextImages(batches: readonly ContextImageBatch[], cap = CONTEXT_IMAGE_TOTAL_CAP): RankedContextImage[] {
  const all: Array<{ img: RankedContextImage; score: number; pos: number; order: number }> = [];
  for (const b of batches) {
    b.images.forEach((img, pos) => {
      all.push({
        img: { ...img, providerKey: b.providerKey, providerName: b.providerName },
        score: img.relevance ?? DEFAULT_RELEVANCE,
        pos,
        order: b.order,
      });
    });
  }
  all.sort((a, b) => b.score - a.score || a.pos - b.pos || a.order - b.order);
  const seen = new Set<string>();
  const out: RankedContextImage[] = [];
  for (const { img } of all) {
    if (seen.has(img.url)) continue;
    seen.add(img.url);
    out.push(img);
    if (out.length >= cap) break;
  }
  return out;
}

/** One credit line: who took it, when, and where it's from — without saying
 *  the same name twice (Commons puts the author in `source` already). */
export function contextImageCredit(img: Pick<ContextImage, "author" | "source" | "year">): string | null {
  const { author, source } = img;
  const year = img.year !== undefined ? String(img.year) : null;
  const parts: string[] = [];
  if (author && !source?.includes(author)) parts.push(author);
  if (year && !source?.includes(year)) parts.push(year);
  if (source) parts.push(source);
  return parts.length ? parts.join(" · ") : null;
}

/** A track's release year: its library copy's, else its album's. Null when
 *  the library has none — the provider may look it up itself. */
export async function resolveTrackYear(track: QueueTrack): Promise<number | null> {
  const fromRow = (t: Track | null | undefined) => plausibleYear(t?.year ?? undefined) ?? null;
  try {
    if (track.libraryId != null) {
      const row = await invoke<Track | null>("get_track_by_id", { trackId: track.libraryId });
      const y = fromRow(row);
      if (y !== null) return y;
    } else {
      const row = await invoke<Track | null>("find_track_by_metadata", {
        title: track.title, artistName: track.artist_name ?? null, albumName: track.album_title ?? null,
      });
      const y = fromRow(row);
      if (y !== null) return y;
    }
    if (track.album_title) {
      const album = await invoke<Album | null>("find_album_by_name", {
        title: track.album_title, artistName: track.album_artist_name ?? track.artist_name ?? null,
      });
      return plausibleYear(album?.year ?? undefined) ?? null;
    }
  } catch (e) {
    console.error("Failed to read the track's year for context images:", e);
  }
  return null;
}

/** The request for a track. */
export function trackContextRequest(
  track: QueueTrack,
  year: number | null,
  purpose: ContextImageRequest["purpose"],
  limit: number,
): ContextImageRequest {
  const albumArtistName = track.album_artist_name ?? track.artist_name ?? null;
  return {
    subject: "track",
    track: {
      title: track.title,
      artistName: track.artist_name ?? null,
      albumTitle: track.album_title ?? null,
      albumArtistName,
      year,
      durationSecs: track.duration_secs ?? null,
    },
    ...(track.artist_name ? { artist: { name: track.artist_name } } : {}),
    ...(track.album_title ? { album: { title: track.album_title, artistName: albumArtistName, year } } : {}),
    purpose,
    limit: Math.min(CONTEXT_IMAGE_LIMIT_MAX, Math.max(1, Math.floor(limit))),
  };
}

/** Identity of a request for the session cache: everything a provider is told. */
export function contextRequestKey(req: ContextImageRequest): string {
  return JSON.stringify([req.subject, req.track, req.artist, req.album, req.purpose, req.limit]);
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 300;
const cache = new Map<string, { at: number; result: ContextImageResult }>();

/** A provider's answer for this request, from this session's cache — so a
 *  replay, or Photos picked again, asks nobody. Only answers are kept;
 *  errors are asked again. */
function cached(key: string, now: number): ContextImageResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.result;
}

function remember(key: string, result: ContextImageResult, now: number): void {
  if (result.status === "error") return;
  cache.delete(key);
  cache.set(key, { at: now, result });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

/** Tests only. */
export function clearContextImageCache(): void {
  cache.clear();
}

/** Info types whose plugin also declares a context-image provider. That
 *  provider speaks for the plugin's pictures (it is told the context), so its
 *  old gallery types are left out of the adapter — the same photos would
 *  otherwise come twice, once ranked and once not. */
export function typesSpokenForByProviders(
  plugins: ReadonlyArray<{
    manifest: { contributes?: { informationTypes?: Array<{ id: string }>; contextImageProviders?: unknown[] } };
  }>,
): Set<string> {
  const ids = new Set<string>();
  for (const p of plugins) {
    const c = p.manifest.contributes;
    if (!c?.contextImageProviders?.length) continue;
    for (const t of c.informationTypes ?? []) ids.add(t.id);
  }
  return ids;
}

const GALLERY_ABOUT: Record<GalleryAbout, ContextImageAbout> = { song: "track", artist: "artist", album: "album" };

/** An old-style gallery as a context-free provider's batch. */
export function galleryBatch(g: TrackGallery, order: number): ContextImageBatch {
  return {
    providerKey: `gallery:${g.typeId}`,
    providerName: g.name,
    order,
    images: g.images.map((img) => ({ ...img, about: GALLERY_ABOUT[g.about] })),
  };
}

export interface GatherContextImagesOpts {
  track: QueueTrack;
  purpose: ContextImageRequest["purpose"];
  limit: number;
  /** Switched-on providers, in the user's order. */
  providers: readonly OrderedContextImageProvider[];
  invokeProvider: (pluginId: string, providerId: string, request: ContextImageRequest) => Promise<ContextImageResult>;
  /** The old-style galleries: what `gatherTrackGalleries` needs, plus the
   *  info types to leave out because their plugin declares a provider. */
  legacy?: {
    invokeInfoFetch: InvokeInfoFetch;
    pluginNames?: Map<string, string>;
    imageTypeIds?: ReadonlySet<string>;
    excludeTypeIds?: ReadonlySet<string>;
  };
  /** Each provider's answer, as it lands — one slow source must not hold up
   *  the rest. Called only for answers with pictures. */
  onBatch: (batch: ContextImageBatch) => void;
  /** Called with a provider's failure (for logs / the cue context). */
  onError?: (providerName: string, message: string) => void;
  isCancelled?: () => boolean;
  now?: () => number;
}

/** Ask every switched-on provider (and adapt the old galleries) at once.
 *  Resolves when all have settled; answers arrive through `onBatch`. */
export async function gatherContextImages(opts: GatherContextImagesOpts): Promise<void> {
  const now = opts.now ?? Date.now;
  const year = await resolveTrackYear(opts.track);
  if (opts.isCancelled?.()) return;
  const request = trackContextRequest(opts.track, year, opts.purpose, opts.limit);
  const requestKey = contextRequestKey(request);

  const asked = opts.providers.filter((p) => p.enabled).map(async (p, order) => {
    const key = `${p.key}|${requestKey}`;
    let result = cached(key, now());
    if (!result) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      result = await Promise.race([
        opts.invokeProvider(p.pluginId, p.providerId, request),
        new Promise<ContextImageResult>((resolve) => {
          timer = setTimeout(() => resolve({ status: "error", message: "timed out" }), CONTEXT_IMAGE_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      remember(key, result, now());
    }
    if (opts.isCancelled?.()) return;
    if (result.status === "ok") opts.onBatch({ providerKey: p.key, providerName: p.name, order, images: result.images });
    else if (result.status === "error") opts.onError?.(p.name, result.message ?? "failed");
  });

  const legacy = opts.legacy;
  const galleries = legacy
    ? gatherTrackGalleries({
      track: opts.track,
      invokeInfoFetch: legacy.invokeInfoFetch,
      pluginNames: legacy.pluginNames,
      imageTypeIds: legacy.imageTypeIds,
      excludeTypeIds: legacy.excludeTypeIds,
      isCancelled: opts.isCancelled,
      // After every declared provider in the order: they asked for the context.
      onGallery: (g) => opts.onBatch(galleryBatch(g, opts.providers.length + 1)),
    })
    : Promise.resolve();

  await Promise.all([...asked, galleries]);
}
