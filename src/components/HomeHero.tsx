import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { RadioStation } from "../hooks/useHome";

export interface HomeHeroProps {
  stations: RadioStation[];
  onPlayStation: (station: RadioStation) => void;
}

const ROTATE_MS = 8_000;

// Resolve a station cover (album/artist image path, or remote URL) to an <img src>.
function coverSrc(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("http") || url.startsWith("data:")) return url;
  return convertFileSrc(url);
}

export function HomeHero({ stations, onPlayStation }: HomeHeroProps) {
  const [idx, setIdx] = useState(0);
  const hoverRef = useRef(false);

  useEffect(() => { setIdx(0); }, [stations.length]);

  useEffect(() => {
    if (stations.length < 2) return;
    const id = setInterval(() => {
      if (hoverRef.current) return;
      setIdx((i) => (i + 1) % stations.length);
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [stations.length]);

  if (stations.length === 0) {
    return <div className="home-hero home-hero--empty">No radio stations yet.</div>;
  }

  const current = stations[idx];
  const imgSrc = coverSrc(current.coverUrl);

  const advance = (delta: number) => setIdx((i) => (i + delta + stations.length) % stations.length);

  return (
    <div
      className="home-hero"
      onMouseEnter={() => { hoverRef.current = true; }}
      onMouseLeave={() => { hoverRef.current = false; }}
    >
      {/* Cross-fading background layers — one per station, only the active one is
          opaque. Mirrors DetailHeroBackground's layered-opacity approach. */}
      <div className="home-hero-bg" aria-hidden="true">
        {stations.map((s, i) => {
          const src = coverSrc(s.coverUrl);
          if (!src) return null;
          return (
            <div
              key={i}
              className={`home-hero-bg-layer ${i === idx ? "active" : ""}`}
              style={{ backgroundImage: `url("${src.replace(/"/g, '\\"')}")` }}
            />
          );
        })}
      </div>
      <div className="home-hero-scrim" aria-hidden="true" />

      <button className="home-hero-arrow home-hero-arrow--left" aria-label="Previous station" onClick={() => advance(-1)}>‹</button>
      <button className="home-hero-arrow home-hero-arrow--right" aria-label="Next station" onClick={() => advance(1)}>›</button>

      {/* key={idx} re-mounts the content on each change so it fades in fresh. */}
      <div className="home-hero-content" key={idx}>
        <div className="home-hero-art" onClick={() => onPlayStation(current)}>
          {imgSrc ? <img src={imgSrc} alt={current.seed.title} /> : <div className="home-hero-art-fallback">{current.seed.title[0]?.toUpperCase() ?? "?"}</div>}
        </div>
        <div className="home-hero-info">
          <div className="home-hero-eyebrow">RADIO STATION</div>
          <h1 className="home-hero-title">Radio: {current.seed.title}</h1>
          <div className="home-hero-artist">{current.seed.artist_name ?? "Unknown artist"}</div>
          <div className="home-hero-meta">
            {current.seed.album_title && <span className="home-hero-chip">{current.seed.album_title}</span>}
          </div>
          <div className="home-hero-actions">
            <button className="ds-btn ds-btn--primary" onClick={() => onPlayStation(current)}>▶ Play</button>
          </div>
          <div className="home-hero-dots" role="tablist">
            {stations.map((_, i) => (
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
