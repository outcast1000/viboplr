import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

interface EventListenerOptions {
  loadLibrary: () => Promise<void>;
  loadTracks: () => Promise<void>;
  addLog: (message: string) => void;
  setScanning: (v: boolean) => void;
  setScanProgress: (v: { scanned: number; total: number }) => void;
  setSyncing: (v: boolean) => void;
  setSyncProgress: (v: { synced: number; total: number; collection: string }) => void;
  onResyncDone?: () => void;
}

export function useEventListeners(opts: EventListenerOptions) {
  const {
    loadLibrary, loadTracks,
    addLog,
    setScanning, setScanProgress,
    setSyncing, setSyncProgress,
    onResyncDone,
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
      onResyncDone?.();
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
      onResyncDone?.();
      loadLibrary();
      loadTracks();
    });
    const unlisten3 = listen<{ collectionId: number; error: string }>("sync-error", (event) => {
      syncStarted = false;
      setSyncing(false);
      addLog("Sync error: " + event.payload.error);
      console.error("Sync error:", event.payload.error);
      onResyncDone?.();
      loadLibrary();
      loadTracks();
    });

    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
      unlisten3.then((f) => f());
    };
  }, [loadLibrary, loadTracks]);

  // Bulk edit events
  useEffect(() => {
    const unlisten = listen("bulk-edit-complete", () => {
      loadLibrary();
      loadTracks();
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [loadLibrary, loadTracks]);

  // Download complete — refresh library so the new track appears
  useEffect(() => {
    const unlisten = listen("download-complete", () => {
      loadLibrary();
      loadTracks();
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [loadLibrary, loadTracks]);

}
