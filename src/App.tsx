import { useEffect, useState, useCallback, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

import type { Album, Collection, Track, View, ColumnConfig, SortField, SortDir } from "./types";
import { isVideoTrack, getInitials } from "./utils";
import { store } from "./store";
import type { SearchProviderConfig } from "./searchProviders";
import { DEFAULT_PROVIDERS, loadProviders, saveProviders } from "./searchProviders";
import { timeAsync, getTimingEntries, type TimingEntry } from "./startupTiming";

import { usePlayback } from "./hooks/usePlayback";
import { useQueue } from "./hooks/useQueue";
import { useLibrary } from "./hooks/useLibrary";
import { useEventListeners } from "./hooks/useEventListeners";
import { useAutoContinue } from "./hooks/useAutoContinue";
import { usePasteImage } from "./hooks/usePasteImage";
import { useNavigationHistory, type NavState } from "./hooks/useNavigationHistory";

import { Sidebar } from "./components/Sidebar";
import { TrackList } from "./components/TrackList";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { QueuePanel } from "./components/QueuePanel";
import { SettingsPanel, type UpdateState } from "./components/SettingsPanel";
import { AddServerModal } from "./components/AddServerModal";
import { ContextMenu } from "./components/ContextMenu";
import type { ContextMenuState } from "./components/ContextMenu";
import { Breadcrumb } from "./components/Breadcrumb";
import { AlbumCardArt } from "./components/AlbumCardArt";
import { ImageActions } from "./components/ImageActions";
import { HistoryView } from "./components/HistoryView";
import type { HistoryViewHandle } from "./components/HistoryView";
import { TidalView } from "./components/TidalView";
import { AddTidalModal } from "./components/AddTidalModal";
import { TrackPropertiesModal } from "./components/TrackPropertiesModal";
import { StatusBar } from "./components/StatusBar";

const stripAccents = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const MINI_HEIGHT = 40;
const MINI_MIN_WIDTH = 280;
const MINI_MAX_WIDTH = 550;
const MINI_INITIAL_WIDTH = 500;

function measureMiniFooter(): number {
  const footer = document.querySelector(".now-playing-mini") as HTMLElement;
  if (!footer) return MINI_INITIAL_WIDTH;
  const clone = footer.cloneNode(true) as HTMLElement;
  clone.style.cssText = "position:fixed;top:-9999px;left:-9999px;visibility:hidden;width:max-content;pointer-events:none;";
  document.body.appendChild(clone);
  const width = clone.offsetWidth;
  document.body.removeChild(clone);
  return Math.max(MINI_MIN_WIDTH, Math.min(width + 16, MINI_MAX_WIDTH));
}

function App() {
  const restoredRef = useRef(false);
  const trackListRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<HistoryViewHandle>(null);
  const previousVolumeRef = useRef(1.0);

  // Mini mode state
  const [miniMode, setMiniMode] = useState(false);
  const miniModeRef = useRef(false);
  const fullSizeRef = useRef<{ w: number; h: number; x: number; y: number } | null>(null);

  // Core hooks
  const peekNextRef = useRef<() => Track | null>(() => null);
  const crossfadeSecsRef = useRef(3);
  const [crossfadeSecs, setCrossfadeSecs] = useState(3);
  crossfadeSecsRef.current = crossfadeSecs;
  const advanceIndexRef = useRef<() => void>(() => {});
  const playback = usePlayback(restoredRef, peekNextRef, crossfadeSecsRef, advanceIndexRef);
  const beforeNavRef = useRef<() => void>(() => {});
  const library = useLibrary(restoredRef, () => beforeNavRef.current());
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
  const [showAddTidal, setShowAddTidal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionLog, setSessionLog] = useState<{ time: Date; message: string }[]>([]);
  const [statusHint, setStatusHint] = useState<string | null>(null);
  const [searchProviders, setSearchProviders] = useState<SearchProviderConfig[]>(DEFAULT_PROVIDERS);
  const [backendTimings, setBackendTimings] = useState<TimingEntry[]>([]);
  const [youtubeFeedback, setYoutubeFeedback] = useState<{
    trackId: number; url: string; videoTitle: string;
  } | null>(null);
  const [propertiesTrack, setPropertiesTrack] = useState<Track | null>(null);

  // Update state
  const [appVersion, setAppVersion] = useState("");
  const [updateState, setUpdateState] = useState<UpdateState>({
    available: null,
    checking: false,
    downloading: false,
    progress: null,
    upToDate: false,
  });
  const updateRef = useRef<Awaited<ReturnType<typeof check>>>(null);

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

  // Toggle mini mode
  const toggleMiniMode = useCallback(async () => {
    const win = getCurrentWindow();
    const factor = await win.scaleFactor();
    if (!miniModeRef.current) {
      // Entering mini mode — save current full geometry
      const size = await win.innerSize();
      const pos = await win.outerPosition();
      const geo = { w: size.width / factor, h: size.height / factor, x: pos.x / factor, y: pos.y / factor };
      fullSizeRef.current = geo;
      store.set("fullWindowWidth", geo.w);
      store.set("fullWindowHeight", geo.h);
      store.set("fullWindowX", geo.x);
      store.set("fullWindowY", geo.y);
      await win.setSize(new LogicalSize(MINI_INITIAL_WIDTH, MINI_HEIGHT));
      // Restore saved mini position if available
      const [mx, my] = await Promise.all([
        store.get<number | null>("miniWindowX"),
        store.get<number | null>("miniWindowY"),
      ]);
      if (mx != null && my != null) {
        await win.setPosition(new LogicalPosition(mx, my));
      }
      await win.setAlwaysOnTop(true);
      await win.setDecorations(false);
      setMiniMode(true);
      miniModeRef.current = true;
      store.set("miniMode", true);
    } else {
      // Exiting mini mode — save mini position, then restore full geometry
      const pos = await win.outerPosition();
      store.set("miniWindowX", pos.x / factor);
      store.set("miniWindowY", pos.y / factor);
      await win.setDecorations(true);
      await win.setAlwaysOnTop(false);
      const geo = fullSizeRef.current;
      if (geo) {
        await win.setSize(new LogicalSize(geo.w, geo.h));
        await win.setPosition(new LogicalPosition(geo.x, geo.y));
      } else {
        // Fallback: read from store
        const [fw, fh, fx, fy] = await Promise.all([
          store.get<number | null>("fullWindowWidth"),
          store.get<number | null>("fullWindowHeight"),
          store.get<number | null>("fullWindowX"),
          store.get<number | null>("fullWindowY"),
        ]);
        if (fw && fh) await win.setSize(new LogicalSize(fw, fh));
        if (fx != null && fy != null) await win.setPosition(new LogicalPosition(fx, fy));
      }
      setMiniMode(false);
      miniModeRef.current = false;
      store.set("miniMode", false);
    }
  }, []);

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

  const statusActivity = scanning
    ? `Scanning... ${scanProgress.scanned}/${scanProgress.total}`
    : syncing
    ? `Syncing ${syncProgress.collection}... ${syncProgress.synced}/${syncProgress.total} albums`
    : null;

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

  const applyNavState = useCallback((s: NavState) => {
    library.setView(s.view);
    library.setSelectedArtist(s.selectedArtist);
    library.setSelectedAlbum(s.selectedAlbum);
    library.setSelectedTag(s.selectedTag);
    library.setSearchQuery(s.searchQuery);
    // Restore scroll position after React renders the new view
    requestAnimationFrame(() => {
      if (contentRef.current) contentRef.current.scrollTop = s.scrollTop;
    });
  }, [library.setView, library.setSelectedArtist, library.setSelectedAlbum, library.setSelectedTag, library.setSearchQuery]);

  const getScrollTop = useCallback(() => contentRef.current?.scrollTop ?? 0, []);

  const { pushState, goBack, goForward, canGoBack, canGoForward } = useNavigationHistory(
    {
      view: library.view,
      selectedArtist: library.selectedArtist,
      selectedAlbum: library.selectedAlbum,
      selectedTag: library.selectedTag,
      searchQuery: library.searchQuery,
    },
    applyNavState,
    getScrollTop,
  );

  // Push history and reset scroll for the new view.
  // Used by all navigation triggers (sidebar, keyboard, click handlers).
  const pushAndScroll = useCallback(() => {
    pushState();
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [pushState]);
  beforeNavRef.current = pushAndScroll;

  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;
  const goForwardRef = useRef(goForward);
  goForwardRef.current = goForward;
  const pushStateRef = useRef(pushAndScroll);
  pushStateRef.current = pushAndScroll;

  // Disable default browser context menu globally
  useEffect(() => {
    const handler = (e: MouseEvent) => { e.preventDefault(); };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  // Load app version and auto-check for updates on startup
  useEffect(() => {
    getVersion().then(setAppVersion);
    const timer = setTimeout(async () => {
      try {
        const update = await check();
        if (update) {
          updateRef.current = update;
          setUpdateState(s => ({ ...s, available: { version: update.version, body: update.body ?? "" } }));
        }
      } catch {
        // Silently ignore — no update endpoint configured or network error
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // Restore persisted state on mount
  useEffect(() => {
    (async () => {
      try {
        await timeAsync("store.init", () => store.init());
        const [v, sq, sa, sal, st, tid, vol, qIds, qIdx, qMode, pos, cf, wasMini, fww, fwh, fwx, fwy, tSortField, tSortDir, tCols] = await timeAsync("store.restore (20 keys)", () => Promise.all([
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
          store.get<number>("crossfadeSecs"),
          store.get<boolean>("miniMode"),
          store.get<number | null>("fullWindowWidth"),
          store.get<number | null>("fullWindowHeight"),
          store.get<number | null>("fullWindowX"),
          store.get<number | null>("fullWindowY"),
          store.get<string | null>("trackSortField"),
          store.get<string>("trackSortDir"),
          store.get<ColumnConfig[] | null>("trackColumns"),
        ]));
        if (v && ["all", "artists", "albums", "tags", "liked", "history", "tidal"].includes(v)) library.setView(v as View);
        if (sq) library.setSearchQuery(sq);
        if (sa !== undefined && sa !== null) {
          library.setSelectedArtist(sa);
        }
        if (sal !== undefined && sal !== null) library.setSelectedAlbum(sal);
        if (st !== undefined && st !== null) library.setSelectedTag(st);
        if (vol !== undefined && vol !== null) playback.setVolume(vol);
        if (cf !== undefined && cf !== null) setCrossfadeSecs(cf);
        if (tSortField && ["num", "title", "artist", "album", "duration", "path", "year", "quality", "collection"].includes(tSortField)) library.setSortField(tSortField as SortField);
        if (tSortDir && ["asc", "desc"].includes(tSortDir)) library.setSortDir(tSortDir as SortDir);
        if (tCols && Array.isArray(tCols) && tCols.length > 0) library.setTrackColumns(tCols);
        const [restoredTrack, restoredTracks, trackPath] = await timeAsync("restore IPC (track/queue/path)", () => Promise.all([
          tid ? invoke<Track>("get_track_by_id", { trackId: tid }).catch(() => null) : Promise.resolve(null),
          qIds?.length ? invoke<Track[]>("get_tracks_by_ids", { ids: qIds }).catch(() => []) : Promise.resolve([]),
          tid ? invoke<string>("get_track_path", { trackId: tid }).catch(() => null) : Promise.resolve(null),
        ]));
        if (restoredTrack && trackPath) await timeAsync("playback.handleRestore", () => playback.handleRestore(restoredTrack, pos ?? 0, trackPath));
        if (restoredTracks && restoredTracks.length) {
          queueHook.setQueue(restoredTracks);
          const idx = qIdx ?? -1;
          queueHook.setQueueIndex(idx >= 0 && idx < restoredTracks.length ? idx : -1);
        }
        if (qMode && ["normal", "loop", "shuffle"].includes(qMode)) {
          queueHook.setQueueMode(qMode as "normal" | "loop" | "shuffle");
        }
        await timeAsync("window.restore", async () => {
          // Size/position already restored by Rust setup — just set React state and show
          if (wasMini) {
            if (fww && fwh) fullSizeRef.current = { w: fww, h: fwh, x: fwx ?? 0, y: fwy ?? 0 };
            setMiniMode(true);
            miniModeRef.current = true;
          }
          await getCurrentWindow().show();
        });
      } catch (e) {
        console.error("Failed to restore state:", e);
        await getCurrentWindow().show();
      }
      await timeAsync("loadProviders", () => loadProviders(store).then(setSearchProviders));
      restoredRef.current = true;
      await timeAsync("loadLibrary", () => library.loadLibrary());
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
        const pos = await win.outerPosition();
        if (miniModeRef.current) {
          store.set("miniWindowX", pos.x / factor);
          store.set("miniWindowY", pos.y / factor);
        } else {
          const size = await win.innerSize();
          store.set("windowWidth", size.width / factor);
          store.set("windowHeight", size.height / factor);
          store.set("windowX", pos.x / factor);
          store.set("windowY", pos.y / factor);
        }
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

  // Auto-resize mini window when track changes or mini mode is entered
  const miniSettledRef = useRef(false);
  useEffect(() => {
    if (!miniMode) { miniSettledRef.current = false; return; }
    const frame = requestAnimationFrame(async () => {
      const win = getCurrentWindow();
      const newWidth = measureMiniFooter();
      if (miniSettledRef.current) {
        // Track changed while in mini mode — pin right edge
        const factor = await win.scaleFactor();
        const size = await win.innerSize();
        const pos = await win.outerPosition();
        const rightEdge = pos.x / factor + size.width / factor;
        await win.setSize(new LogicalSize(newWidth, MINI_HEIGHT));
        await win.setPosition(new LogicalPosition(rightEdge - newWidth, pos.y / factor));
      } else {
        // Just entered mini mode — set size only, keep position
        await win.setSize(new LogicalSize(newWidth, MINI_HEIGHT));
        miniSettledRef.current = true;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [miniMode, playback.currentTrack]);

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

  // Fetch album/artist image when current track changes (for Now Playing bar)
  useEffect(() => {
    const track = playback.currentTrack;
    if (!track) return;
    if (track.album_id) {
      fetchAlbumImageOnDemand({ id: track.album_id, title: track.album_title ?? "", artist_name: track.artist_name } as Album);
    }
    if (track.artist_id) {
      if (artistImagesRef.current[track.artist_id] !== undefined) return;
      if (fetchedArtistImagesRef.current.has(track.artist_id)) return;
      if (failedArtistImagesRef.current.has(track.artist_id)) return;
      setFetchedArtistImages((prev) => new Set(prev).add(track.artist_id!));
      invoke<string | null>("get_artist_image", { artistId: track.artist_id }).then((path) => {
        if (path) {
          setArtistImages((prev) => ({ ...prev, [track.artist_id!]: path }));
        } else {
          invoke("fetch_artist_image", { artistId: track.artist_id, artistName: track.artist_name ?? "Unknown" });
        }
      });
    }
  }, [playback.currentTrack]);

  // Ref for keyboard shortcut handler to avoid stale closures
  const shortcutStateRef = useRef({
    volume: playback.volume,
    showQueue: queueHook.showQueue,
    getMediaElement: playback.getMediaElement,
    handleSeek: playback.handleSeek,
  });
  shortcutStateRef.current = {
    volume: playback.volume,
    showQueue: queueHook.showQueue,
    getMediaElement: playback.getMediaElement,
    handleSeek: playback.handleSeek,
  };

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Alt+Arrow: navigation history
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === "ArrowLeft") { e.preventDefault(); goBackRef.current(); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); goForwardRef.current(); return; }
      }

      if (!(e.ctrlKey || e.metaKey)) return;

      const s = shortcutStateRef.current;

      switch (e.key) {
        case "1":
          e.preventDefault();
          library.handleShowAll();
          searchInputRef.current?.focus();
          break;
        case "2":
          e.preventDefault();
          pushStateRef.current();
          library.setView("artists");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSearchQuery("");
          searchInputRef.current?.focus();
          break;
        case "3":
          e.preventDefault();
          pushStateRef.current();
          library.setView("albums");
          library.setSelectedArtist(null);
          library.setSelectedTag(null);
          library.setSearchQuery("");
          searchInputRef.current?.focus();
          break;
        case "4":
          e.preventDefault();
          pushStateRef.current();
          library.setView("tags");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSearchQuery("");
          searchInputRef.current?.focus();
          break;
        case "5":
          e.preventDefault();
          library.handleShowLiked();
          searchInputRef.current?.focus();
          break;
        case "6":
          e.preventDefault();
          pushStateRef.current();
          library.setView("history");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSearchQuery("");
          searchInputRef.current?.focus();
          break;
        case "7":
          e.preventDefault();
          queueHook.setShowQueue(!s.showQueue);
          break;
        case "m":
          e.preventDefault();
          if (s.volume > 0) {
            previousVolumeRef.current = s.volume;
            playback.handleVolume(0);
          } else {
            playback.handleVolume(previousVolumeRef.current || 1.0);
          }
          break;
        case "M":
          e.preventDefault();
          toggleMiniMode();
          break;
        case "ArrowLeft": {
          e.preventDefault();
          const el = s.getMediaElement();
          if (el) s.handleSeek(Math.max(0, el.currentTime - 15));
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          const el = s.getMediaElement();
          if (el) s.handleSeek(Math.min(el.duration || 0, el.currentTime + 15));
          break;
        }
        case "ArrowUp":
          e.preventDefault();
          playback.handleVolume(Math.min(1, s.volume + 0.05));
          break;
        case "ArrowDown":
          e.preventDefault();
          playback.handleVolume(Math.max(0, s.volume - 0.05));
          break;
        case ">":
          e.preventDefault();
          handleNext();
          break;
        case "<":
          e.preventDefault();
          queueHook.playPrevious();
          break;
        case "[":
          e.preventDefault();
          goBackRef.current();
          break;
        case "]":
          e.preventDefault();
          goForwardRef.current();
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Mouse side buttons for navigation history
  useEffect(() => {
    function handleMouseUp(e: MouseEvent) {
      if (e.button === 3) { e.preventDefault(); goBackRef.current(); }
      if (e.button === 4) { e.preventDefault(); goForwardRef.current(); }
    }
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  // onEnded handler — uses refs to avoid stale closures from useCallback([])
  const autoContinueRef = useRef(autoContinue);
  autoContinueRef.current = autoContinue;
  const currentTrackRef = useRef(playback.currentTrack);
  currentTrackRef.current = playback.currentTrack;
  const handleStopRef = useRef(playback.handleStop);
  handleStopRef.current = playback.handleStop;

  const handleNext = useCallback(async () => {
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

  const onEnded = useCallback(async () => {
    if (playback.handleGaplessNext()) {
      queueHook.advanceIndex();
      return;
    }
    handleNext();
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

  function handleShowProperties() {
    if (!contextMenu || contextMenu.target.kind !== "track") return;
    const { trackId } = contextMenu.target;
    const track = library.tracks.find(t => t.id === trackId);
    if (track) setPropertiesTrack(track);
    setContextMenu(null);
  }

  async function handleWatchOnYoutube() {
    if (!contextMenu || contextMenu.target.kind !== "track") return;
    const { trackId, title, artistName } = contextMenu.target;

    // Use saved URL if available
    const track = tracks.find(t => t.id === trackId);
    if (track?.youtube_url) {
      await openUrl(track.youtube_url);
      addLog(`Opened YouTube: ${title}`);
      return;
    }

    addLog("Searching YouTube...");
    try {
      const result = await invoke<{ url: string; video_title: string | null }>(
        "search_youtube", { title, artistName }
      );
      await openUrl(result.url);
      addLog(`Opened YouTube: ${result.video_title ?? title}`);
      setYoutubeFeedback({ trackId, url: result.url, videoTitle: result.video_title ?? title });
    } catch {
      const q = encodeURIComponent(`${title} ${artistName ?? ""}`);
      await openUrl(`https://www.youtube.com/results?search_query=${q}`);
      addLog("YouTube search failed, opened search results");
    }
  }

  async function handleYoutubeFeedback(correct: boolean) {
    if (!youtubeFeedback) return;
    if (correct) {
      await invoke("set_track_youtube_url", {
        trackId: youtubeFeedback.trackId,
        url: youtubeFeedback.url,
      });
      library.setTracks(prev => prev.map(t => t.id === youtubeFeedback.trackId ? { ...t, youtube_url: youtubeFeedback.url } : t));
      addLog("Saved YouTube link for future use");
    }
    setYoutubeFeedback(null);
  }

  async function handleAddFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      const folderName = selected.split("/").pop() || selected.split("\\").pop() || selected;
      await invoke("add_collection", { kind: "local", name: folderName, path: selected });
      library.loadLibrary();
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

  async function handleCheckForUpdates() {
    setUpdateState(s => ({ ...s, checking: true, upToDate: false }));
    try {
      const update = await check();
      if (update) {
        updateRef.current = update;
        setUpdateState(s => ({ ...s, checking: false, available: { version: update.version, body: update.body ?? "" } }));
      } else {
        setUpdateState(s => ({ ...s, checking: false, upToDate: true }));
      }
    } catch {
      setUpdateState(s => ({ ...s, checking: false, upToDate: true }));
    }
  }

  async function handleInstallUpdate() {
    const update = updateRef.current;
    if (!update) return;
    setUpdateState(s => ({ ...s, downloading: true, progress: null }));
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          setUpdateState(s => ({ ...s, progress: { downloaded: 0, total: event.data.contentLength! } }));
        } else if (event.event === "Progress") {
          setUpdateState(s => ({
            ...s,
            progress: s.progress
              ? { downloaded: s.progress.downloaded + event.data.chunkLength, total: s.progress.total }
              : null,
          }));
        }
      });
      await relaunch();
    } catch {
      setUpdateState(s => ({ ...s, downloading: false, progress: null }));
      addLog("Failed to install update.");
    }
  }

  async function handleRemoveCollection(collectionId: number) {
    await invoke("remove_collection", { collectionId });
    library.loadLibrary();
    library.loadTracks();
  }

  async function handleResyncCollection(collectionId: number) {
    await invoke("resync_collection", { collectionId });
  }

  async function handleUpdateCollection(collectionId: number, name: string, autoUpdate: boolean, autoUpdateIntervalMins: number, enabled: boolean) {
    await invoke("update_collection", { collectionId, name, autoUpdate, autoUpdateIntervalMins, enabled });
    library.loadLibrary();
    library.loadTracks();
  }

  async function handleToggleCollectionEnabled(collection: Collection) {
    await invoke("update_collection", {
      collectionId: collection.id,
      name: collection.name,
      autoUpdate: collection.auto_update,
      autoUpdateIntervalMins: collection.auto_update_interval_mins,
      enabled: !collection.enabled,
    });
    library.loadLibrary();
    library.loadTracks();
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

  async function handleToggleArtistLike(artistId: number) {
    const artist = artists.find(a => a.id === artistId);
    if (!artist) return;
    const newLiked = !artist.liked;
    try {
      await invoke("toggle_artist_liked", { artistId, liked: newLiked });
      library.setArtists(prev => prev.map(a => a.id === artistId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle artist like:", e);
    }
  }

  async function handleToggleAlbumLike(albumId: number) {
    const album = albums.find(a => a.id === albumId);
    if (!album) return;
    const newLiked = !album.liked;
    try {
      await invoke("toggle_album_liked", { albumId, liked: newLiked });
      library.setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle album like:", e);
    }
  }

  const { view, selectedArtist, selectedAlbum, selectedTag, artists, albums, tags, tracks,
    searchQuery, sortedTracks, sortField, highlightedIndex, highlightedListIndex } = library;

  // Filtered lists for keyboard navigation
  const filteredArtists = (() => {
    if (view !== "artists" || selectedArtist !== null) return [];
    const q = searchQuery.trim().toLowerCase();
    return q ? library.sortedArtists.filter(a => stripAccents(a.name.toLowerCase()).includes(stripAccents(q))) : library.sortedArtists;
  })();

  const filteredAlbums = (() => {
    if (view !== "albums") return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return library.sortedAlbums;
    const sq = stripAccents(q);
    return library.sortedAlbums.filter(a =>
      stripAccents(a.title.toLowerCase()).includes(sq) ||
      (a.artist_name ? stripAccents(a.artist_name.toLowerCase()).includes(sq) : false)
    );
  })();

  const filteredTags = (() => {
    if (view !== "tags" || selectedTag !== null) return [];
    const q = searchQuery.trim().toLowerCase();
    return q ? library.sortedTags.filter(t => stripAccents(t.name.toLowerCase()).includes(stripAccents(q))) : library.sortedTags;
  })();

  const isListView = (view === "artists" && selectedArtist === null) || view === "albums" || (view === "tags" && selectedTag === null);
  const isHistoryView = view === "history";
  const tidalCollection = library.collections.find(c => c.kind === "tidal" && c.enabled);
  const hasTidal = !!tidalCollection;

  return (
    <div className={`app ${playback.currentTrack && isVideoTrack(playback.currentTrack) ? "video-mode" : ""} ${queueHook.showQueue ? "queue-open" : ""} ${miniMode ? "mini-mode" : ""}`} onClick={() => setContextMenu(null)}>
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
        hasTidal={hasTidal}
        onNavHover={setStatusHint}
        onShowAll={library.handleShowAll}
        onShowArtists={() => {
          pushAndScroll();
          library.setView("artists");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSearchQuery("");
        }}
        onShowAlbums={() => {
          pushAndScroll();
          library.setView("albums");
          library.setSelectedArtist(null);
          library.setSelectedTag(null);
          library.setSearchQuery("");
        }}
        onShowTags={() => {
          pushAndScroll();
          library.setView("tags");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSearchQuery("");
        }}
        onShowLiked={library.handleShowLiked}
        onShowHistory={() => {
          pushAndScroll();
          library.setView("history");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSearchQuery("");
        }}
        onShowTidal={() => {
          pushAndScroll();
          library.setView("tidal");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSearchQuery("");
        }}
        onShowSettings={() => setShowSettings(true)}
        updateAvailable={updateState.available !== null}
      />

      {showAddServer && (
        <AddServerModal
          onAdded={() => {
            setShowAddServer(false);
            library.loadLibrary();
          }}
          onClose={() => setShowAddServer(false)}
        />
      )}

      {showAddTidal && (
        <AddTidalModal
          onAdded={() => {
            setShowAddTidal(false);
            library.loadLibrary();
          }}
          onClose={() => setShowAddTidal(false)}
        />
      )}

      {showSettings && (
        <SettingsPanel
          collections={library.collections}
          searchProviders={searchProviders}
          onClose={() => setShowSettings(false)}
          onAddFolder={handleAddFolder}
          onShowAddServer={() => { setShowAddServer(true); setShowSettings(false); }}
          onShowAddTidal={() => { setShowAddTidal(true); setShowSettings(false); }}
          onRemoveCollection={handleRemoveCollection}
          onResyncCollection={handleResyncCollection}
          onUpdateCollection={handleUpdateCollection}
          onToggleCollectionEnabled={handleToggleCollectionEnabled}
          onSeedDatabase={handleSeedDatabase}
          onClearDatabase={handleClearDatabase}
          clearing={clearing}
          onClearImageFailures={handleClearImageFailures}
          onSaveProviders={handleSaveProviders}
          crossfadeSecs={crossfadeSecs}
          onCrossfadeChange={handleCrossfadeChange}
          appVersion={appVersion}
          updateState={updateState}
          onCheckForUpdates={handleCheckForUpdates}
          onInstallUpdate={handleInstallUpdate}
          backendTimings={backendTimings}
          frontendTimings={getTimingEntries()}
          onFetchBackendTimings={() => invoke<TimingEntry[]>("get_startup_timings").then(setBackendTimings)}
        />
      )}

      {/* Main content */}
      <main className="main">
        {/* Search bar */}
        <div className="search-bar">
          <button
            className="nav-history-btn"
            disabled={!canGoBack}
            onClick={goBack}
            title="Go back (Alt+Left)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            className="nav-history-btn"
            disabled={!canGoForward}
            onClick={goForward}
            title="Go forward (Alt+Right)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </button>
          <input
            ref={searchInputRef}
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
              if (e.ctrlKey || e.metaKey || e.altKey) return;
              if (isHistoryView) {
                const count = historyRef.current?.count ?? 0;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  library.setHighlightedListIndex((prev) => {
                    const next = Math.min(prev + 1, count - 1);
                    document.querySelector(`.history-row[data-history-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
                    return next;
                  });
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  library.setHighlightedListIndex((prev) => {
                    const next = Math.max(prev - 1, 0);
                    document.querySelector(`.history-row[data-history-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
                    return next;
                  });
                } else if (e.key === "Enter" && highlightedListIndex >= 0 && highlightedListIndex < count) {
                  e.preventDefault();
                  if (e.shiftKey) {
                    historyRef.current?.enqueueItem(highlightedListIndex);
                  } else {
                    historyRef.current?.playItem(highlightedListIndex);
                  }
                }
              } else if (isListView) {
                const list = view === "artists" ? filteredArtists : view === "albums" ? filteredAlbums : filteredTags;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  library.setHighlightedListIndex((prev) => {
                    const next = Math.min(prev + 1, list.length - 1);
                    if (view === "albums") {
                      document.querySelector(`.album-grid .album-card:nth-child(${next + 1})`)?.scrollIntoView({ block: "nearest" });
                    } else {
                      document.querySelector(`.list .list-item:nth-child(${next + 1})`)?.scrollIntoView({ block: "nearest" });
                    }
                    return next;
                  });
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  library.setHighlightedListIndex((prev) => {
                    const next = Math.max(prev - 1, 0);
                    if (view === "albums") {
                      document.querySelector(`.album-grid .album-card:nth-child(${next + 1})`)?.scrollIntoView({ block: "nearest" });
                    } else {
                      document.querySelector(`.list .list-item:nth-child(${next + 1})`)?.scrollIntoView({ block: "nearest" });
                    }
                    return next;
                  });
                } else if (e.key === "Enter" && highlightedListIndex >= 0 && highlightedListIndex < list.length) {
                  e.preventDefault();
                  const item = list[highlightedListIndex];
                  if (view === "artists") {
                    library.handleArtistClick(item.id);
                  } else if (view === "albums") {
                    library.handleAlbumClick(item.id);
                  } else {
                    pushAndScroll();
                    library.setSelectedTag(item.id);
                    library.setSearchQuery("");
                    library.setView("all");
                  }
                }
              } else {
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
                  if (e.shiftKey) {
                    queueHook.enqueueTracks([tracks[highlightedIndex]]);
                  } else {
                    queueHook.playTracks([tracks[highlightedIndex]], 0);
                  }
                }
              }
            }}
          />
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
        <div className="content" ref={contentRef}>
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
            onPlayAll={queueHook.playTracks}
            onEnqueueAll={queueHook.enqueueTracks}
          />

          {/* Artist list */}
          {view === "artists" && selectedArtist === null && (
            <>
              <div className="sort-bar">
                <div className="sort-options">
                  <button className={`sort-btn${library.artistSortField === "name" ? " active" : ""}`} onClick={() => library.handleArtistSort("name")}>
                    Name{library.artistSortField === "name" ? (library.artistSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                  </button>
                  <button className={`sort-btn${library.artistSortField === "tracks" ? " active" : ""}`} onClick={() => library.handleArtistSort("tracks")}>
                    Tracks{library.artistSortField === "tracks" ? (library.artistSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                  </button>
                  <button className={`sort-btn${library.artistSortField === "random" ? " active" : ""}`} onClick={() => library.handleArtistSort("random")}>
                    Shuffle
                  </button>
                </div>
                <button
                  className={`sort-btn liked-first-btn${library.artistLikedFirst ? " active" : ""}`}
                  onClick={() => library.setArtistLikedFirst(v => !v)}
                  title="Liked first"
                >{"\u2665"}</button>
              </div>
              <div className="list">
              {filteredArtists.map((a, i) => (
                <div
                  key={a.id}
                  className={`list-item${i === highlightedListIndex ? " highlighted" : ""}`}
                  onClick={() => library.handleArtistClick(a.id)}
                  onContextMenu={(e) => handleArtistContextMenu(e, a.id)}
                >
                  <span
                    className="list-item-like"
                    onClick={(e) => { e.stopPropagation(); handleToggleArtistLike(a.id); }}
                  >{a.liked ? "\u2665" : "\u2661"}</span>
                  <span style={{ flex: 1 }}>{a.name}</span>
                  <span className="list-count">{a.track_count}</span>
                </div>
              ))}
              {filteredArtists.length === 0 && (
                <div className="empty">{searchQuery.trim() ? `No artists matching "${searchQuery}"` : "No artists found. Add a folder or server to get started."}</div>
              )}
            </div>
            </>
          )}

          {/* Artist detail view */}
          {view === "artists" && selectedArtist !== null && selectedAlbum === null && (() => {
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
                    <h2>
                      {artist?.name ?? "Unknown"}
                      <span
                        className={`detail-like-btn${artist?.liked ? " liked" : ""}`}
                        onClick={() => handleToggleArtistLike(selectedArtist)}
                        title={artist?.liked ? "Unlike artist" : "Like artist"}
                      >{artist?.liked ? "\u2665" : "\u2661"}</span>
                    </h2>
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

                {library.artistAlbums.length > 0 && (
                  <div className="artist-section">
                    <div className="section-title">Albums</div>
                    <div className="album-grid">
                      {library.artistAlbums.map((a) => (
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
                    columns={library.trackColumns}
                    onColumnsChange={library.setTrackColumns}
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
          {view === "albums" && (
            <>
              <div className="sort-bar">
                <div className="sort-options">
                  <button className={`sort-btn${library.albumSortField === "name" ? " active" : ""}`} onClick={() => library.handleAlbumSort("name")}>
                    Name{library.albumSortField === "name" ? (library.albumSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                  </button>
                  <button className={`sort-btn${library.albumSortField === "year" ? " active" : ""}`} onClick={() => library.handleAlbumSort("year")}>
                    Year{library.albumSortField === "year" ? (library.albumSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                  </button>
                  <button className={`sort-btn${library.albumSortField === "random" ? " active" : ""}`} onClick={() => library.handleAlbumSort("random")}>
                    Shuffle
                  </button>
                </div>
                <button
                  className={`sort-btn liked-first-btn${library.albumLikedFirst ? " active" : ""}`}
                  onClick={() => library.setAlbumLikedFirst(v => !v)}
                  title="Liked first"
                >{"\u2665"}</button>
              </div>
              <div className="album-grid" style={{ padding: 16 }}>
                {filteredAlbums.map((a, i) => (
                  <div key={a.id} className={`album-card${i === highlightedListIndex ? " highlighted" : ""}`} onClick={() => library.handleAlbumClick(a.id)} onContextMenu={(e) => handleAlbumContextMenu(e, a.id)}>
                    <AlbumCardArt album={a} imagePath={albumImages[a.id]} onVisible={fetchAlbumImageOnDemand} />
                    <div
                      className={`album-card-like${a.liked ? " liked" : ""}`}
                      onClick={(e) => { e.stopPropagation(); handleToggleAlbumLike(a.id); }}
                    >{a.liked ? "\u2665" : "\u2661"}</div>
                    <div className="album-card-body">
                      <div className="album-card-title" title={a.title}>{a.title}</div>
                      <div className="album-card-info">
                        {a.artist_name && <>{a.artist_name} {"\u00B7"} </>}
                        {a.year ? `${a.year} \u00B7 ` : ""}{a.track_count} tracks
                      </div>
                    </div>
                  </div>
                ))}
                {filteredAlbums.length === 0 && (
                  <div className="empty">{searchQuery.trim() ? `No albums matching "${searchQuery}"` : "No albums found."}</div>
                )}
              </div>
            </>
          )}

          {/* Tags list view */}
          {view === "tags" && selectedTag === null && (
            <>
              <div className="sort-bar">
                <div className="sort-options">
                  <button className={`sort-btn${library.tagSortField === "name" ? " active" : ""}`} onClick={() => library.handleTagSort("name")}>
                    Name{library.tagSortField === "name" ? (library.tagSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                  </button>
                  <button className={`sort-btn${library.tagSortField === "tracks" ? " active" : ""}`} onClick={() => library.handleTagSort("tracks")}>
                    Tracks{library.tagSortField === "tracks" ? (library.tagSortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                  </button>
                  <button className={`sort-btn${library.tagSortField === "random" ? " active" : ""}`} onClick={() => library.handleTagSort("random")}>
                    Shuffle
                  </button>
                </div>
              </div>
              <div className="list">
                {filteredTags.map((t, i) => (
                  <div
                    key={t.id}
                    className={`list-item${i === highlightedListIndex ? " highlighted" : ""}`}
                    onClick={() => { pushAndScroll(); library.setSelectedTag(t.id); library.setSearchQuery(""); library.setView("all"); }}
                  >
                    <span>{t.name}</span>
                    <span className="list-count">{t.track_count}</span>
                  </div>
                ))}
                {filteredTags.length === 0 && (
                  <div className="empty">{searchQuery.trim() ? `No tags matching "${searchQuery}"` : "No tags found. Add a folder or server to get started."}</div>
                )}
              </div>
            </>
          )}

          {/* Album detail header */}
          {(view === "all" || view === "artists") && selectedAlbum !== null && !searchQuery.trim() && (() => {
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
                  <h2>
                    {album?.title ?? "Unknown"}
                    <span
                      className={`detail-like-btn${album?.liked ? " liked" : ""}`}
                      onClick={() => handleToggleAlbumLike(selectedAlbum)}
                      title={album?.liked ? "Unlike album" : "Like album"}
                    >{album?.liked ? "\u2665" : "\u2661"}</span>
                  </h2>
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
          {(view === "all" || (view === "artists" && selectedAlbum !== null)) && (
            <TrackList
              tracks={sortedTracks}
              currentTrack={playback.currentTrack}
              highlightedIndex={highlightedIndex}
              sortField={sortField}
              trackListRef={trackListRef}
              columns={library.trackColumns}
              onColumnsChange={library.setTrackColumns}
              onDoubleClick={queueHook.playTracks}
              onContextMenu={handleTrackContextMenu}
              onArtistClick={library.handleArtistClick}
              onAlbumClick={library.handleAlbumClick}
              onSort={library.handleSort}
              sortIndicator={library.sortIndicator}
              onToggleLike={handleToggleLike}
              emptyMessage="No tracks found. Add a folder or server to start building your library."
              hasMore={library.hasMore}
              loadingMore={library.loadingMore}
              onLoadMore={library.loadMore}
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
              columns={library.trackColumns}
              onColumnsChange={library.setTrackColumns}
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
            <HistoryView ref={historyRef} searchQuery={searchQuery} highlightedIndex={highlightedListIndex} onPlayTrack={queueHook.playTracks} onEnqueueTrack={queueHook.enqueueTracks} />
          )}

          {/* TIDAL view */}
          {view === "tidal" && tidalCollection && (
            <TidalView
              collectionId={tidalCollection.id}
              onPlayTracks={queueHook.playTracks}
              onEnqueueTracks={queueHook.enqueueTracks}
            />
          )}
        </div>
      </main>

      {queueHook.showQueue && (
        <QueuePanel
          queue={queueHook.queue}
          queueIndex={queueHook.queueIndex}
          queuePanelRef={queueHook.queuePanelRef}
          dragIndexRef={queueHook.dragIndexRef}
          playlistName={queueHook.playlistName}
          onPlay={(track, index) => { queueHook.setQueueIndex(index); playback.handlePlay(track); }}
          onRemove={queueHook.removeFromQueue}
          onMove={queueHook.moveInQueue}
          onClear={queueHook.clearQueue}
          onClose={() => queueHook.setShowQueue(false)}
          onSavePlaylist={queueHook.savePlaylist}
          onLoadPlaylist={queueHook.loadPlaylist}
        />
      )}

      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          providers={searchProviders}
          onPlay={handleContextPlay}
          onEnqueue={handleContextEnqueue}
          onShowInFolder={handleShowInFolder}
          onWatchOnYoutube={handleWatchOnYoutube}
          onShowProperties={handleShowProperties}
          onClose={() => setContextMenu(null)}
        />
      )}

      {propertiesTrack && (
        <TrackPropertiesModal
          track={propertiesTrack}
          collections={library.collections}
          onClose={() => setPropertiesTrack(null)}
          onYoutubeUrlChange={(trackId, url) => {
            library.setTracks(prev => prev.map(t => t.id === trackId ? { ...t, youtube_url: url } : t));
            setPropertiesTrack(prev => prev && prev.id === trackId ? { ...prev, youtube_url: url } : prev);
          }}
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
        imagePath={
          (playback.currentTrack?.album_id && albumImages[playback.currentTrack.album_id])
          || (playback.currentTrack?.artist_id && artistImages[playback.currentTrack.artist_id])
          || null
        }
        miniMode={miniMode}
        onToggleMiniMode={toggleMiniMode}
        onClose={() => getCurrentWindow().close()}
        onPause={playback.handlePause}
        onStop={playback.handleStop}
        onNext={handleNext}
        onPrevious={queueHook.playPrevious}
        onSeek={playback.handleSeek}
        onVolume={playback.handleVolume}
        onMute={() => {
          if (playback.volume > 0) {
            previousVolumeRef.current = playback.volume;
            playback.handleVolume(0);
          } else {
            playback.handleVolume(previousVolumeRef.current || 1.0);
          }
        }}
        onToggleQueueMode={queueHook.toggleQueueMode}
        onToggleQueue={() => queueHook.setShowQueue(!queueHook.showQueue)}
        onToggleAutoContinue={() => autoContinue.setEnabled(!autoContinue.enabled)}
        onToggleAutoContinuePopover={() => autoContinue.setShowPopover(!autoContinue.showPopover)}
        onAdjustAutoContinueWeight={autoContinue.adjustWeight}
        onArtistClick={library.handleArtistClick}
        onAlbumClick={library.handleAlbumClick}
      />

      <StatusBar
        sessionLog={sessionLog}
        hint={statusHint}
        activity={statusActivity}
        feedback={youtubeFeedback ? {
          message: `Was "${youtubeFeedback.videoTitle}" the right video?`,
          onYes: () => handleYoutubeFeedback(true),
          onNo: () => handleYoutubeFeedback(false),
        } : null}
      />
    </div>
  );
}

export default App;
