import { useEffect, useState } from "react";
import type { Album, Track, Artist } from "../types";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { stripAccents } from "../utils";

export interface SectionMeta { url?: string; providerName?: string }

export interface UseArtistInfoReturn {
  trackPopularity: Record<number, number>;
  albumTrackPopularity: Record<number, number>;
  artistTrackPopularity: Record<number, number>;
  artistTopTracks: Array<{ name: string; listeners: number; libraryTrack?: Track }>;
  albumTopTracks: Array<{ name: string; listeners: number; libraryTrack?: Track }>;
  albumUnmatchedTracks: Array<{ name: string; listeners: number }>;
  similarArtists: Array<{ name: string; match: string }>;
  sectionMeta: Record<string, SectionMeta>;
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
  const [artistTopTracks, setArtistTopTracks] = useState<Array<{ name: string; listeners: number; libraryTrack?: Track }>>([]);
  const [albumTopTracks, setAlbumTopTracks] = useState<Array<{ name: string; listeners: number; libraryTrack?: Track }>>([]);
  const [albumUnmatchedTracks, setAlbumUnmatchedTracks] = useState<Array<{ name: string; listeners: number }>>([]);
  const [similarArtists, setSimilarArtists] = useState<Array<{ name: string; match: string }>>([]);
  const [sectionMeta, setSectionMeta] = useState<Record<string, SectionMeta>>({});

  const trackPopularity = Object.keys(albumTrackPopularity).length > 0 ? albumTrackPopularity : artistTrackPopularity;

  // Fetch album track popularity when selected album changes
  useEffect(() => {
    setAlbumTrackPopularity({});
    setAlbumTopTracks([]);
    setAlbumUnmatchedTracks([]);
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
      const unmatched: Array<{ name: string; listeners: number }> = [];
      const topList: Array<{ name: string; listeners: number; libraryTrack?: Track }> = [];
      for (const item of items) {
        const norm = normalizeTitle(item.name);
        const match = deps.tracks.find(t => normalizeTitle(t.title) === norm);
        if (match && item.value > 0) {
          popMap[match.id] = item.value;
        } else {
          unmatched.push({ name: item.name, listeners: item.value });
        }
        topList.push({ name: item.name, listeners: item.value, libraryTrack: match ?? undefined });
      }
      topList.sort((a, b) => b.listeners - a.listeners);
      const meta = (result.value as any)?._meta as SectionMeta | undefined;
      if (meta) setSectionMeta(prev => ({ ...prev, albumTopTracks: meta }));
      setAlbumTrackPopularity(popMap);
      setAlbumTopTracks(topList);
      setAlbumUnmatchedTracks(unmatched);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [deps.selectedAlbum, deps.albums, deps.artists, deps.tracks, deps.invokeInfoFetch]);

  // Fetch artist top tracks + popularity when selected artist changes (no album selected)
  useEffect(() => {
    setArtistTrackPopularity({});
    setArtistTopTracks([]);
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
      const topList: Array<{ name: string; listeners: number; libraryTrack?: Track }> = [];
      for (const item of items) {
        const norm = normalizeTitle(item.name);
        const match = deps.tracks.find(t => normalizeTitle(t.title) === norm);
        if (match && item.value > 0) {
          popMap[match.id] = item.value;
        }
        topList.push({ name: item.name, listeners: item.value, libraryTrack: match ?? undefined });
      }
      const meta = (result.value as any)?._meta as SectionMeta | undefined;
      if (meta) setSectionMeta(prev => ({ ...prev, artistTopTracks: meta }));
      setArtistTrackPopularity(popMap);
      setArtistTopTracks(topList);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [deps.selectedArtist, deps.selectedAlbum, deps.artists, deps.tracks, deps.invokeInfoFetch]);

  // Fetch similar artists when selected artist changes
  useEffect(() => {
    setSimilarArtists([]);
    if (deps.selectedArtist === null) return;
    const artist = deps.artists.find(a => a.id === deps.selectedArtist);
    if (!artist) return;

    let cancelled = false;
    deps.invokeInfoFetch("lastfm", "similar_artists", {
      kind: "artist", name: artist.name, id: artist.id,
    }).then(result => {
      if (cancelled || result.status !== "ok") return;
      const items = (result.value as any)?.items as Array<{ name: string; match?: number }> | undefined;
      if (!items) return;
      const meta = (result.value as any)?._meta as SectionMeta | undefined;
      if (meta) setSectionMeta(prev => ({ ...prev, similarArtists: meta }));
      setSimilarArtists(items.map(item => ({
        name: item.name,
        match: String(item.match ?? 0),
      })));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [deps.selectedArtist, deps.artists, deps.invokeInfoFetch]);

  const refreshInfo = () => {
    // No-op — info types handle their own caching/refresh
  };

  return {
    trackPopularity,
    albumTrackPopularity,
    artistTrackPopularity,
    artistTopTracks,
    albumTopTracks,
    albumUnmatchedTracks,
    similarArtists,
    sectionMeta,
    refreshInfo,
  };
}
