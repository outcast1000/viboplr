import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";

/** Build the `enqueue_download` IPC payload from a queue track. Single source so
 * the single-track and multi-track download paths can't drift. `provider`
 * targets a specific download provider (plugins pass their own via
 * `api.downloads.enqueue`); null walks the whole chain. */
function buildDownloadRequest(track: QueueTrack, isBatchLast: boolean, provider?: string | null) {
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
    provider: provider ?? null,
  };
}

/**
 * Context-menu download actions (batch). Goes through the unified downloader
 * via `enqueue_download` — the background chain resolves each track. The old
 * single-track-with-confirm flow (`handleDownloadTrack` + the "already
 * downloaded" modal) was removed with the host-generated per-provider menu
 * entries — nothing reached it any more; single-track downloads open the
 * source-owned DownloadModal instead.
 */
export function useDownloadActions() {
  const enqueueDownload = useCallback(async (track: QueueTrack, provider?: string | null) => {
    try {
      await invoke("enqueue_download", buildDownloadRequest(track, false, provider));
    } catch (e) {
      console.error("Failed to enqueue download:", e);
    }
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
    enqueueDownload,
    handleDownloadMulti,
  };
}
