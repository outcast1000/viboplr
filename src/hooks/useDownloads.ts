import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Track } from "../types";
import type { AppStore } from "../store";

export interface DownloadStatus {
  active: { id: number; track_title: string; artist_name: string; progress_pct: number } | null;
  queued: { id: number; track_title: string; artist_name: string }[];
  completed: { id: number; track_title: string; status: string; error?: string }[];
}

export interface UseDownloadsReturn {
  downloadFormat: string;
  downloadStatus: DownloadStatus | null;
  setFormat: (format: string, store: AppStore) => void;
  downloadTrack: (trackId: number, destCollectionId: number, tracks: Track[]) => Promise<void>;
  cancelDownload: (id: number) => Promise<void>;
}

export function useDownloads(
  downloadFormatRef: React.MutableRefObject<string>,
  addLog: (msg: string) => void,
): UseDownloadsReturn {
  const [downloadFormat, setDownloadFormat] = useState("flac");
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus | null>(null);

  useEffect(() => {
    const unlisten1 = listen<{ id: number; track_title: string; artist_name: string; progress_pct: number }>(
      "download-progress",
      () => { invoke<typeof downloadStatus>("get_download_status").then(setDownloadStatus); }
    );
    const unlisten2 = listen<{ id: number; trackTitle: string; destPath: string }>(
      "download-complete",
      (event) => {
        addLog(`Downloaded: ${event.payload.trackTitle}`);
        invoke<typeof downloadStatus>("get_download_status").then(setDownloadStatus);
      }
    );
    const unlisten3 = listen<{ id: number; trackTitle: string; error: string }>(
      "download-error",
      (event) => {
        addLog(`Download error: ${event.payload.trackTitle} - ${event.payload.error}`);
        invoke<typeof downloadStatus>("get_download_status").then(setDownloadStatus);
      }
    );
    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
      unlisten3.then((f) => f());
    };
  }, [addLog]);

  function setFormat(format: string, store: AppStore) {
    setDownloadFormat(format);
    downloadFormatRef.current = format;
    store.set("downloadFormat", format);
  }

  async function downloadTrack(trackId: number, destCollectionId: number, tracks: Track[]) {
    const track = tracks.find(t => t.id === trackId);
    if (!track?.subsonic_id || !track.collection_id) return;
    try {
      await invoke("download_track", {
        sourceCollectionId: track.collection_id,
        remoteTrackId: track.subsonic_id,
        destCollectionId,
        format: downloadFormat,
      });
      addLog(`Downloading: ${track.title}`);
    } catch (e) {
      addLog(`Download failed: ${e}`);
    }
  }

  async function cancelDownload(id: number) {
    await invoke("cancel_download", { downloadId: id });
    invoke<typeof downloadStatus>("get_download_status").then(setDownloadStatus);
  }

  return {
    downloadFormat,
    downloadStatus,
    setFormat,
    downloadTrack,
    cancelDownload,
  };
}
