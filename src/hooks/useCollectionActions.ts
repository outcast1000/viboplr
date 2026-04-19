import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Collection, Track } from "../types";

export function useCollectionActions(deps: {
  library: { loadLibrary: () => Promise<void>; loadTracks: () => Promise<void> };
  playback: { currentTrack: Track | null; handleStop: () => void };
  queueHook: { setQueue: React.Dispatch<React.SetStateAction<Track[]>> };
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
      await invoke("remove_collection", { collectionId: removeCollectionConfirm.id });
      if (deps.playback.currentTrack && deps.playback.currentTrack.collection_id === removeCollectionConfirm.id) {
        deps.playback.handleStop();
      }
      deps.queueHook.setQueue(prev => prev.filter(t => t.collection_id !== removeCollectionConfirm.id));
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
