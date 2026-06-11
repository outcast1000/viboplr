import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Track, Artist, Album, QueueTrack } from "../types";
import { parseLibraryId, isLocalTrack, isNetworkSharePath, trackToQueueTrack } from "../queueEntry";
import type { ContextMenuState, ContextMenuTarget } from "../types/contextMenu";
import type { PlaylistContext } from "./useQueue";
import { store } from "../store";
import { trashLabel } from "../utils";
import { emitTrackPatch, emitTracksDeleted } from "../trackEvents";

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
  playActions: {
    playAlbum: (albumId: number) => void;
    playArtist: (artistId: number) => void;
    playTag: (tagId: number) => void;
  };
  queueCollapsed: boolean;
  setQueueCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  onTracksDeleted?: (deletedIds: number[]) => void;
  onShowMenu?: (state: ContextMenuState) => void;
}

export function useContextMenuActions(deps: UseContextMenuActionsDeps) {
  const { library, queueHook, playback, playActions, queueCollapsed, setQueueCollapsed, onTracksDeleted, onShowMenu } = deps;

  const [contextMenu, setContextMenuState] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<ContextMenuState | null>(null);
  const [youtubeFeedback, setYoutubeFeedback] = useState<{
    trackId: number; url: string; videoTitle: string;
  } | null>(null);
  const [bulkEditTracks, setBulkEditTracks] = useState<Track[] | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<{ trackIds: number[]; title: string; network?: boolean } | null>(null);
  const [deleteError, setDeleteError] = useState<{ message: string; failures: { title: string; reason: string }[] } | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [downloadConfirm, setDownloadConfirm] = useState<{ track: QueueTrack; localTitle: string; localTrackId: number } | null>(null);
  const [pendingEnqueue, setPendingEnqueue] = useState<{ all: QueueTrack[]; duplicates: QueueTrack[]; unique: QueueTrack[]; position?: number } | null>(null);
  const [externalDropTarget, setExternalDropTarget] = useState<number | null>(null);

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

  function handleQueueRemove() {
    const cm = contextMenuRef.current;
    if (!cm || cm.target.kind !== "queue-multi") return;
    queueHook.removeMultiple(cm.target.indices);
  }

  function handleQueueKeepOnly() {
    const cm = contextMenuRef.current;
    if (!cm || cm.target.kind !== "queue-multi") return;
    const keepSet = new Set(cm.target.indices);
    const toRemove = queueHook.queue.map((_, i) => i).filter(i => !keepSet.has(i));
    queueHook.removeMultiple(toRemove);
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

  function handleTrackDragStart(dragTracks: Track[]) {
    let ghost: HTMLDivElement | null = null;
    const dropTargetRef = { current: null as number | null };

    function findQueueIndex(el: Element | null): number | null {
      while (el) {
        const idx = el.getAttribute("data-queue-index");
        if (idx !== null) return parseInt(idx, 10);
        el = el.parentElement;
      }
      return null;
    }

    function onMouseMove(ev: MouseEvent) {
      if (!ghost) {
        ghost = document.createElement("div");
        ghost.className = "queue-drag-ghost";
        ghost.textContent = `${dragTracks.length} track${dragTracks.length > 1 ? "s" : ""}`;
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${ev.clientX + 12}px`;
      ghost.style.top = `${ev.clientY - 10}px`;

      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const queuePanel = target?.closest(".queue-panel");
      if (queuePanel) {
        const overIndex = findQueueIndex(target);
        if (overIndex !== null) {
          const el = target!.closest("[data-queue-index]") as HTMLElement | null;
          if (el) {
            const rect = el.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const dt = ev.clientY < midY ? overIndex : overIndex + 1;
            dropTargetRef.current = dt;
            setExternalDropTarget(dt);
          }
        } else {
          // Over queue panel but not on an item — drop at end
          dropTargetRef.current = queueHook.queue.length;
          setExternalDropTarget(queueHook.queue.length);
        }
      } else {
        dropTargetRef.current = null;
        setExternalDropTarget(null);
      }
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (ghost) { ghost.remove(); ghost = null; }

      if (dropTargetRef.current !== null) {
        const pos = dropTargetRef.current;
        const { duplicates, unique } = queueHook.findDuplicates(dragTracks);
        if (duplicates.length > 0) {
          setPendingEnqueue({ all: dragTracks, duplicates, unique, position: pos });
          if (queueCollapsed) { setQueueCollapsed(false); store.set("queueCollapsed", false); }
        } else {
          queueHook.insertAtPosition(dragTracks, pos);
          if (queueCollapsed) { setQueueCollapsed(false); store.set("queueCollapsed", false); }
        }
      }

      setExternalDropTarget(null);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
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

  function handleDeleteRequest() {
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
      const tracks = target.indices.map(i => queueHook.queue[i]).filter(Boolean);
      const localTracks = tracks.filter(t => isLocalTrack(t) && parseLibraryId(t.key) != null);
      if (localTracks.length > 0) {
        const ids = localTracks.map(t => parseLibraryId(t.key)!);
        setDeleteConfirm({
          trackIds: ids,
          title: localTracks.length === 1 ? localTracks[0].title : `${localTracks.length} tracks`,
          network: localTracks.some(t => isNetworkSharePath(t.path)),
        });
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
        if (playback.currentTrack?.path && deletedPaths.has(playback.currentTrack.path)) {
          playback.handleStop();
        }
        const queueIndicesToRemove: number[] = [];
        queueHook.queue.forEach((t, i) => {
          if (t.path && deletedPaths.has(t.path)) queueIndicesToRemove.push(i);
        });
        if (queueIndicesToRemove.length > 0) {
          queueHook.removeMultiple(queueIndicesToRemove);
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

  async function watchOnYoutube(trackId: number, title: string, artistName: string | null, youtubeUrl: string | null, durationSecs: number | null = null) {
    if (youtubeUrl) {
      await openUrl(youtubeUrl);
      return;
    }

    try {
      const result = await invoke<{ url: string; video_title: string | null }>(
        "search_youtube", { title, artistName, durationSecs }
      );
      await openUrl(result.url);
      setYoutubeFeedback({ trackId, url: result.url, videoTitle: result.video_title ?? title });
    } catch {
      const q = encodeURIComponent(`${title} ${artistName ?? ""}`);
      await openUrl(`https://www.youtube.com/results?search_query=${q}`);
    }
  }

  async function handleWatchOnYoutube() {
    const cm = contextMenuRef.current;
    if (!cm || cm.target.kind !== "track" || cm.target.trackId == null) return;
    const { trackId, title, artistName } = cm.target;
    const track = library.tracks.find(t => t.id === trackId);
    await watchOnYoutube(trackId, title, artistName, track?.youtube_url ?? null, track?.duration_secs ?? null);
  }

  async function handleYoutubeFeedback(correct: boolean) {
    if (!youtubeFeedback) return;
    if (correct) {
      await invoke("set_track_youtube_url", {
        trackId: youtubeFeedback.trackId,
        url: youtubeFeedback.url,
      });
      library.setTracks(prev => prev.map(t => t.id === youtubeFeedback.trackId ? { ...t, youtube_url: youtubeFeedback.url } : t));
      emitTrackPatch(youtubeFeedback.trackId, { youtube_url: youtubeFeedback.url });
    }
    setYoutubeFeedback(null);
  }

  function handleInfoTrackContextMenu(e: React.MouseEvent, info: { trackId?: number; title: string; artistName: string | null }) {
    showMenu({ x: e.clientX, y: e.clientY, target: {
      kind: "track", trackId: info.trackId, isLocal: false, title: info.title, artistName: info.artistName,
    } });
  }

  function findLocalCopy(track: QueueTrack): Track | undefined {
    const title = track.title.toLowerCase();
    const artist = (track.artist_name || "").toLowerCase();
    return library.tracks.find(t =>
      t.path?.startsWith("file://") &&
      t.title.toLowerCase() === title &&
      (t.artist_name || "").toLowerCase() === artist
    );
  }

  const enqueueDownload = useCallback(async (track: QueueTrack) => {
    try {
      await invoke("enqueue_download", {
        title: track.title,
        artistName: track.artist_name,
        albumTitle: track.album_title,
        uri: track.path ?? null,
        durationSecs: track.duration_secs ?? null,
        destCollectionId: null,
        destCollectionPath: null,
        format: null,
        pathPattern: null,
        isBatchLast: false,
      });
    } catch (e) {
      console.error("Failed to enqueue download:", e);
    }
  }, []);

  const handleDownloadTrack = useCallback(async (track: QueueTrack) => {
    const localCopy = findLocalCopy(track);
    if (localCopy) {
      setDownloadConfirm({ track, localTitle: localCopy.title, localTrackId: localCopy.id! });
      return;
    }
    enqueueDownload(track);
  }, [enqueueDownload, library.tracks]);

  const handleDownloadConfirm = useCallback(() => {
    if (!downloadConfirm) return;
    const { track } = downloadConfirm;
    setDownloadConfirm(null);
    enqueueDownload(track);
  }, [downloadConfirm, enqueueDownload]);

  const handleDownloadConfirmDismiss = useCallback(() => {
    setDownloadConfirm(null);
  }, []);

  const handleDownloadMulti = useCallback(async (tracks: QueueTrack[]) => {
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const isLast = i === tracks.length - 1;
      try {
        await invoke("enqueue_download", {
          title: track.title,
          artistName: track.artist_name,
          albumTitle: track.album_title,
          uri: track.path ?? null,
          durationSecs: track.duration_secs ?? null,
          destCollectionId: null,
          destCollectionPath: null,
          format: null,
          pathPattern: null,
          isBatchLast: isLast,
        });
      } catch (e) {
        console.error("Failed to enqueue download:", e);
      }
    }
  }, []);

  function handleEntityContextMenu(e: React.MouseEvent, info: { kind: "track" | "artist" | "album"; id?: number; name: string; artistName?: string | null }) {
    e.preventDefault();
    const target: ContextMenuTarget = info.kind === "artist"
      ? { kind: "artist", artistId: info.id, name: info.name }
      : info.kind === "album"
      ? { kind: "album", albumId: info.id, title: info.name, artistName: info.artistName ?? null }
      : { kind: "track", trackId: info.id, isLocal: false, title: info.name, artistName: info.artistName ?? null };
    showMenu({ x: e.clientX, y: e.clientY, target });
  }

  const startRadio = useCallback(async (seed: { title: string; artistName: string | null; coverPath: string | null }) => {
    if (!seed.title) return;
    console.log(`Building radio from "${seed.title}"...`);
    try {
      const tracks = await invoke<Track[]>("build_radio_for_track", {
        seedTitle: seed.title,
        seedArtist: seed.artistName,
        targetCount: 30,
      });
      if (tracks.length < 2) {
        console.log("Radio: not enough tracks to generate a station");
        return;
      }
      const queueTracks = tracks.map(trackToQueueTrack);
      queueHook.playTracks(queueTracks, 0, {
        name: `Radio: ${seed.title}`,
        imagePath: seed.coverPath ?? null,
        source: "radio",
      });
      console.log(`Radio started · ${tracks.length} tracks`);
    } catch (e) {
      console.error("Failed to start radio:", e);
    }
  }, [queueHook]);

  return {
    contextMenu,
    setContextMenu,
    youtubeFeedback,
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
    startRadio,
    handleContextEnqueue,
    handleEnqueue,
    handleShowInFolder,
    handleBulkEdit,
    handleDeleteRequest,
    handleDeleteConfirm,
    watchOnYoutube,
    handleWatchOnYoutube,
    handleYoutubeFeedback,
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
