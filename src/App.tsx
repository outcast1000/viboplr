import { useEffect, useState, useCallback, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

interface Artist {
  id: number;
  name: string;
  track_count: number;
}

interface Album {
  id: number;
  title: string;
  artist_id: number | null;
  artist_name: string | null;
  year: number | null;
  track_count: number;
}

interface Tag {
  id: number;
  name: string;
  track_count: number;
}

interface Track {
  id: number;
  path: string;
  title: string;
  artist_id: number | null;
  artist_name: string | null;
  album_id: number | null;
  album_title: string | null;
  track_number: number | null;
  duration_secs: number | null;
  format: string | null;
  file_size: number | null;
}

interface FolderInfo {
  id: number;
  path: string;
  last_scanned_at: number | null;
}

const VIDEO_FORMATS = ["mp4", "m4v", "mov", "webm"];

function isVideoTrack(track: Track): boolean {
  return VIDEO_FORMATS.includes(track.format?.toLowerCase() ?? "");
}

type View = "all" | "artists" | "albums" | "tags";

function getInitials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

function formatDuration(secs: number | null | undefined): string {
  if (!secs) return "--:--";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function App() {
  const [view, setView] = useState<View>("all");
  const [artists, setArtists] = useState<Artist[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [tags, setTags] = useState<Tag[]>([]);
  const [trackCount, setTrackCount] = useState(0);
  const [selectedArtist, setSelectedArtist] = useState<number | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<number | null>(null);
  const [selectedTag, setSelectedTag] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [scanProgress, setScanProgress] = useState({ scanned: 0, total: 0 });
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; trackId: number } | null>(null);
  const [artistImages, setArtistImages] = useState<Record<number, string | null>>({});
  const [fetchedArtistImages, setFetchedArtistImages] = useState<Set<number>>(new Set());
  const [albumImages, setAlbumImages] = useState<Record<number, string | null>>({});
  const [fetchedAlbumImages, setFetchedAlbumImages] = useState<Set<number>>(new Set());

  // Playback state (driven by HTML5 media events)
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionSecs, setPositionSecs] = useState(0);
  const [durationSecs, setDurationSecs] = useState(0);
  const [volume, setVolume] = useState(1.0);

  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingSrcRef = useRef<string | null>(null);
  const trackListRef = useRef<HTMLDivElement>(null);

  // Get the active media element based on current track type
  function getMediaElement(): HTMLAudioElement | HTMLVideoElement | null {
    if (currentTrack && isVideoTrack(currentTrack)) {
      return videoRef.current;
    }
    return audioRef.current;
  }

  const loadLibrary = useCallback(async () => {
    try {
      const [a, al, f, t, tc] = await Promise.all([
        invoke<Artist[]>("get_artists"),
        invoke<Album[]>("get_albums", { artistId: null }),
        invoke<FolderInfo[]>("get_folders"),
        invoke<Tag[]>("get_tags"),
        invoke<number>("get_track_count"),
      ]);
      setArtists(a);
      setAlbums(al);
      setFolders(f);
      setTags(t);
      setTrackCount(tc);
    } catch (e) {
      console.error("Failed to load library:", e);
    }
  }, []);

  const loadTracks = useCallback(async () => {
    try {
      if (searchQuery.trim()) {
        const results = await invoke<Track[]>("search", { query: searchQuery });
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
      } else {
        const results = await invoke<Track[]>("get_tracks", { albumId: null });
        setTracks(results);
      }
    } catch (e) {
      console.error("Failed to load tracks:", e);
    }
  }, [searchQuery, selectedTag, selectedAlbum, selectedArtist]);

  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    loadTracks();
  }, [loadTracks]);

  // Reset highlighted index when tracks change
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [tracks]);

  // Listen for scan events
  useEffect(() => {
    const unlisten1 = listen<{ folder: string; scanned: number; total: number }>(
      "scan-progress",
      (event) => {
        setScanning(true);
        setScanProgress({ scanned: event.payload.scanned, total: event.payload.total });
      }
    );
    const unlisten2 = listen("scan-complete", () => {
      setScanning(false);
      loadLibrary();
      loadTracks();
    });

    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
    };
  }, [loadLibrary, loadTracks]);

  // Listen for artist image ready events
  useEffect(() => {
    const unlisten = listen<{ artistId: number; path: string }>(
      "artist-image-ready",
      (event) => {
        setArtistImages((prev) => ({
          ...prev,
          [event.payload.artistId]: event.payload.path,
        }));
      }
    );
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Fetch artist image on demand when selectedArtist changes
  useEffect(() => {
    if (selectedArtist === null) return;
    // Already have image or already tried fetching
    if (artistImages[selectedArtist] !== undefined) return;
    if (fetchedArtistImages.has(selectedArtist)) return;

    const artist = artists.find((a) => a.id === selectedArtist);
    if (!artist) return;

    // Check if cached image exists
    invoke<string | null>("get_artist_image", { artistId: selectedArtist }).then((path) => {
      if (path) {
        setArtistImages((prev) => ({ ...prev, [selectedArtist]: path }));
      } else {
        // Trigger background fetch
        setFetchedArtistImages((prev) => new Set(prev).add(selectedArtist));
        invoke("fetch_artist_image", { artistId: selectedArtist, artistName: artist.name });
      }
    });
  }, [selectedArtist, artists, artistImages, fetchedArtistImages]);

  // Listen for album image ready events
  useEffect(() => {
    const unlisten = listen<{ albumId: number; path: string }>(
      "album-image-ready",
      (event) => {
        setAlbumImages((prev) => ({
          ...prev,
          [event.payload.albumId]: event.payload.path,
        }));
      }
    );
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Fetch album images on demand when albums list changes (for visible albums)
  useEffect(() => {
    for (const album of albums) {
      if (albumImages[album.id] !== undefined) continue;
      if (fetchedAlbumImages.has(album.id)) continue;
      invoke<string | null>("get_album_image", { albumId: album.id }).then((path) => {
        if (path) {
          setAlbumImages((prev) => ({ ...prev, [album.id]: path }));
        } else {
          setFetchedAlbumImages((prev) => new Set(prev).add(album.id));
          invoke("fetch_album_image", {
            albumId: album.id,
            albumTitle: album.title,
            artistName: album.artist_name,
          });
        }
      });
    }
  }, [albums, albumImages, fetchedAlbumImages]);

  // Sync volume to media elements when it changes
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

  // Start video playback once the element is available after render
  useEffect(() => {
    if (pendingSrcRef.current && currentTrack && isVideoTrack(currentTrack) && videoRef.current) {
      const src = pendingSrcRef.current;
      pendingSrcRef.current = null;
      videoRef.current.src = src;
      videoRef.current.volume = volume;
      videoRef.current.play().catch(e => console.error("Video play error:", e));
    }
  }, [currentTrack]);

  async function handleSeedDatabase() {
    setSeeding(true);
    try {
      await invoke("seed_database", {});
      await loadLibrary();
      await loadTracks();
    } catch (e) {
      console.error("Seed error:", e);
    } finally {
      setSeeding(false);
    }
  }

  async function handleClearDatabase() {
    setClearing(true);
    try {
      await invoke("clear_database", {});
      await loadLibrary();
      await loadTracks();
    } catch (e) {
      console.error("Clear database error:", e);
    } finally {
      setClearing(false);
    }
  }

  async function handleAddFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      await invoke("add_folder", { path: selected });
      loadLibrary();
    }
  }

  async function handleRemoveFolder(folderId: number) {
    await invoke("remove_folder", { folderId });
    loadLibrary();
    loadTracks();
  }

  async function handlePlay(track: Track) {
    try {
      const path = await invoke<string>("get_track_path", { trackId: track.id });
      const src = convertFileSrc(path);

      // Stop current playback on both elements
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.removeAttribute("src");
        audioRef.current.load();
      }
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.removeAttribute("src");
        videoRef.current.load();
      }

      setCurrentTrack(track);
      setPositionSecs(0);
      setDurationSecs(track.duration_secs ?? 0);

      if (isVideoTrack(track)) {
        if (videoRef.current) {
          videoRef.current.src = src;
          videoRef.current.volume = volume;
          await videoRef.current.play();
        } else {
          // Video element not yet mounted — defer to useEffect
          pendingSrcRef.current = src;
        }
      } else {
        if (audioRef.current) {
          audioRef.current.src = src;
          audioRef.current.volume = volume;
          await audioRef.current.play();
        }
      }
    } catch (e) {
      console.error("Playback error:", e);
    }
  }

  function handlePause() {
    const el = getMediaElement();
    if (!el) return;
    if (el.paused) {
      el.play();
    } else {
      el.pause();
    }
  }

  function handleStop() {
    const el = getMediaElement();
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    setCurrentTrack(null);
    setPlaying(false);
    setPositionSecs(0);
    setDurationSecs(0);
  }

  function handleVolume(level: number) {
    setVolume(level);
  }

  function handleSeek(secs: number) {
    const el = getMediaElement();
    if (el) {
      el.currentTime = secs;
    }
    setPositionSecs(secs);
  }

  // Shared media event handlers
  function onTimeUpdate(e: React.SyntheticEvent<HTMLAudioElement | HTMLVideoElement>) {
    setPositionSecs(e.currentTarget.currentTime);
  }
  function onLoadedMetadata(e: React.SyntheticEvent<HTMLAudioElement | HTMLVideoElement>) {
    setDurationSecs(e.currentTarget.duration);
  }
  function onPlay() { setPlaying(true); }
  function onPause() { setPlaying(false); }
  function onEnded() {
    setPlaying(false);
    setPositionSecs(0);
  }

  function handleArtistClick(artistId: number) {
    setSelectedArtist(artistId);
    setSelectedAlbum(null);
    setSelectedTag(null);
    setView("artists");
    invoke<Album[]>("get_albums", { artistId }).then(setAlbums);
  }

  function handleAlbumClick(albumId: number) {
    setSelectedAlbum(albumId);
    setSelectedTag(null);
    setView("all");
  }

  function handleShowAll() {
    setSelectedArtist(null);
    setSelectedAlbum(null);
    setSelectedTag(null);
    setView("all");
    setSearchQuery("");
  }

  function handleContextMenu(e: React.MouseEvent, trackId: number) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, trackId });
  }

  function handleShowInFolder() {
    if (contextMenu) {
      invoke("show_in_folder", { trackId: contextMenu.trackId });
      setContextMenu(null);
    }
  }

  return (
    <div className={`app ${currentTrack && isVideoTrack(currentTrack) ? "video-mode" : ""}`} onClick={() => setContextMenu(null)}>
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMetadata}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEnded}
      />

      {/* Sidebar */}
      <aside className="sidebar">
        <h1 className="logo">FastPlayer</h1>
        <nav className="nav">
          <button
            className={`nav-btn ${view === "all" && !selectedAlbum ? "active" : ""}`}
            onClick={handleShowAll}
          >
            All Tracks <span className="nav-count">{trackCount}</span>
          </button>
          <button
            className={`nav-btn ${view === "artists" ? "active" : ""}`}
            onClick={() => {
              setView("artists");
              setSelectedArtist(null);
              setSelectedAlbum(null);
              setSelectedTag(null);
              setSearchQuery("");
            }}
          >
            Artists <span className="nav-count">{artists.length}</span>
          </button>
          <button
            className={`nav-btn ${view === "albums" && !selectedArtist ? "active" : ""}`}
            onClick={() => {
              setView("albums");
              setSelectedArtist(null);
              setSelectedTag(null);
              setSearchQuery("");
              invoke<Album[]>("get_albums", { artistId: null }).then(setAlbums);
            }}
          >
            Albums <span className="nav-count">{albums.length}</span>
          </button>
          <button
            className={`nav-btn ${view === "tags" ? "active" : ""}`}
            onClick={() => {
              setView("tags");
              setSelectedArtist(null);
              setSelectedAlbum(null);
              setSelectedTag(null);
              setSearchQuery("");
            }}
          >
            Tags <span className="nav-count">{tags.length}</span>
          </button>
        </nav>

        <div className="folders-section">
          <h3>Folders</h3>
          {folders.map((f) => (
            <div key={f.id} className="folder-item">
              <span className="folder-path" title={f.path}>
                {f.path.split("/").pop() || f.path.split("\\").pop()}
              </span>
              <button className="folder-remove" onClick={() => handleRemoveFolder(f.id)}>
                ×
              </button>
            </div>
          ))}
          <button className="add-folder-btn" onClick={handleAddFolder}>
            + Add Folder
          </button>
          {import.meta.env.DEV && (
            <button
              className="add-folder-btn"
              onClick={handleSeedDatabase}
              disabled={seeding}
            >
              {seeding ? "Seeding..." : "Seed Test Data"}
            </button>
          )}
          {import.meta.env.DEV && (
            <button
              className="add-folder-btn"
              onClick={handleClearDatabase}
              disabled={clearing}
            >
              {clearing ? "Clearing..." : "Clear Database"}
            </button>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className="main">
        {/* Search bar */}
        <div className="search-bar">
          <input
            type="text"
            placeholder="Search tracks..."
            title=""
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value.trim()) {
                setView("all");
                setSelectedArtist(null);
                setSelectedAlbum(null);
                setSelectedTag(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlightedIndex((prev) => {
                  const next = Math.min(prev + 1, tracks.length - 1);
                  trackListRef.current?.children[next + 1]?.scrollIntoView({ block: "nearest" });
                  return next;
                });
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlightedIndex((prev) => {
                  const next = Math.max(prev - 1, 0);
                  trackListRef.current?.children[next + 1]?.scrollIntoView({ block: "nearest" });
                  return next;
                });
              } else if (e.key === "Enter" && highlightedIndex >= 0 && highlightedIndex < tracks.length) {
                e.preventDefault();
                handlePlay(tracks[highlightedIndex]);
              }
            }}
          />
          {scanning && (
            <span className="scan-status">
              Scanning... {scanProgress.scanned}/{scanProgress.total}
            </span>
          )}
        </div>

        {/* Video player area */}
        <div className="video-container" style={{ display: currentTrack && isVideoTrack(currentTrack) ? undefined : 'none' }}>
          <video
            ref={videoRef}
            onTimeUpdate={onTimeUpdate}
            onLoadedMetadata={onLoadedMetadata}
            onPlay={onPlay}
            onPause={onPause}
            onEnded={onEnded}
            onClick={handlePause}
          />
        </div>

        {/* Content area */}
        <div className="content">
          {/* Breadcrumb navigation */}
          <div className="breadcrumb">
            {searchQuery.trim() ? (
              <span>Search results for "{searchQuery}"</span>
            ) : view === "artists" && selectedArtist === null ? (
              <span>All Artists</span>
            ) : view === "artists" && selectedArtist !== null ? (
              <>
                <span className="breadcrumb-link" onClick={() => { setSelectedArtist(null); setView("artists"); }}>Artists</span>
                <span className="breadcrumb-sep"> › </span>
                <span>{artists.find(a => a.id === selectedArtist)?.name ?? "Unknown"}</span>
              </>
            ) : view === "albums" && selectedAlbum === null ? (
              <span>All Albums</span>
            ) : selectedArtist !== null && selectedAlbum !== null ? (
              <>
                <span className="breadcrumb-link" onClick={() => { setSelectedArtist(null); setSelectedAlbum(null); setView("artists"); }}>Artists</span>
                <span className="breadcrumb-sep"> › </span>
                <span className="breadcrumb-link" onClick={() => { setSelectedAlbum(null); setView("artists"); invoke<Album[]>("get_albums", { artistId: selectedArtist }).then(setAlbums); }}>{artists.find(a => a.id === selectedArtist)?.name ?? "Unknown"}</span>
                <span className="breadcrumb-sep"> › </span>
                <span>{albums.find(a => a.id === selectedAlbum)?.title ?? "Album"}</span>
              </>
            ) : view === "tags" && selectedTag === null ? (
              <span>All Tags</span>
            ) : selectedTag !== null ? (
              <>
                <span className="breadcrumb-link" onClick={() => { setSelectedTag(null); setView("tags"); }}>Tags</span>
                <span className="breadcrumb-sep"> › </span>
                <span>{tags.find(t => t.id === selectedTag)?.name ?? "Tag"}</span>
              </>
            ) : selectedAlbum !== null ? (
              <>
                <span className="breadcrumb-link" onClick={() => { setSelectedAlbum(null); setView("albums"); invoke<Album[]>("get_albums", { artistId: null }).then(setAlbums); }}>Albums</span>
                <span className="breadcrumb-sep"> › </span>
                <span>{albums.find(a => a.id === selectedAlbum)?.title ?? "Album"}</span>
              </>
            ) : (
              <span>All Tracks</span>
            )}
          </div>

          {/* Artist list */}
          {view === "artists" && !searchQuery.trim() && selectedArtist === null && (
            <div className="list">
              {artists.map((a) => (
                <div
                  key={a.id}
                  className="list-item"
                  onClick={() => handleArtistClick(a.id)}
                >
                  <span>{a.name}</span>
                  <span className="list-count">{a.track_count}</span>
                </div>
              ))}
              {artists.length === 0 && (
                <div className="empty">No artists found. Add a folder to scan.</div>
              )}
            </div>
          )}

          {/* Artist detail view */}
          {view === "artists" && !searchQuery.trim() && selectedArtist !== null && (() => {
            const artist = artists.find(a => a.id === selectedArtist);
            const artistImagePath = selectedArtist !== null ? artistImages[selectedArtist] : null;
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
                    <div className="artist-image-actions">
                      <button
                        className="artist-image-btn"
                        onClick={async () => {
                          const selected = await open({
                            multiple: false,
                            filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
                          });
                          if (selected && selectedArtist !== null) {
                            const newPath = await invoke<string>("set_artist_image", {
                              artistId: selectedArtist,
                              sourcePath: selected,
                            });
                            setArtistImages((prev) => ({ ...prev, [selectedArtist!]: newPath }));
                          }
                        }}
                      >
                        Set Image
                      </button>
                      {artistImagePath && (
                        <button
                          className="artist-image-btn"
                          onClick={() => {
                            if (selectedArtist !== null) {
                              invoke("remove_artist_image", { artistId: selectedArtist });
                              setArtistImages((prev) => ({ ...prev, [selectedArtist!]: null }));
                              setFetchedArtistImages((prev) => {
                                const next = new Set(prev);
                                next.delete(selectedArtist!);
                                return next;
                              });
                            }
                          }}
                        >
                          Remove Image
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {albums.length > 0 && (
                  <div className="artist-section">
                    <div className="section-title">Albums</div>
                    <div className="album-grid">
                      {albums.map((a) => (
                        <div key={a.id} className="album-card" onClick={() => handleAlbumClick(a.id)}>
                          <div className="album-card-art">
                            {albumImages[a.id] ? (
                              <img className="album-card-art-img" src={convertFileSrc(albumImages[a.id]!)} alt={a.title} />
                            ) : (
                              a.title[0]?.toUpperCase() ?? "?"
                            )}
                          </div>
                          <div className="album-card-body">
                            <div className="album-card-title" title={a.title}>{a.title}</div>
                            <div className="album-card-info">
                              {a.year ? `${a.year} · ` : ""}{a.track_count} tracks
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="artist-section">
                  <div className="section-title">All Tracks</div>
                  <div className="track-list" ref={trackListRef}>
                    <div className="track-header">
                      <span className="col-num">#</span>
                      <span className="col-title">Title</span>
                      <span className="col-artist">Artist</span>
                      <span className="col-album">Album</span>
                      <span className="col-duration">Duration</span>
                    </div>
                    {tracks.map((t, i) => (
                      <div
                        key={t.id}
                        className={`track-row ${currentTrack?.id === t.id ? "playing" : ""} ${highlightedIndex === i ? "highlighted" : ""}`}
                        onDoubleClick={() => handlePlay(t)}
                        onContextMenu={(e) => handleContextMenu(e, t.id)}
                      >
                        <span className="col-num">
                          {isVideoTrack(t) ? "🎬" : (t.track_number || i + 1)}
                        </span>
                        <span className="col-title">{t.title}</span>
                        <span className="col-artist">{t.artist_name || "Unknown"}</span>
                        <span className="col-album">{t.album_title || "Unknown"}</span>
                        <span className="col-duration">{formatDuration(t.duration_secs)}</span>
                      </div>
                    ))}
                    {tracks.length === 0 && (
                      <div className="empty">No tracks found for this artist.</div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* All albums view */}
          {view === "albums" && !searchQuery.trim() && (
            <div className="album-grid" style={{ padding: 16 }}>
              {albums.map((a) => (
                <div key={a.id} className="album-card" onClick={() => handleAlbumClick(a.id)}>
                  <div className="album-card-art">
                    {albumImages[a.id] ? (
                      <img className="album-card-art-img" src={convertFileSrc(albumImages[a.id]!)} alt={a.title} />
                    ) : (
                      a.title[0]?.toUpperCase() ?? "?"
                    )}
                  </div>
                  <div className="album-card-body">
                    <div className="album-card-title" title={a.title}>{a.title}</div>
                    <div className="album-card-info">
                      {a.artist_name && <>{a.artist_name} · </>}
                      {a.year ? `${a.year} · ` : ""}{a.track_count} tracks
                    </div>
                  </div>
                </div>
              ))}
              {albums.length === 0 && (
                <div className="empty">No albums found.</div>
              )}
            </div>
          )}

          {/* Tags list view */}
          {view === "tags" && !searchQuery.trim() && selectedTag === null && (
            <div className="list">
              {tags.map((t) => (
                <div
                  key={t.id}
                  className="list-item"
                  onClick={() => { setSelectedTag(t.id); setView("all"); }}
                >
                  <span>{t.name}</span>
                  <span className="list-count">{t.track_count}</span>
                </div>
              ))}
              {tags.length === 0 && (
                <div className="empty">No tags found. Add a folder to scan or seed test data.</div>
              )}
            </div>
          )}

          {(view === "all" || selectedTag !== null || searchQuery.trim()) && selectedAlbum !== null && !searchQuery.trim() && (() => {
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
                    {album?.artist_name && <>{album.artist_name} · </>}
                    {album?.year && <>{album.year} · </>}
                    {album?.track_count ?? 0} tracks
                  </span>
                  <div className="artist-image-actions">
                    <button
                      className="artist-image-btn"
                      onClick={async () => {
                        const selected = await open({
                          multiple: false,
                          filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
                        });
                        if (selected && selectedAlbum !== null) {
                          const newPath = await invoke<string>("set_album_image", {
                            albumId: selectedAlbum,
                            sourcePath: selected,
                          });
                          setAlbumImages((prev) => ({ ...prev, [selectedAlbum!]: newPath }));
                        }
                      }}
                    >
                      Set Image
                    </button>
                    {albumImagePath && (
                      <button
                        className="artist-image-btn"
                        onClick={() => {
                          if (selectedAlbum !== null) {
                            invoke("remove_album_image", { albumId: selectedAlbum });
                            setAlbumImages((prev) => ({ ...prev, [selectedAlbum!]: null }));
                            setFetchedAlbumImages((prev) => {
                              const next = new Set(prev);
                              next.delete(selectedAlbum!);
                              return next;
                            });
                          }
                        }}
                      >
                        Remove Image
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {(view === "all" || selectedTag !== null || searchQuery.trim()) && (
            <div className="track-list" ref={trackListRef}>
              <div className="track-header">
                <span className="col-num">#</span>
                <span className="col-title">Title</span>
                <span className="col-artist">Artist</span>
                <span className="col-album">Album</span>
                <span className="col-duration">Duration</span>
              </div>
              {tracks.map((t, i) => (
                <div
                  key={t.id}
                  className={`track-row ${currentTrack?.id === t.id ? "playing" : ""} ${highlightedIndex === i ? "highlighted" : ""}`}
                  onDoubleClick={() => handlePlay(t)}
                  onContextMenu={(e) => handleContextMenu(e, t.id)}
                >
                  <span className="col-num">
                    {isVideoTrack(t) ? "🎬" : (t.track_number || i + 1)}
                  </span>
                  <span className="col-title">{t.title}</span>
                  <span className="col-artist">{t.artist_name || "Unknown"}</span>
                  <span className="col-album">{t.album_title || "Unknown"}</span>
                  <span className="col-duration">{formatDuration(t.duration_secs)}</span>
                </div>
              ))}
              {tracks.length === 0 && (
                <div className="empty">
                  No tracks found. Add a folder to start building your library.
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <div className="context-menu-item" onClick={handleShowInFolder}>
            Open Containing Folder
          </div>
        </div>
      )}

      {/* Now playing bar */}
      <footer className="now-playing">
        <div className="now-info">
          {currentTrack ? (
            <>
              <span className="now-title">{currentTrack.title}</span>
              <span className="now-artist">{currentTrack.artist_name || "Unknown"}</span>
            </>
          ) : (
            <span className="now-title">No track playing</span>
          )}
        </div>
        <div className="now-center">
          <div className="now-controls">
            <button className="ctrl-btn" onClick={handleStop}>⏹</button>
            <button className="ctrl-btn play-btn" onClick={handlePause}>
              {playing ? "⏸" : "▶"}
            </button>
          </div>
          <div className="now-seek">
            <span className="time-label">{formatDuration(positionSecs)}</span>
            <input
              type="range"
              className="seek-bar"
              min="0"
              max={durationSecs || 1}
              step="0.5"
              value={positionSecs}
              onChange={(e) => handleSeek(parseFloat(e.target.value))}
            />
            <span className="time-label">{formatDuration(durationSecs)}</span>
          </div>
        </div>
        <div className="now-volume">
          <span>🔊</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(e) => handleVolume(parseFloat(e.target.value))}
          />
        </div>
      </footer>
    </div>
  );
}

export default App;
