import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Track } from "../types";
import { remoteId } from "../queueEntry";
import type { AppStore } from "../store";
import type { DownloadProvider, DownloadResolveResult } from "../types/plugin";

export interface UseDownloadsReturn {
  downloadFormat: string;
  setFormat: (format: string, store: AppStore) => void;
  downloadTrack: (trackId: number, destCollectionId: number, tracks: Track[]) => Promise<void>;
  autoSaveTrack: (track: Track, downloadsCollectionId: number, format: string) => Promise<void>;
}

export async function resolveDownload(
  providers: DownloadProvider[],
  title: string,
  artistName: string | null,
  albumName: string | null,
  format: string,
  timeoutMs = 10000,
): Promise<DownloadResolveResult | null> {
  for (const provider of providers) {
    try {
      const result = await Promise.race([
        provider.resolve(title, artistName, albumName, null, format),
        new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
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
  invokeDownloadResolveRef: React.MutableRefObject<(pluginId: string, providerId: string, title: string, artistName: string | null, albumName: string | null, sourceTrackId: string | null, format: string) => Promise<DownloadResolveResult | null>>,
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

  // Listen for download-resolve-request events from the Rust backend
  useEffect(() => {
    const unlisten = listen<{
      id: number;
      title: string;
      artist_name: string | null;
      album_title: string | null;
      source_provider_id: string | null;
      source_track_id: string | null;
      source_collection_id: number | null;
      format: string;
    }>("download-resolve-request", async (event) => {
      const { id, title, artist_name, album_title, source_provider_id, source_track_id, source_collection_id, format } = event.payload;

      let result: DownloadResolveResult | null = null;

      // Direct-source: try the specified provider first
      if (source_provider_id && source_provider_id !== "__builtin:subsonic") {
        const parts = source_provider_id.split(":");
        const pluginId = parts[0];
        const providerId = parts.slice(1).join(":");
        if (pluginId && providerId) {
          result = await invokeDownloadResolveRef.current(pluginId, providerId, title, artist_name, album_title, source_track_id, format);
        }
      }

      // Built-in Subsonic handler
      if (!result && source_provider_id === "__builtin:subsonic" && source_track_id && source_collection_id) {
        try {
          const url = await invoke<string>("resolve_subsonic_download_url", {
            collectionId: source_collection_id,
            remoteTrackId: source_track_id,
            format,
          });
          result = { url, headers: null, metadata: null };
        } catch (e) {
          console.error("Subsonic download resolve failed:", e);
        }
      }

      // Chain stream resolvers: iterate all providers in priority order
      if (!result) {
        result = await resolveDownload(downloadProvidersRef.current, title, artist_name, album_title, format);
      }

      await invoke("download_resolve_response", { id, result: result ?? null });
    });

    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Listen for mixtape-download-request events from full export
  useEffect(() => {
    const unlisten = listen<{
      id: number;
      title: string;
      artist_name: string | null;
      album_title: string | null;
      path: string | null;
    }>("mixtape-download-request", async (event) => {
      const { id, title, artist_name, album_title, path } = event.payload;
      const format = downloadFormatRef.current;
      console.log(`[mixtape-resolve] request #${id}: "${title}" by ${artist_name}, path=${path}, format=${format}`);

      let result: DownloadResolveResult | null = null;

      if (path) {
        const parts = path.split("://");
        const scheme = parts[0];
        if (scheme === "tidal") {
          const trackId = parts[1] || null;
          console.log(`[mixtape-resolve] #${id}: trying tidal-download, trackId=${trackId}`);
          result = await invokeDownloadResolveRef.current(
            "tidal-browse", "tidal-download", title, artist_name, album_title, trackId, format);
        } else if (scheme === "subsonic") {
          const rest = parts[1] || "";
          const lastSlash = rest.lastIndexOf("/");
          const trackId = lastSlash >= 0 ? rest.substring(lastSlash + 1) : null;
          console.log(`[mixtape-resolve] #${id}: trying subsonic, trackId=${trackId}`);
          if (trackId) {
            try {
              const url = await invoke<string>("resolve_subsonic_download_url", {
                collectionId: parseInt(rest.substring(0, lastSlash), 10),
                remoteTrackId: trackId,
                format,
              });
              result = { url, headers: null, metadata: null };
            } catch (e) {
              console.error(`[mixtape-resolve] #${id}: subsonic resolve failed:`, e);
            }
          }
        } else {
          console.log(`[mixtape-resolve] #${id}: unknown scheme "${scheme}", falling through to chain`);
        }
      } else {
        console.log(`[mixtape-resolve] #${id}: no path, falling through to chain`);
      }

      if (!result) {
        const providerCount = downloadProvidersRef.current.length;
        console.log(`[mixtape-resolve] #${id}: trying ${providerCount} download providers`);
        result = await resolveDownload(
          downloadProvidersRef.current, title, artist_name, album_title, format);
      }

      console.log(`[mixtape-resolve] #${id}: ${result ? "resolved -> " + result.url.substring(0, 80) : "FAILED (no provider resolved)"}`);
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
    const rid = track ? remoteId(track) : null;
    if (!rid || !track?.collection_id) return;

    // Determine source provider from the track path scheme
    const path = track.path ?? "";
    let sourceProviderId: string;
    if (path.startsWith("tidal://")) {
      sourceProviderId = "tidal-browse:tidal-download";
    } else if (path.startsWith("subsonic://")) {
      sourceProviderId = "__builtin:subsonic";
    } else {
      addLog(`Download not supported for this track type`, "downloads");
      return;
    }

    try {
      await invoke("enqueue_download", {
        title: track.title,
        artistName: track.artist_name ?? null,
        albumTitle: track.album_title ?? null,
        sourceProviderId,
        sourceTrackId: rid,
        sourceCollectionId: track.collection_id,
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
  ) {
    try {
      const existing = await invoke<Track | null>("find_track_in_collection", {
        collectionId: downloadsCollectionId,
        title: track.title,
        artistName: track.artist_name ?? "",
      });
      if (existing) return;

      const path = track.path ?? "";
      let sourceProviderId: string | null = null;
      let sourceTrackId: string | null = null;
      const sourceCollectionId: number | null = track.collection_id ?? null;

      if (path.startsWith("tidal://")) {
        sourceProviderId = "tidal-browse:tidal-download";
        sourceTrackId = path.substring(8);
      } else if (path.startsWith("subsonic://")) {
        sourceProviderId = "__builtin:subsonic";
        const rest = path.substring(11);
        const lastSlash = rest.lastIndexOf("/");
        sourceTrackId = lastSlash >= 0 ? rest.substring(lastSlash + 1) : null;
      } else if (path.startsWith("external://")) {
        sourceProviderId = "youtube:youtube-download";
      }

      await invoke("enqueue_download", {
        title: track.title,
        artistName: track.artist_name ?? null,
        albumTitle: track.album_title ?? null,
        sourceProviderId,
        sourceTrackId,
        sourceCollectionId,
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
