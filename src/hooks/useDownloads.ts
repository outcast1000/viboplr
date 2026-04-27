import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Track } from "../types";
import type { AppStore } from "../store";
import type { DownloadProvider, DownloadResolveResult } from "../types/plugin";

export interface UseDownloadsReturn {
  downloadFormat: string;
  setFormat: (format: string, store: AppStore) => void;
  downloadTrack: (trackId: number, destCollectionId: number, tracks: Track[]) => Promise<void>;
  autoSaveTrack: (track: Track, downloadsCollectionId: number, format: string, libraryTracks?: Track[]) => Promise<void>;
}

async function resolveTrackDownload(
  providers: DownloadProvider[],
  uri: string | null,
  title: string,
  artistName: string | null,
  albumName: string | null,
  durationSecs: number | null,
  format: string,
): Promise<DownloadResolveResult | null> {
  if (uri) {
    for (const provider of providers) {
      try {
        const result = await Promise.race([
          provider.resolveByUri(uri, format),
          new Promise<null>((r) => setTimeout(() => r(null), 10000)),
        ]);
        if (result) return result;
      } catch {
        continue;
      }
    }
  }

  for (const provider of providers) {
    try {
      const result = await Promise.race([
        provider.resolveByMetadata(title, artistName, albumName, durationSecs, format),
        new Promise<null>((r) => setTimeout(() => r(null), 10000)),
      ]);
      if (result) return result;
    } catch {
      continue;
    }
  }

  return null;
}

export function useDownloads(
  downloadFormatRef: React.MutableRefObject<string>,
  addLog: (msg: string, module?: string) => void,
  downloadProvidersRef: React.MutableRefObject<DownloadProvider[]>,
): UseDownloadsReturn {
  const [downloadFormat, setDownloadFormat] = useState("flac");

  useEffect(() => {
    const unlisten1 = listen<{ id: number; trackTitle: string; destPath: string }>(
      "download-complete",
      (event) => {
        addLog(`Downloaded: ${event.payload.trackTitle}`, "downloads");
      }
    );
    const unlisten2 = listen<{ id: number; trackTitle: string; error: string }>(
      "download-error",
      (event) => {
        addLog(`Download failed: ${event.payload.trackTitle}`, "downloads");
      }
    );
    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
    };
  }, [addLog]);

  useEffect(() => {
    const unlisten = listen<{
      id: number;
      title: string;
      artist_name: string | null;
      album_title: string | null;
      duration_secs: number | null;
      uri: string | null;
      format: string;
    }>("download-resolve-request", async (event) => {
      const { id, title, artist_name, album_title, duration_secs, uri, format } = event.payload;

      const result = await resolveTrackDownload(
        downloadProvidersRef.current,
        uri, title, artist_name, album_title, duration_secs, format,
      );

      await invoke("download_resolve_response", { id, result: result ?? null });
    });

    return () => { unlisten.then((fn) => fn()); };
  }, []);

  function setFormat(format: string, store: AppStore) {
    setDownloadFormat(format);
    downloadFormatRef.current = format;
    store.set("downloadFormat", format);
  }

  async function downloadTrack(trackId: number, destCollectionId: number, tracks: Track[]) {
    const track = tracks.find(t => t.id === trackId);
    if (!track) return;
    const path = track.path ?? "";
    if (path.startsWith("file://")) {
      addLog("Cannot download local tracks", "downloads");
      return;
    }

    try {
      await invoke("enqueue_download", {
        title: track.title,
        artistName: track.artist_name ?? null,
        albumTitle: track.album_title ?? null,
        uri: track.path ?? null,
        durationSecs: track.duration_secs ?? null,
        destCollectionId,
        format: downloadFormat,
      });
      addLog(`Downloading: ${track.title}`, "downloads");
    } catch (e) {
      addLog(`Download failed: ${e}`, "downloads");
    }
  }

  async function autoSaveTrack(
    track: Track,
    downloadsCollectionId: number,
    format: string,
    libraryTracks?: Track[],
  ) {
    try {
      if (libraryTracks) {
        const title = track.title.toLowerCase();
        const artist = (track.artist_name || "").toLowerCase();
        const localCopy = libraryTracks.find(t =>
          t.path?.startsWith("file://") &&
          t.title.toLowerCase() === title &&
          (t.artist_name || "").toLowerCase() === artist
        );
        if (localCopy) return;
      }

      const existing = await invoke<Track | null>("find_track_in_collection", {
        collectionId: downloadsCollectionId,
        title: track.title,
        artistName: track.artist_name ?? "",
      });
      if (existing) return;

      await invoke("enqueue_download", {
        title: track.title,
        artistName: track.artist_name ?? null,
        albumTitle: track.album_title ?? null,
        uri: track.path ?? null,
        durationSecs: track.duration_secs ?? null,
        destCollectionId: downloadsCollectionId,
        format,
      });
      addLog(`Auto-saving: ${track.artist_name ? track.artist_name + " - " : ""}${track.title}`, "downloads");
    } catch (e) {
      console.error("Auto-save failed:", e);
      addLog(`Failed to auto-save: ${track.title}`, "downloads");
    }
  }

  return {
    downloadFormat,
    setFormat,
    downloadTrack,
    autoSaveTrack,
  };
}
