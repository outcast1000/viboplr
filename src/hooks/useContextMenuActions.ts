import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Track, Artist, Album } from "../types";
import type { ContextMenuState } from "../components/ContextMenu";
import { store } from "../store";

interface UseContextMenuActionsDeps {
  library: {
    tracks: Track[];
    sortedTracks: Track[];
    artists: Artist[];
    albums: Album[];
    setTracks: React.Dispatch<React.SetStateAction<Track[]>>;
  };
  queueHook: {
    playTracks: (tracks: Track[], index: number) => void;
    enqueueTracks: (tracks: Track[]) => void;
    findDuplicates: (tracks: Track[]) => { duplicates: Track[]; unique: Track[] };
    insertAtPosition: (tracks: Track[], pos: number) => void;
    removeMultiple: (indices: number[]) => void;
    moveToTop: (indices: number[]) => void;
    moveToBottom: (indices: number[]) => void;
    queue: Track[];
    addToQueue: (track: Track) => void;
  };
  playback: { currentTrack: Track | null; handleStop: () => void };
  addLog: (msg: string) => void;
  queueCollapsed: boolean;
  setQueueCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useContextMenuActions(deps: UseContextMenuActionsDeps) {
  const { library, queueHook, playback, addLog, queueCollapsed, setQueueCollapsed } = deps;

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [youtubeFeedback, setYoutubeFeedback] = useState<{
    trackId: number; url: string; videoTitle: string;
  } | null>(null);
  const [bulkEditTracks, setBulkEditTracks] = useState<Track[] | null>(null);
  const [tidalDownload, setTidalDownload] = useState<{ trackId: number | null; title: string; artistName: string | null } | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<{ trackIds: number[]; title: string } | null>(null);
  const [deleteError, setDeleteError] = useState<{ message: string; failures: { title: string; reason: string }[] } | null>(null);
  const [pendingEnqueue, setPendingEnqueue] = useState<{ all: Track[]; duplicates: Track[]; unique: Track[]; position?: number } | null>(null);
  const [externalDropTarget, setExternalDropTarget] = useState<number | null>(null);

  function handleTrackContextMenu(e: React.MouseEvent, track: Track, selectedTrackIds: Set<number>) {
    e.preventDefault();
    if (selectedTrackIds.size > 1) {
      setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "multi-track", trackIds: [...selectedTrackIds] } });
    } else {
      setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "track", trackId: track.id, subsonic: track.path.startsWith("subsonic://"), title: track.title, artistName: track.artist_name } });
    }
  }

  function handleAlbumContextMenu(e: React.MouseEvent, albumId: number) {
    e.preventDefault();
    const album = library.albums.find(a => a.id === albumId);
    setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "album", albumId, title: album?.title ?? "", artistName: album?.artist_name ?? null } });
  }

  function handleArtistContextMenu(e: React.MouseEvent, artistId: number) {
    e.preventDefault();
    const artist = library.artists.find(a => a.id === artistId);
    setContextMenu({ x: e.clientX, y: e.clientY, target: { kind: "artist", artistId, name: artist?.name ?? "" } });
  }

  async function handleContextPlay() {
    if (!contextMenu) return;
    const { target } = contextMenu;
    if (target.kind === "track") {
      const track = library.tracks.find(t => t.id === target.trackId);
      if (track) queueHook.playTracks([track], 0);
    } else if (target.kind === "album") {
      const albumTracks = await invoke<Track[]>("get_tracks", { opts: { albumId: target.albumId } });
      if (albumTracks.length > 0) queueHook.playTracks(albumTracks, 0);
    } else if (target.kind === "artist") {
      const artistTracks = await invoke<Track[]>("get_tracks_by_artist", { artistId: target.artistId });
      if (artistTracks.length > 0) queueHook.playTracks(artistTracks, 0);
    } else if (target.kind === "multi-track") {
      const idSet = new Set(target.trackIds);
      const selected = library.sortedTracks.filter(t => idSet.has(t.id));
      if (selected.length > 0) queueHook.playTracks(selected, 0);
    } else if (target.kind === "queue-multi") {
      const selected = target.indices.map(i => queueHook.queue[i]).filter(Boolean);
      if (selected.length > 0) queueHook.playTracks(selected, 0);
    }
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
    if (!contextMenu) return;
    const { target } = contextMenu;
    if (target.kind === "track") {
      const track = library.tracks.find(t => t.id === target.trackId);
      if (track) handleEnqueue([track]);
    } else if (target.kind === "album") {
      const albumTracks = await invoke<Track[]>("get_tracks", { opts: { albumId: target.albumId } });
      handleEnqueue(albumTracks);
    } else if (target.kind === "artist") {
      const artistTracks = await invoke<Track[]>("get_tracks_by_artist", { artistId: target.artistId });
      handleEnqueue(artistTracks);
    } else if (target.kind === "multi-track") {
      const idSet = new Set(target.trackIds);
      const selected = library.sortedTracks.filter(t => idSet.has(t.id));
      handleEnqueue(selected);
    }
  }

  function handleQueueRemove() {
    if (!contextMenu || contextMenu.target.kind !== "queue-multi") return;
    queueHook.removeMultiple(contextMenu.target.indices);
  }

  function handleQueueMoveToTop() {
    if (!contextMenu || contextMenu.target.kind !== "queue-multi") return;
    queueHook.moveToTop(contextMenu.target.indices);
  }

  function handleQueueMoveToBottom() {
    if (!contextMenu || contextMenu.target.kind !== "queue-multi") return;
    queueHook.moveToBottom(contextMenu.target.indices);
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

  function handleShowInFolder() {
    if (contextMenu && contextMenu.target.kind === "track") {
      invoke("show_in_folder", { trackId: contextMenu.target.trackId });
      setContextMenu(null);
    } else if (contextMenu && contextMenu.target.kind === "queue-multi" && contextMenu.target.indices.length === 1) {
      const track = queueHook.queue[contextMenu.target.indices[0]];
      if (track && track.path) {
        invoke("show_in_folder_path", { filePath: track.path });
      } else if (track && track.id > 0) {
        invoke("show_in_folder", { trackId: track.id });
      }
      setContextMenu(null);
    }
  }

  function handleBulkEdit() {
    if (!contextMenu || contextMenu.target.kind !== "multi-track") return;
    const { trackIds } = contextMenu.target;
    const selected = library.tracks.filter(t => trackIds.includes(t.id));
    if (selected.length > 0) setBulkEditTracks(selected);
    setContextMenu(null);
  }

  function handleDeleteRequest() {
    if (!contextMenu) return;
    const { target } = contextMenu;
    if (target.kind === "track" && !target.subsonic) {
      setDeleteConfirm({ trackIds: [target.trackId], title: target.title });
    } else if (target.kind === "multi-track") {
      setDeleteConfirm({ trackIds: target.trackIds, title: `${target.trackIds.length} tracks` });
    } else if (target.kind === "queue-multi") {
      const tracks = target.indices.map(i => queueHook.queue[i]).filter(Boolean);
      const localTracks = tracks.filter(t => !t.path.startsWith("subsonic://") && !t.path.startsWith("tidal://"));
      if (localTracks.length > 0) {
        const ids = localTracks.map(t => t.id);
        setDeleteConfirm({ trackIds: ids, title: localTracks.length === 1 ? localTracks[0].title : `${localTracks.length} tracks` });
      }
    }
    setContextMenu(null);
  }

  async function handleDeleteConfirm() {
    if (!deleteConfirm) return;
    const { trackIds, title } = deleteConfirm;
    setDeleteConfirm(null);
    try {
      const result: { deletedIds: number[]; failures: { title: string; reason: string }[] } = await invoke("delete_tracks", { trackIds });
      const deletedSet = new Set(result.deletedIds);
      if (deletedSet.size > 0) {
        library.setTracks(prev => prev.filter(t => !deletedSet.has(t.id)));
        if (playback.currentTrack && deletedSet.has(playback.currentTrack.id)) {
          playback.handleStop();
        }
      }
      if (result.failures.length === trackIds.length) {
        setDeleteError({ message: `Failed to delete ${title}`, failures: result.failures });
      } else if (result.failures.length > 0) {
        addLog(`Deleted ${result.deletedIds.length} of ${trackIds.length} tracks`);
        setDeleteError({ message: `${result.failures.length} of ${trackIds.length} tracks could not be deleted`, failures: result.failures });
      } else {
        addLog(`Deleted ${title}`);
      }
    } catch (e) {
      console.error("Failed to delete tracks:", e);
      setDeleteError({ message: `Failed to delete ${title}`, failures: [{ title, reason: String(e) }] });
    }
  }

  async function watchOnYoutube(trackId: number, title: string, artistName: string | null, youtubeUrl: string | null) {
    if (youtubeUrl) {
      await openUrl(youtubeUrl);
      addLog(`Opened YouTube: ${title}`);
      return;
    }

    addLog("Searching YouTube...");
    try {
      const result = await invoke<{ url: string; video_title: string | null }>(
        "search_youtube", { title, artistName }
      );
      await openUrl(result.url);
      addLog(`Opened YouTube: ${result.video_title ?? title}`);
      setYoutubeFeedback({ trackId, url: result.url, videoTitle: result.video_title ?? title });
    } catch {
      const q = encodeURIComponent(`${title} ${artistName ?? ""}`);
      await openUrl(`https://www.youtube.com/results?search_query=${q}`);
      addLog("YouTube search failed, opened search results");
    }
  }

  async function handleWatchOnYoutube() {
    if (!contextMenu || contextMenu.target.kind !== "track") return;
    const { trackId, title, artistName } = contextMenu.target;
    const track = library.tracks.find(t => t.id === trackId);
    await watchOnYoutube(trackId, title, artistName, track?.youtube_url ?? null);
  }

  async function handleYoutubeFeedback(correct: boolean) {
    if (!youtubeFeedback) return;
    if (correct) {
      await invoke("set_track_youtube_url", {
        trackId: youtubeFeedback.trackId,
        url: youtubeFeedback.url,
      });
      library.setTracks(prev => prev.map(t => t.id === youtubeFeedback.trackId ? { ...t, youtube_url: youtubeFeedback.url } : t));
      addLog("Saved YouTube link for future use");
    }
    setYoutubeFeedback(null);
  }

  return {
    contextMenu,
    setContextMenu,
    youtubeFeedback,
    bulkEditTracks,
    setBulkEditTracks,
    tidalDownload,
    setTidalDownload,
    deleteConfirm,
    setDeleteConfirm,
    deleteError,
    setDeleteError,
    pendingEnqueue,
    setPendingEnqueue,
    externalDropTarget,
    handleTrackContextMenu,
    handleAlbumContextMenu,
    handleArtistContextMenu,
    handleContextPlay,
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
    handleQueueMoveToTop,
    handleQueueMoveToBottom,
    handleTrackDragStart,
  };
}
