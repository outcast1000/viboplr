import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useVideoFrameQueue, useVideoFrameEntry } from "../hooks/useVideoFrameQueueContext";
import { HOVER_FRAME_INTERVAL_MS } from "../videoFrameQueue";
import { FilmReel } from "./FilmReel";
import { StoryboardTile } from "./StoryboardTile";
import { spreadTileIndices, type Storyboard } from "../utils/storyboard";
import "./VideoRowThumb.css";

/** Moments to cycle on hover. The storyboard holds many more; this is a glance. */
const CYCLE_TILES = 6;

interface Props {
  trackId: number;
  /** Track path — the storyboard cache key. Omit to disable hover cycling. */
  trackPath?: string | null;
  alt: string;
  className?: string;
}

export function VideoRowThumb({ trackId, trackPath, alt, className }: Props) {
  const queue = useVideoFrameQueue();
  const entry = useVideoFrameEntry(trackId);
  const elRef = useRef<HTMLDivElement | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Loaded on first hover, not on scroll-into-view: a long track list would otherwise
  // fetch a sheet per row for thumbnails nobody looks at.
  const [board, setBoard] = useState<Storyboard | null>(null);
  const boardRequestedRef = useRef(false);

  // IntersectionObserver: enqueue when approaching viewport; cancel on exit.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            queue.enqueue(trackId);
          } else {
            queue.cancel(trackId);
          }
        }
      },
      { rootMargin: "100px" }
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      queue.cancel(trackId);
    };
  }, [queue, trackId]);

  // Clear interval on unmount.
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Drop a stale sheet when the row is recycled for a different track.
  useEffect(() => {
    setBoard(null);
    setFrameIndex(0);
    boardRequestedRef.current = false;
  }, [trackPath]);

  const tiles = board ? spreadTileIndices(board, CYCLE_TILES) : [];

  function startCycling(total: number) {
    if (total <= 1) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setFrameIndex((i) => (i + 1) % total);
    }, HOVER_FRAME_INTERVAL_MS);
  }

  function handleMouseEnter() {
    if (board) {
      startCycling(tiles.length);
      return;
    }
    if (!trackPath || boardRequestedRef.current) return;
    boardRequestedRef.current = true;
    // Cache-only: hovering a row must not kick off ffmpeg for every video the cursor
    // crosses. The sheet appears once something else (playback) has generated it.
    invoke<Storyboard | null>("get_storyboard", { path: trackPath })
      .then((b) => {
        if (!b) return;
        const withUrls: Storyboard = {
          ...b,
          sheets: b.sheets.map((s) => (/^(https?|data):/.test(s) ? s : convertFileSrc(s))),
        };
        setBoard(withUrls);
        startCycling(spreadTileIndices(withUrls, CYCLE_TILES).length);
      })
      .catch((e) => console.error("Failed to load storyboard for row thumb:", e));
  }

  function handleMouseLeave() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setFrameIndex(0);
  }

  const showShimmer = entry.status === "loading";
  // The resting image is always the track's own large frame — sharp at card size.
  // Cycling swaps in storyboard tiles, which are lower resolution but only ever seen
  // in motion (see docs/seek-preview-spec.md).
  const poster = entry.status === "ready" ? entry.frames[0] ?? null : null;
  const cyclingTile = frameIndex > 0 && tiles[frameIndex] != null ? tiles[frameIndex] : null;
  const showIcon = entry.status === "idle" || entry.status === "unavailable";

  return (
    <div
      ref={elRef}
      className={`video-row-thumb ${className ?? ""}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {poster && cyclingTile === null && (
        <img className="video-row-thumb-img" src={poster} alt={alt} draggable={false} />
      )}
      {board && cyclingTile !== null && (
        <StoryboardTile
          board={board}
          index={cyclingTile}
          className="video-row-thumb-img video-row-thumb-tile"
          cover
        />
      )}
      {showShimmer && <div className="video-row-thumb-shimmer" />}
      {showIcon && <FilmReel className="video-row-thumb-icon" />}
    </div>
  );
}
