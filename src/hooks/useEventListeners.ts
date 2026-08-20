import { useEffect } from "react";
import { subscribe, combineUnlisten } from "../utils/tauriEvents";
import { track as trackTelemetry, bucketCount } from "../telemetry";

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
  onResyncDone?: () => void;
  resyncingCollectionName: string | null;
  setResyncProgress: (v: ResyncProgress | null) => void;
  setResyncComplete: (v: ResyncComplete | null) => void;
  onBulkEditComplete?: () => void;
  // Fired when a scan/sync changes the library's track population. SearchView keeps
  // its own results state (independent of the `library` hook), so loadLibrary alone
  // does not refresh it — this nudges it to re-run its current query.
  onLibraryChanged?: () => void;
  dispatchPluginEvent?: (event: string, ...args: unknown[]) => void;
}

export type { ResyncProgress, ResyncComplete };

export function useEventListeners(opts: EventListenerOptions) {
  const {
    loadLibrary, loadTracks,
    onResyncDone,
    resyncingCollectionName,
    setResyncProgress,
    setResyncComplete,
    onBulkEditComplete,
    onLibraryChanged,
  } = opts;

  // Scan events
  useEffect(() => {
    // Coalesce progress renders to ~4 Hz. The backend emits every 10 files and
    // a re-scan of unchanged files processes hundreds of files/sec; each event
    // lands in React state on the App root, so unthrottled it re-renders the
    // whole tree tens of times per second for the scan's duration. Dropping
    // intermediate events is safe — scan-complete resets the state afterwards.
    let lastProgressRender = 0;
    const stopProgress = subscribe<{ folder: string; scanned: number; total: number; collection_id?: number }>(
      "scan-progress",
      (event) => {
        if (event.payload.collection_id == null) return;
        const now = Date.now();
        if (now - lastProgressRender < 250) return;
        lastProgressRender = now;
        setResyncComplete(null);
        setResyncProgress({
          collectionId: event.payload.collection_id,
          collectionName: resyncingCollectionName ?? event.payload.folder,
          kind: "scan",
          scanned: event.payload.scanned,
          total: event.payload.total,
        });
      }
    );
    const stopComplete = subscribe<{ folder?: string; collectionId?: number; newTracks?: number; removedTracks?: number }>("scan-complete", (event) => {
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
      trackTelemetry("scan_completed", {
        added_bucket: bucketCount(event.payload.newTracks ?? 0),
        removed_bucket: bucketCount(event.payload.removedTracks ?? 0),
      });
      loadLibrary();
      loadTracks();
      onLibraryChanged?.();
      opts.dispatchPluginEvent?.("scan:complete" as any, {
        collectionId: event.payload.collectionId,
        newTracks: event.payload.newTracks ?? 0,
        removedTracks: event.payload.removedTracks ?? 0,
      });
    });

    return combineUnlisten(stopProgress, stopComplete);
  }, [loadLibrary, loadTracks, resyncingCollectionName]);

  // Sync events
  useEffect(() => {
    // Same ~4 Hz coalescing as scan-progress above.
    let lastProgressRender = 0;
    const stopProgress = subscribe<{ collection: string; synced: number; total: number; collection_id?: number }>(
      "sync-progress",
      (event) => {
        if (event.payload.collection_id == null) return;
        const now = Date.now();
        if (now - lastProgressRender < 250) return;
        lastProgressRender = now;
        setResyncComplete(null);
        setResyncProgress({
          collectionId: event.payload.collection_id,
          collectionName: resyncingCollectionName ?? event.payload.collection,
          kind: "sync",
          scanned: event.payload.synced,
          total: event.payload.total,
        });
      }
    );
    const stopComplete = subscribe<{ collectionId: number; newTracks?: number; removedTracks?: number }>("sync-complete", (event) => {
      onResyncDone?.();
      setResyncProgress(null);
      setResyncComplete({
        collectionId: event.payload.collectionId,
        collectionName: resyncingCollectionName ?? "Collection",
        newTracks: event.payload.newTracks ?? 0,
        removedTracks: event.payload.removedTracks ?? 0,
      });
      setTimeout(() => setResyncComplete(null), 3000);
      trackTelemetry("scan_completed", {
        added_bucket: bucketCount(event.payload.newTracks ?? 0),
        removed_bucket: bucketCount(event.payload.removedTracks ?? 0),
      });
      loadLibrary();
      loadTracks();
      onLibraryChanged?.();
      opts.dispatchPluginEvent?.("scan:complete" as any, {
        collectionId: event.payload.collectionId,
        newTracks: event.payload.newTracks ?? 0,
        removedTracks: event.payload.removedTracks ?? 0,
      });
    });
    const stopError = subscribe<{ collectionId: number; error: string }>("sync-error", (event) => {
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
      onLibraryChanged?.();
    });

    return combineUnlisten(stopProgress, stopComplete, stopError);
  }, [loadLibrary, loadTracks, resyncingCollectionName]);

  // Bulk edit events
  useEffect(() => {
    return subscribe("bulk-edit-complete", () => {
      loadLibrary();
      loadTracks();
      onBulkEditComplete?.();
    });
    // onBulkEditComplete called via closure (stable functional setter) — kept out
    // of deps to match the other optional callbacks and avoid re-subscribing.
  }, [loadLibrary, loadTracks]);

  // Library change events — bridged to plugin event system
  useEffect(() => {
    const stopAdded = subscribe<{ trackId: number; path: string; title: string; artistName: string | null; albumTitle: string | null; collectionId: number }>(
      "track-added",
      (event) => {
        opts.dispatchPluginEvent?.("track:added" as any, event.payload);
      }
    );
    const stopRemoved = subscribe<{ trackId: number; path: string }>(
      "track-removed",
      (event) => {
        opts.dispatchPluginEvent?.("track:removed" as any, event.payload);
      }
    );

    return combineUnlisten(stopAdded, stopRemoved);
  }, []);
}
