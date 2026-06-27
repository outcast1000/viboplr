import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Collection, QueueTrack } from "../types";

export function useCollectionActions(deps: {
  library: { loadLibrary: () => Promise<void>; loadTracks: () => Promise<void> };
  playback: { currentTrack: QueueTrack | null; handleStop: () => void };
  queueHook: { queue: QueueTrack[]; removeMultiple: (indices: number[]) => void };
  collections: Collection[];
}) {
  const [checkingConnectionId, setCheckingConnectionId] = useState<number | null>(null);
  const [connectionResult, setConnectionResult] = useState<{ collectionId: number; ok: boolean; message: string } | null>(null);
  const [editingCollection, setEditingCollection] = useState<Collection | null>(null);
  const [removeCollectionConfirm, setRemoveCollectionConfirm] = useState<Collection | null>(null);
  const [resyncingCollection, setResyncingCollection] = useState<{ id: number; name: string } | null>(null);

  async function handleResyncCollection(collectionId: number) {
    const col = deps.collections.find(c => c.id === collectionId);
    setResyncingCollection({ id: collectionId, name: col?.name ?? "Collection" });
    try {
      await invoke("resync_collection", { collectionId });
    } catch (e) {
      console.error("Failed to resync collection:", e);
      setResyncingCollection(null);
    }
  }

  function clearResyncingState() {
    setResyncingCollection(null);
  }

  async function handleToggleCollectionEnabled(collection: Collection) {
    await invoke("update_collection", {
      collectionId: collection.id,
      name: collection.name,
      autoUpdate: collection.auto_update,
      autoUpdateIntervalMins: collection.auto_update_interval_mins,
      enabled: !collection.enabled,
    });
    deps.library.loadLibrary();
    deps.library.loadTracks();
  }

  async function handleCheckConnection(collectionId: number) {
    setCheckingConnectionId(collectionId);
    setConnectionResult(null);
    try {
      const msg = await invoke<string>("test_collection_connection", { collectionId });
      setConnectionResult({ collectionId, ok: true, message: msg });
    } catch (e) {
      setConnectionResult({ collectionId, ok: false, message: String(e) });
    } finally {
      setCheckingConnectionId(null);
      deps.library.loadLibrary();
      setTimeout(() => setConnectionResult(null), 5000);
    }
  }

  async function handleSaveCollection(id: number, name: string, autoUpdate: boolean, autoUpdateIntervalMins: number, enabled: boolean) {
    await invoke("update_collection", {
      collectionId: id,
      name,
      autoUpdate,
      autoUpdateIntervalMins,
      enabled,
    });
    setEditingCollection(null);
    deps.library.loadLibrary();
    deps.library.loadTracks();
  }

  async function handleRemoveCollectionConfirm() {
    if (!removeCollectionConfirm) return;
    try {
      const col = removeCollectionConfirm;
      const pathPrefix = col.kind === "local" && col.path
        ? `file://${col.path}`
        : col.kind === "subsonic" && col.url
        ? `subsonic://${col.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}/`
        : null;
      await invoke("remove_collection", { collectionId: col.id });
      if (pathPrefix && deps.playback.currentTrack?.path?.startsWith(pathPrefix)) {
        deps.playback.handleStop();
      }
      if (pathPrefix) {
        // Route through removeMultiple (not a raw setQueue filter) so queueIndex
        // is recalculated and keeps pointing at the playing track — see
        // queue.md "Queue Mutation & Index Integrity".
        const indices = deps.queueHook.queue
          .map((t, i) => (t.path?.startsWith(pathPrefix) ? i : -1))
          .filter(i => i >= 0);
        if (indices.length > 0) deps.queueHook.removeMultiple(indices);
      }
      deps.library.loadLibrary();
      deps.library.loadTracks();
    } catch (e) {
      console.error("Failed to remove collection:", e);
    }
    setRemoveCollectionConfirm(null);
  }

  return {
    checkingConnectionId,
    connectionResult,
    editingCollection,
    setEditingCollection,
    removeCollectionConfirm,
    setRemoveCollectionConfirm,
    resyncingCollection,
    handleResyncCollection,
    clearResyncingState,
    handleToggleCollectionEnabled,
    handleCheckConnection,
    handleSaveCollection,
    handleRemoveCollectionConfirm,
  };
}
