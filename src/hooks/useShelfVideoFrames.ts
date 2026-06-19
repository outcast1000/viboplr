import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ResolvedShelf } from "./useHome";
import type { QueueTrack, Track } from "../types";
import { isVideoTrack } from "../utils";
import { useVideoFrameQueue } from "./useVideoFrameQueueContext";
import type { VideoFrameQueue } from "../videoFrameQueue";

// Metadata identity used to key a track's resolved video frame. Matches the keys
// the queue and home shelves already use for their image maps.
export function shelfVideoKey(artistName: string | null | undefined, title: string): string {
  return `${artistName ?? ""}::${title}`;
}

// Read the queue's stable ready-frame snapshot and project it onto a
// metadata-key -> trackId map, yielding key -> ready frame URL (already a
// converted asset URL — do NOT pass through resolveImagePath/resolveImageUrl).
// Both layers stay referentially stable: useSyncExternalStore returns the
// queue's cached snapshot, and useMemo recomputes only when it or trackIds change.
function useReadyFrameProjection(
  frameQueue: VideoFrameQueue,
  trackIds: Record<string, number>,
): Record<string, string> {
  const readyFrames = useSyncExternalStore(
    (cb) => frameQueue.subscribe(cb),
    () => frameQueue.getReadyFrameSnapshot(),
  );
  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const [key, id] of Object.entries(trackIds)) {
      const url = readyFrames[id];
      if (url) out[key] = url;
    }
    return out;
  }, [readyFrames, trackIds]);
}

// For a `track-rows` shelf, resolve each track to a library id (via metadata) and
// enqueue first-frame extraction for video tracks. Returns a metadata-key ->
// ready frame URL map that updates, and re-renders the caller, as frames arrive.
// Non track-rows shelves resolve to an empty map. Shared by HomeShelf (row cards)
// and HeroCarousel (the promoted shelf) so both surfaces get video thumbnails.
export function useShelfVideoFrames(shelf: ResolvedShelf): Record<string, string> {
  const frameQueue = useVideoFrameQueue();
  // metadata key (artist::title) -> resolved library track id
  const [trackIds, setTrackIds] = useState<Record<string, number>>({});
  const resolvingRef = useRef<Set<string>>(new Set());

  // Resolve metadata -> library track id, then enqueue extraction for video tracks.
  useEffect(() => {
    if (shelf.displayKind !== "track-rows") return;
    for (const item of shelf.items) {
      const track = (item as { track: { title: string; artist_name?: string; album_title?: string; image_url?: string } }).track;
      if (track.image_url) continue;
      const key = shelfVideoKey(track.artist_name, track.title);
      if (key in trackIds || resolvingRef.current.has(key)) continue;
      resolvingRef.current.add(key);
      (async () => {
        try {
          const lib = await invoke<Track | null>("find_track_by_metadata", {
            title: track.title,
            artistName: track.artist_name ?? null,
            albumName: track.album_title ?? null,
          });
          if (!lib || lib.id == null || !isVideoTrack(lib)) return;
          const id = lib.id;
          setTrackIds((prev) => ({ ...prev, [key]: id }));
          frameQueue.enqueue(id);
        } catch (e) {
          console.error("Failed to resolve home shelf track id:", e);
        } finally {
          resolvingRef.current.delete(key);
        }
      })();
    }
  }, [shelf, trackIds, frameQueue]);

  return useReadyFrameProjection(frameQueue, trackIds);
}

// For a queue, resolve each video track to its library id (by path) and enqueue
// first-frame extraction. Returns a metadata-key -> ready frame URL map that
// updates as frames arrive — so the Queue panel both triggers extraction and
// refreshes when it completes (the QueueTrack already tells us it's a video, so
// we skip the metadata round-trip and resolve the id straight from the path).
export function useQueueVideoFrames(queue: QueueTrack[]): Record<string, string> {
  const frameQueue = useVideoFrameQueue();
  const [trackIds, setTrackIds] = useState<Record<string, number>>({});
  const resolvingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const t of queue) {
      if (t.image_url || !isVideoTrack(t) || !t.path) continue;
      const key = shelfVideoKey(t.artist_name, t.title);
      if (key in trackIds || resolvingRef.current.has(key)) continue;
      resolvingRef.current.add(key);
      (async () => {
        try {
          const id = await invoke<number | null>("find_track_id_by_path", { path: t.path });
          if (id == null) return;
          setTrackIds((prev) => ({ ...prev, [key]: id }));
          frameQueue.enqueue(id);
        } catch (e) {
          console.error("Failed to resolve queue video track id:", e);
        } finally {
          resolvingRef.current.delete(key);
        }
      })();
    }
  }, [queue, trackIds, frameQueue]);

  return useReadyFrameProjection(frameQueue, trackIds);
}
