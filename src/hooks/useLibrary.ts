import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Artist, Album, Tag, Track, Collection, View, SortField, SortDir } from "../types";
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

  // Sort state
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

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

  function handleArtistClick(artistId: number) {
    setSelectedArtist(artistId);
    setSelectedAlbum(null);
    setSelectedTag(null);
    setSearchQuery("");
    setView("artists");
    invoke<Album[]>("get_albums", { artistId }).then(setAlbums);
  }

  function handleAlbumClick(albumId: number) {
    setSelectedAlbum(albumId);
    setSelectedTag(null);
    setSearchQuery("");
    setView("all");
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
    sortField, sortDir,
    sortedTracks,
    handleSort, sortIndicator,
    handleArtistClick, handleAlbumClick, handleShowAll, handleShowLiked,
    loadLibrary, loadTracks,
  };
}
