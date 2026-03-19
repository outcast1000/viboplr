import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Artist, Album } from "../types";

interface EventListenerOptions {
  loadLibrary: () => Promise<void>;
  loadTracks: () => Promise<void>;
  addLog: (message: string) => void;
  setScanning: (v: boolean) => void;
  setScanProgress: (v: { scanned: number; total: number }) => void;
  setSyncing: (v: boolean) => void;
  setSyncProgress: (v: { synced: number; total: number; collection: string }) => void;
  setArtistImages: React.Dispatch<React.SetStateAction<Record<number, string | null>>>;
  setAlbumImages: React.Dispatch<React.SetStateAction<Record<number, string | null>>>;
  setFailedArtistImages: React.Dispatch<React.SetStateAction<Set<number>>>;
  setFailedAlbumImages: React.Dispatch<React.SetStateAction<Set<number>>>;
  artistsRef: React.RefObject<Artist[]>;
  albumsRef: React.RefObject<Album[]>;
}

export function useEventListeners(opts: EventListenerOptions) {
  const {
    loadLibrary, loadTracks,
    addLog,
    setScanning, setScanProgress,
    setSyncing, setSyncProgress,
    setArtistImages, setAlbumImages,
    setFailedArtistImages, setFailedAlbumImages,
    artistsRef, albumsRef,
  } = opts;

  // Scan events
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
      addLog("Scan complete");
      loadLibrary();
      loadTracks();
    });

    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
    };
  }, [loadLibrary, loadTracks]);

  // Sync events
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
      addLog("Sync complete");
      loadLibrary();
      loadTracks();
    });
    const unlisten3 = listen<string>("sync-error", (event) => {
      syncStarted = false;
      setSyncing(false);
      addLog("Sync error: " + event.payload);
      console.error("Sync error:", event.payload);
      loadLibrary();
      loadTracks();
    });

    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
      unlisten3.then((f) => f());
    };
  }, [loadLibrary, loadTracks]);

  // Artist image events
  useEffect(() => {
    const unlisten = listen<{ artistId: number; path: string }>(
      "artist-image-ready",
      (event) => {
        addLog("Artist image ready: " + (artistsRef.current.find(a => a.id === event.payload.artistId)?.name ?? "id=" + event.payload.artistId));
        setArtistImages((prev) => ({
          ...prev,
          [event.payload.artistId]: event.payload.path,
        }));
      }
    );
    const unlisten2 = listen<{ artistId: number; error: string }>(
      "artist-image-error",
      (event) => {
        addLog("Artist image error (" + (artistsRef.current.find(a => a.id === event.payload.artistId)?.name ?? "id=" + event.payload.artistId) + "): " + event.payload.error);
        setFailedArtistImages((prev) => new Set(prev).add(event.payload.artistId));
      }
    );
    return () => { unlisten.then((f) => f()); unlisten2.then((f) => f()); };
  }, []);

  // Album image events
  useEffect(() => {
    const unlisten = listen<{ albumId: number; path: string }>(
      "album-image-ready",
      (event) => {
        addLog("Album image ready: " + (albumsRef.current.find(a => a.id === event.payload.albumId)?.title ?? "id=" + event.payload.albumId));
        setAlbumImages((prev) => ({
          ...prev,
          [event.payload.albumId]: event.payload.path,
        }));
      }
    );
    const unlisten2 = listen<{ albumId: number; error: string }>(
      "album-image-error",
      (event) => {
        addLog("Album image error (" + (albumsRef.current.find(a => a.id === event.payload.albumId)?.title ?? "id=" + event.payload.albumId) + "): " + event.payload.error);
        setFailedAlbumImages((prev) => new Set(prev).add(event.payload.albumId));
      }
    );
    return () => { unlisten.then((f) => f()); unlisten2.then((f) => f()); };
  }, []);
}
