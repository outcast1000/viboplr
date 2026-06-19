import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ResolvedShelf } from "../hooks/useHome";
import type { HomeShelfItem, PluginTrack } from "../types/plugin";
import { useShelfVideoFrames, shelfVideoKey } from "../hooks/useShelfVideoFrames";
import { resolveShelfPlayAction } from "../utils/homeShelfPlay";

const ROTATE_MS = 8_000;

// Resolve any image path (http/data URI, or local path with optional `#v=...`
// cache-busting fragment) to a value usable in <img src> / background-image.
function resolveImagePath(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith("http") || path.startsWith("data:")) return path;
  const hashIdx = path.indexOf("#");
  if (hashIdx >= 0) return convertFileSrc(path.slice(0, hashIdx)) + path.slice(hashIdx);
  return convertFileSrc(path);
}

interface Slide {
  coverSrc: string | null;
  title: string;
  subtitle: string | null;
}

// Map a shelf item to a hero slide (cover + title + subtitle) per display kind,
// reusing the album/artist name-based image chain when the item has no explicit
// art. `videoFrames` carries already-converted first-frame URLs for video tracks.
function slideFor(
  shelf: ResolvedShelf,
  item: HomeShelfItem,
  albumImageFor: (name: string, artistName?: string) => string | null,
  artistImageFor: (name: string) => string | null,
  videoFrames: Record<string, string>,
): Slide {
  if (shelf.displayKind === "album-cards") {
    const it = item as { name: string; artistName?: string; coverUrl?: string };
    return {
      coverSrc: resolveImagePath(it.coverUrl ?? albumImageFor(it.name, it.artistName)),
      title: it.name,
      subtitle: it.artistName ?? null,
    };
  }
  if (shelf.displayKind === "artist-cards") {
    const it = item as { name: string; imageUrl?: string };
    return {
      coverSrc: resolveImagePath(it.imageUrl ?? artistImageFor(it.name)),
      title: it.name,
      subtitle: null,
    };
  }
  if (shelf.displayKind === "playlist-cards") {
    const it = item as { name: string; coverUrl?: string; subtitle?: string; tracks?: PluginTrack[] };
    // No explicit cover (e.g. a radio station whose cover wasn't cached): fall
    // back to the seed track's album/artist image, which fetches on demand.
    const seed = it.tracks?.[0];
    const fallback = seed
      ? (seed.album_title ? albumImageFor(seed.album_title, seed.artist_name ?? undefined) : null) ??
        (seed.artist_name ? artistImageFor(seed.artist_name) : null)
      : null;
    return { coverSrc: resolveImagePath(it.coverUrl ?? fallback), title: it.name, subtitle: it.subtitle ?? null };
  }
  // track-rows
  const it = item as { track: { title: string; artist_name?: string; album_title?: string; image_url?: string } };
  const explicit = it.track.image_url ?? null;
  // Video frame URLs are already converted — do NOT pass them through resolveImagePath.
  const videoFrame = !explicit ? videoFrames[shelfVideoKey(it.track.artist_name, it.track.title)] ?? null : null;
  if (videoFrame) return { coverSrc: videoFrame, title: it.track.title, subtitle: it.track.artist_name ?? null };
  const path =
    explicit ??
    (it.track.album_title ? albumImageFor(it.track.album_title, it.track.artist_name) : null) ??
    (it.track.artist_name ? artistImageFor(it.track.artist_name) : null);
  return { coverSrc: resolveImagePath(path), title: it.track.title, subtitle: it.track.artist_name ?? null };
}

export interface HeroCarouselProps {
  // The promoted (first) shelf, rendered as a rotating hero of its items.
  shelf: ResolvedShelf;
  albumImageFor: (name: string, artistName?: string) => string | null;
  artistImageFor: (name: string) => string | null;
  onItemClick: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
  onItemPlay: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
}

export function HeroCarousel({ shelf, albumImageFor, artistImageFor, onItemClick, onItemPlay }: HeroCarouselProps) {
  const items = shelf.items;
  const videoFrames = useShelfVideoFrames(shelf);
  const [idx, setIdx] = useState(0);
  const hoverRef = useRef(false);

  // Reset to the first slide when the shelf changes or shrinks.
  useEffect(() => { setIdx(0); }, [shelf.id, items.length]);

  useEffect(() => {
    if (items.length < 2) return;
    const id = setInterval(() => {
      if (hoverRef.current) return;
      setIdx((i) => (i + 1) % items.length);
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [items.length]);

  if (items.length === 0) return null;

  const safeIdx = idx % items.length;
  const item = items[safeIdx];
  const slide = slideFor(shelf, item, albumImageFor, artistImageFor, videoFrames);
  const hasPlay = resolveShelfPlayAction(shelf.displayKind, item).kind !== "none";
  const advance = (delta: number) => setIdx((i) => (i + delta + items.length) % items.length);

  return (
    <div
      className="home-hero"
      onMouseEnter={() => { hoverRef.current = true; }}
      onMouseLeave={() => { hoverRef.current = false; }}
    >
      {/* Cross-fading background layers — one per item, only the active one opaque. */}
      <div className="home-hero-bg" aria-hidden="true">
        {items.map((it, i) => {
          const src = slideFor(shelf, it, albumImageFor, artistImageFor, videoFrames).coverSrc;
          if (!src) return null;
          return (
            <div
              key={i}
              className={`home-hero-bg-layer ${i === safeIdx ? "active" : ""}`}
              style={{ backgroundImage: `url("${src.replace(/"/g, '\\"')}")` }}
            />
          );
        })}
      </div>
      <div className="home-hero-scrim" aria-hidden="true" />

      {items.length > 1 && (
        <>
          <button className="home-hero-arrow home-hero-arrow--left" aria-label="Previous" onClick={() => advance(-1)}>‹</button>
          <button className="home-hero-arrow home-hero-arrow--right" aria-label="Next" onClick={() => advance(1)}>›</button>
        </>
      )}

      {/* key re-mounts the content on each change so it fades in fresh. */}
      <div className="home-hero-content" key={safeIdx}>
        <div className="home-hero-art" onClick={() => onItemClick(shelf, item)}>
          {slide.coverSrc
            ? <img src={slide.coverSrc} alt={slide.title} />
            : <div className="home-hero-art-fallback">{slide.title[0]?.toUpperCase() ?? "?"}</div>}
        </div>
        <div className="home-hero-info">
          <div className="home-hero-eyebrow">{shelf.title.toUpperCase()}</div>
          <h1 className="home-hero-title">{slide.title}</h1>
          {slide.subtitle && <div className="home-hero-artist">{slide.subtitle}</div>}
          {hasPlay && (
            <div className="home-hero-actions">
              <button className="ds-btn ds-btn--primary" onClick={() => onItemPlay(shelf, item)}>▶ Play</button>
            </div>
          )}
          {items.length > 1 && (
            <div className="home-hero-dots" role="tablist">
              {items.map((_, i) => (
                <button
                  key={i}
                  role="tab"
                  aria-selected={i === safeIdx}
                  className={`home-hero-dot ${i === safeIdx ? "active" : ""}`}
                  onClick={() => setIdx(i)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
