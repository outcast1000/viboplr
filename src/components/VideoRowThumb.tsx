import { useEffect, useRef, useState } from "react";
import { useVideoFrameQueue, useVideoFrameEntry } from "../hooks/useVideoFrameQueueContext";
import { HOVER_FRAME_INTERVAL_MS } from "../videoFrameQueue";
import { FilmReel } from "./FilmReel";
import "./VideoRowThumb.css";

interface Props {
  trackId: number;
  alt: string;
  className?: string;
}

export function VideoRowThumb({ trackId, alt, className }: Props) {
  const queue = useVideoFrameQueue();
  const entry = useVideoFrameEntry(trackId);
  const elRef = useRef<HTMLDivElement | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  function handleMouseEnter() {
    if (entry.status !== "ready" || entry.frames.length <= 1) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    const total = entry.frames.length;
    intervalRef.current = setInterval(() => {
      setFrameIndex((i) => (i + 1) % total);
    }, HOVER_FRAME_INTERVAL_MS);
  }

  function handleMouseLeave() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setFrameIndex(0);
  }

  const showShimmer = entry.status === "loading";
  const currentFrame = entry.status === "ready" ? entry.frames[frameIndex] ?? entry.frames[0] : null;
  const showIcon = entry.status === "idle" || entry.status === "unavailable";

  return (
    <div
      ref={elRef}
      className={`video-row-thumb ${className ?? ""}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {currentFrame && <img className="video-row-thumb-img" src={currentFrame} alt={alt} draggable={false} />}
      {showShimmer && <div className="video-row-thumb-shimmer" />}
      {showIcon && <FilmReel className="video-row-thumb-icon" />}
    </div>
  );
}
