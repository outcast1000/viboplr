import { useEffect, useState } from "react";
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
    deps.invokeInfoFetch("lastfm", "album_track_popularity", {
      kind: "album", name: album.title, id: album.id, artistName,
    }).then(result => {
      if (cancelled || result.status !== "ok") return;
      const items = (result.value as any)?.items as Array<{ name: string; value: number }> | undefined;
      if (!items) return;
      const popMap: Record<number, number> = {};
      for (const item of items) {
        const norm = normalizeTitle(item.name);
        const match = deps.tracks.find(t => normalizeTitle(t.title) === norm);
        if (match && item.value > 0) {
          popMap[match.id] = item.value;
        }
      }
      setAlbumTrackPopularity(popMap);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [deps.selectedAlbum, deps.albums, deps.artists, deps.tracks, deps.invokeInfoFetch]);

  // Fetch artist top tracks popularity when selected artist changes (no album selected)
  useEffect(() => {
    setArtistTrackPopularity({});
    if (deps.selectedArtist === null || deps.selectedAlbum !== null) return;
    const artist = deps.artists.find(a => a.id === deps.selectedArtist);
    if (!artist) return;

    let cancelled = false;
    deps.invokeInfoFetch("lastfm", "artist_top_tracks", {
      kind: "artist", name: artist.name, id: artist.id,
    }).then(result => {
      if (cancelled || result.status !== "ok") return;
      const items = (result.value as any)?.items as Array<{ name: string; value: number }> | undefined;
      if (!items) return;
      const popMap: Record<number, number> = {};
      for (const item of items) {
        const norm = normalizeTitle(item.name);
        const match = deps.tracks.find(t => normalizeTitle(t.title) === norm);
        if (match && item.value > 0) {
          popMap[match.id] = item.value;
        }
      }
      setArtistTrackPopularity(popMap);
    }).catch(() => {});
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
