import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Artist, Album, Tag, Track, Collection, View, SortField, SortDir, ArtistSortField, AlbumSortField } from "../types";
import { store } from "../store";

export function useLibrary(restoredRef: React.RefObject<boolean>) {
  const [view, setView] = useState<View>("all");
  const [artists, setArtists] = useState<Artist[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [trackCount, setTrackCount] = useState(0);
  const [albumCount, setAlbumCount] = useState(0);
  const [selectedArtist, setSelectedArtist] = useState<number | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<number | null>(null);
  const [selectedTag, setSelectedTag] = useState<number | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [highlightedListIndex, setHighlightedListIndex] = useState(-1);

  // Sort state
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Artist sort state
  const [artistSortField, setArtistSortField] = useState<ArtistSortField | null>(null);
  const [artistSortDir, setArtistSortDir] = useState<SortDir>("asc");
  const [artistLikedFirst, setArtistLikedFirst] = useState(false);
  const [artistShuffleKey, setArtistShuffleKey] = useState(0);

  // Album sort state
  const [albumSortField, setAlbumSortField] = useState<AlbumSortField | null>(null);
  const [albumSortDir, setAlbumSortDir] = useState<SortDir>("asc");
  const [albumLikedFirst, setAlbumLikedFirst] = useState(false);
  const [albumShuffleKey, setAlbumShuffleKey] = useState(0);

  // Persist state
  useEffect(() => { if (restoredRef.current) store.set("view", view); }, [view]);
  useEffect(() => { if (restoredRef.current) store.set("searchQuery", searchQuery); }, [searchQuery]);
  useEffect(() => { if (restoredRef.current) store.set("selectedArtist", selectedArtist); }, [selectedArtist]);
  useEffect(() => { if (restoredRef.current) store.set("selectedAlbum", selectedAlbum); }, [selectedAlbum]);
  useEffect(() => { if (restoredRef.current) store.set("selectedTag", selectedTag); }, [selectedTag]);

  const loadLibrary = useCallback(async () => {
    try {
      const [a, al, c, t, tc] = await Promise.all([
        invoke<Artist[]>("get_artists"),
        invoke<Album[]>("get_albums", { artistId: null }),
        invoke<Collection[]>("get_collections"),
        invoke<Tag[]>("get_tags"),
        invoke<number>("get_track_count"),
      ]);
      setArtists(a);
      setAlbums(al);
      setAlbumCount(al.length);
      setCollections(c);
      setTags(t);
      setTrackCount(tc);
    } catch (e) {
      console.error("Failed to load library:", e);
    }
  }, []);

  const loadTracks = useCallback(async () => {
    try {
      if (searchQuery.trim()) {
        const results = await invoke<Track[]>("search", {
          query: searchQuery,
          artistId: selectedArtist,
          albumId: selectedAlbum,
          tagId: selectedTag,
          likedOnly: view === "liked" ? true : null,
        });
        setTracks(results);
      } else if (selectedTag !== null) {
        const results = await invoke<Track[]>("get_tracks_by_tag", { tagId: selectedTag });
        setTracks(results);
      } else if (selectedAlbum !== null) {
        const results = await invoke<Track[]>("get_tracks", { albumId: selectedAlbum });
        setTracks(results);
      } else if (selectedArtist !== null) {
        const results = await invoke<Track[]>("get_tracks_by_artist", { artistId: selectedArtist });
        setTracks(results);
      } else if (view === "liked") {
        const results = await invoke<Track[]>("get_liked_tracks");
        setTracks(results);
      } else {
        const results = await invoke<Track[]>("get_tracks", { albumId: null });
        setTracks(results);
      }
    } catch (e) {
      console.error("Failed to load tracks:", e);
    }
  }, [searchQuery, selectedTag, selectedAlbum, selectedArtist, view]);

  useEffect(() => { loadLibrary(); }, [loadLibrary]);
  useEffect(() => { loadTracks(); }, [loadTracks]);

  // Reset highlighted index and sort when tracks change
  useEffect(() => {
    setHighlightedIndex(-1);
    setSortField(null);
    setSortDir("asc");
  }, [tracks]);

  // Reset list highlight when search or view changes
  useEffect(() => { setHighlightedListIndex(-1); }, [searchQuery, view, selectedArtist, selectedAlbum, selectedTag]);

  function handleSort(field: SortField) {
    if (sortField === field) {
      if (sortDir === "asc") {
        setSortDir("desc");
      } else {
        setSortField(null);
        setSortDir("asc");
      }
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  function sortIndicator(field: SortField): string {
    if (sortField !== field) return "";
    return sortDir === "asc" ? " \u25B2" : " \u25BC";
  }

  const sortedTracks = (() => {
    if (!sortField) return tracks;
    const sorted = [...tracks];
    const dir = sortDir === "asc" ? 1 : -1;
    sorted.sort((a, b) => {
      switch (sortField) {
        case "num": return ((a.track_number ?? 0) - (b.track_number ?? 0)) * dir;
        case "title": return (a.title.localeCompare(b.title)) * dir;
        case "artist": return ((a.artist_name ?? "").localeCompare(b.artist_name ?? "")) * dir;
        case "album": return ((a.album_title ?? "").localeCompare(b.album_title ?? "")) * dir;
        case "duration": return ((a.duration_secs ?? 0) - (b.duration_secs ?? 0)) * dir;
        default: return 0;
      }
    });
    return sorted;
  })();

  // Fisher-Yates shuffle helper
  function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const sortedArtists = useMemo(() => {
    void artistShuffleKey; // trigger re-compute on shuffle
    let result: Artist[];
    if (artistSortField === "random") {
      result = shuffle(artists);
    } else if (artistSortField === "name") {
      const dir = artistSortDir === "asc" ? 1 : -1;
      result = [...artists].sort((a, b) => a.name.localeCompare(b.name) * dir);
    } else if (artistSortField === "tracks") {
      const dir = artistSortDir === "asc" ? 1 : -1;
      result = [...artists].sort((a, b) => (a.track_count - b.track_count) * dir);
    } else {
      result = artists;
    }
    if (artistLikedFirst) {
      result = [...result].sort((a, b) => (a.liked === b.liked ? 0 : a.liked ? -1 : 1));
    }
    return result;
  }, [artists, artistSortField, artistSortDir, artistLikedFirst, artistShuffleKey]);

  const sortedAlbums = useMemo(() => {
    void albumShuffleKey;
    let result: Album[];
    if (albumSortField === "random") {
      result = shuffle(albums);
    } else if (albumSortField === "name") {
      const dir = albumSortDir === "asc" ? 1 : -1;
      result = [...albums].sort((a, b) => a.title.localeCompare(b.title) * dir);
    } else if (albumSortField === "year") {
      const dir = albumSortDir === "asc" ? 1 : -1;
      result = [...albums].sort((a, b) => ((a.year ?? 0) - (b.year ?? 0)) * dir);
    } else {
      result = albums;
    }
    if (albumLikedFirst) {
      result = [...result].sort((a, b) => (a.liked === b.liked ? 0 : a.liked ? -1 : 1));
    }
    return result;
  }, [albums, albumSortField, albumSortDir, albumLikedFirst, albumShuffleKey]);

  function handleArtistSort(field: ArtistSortField) {
    if (field === "random") {
      setArtistSortField("random");
      setArtistShuffleKey(k => k + 1);
      return;
    }
    if (artistSortField === field) {
      if (artistSortDir === "asc") {
        setArtistSortDir("desc");
      } else {
        setArtistSortField(null);
        setArtistSortDir("asc");
      }
    } else {
      setArtistSortField(field);
      setArtistSortDir("asc");
    }
  }

  function handleAlbumSort(field: AlbumSortField) {
    if (field === "random") {
      setAlbumSortField("random");
      setAlbumShuffleKey(k => k + 1);
      return;
    }
    if (albumSortField === field) {
      if (albumSortDir === "asc") {
        setAlbumSortDir("desc");
      } else {
        setAlbumSortField(null);
        setAlbumSortDir("asc");
      }
    } else {
      setAlbumSortField(field);
      setAlbumSortDir("asc");
    }
  }

  function handleArtistClick(artistId: number) {
    setSelectedArtist(artistId);
    setSelectedAlbum(null);
    setSelectedTag(null);
    setSearchQuery("");
    setView("artists");
    invoke<Album[]>("get_albums", { artistId }).then(setAlbums);
  }

  function handleAlbumClick(albumId: number, artistId?: number | null) {
    setSelectedAlbum(albumId);
    setSelectedTag(null);
    setSearchQuery("");
    const resolvedArtistId = artistId !== undefined ? artistId
      : albums.find(a => a.id === albumId)?.artist_id ?? null;
    if (resolvedArtistId) {
      setSelectedArtist(resolvedArtistId);
      setView("artists");
      invoke<Album[]>("get_albums", { artistId: resolvedArtistId }).then(setAlbums);
    } else {
      setSelectedArtist(null);
      setView("albums");
      invoke<Album[]>("get_albums", { artistId: null }).then(setAlbums);
    }
  }

  function handleShowAll() {
    setView("all");
    setSelectedArtist(null);
    setSelectedAlbum(null);
    setSelectedTag(null);
    setSearchQuery("");
  }

  function handleShowLiked() {
    setView("liked");
    setSelectedArtist(null);
    setSelectedAlbum(null);
    setSelectedTag(null);
    setSearchQuery("");
  }

  return {
    view, setView,
    artists, setArtists,
    albums, setAlbums,
    tracks, setTracks,
    collections, setCollections,
    tags, setTags,
    searchQuery, setSearchQuery,
    trackCount, albumCount,
    selectedArtist, setSelectedArtist,
    selectedAlbum, setSelectedAlbum,
    selectedTag, setSelectedTag,
    highlightedIndex, setHighlightedIndex,
    highlightedListIndex, setHighlightedListIndex,
    sortField, sortDir,
    sortedTracks,
    handleSort, sortIndicator,
    handleArtistClick, handleAlbumClick, handleShowAll, handleShowLiked,
    loadLibrary, loadTracks,
    sortedArtists, artistSortField, artistSortDir, artistLikedFirst, setArtistLikedFirst, handleArtistSort,
    sortedAlbums, albumSortField, albumSortDir, albumLikedFirst, setAlbumLikedFirst, handleAlbumSort,
  };
}
