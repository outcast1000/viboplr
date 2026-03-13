import { useEffect, useState, useCallback, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import "./App.css";

import type { Album, Track, View } from "./types";
import { isVideoTrack, getInitials } from "./utils";
import { store } from "./store";
import type { SearchProviderConfig } from "./searchProviders";
import { DEFAULT_PROVIDERS, loadProviders, saveProviders } from "./searchProviders";

import { usePlayback } from "./hooks/usePlayback";
import { useQueue } from "./hooks/useQueue";
import { useLibrary } from "./hooks/useLibrary";
import { useEventListeners } from "./hooks/useEventListeners";
import { useAutoContinue } from "./hooks/useAutoContinue";
import { usePasteImage } from "./hooks/usePasteImage";

import { Sidebar } from "./components/Sidebar";
import { TrackList } from "./components/TrackList";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { QueuePanel } from "./components/QueuePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { AddServerModal } from "./components/AddServerModal";
import { ContextMenu } from "./components/ContextMenu";
import type { ContextMenuState } from "./components/ContextMenu";
import { Breadcrumb } from "./components/Breadcrumb";
import { AlbumCardArt } from "./components/AlbumCardArt";
import { ImageActions } from "./components/ImageActions";
import { HistoryView } from "./components/HistoryView";
import { StatusBar } from "./components/StatusBar";

const stripAccents = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function App() {
  const restoredRef = useRef(false);
  const trackListRef = useRef<HTMLDivElement>(null);

  // Core hooks
  const peekNextRef = useRef<() => Track | null>(() => null);
  const crossfadeSecsRef = useRef(3);
  const [crossfadeSecs, setCrossfadeSecs] = useState(3);
  crossfadeSecsRef.current = crossfadeSecs;
  const advanceIndexRef = useRef<() => void>(() => {});
  const playback = usePlayback(restoredRef, peekNextRef, crossfadeSecsRef, advanceIndexRef);
  const library = useLibrary(restoredRef);
  const queueHook = useQueue(restoredRef, playback.handlePlay);
  const autoContinue = useAutoContinue(restoredRef);
  peekNextRef.current = queueHook.peekNext;
  advanceIndexRef.current = queueHook.advanceIndex;

  // UI state
  const [scanning, setScanning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [scanProgress, setScanProgress] = useState({ scanned: 0, total: 0 });
  const [syncProgress, setSyncProgress] = useState({ synced: 0, total: 0, collection: "" });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showAddServer, setShowAddServer] = useState(false);
  const [serverForm, setServerForm] = useState({ name: "", url: "", username: "", password: "" });
  const [showSettings, setShowSettings] = useState(false);
  const [sessionLog, setSessionLog] = useState<{ time: Date; message: string }[]>([]);
  const [searchProviders, setSearchProviders] = useState<SearchProviderConfig[]>(DEFAULT_PROVIDERS);

  // Image state
  const [artistImages, setArtistImages] = useState<Record<number, string | null>>({});
  const [fetchedArtistImages, setFetchedArtistImages] = useState<Set<number>>(new Set());
  const [albumImages, setAlbumImages] = useState<Record<number, string | null>>({});
  const [fetchedAlbumImages, setFetchedAlbumImages] = useState<Set<number>>(new Set());
  const [failedArtistImages, setFailedArtistImages] = useState<Set<number>>(new Set());
  const [failedAlbumImages, setFailedAlbumImages] = useState<Set<number>>(new Set());

  function addLog(message: string) {
    setSessionLog(prev => [...prev, { time: new Date(), message }]);
  }

  // Refs for latest artists/albums (needed by useEventListeners to avoid stale closures)
  const artistsRef = useRef(library.artists);
  artistsRef.current = library.artists;
  const albumsRef = useRef(library.albums);
  albumsRef.current = library.albums;

  // Event listeners
  useEventListeners({
    loadLibrary: library.loadLibrary,
    loadTracks: library.loadTracks,
    addLog,
    setScanning, setScanProgress,
    setSyncing, setSyncProgress,
    setArtistImages, setAlbumImages,
    setFailedArtistImages, setFailedAlbumImages,
    artistsRef, albumsRef,
  });

  // Paste image onto artist/album
  usePasteImage({
    view: library.view,
    selectedArtist: library.selectedArtist,
    selectedAlbum: library.selectedAlbum,
    searchQuery: library.searchQuery,
    artists: library.artists,
    albums: library.albums,
    setArtistImages,
    setAlbumImages,
    addLog,
  });

  // Disable default browser context menu globally
  useEffect(() => {
    const handler = (e: MouseEvent) => { e.preventDefault(); };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  // Restore persisted state on mount
  useEffect(() => {
    (async () => {
      try {
        const [v, sq, sa, sal, st, tid, vol, qIds, qIdx, qMode, pos, ww, wh, wx, wy, cf] = await Promise.all([
          store.get<string>("view"),
          store.get<string>("searchQuery"),
          store.get<number | null>("selectedArtist"),
          store.get<number | null>("selectedAlbum"),
          store.get<number | null>("selectedTag"),
          store.get<number | null>("currentTrackId"),
          store.get<number>("volume"),
          store.get<number[]>("queueTrackIds"),
          store.get<number>("queueIndex"),
          store.get<string>("queueMode"),
          store.get<number>("positionSecs"),
          store.get<number | null>("windowWidth"),
          store.get<number | null>("windowHeight"),
          store.get<number | null>("windowX"),
          store.get<number | null>("windowY"),
          store.get<number>("crossfadeSecs"),
        ]);
        if (v && ["all", "artists", "albums", "tags", "liked", "history"].includes(v)) library.setView(v as View);
        if (sq) library.setSearchQuery(sq);
        if (sa !== undefined && sa !== null) {
          library.setSelectedArtist(sa);
          invoke<Album[]>("get_albums", { artistId: sa }).then(library.setAlbums);
        }
        if (sal !== undefined && sal !== null) library.setSelectedAlbum(sal);
        if (st !== undefined && st !== null) library.setSelectedTag(st);
        if (vol !== undefined && vol !== null) playback.setVolume(vol);
        if (cf !== undefined && cf !== null) setCrossfadeSecs(cf);
        if (tid !== undefined && tid !== null) {
          try {
            const track = await invoke<Track>("get_track_by_id", { trackId: tid });
            await playback.handleRestore(track, pos ?? 0);
          } catch {
            // Track was deleted
          }
        }
        if (qIds && qIds.length > 0) {
          try {
            const restoredTracks = await invoke<Track[]>("get_tracks_by_ids", { ids: qIds });
            queueHook.setQueue(restoredTracks);
            const idx = qIdx ?? -1;
            queueHook.setQueueIndex(idx >= 0 && idx < restoredTracks.length ? idx : -1);
          } catch {
            // Queue restore failed
          }
        }
        if (qMode && ["normal", "loop", "shuffle"].includes(qMode)) {
          queueHook.setQueueMode(qMode as "normal" | "loop" | "shuffle");
        }
        const win = getCurrentWindow();
        if (ww && wh && ww > 0 && wh > 0) {
          await win.setSize(new LogicalSize(ww, wh));
        }
        if (wx !== undefined && wx !== null && wy !== undefined && wy !== null) {
          await win.setPosition(new LogicalPosition(wx, wy));
        }
        await win.show();
      } catch (e) {
        console.error("Failed to restore state:", e);
        await getCurrentWindow().show();
      }
      loadProviders(store).then(setSearchProviders);
      restoredRef.current = true;
    })();
  }, []);

  // Save window size and position on resize/move
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout>;
    const save = async () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!restoredRef.current) return;
        const factor = await win.scaleFactor();
        const size = await win.innerSize();
        const pos = await win.outerPosition();
        store.set("windowWidth", size.width / factor);
        store.set("windowHeight", size.height / factor);
        store.set("windowX", pos.x / factor);
        store.set("windowY", pos.y / factor);
      }, 500);
    };
    const unlistenResize = win.onResized(save);
    const unlistenMove = win.onMoved(save);
    return () => {
      clearTimeout(timer);
      unlistenResize.then(f => f());
      unlistenMove.then(f => f());
    };
  }, []);

  // Fetch artist image on demand
  const fetchedArtistImagesRef = useRef(fetchedArtistImages);
  fetchedArtistImagesRef.current = fetchedArtistImages;
  const artistImagesRef = useRef(artistImages);
  artistImagesRef.current = artistImages;
  const failedArtistImagesRef = useRef(failedArtistImages);
  failedArtistImagesRef.current = failedArtistImages;
  useEffect(() => {
    if (library.selectedArtist === null) return;
    if (artistImagesRef.current[library.selectedArtist] !== undefined) return;
    if (fetchedArtistImagesRef.current.has(library.selectedArtist)) return;
    if (failedArtistImagesRef.current.has(library.selectedArtist)) return;

    const artist = library.artists.find((a) => a.id === library.selectedArtist);
    if (!artist) return;

    setFetchedArtistImages((prev) => new Set(prev).add(library.selectedArtist!));

    invoke<string | null>("get_artist_image", { artistId: library.selectedArtist }).then((path) => {
      if (path) {
        setArtistImages((prev) => ({ ...prev, [library.selectedArtist!]: path }));
      } else {
        invoke("fetch_artist_image", { artistId: library.selectedArtist, artistName: artist.name });
      }
    });
  }, [library.selectedArtist, library.artists]);

  // Fetch album image on demand
  const fetchedAlbumImagesRef = useRef(fetchedAlbumImages);
  fetchedAlbumImagesRef.current = fetchedAlbumImages;
  const albumImagesRef = useRef(albumImages);
  albumImagesRef.current = albumImages;
  const failedAlbumImagesRef = useRef(failedAlbumImages);
  failedAlbumImagesRef.current = failedAlbumImages;
  const fetchAlbumImageOnDemand = useCallback((album: Album) => {
    if (albumImagesRef.current[album.id] !== undefined) return;
    if (fetchedAlbumImagesRef.current.has(album.id)) return;
    if (failedAlbumImagesRef.current.has(album.id)) return;
    setFetchedAlbumImages((prev) => new Set(prev).add(album.id));

    invoke<string | null>("get_album_image", { albumId: album.id }).then((path) => {
      if (path) {
        setAlbumImages((prev) => ({ ...prev, [album.id]: path }));
      } else {
        invoke("fetch_album_image", { albumId: album.id, albumTitle: album.title, artistName: album.artist_name });
      }
    });
  }, []);

  useEffect(() => {
    if (library.selectedAlbum === null) return;
    const album = library.albums.find(a => a.id === library.selectedAlbum);
    if (album) fetchAlbumImageOnDemand(album);
  }, [library.selectedAlbum]);

  // onEnded handler — uses refs to avoid stale closures from useCallback([])
  const autoContinueRef = useRef(autoContinue);
  autoContinueRef.current = autoContinue;
  const currentTrackRef = useRef(playback.currentTrack);
  currentTrackRef.current = playback.currentTrack;
  const handleStopRef = useRef(playback.handleStop);
  handleStopRef.current = playback.handleStop;

  const onEnded = useCallback(async () => {
    if (playback.handleGaplessNext()) {
      queueHook.advanceIndex();
      return;
    }
    if (!queueHook.playNext()) {
      const ac = autoContinueRef.current;
      const track = currentTrackRef.current;
      if (ac.enabled && track) {
        const next = await ac.fetchTrack(track);
        if (next) {
          queueHook.addToQueueAndPlay(next);
          return;
        }
      }
      handleStopRef.current();
    }
  }, []);

  useEffect(() => {
    const video = playback.videoRef.current;
    if (video) {
      video.addEventListener("ended", onEnded);
    }
    return () => {
      if (video) video.removeEventListener("ended", onEnded);
    };
  }, [onEnded]);

  // Action handlers
  function handleTrackContextMenu(e: React.MouseEvent, track: Track) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "track", trackId: track.id, subsonic: !!track.subsonic_id, title: track.title, artistName: track.artist_name } });
  }

  function handleAlbumContextMenu(e: React.MouseEvent, albumId: number) {
    e.preventDefault();
    const album = albums.find(a => a.id === albumId);
    setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "album", albumId, title: album?.title ?? "", artistName: album?.artist_name ?? null } });
  }

  function handleArtistContextMenu(e: React.MouseEvent, artistId: number) {
    e.preventDefault();
    const artist = artists.find(a => a.id === artistId);
    setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "artist", artistId, name: artist?.name ?? "" } });
  }

  async function handleContextPlay() {
    if (!contextMenu) return;
    const { target } = contextMenu;
    if (target.kind === "track") {
      const track = tracks.find(t => t.id === target.trackId);
      if (track) queueHook.playTracks([track], 0);
    } else if (target.kind === "album") {
      const albumTracks = await invoke<Track[]>("get_tracks", { albumId: target.albumId });
      if (albumTracks.length > 0) queueHook.playTracks(albumTracks, 0);
    } else if (target.kind === "artist") {
      const artistTracks = await invoke<Track[]>("get_tracks_by_artist", { artistId: target.artistId });
      if (artistTracks.length > 0) queueHook.playTracks(artistTracks, 0);
    }
  }

  async function handleContextEnqueue() {
    if (!contextMenu) return;
    const { target } = contextMenu;
    if (target.kind === "track") {
      const track = tracks.find(t => t.id === target.trackId);
      if (track) queueHook.enqueueTracks([track]);
    } else if (target.kind === "album") {
      const albumTracks = await invoke<Track[]>("get_tracks", { albumId: target.albumId });
      queueHook.enqueueTracks(albumTracks);
    } else if (target.kind === "artist") {
      const artistTracks = await invoke<Track[]>("get_tracks_by_artist", { artistId: target.artistId });
      queueHook.enqueueTracks(artistTracks);
    }
  }

  function handleShowInFolder() {
    if (contextMenu && contextMenu.target.kind === "track") {
      invoke("show_in_folder", { trackId: contextMenu.target.trackId });
      setContextMenu(null);
    }
  }

  async function handleAddFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      const folderName = selected.split("/").pop() || selected.split("\\").pop() || selected;
      await invoke("add_collection", { kind: "local", name: folderName, path: selected });
      library.loadLibrary();
    }
  }

  async function handleAddServer() {
    if (!serverForm.url || !serverForm.username || !serverForm.password) return;
    try {
      await invoke("add_collection", {
        kind: "subsonic",
        name: serverForm.name || serverForm.url,
        url: serverForm.url,
        username: serverForm.username,
        password: serverForm.password,
      });
      setShowAddServer(false);
      setServerForm({ name: "", url: "", username: "", password: "" });
      library.loadLibrary();
    } catch (e) {
      console.error("Failed to add server:", e);
      alert("Failed to connect: " + e);
    }
  }

  async function handleSeedDatabase() {
    try {
      await invoke("add_collection", { kind: "seed", name: "Test Data" });
      await library.loadLibrary();
      await library.loadTracks();
    } catch (e) {
      console.error("Seed error:", e);
    }
  }

  async function handleClearDatabase() {
    setClearing(true);
    try {
      await invoke("clear_database", {});
      await library.loadLibrary();
      await library.loadTracks();
    } catch (e) {
      console.error("Clear database error:", e);
    } finally {
      setClearing(false);
    }
  }

  async function handleClearImageFailures() {
    try {
      await invoke("clear_image_failures");
      setFailedArtistImages(new Set());
      setFailedAlbumImages(new Set());
      setFetchedArtistImages(new Set());
      setFetchedAlbumImages(new Set());
      addLog("Cleared image fetch failures");
    } catch (e) {
      console.error("Failed to clear image failures:", e);
    }
  }

  function handleSaveProviders(providers: SearchProviderConfig[]) {
    setSearchProviders(providers);
    saveProviders(store, providers);
  }

  function handleCrossfadeChange(secs: number) {
    setCrossfadeSecs(secs);
    store.set("crossfadeSecs", secs);
  }

  async function handleRemoveCollection(collectionId: number) {
    await invoke("remove_collection", { collectionId });
    library.loadLibrary();
    library.loadTracks();
  }

  async function handleResyncCollection(collectionId: number) {
    await invoke("resync_collection", { collectionId });
  }

  async function handleToggleLike(track: Track) {
    const newLiked = !track.liked;
    try {
      await invoke("toggle_track_liked", { trackId: track.id, liked: newLiked });
      library.setTracks(prev => prev.map(t => t.id === track.id ? { ...t, liked: newLiked } : t));
      if (playback.currentTrack?.id === track.id) {
        playback.setCurrentTrack({ ...playback.currentTrack, liked: newLiked });
      }
      queueHook.setQueue(prev => prev.map(t => t.id === track.id ? { ...t, liked: newLiked } : t));
    } catch (e) {
      console.error("Failed to toggle like:", e);
    }
  }

  const { view, selectedArtist, selectedAlbum, selectedTag, artists, albums, tags, tracks,
    searchQuery, sortedTracks, sortField, highlightedIndex } = library;

  return (
    <div className={`app ${playback.currentTrack && isVideoTrack(playback.currentTrack) ? "video-mode" : ""} ${queueHook.showQueue ? "queue-open" : ""}`} onClick={() => setContextMenu(null)}>
      {/* Hidden audio elements (A/B for gapless playback) */}
      <audio
        ref={playback.audioRefA}
        onTimeUpdate={playback.onTimeUpdate}
        onLoadedMetadata={playback.onLoadedMetadata}
        onPlay={playback.onPlaySlotA}
        onPause={playback.onPauseSlotA}
        onEnded={() => playback.onEndedSlotA(onEnded)}
      />
      <audio
        ref={playback.audioRefB}
        onTimeUpdate={playback.onTimeUpdate}
        onLoadedMetadata={playback.onLoadedMetadata}
        onPlay={playback.onPlaySlotB}
        onPause={playback.onPauseSlotB}
        onEnded={() => playback.onEndedSlotB(onEnded)}
      />

      <Sidebar
        view={view}
        selectedAlbum={selectedAlbum}
        selectedArtist={selectedArtist}
        onShowAll={library.handleShowAll}
        onShowArtists={() => {
          library.setView("artists");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSearchQuery("");
        }}
        onShowAlbums={() => {
          library.setView("albums");
          library.setSelectedArtist(null);
          library.setSelectedTag(null);
          library.setSearchQuery("");
          invoke<Album[]>("get_albums", { artistId: null }).then(library.setAlbums);
        }}
        onShowTags={() => {
          library.setView("tags");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSearchQuery("");
        }}
        onShowLiked={library.handleShowLiked}
        onShowHistory={() => {
          library.setView("history");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSearchQuery("");
        }}
        onShowSettings={() => setShowSettings(true)}
      />

      {showAddServer && (
        <AddServerModal
          form={serverForm}
          onChange={setServerForm}
          onConnect={handleAddServer}
          onClose={() => setShowAddServer(false)}
        />
      )}

      {showSettings && (
        <SettingsPanel
          collections={library.collections}
          searchProviders={searchProviders}
          onClose={() => setShowSettings(false)}
          onAddFolder={handleAddFolder}
          onShowAddServer={() => setShowAddServer(true)}
          onRemoveCollection={handleRemoveCollection}
          onResyncCollection={handleResyncCollection}
          onSeedDatabase={handleSeedDatabase}
          onClearDatabase={handleClearDatabase}
          clearing={clearing}
          onClearImageFailures={handleClearImageFailures}
          onSaveProviders={handleSaveProviders}
          crossfadeSecs={crossfadeSecs}
          onCrossfadeChange={handleCrossfadeChange}
        />
      )}

      {/* Main content */}
      <main className="main">
        {/* Search bar */}
        <div className="search-bar">
          <input
            type="text"
            placeholder={
              view === "liked" ? "Search liked tracks..." :
              view === "history" ? "Search history..." :
              view === "artists" && selectedArtist === null ? "Search artists..." :
              view === "albums" && selectedAlbum === null ? "Search albums..." :
              view === "tags" && selectedTag === null ? "Search tags..." :
              selectedArtist !== null && selectedAlbum === null ? `Search in ${artists.find(a => a.id === selectedArtist)?.name ?? "artist"}...` :
              selectedAlbum !== null ? `Search in ${albums.find(a => a.id === selectedAlbum)?.title ?? "album"}...` :
              selectedTag !== null ? `Search in ${tags.find(t => t.id === selectedTag)?.name ?? "tag"}...` :
              "Search tracks..."
            }
            title=""
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={searchQuery}
            onChange={(e) => library.setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                library.setHighlightedIndex((prev) => {
                  const next = Math.min(prev + 1, tracks.length - 1);
                  trackListRef.current?.children[next + 1]?.scrollIntoView({ block: "nearest" });
                  return next;
                });
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                library.setHighlightedIndex((prev) => {
                  const next = Math.max(prev - 1, 0);
                  trackListRef.current?.children[next + 1]?.scrollIntoView({ block: "nearest" });
                  return next;
                });
              } else if (e.key === "Enter" && highlightedIndex >= 0 && highlightedIndex < tracks.length) {
                e.preventDefault();
                queueHook.playTracks([tracks[highlightedIndex]], 0);
              }
            }}
          />
          {scanning && (
            <span className="scan-status">
              Scanning... {scanProgress.scanned}/{scanProgress.total}
            </span>
          )}
          {syncing && (
            <span className="scan-status">
              Syncing {syncProgress.collection}... {syncProgress.synced}/{syncProgress.total} albums
            </span>
          )}
        </div>

        {/* Video player area */}
        <div className="video-container" style={{ display: playback.currentTrack && isVideoTrack(playback.currentTrack) ? undefined : 'none' }}>
          <video
            ref={playback.videoRef}
            onTimeUpdate={playback.onTimeUpdate}
            onLoadedMetadata={playback.onLoadedMetadata}
            onPlay={playback.onPlay}
            onPause={playback.onPause}
            onClick={playback.handlePause}
          />
        </div>

        {/* Content area */}
        <div className="content">
          <Breadcrumb
            view={view}
            selectedArtist={selectedArtist}
            selectedAlbum={selectedAlbum}
            selectedTag={selectedTag}
            artists={artists}
            albums={albums}
            tags={tags}
            tracks={tracks}
            sortedTracks={sortedTracks}
            onSetSelectedArtist={library.setSelectedArtist}
            onSetSelectedAlbum={library.setSelectedAlbum}
            onSetSelectedTag={library.setSelectedTag}
            onSetView={library.setView}
            onSetAlbums={library.setAlbums}
            onPlayAll={queueHook.playTracks}
            onEnqueueAll={queueHook.enqueueTracks}
          />

          {/* Artist list */}
          {view === "artists" && selectedArtist === null && (() => {
            const q = searchQuery.trim().toLowerCase();
            const filtered = q ? artists.filter(a => stripAccents(a.name.toLowerCase()).includes(stripAccents(q))) : artists;
            return (
              <div className="list">
                {filtered.map((a) => (
                  <div
                    key={a.id}
                    className="list-item"
                    onClick={() => library.handleArtistClick(a.id)}
                    onContextMenu={(e) => handleArtistContextMenu(e, a.id)}
                  >
                    <span>{a.name}</span>
                    <span className="list-count">{a.track_count}</span>
                  </div>
                ))}
                {filtered.length === 0 && (
                  <div className="empty">{q ? `No artists matching "${searchQuery}"` : "No artists found. Add a folder or server to get started."}</div>
                )}
              </div>
            );
          })()}

          {/* Artist detail view */}
          {view === "artists" && selectedArtist !== null && (() => {
            const artist = artists.find(a => a.id === selectedArtist);
            const artistImagePath = artistImages[selectedArtist] ?? null;
            return (
              <div className="artist-detail">
                <div className="artist-header">
                  <div className="artist-avatar">
                    {artistImagePath ? (
                      <img className="artist-avatar-img" src={convertFileSrc(artistImagePath)} alt={artist?.name} />
                    ) : (
                      artist ? getInitials(artist.name) : "?"
                    )}
                  </div>
                  <div className="artist-header-info">
                    <h2>{artist?.name ?? "Unknown"}</h2>
                    <span className="artist-meta">{artist?.track_count ?? 0} tracks</span>
                    <ImageActions
                      entityId={selectedArtist}
                      entityType="artist"
                      imagePath={artistImagePath}
                      onImageSet={(id, path) => setArtistImages(prev => ({ ...prev, [id]: path }))}
                      onImageRemoved={(id) => {
                        setArtistImages(prev => ({ ...prev, [id]: null }));
                        setFetchedArtistImages(prev => { const next = new Set(prev); next.delete(id); return next; });
                      }}
                    />
                  </div>
                </div>

                {albums.length > 0 && (
                  <div className="artist-section">
                    <div className="section-title">Albums</div>
                    <div className="album-grid">
                      {albums.map((a) => (
                        <div key={a.id} className="album-card" onClick={() => library.handleAlbumClick(a.id)} onContextMenu={(e) => handleAlbumContextMenu(e, a.id)}>
                          <AlbumCardArt album={a} imagePath={albumImages[a.id]} onVisible={fetchAlbumImageOnDemand} />
                          <div className="album-card-body">
                            <div className="album-card-title" title={a.title}>{a.title}</div>
                            <div className="album-card-info">
                              {a.year ? `${a.year} \u00B7 ` : ""}{a.track_count} tracks
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="artist-section">
                  <div className="section-title">All Tracks</div>
                  <TrackList
                    tracks={sortedTracks}
                    currentTrack={playback.currentTrack}
                    highlightedIndex={highlightedIndex}
                    sortField={sortField}
                    trackListRef={trackListRef}
                    onDoubleClick={queueHook.playTracks}
                    onContextMenu={handleTrackContextMenu}
                    onArtistClick={library.handleArtistClick}
                    onAlbumClick={library.handleAlbumClick}
                    onSort={library.handleSort}
                    sortIndicator={library.sortIndicator}
                    onToggleLike={handleToggleLike}
                    emptyMessage="No tracks found for this artist."
                  />
                </div>
              </div>
            );
          })()}

          {/* All albums view */}
          {view === "albums" && (() => {
            const q = searchQuery.trim().toLowerCase();
            const filtered = q ? albums.filter(a => {
              const sq = stripAccents(q);
              return stripAccents(a.title.toLowerCase()).includes(sq) ||
                (a.artist_name ? stripAccents(a.artist_name.toLowerCase()).includes(sq) : false);
            }) : albums;
            return (
              <div className="album-grid" style={{ padding: 16 }}>
                {filtered.map((a) => (
                  <div key={a.id} className="album-card" onClick={() => library.handleAlbumClick(a.id)} onContextMenu={(e) => handleAlbumContextMenu(e, a.id)}>
                    <AlbumCardArt album={a} imagePath={albumImages[a.id]} onVisible={fetchAlbumImageOnDemand} />
                    <div className="album-card-body">
                      <div className="album-card-title" title={a.title}>{a.title}</div>
                      <div className="album-card-info">
                        {a.artist_name && <>{a.artist_name} {"\u00B7"} </>}
                        {a.year ? `${a.year} \u00B7 ` : ""}{a.track_count} tracks
                      </div>
                    </div>
                  </div>
                ))}
                {filtered.length === 0 && (
                  <div className="empty">{q ? `No albums matching "${searchQuery}"` : "No albums found."}</div>
                )}
              </div>
            );
          })()}

          {/* Tags list view */}
          {view === "tags" && selectedTag === null && (() => {
            const q = searchQuery.trim().toLowerCase();
            const filtered = q ? tags.filter(t => stripAccents(t.name.toLowerCase()).includes(stripAccents(q))) : tags;
            return (
              <div className="list">
                {filtered.map((t) => (
                  <div
                    key={t.id}
                    className="list-item"
                    onClick={() => { library.setSelectedTag(t.id); library.setSearchQuery(""); library.setView("all"); }}
                  >
                    <span>{t.name}</span>
                    <span className="list-count">{t.track_count}</span>
                  </div>
                ))}
                {filtered.length === 0 && (
                  <div className="empty">{q ? `No tags matching "${searchQuery}"` : "No tags found. Add a folder or server to get started."}</div>
                )}
              </div>
            );
          })()}

          {/* Album detail header */}
          {view === "all" && selectedAlbum !== null && !searchQuery.trim() && (() => {
            const album = albums.find(a => a.id === selectedAlbum);
            const albumImagePath = albumImages[selectedAlbum] ?? null;
            return (
              <div className="album-detail-header">
                <div className="album-detail-art">
                  {albumImagePath ? (
                    <img className="album-detail-art-img" src={convertFileSrc(albumImagePath)} alt={album?.title} />
                  ) : (
                    album?.title[0]?.toUpperCase() ?? "?"
                  )}
                </div>
                <div className="album-detail-info">
                  <h2>{album?.title ?? "Unknown"}</h2>
                  <span className="artist-meta">
                    {album?.artist_name && <>{album.artist_name} {"\u00B7"} </>}
                    {album?.year && <>{album.year} {"\u00B7"} </>}
                    {album?.track_count ?? 0} tracks
                  </span>
                  <ImageActions
                    entityId={selectedAlbum}
                    entityType="album"
                    imagePath={albumImagePath}
                    onImageSet={(id, path) => setAlbumImages(prev => ({ ...prev, [id]: path }))}
                    onImageRemoved={(id) => {
                      setAlbumImages(prev => ({ ...prev, [id]: null }));
                      setFetchedAlbumImages(prev => { const next = new Set(prev); next.delete(id); return next; });
                    }}
                  />
                </div>
              </div>
            );
          })()}

          {/* All tracks view */}
          {view === "all" && (
            <TrackList
              tracks={sortedTracks}
              currentTrack={playback.currentTrack}
              highlightedIndex={highlightedIndex}
              sortField={sortField}
              trackListRef={trackListRef}
              onDoubleClick={queueHook.playTracks}
              onContextMenu={handleTrackContextMenu}
              onArtistClick={library.handleArtistClick}
              onAlbumClick={library.handleAlbumClick}
              onSort={library.handleSort}
              sortIndicator={library.sortIndicator}
              onToggleLike={handleToggleLike}
              emptyMessage="No tracks found. Add a folder or server to start building your library."
            />
          )}

          {/* Liked tracks view */}
          {view === "liked" && (
            <TrackList
              tracks={sortedTracks}
              currentTrack={playback.currentTrack}
              highlightedIndex={highlightedIndex}
              sortField={sortField}
              trackListRef={trackListRef}
              onDoubleClick={queueHook.playTracks}
              onContextMenu={handleTrackContextMenu}
              onArtistClick={library.handleArtistClick}
              onAlbumClick={library.handleAlbumClick}
              onSort={library.handleSort}
              sortIndicator={library.sortIndicator}
              onToggleLike={handleToggleLike}
              emptyMessage="No liked tracks yet. Click the heart icon on any track to like it."
            />
          )}

          {/* History view */}
          {view === "history" && (
            <HistoryView searchQuery={searchQuery} onPlayTrack={queueHook.playTracks} />
          )}
        </div>
      </main>

      {queueHook.showQueue && (
        <QueuePanel
          queue={queueHook.queue}
          queueIndex={queueHook.queueIndex}
          queuePanelRef={queueHook.queuePanelRef}
          dragIndexRef={queueHook.dragIndexRef}
          onPlay={(track, index) => { queueHook.setQueueIndex(index); playback.handlePlay(track); }}
          onRemove={queueHook.removeFromQueue}
          onMove={queueHook.moveInQueue}
          onClear={queueHook.clearQueue}
          onClose={() => queueHook.setShowQueue(false)}
        />
      )}

      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          providers={searchProviders}
          onPlay={handleContextPlay}
          onEnqueue={handleContextEnqueue}
          onShowInFolder={handleShowInFolder}
          onClose={() => setContextMenu(null)}
        />
      )}

      <NowPlayingBar
        currentTrack={playback.currentTrack}
        playing={playback.playing}
        positionSecs={playback.positionSecs}
        durationSecs={playback.durationSecs}
        volume={playback.volume}
        queueMode={queueHook.queueMode}
        showQueue={queueHook.showQueue}
        autoContinueEnabled={autoContinue.enabled}
        showAutoContinuePopover={autoContinue.showPopover}
        autoContinueWeights={autoContinue.weights}
        onPause={playback.handlePause}
        onStop={playback.handleStop}
        onNext={() => queueHook.playNext()}
        onPrevious={queueHook.playPrevious}
        onSeek={playback.handleSeek}
        onVolume={playback.handleVolume}
        onToggleQueueMode={queueHook.toggleQueueMode}
        onToggleQueue={() => queueHook.setShowQueue(!queueHook.showQueue)}
        onToggleAutoContinue={() => autoContinue.setEnabled(!autoContinue.enabled)}
        onToggleAutoContinuePopover={() => autoContinue.setShowPopover(!autoContinue.showPopover)}
        onAdjustAutoContinueWeight={autoContinue.adjustWeight}
      />

      <StatusBar sessionLog={sessionLog} />
    </div>
  );
}

export default App;
