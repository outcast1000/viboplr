import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";
import type { NowPlayingInfoResult, PluginTrack } from "../types/plugin";
import { isLocalTrack, parseUrlScheme } from "../queueEntry";
import { formatDuration } from "../utils";

interface AudioProps { sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number }

// Per-item fetch budget. Slow handlers (e.g. a plugin hitting the network) are
// treated as "error" for that track and the item simply doesn't appear that
// cycle. Mirrors the Home-shelf timeout (`useHome.ts`).
const TIMEOUT_MS = 5_000;

export const NOW_PLAYING_ARTIST_ALBUM_ID = "builtin:artist-album";

/** A piece of the rendered info line. `nav` makes the segment a clickable link
 *  (artist/album navigation); `badge` renders a trailing rank chip (e.g. #12). */
export interface NowPlayingInfoSegment {
  text: string;
  nav?: { kind: "artist" | "album"; name: string; artistName?: string };
  badge?: number | null;
}

/** A fully-resolved info item ready to display (one "card" in the cycle). */
export interface NowPlayingInfoResolved {
  id: string;
  segments: NowPlayingInfoSegment[];
}

/** A registered item, shown as a checkbox in the context-menu checklist.
 *  `defaultEnabled` decides whether it's on before the user customizes. */
export interface NowPlayingInfoDescriptor {
  id: string;
  label: string;
  defaultEnabled: boolean;
}

// Built-in items contributed by the core app, in display order. Each declares
// its own default-enabled state; only Artist · Album is on by default (plus the
// Last.fm plugin's Scrobbles). Plays and rank share one item (rank is derived
// from the play count) — it shows e.g. "142 plays · #12".
const BUILTIN_DESCRIPTORS: NowPlayingInfoDescriptor[] = [
  { id: NOW_PLAYING_ARTIST_ALBUM_ID, label: "Artist · Album", defaultEnabled: true },
  { id: "builtin:artist", label: "Artist", defaultEnabled: false },
  { id: "builtin:album", label: "Album", defaultEnabled: false },
  { id: "builtin:plays-rank", label: "Plays · Rank", defaultEnabled: false },
  { id: "builtin:source", label: "Source", defaultEnabled: false },
  { id: "builtin:quality", label: "Quality", defaultEnabled: false },
  { id: "builtin:duration", label: "Duration", defaultEnabled: false },
  { id: "builtin:tags", label: "Tags", defaultEnabled: false },
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
}

export function useNowPlayingInfo({
  currentTrack,
  trackRank,
  artistRank,
  pluginItems,
  invokeNowPlayingInfo,
  selection,
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

  const [resolvedItems, setResolvedItems] = useState<NowPlayingInfoResolved[]>([]);
  const genRef = useRef(0);

  // A stable signature so the resolve effect only re-runs when something it
  // actually reads changes (track identity, ranks, the enabled set).
  const selectionSig = availableItems
    .filter((d) => isNowPlayingItemSelected(d.id, selection, availableItems))
    .map((d) => d.id)
    .join("|");
  const trackSig = currentTrack
    ? `${currentTrack.key}|${currentTrack.title}|${currentTrack.artist_name ?? ""}|${currentTrack.album_title ?? ""}`
    : "";

  useEffect(() => {
    const gen = ++genRef.current;
    const track = currentTrack;
    if (!track) {
      setResolvedItems([]);
      return;
    }
    const enabled = availableItems.filter((d) => isNowPlayingItemSelected(d.id, selection, availableItems));

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
        setResolvedItems(results.filter((r): r is NowPlayingInfoResolved => r !== null));
      })
      .catch((e) => console.error("Failed to resolve now-playing info:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackSig, selectionSig, trackRank, artistRank, availableItems, invokeNowPlayingInfo]);

  return { availableItems, resolvedItems };
}
