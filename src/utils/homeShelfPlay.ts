import type { HomeShelfDisplayKind, HomeShelfItem, PluginTrack } from "../types/plugin";

// Shape of the out-of-band radio seed the radio shelf stuffs onto its first track.
export interface RadioSeed {
  title: string;
  artist_name: string | null;
  image_url?: string | null;
}

// What "playing" a shelf item resolves to. The caller (App.tsx) maps each kind
// to a concrete play handler. `none` means the play button should not act
// (and should not be rendered).
export type ShelfPlayAction =
  | { kind: "album-id"; id: number }
  | { kind: "artist-id"; id: number }
  | { kind: "tracks"; tracks: PluginTrack[]; context?: { name: string; imagePath?: string | null; source?: string } }
  | { kind: "radio"; seed: RadioSeed; coverUrl?: string | null }
  | { kind: "none" };

export function resolveShelfPlayAction(
  displayKind: HomeShelfDisplayKind,
  item: HomeShelfItem,
): ShelfPlayAction {
  if (displayKind === "album-cards") {
    const it = item as { libraryId?: number; name: string; tracks?: PluginTrack[] };
    if (it.libraryId) return { kind: "album-id", id: it.libraryId };
    if (it.tracks?.length) return { kind: "tracks", tracks: it.tracks, context: { name: it.name } };
    return { kind: "none" };
  }
  if (displayKind === "artist-cards") {
    const it = item as { libraryId?: number };
    if (it.libraryId) return { kind: "artist-id", id: it.libraryId };
    return { kind: "none" };
  }
  if (displayKind === "playlist-cards") {
    const it = item as { name: string; coverUrl?: string | null; tracks: PluginTrack[] };
    const first = it.tracks?.[0] as unknown as { __radioSeed?: RadioSeed } | undefined;
    if (first?.__radioSeed) return { kind: "radio", seed: first.__radioSeed, coverUrl: it.coverUrl ?? null };
    return {
      kind: "tracks",
      tracks: it.tracks,
      context: { name: it.name, imagePath: it.coverUrl ?? null, source: "playlist" },
    };
  }
  // track-rows
  const it = item as { track: PluginTrack };
  return { kind: "tracks", tracks: [it.track] };
}
