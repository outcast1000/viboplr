import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";
import type { NowPlayingInfoResult, PluginTrack } from "../types/plugin";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { isLocalTrack, parseUrlScheme } from "../queueEntry";
import { formatDuration } from "../utils";
import { useLyrics } from "./useLyrics";
import { parseLrc, syncedLineAt, plainLines, pickLineByRatio, hashStringToRatio } from "../utils/lyrics";

interface AudioProps { sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number }

// Per-item fetch budget. Slow handlers (e.g. a plugin hitting the network) are
// treated as "error" for that track and the item simply doesn't appear that
// cycle. Mirrors the Home-shelf timeout (`useHome.ts`).
const TIMEOUT_MS = 5_000;

export const NOW_PLAYING_ARTIST_ALBUM_ID = "builtin:artist-album";
export const NOW_PLAYING_LYRICS_SYNCED_ID = "builtin:lyrics-synced";
export const NOW_PLAYING_LYRICS_PLAIN_ID = "builtin:lyrics-plain";

// Lyrics items are resolved synchronously from cached lyrics data (so the synced
// "current line" can update with playback position) — they bypass the async
// resolve pipeline below.
const LYRICS_IDS = new Set<string>([NOW_PLAYING_LYRICS_SYNCED_ID, NOW_PLAYING_LYRICS_PLAIN_ID]);

/** A piece of the rendered info line. `nav` makes the segment a clickable link
 *  (artist/album navigation); `badge` renders a trailing rank chip (e.g. #12). */
export interface NowPlayingInfoSegment {
  text: string;
  nav?: { kind: "artist" | "album"; name: string; artistName?: string };
  badge?: number | null;
}

/** Designer-controlled visual style for an item type (skin-safe by construction:
 *  `role` resolves to a skin color token in the cycler, never a hardcoded color).
 *  Emphasis (`bold`/`italic`) is independent of `role`. */
export interface NowPlayingInfoStyle {
  bold?: boolean;
  italic?: boolean;
  role?: "muted" | "accent";
}

/** A fully-resolved info item ready to display (one "card" in the cycle). */
export interface NowPlayingInfoResolved {
  id: string;
  segments: NowPlayingInfoSegment[];
  /** Time-of-persistence multiplier (one of NOW_PLAYING_TOP_PRESETS): how many
   *  base cycle intervals this item dwells before the cycler advances. Set in
   *  `resolvedItems`; the cycler treats a missing value as 1. */
  top?: number;
  /** Built-in per-type style (see NOW_PLAYING_STYLES). Set in `resolvedItems`;
   *  a missing value renders with the default (inherited) style. */
  style?: NowPlayingInfoStyle;
}

/** Allowed time-of-persistence multipliers. 0 = "preview only" (shown once in
 *  the opening preview pass, then dropped from the steady rotation); 1 = the
 *  base interval (current behavior); 10 = ten times longer on screen. Used by
 *  the per-item submenu. */
export const NOW_PLAYING_TOP_PRESETS = [0, 1, 2, 5, 10] as const;

/** The Last.fm plugin's Now Playing info item, keyed `${pluginId}:${itemId}`.
 *  Named here so the host can ship a sensible default ToP + style for it (the
 *  app already hardcodes per-plugin defaults elsewhere, e.g. provider priority). */
export const NOW_PLAYING_SCROBBLES_ID = "lastfm:scrobbles";

/** Built-in default time-of-persistence per item (before any user override).
 *  Items not listed default to 1 (the base interval). */
const NOW_PLAYING_DEFAULT_TOP: Record<string, number> = {
  [NOW_PLAYING_LYRICS_SYNCED_ID]: 5, // lyrics linger and advance line-by-line
  [NOW_PLAYING_SCROBBLES_ID]: 0, // preview-only: a quick stat at each track change
};

/** Time-of-persistence multiplier for an item — the user's override if it's a
 *  valid preset, else the item's built-in default, else 1. Pure + for tests. */
export function nowPlayingItemTop(id: string, persistence: Record<string, number>): number {
  const v = persistence[id];
  if (v != null && (NOW_PLAYING_TOP_PRESETS as readonly number[]).includes(v)) return v;
  return NOW_PLAYING_DEFAULT_TOP[id] ?? 1;
}

/** Built-in per-type styling. Skin-safe by construction: `role` resolves to a
 *  skin color token in the cycler, never a hardcoded color. Items not listed
 *  render with the default (inherited) style. */
const NOW_PLAYING_STYLES: Record<string, NowPlayingInfoStyle> = {
  "builtin:plays-rank": { role: "accent" }, // a play stat → highlight
  [NOW_PLAYING_SCROBBLES_ID]: { role: "accent" }, // also a play stat
  "builtin:source": { role: "muted" },
  "builtin:quality": { role: "muted" },
  "builtin:duration": { role: "muted" },
  "builtin:tags": { role: "muted" },
  [NOW_PLAYING_LYRICS_SYNCED_ID]: { italic: true }, // quoted/sung text
  [NOW_PLAYING_LYRICS_PLAIN_ID]: { italic: true },
};

/** Built-in per-type style for an item, or undefined when it has no special
 *  styling (renders with the inherited default). Pure + exported for tests. */
export function nowPlayingItemStyle(id: string): NowPlayingInfoStyle | undefined {
  return NOW_PLAYING_STYLES[id];
}

/** Space-joined CSS class list for an item style, using the skin-token-backed
 *  `.npi--*` classes (defined in base.css). Empty string for the default style.
 *  Pure + exported for tests. */
export function nowPlayingStyleClass(style: NowPlayingInfoStyle | undefined): string {
  if (!style) return "";
  const cls: string[] = [];
  if (style.bold) cls.push("npi--bold");
  if (style.italic) cls.push("npi--italic");
  if (style.role === "muted") cls.push("npi--muted");
  if (style.role === "accent") cls.push("npi--accent");
  return cls.join(" ");
}

/** The steady-rotation order: items with a positive ToP (top > 0), sorted by ToP
 *  descending so the longest-dwelling items lead the cycle. "Preview only"
 *  (top === 0) items are dropped. Stable for equal ToP (keeps display order).
 *  Pure + exported for tests. */
export function nowPlayingSteadyOrder<T extends { top?: number }>(items: T[]): T[] {
  return items
    .map((it, i) => ({ it, i, top: it.top ?? 1 }))
    .filter((e) => e.top > 0)
    .sort((a, b) => b.top - a.top || a.i - b.i)
    .map((e) => e.it);
}

/** A registered item, shown as a checkbox in the context-menu checklist.
 *  `defaultEnabled` decides whether it's on before the user customizes. */
export interface NowPlayingInfoDescriptor {
  id: string;
  label: string;
  defaultEnabled: boolean;
}

// Built-in items contributed by the core app, in display order. Each declares
// its own default-enabled state; Artist · Album and Synced Lyrics are on by
// default (plus the Last.fm plugin's Scrobbles). Plays and rank share one item
// (rank is derived from the play count) — it shows e.g. "142 plays · #12".
const BUILTIN_DESCRIPTORS: NowPlayingInfoDescriptor[] = [
  { id: NOW_PLAYING_ARTIST_ALBUM_ID, label: "Artist · Album", defaultEnabled: true },
  { id: "builtin:artist", label: "Artist", defaultEnabled: false },
  { id: "builtin:album", label: "Album", defaultEnabled: false },
  { id: "builtin:plays-rank", label: "Plays · Rank", defaultEnabled: false },
  { id: "builtin:source", label: "Source", defaultEnabled: false },
  { id: "builtin:quality", label: "Quality", defaultEnabled: false },
  { id: "builtin:duration", label: "Duration", defaultEnabled: false },
  { id: "builtin:tags", label: "Tags", defaultEnabled: false },
  // Synced Lyrics is on by default (at 5× ToP, italic — see NOW_PLAYING_DEFAULT_TOP
  // / NOW_PLAYING_STYLES). Lyrics only fetch when a lyrics item is enabled, so this
  // makes the default experience fetch lyrics for each track.
  { id: NOW_PLAYING_LYRICS_SYNCED_ID, label: "Synced Lyrics", defaultEnabled: true },
  { id: NOW_PLAYING_LYRICS_PLAIN_ID, label: "Plain Lyrics", defaultEnabled: false },
];

/** Whether an item is enabled: the user's explicit choice if any, else the
 *  item's own registered default. Pure + exported for tests. */
export function isNowPlayingItemSelected(
  id: string,
  selection: Record<string, boolean>,
  items: NowPlayingInfoDescriptor[],
): boolean {
  return selection[id] ?? items.find((d) => d.id === id)?.defaultEnabled ?? false;
}

/** Format a play count, or null when there's nothing worth showing. Pure +
 *  exported for tests. */
export function formatPlays(count: number | null | undefined): string | null {
  if (count == null || count <= 0) return null;
  return count === 1 ? "1 play" : `${count.toLocaleString()} plays`;
}

/** Advance a cycle index, wrapping at `len`. Pure + exported for tests. */
export function nextCycleIndex(i: number, len: number): number {
  return len <= 0 ? 0 : (i + 1) % len;
}

/** Human-readable playback source from a track path, or null if unknown. Pure +
 *  exported for tests. */
export function formatSource(path: string | null | undefined): string | null {
  if (!path) return null;
  const parsed = parseUrlScheme(path);
  if (parsed.scheme === "file") return "Local";
  if (parsed.scheme === "subsonic") return "Subsonic";
  if (parsed.scheme === "external") return "External";
  const proto = parsed.protocol;
  if (proto === "http" || proto === "https") return "Web";
  return proto ? proto.charAt(0).toUpperCase() + proto.slice(1) : null;
}

/** Compact audio-quality string (e.g. "FLAC · 44.1 kHz · 16-bit", "MP3 · 320 kbps"),
 *  or null when nothing is known. Pure + exported for tests. */
export function formatQuality(format: string | null | undefined, props: AudioProps | null): string | null {
  const parts: string[] = [];
  if (format) parts.push(format.toUpperCase());
  if (props?.bit_depth && props?.sample_rate) {
    parts.push(`${(props.sample_rate / 1000).toFixed(1)} kHz · ${props.bit_depth}-bit`);
  } else if (props?.bitrate) {
    parts.push(`${props.bitrate} kbps`);
  } else if (props?.sample_rate) {
    parts.push(`${(props.sample_rate / 1000).toFixed(1)} kHz`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Compact tag line (e.g. "#rock · #jazz"), or null when there are no tags.
 *  Pure + exported for tests. */
export function formatTags(names: string[] | null | undefined): string | null {
  if (!names || names.length === 0) return null;
  return names.map((t) => `#${t}`).join(" · ");
}

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), TIMEOUT_MS)),
  ]);
}

function artistSegment(track: QueueTrack, badge?: number | null): NowPlayingInfoSegment {
  const name = track.artist_name || "Unknown";
  return {
    text: name,
    nav: track.artist_name ? { kind: "artist", name: track.artist_name } : undefined,
    badge,
  };
}

function albumSegment(track: QueueTrack): NowPlayingInfoSegment | null {
  if (!track.album_title) return null;
  return {
    text: track.album_title,
    nav: { kind: "album", name: track.album_title, artistName: track.artist_name ?? undefined },
  };
}

interface UseNowPlayingInfoArgs {
  currentTrack: QueueTrack | null;
  trackRank: number | null;
  artistRank: number | null;
  // Plugin-registered descriptors (from usePlugins, already priority-sorted).
  pluginItems: { pluginId: string; itemId: string; label: string; defaultEnabled: boolean }[];
  invokeNowPlayingInfo: (pluginId: string, itemId: string, track: PluginTrack) => Promise<NowPlayingInfoResult>;
  selection: Record<string, boolean>;
  // Per-item time-of-persistence multipliers (id → 1/2/5/10). Missing = 1.
  persistence: Record<string, number>;
  // Current playback position — drives the "current line" of the Synced Lyrics item.
  positionSecs: number;
  // Plugin info-type bridge — lyrics are fetched through the same cache/chain as
  // the track-detail Lyrics tab (via useLyrics), only when a lyrics item is on.
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
    onFetchUrl?: (url: string) => void,
  ) => Promise<InfoFetchResult>;
  pluginNames?: Map<string, string>;
  // True once all plugins have finished activating. Gating the lyrics fetch on
  // this avoids a startup race: the lyrics info-type row persists in the DB, so
  // the fetch fires the moment the restored track is set — but if the lyrics
  // plugin hasn't activated yet, the provider call returns "error", which gets
  // cached for an hour and suppresses lyrics for the track playing at launch.
  pluginsLoaded: boolean;
}

export function useNowPlayingInfo({
  currentTrack,
  trackRank,
  artistRank,
  pluginItems,
  invokeNowPlayingInfo,
  selection,
  persistence,
  positionSecs,
  invokeInfoFetch,
  pluginNames,
  pluginsLoaded,
}: UseNowPlayingInfoArgs): {
  availableItems: NowPlayingInfoDescriptor[];
  resolvedItems: NowPlayingInfoResolved[];
} {
  // Built-ins first, then plugin items (plugin id = `${pluginId}:${itemId}`).
  const availableItems = useMemo<NowPlayingInfoDescriptor[]>(
    () => [
      ...BUILTIN_DESCRIPTORS,
      ...pluginItems.map((p) => ({ id: `${p.pluginId}:${p.itemId}`, label: p.label, defaultEnabled: p.defaultEnabled })),
    ],
    [pluginItems],
  );

  // Async items (everything except lyrics) — resolved once per track/selection.
  const [asyncResolved, setAsyncResolved] = useState<NowPlayingInfoResolved[]>([]);
  const genRef = useRef(0);

  // Lyrics items resolve synchronously from cached lyrics data, so the synced
  // "current line" can track playback position without re-running the async
  // resolvers each tick. Only fetch when a lyrics item is actually enabled.
  const syncedEnabled = isNowPlayingItemSelected(NOW_PLAYING_LYRICS_SYNCED_ID, selection, availableItems);
  const plainEnabled = isNowPlayingItemSelected(NOW_PLAYING_LYRICS_PLAIN_ID, selection, availableItems);
  const { data: lyricsData } = useLyrics({
    track: currentTrack,
    // Wait for plugins so the first fetch reaches the (now-loaded) lyrics
    // provider instead of caching a spurious "plugin not loaded" error.
    enabled: pluginsLoaded && (syncedEnabled || plainEnabled),
    invokeInfoFetch,
    pluginNames,
  });

  const syncedLines = useMemo(
    () => (lyricsData?.kind === "synced" && lyricsData.text ? parseLrc(lyricsData.text) : null),
    [lyricsData],
  );
  const syncedText = useMemo(
    () => (syncedLines ? syncedLineAt(syncedLines, positionSecs) : null),
    [syncedLines, positionSecs],
  );
  // One line per track, stable across re-renders/cycles: pick by a hash of the
  // track + lyrics so it doesn't flicker, while still varying between songs.
  const plainText = useMemo(() => {
    if (!lyricsData?.text || lyricsData.kind !== "plain") return null;
    const lines = plainLines(lyricsData.text);
    return pickLineByRatio(lines, hashStringToRatio(`${currentTrack?.key ?? ""}:${lyricsData.text.length}`));
  }, [lyricsData, currentTrack?.key]);

  const lyricsResolved = useMemo<NowPlayingInfoResolved[]>(() => {
    const out: NowPlayingInfoResolved[] = [];
    if (syncedEnabled && syncedText) out.push({ id: NOW_PLAYING_LYRICS_SYNCED_ID, segments: [{ text: `“${syncedText}”` }] });
    if (plainEnabled && plainText) out.push({ id: NOW_PLAYING_LYRICS_PLAIN_ID, segments: [{ text: `“${plainText}”` }] });
    return out;
  }, [syncedEnabled, plainEnabled, syncedText, plainText]);

  // A stable signature so the resolve effect only re-runs when something it
  // actually reads changes (track identity, ranks, the enabled set). Lyrics ids
  // are excluded — they're resolved synchronously above, not in this effect.
  const selectionSig = availableItems
    .filter((d) => isNowPlayingItemSelected(d.id, selection, availableItems))
    .filter((d) => !LYRICS_IDS.has(d.id))
    .map((d) => d.id)
    .join("|");
  const trackSig = currentTrack
    ? `${currentTrack.key}|${currentTrack.title}|${currentTrack.artist_name ?? ""}|${currentTrack.album_title ?? ""}`
    : "";

  useEffect(() => {
    const gen = ++genRef.current;
    const track = currentTrack;
    if (!track) {
      setAsyncResolved([]);
      return;
    }
    const enabled = availableItems
      .filter((d) => isNowPlayingItemSelected(d.id, selection, availableItems))
      .filter((d) => !LYRICS_IDS.has(d.id));

    const pluginTrack: PluginTrack = {
      path: track.path,
      title: track.title,
      artist_name: track.artist_name,
      album_title: track.album_title,
      duration_secs: track.duration_secs,
    };

    const resolveOne = async (id: string): Promise<NowPlayingInfoResolved | null> => {
      if (id === NOW_PLAYING_ARTIST_ALBUM_ID) {
        const segments: NowPlayingInfoSegment[] = [
          artistSegment(track, artistRank != null && artistRank <= 100 ? artistRank : null),
        ];
        const album = albumSegment(track);
        if (album) segments.push(album);
        return { id, segments };
      }
      if (id === "builtin:artist") {
        return { id, segments: [artistSegment(track)] };
      }
      if (id === "builtin:album") {
        const album = albumSegment(track);
        return album ? { id, segments: [album] } : null;
      }
      if (id === "builtin:plays-rank") {
        try {
          const stats = await withTimeout(
            invoke<{ play_count: number } | null>("get_track_play_stats", {
              title: track.title,
              artistName: track.artist_name,
            }),
            null,
          );
          const parts: string[] = [];
          const plays = formatPlays(stats?.play_count);
          if (plays) parts.push(plays);
          if (trackRank != null && trackRank <= 100) parts.push(`#${trackRank}`);
          return parts.length > 0 ? { id, segments: [{ text: parts.join(" · ") }] } : null;
        } catch (e) {
          console.error("Failed to resolve plays/rank for now-playing info:", e);
          return null;
        }
      }
      if (id === "builtin:source") {
        const text = formatSource(track.path);
        return text ? { id, segments: [{ text }] } : null;
      }
      if (id === "builtin:duration") {
        return track.duration_secs ? { id, segments: [{ text: formatDuration(track.duration_secs) }] } : null;
      }
      if (id === "builtin:quality") {
        let props: AudioProps | null = null;
        if (track.path && isLocalTrack(track)) {
          try {
            props = await withTimeout(
              invoke<AudioProps | null>("get_audio_properties_by_path", { path: track.path }),
              null,
            );
          } catch (e) {
            console.error("Failed to resolve audio quality for now-playing info:", e);
          }
        }
        const text = formatQuality(track.format, props);
        return text ? { id, segments: [{ text }] } : null;
      }
      if (id === "builtin:tags") {
        // Tags only exist for library tracks; resolve the row by metadata, then
        // read its tags (same path the Now Playing bar's tag chips use).
        try {
          const lib = await withTimeout(
            invoke<{ id: number } | null>("find_track_by_metadata", {
              title: track.title,
              artistName: track.artist_name,
              albumName: track.album_title,
            }),
            null,
          );
          if (!lib) return null;
          const rows = await withTimeout(
            invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId: lib.id }),
            [] as Array<{ id: number; name: string }>,
          );
          const text = formatTags(rows.map((r) => r.name));
          return text ? { id, segments: [{ text }] } : null;
        } catch (e) {
          console.error("Failed to resolve tags for now-playing info:", e);
          return null;
        }
      }
      // Plugin item: id is `${pluginId}:${itemId}`.
      const sep = id.indexOf(":");
      if (sep <= 0) return null;
      const pluginId = id.slice(0, sep);
      const itemId = id.slice(sep + 1);
      try {
        const res = await withTimeout(invokeNowPlayingInfo(pluginId, itemId, pluginTrack), {
          status: "error",
          message: "timeout",
        } as NowPlayingInfoResult);
        if (res.status === "ok" && res.text.trim()) {
          return { id, segments: [{ text: res.text }] };
        }
        if (res.status === "error") {
          console.error(`Now-playing info "${id}" failed:`, res.message ?? "");
        }
        return null;
      } catch (e) {
        console.error(`Now-playing info "${id}" threw:`, e);
        return null;
      }
    };

    Promise.all(enabled.map((d) => resolveOne(d.id)))
      .then((results) => {
        if (gen !== genRef.current) return; // stale — a newer resolve started
        setAsyncResolved(results.filter((r): r is NowPlayingInfoResolved => r !== null));
      })
      .catch((e) => console.error("Failed to resolve now-playing info:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackSig, selectionSig, trackRank, artistRank, availableItems, invokeNowPlayingInfo]);

  // Merge async + lyrics items back into one list, ordered by availableItems and
  // gated by the current selection.
  const resolvedItems = useMemo<NowPlayingInfoResolved[]>(() => {
    const byId = new Map<string, NowPlayingInfoResolved>();
    for (const r of asyncResolved) byId.set(r.id, r);
    for (const r of lyricsResolved) byId.set(r.id, r);
    return availableItems
      .filter((d) => isNowPlayingItemSelected(d.id, selection, availableItems))
      .map((d): NowPlayingInfoResolved | undefined => {
        const r = byId.get(d.id);
        return r ? { ...r, top: nowPlayingItemTop(d.id, persistence), style: nowPlayingItemStyle(d.id) } : undefined;
      })
      .filter((r): r is NowPlayingInfoResolved => r !== undefined);
  }, [asyncResolved, lyricsResolved, availableItems, selection, persistence]);

  return { availableItems, resolvedItems };
}
