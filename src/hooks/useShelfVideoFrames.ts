import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ResolvedShelf } from "./useHome";
import type { PluginTrack } from "../types/plugin";
import { isVideoTrack } from "../utils";
import { isLocalTrack } from "../queueEntry";
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

/** The track a playlist card opens with — whose art stands in for the card's,
 *  and whose placeholder does when there is none. A Latest play card ships no
 *  tracks; its lead is the session's track. */
export function playlistLead(it: { tracks?: PluginTrack[]; __session?: { track?: PluginTrack | null } }): PluginTrack | undefined {
  return it.tracks?.[0] ?? it.__session?.track ?? undefined;
}

/** A row the backend can pull a frame from: a video file on this disk. Remote
 *  videos are excluded — frame extraction rejects them. */
export function isLocalVideo(t: { path?: string | null; format?: string | null }): t is { path: string; format?: string | null } {
  return !!t.path && isVideoTrack({ format: t.format ?? null, path: t.path }) && isLocalTrack({ path: t.path });
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
//
// A `playlist-cards` shelf (Radio, Latest play) gets a frame for each card whose
// lead track is a local video — a station seeded by a video, a replayed video —
// keyed the same way, so the card can show it before its album/artist art.
export function useShelfVideoFrames(shelf: ResolvedShelf): Record<string, string> {
  const candidates = useMemo<VideoFrameCandidate[]>(() => {
    if (shelf.displayKind === "playlist-cards") {
      const out: VideoFrameCandidate[] = [];
      for (const item of shelf.items) {
        const lead = playlistLead(item as { tracks?: PluginTrack[]; __session?: { track?: PluginTrack | null } });
        if (!lead || !isLocalVideo(lead)) continue;
        const path = lead.path;
        out.push({
          key: shelfVideoKey(path),
          resolveId: () => invoke<number | null>("find_track_id_by_path", { path }),
        });
      }
      return out;
    }
    if (shelf.displayKind !== "track-rows") return [];
    const out: VideoFrameCandidate[] = [];
    for (const item of shelf.items) {
      const track = (item as {
        track: { title: string; artist_name?: string; album_title?: string; format?: string | null; path?: string | null; image_url?: string };
      }).track;
      // A frame is only shown when the row ITSELF is a LOCAL video (by its own
      // path/format), resolved by exact path — never inferred from a fuzzy
      // metadata match on the frontend. History-backed shelves (Recently played /
      // Most played) carry the path of the library copy the backend matched the
      // play to (`display_path`), so a video play shows its own frame and an
      // audio play never borrows one. Remote videos are skipped — the backend
      // can't extract frames from them. Mirrors useQueueVideoFrames.
      const path = track.path;
      if (track.image_url || !path || !isVideoTrack({ format: track.format ?? null, path }) || !isLocalTrack({ path })) continue;
      out.push({
        key: shelfVideoKey(path),
        resolveId: () => invoke<number | null>("find_track_id_by_path", { path }),
      });
    }
    return out;
  }, [shelf]);
  return useVideoFrameMap(candidates);
}

// The fields the frame lookup reads off a row: a queue entry, a playlist row, or
// a history row carrying its matched library copy's path.
export interface VideoFrameRow {
  path?: string | null;
  format?: string | null;
  image_url?: string | null;
}

// For a queue (or any list of rows like one): resolve each video track to its
// library id by path and enqueue first-frame extraction. Same path-based
// identity as the shelf hook above.
export function useQueueVideoFrames(queue: readonly VideoFrameRow[]): Record<string, string> {
  const candidates = useMemo<VideoFrameCandidate[]>(() => {
    const out: VideoFrameCandidate[] = [];
    for (const t of queue) {
      // Local video only — the backend rejects frame extraction for remote
      // tracks (subsonic, prefer-video streams), so those fall back to entity art.
      if (t.image_url || !t.path || !isVideoTrack({ format: t.format ?? null, path: t.path }) || !isLocalTrack(t)) continue;
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
