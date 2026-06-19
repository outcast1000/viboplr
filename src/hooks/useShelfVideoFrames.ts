import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ResolvedShelf } from "./useHome";
import type { Track } from "../types";
import { isVideoTrack } from "../utils";
import { useVideoFrameQueue } from "./useVideoFrameQueueContext";

// Metadata identity used to key a home-shelf track's resolved video frame.
export function shelfVideoKey(artistName: string | null | undefined, title: string): string {
  return `${artistName ?? ""}::${title}`;
}

// For a `track-rows` shelf, resolve each track to a library id (via metadata) and
// enqueue first-frame extraction for video tracks. Returns a metadata-key ->
// ready frame URL map (already a converted asset URL — do NOT pass it through
// resolveImagePath) that updates, and re-renders the caller, as frames arrive.
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

  // Read the queue's stable ready-frame snapshot, then project it to our metadata
  // keys. Both layers must be referentially stable: useSyncExternalStore gets the
  // queue's cached snapshot (stable per-change), and useMemo recomputes the
  // projection only when the snapshot or trackIds change.
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
