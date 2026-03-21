import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import type { Track, PlaylistLoadResult } from "../types";
import { store } from "../store";

export function useQueue(
  restoredRef: React.RefObject<boolean>,
  handlePlay: (track: Track) => void,
) {
  const [queue, setQueue] = useState<Track[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [queueMode, setQueueMode] = useState<"normal" | "loop" | "shuffle">("normal");
  const [shuffleOrder, setShuffleOrder] = useState<number[]>([]);
  const [shufflePosition, setShufflePosition] = useState(0);
  const [showQueue, setShowQueue] = useState(false);
  const [playlistName, setPlaylistName] = useState<string | null>(null);

  const queueRef = useRef(queue);
  queueRef.current = queue;
  const queueIndexRef = useRef(queueIndex);
  queueIndexRef.current = queueIndex;
  const queueModeRef = useRef(queueMode);
  queueModeRef.current = queueMode;
  const shuffleOrderRef = useRef(shuffleOrder);
  shuffleOrderRef.current = shuffleOrder;
  const shufflePositionRef = useRef(shufflePosition);
  shufflePositionRef.current = shufflePosition;
  const queuePanelRef = useRef<HTMLDivElement>(null);
  const dragIndexRef = useRef<number | null>(null);

  // Persist state
  useEffect(() => { if (restoredRef.current) store.set("queueTrackIds", queue.map(t => t.id)); }, [queue]);
  useEffect(() => { if (restoredRef.current) store.set("queueIndex", queueIndex); }, [queueIndex]);
  useEffect(() => { if (restoredRef.current) store.set("queueMode", queueMode); }, [queueMode]);

  // Auto-scroll queue panel to current track
  useEffect(() => {
    if (showQueue && queueIndex >= 0 && queuePanelRef.current) {
      const list = queuePanelRef.current.querySelector(".queue-list");
      const item = list?.children[queueIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [queueIndex, showQueue]);

  function generateShuffleOrder(length: number, startIndex: number): number[] {
    const indices = Array.from({ length }, (_, i) => i).filter(i => i !== startIndex);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return [startIndex, ...indices];
  }

  function playTracks(tracks: Track[], startIndex: number) {
    setQueue(tracks);
    setQueueIndex(startIndex);
    handlePlay(tracks[startIndex]);
    if (queueModeRef.current === "shuffle") {
      const order = generateShuffleOrder(tracks.length, startIndex);
      setShuffleOrder(order);
      setShufflePosition(0);
    }
  }

  function enqueueTracks(newTracks: Track[]) {
    setQueue(prev => {
      const existing = new Set(prev.map(t => t.id));
      const toAdd = newTracks.filter(t => !existing.has(t.id));
      if (toAdd.length === 0) return prev;
      return [...prev, ...toAdd];
    });
  }

  function playNext(): boolean {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const mode = queueModeRef.current;

    if (q.length === 0) return false;

    if (mode === "shuffle") {
      const pos = shufflePositionRef.current;
      const order = shuffleOrderRef.current;
      if (order.length === 0) return false;
      const nextPos = pos + 1;
      if (nextPos >= order.length) {
        const newOrder = generateShuffleOrder(q.length, order[0]);
        setShuffleOrder(newOrder);
        setShufflePosition(0);
        const nextIdx = newOrder[0];
        setQueueIndex(nextIdx);
        handlePlay(q[nextIdx]);
      } else {
        setShufflePosition(nextPos);
        const nextIdx = order[nextPos];
        setQueueIndex(nextIdx);
        handlePlay(q[nextIdx]);
      }
      return true;
    }

    if (mode === "loop") {
      const nextIdx = (idx + 1) % q.length;
      setQueueIndex(nextIdx);
      handlePlay(q[nextIdx]);
      return true;
    }

    // normal
    if (idx + 1 < q.length) {
      const nextIdx = idx + 1;
      setQueueIndex(nextIdx);
      handlePlay(q[nextIdx]);
      return true;
    }
    return false;
  }

  function playPrevious() {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const mode = queueModeRef.current;

    if (q.length === 0) return;

    if (mode === "shuffle") {
      const pos = shufflePositionRef.current;
      const order = shuffleOrderRef.current;
      if (pos > 0) {
        const prevPos = pos - 1;
        setShufflePosition(prevPos);
        const prevIdx = order[prevPos];
        setQueueIndex(prevIdx);
        handlePlay(q[prevIdx]);
      }
      return;
    }

    if (mode === "loop") {
      const prevIdx = (idx - 1 + q.length) % q.length;
      setQueueIndex(prevIdx);
      handlePlay(q[prevIdx]);
      return;
    }

    if (idx > 0) {
      const prevIdx = idx - 1;
      setQueueIndex(prevIdx);
      handlePlay(q[prevIdx]);
    }
  }

  function removeFromQueue(index: number) {
    setQueue(prev => {
      const next = [...prev];
      next.splice(index, 1);
      return next;
    });
    setQueueIndex(prev => {
      if (index < prev) return prev - 1;
      if (index === prev) return Math.min(prev, queue.length - 2);
      return prev;
    });
  }

  function removeMultiple(indices: number[]) {
    const toRemove = new Set(indices);
    setQueue(prev => prev.filter((_, i) => !toRemove.has(i)));
    setQueueIndex(prev => {
      if (toRemove.has(prev)) return Math.max(0, prev - [...toRemove].filter(i => i < prev).length);
      return prev - [...toRemove].filter(i => i < prev).length;
    });
  }

  function moveToTop(indices: number[]) {
    const sorted = [...indices].sort((a, b) => a - b);
    setQueue(prev => {
      const moving = sorted.map(i => prev[i]);
      const remaining = prev.filter((_, i) => !new Set(sorted).has(i));
      return [...moving, ...remaining];
    });
    setQueueIndex(prev => {
      const indexSet = new Set(sorted);
      if (indexSet.has(prev)) return sorted.indexOf(prev);
      const shiftedBefore = sorted.filter(i => i < prev).length;
      return prev - shiftedBefore + sorted.length;
    });
  }

  function moveToBottom(indices: number[]) {
    const sorted = [...indices].sort((a, b) => a - b);
    setQueue(prev => {
      const moving = sorted.map(i => prev[i]);
      const remaining = prev.filter((_, i) => !new Set(sorted).has(i));
      return [...remaining, ...moving];
    });
    setQueueIndex(prev => {
      const indexSet = new Set(sorted);
      if (indexSet.has(prev)) {
        const remaining = queue.length - sorted.length;
        return remaining + sorted.indexOf(prev);
      }
      return prev - sorted.filter(i => i < prev).length;
    });
  }

  function moveMultiple(indices: number[], targetIndex: number) {
    const sorted = [...indices].sort((a, b) => a - b);
    const indexSet = new Set(sorted);
    setQueue(prev => {
      const moving = sorted.map(i => prev[i]);
      const remaining = prev.filter((_, i) => !indexSet.has(i));
      // Calculate insertion point in the remaining array
      let insertAt = targetIndex;
      for (const idx of sorted) {
        if (idx < targetIndex) insertAt--;
      }
      insertAt = Math.max(0, Math.min(insertAt, remaining.length));
      remaining.splice(insertAt, 0, ...moving);
      return remaining;
    });
    setQueueIndex(prev => {
      if (indexSet.has(prev)) {
        // Current track is being moved — find its new position
        const posInMoving = sorted.indexOf(prev);
        let insertAt = targetIndex;
        for (const idx of sorted) {
          if (idx < targetIndex) insertAt--;
        }
        insertAt = Math.max(0, Math.min(insertAt, queue.length - sorted.length));
        return insertAt + posInMoving;
      }
      // Current track is not being moved — count how many moved items were before/after
      const beforeOld = sorted.filter(i => i < prev).length;
      const newPosWithoutMoving = prev - beforeOld;
      let insertAt = targetIndex;
      for (const idx of sorted) {
        if (idx < targetIndex) insertAt--;
      }
      insertAt = Math.max(0, Math.min(insertAt, queue.length - sorted.length));
      if (newPosWithoutMoving < insertAt) return newPosWithoutMoving;
      return newPosWithoutMoving + sorted.length;
    });
  }

  function moveInQueue(from: number, to: number) {
    setQueue(prev => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    setQueueIndex(prev => {
      if (prev === from) return to;
      if (from < prev && to >= prev) return prev - 1;
      if (from > prev && to <= prev) return prev + 1;
      return prev;
    });
  }

  function clearQueue() {
    setQueue([]);
    setQueueIndex(-1);
    setShuffleOrder([]);
    setShufflePosition(0);
    setPlaylistName(null);
  }

  function toggleQueueMode() {
    setQueueMode(prev => {
      const next = prev === "normal" ? "loop" : prev === "loop" ? "shuffle" : "normal";
      if (next === "shuffle" && queueRef.current.length > 0) {
        const order = generateShuffleOrder(queueRef.current.length, queueIndexRef.current);
        setShuffleOrder(order);
        setShufflePosition(0);
      }
      return next;
    });
  }

  function peekNext(): Track | null {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const mode = queueModeRef.current;

    if (q.length === 0) return null;

    if (mode === "shuffle") {
      const pos = shufflePositionRef.current;
      const order = shuffleOrderRef.current;
      if (order.length === 0) return null;
      const nextPos = pos + 1;
      if (nextPos >= order.length) return null; // can't predict new shuffle order
      return q[order[nextPos]] ?? null;
    }

    if (mode === "loop") {
      return q[(idx + 1) % q.length] ?? null;
    }

    // normal
    if (idx + 1 < q.length) return q[idx + 1];
    return null;
  }

  function advanceIndex(): boolean {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const mode = queueModeRef.current;

    if (q.length === 0) return false;

    if (mode === "shuffle") {
      const pos = shufflePositionRef.current;
      const order = shuffleOrderRef.current;
      if (order.length === 0) return false;
      const nextPos = pos + 1;
      if (nextPos >= order.length) {
        const newOrder = generateShuffleOrder(q.length, order[0]);
        setShuffleOrder(newOrder);
        setShufflePosition(0);
        setQueueIndex(newOrder[0]);
      } else {
        setShufflePosition(nextPos);
        setQueueIndex(order[nextPos]);
      }
      return true;
    }

    if (mode === "loop") {
      setQueueIndex((idx + 1) % q.length);
      return true;
    }

    if (idx + 1 < q.length) {
      setQueueIndex(idx + 1);
      return true;
    }
    return false;
  }

  function playNextInQueue(track: Track) {
    const idx = queueIndexRef.current;
    setQueue(prev => {
      const next = [...prev];
      next.splice(idx + 1, 0, track);
      return next;
    });
  }

  function addToQueue(track: Track) {
    setQueue(prev => [...prev, track]);
  }

  function addToQueueAndPlay(track: Track) {
    const newIndex = queueRef.current.length;
    setQueue(prev => [...prev, track]);
    setQueueIndex(newIndex);
    handlePlay(track);
  }

  async function savePlaylist() {
    if (queueRef.current.length === 0) return;
    const filePath = await save({
      filters: [{ name: "M3U Playlist", extensions: ["m3u"] }],
    });
    if (!filePath) return;
    const trackIds = queueRef.current.map(t => t.id);
    await invoke("save_playlist", { path: filePath, trackIds });
    const name = filePath.split(/[/\\]/).pop()?.replace(/\.m3u8?$/i, "") ?? "Playlist";
    setPlaylistName(name);
  }

  async function loadPlaylist() {
    const filePath = await open({
      filters: [{ name: "M3U Playlist", extensions: ["m3u", "m3u8"] }],
      multiple: false,
    });
    if (!filePath) return;
    const result = await invoke<PlaylistLoadResult>("load_playlist", { path: filePath });
    if (result.tracks.length > 0) {
      setQueue(result.tracks);
      setQueueIndex(0);
      handlePlay(result.tracks[0]);
      setPlaylistName(result.playlist_name);
    }
  }

  return {
    queue, setQueue,
    queueIndex, setQueueIndex,
    queueMode, setQueueMode,
    shuffleOrder, setShuffleOrder,
    shufflePosition, setShufflePosition,
    showQueue, setShowQueue,
    queuePanelRef, dragIndexRef,
    playTracks, enqueueTracks,
    playNext, playPrevious,
    removeFromQueue, removeMultiple, moveInQueue, moveMultiple, moveToTop, moveToBottom, clearQueue,
    toggleQueueMode, playNextInQueue, addToQueue, addToQueueAndPlay,
    peekNext, advanceIndex,
    playlistName, savePlaylist, loadPlaylist,
  };
}
