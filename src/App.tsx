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
  collection_id: number | null;
  subsonic_id: string | null;
}

interface Collection {
  id: number;
  kind: "local" | "subsonic" | "seed";
  name: string;
  path: string | null;
  url: string | null;
  username: string | null;
  last_synced_at: number | null;
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

function collectionKindLabel(kind: string): string {
  switch (kind) {
    case "local": return "Local";
    case "subsonic": return "Server";
    case "seed": return "Test";
    default: return kind;
  }
}

function AlbumCardArt({ album, imagePath, onVisible }: {
  album: Album;
  imagePath: string | null | undefined;
  onVisible: (album: Album) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || imagePath !== undefined) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { onVisible(album); observer.disconnect(); } },
      { threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [album, imagePath, onVisible]);

  return (
    <div ref={ref} className="album-card-art">
      {imagePath ? (
        <img className="album-card-art-img" src={convertFileSrc(imagePath)} alt={album.title} />
      ) : (
        album.title[0]?.toUpperCase() ?? "?"
      )}
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>("all");
  const [artists, setArtists] = useState<Artist[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [tags, setTags] = useState<Tag[]>([]);
  const [trackCount, setTrackCount] = useState(0);
  const [albumCount, setAlbumCount] = useState(0);
  const [selectedArtist, setSelectedArtist] = useState<number | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<number | null>(null);
  const [selectedTag, setSelectedTag] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [scanProgress, setScanProgress] = useState({ scanned: 0, total: 0 });
  const [syncProgress, setSyncProgress] = useState({ synced: 0, total: 0, collection: "" });
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; trackId: number; subsonic: boolean } | null>(null);
  const [artistImages, setArtistImages] = useState<Record<number, string | null>>({});
  const [fetchedArtistImages, setFetchedArtistImages] = useState<Set<number>>(new Set());
  const [albumImages, setAlbumImages] = useState<Record<number, string | null>>({});
  const [fetchedAlbumImages, setFetchedAlbumImages] = useState<Set<number>>(new Set());
  const [showAddServer, setShowAddServer] = useState(false);
  const [serverForm, setServerForm] = useState({ name: "", url: "", username: "", password: "" });
  const [showSettings, setShowSettings] = useState(false);
  const [notifications, setNotifications] = useState<{ id: number; text: string }[]>([]);
  const [sessionLog, setSessionLog] = useState<{ time: Date; message: string }[]>([]);
  const notifIdRef = useRef(0);
  const [settingsTab, setSettingsTab] = useState<"main" | "collections" | "logging">("main");

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

  function addNotification(text: string) {
    const id = ++notifIdRef.current;
    setNotifications(prev => [...prev, { id, text }]);
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 3000);
  }

  function addLog(message: string) {
    setSessionLog(prev => [...prev, { time: new Date(), message }]);
  }

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
    let scanStarted = false;
    const unlisten1 = listen<{ folder: string; scanned: number; total: number }>(
      "scan-progress",
      (event) => {
        if (!scanStarted) {
          scanStarted = true;
          addLog("Scan started: " + event.payload.folder);
        }
        setScanning(true);
        setScanProgress({ scanned: event.payload.scanned, total: event.payload.total });
      }
    );
    const unlisten2 = listen("scan-complete", () => {
      scanStarted = false;
      setScanning(false);
      addNotification("Scan complete");
      addLog("Scan complete");
      loadLibrary();
      loadTracks();
    });

    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
    };
  }, [loadLibrary, loadTracks]);

  // Listen for sync events
  useEffect(() => {
    let syncStarted = false;
    const unlisten1 = listen<{ collection: string; synced: number; total: number }>(
      "sync-progress",
      (event) => {
        if (!syncStarted) {
          syncStarted = true;
          addLog("Sync started: " + event.payload.collection);
        }
        setSyncing(true);
        setSyncProgress({
          synced: event.payload.synced,
          total: event.payload.total,
          collection: event.payload.collection,
        });
      }
    );
    const unlisten2 = listen("sync-complete", () => {
      syncStarted = false;
      setSyncing(false);
      addNotification("Sync complete");
      addLog("Sync complete");
      loadLibrary();
      loadTracks();
    });
    const unlisten3 = listen<string>("sync-error", (event) => {
      syncStarted = false;
      setSyncing(false);
      addNotification("Sync failed");
      addLog("Sync error: " + event.payload);
      console.error("Sync error:", event.payload);
    });

    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
      unlisten3.then((f) => f());
    };
  }, [loadLibrary, loadTracks]);

  // Listen for artist image ready/error events
  useEffect(() => {
    const unlisten = listen<{ artistId: number; path: string }>(
      "artist-image-ready",
      (event) => {
        addNotification("Artist image loaded");
        addLog("Artist image ready: id=" + event.payload.artistId);
        setArtistImages((prev) => ({
          ...prev,
          [event.payload.artistId]: event.payload.path,
        }));
      }
    );
    const unlisten2 = listen<{ artistId: number; error: string }>(
      "artist-image-error",
      (event) => {
        addNotification("Artist image error (id=" + event.payload.artistId + "): " + event.payload.error);
        addLog("Artist image error (id=" + event.payload.artistId + "): " + event.payload.error);
      }
    );
    return () => { unlisten.then((f) => f()); unlisten2.then((f) => f()); };
  }, []);

  // Fetch artist image on demand — only for the currently selected artist
  const fetchedArtistImagesRef = useRef(fetchedArtistImages);
  fetchedArtistImagesRef.current = fetchedArtistImages;
  const artistImagesRef = useRef(artistImages);
  artistImagesRef.current = artistImages;
  useEffect(() => {
    if (selectedArtist === null) return;
    if (artistImagesRef.current[selectedArtist] !== undefined) return;
    if (fetchedArtistImagesRef.current.has(selectedArtist)) return;

    const artist = artists.find((a) => a.id === selectedArtist);
    if (!artist) return;

    setFetchedArtistImages((prev) => new Set(prev).add(selectedArtist));

    invoke<string | null>("get_artist_image", { artistId: selectedArtist }).then((path) => {
      if (path) {
        setArtistImages((prev) => ({ ...prev, [selectedArtist]: path }));
      } else {
        invoke("fetch_artist_image", { artistId: selectedArtist, artistName: artist.name });
        addLog("Requested artist image: " + artist.name);
      }
    });
  }, [selectedArtist, artists]);

  // Listen for album image ready/error events
  useEffect(() => {
    const unlisten = listen<{ albumId: number; path: string }>(
      "album-image-ready",
      (event) => {
        addLog("Album image ready: id=" + event.payload.albumId);
        setAlbumImages((prev) => ({
          ...prev,
          [event.payload.albumId]: event.payload.path,
        }));
      }
    );
    const unlisten2 = listen<{ albumId: number; error: string }>(
      "album-image-error",
      (event) => {
        addNotification("Album image error (id=" + event.payload.albumId + "): " + event.payload.error);
        addLog("Album image error (id=" + event.payload.albumId + "): " + event.payload.error);
      }
    );
    return () => { unlisten.then((f) => f()); unlisten2.then((f) => f()); };
  }, []);

  // Fetch a single album's image: check cache first, then fire-and-forget network fetch
  const fetchedAlbumImagesRef = useRef(fetchedAlbumImages);
  fetchedAlbumImagesRef.current = fetchedAlbumImages;
  const albumImagesRef = useRef(albumImages);
  albumImagesRef.current = albumImages;
  const fetchAlbumImageOnDemand = useCallback((album: Album) => {
    if (albumImagesRef.current[album.id] !== undefined) return;
    if (fetchedAlbumImagesRef.current.has(album.id)) return;
    setFetchedAlbumImages((prev) => new Set(prev).add(album.id));

    invoke<string | null>("get_album_image", { albumId: album.id }).then((path) => {
      if (path) {
        setAlbumImages((prev) => ({ ...prev, [album.id]: path }));
      } else {
        invoke("fetch_album_image", { albumId: album.id, albumTitle: album.title, artistName: album.artist_name });
        addLog("Requested album image: " + album.title);
      }
    });
  }, []);

  // Fetch album image when viewing album detail
  useEffect(() => {
    if (selectedAlbum === null) return;
    const album = albums.find(a => a.id === selectedAlbum);
    if (album) fetchAlbumImageOnDemand(album);
  }, [selectedAlbum]);

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
      const folderName = selected.split("/").pop() || selected.split("\\").pop() || selected;
      await invoke("add_collection", { kind: "local", name: folderName, path: selected });
      loadLibrary();
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
      loadLibrary();
    } catch (e) {
      console.error("Failed to add server:", e);
      alert("Failed to connect: " + e);
    }
  }

  async function handleSeedDatabase() {
    try {
      await invoke("add_collection", { kind: "seed", name: "Test Data" });
      await loadLibrary();
      await loadTracks();
    } catch (e) {
      console.error("Seed error:", e);
    }
  }

  async function handleRemoveCollection(collectionId: number) {
    await invoke("remove_collection", { collectionId });
    loadLibrary();
    loadTracks();
  }

  async function handleResyncCollection(collectionId: number) {
    await invoke("resync_collection", { collectionId });
  }

  async function handlePlay(track: Track) {
    try {
      const pathOrUrl = await invoke<string>("get_track_path", { trackId: track.id });
      const src = track.subsonic_id ? pathOrUrl : convertFileSrc(pathOrUrl);

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
    setSelectedArtist(null);
    setSelectedAlbum(null);
    setSelectedTag(null);
    setView("all");
    setSearchQuery("");
  }

  function handleContextMenu(e: React.MouseEvent, track: Track) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, trackId: track.id, subsonic: !!track.subsonic_id });
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
            Albums <span className="nav-count">{albumCount}</span>
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

        <button className="settings-btn" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </aside>

      {/* Add Server Modal */}
      {showAddServer && (
        <div className="modal-overlay" onClick={() => setShowAddServer(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add Subsonic Server</h2>
            <div className="modal-field">
              <label>Display Name</label>
              <input
                type="text"
                placeholder="My Server"
                value={serverForm.name}
                onChange={(e) => setServerForm({ ...serverForm, name: e.target.value })}
              />
            </div>
            <div className="modal-field">
              <label>Server URL</label>
              <input
                type="text"
                placeholder="https://music.example.com"
                value={serverForm.url}
                onChange={(e) => setServerForm({ ...serverForm, url: e.target.value })}
              />
            </div>
            <div className="modal-field">
              <label>Username</label>
              <input
                type="text"
                value={serverForm.username}
                onChange={(e) => setServerForm({ ...serverForm, username: e.target.value })}
              />
            </div>
            <div className="modal-field">
              <label>Password</label>
              <input
                type="password"
                value={serverForm.password}
                onChange={(e) => setServerForm({ ...serverForm, password: e.target.value })}
              />
            </div>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => setShowAddServer(false)}>
                Cancel
              </button>
              <button className="modal-btn modal-btn-confirm" onClick={handleAddServer}>
                Connect
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings panel */}
      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-panel" onClick={e => e.stopPropagation()}>
            <div className="settings-header">
              <h2>Settings</h2>
              <button className="settings-close" onClick={() => setShowSettings(false)}>×</button>
            </div>

            <div className="settings-tabs">
              <button className={`settings-tab ${settingsTab === "main" ? "active" : ""}`} onClick={() => setSettingsTab("main")}>Main</button>
              <button className={`settings-tab ${settingsTab === "collections" ? "active" : ""}`} onClick={() => setSettingsTab("collections")}>Collections</button>
              <button className={`settings-tab ${settingsTab === "logging" ? "active" : ""}`} onClick={() => setSettingsTab("logging")}>Logging</button>
            </div>

            {settingsTab === "main" && (
              <div className="settings-section">
                <div className="log-empty">No settings yet</div>
              </div>
            )}

            {settingsTab === "collections" && (
              <div className="settings-section">
                {collections.map((c) => (
                  <div key={c.id} className="collection-item">
                    <span className={`collection-kind collection-kind-${c.kind}`}>
                      {collectionKindLabel(c.kind)}
                    </span>
                    <span className="collection-name" title={c.path || c.url || c.name}>
                      {c.name}
                    </span>
                    <button
                      className="collection-action collection-resync"
                      onClick={() => handleResyncCollection(c.id)}
                      title="Resync"
                    >
                      ↻
                    </button>
                    <button
                      className="collection-action collection-remove"
                      onClick={() => handleRemoveCollection(c.id)}
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button className="add-folder-btn" onClick={handleAddFolder}>
                  + Add Folder
                </button>
                <button className="add-folder-btn" onClick={() => setShowAddServer(true)}>
                  + Add Server
                </button>
                {import.meta.env.DEV && (
                  <button className="add-folder-btn" onClick={handleSeedDatabase}>
                    Seed Test Data
                  </button>
                )}
                {import.meta.env.DEV && (
                  <button className="add-folder-btn" onClick={handleClearDatabase} disabled={clearing}>
                    {clearing ? "Clearing..." : "Clear Database"}
                  </button>
                )}
              </div>
            )}

            {settingsTab === "logging" && (
              <div className="settings-section">
                <div className="session-log">
                  {sessionLog.length === 0 && <div className="log-empty">No events yet</div>}
                  {[...sessionLog].reverse().map((entry, i) => (
                    <div key={i} className="log-entry">
                      <span className="log-time">{entry.time.toLocaleTimeString()}</span>
                      <span className="log-message">{entry.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="main">
        {/* Search bar */}
        <div className="search-bar">
          <input
            type="text"
            placeholder={
              view === "artists" && selectedArtist === null ? "Search artists..." :
              view === "albums" ? "Search albums..." :
              view === "tags" && selectedTag === null ? "Search tags..." :
              "Search tracks..."
            }
            title=""
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
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
          {syncing && (
            <span className="scan-status">
              Syncing {syncProgress.collection}... {syncProgress.synced}/{syncProgress.total} albums
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
            {view === "artists" && selectedArtist === null ? (
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
          {view === "artists" && selectedArtist === null && (() => {
            const q = searchQuery.trim().toLowerCase();
            const filtered = q ? artists.filter(a => a.name.toLowerCase().includes(q)) : artists;
            return (
              <div className="list">
                {filtered.map((a) => (
                  <div
                    key={a.id}
                    className="list-item"
                    onClick={() => handleArtistClick(a.id)}
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
                          <AlbumCardArt album={a} imagePath={albumImages[a.id]} onVisible={fetchAlbumImageOnDemand} />
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
                        onContextMenu={(e) => handleContextMenu(e, t)}
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
          {view === "albums" && (() => {
            const q = searchQuery.trim().toLowerCase();
            const filtered = q ? albums.filter(a =>
              a.title.toLowerCase().includes(q) ||
              (a.artist_name?.toLowerCase().includes(q) ?? false)
            ) : albums;
            return (
              <div className="album-grid" style={{ padding: 16 }}>
                {filtered.map((a) => (
                  <div key={a.id} className="album-card" onClick={() => handleAlbumClick(a.id)}>
                    <AlbumCardArt album={a} imagePath={albumImages[a.id]} onVisible={fetchAlbumImageOnDemand} />
                    <div className="album-card-body">
                      <div className="album-card-title" title={a.title}>{a.title}</div>
                      <div className="album-card-info">
                        {a.artist_name && <>{a.artist_name} · </>}
                        {a.year ? `${a.year} · ` : ""}{a.track_count} tracks
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
            const filtered = q ? tags.filter(t => t.name.toLowerCase().includes(q)) : tags;
            return (
              <div className="list">
                {filtered.map((t) => (
                  <div
                    key={t.id}
                    className="list-item"
                    onClick={() => { setSelectedTag(t.id); setSearchQuery(""); setView("all"); }}
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

          {view === "all" && (
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
                  onContextMenu={(e) => handleContextMenu(e, t)}
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
                  No tracks found. Add a folder or server to start building your library.
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
          {!contextMenu.subsonic && (
            <div className="context-menu-item" onClick={handleShowInFolder}>
              Open Containing Folder
            </div>
          )}
          {contextMenu.subsonic && (
            <div className="context-menu-item" style={{ color: "var(--text-secondary)", cursor: "default" }}>
              Server track
            </div>
          )}
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

      {/* Toast notifications */}
      <div className="notifications">
        {notifications.map(n => (
          <div key={n.id} className="toast">{n.text}</div>
        ))}
      </div>
    </div>
  );
}

export default App;
