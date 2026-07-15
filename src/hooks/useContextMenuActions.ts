import { useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Artist, Album, QueueTrack } from "../types";
import { watchOnYoutube } from "../utils/youtube";
import { parseLibraryId, isLocalTrack, isNetworkSharePath } from "../queueEntry";
import type { ContextMenuState, ContextMenuTarget } from "../types/contextMenu";
import type { PlaylistContext } from "./useQueue";
import { useQueueDragToInsert, type PendingEnqueue } from "./useQueueDragToInsert";
import { useDownloadActions } from "./useDownloadActions";
import { store } from "../store";
import { trashLabel } from "../utils";
import { emitTracksDeleted } from "../trackEvents";

interface UseContextMenuActionsDeps {
  library: {
    tracks: Track[];
    artists: Artist[];
    albums: Album[];
    setTracks: React.Dispatch<React.SetStateAction<Track[]>>;
    loadLibrary: () => Promise<void>;
    loadTracks: () => Promise<void>;
  };
  queueHook: {
    playTracks: (tracks: QueueTrack[], index: number, context?: PlaylistContext | null) => void;
    enqueueTracks: (tracks: QueueTrack[]) => void;
    findDuplicates: (tracks: QueueTrack[]) => { duplicates: QueueTrack[]; unique: QueueTrack[] };
    insertAtPosition: (tracks: QueueTrack[], pos: number) => void;
    removeMultiple: (indices: number[]) => void;
    moveToTop: (indices: number[]) => void;
    moveToBottom: (indices: number[]) => void;
    queue: QueueTrack[];
    addToQueue: (track: QueueTrack) => void;
  };
  playback: { currentTrack: QueueTrack | null; handleStop: () => void };
  /**
   * Called when the currently-playing track is among those deleted. Receives the
   * queue indices to remove and is responsible for both advancing playback
   * (next / auto-continue / previous / stop) and removing the entries from the
   * queue. When absent, the delete falls back to a plain stop + queue removal.
   */
  onCurrentTrackDeleted?: (queueIndices: number[]) => void;
  playActions: {
    playAlbum: (albumId: number) => void;
    playArtist: (artistId: number) => void;
    playTag: (tagId: number) => void;
    startRadio: (seed: { title: string; artistName: string | null; coverPath: string | null }) => void;
  };
  queueCollapsed: boolean;
  setQueueCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  onTracksDeleted?: (deletedIds: number[]) => void;
  onShowMenu?: (state: ContextMenuState) => void;
}

export function useContextMenuActions(deps: UseContextMenuActionsDeps) {
  const { library, queueHook, playback, playActions, queueCollapsed, setQueueCollapsed, onTracksDeleted, onCurrentTrackDeleted, onShowMenu } = deps;

  const [contextMenu, setContextMenuState] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<ContextMenuState | null>(null);
  const [bulkEditTracks, setBulkEditTracks] = useState<Track[] | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<{ trackIds: number[]; title: string; network?: boolean } | null>(null);
  const [deleteError, setDeleteError] = useState<{ message: string; failures: { title: string; reason: string }[] } | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [pendingEnqueue, setPendingEnqueue] = useState<PendingEnqueue | null>(null);

  // Drag-to-queue and download actions live in focused hooks; this hook composes
  // them and re-exports their surface so every context-menu consumer keeps
  // reaching them via `contextMenuActions.*`.
  const { externalDropTarget, handleTrackDragStart } = useQueueDragToInsert({
    queueHook, queueCollapsed, setQueueCollapsed, setPendingEnqueue,
  });
  const {
    downloadConfirm,
    handleDownloadTrack,
    handleDownloadConfirm,
    handleDownloadConfirmDismiss,
    handleDownloadMulti,
  } = useDownloadActions();

  function setContextMenu(state: ContextMenuState | null) {
    contextMenuRef.current = state;
    setContextMenuState(state);
  }

  function showMenu(state: ContextMenuState) {
    setContextMenu(state);
    onShowMenu?.(state);
  }

  function handleTrackContextMenu(e: React.MouseEvent, track: Track, selectedTrackKeys: Set<string>) {
    e.preventDefault();
    if (selectedTrackKeys.size > 1) {
      const trackIds = [...selectedTrackKeys].map(k => parseLibraryId(k)).filter((id): id is number => id != null);
      showMenu({ x: e.clientX, y: e.clientY, target: { kind: "multi-track", trackIds } });
    } else {
      showMenu({ x: e.clientX, y: e.clientY, target: { kind: "track", trackId: track.id ?? undefined, isLocal: isLocalTrack(track), title: track.title, artistName: track.artist_name } });
    }
  }

  function handleAlbumContextMenu(e: React.MouseEvent, albumId: number) {
    e.preventDefault();
    const album = library.albums.find(a => a.id === albumId);
    showMenu({ x: e.clientX, y: e.clientY, target: { kind: "album", albumId, title: album?.title ?? "", artistName: album?.artist_name ?? null } });
  }

  function handleArtistContextMenu(e: React.MouseEvent, artistId: number) {
    e.preventDefault();
    const artist = library.artists.find(a => a.id === artistId);
    showMenu({ x: e.clientX, y: e.clientY, target: { kind: "artist", artistId, name: artist?.name ?? "" } });
  }

  function handleTagContextMenu(e: React.MouseEvent, tag: { id: number; name: string }) {
    e.preventDefault();
    showMenu({ x: e.clientX, y: e.clientY, target: { kind: "tag", tagId: tag.id, name: tag.name } });
  }

  function handleMultiAlbumContextMenu(e: React.MouseEvent, albumIds: number[]) {
    e.preventDefault();
    showMenu({ x: e.clientX, y: e.clientY, target: { kind: "multi-album", albumIds } });
  }

  function handleMultiArtistContextMenu(e: React.MouseEvent, artistIds: number[]) {
    e.preventDefault();
    showMenu({ x: e.clientX, y: e.clientY, target: { kind: "multi-artist", artistIds } });
  }

  function handleMultiTagContextMenu(e: React.MouseEvent, tagIds: number[]) {
    e.preventDefault();
    showMenu({ x: e.clientX, y: e.clientY, target: { kind: "multi-tag", tagIds } });
  }

  async function handleContextPlay() {
    const cm = contextMenuRef.current;
    if (!cm) return;
    const { target } = cm;
    if (target.kind === "track" && target.trackId) {
      try {
        const track = await invoke<Track>("get_track_by_id", { trackId: target.trackId });
        queueHook.playTracks([track], 0);
      } catch (e) { console.error("Failed to play track:", e); }
    } else if (target.kind === "album" && target.albumId) {
      playActions.playAlbum(target.albumId);
    } else if (target.kind === "artist" && target.artistId) {
      playActions.playArtist(target.artistId);
    } else if (target.kind === "tag" && target.tagId) {
      playActions.playTag(target.tagId);
    } else if (target.kind === "multi-track") {
      try {
        const selected = await invoke<Track[]>("get_tracks_by_ids", { ids: target.trackIds });
        if (selected.length > 0) queueHook.playTracks(selected, 0);
      } catch (e) { console.error("Failed to play tracks:", e); }
    } else if (target.kind === "queue-multi") {
      const selected = target.indices.map(i => queueHook.queue[i]).filter(Boolean);
      if (selected.length > 0) queueHook.playTracks(selected, 0);
    } else if (target.kind === "multi-album") {
      const all = await fetchMultiEntityTracks(target);
      if (all.length > 0) queueHook.playTracks(all, 0);
    } else if (target.kind === "multi-artist") {
      const all = await fetchMultiEntityTracks(target);
      if (all.length > 0) queueHook.playTracks(all, 0);
    } else if (target.kind === "multi-tag") {
      const all = await fetchMultiEntityTracks(target);
      if (all.length > 0) queueHook.playTracks(all, 0);
    }
  }

  async function fetchMultiEntityTracks(target: { kind: "multi-album"; albumIds: number[] } | { kind: "multi-artist"; artistIds: number[] } | { kind: "multi-tag"; tagIds: number[] }): Promise<Track[]> {
    const results: Track[] = [];
    if (target.kind === "multi-album") {
      for (const id of target.albumIds) {
        const tracks = await invoke<Track[]>("get_tracks", { opts: { albumId: id } });
        results.push(...tracks);
      }
    } else if (target.kind === "multi-artist") {
      for (const id of target.artistIds) {
        const tracks = await invoke<Track[]>("get_tracks_by_artist", { artistId: id });
        results.push(...tracks);
      }
    } else if (target.kind === "multi-tag") {
      for (const id of target.tagIds) {
        const tracks = await invoke<Track[]>("get_tracks_by_tag", { tagId: id });
        results.push(...tracks);
      }
    }
    return results;
  }

  function handleEnqueue(tracks: Track[]) {
    if (tracks.length === 0) return;
    const { duplicates, unique } = queueHook.findDuplicates(tracks);
    if (duplicates.length > 0) {
      setPendingEnqueue({ all: tracks, duplicates, unique });
      if (queueCollapsed) { setQueueCollapsed(false); store.set("queueCollapsed", false); }
    } else {
      queueHook.enqueueTracks(tracks);
    }
  }

  async function handleContextEnqueue() {
    const cm = contextMenuRef.current;
    if (!cm) return;
    const { target } = cm;
    if (target.kind === "track" && target.trackId) {
      try {
        const track = await invoke<Track>("get_track_by_id", { trackId: target.trackId });
        handleEnqueue([track]);
      } catch (e) { console.error("Failed to enqueue track:", e); }
    } else if (target.kind === "album" && target.albumId) {
      const albumTracks = await invoke<Track[]>("get_tracks", { opts: { albumId: target.albumId } });
      handleEnqueue(albumTracks);
    } else if (target.kind === "artist" && target.artistId) {
      const artistTracks = await invoke<Track[]>("get_tracks_by_artist", { artistId: target.artistId });
      handleEnqueue(artistTracks);
    } else if (target.kind === "tag" && target.tagId) {
      const tagTracks = await invoke<Track[]>("get_tracks_by_tag", { tagId: target.tagId });
      handleEnqueue(tagTracks);
    } else if (target.kind === "multi-track") {
      try {
        const selected = await invoke<Track[]>("get_tracks_by_ids", { ids: target.trackIds });
        handleEnqueue(selected);
      } catch (e) { console.error("Failed to enqueue tracks:", e); }
    } else if (target.kind === "multi-album" || target.kind === "multi-artist" || target.kind === "multi-tag") {
      const all = await fetchMultiEntityTracks(target);
      handleEnqueue(all);
    }
  }

  // Remove queue entries. When the currently-playing track is among them,
  // route through `onCurrentTrackDeleted` so playback advances to the next
  // surviving track (it falls back to plain index-fixup removal when the
  // current track survives — same behavior as `removeMultiple`).
  function removeQueueIndices(indices: number[]) {
    if (onCurrentTrackDeleted) onCurrentTrackDeleted(indices);
    else queueHook.removeMultiple(indices);
  }

  function handleQueueRemove() {
    const cm = contextMenuRef.current;
    if (!cm || cm.target.kind !== "queue-multi") return;
    removeQueueIndices(cm.target.indices);
  }

  function handleQueueKeepOnly() {
    const cm = contextMenuRef.current;
    if (!cm || cm.target.kind !== "queue-multi") return;
    const keepSet = new Set(cm.target.indices);
    const toRemove = queueHook.queue.map((_, i) => i).filter(i => !keepSet.has(i));
    removeQueueIndices(toRemove);
  }

  function handleQueueMoveToTop() {
    const cm = contextMenuRef.current;
    if (!cm || cm.target.kind !== "queue-multi") return;
    queueHook.moveToTop(cm.target.indices);
  }

  function handleQueueMoveToBottom() {
    const cm = contextMenuRef.current;
    if (!cm || cm.target.kind !== "queue-multi") return;
    queueHook.moveToBottom(cm.target.indices);
  }

  async function handleShowInFolder() {
    const cm = contextMenuRef.current;
    if (cm && cm.target.kind === "track" && cm.target.trackId != null) {
      try {
        await invoke("show_in_folder", { trackId: cm.target.trackId });
      } catch (e) {
        console.error("Failed to open containing folder:", e);
        setFolderError(String(e));
      }
      setContextMenu(null);
    } else if (cm && cm.target.kind === "queue-multi" && cm.target.indices.length === 1) {
      const track = queueHook.queue[cm.target.indices[0]];
      try {
        const libId = track ? parseLibraryId(track.key) : null;
        if (track && libId != null) {
          await invoke("show_in_folder", { trackId: libId });
        } else if (track && track.path) {
          await invoke("show_in_folder_path", { filePath: track.path });
        }
      } catch (e) {
        console.error("Failed to open containing folder:", e);
        setFolderError(String(e));
      }
      setContextMenu(null);
    } else if (cm && cm.target.kind === "video" && cm.target.track) {
      const t = cm.target.track;
      try {
        const libId = parseLibraryId(t.key);
        if (libId != null) {
          await invoke("show_in_folder", { trackId: libId });
        } else if (t.path) {
          await invoke("show_in_folder_path", { filePath: t.path });
        }
      } catch (e) {
        console.error("Failed to open containing folder:", e);
        setFolderError(String(e));
      }
      setContextMenu(null);
    }
  }

  async function handleBulkEdit() {
    const cm = contextMenuRef.current;
    if (!cm) return;
    const trackIds = cm.target.kind === "multi-track"
      ? cm.target.trackIds
      : cm.target.kind === "track" && cm.target.trackId
      ? [cm.target.trackId]
      : null;
    if (!trackIds || trackIds.length === 0) return;
    setContextMenu(null);
    try {
      const selected = await invoke<Track[]>("get_tracks_by_ids", { ids: trackIds });
      if (selected.length > 0) setBulkEditTracks(selected);
    } catch (e) {
      console.error("Failed to load tracks for bulk edit:", e);
    }
  }

  async function handleDeleteRequest() {
    const cm = contextMenuRef.current;
    if (!cm) return;
    const { target } = cm;
    // A network-share file can't go to the Recycle Bin — deleting it is
    // permanent. Flag the confirm modal when any selected track lives there.
    const idsOnNetwork = (ids: number[]) =>
      ids.some(id => isNetworkSharePath(library.tracks.find(t => t.id === id)?.path));
    if (target.kind === "track" && target.trackId && target.isLocal) {
      setDeleteConfirm({ trackIds: [target.trackId], title: target.title, network: idsOnNetwork([target.trackId]) });
    } else if (target.kind === "multi-track") {
      setDeleteConfirm({ trackIds: target.trackIds, title: `${target.trackIds.length} tracks`, network: idsOnNetwork(target.trackIds) });
    } else if (target.kind === "queue-multi") {
      const localTracks = target.indices.map(i => queueHook.queue[i]).filter(Boolean).filter(isLocalTrack);
      // Resolve a library id per local track: prefer the in-memory lib:N key, else
      // look it up by its (durable) file path. This is what lets ext: queue tracks
      // be deleted — restored, m3u-loaded, or home-shelf — not just fresh lib:N rows.
      const ids: number[] = [];
      for (const t of localTracks) {
        const keyId = parseLibraryId(t.key);
        if (keyId != null) { ids.push(keyId); continue; }
        if (!t.path) continue;
        try {
          const resolved = await invoke<number | null>("find_track_id_by_path", { path: t.path });
          if (resolved != null) ids.push(resolved);
        } catch (e) {
          console.error("Failed to resolve track id by path:", e);
        }
      }
      if (ids.length > 0) {
        setDeleteConfirm({
          trackIds: ids,
          title: localTracks.length === 1 ? localTracks[0].title : `${ids.length} tracks`,
          network: localTracks.some(t => isNetworkSharePath(t.path)),
        });
      } else if (localTracks.length > 0) {
        setDeleteError({ message: `Those tracks aren't in your library, so they can't be moved to the ${trashLabel}.`, failures: [] });
      }
    } else if (target.kind === "video" && target.track && target.track.isLocal) {
      // The playing video is an id-less QueueTrack: resolve its library id from
      // the lib:N key, falling back to a path lookup (restored/m3u/external keys).
      const t = target.track;
      let id = parseLibraryId(t.key);
      if (id == null && t.path) {
        try {
          id = await invoke<number | null>("find_track_id_by_path", { path: t.path });
        } catch (e) {
          console.error("Failed to resolve track id by path:", e);
        }
      }
      if (id != null) {
        setDeleteConfirm({ trackIds: [id], title: t.title, network: isNetworkSharePath(t.path) });
      } else {
        setDeleteError({ message: `That track isn't in your library, so it can't be moved to the ${trashLabel}.`, failures: [] });
      }
    }
    setContextMenu(null);
  }

  async function handleDeleteConfirm() {
    if (!deleteConfirm) return;
    const { trackIds, title } = deleteConfirm;
    setDeleteConfirm(null);
    try {
      const result: { deletedIds: number[]; deletedPaths: string[]; failures: { title: string; reason: string }[] } = await invoke("delete_tracks", { trackIds });
      const deletedPaths = new Set(result.deletedPaths as string[]);
      if (result.deletedIds.length > 0) {
        library.setTracks(prev => prev.filter(t => t.id == null || !new Set(result.deletedIds).has(t.id)));
        emitTracksDeleted(result.deletedIds);
        const queueIndicesToRemove: number[] = [];
        queueHook.queue.forEach((t, i) => {
          if (t.path && deletedPaths.has(t.path)) queueIndicesToRemove.push(i);
        });
        const currentDeleted = !!(playback.currentTrack?.path && deletedPaths.has(playback.currentTrack.path));
        if (currentDeleted && onCurrentTrackDeleted) {
          // Deleting the playing track shouldn't dead-stop the player: advance to
          // the next surviving track (or auto-continue / previous / stop) AND drop
          // the deleted entries from the queue in one consistent step.
          onCurrentTrackDeleted(queueIndicesToRemove);
        } else {
          if (currentDeleted) playback.handleStop();
          if (queueIndicesToRemove.length > 0) {
            queueHook.removeMultiple(queueIndicesToRemove);
          }
        }
        library.loadLibrary();
        onTracksDeleted?.(result.deletedIds);
      }
      if (result.failures.length === trackIds.length) {
        setDeleteError({ message: `Failed to move ${title} to ${trashLabel}`, failures: result.failures });
      } else if (result.failures.length > 0) {
        setDeleteError({ message: `${result.failures.length} of ${trackIds.length} tracks could not be moved to ${trashLabel}`, failures: result.failures });
      }
    } catch (e) {
      console.error("Failed to move tracks to trash:", e);
      setDeleteError({ message: `Failed to move ${title} to ${trashLabel}`, failures: [{ title, reason: String(e) }] });
    }
  }

  async function handleWatchOnYoutube() {
    const cm = contextMenuRef.current;
    if (!cm || cm.target.kind !== "track" || cm.target.trackId == null) return;
    const { trackId, title, artistName } = cm.target;
    const track = library.tracks.find(t => t.id === trackId);
    await watchOnYoutube(title, artistName, track?.duration_secs ?? null);
  }

  function handleInfoTrackContextMenu(e: React.MouseEvent, info: { trackId?: number; title: string; artistName: string | null }) {
    showMenu({ x: e.clientX, y: e.clientY, target: {
      kind: "track", trackId: info.trackId, isLocal: false, title: info.title, artistName: info.artistName,
    } });
  }

  function handleEntityContextMenu(e: React.MouseEvent, info: { kind: "track" | "artist" | "album"; id?: number; name: string; artistName?: string | null }) {
    e.preventDefault();
    const target: ContextMenuTarget = info.kind === "artist"
      ? { kind: "artist", artistId: info.id, name: info.name }
      : info.kind === "album"
      ? { kind: "album", albumId: info.id, title: info.name, artistName: info.artistName ?? null }
      : { kind: "track", trackId: info.id, isLocal: false, title: info.name, artistName: info.artistName ?? null };
    showMenu({ x: e.clientX, y: e.clientY, target });
  }

  return {
    contextMenu,
    setContextMenu,
    bulkEditTracks,
    setBulkEditTracks,
    deleteConfirm,
    setDeleteConfirm,
    deleteError,
    setDeleteError,
    folderError,
    setFolderError,
    pendingEnqueue,
    setPendingEnqueue,
    externalDropTarget,
    handleTrackContextMenu,
    handleAlbumContextMenu,
    handleArtistContextMenu,
    handleTagContextMenu,
    handleMultiAlbumContextMenu,
    handleMultiArtistContextMenu,
    handleMultiTagContextMenu,
    fetchMultiEntityTracks,
    handleContextPlay,
    startRadio: playActions.startRadio,
    handleContextEnqueue,
    handleEnqueue,
    handleShowInFolder,
    handleBulkEdit,
    handleDeleteRequest,
    handleDeleteConfirm,
    watchOnYoutube,
    handleWatchOnYoutube,
    handleQueueRemove,
    handleQueueKeepOnly,
    handleQueueMoveToTop,
    handleQueueMoveToBottom,
    handleTrackDragStart,
    handleInfoTrackContextMenu,
    handleEntityContextMenu,
    handleDownloadTrack,
    handleDownloadMulti,
    downloadConfirm,
    handleDownloadConfirm,
    handleDownloadConfirmDismiss,
  };
}
