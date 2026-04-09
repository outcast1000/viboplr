import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Album, Track, Artist } from "../types";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { stripAccents } from "../utils";

export interface UseArtistInfoReturn {
  trackPopularity: Record<number, number>;
  albumTrackPopularity: Record<number, number>;
  artistTrackPopularity: Record<number, number>;
  refreshInfo: () => void;
}

const normalizeTitle = (s: string) => stripAccents(s.toLowerCase().replace(/\([^)]*\)/g, "").trim()).replace(/[^a-z0-9]/g, "");

// Backend returns: [type_id, name, display_kind, ttl, sort_order, providers: [plugin_id, integer_id][]]
type BackendTypeRow = [string, string, string, number, number, Array<[string, number]>];

/**
 * Discovers ranked_list info types dynamically and fetches track popularity
 * with provider fallback. No hardcoded plugin IDs or type IDs.
 */
export function useArtistInfo(deps: {
  selectedArtist: number | null;
  selectedAlbum: number | null;
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
  invokeInfoFetch: (pluginId: string, infoTypeId: string, entity: InfoEntity) => Promise<InfoFetchResult>;
}): UseArtistInfoReturn {
  const [albumTrackPopularity, setAlbumTrackPopularity] = useState<Record<number, number>>({});
  const [artistTrackPopularity, setArtistTrackPopularity] = useState<Record<number, number>>({});

  const trackPopularity = Object.keys(albumTrackPopularity).length > 0 ? albumTrackPopularity : artistTrackPopularity;

  // Fetch album track popularity when selected album changes
  useEffect(() => {
    setAlbumTrackPopularity({});
    if (deps.selectedAlbum === null) return;
    const album = deps.albums.find(a => a.id === deps.selectedAlbum);
    if (!album) return;
    const artistName = deps.artists.find(a => a.id === album.artist_id)?.name;
    if (!artistName) return;

    let cancelled = false;
    (async () => {
      // Discover ranked_list types for album entity
      const types = await invoke<BackendTypeRow[]>("info_get_types_for_entity", { entity: "album" });
      const rankedType = types.find(([, , displayKind]) => displayKind === "ranked_list");
      if (!rankedType || cancelled) return;

      const [typeId, , , , , providers] = rankedType;
      const entity: InfoEntity = { kind: "album", name: album.title, id: album.id, artistName };

      // Try providers in priority order (fallback chain)
      for (const [pluginId] of providers) {
        if (cancelled) return;
        try {
          const result = await deps.invokeInfoFetch(pluginId, typeId, entity);
          if (cancelled || result.status !== "ok") continue;
          const items = (result.value as any)?.items as Array<{ name: string; value: number }> | undefined;
          if (!items) continue;
          const popMap: Record<number, number> = {};
          for (const item of items) {
            const norm = normalizeTitle(item.name);
            const match = deps.tracks.find(t => normalizeTitle(t.title) === norm);
            if (match && item.value > 0) popMap[match.id] = item.value;
          }
          setAlbumTrackPopularity(popMap);
          return; // Success — stop trying providers
        } catch { continue; }
      }
    })();
    return () => { cancelled = true; };
  }, [deps.selectedAlbum, deps.albums, deps.artists, deps.tracks, deps.invokeInfoFetch]);

  // Fetch artist top tracks popularity when selected artist changes (no album selected)
  useEffect(() => {
    setArtistTrackPopularity({});
    if (deps.selectedArtist === null || deps.selectedAlbum !== null) return;
    const artist = deps.artists.find(a => a.id === deps.selectedArtist);
    if (!artist) return;

    let cancelled = false;
    (async () => {
      // Discover ranked_list types for artist entity
      const types = await invoke<BackendTypeRow[]>("info_get_types_for_entity", { entity: "artist" });
      const rankedType = types.find(([, , displayKind]) => displayKind === "ranked_list");
      if (!rankedType || cancelled) return;

      const [typeId, , , , , providers] = rankedType;
      const entity: InfoEntity = { kind: "artist", name: artist.name, id: artist.id };

      for (const [pluginId] of providers) {
        if (cancelled) return;
        try {
          const result = await deps.invokeInfoFetch(pluginId, typeId, entity);
          if (cancelled || result.status !== "ok") continue;
          const items = (result.value as any)?.items as Array<{ name: string; value: number }> | undefined;
          if (!items) continue;
          const popMap: Record<number, number> = {};
          for (const item of items) {
            const norm = normalizeTitle(item.name);
            const match = deps.tracks.find(t => normalizeTitle(t.title) === norm);
            if (match && item.value > 0) popMap[match.id] = item.value;
          }
          setArtistTrackPopularity(popMap);
          return;
        } catch { continue; }
      }
    })();
    return () => { cancelled = true; };
  }, [deps.selectedArtist, deps.selectedAlbum, deps.artists, deps.tracks, deps.invokeInfoFetch]);

  const refreshInfo = () => {
    // No-op — info types handle their own caching/refresh
  };

  return {
    trackPopularity,
    albumTrackPopularity,
    artistTrackPopularity,
    refreshInfo,
  };
}
