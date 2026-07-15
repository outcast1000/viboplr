import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ResolvedShelf } from "./useHome";
import type { QueueTrack } from "../types";
import { isVideoTrack } from "../utils";
import { useVideoFrameQueue } from "./useVideoFrameQueueContext";
import type { VideoFrameQueue } from "../videoFrameQueue";

// Identity used to key a track's resolved video frame: the track's own
// scheme-prefixed path, which uniquely identifies the file. Only rows that are
// themselves video AND carry a path become candidates, so a keyed entry always
// has a path; path-less rows produce the empty key, never match a candidate, and
// fall back to entity art. Keying by path (not artist+title) also stops two
// same-titled videos from sharing — and swapping — one frame.
export function shelfVideoKey(path: string | null | undefined): string {
  return path ?? "";
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

// A video-frame candidate: a path-based key plus a way to resolve its library
// track id. The id-resolution is the ONLY thing that differs between the queue
// and shelf surfaces — everything downstream is shared.
interface VideoFrameCandidate {
  key: string; // shelfVideoKey(path)
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

// For a `track-rows` shelf: enqueue first-frame extraction for rows that are
// themselves video files (carry a video path), resolving the library id by exact
// path. Non track-rows shelves — and rows without a path (history-backed) — produce
// no candidates. Shared by HomeShelf (row cards) and HeroCarousel (the promoted
// shelf) so both surfaces get video thumbnails.
export function useShelfVideoFrames(shelf: ResolvedShelf): Record<string, string> {
  const candidates = useMemo<VideoFrameCandidate[]>(() => {
    if (shelf.displayKind !== "track-rows") return [];
    const out: VideoFrameCandidate[] = [];
    for (const item of shelf.items) {
      const track = (item as {
        track: { title: string; artist_name?: string; album_title?: string; format?: string | null; path?: string | null; image_url?: string };
      }).track;
      // A frame is only shown when the row ITSELF is a video (by its own
      // path/format), resolved by exact path — never inferred from a fuzzy
      // metadata match. History-backed shelves (Recently played / Most played)
      // carry no path or format, so they no longer borrow a same-titled video's
      // frame for an audio play; they fall back to album/artist art. Mirrors
      // useQueueVideoFrames.
      const path = track.path;
      if (track.image_url || !path || !isVideoTrack({ format: track.format ?? null, path })) continue;
      out.push({
        key: shelfVideoKey(path),
        resolveId: () => invoke<number | null>("find_track_id_by_path", { path }),
      });
    }
    return out;
  }, [shelf]);
  return useVideoFrameMap(candidates);
}

// For a queue: resolve each video track to its library id by path and enqueue
// first-frame extraction. Same path-based identity as the shelf hook above.
export function useQueueVideoFrames(queue: QueueTrack[]): Record<string, string> {
  const candidates = useMemo<VideoFrameCandidate[]>(() => {
    const out: VideoFrameCandidate[] = [];
    for (const t of queue) {
      if (t.image_url || !isVideoTrack(t) || !t.path) continue;
      const path = t.path;
      out.push({
        key: shelfVideoKey(path),
        resolveId: () => invoke<number | null>("find_track_id_by_path", { path }),
      });
    }
    return out;
  }, [queue]);
  return useVideoFrameMap(candidates);
}
