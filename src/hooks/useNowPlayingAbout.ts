import { useMemo } from "react";
import { useInformationTypes } from "./useInformationTypes";
import type { DisplayKind, InfoEntity, InfoFetchResult, InfoSection } from "../types/informationTypes";
import type { QueueTrack } from "../types";

/** The Now Playing view's About panel shows *reading* — a bio, an album review,
    a song's story — and nothing else. Lists (similar artists, top tracks, tags)
    are what the detail pages are for; on a lean-back surface they are noise.
    Filtering by display kind rather than by type id means any plugin that
    provides prose for an entity shows up here without the host naming it. */
export const ABOUT_DISPLAY_KINDS: DisplayKind[] = ["rich_text", "html", "annotated_text"];

export type AboutTabId = "song" | "artist" | "album";

export interface AboutEntry {
  typeId: string;
  name: string;
  displayKind: DisplayKind;
  data: unknown;
}

export interface AboutTab {
  id: AboutTabId;
  label: string;
  entries: AboutEntry[];
}

export interface NowPlayingAboutData {
  /** Only tabs that have text, in Song → Artist → Album order. A tab still
      waiting on its provider is not listed yet: offering one that then turns
      out empty would make the tab row appear and shrink under the pointer. */
  tabs: AboutTab[];
  /** Something may still arrive (a cache read or a provider is out). Lets the
      panel show a quiet placeholder instead of "nothing here" while it waits. */
  pending: boolean;
}

const TAB_LABELS: Record<AboutTabId, string> = { song: "Song", artist: "Artist", album: "Album" };

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

/** Does a loaded value actually carry text? A provider can answer `ok` with an
    empty summary (Last.fm does for obscure artists), and a tab whose only
    content is blank must not be offered. */
export function hasAboutText(displayKind: DisplayKind, data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  switch (displayKind) {
    case "rich_text":
      return typeof d.summary === "string" && stripTags(d.summary).length > 0;
    case "html":
      return typeof d.content === "string" && stripTags(d.content).length > 0;
    case "annotated_text": {
      const overview = typeof d.overview === "string" && stripTags(d.overview).length > 0;
      const sections = Array.isArray(d.sections) && d.sections.some(
        (s) => s && typeof (s as { text?: unknown }).text === "string" && stripTags((s as { text: string }).text).length > 0,
      );
      return overview || sections;
    }
    default:
      return false;
  }
}

/** One entity's sections → its tab (null when there is no text to offer) and
    whether a provider is still out for it. */
export function summarizeAboutTab(
  id: AboutTabId,
  sections: InfoSection[],
): { tab: AboutTab | null; loading: boolean } {
  const entries: AboutEntry[] = [];
  let loading = false;
  for (const s of sections) {
    if (s.state.kind === "loading") loading = true;
    else if (s.state.kind === "loaded" && hasAboutText(s.displayKind, s.state.data)) {
      entries.push({ typeId: s.typeId, name: s.name, displayKind: s.displayKind, data: s.state.data });
    }
  }
  return { tab: entries.length > 0 ? { id, label: TAB_LABELS[id], entries } : null, loading };
}

/** Combine the three entities. A not-yet-`ready` entity contributes nothing but
    `pending`: its `sections` may still describe the previous track. */
export function buildAboutData(
  parts: Array<{ id: AboutTabId; sections: InfoSection[]; ready: boolean }>,
): NowPlayingAboutData {
  const tabs: AboutTab[] = [];
  let pending = false;
  for (const p of parts) {
    if (!p.ready) { pending = true; continue; }
    const { tab, loading } = summarizeAboutTab(p.id, p.sections);
    if (tab) tabs.push(tab);
    if (loading) pending = true;
  }
  return { tabs, pending };
}

interface UseNowPlayingAboutOpts {
  track: QueueTrack | null;
  /** Fetch only while the panel is actually open — a closed panel must not cost
      three provider walks per track change. */
  enabled: boolean;
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
    onFetchUrl?: (url: string) => void,
  ) => Promise<InfoFetchResult>;
  pluginNames?: Map<string, string>;
}

/**
 * Song / artist / album prose for the current track, through the same info-type
 * provider chain + cache the detail pages use (so a bio the artist page already
 * fetched costs nothing here, and vice versa). Entities are name-keyed, which is
 * what lets a metadata-only `QueueTrack` resolve them.
 */
export function useNowPlayingAbout({ track, enabled, invokeInfoFetch, pluginNames }: UseNowPlayingAboutOpts): NowPlayingAboutData {
  const title = enabled ? track?.title ?? "" : "";
  const artist = enabled ? track?.artist_name ?? "" : "";
  const album = enabled ? track?.album_title ?? "" : "";
  // An album is keyed by its album artist (a compilation belongs to "Various
  // Artists"), the same rule every other album lookup from a track follows.
  const albumArtist = enabled ? track?.album_artist_name ?? track?.artist_name ?? "" : "";

  const songEntity = useMemo<InfoEntity | null>(
    () => (title ? { kind: "track", name: title, id: 0, artistName: artist, albumTitle: album } : null),
    [title, artist, album],
  );
  const artistEntity = useMemo<InfoEntity | null>(
    () => (artist ? { kind: "artist", name: artist, id: 0 } : null),
    [artist],
  );
  const albumEntity = useMemo<InfoEntity | null>(
    () => (album ? { kind: "album", name: album, id: 0, artistName: albumArtist } : null),
    [album, albumArtist],
  );

  const song = useInformationTypes({ entity: songEntity, includeKinds: ABOUT_DISPLAY_KINDS, invokeInfoFetch, pluginNames });
  const artistInfo = useInformationTypes({ entity: artistEntity, includeKinds: ABOUT_DISPLAY_KINDS, invokeInfoFetch, pluginNames });
  const albumInfo = useInformationTypes({ entity: albumEntity, includeKinds: ABOUT_DISPLAY_KINDS, invokeInfoFetch, pluginNames });

  return useMemo<NowPlayingAboutData>(
    // An absent entity (a track with no album) contributes nothing, whatever
    // its hook still holds from the previous track for the one render before
    // the reset lands.
    () => buildAboutData([
      { id: "song", sections: songEntity ? song.sections : [], ready: song.ready },
      { id: "artist", sections: artistEntity ? artistInfo.sections : [], ready: artistInfo.ready },
      { id: "album", sections: albumEntity ? albumInfo.sections : [], ready: albumInfo.ready },
    ]),
    [songEntity, artistEntity, albumEntity, song.sections, song.ready, artistInfo.sections, artistInfo.ready, albumInfo.sections, albumInfo.ready],
  );
}
