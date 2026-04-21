import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

interface ResyncProgress {
  collectionId: number;
  collectionName: string;
  kind: "scan" | "sync";
  scanned: number;
  total: number;
}

interface ResyncComplete {
  collectionId: number;
  collectionName: string;
  newTracks: number;
  removedTracks: number;
  error?: string;
}

interface EventListenerOptions {
  loadLibrary: () => Promise<void>;
  loadTracks: () => Promise<void>;
  addLog: (message: string, module?: string) => void;
  setScanning: (v: boolean) => void;
  setScanProgress: (v: { scanned: number; total: number }) => void;
  setSyncing: (v: boolean) => void;
  setSyncProgress: (v: { synced: number; total: number; collection: string }) => void;
  onResyncDone?: () => void;
  resyncingCollectionName: string | null;
  setResyncProgress: (v: ResyncProgress | null) => void;
  setResyncComplete: (v: ResyncComplete | null) => void;
  dispatchPluginEvent?: (event: string, ...args: unknown[]) => void;
}

export type { ResyncProgress, ResyncComplete };

export function useEventListeners(opts: EventListenerOptions) {
  const {
    loadLibrary, loadTracks,
    addLog,
    setScanning, setScanProgress,
    setSyncing, setSyncProgress,
    onResyncDone,
    resyncingCollectionName,
    setResyncProgress,
    setResyncComplete,
  } = opts;

  // Scan events
  useEffect(() => {
    let scanStarted = false;
    const unlisten1 = listen<{ folder: string; scanned: number; total: number; collection_id?: number }>(
      "scan-progress",
      (event) => {
        if (!scanStarted) {
          scanStarted = true;
          addLog("Scan started: " + event.payload.folder, "scanner");
        }
        setScanning(true);
        setScanProgress({ scanned: event.payload.scanned, total: event.payload.total });
        if (event.payload.collection_id != null) {
          setResyncComplete(null);
          setResyncProgress({
            collectionId: event.payload.collection_id,
            collectionName: resyncingCollectionName ?? event.payload.folder,
            kind: "scan",
            scanned: event.payload.scanned,
            total: event.payload.total,
          });
        }
      }
    );
    const unlisten2 = listen<{ folder?: string; collectionId?: number; newTracks?: number; removedTracks?: number }>("scan-complete", (event) => {
      scanStarted = false;
      setScanning(false);
      addLog("Scan complete", "scanner");
      onResyncDone?.();
      if (event.payload.collectionId != null) {
        setResyncProgress(null);
        setResyncComplete({
          collectionId: event.payload.collectionId,
          collectionName: resyncingCollectionName ?? event.payload.folder ?? "Collection",
          newTracks: event.payload.newTracks ?? 0,
          removedTracks: event.payload.removedTracks ?? 0,
        });
        setTimeout(() => setResyncComplete(null), 3000);
      }
      loadLibrary();
      loadTracks();
      opts.dispatchPluginEvent?.("scan:complete" as any, {
        collectionId: event.payload.collectionId,
        newTracks: event.payload.newTracks ?? 0,
        removedTracks: event.payload.removedTracks ?? 0,
      });
    });

    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
    };
  }, [loadLibrary, loadTracks, resyncingCollectionName]);

  // Sync events
  useEffect(() => {
    let syncStarted = false;
    const unlisten1 = listen<{ collection: string; synced: number; total: number; collection_id?: number }>(
      "sync-progress",
      (event) => {
        if (!syncStarted) {
          syncStarted = true;
          addLog("Sync started: " + event.payload.collection, "sync");
        }
        setSyncing(true);
        setSyncProgress({
          synced: event.payload.synced,
          total: event.payload.total,
          collection: event.payload.collection,
        });
        if (event.payload.collection_id != null) {
          setResyncComplete(null);
          setResyncProgress({
            collectionId: event.payload.collection_id,
            collectionName: resyncingCollectionName ?? event.payload.collection,
            kind: "sync",
            scanned: event.payload.synced,
            total: event.payload.total,
          });
        }
      }
    );
    const unlisten2 = listen<{ collectionId: number; newTracks?: number; removedTracks?: number }>("sync-complete", (event) => {
      syncStarted = false;
      setSyncing(false);
      addLog("Sync complete", "sync");
      onResyncDone?.();
      setResyncProgress(null);
      setResyncComplete({
        collectionId: event.payload.collectionId,
        collectionName: resyncingCollectionName ?? "Collection",
        newTracks: event.payload.newTracks ?? 0,
        removedTracks: event.payload.removedTracks ?? 0,
      });
      setTimeout(() => setResyncComplete(null), 3000);
      loadLibrary();
      loadTracks();
      opts.dispatchPluginEvent?.("scan:complete" as any, {
        collectionId: event.payload.collectionId,
        newTracks: event.payload.newTracks ?? 0,
        removedTracks: event.payload.removedTracks ?? 0,
      });
    });
    const unlisten3 = listen<{ collectionId: number; error: string }>("sync-error", (event) => {
      syncStarted = false;
      setSyncing(false);
      addLog("Sync error: " + event.payload.error, "sync");
      console.error("Sync error:", event.payload.error);
      onResyncDone?.();
      setResyncProgress(null);
      setResyncComplete({
        collectionId: event.payload.collectionId,
        collectionName: resyncingCollectionName ?? "Collection",
        newTracks: 0,
        removedTracks: 0,
        error: event.payload.error,
      });
      // Error persists on the inline card until next resync attempt — no auto-clear.
      // Caption bar fades after 5s via CSS animation, but resyncComplete state stays.
      loadLibrary();
      loadTracks();
    });

    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
      unlisten3.then((f) => f());
    };
  }, [loadLibrary, loadTracks, resyncingCollectionName]);

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

  // Library change events — bridged to plugin event system
  useEffect(() => {
    const unlisten1 = listen<{ trackId: number; path: string; title: string; artistName: string | null; albumTitle: string | null; collectionId: number }>(
      "track-added",
      (event) => {
        opts.dispatchPluginEvent?.("track:added" as any, event.payload);
      }
    );
    const unlisten2 = listen<{ trackId: number; path: string }>(
      "track-removed",
      (event) => {
        opts.dispatchPluginEvent?.("track:removed" as any, event.payload);
      }
    );

    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
    };
  }, []);
}
