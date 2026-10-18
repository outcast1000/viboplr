import type { PluginSearchAlbum, PluginSearchArtist, PluginSearchResult, PluginSearchTrack } from "../types/plugin";

/** Longest `snippet` a result row keeps — one line of a dropdown. */
export const SEARCH_SNIPPET_MAX = 160;

/** A catalog answer with all three lists present (possibly empty). */
export type NormalizedSearchResult =
  | { status: "ok"; tracks: PluginSearchTrack[]; artists: PluginSearchArtist[]; albums: PluginSearchAlbum[] }
  | { status: "empty" }
  | { status: "error"; message?: string };

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const optString = (v: unknown): string | null => (nonEmpty(v) ? v : null);

function list<T>(raw: unknown, keep: (item: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const kept = keep(item as Record<string, unknown>);
    if (kept) out.push(kept);
  }
  return out;
}

/**
 * Make a provider's answer safe to render, once, where the host receives it —
 * so the dropdown, the control API and plugin-to-plugin callers all see the
 * same shape. A provider is plugin code: a row without a name would crash the
 * dropdown, and a result whose every list is empty is a miss, not "ok".
 * `artists` / `albums` are newer than `tracks`, so absent means none.
 */
export function normalizeSearchResult(raw: PluginSearchResult | null | undefined): NormalizedSearchResult {
  if (!raw || typeof raw !== "object") return { status: "empty" };
  if (raw.status === "error") return { status: "error", message: optString(raw.message) ?? undefined };
  if (raw.status !== "ok") return { status: "empty" };

  const tracks = list<PluginSearchTrack>(raw.tracks, (t) => {
    if (!nonEmpty(t.title)) return null;
    const track = t as unknown as PluginSearchTrack;
    const snippet = optString(t.snippet);
    if (snippet === null) return track.snippet == null ? track : { ...track, snippet: null };
    const flat = snippet.replace(/\s+/g, " ").trim();
    return {
      ...track,
      snippet: flat.length > SEARCH_SNIPPET_MAX ? flat.slice(0, SEARCH_SNIPPET_MAX - 1) + "…" : flat,
    };
  });
  const artists = list<PluginSearchArtist>(raw.artists, (a) =>
    nonEmpty(a.name) ? { name: a.name, image_url: optString(a.image_url), subtitle: optString(a.subtitle) } : null,
  );
  const albums = list<PluginSearchAlbum>(raw.albums, (a) =>
    nonEmpty(a.title)
      ? { title: a.title, artist_name: optString(a.artist_name), image_url: optString(a.image_url) }
      : null,
  );
  if (tracks.length + artists.length + albums.length === 0) return { status: "empty" };
  return { status: "ok", tracks, artists, albums };
}
