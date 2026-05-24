import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track } from "../types";

export interface HomeHeroProps {
  tracks: Track[];
  albumImageFor: (name: string, artistName?: string) => string | null;
  onPlay: (track: Track) => void;
  onEnqueue: (track: Track) => void;
  onContextMenu: (track: Track, e: React.MouseEvent) => void;
}

const ROTATE_MS = 8_000;

export function HomeHero({ tracks, albumImageFor, onPlay, onEnqueue, onContextMenu }: HomeHeroProps) {
  const [idx, setIdx] = useState(0);
  const hoverRef = useRef(false);

  useEffect(() => { setIdx(0); }, [tracks.length]);

  useEffect(() => {
    if (tracks.length < 2) return;
    const id = setInterval(() => {
      if (hoverRef.current) return;
      setIdx((i) => (i + 1) % tracks.length);
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [tracks.length]);

  if (tracks.length === 0) {
    return <div className="home-hero home-hero--empty">No featured tracks yet.</div>;
  }

  const current = tracks[idx];
  const imgPath = albumImageFor(current.album_title ?? "", current.artist_name ?? undefined);
  const imgSrc = imgPath ? convertFileSrc(imgPath) : null;

  const advance = (delta: number) => setIdx((i) => (i + delta + tracks.length) % tracks.length);

  return (
    <div
      className="home-hero"
      onMouseEnter={() => { hoverRef.current = true; }}
      onMouseLeave={() => { hoverRef.current = false; }}
      style={{
        backgroundImage: imgSrc ? `linear-gradient(rgba(0,0,0,0.55), rgba(0,0,0,0.55)), url("${imgSrc}")` : undefined,
      }}
    >
      <button className="home-hero-arrow home-hero-arrow--left" aria-label="Previous featured" onClick={() => advance(-1)}>‹</button>
      <button className="home-hero-arrow home-hero-arrow--right" aria-label="Next featured" onClick={() => advance(1)}>›</button>

      <div className="home-hero-content">
        <div className="home-hero-art" onClick={() => onPlay(current)} onContextMenu={(e) => { e.preventDefault(); onContextMenu(current, e); }}>
          {imgSrc ? <img src={imgSrc} alt={current.title} /> : <div className="home-hero-art-fallback">{current.title[0]?.toUpperCase() ?? "?"}</div>}
        </div>
        <div className="home-hero-info">
          <div className="home-hero-eyebrow">FEATURED TRACK</div>
          <h1 className="home-hero-title">{current.title}</h1>
          <div className="home-hero-artist">{current.artist_name ?? "Unknown artist"}</div>
          <div className="home-hero-meta">
            {current.year && <span className="home-hero-chip">{current.year}</span>}
            {current.album_title && <span className="home-hero-chip">{current.album_title}</span>}
            {current.format && <span className="home-hero-chip">{current.format.toUpperCase()}</span>}
          </div>
          <div className="home-hero-actions">
            <button className="ds-btn ds-btn--primary" onClick={() => onPlay(current)}>▶ Play</button>
            <button className="ds-btn ds-btn--secondary" onClick={() => onEnqueue(current)}>≡+ Enqueue</button>
          </div>
          <div className="home-hero-dots" role="tablist">
            {tracks.map((_, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === idx}
                className={`home-hero-dot ${i === idx ? "active" : ""}`}
                onClick={() => setIdx(i)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
