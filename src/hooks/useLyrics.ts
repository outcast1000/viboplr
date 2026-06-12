import { useMemo } from "react";
import { useInformationTypes } from "./useInformationTypes";
import type { InfoEntity, InfoFetchResult, LyricsData } from "../types/informationTypes";
import type { QueueTrack } from "../types";

export type LyricsStatus = "loading" | "loaded" | "empty";

export interface UseLyricsResult {
  data: LyricsData | null;
  status: LyricsStatus;
}

interface UseLyricsOpts {
  track: QueueTrack | null;
  /** When false, no fetch is performed (e.g. the Now Playing view is not open). */
  enabled?: boolean;
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
    onFetchUrl?: (url: string) => void,
  ) => Promise<InfoFetchResult>;
  pluginNames?: Map<string, string>;
}

const LYRICS_ONLY = ["lyrics"];

/**
 * Fetch synced/plain lyrics for the current track via the same plugin info-type
 * provider chain + cache that powers the track-detail Lyrics tab. This reuses
 * `useInformationTypes` with an `include` filter so there is no duplicate
 * fetch/cache/dedup logic — we just pull out the single "lyrics" section.
 *
 * Keying is name-based (`track:{artist}:{title}`), so it works for QueueTrack
 * (which has no DB id).
 */
export function useLyrics({ track, enabled = true, invokeInfoFetch, pluginNames }: UseLyricsOpts): UseLyricsResult {
  const entity: InfoEntity | null = useMemo(() => {
    if (!enabled || !track?.title) return null;
    return {
      kind: "track",
      name: track.title,
      id: 0,
      artistName: track.artist_name ?? "",
      albumTitle: track.album_title ?? "",
    };
  }, [enabled, track?.title, track?.artist_name, track?.album_title]);

  const { sections } = useInformationTypes({
    entity,
    include: LYRICS_ONLY,
    invokeInfoFetch,
    pluginNames,
  });

  return useMemo<UseLyricsResult>(() => {
    const section = sections.find((s) => s.typeId === "lyrics");
    if (!section) return { data: null, status: "empty" };
    if (section.state.kind === "loading") return { data: null, status: "loading" };
    if (section.state.kind === "loaded") {
      const d = section.state.data as LyricsData | null;
      return d?.text ? { data: d, status: "loaded" } : { data: null, status: "empty" };
    }
    return { data: null, status: "empty" };
  }, [sections]);
}
