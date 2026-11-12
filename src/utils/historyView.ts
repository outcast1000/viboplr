// Pure parts of the History view (components/HistoryView.tsx): its persisted
// settings, the time ranges, and how a history row becomes a queue entry.
// Kept out of the component so they're assertable without a webview
// (__tests__/historyView.test.ts).
import type { QueueTrack, ViewMode } from "../types";
import type { SortKey } from "../sortChain";
import { nextQueueKey } from "../queueEntry";

export type HistoryTab = "recent" | "tracks" | "artists";
export type HistoryRange = "30-days" | "year" | "all-time";

export const HISTORY_TABS: readonly HistoryTab[] = ["recent", "tracks", "artists"];

export const HISTORY_RANGES: { key: HistoryRange; label: string }[] = [
  { key: "30-days", label: "30 days" },
  { key: "year", label: "Year" },
  { key: "all-time", label: "All time" },
];

/** Rows per page. Same as the Library's track page. */
export const HISTORY_PAGE_SIZE = 50;

/** Persisted as the `historySettings` store key — the History view's
 *  counterpart to the Library's `searchSettings`. */
export interface HistorySettings {
  activeTab: HistoryTab;
  sortChains: Record<HistoryTab, SortKey[]>;
  /** One range for the whole view (owner decision, 2026-11-12): with a range
   *  per tab, the play log listed a song's 22 plays while the Tracks ranking
   *  counted the 2 of the last month, and nothing on screen said why. */
  range: HistoryRange;
  viewModes: Record<HistoryTab, ViewMode>;
  sortBarCollapsed: boolean;
}

/** Opens on the last 30 days, what the rankings always showed. */
export const DEFAULT_HISTORY_SETTINGS: HistorySettings = {
  activeTab: "recent",
  sortChains: { recent: [], tracks: [], artists: [] },
  range: "30-days",
  viewModes: { recent: "list", tracks: "list", artists: "list" },
  sortBarCollapsed: true,
};

const VIEW_MODES: readonly ViewMode[] = ["basic", "list", "tiles"];
const RANGE_KEYS: readonly HistoryRange[] = ["30-days", "year", "all-time"];

function isSortChain(v: unknown): v is SortKey[] {
  return Array.isArray(v) && v.every(k =>
    !!k && typeof k === "object"
    && typeof (k as SortKey).field === "string"
    && ((k as SortKey).dir === "asc" || (k as SortKey).dir === "desc"));
}

/** A saved `historySettings` value, taken field by field: anything missing or
 *  malformed falls back to its default, so a settings shape from an older or
 *  newer build never breaks the view. */
export function coerceHistorySettings(saved: unknown): HistorySettings {
  const d = DEFAULT_HISTORY_SETTINGS;
  if (!saved || typeof saved !== "object") return d;
  const s = saved as Partial<Record<keyof HistorySettings, unknown>>;
  const pick = <T>(rec: unknown, tab: HistoryTab, ok: (v: unknown) => v is T, fallback: T): T => {
    const v = rec && typeof rec === "object" ? (rec as Record<string, unknown>)[tab] : undefined;
    return ok(v) ? v : fallback;
  };
  const perTab = <T>(rec: unknown, ok: (v: unknown) => v is T, fallback: Record<HistoryTab, T>) =>
    ({
      recent: pick(rec, "recent", ok, fallback.recent),
      tracks: pick(rec, "tracks", ok, fallback.tracks),
      artists: pick(rec, "artists", ok, fallback.artists),
    });
  return {
    activeTab: HISTORY_TABS.includes(s.activeTab as HistoryTab) ? s.activeTab as HistoryTab : d.activeTab,
    sortChains: perTab(s.sortChains, isSortChain, d.sortChains),
    range: RANGE_KEYS.includes(s.range as HistoryRange) ? s.range as HistoryRange : d.range,
    viewModes: perTab(s.viewModes, (v): v is ViewMode => VIEW_MODES.includes(v as ViewMode), d.viewModes),
    sortBarCollapsed: typeof s.sortBarCollapsed === "boolean" ? s.sortBarCollapsed : d.sortBarCollapsed,
  };
}

/** The `sinceTs` a range sends (unix seconds), or null for all time. */
export function rangeSinceTs(range: HistoryRange, nowSecs: number = Math.floor(Date.now() / 1000)): number | null {
  if (range === "all-time") return null;
  return nowSecs - (range === "30-days" ? 30 : 365) * 86400;
}

/** The track-shaped fields every history row carries (Recent and Tracks). */
export interface HistoryTrackFields {
  display_title: string;
  display_artist: string | null;
  display_album: string | null;
  display_album_artist: string | null;
  display_path: string | null;
  display_track_id?: number | null;
  display_duration_secs?: number | null;
  display_format?: string | null;
}

/** A history row as a queue entry. With a library copy it carries that copy's
 *  row id and path, exactly like a library track converted at the queue's door
 *  (`trackToQueueTrack`); without one (a ghost play) it is metadata-only, and
 *  the stream resolvers find a source by title + artist at play time — the same
 *  entry a "Not in library" row makes. Either way the play needs no reconnect
 *  round-trip. */
export function historyQueueTrack(r: HistoryTrackFields): QueueTrack {
  return {
    key: nextQueueKey(),
    libraryId: r.display_track_id ?? null,
    path: r.display_path ?? null,
    title: r.display_title,
    artist_name: r.display_artist ?? null,
    album_title: r.display_album ?? null,
    album_artist_name: r.display_album_artist ?? null,
    duration_secs: r.display_duration_secs ?? null,
    format: r.display_format ?? null,
  };
}

/** "1 play" / "12 plays". */
export function playsLabel(n: number): string {
  return `${n} play${n === 1 ? "" : "s"}`;
}
