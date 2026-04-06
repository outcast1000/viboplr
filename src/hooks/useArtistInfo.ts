import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Album, Track, Artist } from "../types";
import { stripAccents } from "../utils";

export interface UseArtistInfoReturn {
  trackPopularity: Record<number, number>;
  albumTrackPopularity: Record<number, number>;
  artistTrackPopularity: Record<number, number>;
  artistTopTracks: Array<{ name: string; listeners: number; libraryTrack?: Track }>;
  artistBio: { summary: string; listeners: string; playcount: string } | null;
  artistInfoLoading: boolean;
  albumWiki: string | null;
  albumInfoLoading: boolean;
  albumUnmatchedTracks: Array<{ name: string; listeners: number }>;
  similarArtists: Array<{ name: string; match: string }>;
  refreshInfo: () => void;
}

export function useArtistInfo(deps: {
  selectedArtist: number | null;
  selectedAlbum: number | null;
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
}): UseArtistInfoReturn {
  const [albumTrackPopularity, setAlbumTrackPopularity] = useState<Record<number, number>>({});
  const [artistTrackPopularity, setArtistTrackPopularity] = useState<Record<number, number>>({});
  const [artistTopTracks, setArtistTopTracks] = useState<Array<{ name: string; listeners: number; libraryTrack?: Track }>>([]);
  const [artistBio, setArtistBio] = useState<{ summary: string; listeners: string; playcount: string } | null>(null);
  const [artistInfoLoading, setArtistInfoLoading] = useState(false);
  const [albumWiki, setAlbumWiki] = useState<string | null>(null);
  const [albumInfoLoading, setAlbumInfoLoading] = useState(false);
  const [albumUnmatchedTracks, setAlbumUnmatchedTracks] = useState<Array<{ name: string; listeners: number }>>([]);
  const [similarArtists, setSimilarArtists] = useState<Array<{ name: string; match: string }>>([]);
  const [infoRefreshCounter, setInfoRefreshCounter] = useState(0);

  const trackPopularity = Object.keys(albumTrackPopularity).length > 0 ? albumTrackPopularity : artistTrackPopularity;

  // Fetch Last.fm artist bio and similar artists when selected artist changes
  useEffect(() => {
    setArtistBio(null);
    setArtistInfoLoading(false);
    setSimilarArtists([]);
    if (deps.selectedArtist === null) return;
    const artist = deps.artists.find(a => a.id === deps.selectedArtist);
    if (!artist) return;

    setArtistInfoLoading(true);
    const parseArtistInfo = (resp: { artist?: { bio?: { summary?: string }; stats?: { listeners?: string; playcount?: string } } } | null) => {
      if (resp?.artist?.bio?.summary) {
        setArtistBio({
          summary: resp.artist.bio.summary.replace(/<a [^>]*>Read more on Last\.fm<\/a>\.?/, "").trim(),
          listeners: resp.artist.stats?.listeners ?? "",
          playcount: resp.artist.stats?.playcount ?? "",
        });
      }
      setArtistInfoLoading(false);
    };
    const parseSimilar = (resp: { similarartists?: { artist?: Array<{ name: string; match: string }> } } | null) => {
      setSimilarArtists(resp?.similarartists?.artist ?? []);
    };

    // invoke returns cached data immediately, or null if fetching in background
    invoke<any>("lastfm_get_artist_info", { artistName: artist.name })
      .then(resp => { if (resp) parseArtistInfo(resp); })
      .catch(() => setArtistInfoLoading(false));
    invoke<any>("lastfm_get_similar_artists", { artistName: artist.name })
      .then(resp => { if (resp) parseSimilar(resp); })
      .catch(() => {});

    // Listen for async results from background fetches
    const unlistenInfo = listen<any>("lastfm-artist-info", (event) => parseArtistInfo(event.payload));
    const unlistenInfoError = listen<any>("lastfm-artist-info-error", () => setArtistInfoLoading(false));
    const unlistenSimilar = listen<any>("lastfm-similar-artists", (event) => parseSimilar(event.payload));

    return () => {
      unlistenInfo.then(f => f());
      unlistenInfoError.then(f => f());
      unlistenSimilar.then(f => f());
    };
  }, [deps.selectedArtist, deps.artists, infoRefreshCounter]);

  // Fetch Last.fm album wiki when selected album changes
  useEffect(() => {
    setAlbumWiki(null);
    setAlbumInfoLoading(false);
    if (deps.selectedAlbum === null) return;
    const album = deps.albums.find(a => a.id === deps.selectedAlbum);
    if (!album) return;
    const artistName = deps.artists.find(a => a.id === album.artist_id)?.name;
    if (!artistName) return;

    setAlbumInfoLoading(true);
    const parseAlbumInfo = (resp: { album?: { wiki?: { summary?: string } } } | null) => {
      if (resp?.album?.wiki?.summary) {
        setAlbumWiki(resp.album.wiki.summary.replace(/<a [^>]*>Read more on Last\.fm<\/a>\.?/, "").trim());
      }
      setAlbumInfoLoading(false);
    };

    invoke<any>("lastfm_get_album_info", { artistName, albumTitle: album.title })
      .then(resp => { if (resp) parseAlbumInfo(resp); })
      .catch(() => setAlbumInfoLoading(false));

    const unlistenAlbum = listen<any>("lastfm-album-info", (event) => parseAlbumInfo(event.payload));
    const unlistenAlbumError = listen<any>("lastfm-album-info-error", () => setAlbumInfoLoading(false));
    return () => { unlistenAlbum.then(f => f()); unlistenAlbumError.then(f => f()); };
  }, [deps.selectedAlbum, deps.albums, deps.artists, infoRefreshCounter]);

  // Fetch Last.fm track popularity when selected album changes
  useEffect(() => {
    setAlbumTrackPopularity({});
    setAlbumUnmatchedTracks([]);
    if (deps.selectedAlbum === null) return;
    const album = deps.albums.find(a => a.id === deps.selectedAlbum);
    if (!album) return;
    const artistName = deps.artists.find(a => a.id === album.artist_id)?.name;
    if (!artistName) return;

    const normalizeTitle = (s: string) => stripAccents(s.toLowerCase().replace(/\([^)]*\)/g, "").trim()).replace(/[^a-z0-9]/g, "");
    const matchPopularity = (resp: { tracks?: Array<{ name: string; listeners: number }> } | null) => {
      if (!resp?.tracks) return;
      const popMap: Record<number, number> = {};
      const unmatched: Array<{ name: string; listeners: number }> = [];
      const localTracks = deps.tracks;
      for (const lfmTrack of resp.tracks) {
        const norm = normalizeTitle(lfmTrack.name);
        const match = localTracks.find(t => normalizeTitle(t.title) === norm);
        if (match && lfmTrack.listeners > 0) {
          popMap[match.id] = lfmTrack.listeners;
        } else {
          unmatched.push({ name: lfmTrack.name, listeners: lfmTrack.listeners });
        }
      }
      setAlbumTrackPopularity(popMap);
      setAlbumUnmatchedTracks(unmatched);
    };

    invoke<any>("lastfm_get_album_track_popularity", { artistName, albumTitle: album.title })
      .then(resp => { if (resp) matchPopularity(resp); })
      .catch(() => {});

    const unlistenPop = listen<any>("lastfm-album-track-popularity", (event) => matchPopularity(event.payload));
    return () => { unlistenPop.then(f => f()); };
  }, [deps.selectedAlbum, deps.albums, deps.artists, deps.tracks]);

  // Fetch Last.fm artist top tracks popularity when selected artist changes (no album selected)
  useEffect(() => {
    setArtistTrackPopularity({});
    setArtistTopTracks([]);
    if (deps.selectedArtist === null || deps.selectedAlbum !== null) return;
    const artist = deps.artists.find(a => a.id === deps.selectedArtist);
    if (!artist) return;

    const normalizeTitle = (s: string) => stripAccents(s.toLowerCase().replace(/\([^)]*\)/g, "").trim()).replace(/[^a-z0-9]/g, "");
    const matchPopularity = (resp: { tracks?: Array<{ name: string; listeners: number }> } | null) => {
      if (!resp?.tracks) return;
      const popMap: Record<number, number> = {};
      const topList: Array<{ name: string; listeners: number; libraryTrack?: Track }> = [];
      for (const lfmTrack of resp.tracks) {
        const norm = normalizeTitle(lfmTrack.name);
        const match = deps.tracks.find(t => normalizeTitle(t.title) === norm);
        if (match && lfmTrack.listeners > 0) {
          popMap[match.id] = lfmTrack.listeners;
        }
        topList.push({ name: lfmTrack.name, listeners: lfmTrack.listeners, libraryTrack: match ?? undefined });
      }
      setArtistTrackPopularity(popMap);
      setArtistTopTracks(topList);
    };

    invoke<any>("lastfm_get_artist_track_popularity", { artistName: artist.name })
      .then(resp => { if (resp) matchPopularity(resp); })
      .catch(() => {});

    const unlistenPop = listen<any>("lastfm-artist-track-popularity", (event) => matchPopularity(event.payload));
    return () => { unlistenPop.then(f => f()); };
  }, [deps.selectedArtist, deps.selectedAlbum, deps.artists, deps.tracks]);

  const refreshInfo = () => {
    setInfoRefreshCounter(c => c + 1);
  };

  return {
    trackPopularity,
    albumTrackPopularity,
    artistTrackPopularity,
    artistTopTracks,
    artistBio,
    artistInfoLoading,
    albumWiki,
    albumInfoLoading,
    albumUnmatchedTracks,
    similarArtists,
    refreshInfo,
  };
}
