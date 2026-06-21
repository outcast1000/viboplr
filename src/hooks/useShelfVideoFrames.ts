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

// A video-frame candidate: a metadata key plus a way to resolve its library
// track id. The id-resolution is the ONLY thing that differs between the queue
// and shelf surfaces — everything downstream is shared.
interface VideoFrameCandidate {
  key: string; // shelfVideoKey(artist, title)
  resolveId: () => Promise<number | null>;
}

// Shared state machine for both surfaces: for each not-yet-resolved candidate,
// resolve its library id once, enqueue first-frame extraction, and project the
// queue's ready frames onto the metadata keys. Dedup is by key (in-flight set +
// resolved map), so duplicate keys and re-renders are no-ops.
function useVideoFrameMap(candidates: VideoFrameCandidate[]): Record<string, string> {
  const frameQueue = useVideoFrameQueue();
  // metadata key (artist::title) -> resolved library track id
  const [trackIds, setTrackIds] = useState<Record<string, number>>({});
  const resolvingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const { key, resolveId } of candidates) {
      if (key in trackIds || resolvingRef.current.has(key)) continue;
      resolvingRef.current.add(key);
      (async () => {
        try {
          const id = await resolveId();
          if (id == null) return;
          setTrackIds((prev) => ({ ...prev, [key]: id }));
          frameQueue.enqueue(id);
        } catch (e) {
          console.error("Failed to resolve video frame track id:", e);
        } finally {
          resolvingRef.current.delete(key);
        }
      })();
    }
  }, [candidates, trackIds, frameQueue]);

  return useReadyFrameProjection(frameQueue, trackIds);
}

// For a `track-rows` shelf: resolve each track to a library id via metadata and
// enqueue first-frame extraction for the video ones. Non track-rows shelves
// produce no candidates. Shared by HomeShelf (row cards) and HeroCarousel (the
// promoted shelf) so both surfaces get video thumbnails.
export function useShelfVideoFrames(shelf: ResolvedShelf): Record<string, string> {
  const candidates = useMemo<VideoFrameCandidate[]>(() => {
    if (shelf.displayKind !== "track-rows") return [];
    const out: VideoFrameCandidate[] = [];
    for (const item of shelf.items) {
      const track = (item as { track: { title: string; artist_name?: string; album_title?: string; image_url?: string } }).track;
      if (track.image_url) continue;
      out.push({
        key: shelfVideoKey(track.artist_name, track.title),
        resolveId: async () => {
          const lib = await invoke<Track | null>("find_track_by_metadata", {
            title: track.title,
            artistName: track.artist_name ?? null,
            albumName: track.album_title ?? null,
          });
          return lib && lib.id != null && isVideoTrack(lib) ? lib.id : null;
        },
      });
    }
    return out;
  }, [shelf]);
  return useVideoFrameMap(candidates);
}

// For a queue: resolve each video track to its library id by path and enqueue
// first-frame extraction. The QueueTrack already says it's a video and carries a
// path, so we skip the metadata round-trip the shelf needs.
export function useQueueVideoFrames(queue: QueueTrack[]): Record<string, string> {
  const candidates = useMemo<VideoFrameCandidate[]>(() => {
    const out: VideoFrameCandidate[] = [];
    for (const t of queue) {
      if (t.image_url || !isVideoTrack(t) || !t.path) continue;
      const path = t.path;
      out.push({
        key: shelfVideoKey(t.artist_name, t.title),
        resolveId: () => invoke<number | null>("find_track_id_by_path", { path }),
      });
    }
    return out;
  }, [queue]);
  return useVideoFrameMap(candidates);
}
