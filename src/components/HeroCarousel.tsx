import { useEffect, useRef, useState } from "react";
import type { ResolvedShelf } from "../hooks/useHome";
import type { HomeShelfItem, PluginTrack } from "../types/plugin";
import { useShelfVideoFrames, shelfVideoKey } from "../hooks/useShelfVideoFrames";
import { resolveShelfPlayAction } from "../utils/homeShelfPlay";
import { shouldPauseEffect } from "./DetailHeroEffect";
import { playlistCardCandidates } from "./HomeShelf";
import { resolveImageSrc, resolveImageUrl } from "../utils/resolveImageUrl";
import { firstUsableImage, type ImageCandidate } from "../utils/imageCandidates";

const ROTATE_MS = 8_000;

interface Slide {
  // Ordered cover chain; the first that is present and hasn't failed to load wins.
  covers: ImageCandidate[];
  title: string;
  subtitle: string | null;
}

// Map a shelf item to a hero slide (cover chain + title + subtitle) per display
// kind, reusing the album/artist name-based image chain behind the item's own
// art — an explicit cover can be a stale path or an unreadable file, so it is
// never the only candidate. `videoFrames` carries already-converted
// first-frame URLs for video tracks.
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
      covers: [
        resolveImageUrl(it.coverUrl),
        () => resolveImageUrl(albumImageFor(it.name, it.artistName)),
        () => (it.artistName ? resolveImageUrl(artistImageFor(it.artistName)) : null),
      ],
      title: it.name,
      subtitle: it.artistName ?? null,
    };
  }
  if (shelf.displayKind === "artist-cards") {
    const it = item as { name: string; imageUrl?: string };
    return {
      covers: [resolveImageUrl(it.imageUrl), () => resolveImageUrl(artistImageFor(it.name))],
      title: it.name,
      subtitle: null,
    };
  }
  if (shelf.displayKind === "playlist-cards") {
    // Radio stations and mixes: the station's cover, then the seed track's
    // album/artist image, which fetches on demand.
    const it = item as { name: string; coverUrl?: string; subtitle?: string; tracks?: PluginTrack[] };
    return { covers: playlistCardCandidates(it, albumImageFor, artistImageFor), title: it.name, subtitle: it.subtitle ?? null };
  }
  // track-rows — video frame URLs are already converted and used verbatim.
  const it = item as { track: { title: string; artist_name?: string; album_artist_name?: string; album_title?: string; path?: string | null; image_url?: string } };
  const t = it.track;
  return {
    covers: [
      resolveImageSrc(t.image_url),
      videoFrames[shelfVideoKey(t.path)] ?? null,
      () => (t.album_title ? resolveImageUrl(albumImageFor(t.album_title, t.album_artist_name ?? t.artist_name)) : null),
      () => (t.artist_name ? resolveImageUrl(artistImageFor(t.artist_name)) : null),
    ],
    title: t.title,
    subtitle: t.artist_name ?? null,
  };
}

export interface HeroCarouselProps {
  // The promoted (first) shelf, rendered as a rotating hero of its items.
  shelf: ResolvedShelf;
  albumImageFor: (name: string, artistName?: string) => string | null;
  artistImageFor: (name: string) => string | null;
  onItemClick: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
  onItemPlay: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
  /** Opens the shelf's own ⋯ native menu (move / hide / customize). */
  onShelfMenu?: (shelf: ResolvedShelf, e: React.MouseEvent<HTMLButtonElement>) => void;
}

export function HeroCarousel({ shelf, albumImageFor, artistImageFor, onItemClick, onItemPlay, onShelfMenu }: HeroCarouselProps) {
  const items = shelf.items;
  const videoFrames = useShelfVideoFrames(shelf);
  const [idx, setIdx] = useState(0);
  const hoverRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Covers that failed to load (missing file, unreadable image). Shared by the
  // art and the background layers, so both step down the same chain together.
  const [failedSrcs, setFailedSrcs] = useState<Set<string>>(new Set());
  const coverFor = (s: Slide) => firstUsableImage(s.covers, failedSrcs);

  // Track the slide the carousel just left, so only two background layers are
  // ever mounted: the active one plus the one fading out. Keeping one
  // cover-sized layer per item handed the compositor up to 7 hero-sized
  // images when at most 2 can be visible. Previous-value-in-state form.
  const [prevIdx, setPrevIdx] = useState<number | null>(null);
  const [lastIdx, setLastIdx] = useState(idx);
  if (idx !== lastIdx) {
    setLastIdx(idx);
    setPrevIdx(lastIdx);
  }

  // Reset to the first slide when the shelf changes or shrinks.
  useEffect(() => { setIdx(0); setPrevIdx(null); }, [shelf.id, items.length]);

  // Stop rotating while nobody can see it: Home is display-toggled (kept
  // mounted behind other views — see FreezeWhileHidden) and the window can be
  // minimized/occluded, and each rotation animates a hero-sized crossfade the
  // compositor bills wall-clock GPU for. Same gate as DetailHeroEffect.
  const [suspended, setSuspended] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let onScreen = true;
    let pageVisible = !document.hidden;
    const apply = () => setSuspended(shouldPauseEffect(onScreen, pageVisible));
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              onScreen = entries[0]?.isIntersecting ?? true;
              apply();
            },
            { threshold: 0 },
          )
        : null;
    io?.observe(el);
    const onVisibility = () => {
      pageVisible = !document.hidden;
      apply();
    };
    document.addEventListener("visibilitychange", onVisibility);
    apply();
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (items.length < 2 || suspended) return;
    const id = setInterval(() => {
      if (hoverRef.current) return;
      setIdx((i) => (i + 1) % items.length);
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [items.length, suspended]);

  if (items.length === 0) return null;

  const safeIdx = idx % items.length;
  const item = items[safeIdx];
  const slide = slideFor(shelf, item, albumImageFor, artistImageFor, videoFrames);
  const coverSrc = coverFor(slide);
  const hasPlay = resolveShelfPlayAction(shelf.displayKind, item).kind !== "none";
  const advance = (delta: number) => setIdx((i) => (i + delta + items.length) % items.length);

  // Active layer first (bottom), outgoing layer second (top): the incoming
  // layer mounts already opaque underneath while the outgoing one — kept
  // mounted via its stable key — loses `.active` and transitions out over it,
  // which reads as the same dissolve the mount-them-all version had.
  const bgIdxs = prevIdx !== null && prevIdx !== safeIdx ? [safeIdx, prevIdx] : [safeIdx];

  return (
    <div
      ref={rootRef}
      className="home-hero"
      onMouseEnter={() => { hoverRef.current = true; }}
      onMouseLeave={() => { hoverRef.current = false; }}
    >
      {/* Cross-fading background layers — only the active + outgoing slides. */}
      <div className="home-hero-bg" aria-hidden="true">
        {bgIdxs.map((i) => {
          const it = items[i];
          if (!it) return null;
          const src = coverFor(slideFor(shelf, it, albumImageFor, artistImageFor, videoFrames));
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

      {onShelfMenu && (
        <button
          className="home-hero-menu"
          aria-label={`${shelf.title} options`}
          title="Shelf options"
          onClick={(e) => onShelfMenu(shelf, e)}
        >⋯</button>
      )}

      {/* key re-mounts the content on each change so it fades in fresh. */}
      <div className="home-hero-content" key={safeIdx}>
        <div className="home-hero-art" onClick={() => onItemClick(shelf, item)}>
          {coverSrc
            ? <img
                key={coverSrc}
                src={coverSrc}
                alt={slide.title}
                onError={() => setFailedSrcs((prev) => new Set(prev).add(coverSrc))}
              />
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
