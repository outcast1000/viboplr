import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, QueueTrack } from "../types";
import { isLocalTrack } from "../queueEntry";

/** Build the `enqueue_download` IPC payload from a queue track. Single source so
 * the single-track and multi-track download paths can't drift. */
function buildDownloadRequest(track: QueueTrack, isBatchLast: boolean) {
  return {
    title: track.title,
    artistName: track.artist_name,
    albumTitle: track.album_title,
    uri: track.path ?? null,
    durationSecs: track.duration_secs ?? null,
    destCollectionId: null,
    destCollectionPath: null,
    format: null,
    pathPattern: null,
    isBatchLast,
  };
}

/**
 * Context-menu download actions (single + multi). Both go through the unified
 * downloader via `enqueue_download`. Single-track downloads first check for an
 * existing local copy (via the backend metadata matcher) and, if found, raise a
 * confirm modal before re-downloading.
 */
export function useDownloadActions() {
  const [downloadConfirm, setDownloadConfirm] = useState<{ track: QueueTrack; localTitle: string; localTrackId: number } | null>(null);

  const enqueueDownload = useCallback(async (track: QueueTrack) => {
    try {
      await invoke("enqueue_download", buildDownloadRequest(track, false));
    } catch (e) {
      console.error("Failed to enqueue download:", e);
    }
  }, []);

  const handleDownloadTrack = useCallback(async (track: QueueTrack) => {
    // Resolve an existing local copy through the backend (diacritic-aware SQL
    // match) per conventions.md "Track Matching by Metadata" — never JS-side
    // string comparison. Only a *local* match should trigger the re-download
    // confirm; the backend may return a remote copy, which we ignore here.
    try {
      const localCopy = await invoke<Track | null>("find_track_by_metadata", {
        title: track.title,
        artistName: track.artist_name,
        albumName: track.album_title,
      });
      if (localCopy && localCopy.id != null && isLocalTrack(localCopy)) {
        setDownloadConfirm({ track, localTitle: localCopy.title, localTrackId: localCopy.id });
        return;
      }
    } catch (e) {
      console.error("Failed to check for existing local copy:", e);
    }
    enqueueDownload(track);
  }, [enqueueDownload]);

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
      const isLast = i === tracks.length - 1;
      try {
        await invoke("enqueue_download", buildDownloadRequest(tracks[i], isLast));
      } catch (e) {
        console.error("Failed to enqueue download:", e);
      }
    }
  }, []);

  return {
    downloadConfirm,
    enqueueDownload,
    handleDownloadTrack,
    handleDownloadConfirm,
    handleDownloadConfirmDismiss,
    handleDownloadMulti,
  };
}
