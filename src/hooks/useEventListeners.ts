import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

interface EventListenerOptions {
  loadLibrary: () => Promise<void>;
  loadTracks: () => Promise<void>;
  addNotification: (text: string) => void;
  addLog: (message: string) => void;
  setScanning: (v: boolean) => void;
  setScanProgress: (v: { scanned: number; total: number }) => void;
  setSyncing: (v: boolean) => void;
  setSyncProgress: (v: { synced: number; total: number; collection: string }) => void;
  setArtistImages: React.Dispatch<React.SetStateAction<Record<number, string | null>>>;
  setAlbumImages: React.Dispatch<React.SetStateAction<Record<number, string | null>>>;
}

export function useEventListeners(opts: EventListenerOptions) {
  const {
    loadLibrary, loadTracks,
    addNotification, addLog,
    setScanning, setScanProgress,
    setSyncing, setSyncProgress,
    setArtistImages, setAlbumImages,
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

  // Artist image events
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

  // Album image events
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
}
