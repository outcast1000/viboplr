import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Track, QueueTrack } from "../types";
import type { AppStore } from "../store";
import type { DownloadProvider, DownloadResolveResult } from "../types/plugin";

export interface UseDownloadsReturn {
  downloadFormat: string;
  setFormat: (format: string, store: AppStore) => void;
  downloadTrack: (trackId: number, destCollectionId: number, tracks: Track[]) => Promise<void>;
  autoSaveTrack: (track: QueueTrack, downloadsCollectionId: number, format: string, libraryTracks?: Track[]) => Promise<void>;
}

async function resolveTrackDownload(
  providers: DownloadProvider[],
  uri: string | null,
  title: string,
  artistName: string | null,
  albumName: string | null,
  durationSecs: number | null,
  format: string,
  provider?: string | null,
): Promise<DownloadResolveResult | null> {
  const targetProviders = provider
    ? providers.filter(p => p.id === provider)
    : providers;

  if (uri) {
    for (const p of targetProviders) {
      try {
        const result = await Promise.race([
          p.resolveByUri(uri, format),
          new Promise<null>((r) => setTimeout(() => r(null), 10000)),
        ]);
        if (result) return result;
      } catch {
        continue;
      }
    }
  }

  for (const p of targetProviders) {
    try {
      const result = await Promise.race([
        p.resolveByMetadata(title, artistName, albumName, durationSecs, format),
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
  downloadProvidersRef: React.MutableRefObject<DownloadProvider[]>,
): UseDownloadsReturn {
  const [downloadFormat, setDownloadFormat] = useState("flac");

  useEffect(() => {
    const unlisten = listen<{
      id: number;
      title: string;
      artist_name: string | null;
      album_title: string | null;
      duration_secs: number | null;
      uri: string | null;
      format: string;
      provider: string | null;
    }>("download-resolve-request", async (event) => {
      const { id, title, artist_name, album_title, duration_secs, uri, format, provider } = event.payload;

      const result = await resolveTrackDownload(
        downloadProvidersRef.current,
        uri, title, artist_name, album_title, duration_secs, format, provider,
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
    } catch (e) {
      console.error("Failed to enqueue download:", e);
    }
  }

  async function autoSaveTrack(
    track: QueueTrack,
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
    } catch (e) {
      console.error("Auto-save failed:", e);
    }
  }

  return {
    downloadFormat,
    setFormat,
    downloadTrack,
    autoSaveTrack,
  };
}
