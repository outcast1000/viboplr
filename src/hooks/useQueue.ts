import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save, open } from "@tauri-apps/plugin-dialog";
import type { QueueTrack, PlaylistLoadResult, PlaylistEntry, QueueMode } from "../types";
import { trackToQueueEntry, queueEntryToQueueTrack, nextExternalKey } from "../queueEntry";
import { buildManifest, buildState, diffThumbs, type ThumbInfo } from "../mainPlaylist";
import { stripImageVersion } from "../utils/resolveImageUrl";
import { nextIndex, prevIndex, randomizeOrder } from "../queueNav";

export interface PlaylistContext {
  name: string;
  imagePath?: string | null;
  source?: string | null;
  description?: string | null;
  metadata?: Record<string, string> | null;
  remote?: boolean;
}

export function useQueue(
  restoredRef: React.RefObject<boolean>,
  handlePlay: (track: QueueTrack, source?: "user" | "auto") => void,
) {
  const [queue, setQueue] = useState<QueueTrack[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [queueMode, setQueueMode] = useState<QueueMode>("normal");
  const [playlistContext, setPlaylistContext] = useState<PlaylistContext | null>(null);
  const [thumbInfo, setThumbInfo] = useState<Record<string, ThumbInfo>>({});

  useEffect(() => {
    const unlisten = listen<{ key: string; filename: string }>("main-playlist-thumb-ready", (event) => {
      const key = event.payload?.key;
      const filename = event.payload?.filename;
      if (!key || !filename) return;
      // Bump version to bust the WebView cache; record the backend-supplied
      // filename (the frontend never computes it — Rust's canonical_slug is the
      // single source of truth, so there's no JS slug mirror to drift).
      setThumbInfo(prev => ({ ...prev, [key]: { version: (prev[key]?.version ?? 0) + 1, filename } }));
    });
    return () => { unlisten.then(fn => fn()).catch(console.error); };
  }, []);

  const queueRef = useRef(queue);
  queueRef.current = queue;
  const queueIndexRef = useRef(queueIndex);
  queueIndexRef.current = queueIndex;
  const queueModeRef = useRef(queueMode);
  queueModeRef.current = queueMode;
  const queuePanelRef = useRef<HTMLDivElement>(null);
  const dragIndexRef = useRef<number | null>(null);

  // Persist state to main-playlist folder
  useEffect(() => {
    if (!restoredRef.current) return;
    const t = setTimeout(() => {
      invoke("main_playlist_write", {
        manifest: buildManifest(queue, playlistContext),
        stateData: buildState(queueIndex, queueMode),
      }).catch(e => console.error("Failed to write main-playlist:", e));
    }, 500);
    return () => clearTimeout(t);
  }, [queue, playlistContext, queueIndex, queueMode]);

  // Cover: sync imagePath to main-playlist/cover.jpg
  const lastCoverRef = useRef<string | null>(null);
  useEffect(() => {
    if (!restoredRef.current) return;
    const img = playlistContext?.imagePath ?? null;
    if (img === lastCoverRef.current) return;
    lastCoverRef.current = img;
    if (!img) {
      invoke("main_playlist_set_cover", { source: null })
        .catch(e => console.error("main_playlist_set_cover (clear) failed:", e));
      return;
    }
    const isUrl = img.startsWith("http://") || img.startsWith("https://");
    // Plugins may append `#v=N` to local paths (cache-busting); the backend
    // treats the whole string as a filesystem path so we must strip it before
    // sending. http(s) URLs pass through unchanged.
    const cleanPath = isUrl ? null : stripImageVersion(img);
    const source = isUrl ? { url: img, path: null } : { path: cleanPath, url: null };
    invoke("main_playlist_set_cover", { source })
      .catch(e => console.error(`main_playlist_set_cover failed for ${img}:`, e));
  }, [playlistContext]);

  // Thumb diff: write/remove thumbs when the queue changes.
  //
  // No remote gate: a thumb is written for any added track that carries an
  // `image_url` (i.e. art the entity-image cache can't serve — plugin/remote
  // tracks). Library tracks have no `image_url` on the QueueTrack, so the
  // `source` check below skips them; their art resolves via the entity cache.
  const prevQueueRef = useRef<QueueTrack[]>([]);
  useEffect(() => {
    if (!restoredRef.current) { prevQueueRef.current = queue; return; }
    const { added, removed } = diffThumbs(prevQueueRef.current, queue);
    prevQueueRef.current = queue;

    // Backend slugifies the `key` param via canonical_slug → same filename it wrote.
    for (const uri of removed) {
      invoke("main_playlist_remove_thumb", { key: uri })
        .catch(e => console.error(`main_playlist_remove_thumb failed for ${uri}:`, e));
    }
    if (removed.length > 0) {
      setThumbInfo(prev => {
        const next = { ...prev };
        for (const uri of removed) delete next[uri];
        return next;
      });
    }
    for (const t of added) {
      if (!t.path) continue;
      // Strip plugin-appended `#v=N` cache-buster from local paths before
      // sending to the backend (it treats the string as a filesystem path).
      const raw = t.image_url;
      const source =
        raw?.startsWith("http") ? { url: raw, path: null } :
        raw?.startsWith("file://") ? { path: stripImageVersion(raw.slice(7)), url: null } :
        raw ? { path: stripImageVersion(raw), url: null } :
        null;
      if (!source) continue;
      invoke("main_playlist_set_thumb", { key: t.path, source })
        .catch(e => console.error(`main_playlist_set_thumb failed for "${t.title}" (${t.path}, image_url=${raw}):`, e));
    }
  }, [queue, playlistContext]);

  // Auto-scroll queue panel to current track
  useEffect(() => {
    if (queueIndex >= 0) {
      requestAnimationFrame(() => {
        const list = queuePanelRef.current?.querySelector(".queue-list");
        const item = list?.querySelector(`[data-queue-index="${queueIndex}"]`) as HTMLElement | undefined;
        item?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
  }, [queueIndex]);

  function playTracks(tracks: QueueTrack[], startIndex: number, context?: PlaylistContext | null) {
    // Dedupe keys *within* the incoming batch so two copies of the same library
    // track don't collide as React keys (e.g. a playlist that contains a track
    // twice, or a plugin that re-emits the same item). Without this, React's
    // reconciliation produces stale DOM that looks like a "stuck" first item.
    const seen = new Set<string>();
    const dedupedTracks = tracks.map(t => {
      if (!seen.has(t.key)) { seen.add(t.key); return t; }
      const fresh = nextExternalKey();
      seen.add(fresh);
      return { ...t, key: fresh };
    });
    setQueue(dedupedTracks);
    setQueueIndex(startIndex);
    handlePlay(dedupedTracks[startIndex]);
    setPlaylistContext(context ?? null);
  }

  function findDuplicates(newTracks: QueueTrack[]): { duplicates: QueueTrack[]; unique: QueueTrack[] } {
    const existing = new Set(queueRef.current.map(t => t.path));
    const duplicates = newTracks.filter(t => existing.has(t.path));
    const unique = newTracks.filter(t => !existing.has(t.path));
    return { duplicates, unique };
  }

  // Ensure every incoming track has a key not already used by the existing
  // queue or by an earlier sibling in the same batch. Adding a library track
  // that's already enqueued (or two copies of the same track in one batch)
  // would otherwise produce React key collisions, which break reconciliation
  // and leave stale DOM nodes — visible as "phantom" first items that can't
  // be dragged. Reuse the original key when free; mint a fresh `ext:N` when
  // it collides.
  function withUniqueKeys(newTracks: QueueTrack[]): QueueTrack[] {
    const used = new Set(queueRef.current.map(t => t.key));
    return newTracks.map(t => {
      if (!used.has(t.key)) {
        used.add(t.key);
        return t;
      }
      const fresh = nextExternalKey();
      used.add(fresh);
      return { ...t, key: fresh };
    });
  }

  function enqueueTracks(newTracks: QueueTrack[]) {
    const tracks = withUniqueKeys(newTracks);
    setQueue(prev => [...prev, ...tracks]);
  }

  function playNext(source: "user" | "auto" = "user"): boolean {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const mode = queueModeRef.current;
    const next = nextIndex(mode, idx, q.length);
    if (next === null) return false;
    setQueueIndex(next);
    handlePlay(q[next], source);
    return true;
  }

  function playPrevious() {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const mode = queueModeRef.current;
    const prev = prevIndex(mode, idx, q.length);
    if (prev === null) return;
    setQueueIndex(prev);
    handlePlay(q[prev]);
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
    setPlaylistContext(null);
    invoke("main_playlist_clear").catch(console.error);
  }

  function toggleQueueMode() {
    setQueueMode(prev =>
      prev === "normal" ? "repeat-all" : prev === "repeat-all" ? "repeat-one" : "normal"
    );
  }

  function randomizeQueue() {
    const q = queueRef.current;
    if (q.length < 2) return;
    const idx = queueIndexRef.current;
    const order = randomizeOrder(q.length, idx, Math.random);
    const reordered = order.map(i => q[i]);
    setQueue(reordered);
    // The current track is order[0] by construction (when idx >= 0), so it now
    // sits at index 0. Playback is NOT re-triggered — the same audio keeps
    // playing; we only renumber the queue around it.
    setQueueIndex(idx >= 0 ? 0 : -1);
  }

  function peekNext(): QueueTrack | null {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const mode = queueModeRef.current;
    const next = nextIndex(mode, idx, q.length);
    return next === null ? null : (q[next] ?? null);
  }

  function advanceIndex(): boolean {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const mode = queueModeRef.current;
    const next = nextIndex(mode, idx, q.length);
    if (next === null) return false;
    setQueueIndex(next);
    return true;
  }

  function insertAtPosition(newTracks: QueueTrack[], position: number) {
    const tracks = withUniqueKeys(newTracks);
    setQueue(prev => {
      const next = [...prev];
      next.splice(position, 0, ...tracks);
      return next;
    });
    setQueueIndex(prev => position <= prev ? prev + tracks.length : prev);
  }

  function playNextInQueue(track: QueueTrack) {
    const [unique] = withUniqueKeys([track]);
    const idx = queueIndexRef.current;
    setQueue(prev => {
      const next = [...prev];
      next.splice(idx + 1, 0, unique);
      return next;
    });
  }

  function addToQueue(track: QueueTrack) {
    const [unique] = withUniqueKeys([track]);
    setQueue(prev => [...prev, unique]);
  }

  function addToQueueAndPlay(track: QueueTrack, source: "user" | "auto" = "user") {
    const [unique] = withUniqueKeys([track]);
    const newIndex = queueRef.current.length;
    setQueue(prev => [...prev, unique]);
    setQueueIndex(newIndex);
    handlePlay(unique, source);
  }

  async function savePlaylist() {
    if (queueRef.current.length === 0) return;
    const filePath = await save({
      filters: [{ name: "M3U Playlist", extensions: ["m3u"] }],
    });
    if (!filePath) return;
    const entries = queueRef.current.map(t => trackToQueueEntry(t));
    await invoke("save_playlist_entries", { path: filePath, entries });
    const name = filePath.split(/[/\\]/).pop()?.replace(/\.m3u8?$/i, "") ?? "Playlist";
    setPlaylistContext(prev => prev ? { ...prev, name } : { name });
  }

  async function loadPlaylist(onOpenMixtape?: (path: string) => void) {
    const filePath = await open({
      filters: [{ name: "Playlist", extensions: ["m3u", "m3u8", "mixtape"] }],
      multiple: false,
    });
    if (!filePath) return;
    if (typeof filePath === "string" && filePath.endsWith(".mixtape")) {
      onOpenMixtape?.(filePath);
      return;
    }
    const result = await invoke<PlaylistLoadResult>("load_playlist", { path: filePath });
    if (result.entries.length > 0) {
      const tracks = result.entries.map((e: PlaylistEntry) =>
        queueEntryToQueueTrack({
          url: e.url,
          title: e.title,
          artist_name: e.artist_name,
          album_title: null,
          duration_secs: e.duration_secs,
          track_number: null,
          year: null,
          format: null,
        })
      );
      setQueue(tracks);
      setQueueIndex(0);
      handlePlay(tracks[0]);
      setPlaylistContext({ name: result.playlist_name });
    }
  }

  return {
    queue, setQueue,
    queueIndex, setQueueIndex,
    queueMode, setQueueMode,
    queuePanelRef, dragIndexRef,
    playTracks, enqueueTracks, findDuplicates,
    playNext, playPrevious,
    removeFromQueue, removeMultiple, moveInQueue, moveMultiple, moveToTop, moveToBottom, clearQueue, insertAtPosition,
    toggleQueueMode, randomizeQueue, playNextInQueue, addToQueue, addToQueueAndPlay,
    peekNext, advanceIndex,
    playlistContext, setPlaylistContext, savePlaylist, loadPlaylist,
    thumbInfo,
  };
}
